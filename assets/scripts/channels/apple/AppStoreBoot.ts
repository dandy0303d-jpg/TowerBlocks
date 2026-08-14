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

(function initAppStore(): void {
    if (sys.os !== sys.OS.IOS) {
        // Only iOS has StoreKit. Editor / macOS / Android all keep mock.
        console.log('[AppStoreBoot] non-iOS platform, keeping MockPurchaseProvider');
        return;
    }

    const provider = new StoreKitProvider();
    Providers.setPurchase(provider);
    console.log('[AppStoreBoot] registered StoreKitProvider — init runs at first Providers.purchase.init() call');

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
