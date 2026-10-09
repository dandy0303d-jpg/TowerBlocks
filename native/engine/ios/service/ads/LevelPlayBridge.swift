//
//  LevelPlayBridge.swift
//
//  Swift side of the TS↔Native pipe for Unity LevelPlay (formerly
//  ironSource) mediation SDK on iOS.
//
//  SDK is pulled via CocoaPods. (SPM was tried first but hung at
//  "Preparing to validate..." on adapter packages inside Cocos's
//  CMake-generated Xcode project — see Podfile header for the full
//  story.) The IronSource pod has been stable for years and does NOT
//  carry the XCFramework header-search-path issues that bit Firebase.
//
//  Setup (one-time per clone, after Cocos regen):
//    cd build/<build-id>/proj
//    pod install
//    open tower_blocks.xcworkspace   # NOT the .xcodeproj
//
//  Pods added (see Podfile):
//    IronSourceSDK       9.5.0.0    — core LevelPlay SDK
//    ISUnityAdsAdapter   5.8.1.0.0  — Unity Ads
//    ISAdMobAdapter      5.10.1.0.0 — Google AdMob
//    ISFacebookAdapter   5.3.1.0.0  — Meta (pod kept Facebook name)
//    ISAppLovinAdapter   5.7.1.0.0  — AppLovin MAX
//
//  App Key: add to Info.plist so this bridge can read it without a
//  JS round-trip. The channel-specific key goes in each channel branch:
//    <key>LevelPlayAppKey</key>
//    <string>XXXXXXX</string>
//
//  Event schema — MUST stay lockstep with LevelPlayBridge.kt (Android)
//  and the shared LevelPlayAdProvider.ts on develop:
//
//    JS  → Native:
//      "levelplay.init"            arg = uuid string
//      "levelplay.rewardedReady"   arg = (ignored)
//      "levelplay.showRewarded"    arg = ad unit id (placement string)
//
//    Native → JS:
//      "levelplay.initResult"          arg = JSON {"success":bool, "error"?}
//      "levelplay.rewardedReadyResult" arg = JSON {"ready":bool}
//      "levelplay.showRewardedResult"  arg = JSON {"kind":"rewarded"|"dismissed"|"error", "reason"?}
//      "levelplay.rewardedAvailable"   arg = JSON {"ready":bool}   (push)
//

import Foundation
import UIKit
// `IronSource` is the Swift module name of IronSource.framework
// installed by the `IronSourceSDK` CocoaPods pod.
import IronSource

@objcMembers
public class LevelPlayBridge: NSObject {

    // Singleton — the Objective-C++ glue grabs this via `[LevelPlayBridge shared]`.
    public static let shared = LevelPlayBridge()
    private override init() { super.init() }

    // ─── Callbacks wired by the Glue layer ───────────────────────────
    // The Glue sets these to forward the JSON string to JsbBridgeWrapper.
    // Kept as blocks so this file stays Cocos-agnostic.
    public var onInitResult:            ((String) -> Void)?
    public var onRewardedReadyResult:   ((String) -> Void)?
    public var onShowRewardedResult:    ((String) -> Void)?
    public var onRewardedAvailable:     ((String) -> Void)?

    // ─── State ──────────────────────────────────────────────────────
    // Per-placement rewarded ad instances. LevelPlay 8.x+ is per-ad-unit:
    // one `LPMRewardedAd` per unit, kept alive across load/show cycles.
    private var rewardedAds: [String: LPMRewardedAd] = [:]
    // Flipped by LPMRewardedAdDelegate callbacks. Mirrors the aggregate
    // "any rewarded ad ready" flag the Android bridge keeps — but JS's
    // readiness check still goes per-placement via rewardedReady event.
    private var rewardedReady: Bool = false
    // Set by didReceiveReward(forAd:); consumed by didCloseAd to tell
    // 'rewarded' (watched) apart from 'dismissed' (skipped).
    private var earned: Bool = false

