//
//  AdMobBridge.swift
//  Google Mobile Ads (AdMob) — rewarded + interstitial ads bridge.
//
//  Chosen over AppLovin MAX because AdMob does not require an already
//  App-Store-published app to activate the account, unblocking dev
//  work. AppLovin bridge files are left in the tree for future
//  mediation use.
//
//  Design:
//  - initSdk() called once at boot. GADMobileAds.start() spins up the
//    SDK. Ad unit IDs are cached; slots are preloaded so first show
//    has an ad ready.
//  - Rewarded ads are per-slot: two independent ad units for two
//    gameplay placements (`magic` = picker refresh, `fate` = fate
//    piece reroll). Each slot has its own GADRewardedAd instance
//    and its own auto-retry backoff so a load failure on one doesn't
//    starve the other. Split per-placement so we get per-slot
//    revenue/fill analytics in AdMob dashboard.
//  - Interstitial is a single slot (game-over popup).
//  - Rewarded + Interstitial are class-method loaded (no shared
//    instance like AppLovin). Each successful load stores the ad
//    reference; each show consumes it and requires a new load for
//    next time (Google-Mobile-Ads-SDK 10.x+ semantics).
//  - JS-facing API mirrors AppLovinBridge shape — same event names,
//    same result JSON shape — so the JS AdManager is provider-agnostic.
//    Rewarded show requests carry a `slot` string in the event arg.
//
//  Requires:
//  - Google-Mobile-Ads-SDK via CocoaPods (Podfile: pod 'Google-Mobile-Ads-SDK')
//  - Info.plist: GADApplicationIdentifier (ca-app-pub-XXXX~XXXX)
//  - Info.plist: SKAdNetworkItems (Google's published list, 100+ entries)
//  - Info.plist: NSUserTrackingUsageDescription (already added earlier)
//

import Foundation
import UIKit
import GoogleMobileAds

// Slot identifiers used across the JS↔native boundary. Keep in sync
// with AdManager.ts's `RewardedSlot` type.
private let SLOT_MAGIC = "magic"
private let SLOT_FATE  = "fate"

// Delegate proxy — kept private, so GADFullScreenContentDelegate
// conformance never leaks into tower_blocks_mobile-Swift.h. Neither
// AdMobBridge itself nor any of its extensions references the
// protocol; only this file-private class does. GoogleMobileAds SDK
// holds a weak reference to the proxy for the duration of the ad
// presentation, and the proxy forwards each callback into AdMobBridge.
private class AdMobDelegateProxy: NSObject, GADFullScreenContentDelegate {
    weak var bridge: AdMobBridge?

    init(_ bridge: AdMobBridge) {
        self.bridge = bridge
        super.init()
    }

    func ad(_ ad: GADFullScreenPresentingAd, didFailToPresentFullScreenContentWithError error: Error) {
        bridge?._onAdFailedToPresent(ad: ad, error: error)
    }
    func adWillPresentFullScreenContent(_ ad: GADFullScreenPresentingAd) {
        bridge?._onAdWillPresent(ad: ad)
    }
    func adDidDismissFullScreenContent(_ ad: GADFullScreenPresentingAd) {
        bridge?._onAdDidDismiss(ad: ad)
    }
}

// Note: NO `GADFullScreenContentDelegate` conformance on this class —
// the protocol would otherwise get re-emitted into the ObjC bridging
// header used by every .mm across the project. See AdMobDelegateProxy
// above for the actual delegate implementation.
@objc public class AdMobBridge: NSObject {

    @objc public static let shared = AdMobBridge()

    // Per-slot rewarded state. Dictionary keyed by slot name so adding
    // a third rewarded placement later is a two-line change.
    private var rewardedAds:         [String: GADRewardedAd] = [:]
    private var rewardedUnitIds:     [String: String]        = [:]
    private var rewardedRetryCounts: [String: Int]           = [:]

    private var interstitialAd:        GADInterstitialAd?
    private var interstitialAdUnitId:  String = ""
    private var interstitialRetryCount = 0

    // Lazy-created delegate proxy — GoogleMobileAds SDK holds it weakly,
    // so AdMobBridge (singleton) retains it strongly here.
    private lazy var delegateProxy: AdMobDelegateProxy = AdMobDelegateProxy(self)

    // Slot key of the rewarded ad currently being shown. Set on
    // present, cleared on dismiss. Needed because
    // GADFullScreenContentDelegate callbacks don't tell us which slot
    // (both slots share `self` as delegate).
    private var showingRewardedSlot: String?

    // Set true when user watched to reward completion for the
    // currently-showing rewarded ad; consulted in
    // adDidDismissFullScreenContent to decide rewarded=true/false.
    private var currentRewardedGranted = false

