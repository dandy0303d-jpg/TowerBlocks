/**
 * StoreKitProvider — App Store IAP implementation of IPurchaseProvider.
 *
 * Talks to native iOS Swift code (PurchaseBridge.swift) through the
 * Cocos 3.x `native.bridge` event pipe:
 *
 *   TS ─── sendToNative("iap.buy",       skuId)     ───→  Swift
 *   TS ←─  onNative("iap.buyResult",     jsonResult) ←──  Swift
 *
 * Since the bridge is fire-and-forget one-way, we serialize calls per
 * event kind — one buy() at a time, one fetchProducts() at a time.
 * The IAP UI already serialises user clicks so this isn't a real
 * limitation, and it keeps the correlation logic dead simple (no
 * request-id multiplexing).
 *
 * This file ONLY compiles / runs on channel/app-store. Registration
 * lives in AppStoreBoot.ts, invoked from LoadingController before any
 * TopUpController.buy() can fire.
 */

import { native } from 'cc';
import {
    IPurchaseProvider,
    PurchaseReceipt,
    PurchaseErrorKind,
} from '../../core/channels/IPurchaseProvider';
import { WalletSku, topupWallet } from '../../core/WalletApi';

// ---------------------------------------------------------------------------
// Native event names — mirror the schema doc at the top of
// PurchaseBridgeGlue.mm. Keep in lockstep with that file.
// ---------------------------------------------------------------------------

const EV = {
    fetchProducts: 'iap.fetchProducts',
    products:      'iap.products',
    buy:           'iap.buy',
    buyResult:     'iap.buyResult',
    consume:       'iap.consume',
    consumeResult: 'iap.consumeResult',
    restore:       'iap.restore',
    restoreResult: 'iap.restoreResult',
    pendingTx:     'iap.pendingTx',
} as const;

// ---------------------------------------------------------------------------
// Response shapes from Swift — narrow-typed to the fields we consume.
// ---------------------------------------------------------------------------

interface NativeProduct {
    id: string;
    displayPrice: string;
    priceCents: number;
    currency: string;
}

interface NativeBuySuccess {
    success: true;
    sku: string;
    transactionId: string;
    platformReceipt: string;   // the JWS blob
    paymentKind: 'apple';
}

interface NativeBuyError {
    success: false;
    kind: PurchaseErrorKind;
    error: string;
}

type NativeBuyResult = NativeBuySuccess | NativeBuyError;

interface NativeConsumeResult {
    success: boolean;
    error?: string;
}

// ---------------------------------------------------------------------------
// One-shot pending-callback slot per event kind. See file header for why
// we don't do request-id correlation.
// ---------------------------------------------------------------------------

type Pending<T> = { resolve: (v: T) => void; reject: (e: Error) => void; timer: number };

function slot<T>(): { pending: Pending<T> | null; call: (r: string) => void } {
    const s = { pending: null as Pending<T> | null };
    return {
        pending: null as Pending<T> | null,
        get: () => s.pending,
        call(r: string) {
            const p = s.pending;
            if (!p) return;   // no one waiting — dropped
            s.pending = null;
            clearTimeout(p.timer);
            try {
                p.resolve(JSON.parse(r) as T);
            } catch (e) {
                p.reject(new Error(`native returned invalid JSON: ${(e as Error).message}`));
            }
        },
    } as any;
}

// Poor-man's typed slot — TS doesn't do closure-over-generics elegantly.
class Slot<T> {
    private pending: Pending<T> | null = null;
    private readonly kind: string;
    private readonly timeoutMs: number;

    constructor(kind: string, timeoutMs = 60_000) {
        this.kind = kind;
        this.timeoutMs = timeoutMs;
    }