    // ─── Entry points called by the Glue ────────────────────────────

    /// Called when JS sends "levelplay.init". `uuid` is the player id —
    /// LevelPlay stamps it onto impressions so the S2S reward callback
    /// server-side can route credits to the right wallet.
    public func initSdk(uuid: String) {
        let appKey = Self.readAppKey()
        guard !appKey.isEmpty else {
            emitInitResult(success: false, error: "LevelPlayAppKey missing from Info.plist")
            return
        }

        // User id — required for S2S. Empty string allowed (pre-login),
        // in that case server-side S2S cannot credit; the TS layer should
        // re-init() after login once the uuid is known.
        IronSource.setUserId(uuid)

        // Enable the Integration Verification Suite only on debug builds.
        // On release this is a no-op path — the suite is a dev tool that
        // overlays a diagnostic view; shipping with it would be a bug.
        #if DEBUG
        IronSource.setMetaDataWithKey("is_test_suite", value: "enable")
        #endif

        NSLog("[LevelPlay] init starting (appKey=\(String(appKey.prefix(6)))…, uuid=\(String(uuid.prefix(8)))…)")

        // Modern LevelPlay init API — LPMInitRequestBuilder → LPMInitRequest
        // + completion handler. Ad formats are NOT declared here anymore;
        // each LPMRewardedAd / LPMInterstitialAd instance registers its
        // own placement with the SDK on first loadAd(). (Older 7.x
        // ironSource SDK used .withLegacyAdFormats([IS_REWARDED_VIDEO])
        // — that path is removed in LevelPlay 9.x and we're on the
        // LevelPlay-Swift-Package SPM distribution now.)
        let initReq = LPMInitRequestBuilder(appKey: appKey)
            .build()

        LevelPlay.initWith(initReq) { [weak self] config, error in
            guard let self = self else { return }
            if let error = error {
                NSLog("[LevelPlay] onInitFailed: \(error.localizedDescription)")
                self.emitInitResult(success: false, error: error.localizedDescription)
                return
            }
            NSLog("[LevelPlay] onInitSuccess (config=\(String(describing: config)))")
            // Prepare the default rewarded ad unit. Ad ops can add more
            // units later by calling createAndLoadRewarded(adUnitId:)
            // — one instance per ad unit id.
            self.createAndLoadRewarded(adUnitId: Self.defaultRewardedAdUnit)
            self.emitInitResult(success: true, error: nil)
        }
    }

    /// Called when JS sends "levelplay.rewardedReady". Reads the SDK's
    /// current readiness for the default ad unit (not the cached flag,
    /// which can lag by one listener callback).
    public func checkRewardedReady() {
        let adUnit = Self.defaultRewardedAdUnit
        let ad = rewardedAds[adUnit]
        let ready = ad?.isAdReady() ?? false
        rewardedReady = ready
        emit(onRewardedReadyResult, event: "rewardedReadyResult",
             json: Self.jsonString(["ready": ready]))
    }

    /// Called when JS sends "levelplay.showRewarded". `placement` is the
    /// LevelPlay ad unit id (NOT placement name). Lazy-creates the ad
    /// instance if JS asks for one we haven't built yet (then tells JS
    /// to retry in a few seconds).
    public func showRewarded(placement: String?) {
        let adUnit = (placement?.isEmpty == false) ? placement! : Self.defaultRewardedAdUnit

        guard let viewController = Self.topViewController() else {
            emit(onShowRewardedResult, event: "showRewardedResult",
                 json: Self.jsonString(["kind": "error", "reason": "no root view controller"]))
            return
        }

        guard let ad = rewardedAds[adUnit] else {
            NSLog("[LevelPlay] showRewarded: no ad for adUnit=\(adUnit), creating lazily")
            createAndLoadRewarded(adUnitId: adUnit)
            emit(onShowRewardedResult, event: "showRewardedResult",
                 json: Self.jsonString(["kind": "error",
                                        "reason": "not-ready — unit lazily created, try again"]))
            return
        }

        guard ad.isAdReady() else {
            emit(onShowRewardedResult, event: "showRewardedResult",
                 json: Self.jsonString(["kind": "error", "reason": "not-ready"]))
            return
        }

        earned = false
        NSLog("[LevelPlay] showRewarded: showing adUnit=\(adUnit)")
        // Second arg is the LevelPlay-dashboard "placement" name used for
        // capping — pass the ad unit id itself as the default placement.
        // If you set up custom named placements in the dashboard, surface
        // their names on a per-call basis from TS.
        ad.showAd(viewController: viewController, placementName: adUnit)
    }

