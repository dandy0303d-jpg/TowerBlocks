//
//  AppleAuthBridge.swift
//  Sign in with Apple (SIWA) native wrapper.
//
//  Design:
//  - Uses AuthenticationServices.framework ASAuthorizationController.
//  - Presents the native SIWA sheet, returns the signed identity_token
//    to the JS layer for server-side verification.
//  - Only requests the 'user' scope needed for account linking (Apple
//    unique user id). Email/name intentionally NOT requested — per
//    product decision to store minimum PII (see docs).
//  - `getCredentialState(sub:)` lets JS check periodically whether the
//    user has revoked Apple ID access in iOS Settings — server should
//    demote the link to "revoked" so guest UUID is still primary.
//
//  Requires:
//  - iOS 13+ (SIWA was introduced there; we're on iOS 15+ anyway).
//  - Xcode Signing & Capabilities → "Sign in with Apple" capability
//    added. Xcode auto-provisions the App ID entitlement.
//

import Foundation
import AuthenticationServices

@available(iOS 13.0, *)
@objc public class AppleAuthBridge: NSObject {

    // MARK: - Singleton

    @objc public static let shared = AppleAuthBridge()

    private override init() {
        super.init()
    }

    // In-flight sign-in state. Only one at a time — the SIWA sheet is
    // modal so this is a natural constraint.
    private var pendingCompletion: ((String) -> Void)?
    private var delegateBox: SignInDelegate?

    // MARK: - Public API — all @objc so ObjC glue can call.

    /// Start the SIWA flow. Presents the system sheet; on success
    /// returns JSON:
    ///   {"success":true,
    ///    "identityToken":"<JWS>",
    ///    "authorizationCode":"...",
    ///    "appleSub":"001234.abcd..."}
    /// On failure:
    ///   {"success":false, "kind":"user-cancelled|not-handled|failed|unknown", "error":"..."}
    ///
    /// `appleSub` is Apple's stable per-app unique user id (the `sub`
    /// JWT claim). It's the join key you store server-side to link
    /// Apple ID → uuid.
    @objc(signInWithCompletion:)
    public func signIn(completion: @escaping (String) -> Void) {
        DispatchQueue.main.async {
            if self.pendingCompletion != nil {
                completion(Self.errorJSON(kind: "unknown", detail: "another sign-in already in progress"))
                return
            }
            self.pendingCompletion = completion

            let provider = ASAuthorizationAppleIDProvider()
            let request  = provider.createRequest()
            // Deliberately NOT requesting .email or .fullName — we
            // don't need PII, only the stable Apple user id.
            request.requestedScopes = []

            let controller = ASAuthorizationController(authorizationRequests: [request])
            let delegate = SignInDelegate(owner: self)
            self.delegateBox = delegate
            controller.delegate = delegate
            controller.presentationContextProvider = delegate
            controller.performRequests()
        }
    }

    /// Check current credential state for a previously-stored appleSub.
    /// JSON: {"state":"authorized|revoked|notFound|transferred"}
    ///
    /// Call this at app boot (from JS) if the local cache says the
    /// player is already Apple-linked. If it comes back "revoked" the
    /// server-side link should be dropped so the guest UUID still
    /// owns their progress.
    @objc(getCredentialStateWithSub:completion:)
    public func getCredentialState(sub: String, completion: @escaping (String) -> Void) {
        ASAuthorizationAppleIDProvider().getCredentialState(forUserID: sub) { state, _ in
            let name: String
            switch state {
            case .authorized:  name = "authorized"
            case .revoked:     name = "revoked"
            case .notFound:    name = "notFound"
            case .transferred: name = "transferred"
            @unknown default:  name = "unknown"
            }
            let json = "{\"state\":\"\(name)\"}"
            completion(json)
        }
    }

    // MARK: - Internal — delegate callbacks from ASAuthorizationController

    fileprivate func handleSuccess(_ auth: ASAuthorization) {
        guard let credential = auth.credential as? ASAuthorizationAppleIDCredential else {
            self.finish(errorKind: "unknown", detail: "credential wrong type")
            return
        }
        guard let identityData = credential.identityToken,
              let identityToken = String(data: identityData, encoding: .utf8) else {
            self.finish(errorKind: "unknown", detail: "missing identityToken in credential")
            return
        }
        let authCodeStr: String
        if let authData = credential.authorizationCode,
           let s = String(data: authData, encoding: .utf8) {
            authCodeStr = s
        } else {
            authCodeStr = ""
        }
        let sub = credential.user   // stable per-app user id
        let payload: [String: Any] = [
            "success": true,
            "identityToken": identityToken,
            "authorizationCode": authCodeStr,
            "appleSub": sub,
        ]
        self.finish(json: Self.encodeJSON(payload) ?? Self.errorJSON(kind: "unknown", detail: "json encode failed"))
    }

    fileprivate func handleError(_ error: Error) {
        var kind = "unknown"
        if let ae = error as? ASAuthorizationError {
            switch ae.code {
            case .canceled:               kind = "user-cancelled"
            case .invalidResponse:        kind = "failed"
            case .notHandled:             kind = "not-handled"
            case .failed:                 kind = "failed"
            case .notInteractive:         kind = "unknown"
            case .unknown:                kind = "unknown"
            @unknown default:             kind = "unknown"
            }
        }
        self.finish(errorKind: kind, detail: error.localizedDescription)
    }

    private func finish(json: String) {
        let cb = self.pendingCompletion
        self.pendingCompletion = nil
        self.delegateBox = nil
        cb?(json)
    }

    private func finish(errorKind: String, detail: String) {
        self.finish(json: Self.errorJSON(kind: errorKind, detail: detail))
    }

    // MARK: - Helpers

    private static func encodeJSON(_ obj: Any) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: obj, options: []) else {
            return nil
        }
        return String(data: data, encoding: .utf8)
    }

    fileprivate static func errorJSON(kind: String, detail: String) -> String {
        // JSON-escape backslashes and quotes in detail.
        let escaped = detail
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
        return "{\"success\":false,\"kind\":\"\(kind)\",\"error\":\"\(escaped)\"}"
    }
}

// ---------------------------------------------------------------------------
// Delegate for the ASAuthorizationController — must be an NSObject and
// implement both callback protocols. Held strongly by AppleAuthBridge
// via delegateBox for the duration of the flow.
// ---------------------------------------------------------------------------

@available(iOS 13.0, *)
private class SignInDelegate: NSObject,
    ASAuthorizationControllerDelegate,
    ASAuthorizationControllerPresentationContextProviding {

    weak var owner: AppleAuthBridge?

    init(owner: AppleAuthBridge) {
        self.owner = owner
    }

    func authorizationController(controller: ASAuthorizationController,
                                 didCompleteWithAuthorization authorization: ASAuthorization) {
        self.owner?.handleSuccess(authorization)
    }

    func authorizationController(controller: ASAuthorizationController,
                                 didCompleteWithError error: Error) {
        self.owner?.handleError(error)
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        // Best-effort: return the first key window. In practice we
        // always have exactly one in a Cocos app.
        if let scene = UIApplication.shared.connectedScenes.first as? UIWindowScene,
           let window = scene.windows.first(where: { $0.isKeyWindow }) ?? scene.windows.first {
            return window
        }
        return ASPresentationAnchor()
    }
}