    // JS event callbacks set by the ObjC glue.
    @objc public var onInitResult:        ((String) -> Void)?
    @objc public var onRewardedResult:    ((String) -> Void)?
    @objc public var onInterstitialResult:((String) -> Void)?

    private override init() { super.init() }

    // MARK: - Public API — @objc-exposed

    /// Initialise the SDK. Must be called ONCE at app boot. Idempotent
    /// (Google's start() no-ops on second call).
    /// `rewardedMagicId` / `rewardedFateId` / `interstitialId` = AdMob
    /// unit IDs (ca-app-pub-XXXX/YYYY). Pass empty string for a slot
    /// you don't want to preload.
    /// Note: the App ID (ca-app-pub-XXXX~YYYY) lives in Info.plist as
    /// GADApplicationIdentifier — NOT passed here.
    @objc(initSdkWithRewardedMagicAdUnitId:rewardedFateAdUnitId:interstitialAdUnitId:)
    public func initSdk(rewardedMagicId: String, rewardedFateId: String, interstitialId: String) {
        self.rewardedUnitIds[SLOT_MAGIC] = rewardedMagicId
        self.rewardedUnitIds[SLOT_FATE]  = rewardedFateId
        self.interstitialAdUnitId        = interstitialId

        GADMobileAds.sharedInstance().start { [weak self] status in
            guard let self = self else { return }
            let adapters = status.adapterStatusesByClassName
            NSLog("[Ads] AdMob SDK initialised; adapters=\(adapters.count)")
            self.prepareRewarded(slot: SLOT_MAGIC)
            self.prepareRewarded(slot: SLOT_FATE)
            self.prepareInterstitial()
            self.emit(self.onInitResult, #"{"success":true}"#)
        }
    }

    /// Preload rewarded ad for a given slot. Called internally on
    /// init + after each show. JS can also call explicitly to force
    /// a refresh (e.g. after entering a mode where an ad is likely soon).
    @objc(loadRewardedForSlot:)
    public func loadRewarded(slot: String) { self.prepareRewarded(slot: slot) }

    /// Show the loaded rewarded ad for the given slot. If none ready,
    /// emits {"success":false,"kind":"not-ready","slot":"..."} and
    /// triggers a load for next time. The outcome for a successful
    /// show arrives asynchronously via onRewardedResult when the user
    /// dismisses (with or without the reward).
    @objc(showRewardedForSlot:)
    public func showRewarded(slot: String) {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard let ad = self.rewardedAds[slot], let vc = Self.topViewController() else {
                self.emit(self.onRewardedResult,
                          Self.errorJSON(kind: "not-ready", detail: "no rewarded ad loaded for slot \(slot)", slot: slot))
                self.prepareRewarded(slot: slot)
                return
            }
            // Guard against concurrent shows — the presenter VC can
            // only show one full-screen ad at a time, and our
            // delegate can't disambiguate two overlapping shows.
            if self.showingRewardedSlot != nil {
                self.emit(self.onRewardedResult,
                          Self.errorJSON(kind: "busy", detail: "another rewarded already presenting", slot: slot))
                return
            }
            self.showingRewardedSlot   = slot
            self.currentRewardedGranted = false
            ad.present(fromRootViewController: vc) { [weak self] in
                // User earned the reward — flag it. Result is emitted
                // on adDidDismissFullScreenContent (final dismiss).
                NSLog("[Ads] rewarded[\(slot)]: user earned reward")
                self?.currentRewardedGranted = true
            }
        }
    }

    @objc public func loadInterstitial() { self.prepareInterstitial() }

