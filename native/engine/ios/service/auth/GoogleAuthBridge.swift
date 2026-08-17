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
import CommonCrypto

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
    private static let TOKEN_ENDPOINT  = "https://oauth2.googleapis.com/token"

    // Session must be strongly retained while the flow is in flight —
    // ASWebAuthenticationSession is dismissed if it goes out of scope.
    private var currentSession: ASWebAuthenticationSession?

    private override init() {
        super.init()
    }

    /// Trigger the Google Sign-In flow. Uses OAuth 2.0
    /// authorization_code + PKCE (the only flow Google's iOS OAuth
    /// clients allow). The client-side code exchange then hits
    /// https://oauth2.googleapis.com/token to swap the code for an
    /// id_token. Returns:
    ///   Success: {"success":true, "idToken":"<jwt>", "googleSub":"..."}
    ///   Cancel:  {"success":false, "kind":"user-cancelled", "error":"..."}
    ///   Failure: {"success":false, "kind":"...", "error":"..."}
    @objc(signInWithCompletion:)
    public func signIn(completion: @escaping (String) -> Void) {
        // ---- PKCE: generate code_verifier + code_challenge ------------
        // code_verifier: high-entropy random 43-128 char string
        //   (spec: RFC 7636). Sent to Google's token endpoint later
        //   to prove the caller who exchanges the code is the same
        //   one who initiated the auth request.
        // code_challenge: base64url(SHA256(code_verifier))
        var verifierBytes = [UInt8](repeating: 0, count: 32)
        guard SecRandomCopyBytes(kSecRandomDefault, verifierBytes.count, &verifierBytes) == errSecSuccess else {
            completion(Self.errorJSON(kind: "unknown", detail: "failed to generate PKCE verifier"))
            return
        }
        let verifier = Self.base64urlNoPad(Data(verifierBytes))
        let challenge = Self.base64urlNoPad(Self.sha256(Data(verifier.utf8)))

        // ---- Build OAuth URL (authorization_code flow) ----------------
        var comps = URLComponents(string: Self.AUTH_ENDPOINT)!
        comps.queryItems = [
            URLQueryItem(name: "client_id",             value: Self.CLIENT_ID),
            URLQueryItem(name: "redirect_uri",          value: Self.REDIRECT_URI),
            URLQueryItem(name: "response_type",         value: "code"),
            URLQueryItem(name: "scope",                 value: "openid email profile"),
            URLQueryItem(name: "code_challenge",        value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "prompt",                value: "select_account"),
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
                // Code flow puts `code` in the QUERY string (not
                // fragment): com.googleusercontent.apps.XXX:/oauth?code=Y&...
                guard let code = Self.extractQueryParam(from: url, name: "code") else {
                    let errParam = Self.extractQueryParam(from: url, name: "error") ?? "no code"
                    completion(Self.errorJSON(kind: "failed", detail: "auth callback: \(errParam)"))
                    return
                }
                // Exchange the code for an id_token via Google's token
                // endpoint. iOS clients have no client_secret (public
                // client); PKCE code_verifier serves the same role.
                Self.exchangeCodeForIdToken(code: code, codeVerifier: verifier) { result in
                    switch result {
                    case .success(let idToken):
                        let sub = Self.extractSubFromJws(idToken) ?? "?"
                        let payload: [String: Any] = [
                            "success":   true,
                            "idToken":   idToken,
                            "googleSub": sub,
                        ]
                        completion(Self.encodeJSON(payload) ?? Self.errorJSON(kind: "unknown", detail: "json encode failed"))
                    case .failure(let err):
                        completion(Self.errorJSON(kind: "failed", detail: "token exchange: \(err.localizedDescription)"))
                    }
                }
            }
            session.presentationContextProvider = GoogleAuthPresentationDelegate.shared
            session.prefersEphemeralWebBrowserSession = false
            self.currentSession = session
            let started = session.start()
            if !started {
                self.currentSession = nil
                completion(Self.errorJSON(kind: "unknown", detail: "ASWebAuthenticationSession.start() returned false"))
            }
        }
    }

    // MARK: - Token exchange

    /// POST to Google's token endpoint to swap the authorization code
    /// for an id_token. iOS OAuth clients are public (no secret) —
    /// PKCE code_verifier proves ownership of the original request.
    private static func exchangeCodeForIdToken(
        code: String,
        codeVerifier: String,
        completion: @escaping (Result<String, Error>) -> Void
    ) {
        guard let url = URL(string: TOKEN_ENDPOINT) else {
            completion(.failure(NSError(domain: "GoogleAuth", code: -1, userInfo: [NSLocalizedDescriptionKey: "bad token URL"])))
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")

        // Body params — application/x-www-form-urlencoded requires
        // URL-encoded values. All our values are already URL-safe
        // (client_id / code / verifier are base64url / OAuth-safe)
        // except redirect_uri which contains a ':' — percent-encode.
        let params: [(String, String)] = [
            ("client_id",     CLIENT_ID),
            ("code",          code),
            ("code_verifier", codeVerifier),
            ("grant_type",    "authorization_code"),
            ("redirect_uri",  REDIRECT_URI),
        ]
        let body = params.map { (k, v) in
            let ev = v.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? v
            return "\(k)=\(ev)"
        }.joined(separator: "&")
        req.httpBody = body.data(using: .utf8)

        URLSession.shared.dataTask(with: req) { data, resp, err in
            if let err = err {
                completion(.failure(err))
                return
            }
            guard let http = resp as? HTTPURLResponse, let data = data else {
                completion(.failure(NSError(domain: "GoogleAuth", code: -2, userInfo: [NSLocalizedDescriptionKey: "no response"])))
                return
            }
            if http.statusCode < 200 || http.statusCode >= 300 {
                let body = String(data: data, encoding: .utf8) ?? "<binary>"
                completion(.failure(NSError(domain: "GoogleAuth", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: "HTTP \(http.statusCode): \(body)"])))
                return
            }
            guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let idToken = obj["id_token"] as? String, !idToken.isEmpty else {
                let body = String(data: data, encoding: .utf8) ?? "<binary>"
                completion(.failure(NSError(domain: "GoogleAuth", code: -3, userInfo: [NSLocalizedDescriptionKey: "no id_token in response: \(body)"])))
                return
            }
            completion(.success(idToken))
        }.resume()
    }

    // MARK: - Helpers

    /// Extract a query-string param from the OAuth callback URL.
    /// (Authorization-code flow returns `?code=X&state=Y`; unlike the
    /// implicit flow, values live in the query, not the fragment.)
    private static func extractQueryParam(from url: URL, name: String) -> String? {
        guard let comps = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let items = comps.queryItems else { return nil }
        return items.first(where: { $0.name == name })?.value
    }

    /// SHA256(data) — used for PKCE code_challenge derivation.
    private static func sha256(_ data: Data) -> Data {
        var hash = [UInt8](repeating: 0, count: Int(CC_SHA256_DIGEST_LENGTH))
        data.withUnsafeBytes {
            _ = CC_SHA256($0.baseAddress, CC_LONG(data.count), &hash)
        }
        return Data(hash)
    }

    /// Base64url encoding without padding — required by PKCE + JWS.
    private static func base64urlNoPad(_ data: Data) -> String {
        return data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
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
