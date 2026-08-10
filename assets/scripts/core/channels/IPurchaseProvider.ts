/**
 * IPurchaseProvider — platform-adapter interface for in-app purchases.
 *
 * Main branch ships a `MockPurchaseProvider` that talks straight to the
 * server's `POST /player/wallet/topup` with `paymentKind: 'mock'`, so
 * developers can iterate on the topup UI without any real IAP setup.
 *
 * Channel branches replace this at boot time (via `Providers.setPurchase`)
 * with a real implementation:
 *   - `channel/google-play`  → GooglePlayBillingProvider (uses BillingClient)
 *   - `channel/app-store`    → StoreKitProvider (uses StoreKit 2)
 *
 * The interface intentionally treats consume as a SEPARATE step from
 * `buy()`. The correct sequence for a consumable purchase (gems, coins)
 * is:
 *
 *   1. `provider.buy(sku)` → returns a `PurchaseReceipt` on payment
 *   2. Client sends the receipt to server `POST /player/wallet/topup`
 *   3. Server verifies with Google/Apple (using `platformReceipt`)
 *   4. Server credits gems, returns updated balance
 *   5. ONLY THEN client calls `provider.consume(receipt.platformReceipt)`
 *
 * Consuming BEFORE server confirmation loses the receipt if step 3-4
 * fails: the player paid, no gems credited, and the receipt is now
 * unusable. Splitting `consume` out makes the acknowledge-first flow
 * the natural coding path.
 */

import { WalletSku } from '../WalletApi';

/** Which platform issued the receipt. Server routes verification by
 *  this: `'google'` → Google Play Developer API, `'apple'` → App Store
 *  Server Notification / receipt validation, `'mock'` → trust blindly
 *  (dev only, never accept in production). */
export type PaymentKind = 'apple' | 'google' | 'mock';

/** Result of a completed purchase — passed to server for verification. */
export interface PurchaseReceipt {
    /** Server-side SKU id (matches `WALLET_SKUS[].id`). */
    sku: string;
    /** Platform-native transaction / order id. Server dedups by this
     *  so a retried topup call doesn't credit gems twice.
     *   - Google Play: `purchase.getOrderId()`
     *   - Apple:       `transaction.id` (StoreKit 2)
     *   - Mock:        generated UUID
     */
    transactionId: string;
    /** Base64 receipt token. Sent verbatim to the server, which
     *  forwards it to the store's validation API.
     *   - Google Play: `purchase.getPurchaseToken()`
     *   - Apple:       `AppStore.appStoreReceipt` (raw base64 blob)
     *   - Mock:        empty string
     */
    platformReceipt: string;
    /** Routes server-side validation. */
    paymentKind: PaymentKind;
}

/** Purchase error categories a controller can surface to the player.
 *  Provider `buy()` rejects with `new Error("<kind>: <details>")` and
 *  the caller can `err.message.startsWith(kind)` to switch on it. */
export type PurchaseErrorKind =
    | 'user-cancelled'   // player dismissed the native buy sheet
    | 'network'          // couldn't reach the store
    | 'already-owned'    // non-consumable already purchased (shouldn't
                         // happen for our consumable gems, but handle it)
    | 'unknown';         // catch-all — surface `err.message` to logs

export interface IPurchaseProvider {
    /** One-time init (bind the platform billing service, warm up
     *  pending-purchase queue, etc.). Called once at MenuController
     *  boot. Resolves when the provider is ready to accept `buy()`
     *  calls; rejects if the platform IAP layer is unavailable. */
    init(): Promise<void>;

    /** Ask the platform's IAP layer for localized prices. Returns a
     *  NEW array of SKUs with `displayPrice` populated from the store
     *  (e.g. "¥6.00" instead of the raw USD `$0.99`). Passes SKUs
     *  through unchanged for `MockPurchaseProvider`. */
    fetchLocalizedPrices(skus: WalletSku[]): Promise<WalletSku[]>;

    /** Trigger the native purchase UI for `skuId`. Resolves with a
     *  `PurchaseReceipt` on payment success. Rejects with an Error
     *  whose message starts with a `PurchaseErrorKind` prefix so the
     *  caller can pick the right toast. */
    buy(skuId: string): Promise<PurchaseReceipt>;

    /** Consume a previously-completed purchase so the platform lets
     *  the player buy the same SKU again. MUST be called only AFTER
     *  the server has credited the gems (see comment at top of file).
     *  No-op on Apple (StoreKit consumables are auto-consumed once
     *  finished) and on mock. */
    consume(platformReceipt: string): Promise<void>;

    /** Apple mandates a "Restore Purchases" button in every IAP app.
     *  Play doesn't require it but it's standard UX. Returns every
     *  receipt for NON-consumable purchases the player has bought
     *  historically. Since our current SKUs are all consumable gems,
     *  the typical return is an empty array. Kept in the interface
     *  so future non-consumable purchases (season pass, ad-free) can
     *  drop in without a signature bump. */
    restore(): Promise<PurchaseReceipt[]>;
}
