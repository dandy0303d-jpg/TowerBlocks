//
//  GameCenterBridge.swift
//  Game Center (GameKit) native wrapper.
//
//  Design:
//  - Sets GKLocalPlayer.local.authenticateHandler ONCE at app boot
//    (from AppDelegate → GameCenterBridgeGlue.registerWithCocos).
//    iOS invokes the handler with either:
//      (a) a UIViewController to present (fresh login required —
//          we present it on the app's key window's rootVC)
//      (b) nil vc + isAuthenticated == true (silent success — Game
//          Center session persists across app launches)
//      (c) nil vc + error (user declined, not signed in, etc.)
//  - Emits authentication result to JS via the ObjC glue as a
//    JSON event so the game can display the player's Game Center
//    display name / avatar and use gamePlayerID as a stable identifier.
//  - `authenticate()` from JS is a no-op after the initial callback
//    fires — GameKit fires it exactly once per app launch; asking
//    again returns the cached state.
//
//  Requires:
//  - iOS 14.5+ for `teamPlayerID` (we're on iOS 15+ so fine).
//  - Xcode Signing & Capabilities → "Game Center" capability added.
//    Also need App Store Connect → App → Services → Game Center
//    enabled (default off for new apps).
//

import Foundation
import GameKit
import UIKit

@objc public class GameCenterBridge: NSObject {

    // MARK: - Singleton

    @objc public static let shared = GameCenterBridge()

    private override init() { super.init() }

    // Cached last-known auth state. `nil` before the handler fires
    // the first time; a JSON string thereafter (see emit()).
    private var lastResult: String?

    // Callback set by the ObjC glue — invoked once per authenticate
    // result. Cocos's bridge dispatchEventToScript touches V8 and
    // must run on main; glue handles the queue hop.
    @objc public var onAuthResult: ((String) -> Void)?

    // MARK: - Public API

    /// Install the authenticateHandler. Idempotent — safe to call more
    /// than once; only the first install matters (subsequent calls
    /// overwrite the closure but GameKit's cached state is unchanged).
    /// MUST be called on the main thread (UIKit touch inside the
    /// handler).
    @objc public func startAutoLogin() {
        // Snapshot: if we're already authenticated from a prior call,
        // emit immediately so a late JS listener still gets the state.
        if GKLocalPlayer.local.isAuthenticated, let cached = lastResult {
            self.emit(cached)
            return
        }
        GKLocalPlayer.local.authenticateHandler = { [weak self] vc, error in
            guard let self = self else { return }

            // (a) iOS wants us to present a login sheet.
            if let vc = vc {
                DispatchQueue.main.async {
                    if let top = Self.topViewController() {
                        top.present(vc, animated: true, completion: nil)
                        NSLog("[GameCenter] presented login sheet")
                    } else {
                        NSLog("[GameCenter] no top VC to present login sheet — user won't see it")
                        self.emit(Self.errorJSON(kind: "no-present-vc",
                                                 detail: "no top view controller available"))
                    }
                }
                return
            }

            // (b) or (c) — resolve to success / failure.
            if let error = error {
                NSLog("[GameCenter] authenticate error: \(error.localizedDescription)")
                self.emit(Self.errorJSON(kind: "auth-failed",
                                         detail: error.localizedDescription))
                return
            }

            if GKLocalPlayer.local.isAuthenticated {
                let p = GKLocalPlayer.local
                let payload: [String: Any] = [
                    "success": true,
                    "gamePlayerID": p.gamePlayerID,            // stable per-game
                    "teamPlayerID": p.teamPlayerID,            // stable per-team (dev account)
                    "displayName":  p.displayName,             // localised name for UI
                    "alias":        p.alias,                   // user's nickname
                    "isUnderage":   p.isUnderage,              // for age-gated features
                ]
                let json = Self.encodeJSON(payload) ??
                           Self.errorJSON(kind: "encode-failed", detail: "json encode failed")
                self.emit(json)
                NSLog("[GameCenter] authenticated as \(p.displayName) (\(p.gamePlayerID))")
                return
            }

            // Neither vc, error, nor authenticated — shouldn't happen
            // per docs but defensively:
            self.emit(Self.errorJSON(kind: "unknown", detail: "handler fired with no state"))
        }
    }

    /// Report the last-known auth state to JS. Idempotent — safe for
    /// the JS layer to poll if it missed the initial event (e.g. the
    /// JS side registered its listener after the callback already
    /// fired).
    @objc public func requestState() {
        if let cached = lastResult {
            self.emit(cached)
        } else {
            // Handler hasn't fired yet — reply with a pending sentinel.
            self.emit(#"{"success":false,"kind":"pending","error":"authenticateHandler has not yet fired"}"#)
        }
    }

    // MARK: - Helpers

    private func emit(_ json: String) {
        self.lastResult = json
        DispatchQueue.main.async {
            if let cb = self.onAuthResult {
                cb(json)
            }
        }
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
            "kind": kind,
            "error": detail,
        ]
        return encodeJSON(obj) ?? #"{"success":false,"kind":"unknown","error":"encode failure"}"#
    }

    /// Walk the app's window scene to find the frontmost presented
    /// view controller — GameKit's login sheet needs it.
    private static func topViewController() -> UIViewController? {
        let scenes = UIApplication.shared.connectedScenes
        let windowScene = scenes.first { ($0.activationState == .foregroundActive) } as? UIWindowScene
            ?? scenes.first as? UIWindowScene
        guard let win = windowScene?.windows.first(where: { $0.isKeyWindow })
                  ?? windowScene?.windows.first else {
            return nil
        }
        var vc = win.rootViewController
        while let presented = vc?.presentedViewController {
            vc = presented
        }
        return vc
    }
}
