/**
 * Providers — central registry of platform-adapter singletons.
 *
 * Main branch defaults every adapter to a mock implementation, so the
 * game runs end-to-end in the Cocos editor / desktop preview / on a
 * generic Android APK without any real SDK integration.
 *
 * Channel branches (e.g. `channel/google-play`) run their own boot
 * hook BEFORE `MenuController.start()` fires, and register the real
 * implementations:
 *
 *   // channel/google-play boot code (illustrative)
 *   import { Providers } from '../core/channels/Providers';
 *   import { GooglePlayBillingProvider } from './GooglePlayBillingProvider';
 *   Providers.setPurchase(new GooglePlayBillingProvider());
 *   await Providers.purchase.init();
 *
 * The rest of the game only ever touches `Providers.purchase`, never
 * the concrete class — so main-branch code compiles / runs identically
 * on every channel; the swap happens at boot time via a single line.
 *
 * Add new adapter slots (analytics, remote config, push notifications,
 * ad SDK, etc.) here as they're introduced. Keep interfaces in
 * `assets/scripts/core/channels/*.ts` alongside their default mocks.
 */

import { IPurchaseProvider } from './IPurchaseProvider';
import { MockPurchaseProvider } from './MockPurchaseProvider';

export class Providers {
    /** Purchase / IAP. Defaults to `MockPurchaseProvider` — main
     *  branch and non-channel builds use it. */
    static purchase: IPurchaseProvider = new MockPurchaseProvider();

    /** Register a channel-specific purchase provider at boot time.
     *  Called by the channel branch's entry point BEFORE any UI has
     *  a chance to trigger a purchase. */
    static setPurchase(p: IPurchaseProvider): void {
        this.purchase = p;
    }
}
