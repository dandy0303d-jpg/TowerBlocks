/**
 * MockPurchaseProvider — default `IPurchaseProvider` used on the main
 * branch and by every non-channel build (editor preview, desktop test,
 * CI).
 *
 * Sequence:
 *   1. `buy(sku)` immediately synthesises a "receipt" with a random
 *      transaction id + empty platformReceipt + `paymentKind: 'mock'`.
 *      No native UI, no billing service call — just resolves.
 *   2. Caller sends the receipt to `topupWallet(...)` on the server.
 *      Server accepts `paymentKind: 'mock'` in dev builds; production
 *      server should reject it.
 *   3. `consume(...)` is a no-op — mock purchases don't need consuming.
 *   4. `restore()` returns an empty array — mock has no historical
 *      purchases to restore.
 *
 * NEVER register this on a shipping build. Set the real
 * `GooglePlayBillingProvider` / `StoreKitProvider` in the channel
 * branch's boot code before `MenuController.start()` runs.
 */

import { WalletSku } from '../WalletApi';
import { IPurchaseProvider, PurchaseReceipt } from './IPurchaseProvider';

export class MockPurchaseProvider implements IPurchaseProvider {

    async init(): Promise<void> {
        // Nothing to initialise for mock.
    }

    async fetchLocalizedPrices(skus: WalletSku[]): Promise<WalletSku[]> {
        // Return the input unchanged — no localized-price lookup.
        return skus;
    }

    async buy(skuId: string): Promise<PurchaseReceipt> {
        return {
            sku:              skuId,
            transactionId:    `mock-${Date.now()}-${Math.floor(Math.random() * 1e9)}`,
            platformReceipt:  '',
            paymentKind:      'mock',
        };
    }

    async consume(_platformReceipt: string): Promise<void> {
        // Mock purchases don't need consuming — the server has already
        // credited the gems and there's no platform-side state to clear.
    }

    async restore(): Promise<PurchaseReceipt[]> {
        return [];
    }
}
