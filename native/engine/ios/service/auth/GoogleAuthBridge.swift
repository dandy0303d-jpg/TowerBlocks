//
//  GoogleAuthBridge.swift
//  Google Sign-In via ASWebAuthenticationSession (no third-party SDK).
//
//  Design:
//  - Native builds Google's OAuth 2.0 URL with the implicit id_token
//    flow (response_type=id_token) so we get a signed JWT back with
//    zero server-side code-exchange round-trip.
//  - ASWebAuthenticationSession presents Google's login sheet in a
//    Safari-based modal; user completes the flow; Google redirects
//    to our custom URL scheme with the id_token in the URL fragment.
//  - Native parses the id_token + returns to JS. JS sends it to our
//    server, which verifies the Google signature via Google's JWKS
//    and links the Google `sub` to the player's uuid.
//  - `nonce` is random per-signIn and echoed in the id_token — replay
//    detection is done server-side by comparing the nonce claim to
//    what our /link endpoint expects.
//
//  Why no SDK:
//  - GoogleSignIn-iOS pulls in SPM/CocoaPods, which fights with
//    Cocos's CMake-generated project. ASWebAuthenticationSession is
//    an Apple system framework and needs zero external deps.
//  - Feature parity is fine for our use case (auth + email + name).
//    We don't use Google Drive, GDrive save games, or any other GSI-
//    only feature.
//
//  Requires:
//  - iOS 13+ (we're 15+)
//  - Info.plist CFBundleURLTypes contains the reversed client ID
//    scheme (see Info.plist entry).
//  - Google Cloud Console: OAuth 2.0 iOS client for bundle id
//    com.konenine.tetritower.
//

import Foundation
import AuthenticationServices

/// Presentation delegate for ASWebAuthenticationSession. Deliberately
/// NOT `@objc public` — that would leak the class (and its protocol
/// conformance to ASWebAuthenticationPresentationContextProviding)
/// into the auto-generated Swift-to-ObjC header, requiring every
/// ObjC glue file that includes that header to also import
/// AuthenticationServices. Keeping this internal to Swift avoids the
/// cross-file rebuild dependency. Same pattern GameCenterUIDelegate
/// uses for GKGameCenterControllerDelegate.
@available(iOS 13.0, *)
class GoogleAuthPresentationDelegate: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = GoogleAuthPresentationDelegate()
    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes
        let windowScene = scenes.first { ($0.activationState == .foregroundActive) } as? UIWindowScene
            ?? scenes.first as? UIWindowScene
        return windowScene?.windows.first(where: { $0.isKeyWindow })
            ?? windowScene?.windows.first
            ?? ASPresentationAnchor()
    }
}

@available(iOS 13.0, *)
@objc public class GoogleAuthBridge: NSObject {

    @objc public static let shared = GoogleAuthBridge()

    // ---- Google OAuth client (public; safe to hardcode) --------------
    // Client ID from Google Cloud Console → APIs & Services → Credentials.
    // The redirect URI is the reversed client ID + ":/oauth".
    private static let CLIENT_ID       = "898144979904-3u7infqod1vhcshf538pc8l84t31b5kc.apps.googleusercontent.com"
    private static let REDIRECT_SCHEME = "com.googleusercontent.apps.898144979904-3u7infqod1vhcshf538pc8l84t31b5kc"
    private static let REDIRECT_URI    = "\(REDIRECT_SCHEME):/oauth"

    private static let AUTH_ENDPOINT   = "https://accounts.google.com/o/oauth2/v2/auth"

    // Session must be strongly retained while the flow is in flight —
    // ASWebAuthenticationSession is dismissed if it goes out of scope.
    private var currentSession: ASWebAuthenticationSession?

    private override init() {
        super.init()
    }

