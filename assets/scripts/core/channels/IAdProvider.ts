/**
 * IAdProvider — platform-agnostic rewarded-ad interface.
 *
 * Game code calls `Providers.ads.showRewardedAd()` and handles the
 * three outcomes. Each channel plugs in its own implementation:
 *
 *   main branch          → MockAdProvider (always resolves 'rewarded')
 *   channel/onestore     → TapjoyProvider (Korean-market friendly)
 *   channel/google-play  → future AdMobProvider
 *
 * Preload flow: call `loadRewardedAd()` early so the ad is ready by
 * the time the player hits a "watch ad" button. Providers auto-preload
 * the next ad after every `showRewardedAd()` so the button stays ready.
 */

export type AdShowResult =
    | { kind: 'rewarded' }                       // watched to completion — grant reward
    | { kind: 'dismissed' }                      // skipped / closed early — no reward
    | { kind: 'error'; reason: string };         // network / no-fill / SDK error

export interface IAdProvider {
    /** One-time SDK init. Idempotent — also kicks off first preload. */
    init(): Promise<void>;

    /** Preload the next rewarded ad. Non-throwing — resolves on load
     *  success OR failure; check `isRewardedAdReady()` for state. */
    loadRewardedAd(): Promise<void>;

    /** Cheap sync check — safe from UI update loops. */
    isRewardedAdReady(): boolean;

    /** Show the loaded ad. Resolves once dismissed / errored.
     *  Auto-triggers the next preload before returning. */
    showRewardedAd(): Promise<AdShowResult>;
}
