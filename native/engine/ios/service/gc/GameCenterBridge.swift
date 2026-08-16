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

/// Delegate for GKGameCenterViewController — only job is to dismiss
/// the panel when the player taps "Done". Singleton because there's
/// never more than one panel up at a time, and the delegate needs a
/// strong retainer (GKGameCenterViewController holds it weakly).
@objc public class GameCenterUIDelegate: NSObject, GKGameCenterControllerDelegate {
    @objc public static let shared = GameCenterUIDelegate()
    public func gameCenterViewControllerDidFinish(_ gameCenterViewController: GKGameCenterViewController) {
        gameCenterViewController.dismiss(animated: true, completion: nil)
    }
}

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

    /// Submit a score to a Game Center leaderboard.
    /// - leaderboardID must match an ID created in ASC → Game Center.
    /// - score is an Int64 — GC preserves whatever units the leaderboard
    ///   was configured for (integer / decimal points).
    /// Completion JSON: {"success":true} or {"success":false,"kind":"...","error":"..."}
    @objc public func submitScore(leaderboardID: String, score: Int64, completion: @escaping (String) -> Void) {
        guard GKLocalPlayer.local.isAuthenticated else {
            completion(Self.errorJSON(kind: "not-authenticated", detail: "not signed into Game Center"))
            return
        }
        // GKLeaderboard.submitScore (iOS 14+) is the modern API — the
        // GKScore + report(_:withCompletionHandler:) pair is deprecated.
        if #available(iOS 14.0, *) {
            GKLeaderboard.submitScore(
                Int(score),
                context: 0,
                player: GKLocalPlayer.local,
                leaderboardIDs: [leaderboardID]
            ) { error in
                if let error = error {
                    NSLog("[GameCenter] submitScore(\(leaderboardID), \(score)) failed: \(error.localizedDescription)")
                    completion(Self.errorJSON(kind: "submit-failed", detail: error.localizedDescription))
                } else {
                    NSLog("[GameCenter] submitScore(\(leaderboardID), \(score)) ok")
                    completion(#"{"success":true}"#)
                }
            }
        } else {
            completion(Self.errorJSON(kind: "ios-too-old", detail: "requires iOS 14+"))
        }
    }

    /// Report progress on a Game Center achievement.
    /// - achievementID must match an ID created in ASC → Game Center.
    /// - percentComplete is 0-100 (double). 100 = fully unlocked.
    /// Uses showsCompletionBanner=true so player sees the "Achievement
    /// Unlocked" HUD when reaching 100%.
    /// Completion JSON: {"success":true} or {"success":false,"kind":"...","error":"..."}
    @objc public func reportAchievement(achievementID: String, percentComplete: Double, completion: @escaping (String) -> Void) {
        guard GKLocalPlayer.local.isAuthenticated else {
            completion(Self.errorJSON(kind: "not-authenticated", detail: "not signed into Game Center"))
            return
        }
        let ach = GKAchievement(identifier: achievementID)
        ach.percentComplete = max(0, min(100, percentComplete))
        ach.showsCompletionBanner = true
        GKAchievement.report([ach]) { error in
            if let error = error {
                NSLog("[GameCenter] reportAchievement(\(achievementID), \(percentComplete)%) failed: \(error.localizedDescription)")
                completion(Self.errorJSON(kind: "report-failed", detail: error.localizedDescription))
            } else {
                NSLog("[GameCenter] reportAchievement(\(achievementID), \(percentComplete)%) ok")
                completion(#"{"success":true}"#)
            }
        }
    }

    /// Present the native Game Center UI. `stateKind` selects which
    /// tab opens:
    ///   ""             — default (leaderboards list)
    ///   "leaderboards" — leaderboards, all
    ///   "leaderboard:<id>" — a specific leaderboard by ID
    ///   "achievements" — achievements
    ///   "dashboard"    — the top-level dashboard
    /// Silently returns on non-iOS-14+ (rare — we're on iOS 15+).
    @objc public func showUI(stateKind: String, completion: @escaping (String) -> Void) {
        guard GKLocalPlayer.local.isAuthenticated else {
            completion(Self.errorJSON(kind: "not-authenticated", detail: "not signed into Game Center"))
            return
        }
        DispatchQueue.main.async {
            guard let top = Self.topViewController() else {
                completion(Self.errorJSON(kind: "no-present-vc", detail: "no top view controller"))
                return
            }
            if #available(iOS 14.0, *) {
                let vc: GKGameCenterViewController
                if stateKind.hasPrefix("leaderboard:") {
                    let id = String(stateKind.dropFirst("leaderboard:".count))
                    vc = GKGameCenterViewController(leaderboardID: id, playerScope: .global, timeScope: .allTime)
                } else if stateKind == "achievements" {
                    vc = GKGameCenterViewController(state: .achievements)
                } else if stateKind == "leaderboards" {
                    vc = GKGameCenterViewController(state: .leaderboards)
                } else {
                    vc = GKGameCenterViewController(state: .dashboard)
                }
                vc.gameCenterDelegate = GameCenterUIDelegate.shared
                top.present(vc, animated: true, completion: {
                    completion(#"{"success":true}"#)
                })
            } else {
                completion(Self.errorJSON(kind: "ios-too-old", detail: "requires iOS 14+"))
            }
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