    @objc public func showInterstitial() {
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            guard let ad = self.interstitialAd, let vc = Self.topViewController() else {
                self.emit(self.onInterstitialResult,
                          Self.errorJSON(kind: "not-ready", detail: "no interstitial ad loaded", slot: nil))
                self.prepareInterstitial()
                return
            }
            ad.present(fromRootViewController: vc)
        }
    }

    // MARK: - Internal load helpers

    private func prepareRewarded(slot: String) {
        guard let unitId = rewardedUnitIds[slot], !unitId.isEmpty else { return }
        let request = GADRequest()
        GADRewardedAd.load(withAdUnitID: unitId, request: request) { [weak self] ad, error in
            guard let self = self else { return }
            if let error = error {
                NSLog("[Ads] rewarded[\(slot)] load failed: \(error.localizedDescription)")
                self.scheduleRewardedRetry(slot: slot)
                return
            }
            NSLog("[Ads] rewarded[\(slot)] loaded")
            self.rewardedAds[slot] = ad
            self.rewardedAds[slot]?.fullScreenContentDelegate = self.delegateProxy
            self.rewardedRetryCounts[slot] = 0
        }
    }

    private func prepareInterstitial() {
        guard !interstitialAdUnitId.isEmpty else { return }
        let request = GADRequest()
        GADInterstitialAd.load(withAdUnitID: interstitialAdUnitId, request: request) { [weak self] ad, error in
            guard let self = self else { return }
            if let error = error {
                NSLog("[Ads] interstitial load failed: \(error.localizedDescription)")
                self.scheduleInterstitialRetry()
                return
            }
            NSLog("[Ads] interstitial loaded")
            self.interstitialAd = ad
            self.interstitialAd?.fullScreenContentDelegate = self.delegateProxy
            self.interstitialRetryCount = 0
        }
    }

    private func scheduleRewardedRetry(slot: String) {
        // Exponential backoff capped at 64s per slot.
        let count = min((rewardedRetryCounts[slot] ?? 0) + 1, 6)
        rewardedRetryCounts[slot] = count
        let delay = pow(2.0, Double(count))
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.prepareRewarded(slot: slot)
        }
    }

    private func scheduleInterstitialRetry() {
        let count = min(interstitialRetryCount + 1, 6)
        interstitialRetryCount = count
        let delay = pow(2.0, Double(count))
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            self?.prepareInterstitial()
        }
    }

    // MARK: - Delegate callback forwards
    //
    // These are internal (non-@objc) methods called by
    // AdMobDelegateProxy. Keeping them here means AdMobBridge itself
    // never conforms to GADFullScreenContentDelegate, so no
    // GoogleMobileAds types leak into the ObjC bridging header.

    fileprivate func _onAdFailedToPresent(ad: GADFullScreenPresentingAd, error: Error) {
        NSLog("[Ads] failed to present: \(error.localizedDescription)")
        if ad is GADRewardedAd {
            let slot = showingRewardedSlot ?? SLOT_MAGIC
            emit(onRewardedResult, Self.errorJSON(kind: "display-failed", detail: error.localizedDescription, slot: slot))
            rewardedAds[slot] = nil
            showingRewardedSlot = nil
            prepareRewarded(slot: slot)
        } else if ad is GADInterstitialAd {
            emit(onInterstitialResult, Self.errorJSON(kind: "display-failed", detail: error.localizedDescription, slot: nil))
            interstitialAd = nil
            prepareInterstitial()
        }
    }

    fileprivate func _onAdWillPresent(ad: GADFullScreenPresentingAd) {
        NSLog("[Ads] will present full-screen ad")
    }

    fileprivate func _onAdDidDismiss(ad: GADFullScreenPresentingAd) {
        NSLog("[Ads] dismissed full-screen ad; rewardedGranted=\(currentRewardedGranted)")
        if ad is GADRewardedAd {
            let slot = showingRewardedSlot ?? SLOT_MAGIC
            let payload: [String: Any] = [
                "success":  true,
                "rewarded": currentRewardedGranted,
                "slot":     slot,
            ]
            emit(onRewardedResult, Self.encodeJSON(payload) ?? #"{"success":false,"error":"encode"}"#)
            currentRewardedGranted = false
            rewardedAds[slot] = nil
            showingRewardedSlot = nil
            prepareRewarded(slot: slot)
        } else if ad is GADInterstitialAd {
            emit(onInterstitialResult, #"{"success":true}"#)
            interstitialAd = nil
            prepareInterstitial()
        }
    }

    // MARK: - Helpers

    /// Walks the UI hierarchy to find the presenting VC. Cocos runs in
    /// a full-screen root VC so this is usually just the root, but
    /// modal presentations (share sheet, purchase flow) can push a
    /// stack on top — walk presentedViewController until we hit the
    /// current front-most one.
    private static func topViewController() -> UIViewController? {
        let scene = UIApplication.shared.connectedScenes.first { $0.activationState == .foregroundActive } as? UIWindowScene
        let window = scene?.windows.first { $0.isKeyWindow } ?? scene?.windows.first
        var vc = window?.rootViewController
        while let presented = vc?.presentedViewController { vc = presented }
        return vc
    }

    private func emit(_ cb: ((String) -> Void)?, _ json: String) {
        guard let cb = cb else { return }
        DispatchQueue.main.async { cb(json) }
    }

    private static func encodeJSON(_ obj: Any) -> String? {
        guard let d = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return nil }
        return String(data: d, encoding: .utf8)
    }

    private static func errorJSON(kind: String, detail: String, slot: String?) -> String {
        var payload: [String: Any] = [
            "success": false,
            "kind":    kind,
            "error":   detail,
        ]
        if let slot = slot { payload["slot"] = slot }
        return encodeJSON(payload) ?? #"{"success":false,"kind":"unknown","error":"encode failed"}"#
    }
}