    // ─── Rewarded ad plumbing ───────────────────────────────────────

    /// Build (or reuse) the LPMRewardedAd for `adUnitId`, attach a
    /// delegate that forwards events, and kick a load. Idempotent —
    /// safe to call repeatedly for the same unit.
    private func createAndLoadRewarded(adUnitId: String) {
        if let existing = rewardedAds[adUnitId] {
            existing.loadAd()
            return
        }
        let ad = LPMRewardedAd(adUnitId: adUnitId)
        let delegate = RewardedDelegate(bridge: self, adUnitId: adUnitId)
        ad.setDelegate(delegate)
        // Keep the delegate alive — LPMRewardedAd holds a weak ref.
        rewardedDelegates[adUnitId] = delegate
        rewardedAds[adUnitId] = ad
        ad.loadAd()
    }

    private var rewardedDelegates: [String: RewardedDelegate] = [:]

    // ─── Helpers ─────────────────────────────────────────────────────

    fileprivate func pushRewardedAvailable(_ ready: Bool) {
        rewardedReady = ready
        emit(onRewardedAvailable, event: "rewardedAvailable",
             json: Self.jsonString(["ready": ready]))
    }

    fileprivate func emitShowResult(kind: String, reason: String?) {
        var payload: [String: Any] = ["kind": kind]
        if let reason = reason { payload["reason"] = reason }
        emit(onShowRewardedResult, event: "showRewardedResult",
             json: Self.jsonString(payload))
    }

    private func emitInitResult(success: Bool, error: String?) {
        var payload: [String: Any] = ["success": success]
        if let error = error { payload["error"] = error }
        emit(onInitResult, event: "initResult", json: Self.jsonString(payload))
    }

    private func emit(_ cb: ((String) -> Void)?, event: String, json: String) {
        if let cb = cb { cb(json); return }
        NSLog("[LevelPlay] no listener wired for \(event); payload=\(json)")
    }

    // ─── Config reads ────────────────────────────────────────────────

    private static func readAppKey() -> String {
        return Bundle.main.object(forInfoDictionaryKey: "LevelPlayAppKey") as? String ?? ""
    }

    // Fallback ad unit — matches the Android default so both platforms
    // can share the same TS BuildConfig constant until iOS ad units
    // are provisioned in the LevelPlay dashboard.
    //
    // TODO(levelplay-ios): replace with the iOS-specific ad unit id
    // once the LevelPlay dashboard has a separate iOS rewarded unit.
    private static let defaultRewardedAdUnit = "8sdnjo086acl132c"

    private static func jsonString(_ obj: [String: Any]) -> String {
        guard JSONSerialization.isValidJSONObject(obj),
              let data = try? JSONSerialization.data(withJSONObject: obj, options: []),
              let s = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return s
    }

    /// Find the top-most presented view controller to attach the
    /// rewarded ad modal to. Walks presentedViewController / nav /
    /// tab containers to find the real foreground VC — presenting
    /// on a dismissed VC is a no-op and crashes on older iOS.
    private static func topViewController(base: UIViewController? =
        UIApplication.shared.connectedScenes
            .compactMap { ($0 as? UIWindowScene) }
            .flatMap { $0.windows }
            .first { $0.isKeyWindow }?
            .rootViewController) -> UIViewController? {
        if let nav = base as? UINavigationController {
            return topViewController(base: nav.visibleViewController)
        }
        if let tab = base as? UITabBarController, let selected = tab.selectedViewController {
            return topViewController(base: selected)
        }
        if let presented = base?.presentedViewController {
            return topViewController(base: presented)
        }
        return base
    }
}

