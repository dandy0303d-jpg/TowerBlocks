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

(function initAppStore(): void {
    if (sys.os !== sys.OS.IOS) {
        // Only iOS has StoreKit. Editor / macOS / Android all keep mock.
        console.log('[AppStoreBoot] non-iOS platform, keeping MockPurchaseProvider');
        return;
    }

    const provider = new StoreKitProvider();
    Providers.setPurchase(provider);
    console.log('[AppStoreBoot] registered StoreKitProvider — init runs at first Providers.purchase.init() call');

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
