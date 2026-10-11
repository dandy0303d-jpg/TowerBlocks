/**
 * AppStoreBoot — channel/app-store startup hook.
 *
 * Registers the App Store's StoreKitProvider as the active
 * IPurchaseProvider, replacing MockPurchaseProvider that main defaults
 * to. Registration is a MODULE-LOAD SIDE EFFECT — just importing this
 * file anywhere in the bundle wires everything up.
 *
 * Import once from an early-loading location (LoadingController's top
 * import block on channel/app-store):
 *
 *   import '../channels/apple/AppStoreBoot';
 *
 * The single-import pattern keeps main-branch code (LoadingController)
 * merge-friendly — one added line, no logic changes.
 *
 * Platform guard: only registers on iOS. If someone imports this file
 * on Android or in the editor, the mock provider stays in place.
 */

import { sys } from 'cc';
import { Providers } from '../../core/channels/Providers';
import { StoreKitProvider } from './StoreKitProvider';
import { AppleAuth } from './AppleAuth';
import { GameCenter } from './GameCenter';
import { LevelPlayAdProvider } from '../../core/channels/LevelPlayAdProvider';
import {
    LEVELPLAY_REWARDED_AD_UNIT,
    LEVELPLAY_FATE_AD_UNIT,
    LEVELPLAY_MAGIC_AD_UNIT,
    LEVELPLAY_REVIVE_AD_UNIT,
} from '../../core/BuildConfig';
import { PlayerProfile } from '../../core/PlayerProfile';

(function initAppStore(): void {
    if (sys.os !== sys.OS.IOS) {
        // Only iOS has StoreKit. Editor / macOS / Android all keep mock.
        console.log('[AppStoreBoot] non-iOS platform, keeping MockPurchaseProvider');
        return;
    }

    const provider = new StoreKitProvider();
    Providers.setPurchase(provider);
    console.log('[AppStoreBoot] registered StoreKitProvider — init runs at first Providers.purchase.init() call');

    // Kick off Game Center login. The native side already auto-fires
    // authenticateHandler from AppDelegate, so this call is really
    // just to observe the outcome (or to trigger it in the event
    // the auto-fire raced with something and we missed it). Silent
    // when the user is already signed in; shows the login sheet /
    // banner on first launch.
    GameCenter.authenticate()
        .then((r) => {
            if (r.success) {
                console.log(`[AppStoreBoot][GC] signed in as "${r.displayName}" (gamePlayerID=${r.gamePlayerID})`);
            } else {
                console.log(`[AppStoreBoot][GC] not signed in — kind=${r.kind}, error=${r.error}`);
            }
        })
        .catch((e) => {
            console.warn('[AppStoreBoot][GC] authenticate threw:', e);
        });

    // Register LevelPlay (Unity mediation) as the active ad provider,
    // replacing the default MockAdProvider. SDK init is async and auto-
    // preloads the first rewarded ad; gameplay hooks that call
    // Providers.ads.showRewardedAd() will get kind:'error' reason:'not-ready'
    // if init hasn't landed yet, and the native bridge will push a
    // levelplay.rewardedAvailable event once the first ad is cached.
    const adProvider = new LevelPlayAdProvider({
        uuid:           PlayerProfile.uuid,          // S2S reward attribution
        rewardedAdUnit: LEVELPLAY_REWARDED_AD_UNIT,  // iOS ad unit from BuildConfig
    });
    Providers.setAds(adProvider);
    adProvider.init()
        .then(() => {
            console.log('[AppStoreBoot][Ads] LevelPlay init OK — preloading 3 ad units');
            // Pre-warm all three rewarded slots so the FIRST player tap
            // on a 'watch ad' button plays immediately instead of
            // returning 'not-ready — lazily created'. Fire-and-forget;
            // native starts loading each unit in parallel.
            adProvider.preloadRewardedAd(LEVELPLAY_FATE_AD_UNIT);
            adProvider.preloadRewardedAd(LEVELPLAY_MAGIC_AD_UNIT);
            adProvider.preloadRewardedAd(LEVELPLAY_REVIVE_AD_UNIT);
        })
        .catch((e) => console.warn(`[AppStoreBoot][Ads] LevelPlay init failed: ${(e as Error).message}`));

    // ---- DEBUG: expose SIWA to globalThis so we can trigger it from
    // Safari Web Inspector while the Settings-screen UI is still WIP.
    // Remove once the real UI button is wired.
    (globalThis as any).__testSIWA = async () => {
        try {
            const cred = await AppleAuth.signIn();
            console.log('[SIWA][test] success');
            console.log('[SIWA][test] appleSub =', cred.appleSub);
            console.log('[SIWA][test] identityToken (first 60 chars) =',
                cred.identityToken.substring(0, 60) + '...');
            console.log('[SIWA][test] authorizationCode =', cred.authorizationCode);
            return cred;
        } catch (e) {
            console.warn('[SIWA][test] failed:', (e as Error).message);
        }
    };
    (globalThis as any).__testSIWAState = async (sub: string) => {
        try {
            const s = await AppleAuth.getCredentialState(sub);
            console.log('[SIWA][test] state =', s);
            return s;
        } catch (e) {
            console.warn('[SIWA][test] getCredentialState failed:', (e as Error).message);
        }
    };
    console.log('[AppStoreBoot] SIWA debug hooks installed — call __testSIWA() from a UI hook');
    // Auto-trigger removed after Phase 1 verified end-to-end. The real
    // trigger lives in the Settings-screen "Bind Apple ID" button (Phase 3).

    // Note: init() runs from TopUpController.onLoad which fires as soon
    // as the topup panel prefab is spawned. If you want the StoreKit
    // handshake to happen at true boot time (to warm up before the
    // user ever taps buy), call it here — safe to call before the
    // first user interaction:
    //
    //   provider.init().catch((err) => {
    //       console.warn('[AppStoreBoot] init failed:', err);
    //   });
})();