    /** Reserve the slot and start a timer. */
    wait(): Promise<T> {
        if (this.pending) {
            return Promise.reject(new Error(`${this.kind}: another call in progress`));
        }
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending) {
                    this.pending = null;
                    reject(new Error(`${this.kind}: timeout after ${this.timeoutMs}ms`));
                }
            }, this.timeoutMs) as unknown as number;
            this.pending = { resolve, reject, timer };
        });
    }

    /** Called from the onNative handler when a matching response arrives. */
    deliver(rawJson: string): void {
        const p = this.pending;
        if (!p) return;
        this.pending = null;
        clearTimeout(p.timer);
        try {
            p.resolve(JSON.parse(rawJson) as T);
        } catch (e) {
            p.reject(new Error(`${this.kind}: invalid JSON from native: ${(e as Error).message}`));
        }
    }
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export class StoreKitProvider implements IPurchaseProvider {
    private readonly productsSlot   = new Slot<NativeProduct[]>('iap.fetchProducts');
    private readonly buySlot        = new Slot<NativeBuyResult>('iap.buy', 5 * 60_000);  // long — user taps sheet
    private readonly consumeSlot    = new Slot<NativeConsumeResult>('iap.consume', 10_000);
    private readonly restoreSlot    = new Slot<NativeBuySuccess[]>('iap.restore', 30_000);

    private initialised = false;

    async init(): Promise<void> {
        if (this.initialised) return;

        // Wire the single global onNative dispatcher.
        // Cocos supports ONE onNative per JS runtime, so we route all
        // iap.* events through this fan-out.
        const prev = native.bridge.onNative;
        native.bridge.onNative = (event: string, arg: string | null) => {
            const payload = arg ?? '';
            switch (event) {
                case EV.products:       this.productsSlot.deliver(payload); return;
                case EV.buyResult:      this.buySlot.deliver(payload);      return;
                case EV.consumeResult:  this.consumeSlot.deliver(payload);  return;
                case EV.restoreResult:  this.restoreSlot.deliver(payload);  return;
                case EV.pendingTx:      this.handlePendingTx(payload);      return;
                default:
                    // Not ours — hand back to the previous handler if any.
                    prev?.(event, arg);
            }
        };

        this.initialised = true;
    }

    async fetchLocalizedPrices(skus: WalletSku[]): Promise<WalletSku[]> {
        const skuIds = skus.map((s) => s.id);
        const wait = this.productsSlot.wait();
        native.bridge.sendToNative(EV.fetchProducts, JSON.stringify(skuIds));
        let products: NativeProduct[];
        try {
            products = await wait;
        } catch (e) {
            // Network / storekit failure — return the input untouched
            // so the UI falls back to USD prices.
            console.warn('[StoreKit] fetchProducts failed:', (e as Error).message);
            return skus;
        }
        // Merge — for each input sku, find the matching native product
        // and copy over the localized price info.
        const byId = new Map(products.map((p) => [p.id, p]));
        return skus.map((s) => {
            const native = byId.get(s.id);
            if (!native) return s;   // not registered in ASC yet? Keep default.
            return {
                ...s,
                displayPrice: native.displayPrice,
                priceCents: native.priceCents,
                currency: native.currency as WalletSku['currency'],
            };
        });
    }

    async buy(skuId: string): Promise<PurchaseReceipt> {
        const wait = this.buySlot.wait();
        native.bridge.sendToNative(EV.buy, skuId);
        const result = await wait;
        if (!result.success) {
            // Wrap error kind into the message prefix per IPurchaseProvider
            // contract, so TopUpController can .startsWith(kind).
            throw new Error(`${result.kind}: ${result.error}`);
        }
        return {
            sku: result.sku,
            transactionId: result.transactionId,
            platformReceipt: result.platformReceipt,
            paymentKind: 'apple',
        };
    }

    async consume(platformReceipt: string): Promise<void> {
        // Note: for our bridge, "platformReceipt" as passed by
        // TopUpController is actually the JWS. But Swift needs the
        // transactionId to look up the cached Transaction. Since
        // TopUpController currently passes receipt.platformReceipt to
        // consume(), and the receipt object also has transactionId,
        // this is a slight interface mismatch.
        //
        // Workaround: parse the JWS payload (base64url middle segment)
        // to extract the transactionId, so consume() works even if
        // the caller doesn't have the receipt object handy.
        const txId = this.extractTransactionIdFromJws(platformReceipt);
        if (!txId) {
            console.warn('[StoreKit] consume: could not extract transactionId from JWS');
            return;   // Best-effort — don't throw; the tx will remain
                      // unfinished and iOS will re-deliver on next launch.
        }
        const wait = this.consumeSlot.wait();
        native.bridge.sendToNative(EV.consume, txId);
        const result = await wait;
        if (!result.success) {
            console.warn('[StoreKit] consume failed:', result.error);
            // Don't throw — the topup already succeeded server-side.
            // Worst case iOS re-delivers next launch and we re-consume.
        }
    }

    async restore(): Promise<PurchaseReceipt[]> {
        const wait = this.restoreSlot.wait();
        native.bridge.sendToNative(EV.restore, '');
        const results = await wait;
        return results.map((r) => ({
            sku: r.sku,
            transactionId: r.transactionId,
            platformReceipt: r.platformReceipt,
            paymentKind: 'apple' as const,
        }));
    }

    // ---- Unsolicited pending transaction (e.g. Ask to Buy approved) --

    private async handlePendingTx(json: string): Promise<void> {
        // Server catch-up: if a transaction arrives outside a buy()
        // flow, credit the player and consume. Fire-and-forget — the
        // player might not have the topup panel open.
        try {
            const tx = JSON.parse(json) as NativeBuySuccess;
            console.log('[StoreKit] pending transaction received:', tx.sku, tx.transactionId);
            await topupWallet(tx.sku, 'apple', tx.transactionId, tx.platformReceipt);
            // Consume via the transactionId directly (bypass extractFromJws).
            const wait = this.consumeSlot.wait();
            native.bridge.sendToNative(EV.consume, tx.transactionId);
            await wait;
            console.log('[StoreKit] pending transaction credited + consumed');
        } catch (e) {
            console.warn('[StoreKit] pending transaction handling failed:', (e as Error).message);
            // Leave unconsumed — iOS re-delivers next launch.
        }
    }

    // ---- Utility: dig transactionId out of a raw JWS ------------------

    private extractTransactionIdFromJws(jws: string): string | null {
        const parts = jws.split('.');
        if (parts.length !== 3) return null;
        try {
            const payloadB64Url = parts[1];
            // base64url → base64 → decode
            const b64 = payloadB64Url.replace(/-/g, '+').replace(/_/g, '/');
            const pad = b64.length % 4;
            const b64Padded = pad ? b64 + '='.repeat(4 - pad) : b64;
            const decoded = atob(b64Padded);
            const obj = JSON.parse(decoded);
            const tx = obj.transactionId;
            return tx != null ? String(tx) : null;
        } catch {
            return null;
        }
    }
}