    /// Trigger the Google Sign-In flow. Presents the ASWebAuthenticationSession
    /// modal; on completion returns JSON:
    ///   Success: {"success":true,
    ///             "idToken":"<jwt>",
    ///             "nonce":"<random>",
    ///             "googleSub":"..." }  // sub extracted client-side
    ///                                    // for logging only; server
    ///                                    // re-extracts after signature verify.
    ///   Cancel:  {"success":false, "kind":"user-cancelled", "error":"..."}
    ///   Failure: {"success":false, "kind":"...", "error":"..."}
    @objc public func signIn(completion: @escaping (String) -> Void) {
        // Random 32-byte nonce (base64url, no padding) — echoed in the
        // id_token; server compares to guard against replay.
        var nonceBytes = [UInt8](repeating: 0, count: 32)
        let status = SecRandomCopyBytes(kSecRandomDefault, nonceBytes.count, &nonceBytes)
        guard status == errSecSuccess else {
            completion(Self.errorJSON(kind: "unknown", detail: "failed to generate nonce"))
            return
        }
        let nonce = Data(nonceBytes).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")

        // Build the OAuth URL. Implicit-flow with response_type=id_token
        // returns the id_token in the URL fragment (#id_token=...) —
        // no back-channel token exchange needed.
        var comps = URLComponents(string: Self.AUTH_ENDPOINT)!
        comps.queryItems = [
            URLQueryItem(name: "client_id",     value: Self.CLIENT_ID),
            URLQueryItem(name: "redirect_uri",  value: Self.REDIRECT_URI),
            URLQueryItem(name: "response_type", value: "id_token"),
            URLQueryItem(name: "scope",         value: "openid email profile"),
            URLQueryItem(name: "nonce",         value: nonce),
            // prompt=select_account so the user always picks an
            // account rather than silently reusing a cached session.
            // Trade-off: an extra tap when they only have one Google
            // account, but avoids surprise re-links on iPad-with-family.
            URLQueryItem(name: "prompt",        value: "select_account"),
        ]
        guard let authURL = comps.url else {
            completion(Self.errorJSON(kind: "unknown", detail: "failed to build auth URL"))
            return
        }

        DispatchQueue.main.async {
            let session = ASWebAuthenticationSession(
                url: authURL,
                callbackURLScheme: Self.REDIRECT_SCHEME
            ) { [weak self] callbackURL, error in
                guard let self = self else { return }
                self.currentSession = nil

                if let err = error {
                    let nsErr = err as NSError
                    if nsErr.domain == ASWebAuthenticationSessionError.errorDomain,
                       nsErr.code == ASWebAuthenticationSessionError.canceledLogin.rawValue {
                        completion(Self.errorJSON(kind: "user-cancelled", detail: "user dismissed the Google sheet"))
                    } else {
                        completion(Self.errorJSON(kind: "failed", detail: err.localizedDescription))
                    }
                    return
                }
                guard let url = callbackURL else {
                    completion(Self.errorJSON(kind: "unknown", detail: "no callback URL"))
                    return
                }

                // Google puts id_token in the FRAGMENT of the callback
                // URL: com.googleusercontent.apps.XXX:/oauth#id_token=JWT&...
                // Parse it out.
                guard let idToken = Self.extractIdToken(from: url) else {
                    completion(Self.errorJSON(kind: "failed", detail: "no id_token in callback: \(url.absoluteString)"))
                    return
                }
                // Extract sub client-side just for logging — server
                // re-decodes after signature verification, that's what
                // matters for auth.
                let sub = Self.extractSubFromJws(idToken) ?? "?"
                let payload: [String: Any] = [
                    "success":   true,
                    "idToken":   idToken,
                    "nonce":     nonce,
                    "googleSub": sub,
                ]
                completion(Self.encodeJSON(payload) ?? Self.errorJSON(kind: "unknown", detail: "json encode failed"))
            }
            session.presentationContextProvider = GoogleAuthPresentationDelegate.shared
            // prefersEphemeralWebBrowserSession=false so the user's
            // existing Google session (from Safari) is reused if
            // available — one tap sign-in when possible. Set to true
            // if we ever want strictly isolated sessions.
            session.prefersEphemeralWebBrowserSession = false
            self.currentSession = session
            let started = session.start()
            if !started {
                self.currentSession = nil
                completion(Self.errorJSON(kind: "unknown", detail: "ASWebAuthenticationSession.start() returned false"))
            }
        }
    }

    // MARK: - Helpers

    /// Google's implicit-flow callback puts params in the URL fragment,
    /// not the query. Parse `#id_token=JWT&...` manually.
    private static func extractIdToken(from url: URL) -> String? {
        // fragment is the part after `#`.
        guard let fragment = url.fragment, !fragment.isEmpty else { return nil }
        for pair in fragment.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1)
            if kv.count == 2 && kv[0] == "id_token" {
                return String(kv[1]).removingPercentEncoding
            }
        }
        return nil
    }

    /// Best-effort client-side JWT payload decode (NOT verification).
    /// Used only for the log line so we can see which Google account
    /// signed in. Server verifies for real.
    private static func extractSubFromJws(_ jws: String) -> String? {
        let parts = jws.split(separator: ".")
        guard parts.count == 3 else { return nil }
        var b64 = String(parts[1])
            .replacingOccurrences(of: "-", with: "+")
            .replacingOccurrences(of: "_", with: "/")
        while b64.count % 4 != 0 { b64.append("=") }
        guard let data = Data(base64Encoded: b64),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let sub = obj["sub"] as? String else {
            return nil
        }
        return sub
    }

    private static func encodeJSON(_ obj: Any) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    private static func errorJSON(kind: String, detail: String) -> String {
        let obj: [String: Any] = [
            "success": false,
            "kind":    kind,
            "error":   detail,
        ]
        return encodeJSON(obj) ?? #"{"success":false,"kind":"unknown","error":"encode failure"}"#
    }
}
