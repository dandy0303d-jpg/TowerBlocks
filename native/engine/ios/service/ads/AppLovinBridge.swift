//
//  AppLovinBridge.swift
//  AppLovin MAX (SDK) ads bridge — mediation SDK for rewarded +
//  interstitial ads.
//
//  Design:
//  - initSdk() called once at boot from AppDelegate → GLUE. Kicks off
//    the SDK initialisation callback (~1-2s on cold start).
//  - Rewarded + Interstitial are two separate ad instances, both
//    kept warm via loadAd() on:
//      (1) init callback
//      (2) after each successful/failed show
//    so the next show() has an ad ready.
//  - JS-facing API: loadRewarded / showRewarded / loadInterstitial /
//    showInterstitial. Each emits a *Result event to JS with
//    { success, error?, rewarded? }.
//  - Rewarded ad reward payload is captured via
//    MARewardedAdDelegate.didRewardUserFor; if the delegate fires
//    the reward before didHide, we honour it; otherwise treat as
//    "user dismissed without watching".
//
//  Requires:
//  - AppLovinSDK via CocoaPods (Podfile: pod 'AppLovinSDK')
//  - Info.plist: AppLovinSdkKey (32-char string from AppLovin dashboard)
//  - Ad unit IDs configured in AppLovin MAX dashboard, passed from
//    JS side (see AdManager.ts).
//

import Foundation
import AppLovinSDK