// ─────────────────────────────────────────────────────────────────────
// Rewarded delegate — forwards LevelPlay 8.x callbacks to the bridge.
// One delegate per ad unit so we don't have to carry adUnitId through
// every callback (LevelPlay also passes adInfo.adUnitId but using a
// bound value is simpler and matches the Android object-scoping).
// ─────────────────────────────────────────────────────────────────────
private class RewardedDelegate: NSObject, LPMRewardedAdDelegate {

    weak var bridge: LevelPlayBridge?
    let adUnitId: String

    init(bridge: LevelPlayBridge, adUnitId: String) {
        self.bridge = bridge
        self.adUnitId = adUnitId
        super.init()
    }

    func didLoadAd(with adInfo: LPMAdInfo) {
        NSLog("[LevelPlay] rewarded didLoadAd adUnit=\(adUnitId)")
        bridge?.pushRewardedAvailable(true)
    }

    func didFailToLoadAd(withAdUnitId adUnitId: String, error: Error) {
        NSLog("[LevelPlay] rewarded didFailToLoadAd adUnit=\(adUnitId) err=\(error.localizedDescription)")
        bridge?.pushRewardedAvailable(false)
        // 30-second cooldown before retrying, matching Unity's docs
        // recommendation. Without this we'd hammer the no-fill path.
        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { [weak self] in
            guard let self = self else { return }
            // Reload via the bridge so the ad instance is reused.
            if let ad = self.bridge?.rewardedAd(forUnit: self.adUnitId) {
                ad.loadAd()
            }
        }
    }

    func didDisplayAd(with adInfo: LPMAdInfo) {
        NSLog("[LevelPlay] rewarded didDisplayAd adUnit=\(adUnitId)")
        bridge?.markShowStarted()
    }

    func didFailToDisplayAd(with adInfo: LPMAdInfo, error: Error) {
        NSLog("[LevelPlay] rewarded didFailToDisplayAd adUnit=\(adUnitId) err=\(error.localizedDescription)")
        bridge?.emitShowResult(kind: "error", reason: error.localizedDescription)
        bridge?.rewardedAd(forUnit: adUnitId)?.loadAd()
    }

    func didReceiveReward(forAd adInfo: LPMAdInfo, reward: LPMReward) {
        NSLog("[LevelPlay] rewarded didReceiveReward adUnit=\(adUnitId) \(reward.rewardName)x\(reward.rewardAmount)")
        bridge?.markEarned()
    }

    func didClickAd(with adInfo: LPMAdInfo) {
        NSLog("[LevelPlay] rewarded didClickAd adUnit=\(adUnitId)")
    }

    func didCloseAd(with adInfo: LPMAdInfo) {
        NSLog("[LevelPlay] rewarded didCloseAd adUnit=\(adUnitId)")
        bridge?.emitShowResultOnClose()
        bridge?.rewardedAd(forUnit: adUnitId)?.loadAd()
    }

    func didChangeAdInfo(_ adInfo: LPMAdInfo) {
        // Auction result changed before the show — no user-facing action.
    }
}

// Private hooks the delegate uses to touch bridge state without
// publicizing earned/rewardedAds on the main API.
extension LevelPlayBridge {
    fileprivate func markShowStarted() {
        earned = false
        pushRewardedAvailable(false)
    }
    fileprivate func markEarned() { earned = true }
    fileprivate func emitShowResultOnClose() {
        emitShowResult(kind: earned ? "rewarded" : "dismissed", reason: nil)
    }
    fileprivate func rewardedAd(forUnit adUnitId: String) -> LPMRewardedAd? {
        return rewardedAds[adUnitId]
    }
}