@objc public class AppLovinBridge: NSObject,
                                   MAAdDelegate,
                                   MARewardedAdDelegate,
                                   MAAdRevenueDelegate {

    @objc public static let shared = AppLovinBridge()

    private var sdk: ALSdk?
    private var rewardedAd:     MARewardedAd?
    private var interstitialAd: MAInterstitialAd?

    private var rewardedAdUnitId:     String = ""
    private var interstitialAdUnitId: String = ""

    // Tracks whether the current rewarded show has fired
    // didRewardUser — if so, we resolve success/rewarded=true on
    // didHide; otherwise dismissed-without-watching = rewarded=false.
    private var currentRewardedGranted = false

    // JS event callbacks set by the ObjC glue.
    @objc public var onInitResult:        ((String) -> Void)?
    @objc public var onRewardedResult:    ((String) -> Void)?
    @objc public var onInterstitialResult:((String) -> Void)?

    private override init() { super.init() }

    // MARK: - Public API — @objc-exposed

    /// Initialise the SDK. Must be called ONCE at app boot. Safe to
    /// call again — subsequent calls no-op via ALSdk's own guard.
    /// `sdkKey` = 32-char string from AppLovin dashboard.
    /// `rewardedId` / `interstitialId` = MAX ad unit IDs.
    @objc(initSdkWithKey:rewardedAdUnitId:interstitialAdUnitId:)
    public func initSdk(sdkKey: String, rewardedId: String, interstitialId: String) {
        self.rewardedAdUnitId     = rewardedId
        self.interstitialAdUnitId = interstitialId

        let config = ALSdkInitializationConfiguration(sdkKey: sdkKey) { builder in
            // COPPA + GDPR knobs would go here for kids-app compliance.
            // Not applicable for us (12+ rating, no PII collection
            // through ads beyond IDFA).
        }
        ALSdk.shared().initialize(with: config) { [weak self] sdkConfig in
            guard let self = self else { return }
            NSLog("[Ads] AppLovin SDK initialised; countryCode=\(sdkConfig.countryCode)")
            self.sdk = ALSdk.shared()
            // Warm up both ad slots so the first showX() has an ad ready.
            self.prepareRewarded()
            self.prepareInterstitial()
            self.emit(self.onInitResult, #"{"success":true}"#)
        }
    }

    /// Preload rewarded ad. Called internally on init + after each
    /// show. JS can also call explicitly to force a refresh.
    @objc public func loadRewarded() { self.prepareRewarded() }

    /// Show the loaded rewarded ad. If none ready, emits
    /// {"success":false,"error":"not-ready"}. Otherwise the outcome
    /// arrives asynchronously via onRewardedResult when the user
    /// dismisses (with or without the reward).
    @objc public func showRewarded() {
        DispatchQueue.main.async {
            guard let ad = self.rewardedAd, ad.isReady else {
                self.emit(self.onRewardedResult, Self.errorJSON(kind: "not-ready", detail: "no rewarded ad loaded"))
                self.prepareRewarded()   // try again for next time
                return
            }
            self.currentRewardedGranted = false
            ad.show()
        }
    }

    @objc public func loadInterstitial() { self.prepareInterstitial() }

    @objc public func showInterstitial() {
        DispatchQueue.main.async {
            guard let ad = self.interstitialAd, ad.isReady else {
                self.emit(self.onInterstitialResult, Self.errorJSON(kind: "not-ready", detail: "no interstitial ad loaded"))
                self.prepareInterstitial()
                return
            }
            ad.show()
        }
    }

    // MARK: - Internal load helpers

    private func prepareRewarded() {
        guard !rewardedAdUnitId.isEmpty else { return }
        if rewardedAd == nil {
            rewardedAd = MARewardedAd.shared(withAdUnitIdentifier: rewardedAdUnitId)
            rewardedAd?.delegate = self
            rewardedAd?.revenueDelegate = self
        }
        rewardedAd?.load()
    }

    private func prepareInterstitial() {
        guard !interstitialAdUnitId.isEmpty else { return }
        if interstitialAd == nil {
            interstitialAd = MAInterstitialAd(adUnitIdentifier: interstitialAdUnitId)
            interstitialAd?.delegate = self
            interstitialAd?.revenueDelegate = self
        }
        interstitialAd?.load()
    }

    // MARK: - MAAdDelegate

    public func didLoad(_ ad: MAAd) {
        NSLog("[Ads] loaded \(ad.format.label) — network=\(ad.networkName)")
    }

    public func didFailToLoadAd(forAdUnitIdentifier adUnitIdentifier: String, withError error: MAError) {
        NSLog("[Ads] load failed for \(adUnitIdentifier): code=\(error.code) msg=\(error.message)")
        // Auto-retry with backoff (1s → 8s cap) so a temporary net
        // hiccup doesn't leave both slots permanently empty.
        let delay = min(8.0, pow(2.0, Double.random(in: 0...3)))
        DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
            if adUnitIdentifier == self?.rewardedAdUnitId     { self?.prepareRewarded() }
            if adUnitIdentifier == self?.interstitialAdUnitId { self?.prepareInterstitial() }
        }
    }

    public func didDisplay(_ ad: MAAd) {
        NSLog("[Ads] displayed \(ad.format.label)")
    }

    public func didHide(_ ad: MAAd) {
        NSLog("[Ads] hidden \(ad.format.label) rewardedGranted=\(currentRewardedGranted)")
        if ad.format == MAAdFormat.rewarded {
            let payload: [String: Any] = [
                "success":  true,
                "rewarded": currentRewardedGranted,
            ]
            emit(onRewardedResult, Self.encodeJSON(payload) ?? #"{"success":false,"error":"encode"}"#)
            currentRewardedGranted = false
            prepareRewarded()   // reload for next time
        } else if ad.format == MAAdFormat.interstitial {
            emit(onInterstitialResult, #"{"success":true}"#)
            prepareInterstitial()
        }
    }

    public func didClick(_ ad: MAAd) {
        NSLog("[Ads] clicked \(ad.format.label)")
    }

    public func didFail(toDisplay ad: MAAd, withError error: MAError) {
        NSLog("[Ads] failed to display \(ad.format.label): \(error.message)")
        if ad.format == MAAdFormat.rewarded {
            emit(onRewardedResult, Self.errorJSON(kind: "display-failed", detail: error.message))
            prepareRewarded()
        } else if ad.format == MAAdFormat.interstitial {
            emit(onInterstitialResult, Self.errorJSON(kind: "display-failed", detail: error.message))
            prepareInterstitial()
        }
    }

    // MARK: - MARewardedAdDelegate

    public func didRewardUser(for ad: MAAd, with reward: MAReward) {
        NSLog("[Ads] user rewarded: \(reward.amount) \(reward.label)")
        currentRewardedGranted = true
    }

    // MARK: - MAAdRevenueDelegate

    public func didPayRevenue(for ad: MAAd) {
        NSLog("[Ads] revenue \(ad.revenue) network=\(ad.networkName) format=\(ad.format.label)")
        // Later — forward to server for revenue attribution. Not
        // wired yet.
    }

    // MARK: - Helpers

    private func emit(_ cb: ((String) -> Void)?, _ json: String) {
        guard let cb = cb else { return }
        DispatchQueue.main.async { cb(json) }
    }

    private static func encodeJSON(_ obj: Any) -> String? {
        guard let d = try? JSONSerialization.data(withJSONObject: obj, options: []) else { return nil }
        return String(data: d, encoding: .utf8)
    }

    private static func errorJSON(kind: String, detail: String) -> String {
        return encodeJSON([
            "success": false,
            "kind":    kind,
            "error":   detail,
        ]) ?? #"{"success":false,"kind":"unknown","error":"encode failed"}"#
    }
}
