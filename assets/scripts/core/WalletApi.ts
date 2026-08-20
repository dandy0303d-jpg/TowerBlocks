/**
 * WalletApi — HTTP client for the player wallet endpoints.
 *
 * Endpoints wrapped:
 *   GET  /player/wallet          — fetch current gem balance
 *   POST /player/wallet/topup    — MOCK purchase, credits gems
 *
 * Currency / price handling:
 *   Each SKU carries `priceCents` + `currency` (ISO 4217 code). The
 *   `formatPrice` helper looks up symbol + decimal rules in a small
 *   table so JPY/KRW render without decimals ("¥120", "₩1300"),
 *   USD/EUR/CNY use two ("$0.99", "¥6.99"). When a real IAP
 *   platform (StoreKit / Play Billing) returns a pre-localized
 *   string, drop it into `sku.displayPrice` and it wins over the
 *   built-in formatter — no code change needed per new market.
 *
 * The SKU catalog is duplicated here for the UI grid; server side
 * (`server/src/wallet.ts` SKUS) is the source of truth on
 * gems-per-SKU for the topup call.
 */

import { BACKEND_BASE_URL, BACKEND_TIMEOUT_MS } from './BackendConfig';
import { PlayerProfile } from './PlayerProfile';
import { httpGetJson, httpPostJson } from './Http';

/** ISO 4217 currency code the SKU is priced in. Server + client keep
 *  this in sync; when a platform overrides via `displayPrice`, the
 *  currency + priceCents become informational only. */
export type CurrencyCode = 'USD' | 'CNY' | 'EUR' | 'GBP' | 'JPY' | 'KRW' | 'HKD' | 'TWD';

export interface WalletSku {
    id:         string;
    gems:       number;
    /** Amount in the smallest unit of `currency`. USD/CNY/EUR: cents.
     *  JPY/KRW: whole units (no fractional part). */
    priceCents: number;
    currency:   CurrencyCode;
    /** Platform-provided formatted price string (e.g. StoreKit's
     *  `localizedPrice`). When set, `formatPrice` uses it verbatim
     *  and ignores currency + priceCents. */
    displayPrice?: string;
}

/** Symbol + decimal-place metadata per supported currency. Extend
 *  when we ship in a new market. */
interface CurrencyInfo {
    symbol:   string;
    decimals: number;
}
const CURRENCY_INFO: Record<CurrencyCode, CurrencyInfo> = {
    USD: { symbol: '$',    decimals: 2 },
    CNY: { symbol: '¥',    decimals: 2 },
    EUR: { symbol: '€',    decimals: 2 },
    GBP: { symbol: '£',    decimals: 2 },
    JPY: { symbol: '¥',    decimals: 0 },   // JPY has no cents
    KRW: { symbol: '₩',    decimals: 0 },   // KRW has no cents
    HKD: { symbol: 'HK$',  decimals: 2 },
    TWD: { symbol: 'NT$',  decimals: 2 },
};

/** Default SKU catalog (USD prices). Client + server + App Store
 *  Connect product IDs must all match exactly — server validates the
 *  `sku` on POST /wallet/topup, StoreKit uses the id as the productId.
 *
 *  Renamed 2026-08 from `gems_*` to `Tgems*` to match App Store
 *  Connect product IDs (Konenine naming convention). Gem amounts
 *  and USD prices tuned for the new tier ladder. */
export const WALLET_SKUS: WalletSku[] = [
    { id: 'Tgems100',   gems:   100, priceCents:   99, currency: 'USD' },
    { id: 'Tgems500',   gems:   500, priceCents:  499, currency: 'USD' },
    { id: 'Tgems1100',  gems:  1100, priceCents:  999, currency: 'USD' },
    { id: 'Tgems2400',  gems:  2400, priceCents: 1999, currency: 'USD' },
    { id: 'Tgems6200',  gems:  6200, priceCents: 4999, currency: 'USD' },
    { id: 'Tgems14500', gems: 14500, priceCents: 9999, currency: 'USD' },
];

export interface WalletState {
    uuid:      string;
    gems:      number;
    updatedAt: string;
}

export interface TopupResult {
    uuid:      string;
    sku:       string;
    gemsAdded: number;
    balance:   number;
}

/** Fetch the current player's wallet. Server upserts an empty row
 *  on first call, so this always returns something (starts at 0). */
export async function fetchWallet(): Promise<WalletState> {
    const uuid = encodeURIComponent(PlayerProfile.uuid);
    const url  = `${BACKEND_BASE_URL}/player/wallet?uuid=${uuid}`;
    return httpGetJson<WalletState>(url, BACKEND_TIMEOUT_MS);
}

/** Credit a completed IAP to the player's wallet. Server dedups by
 *  `transactionId` (idempotent — retrying the same call is safe) and,
 *  when `paymentKind !== 'mock'`, forwards `platformReceipt` to
 *  Google Play Developer API / Apple App Store validation before
 *  crediting.
 *
 *  Main-branch code goes through `Providers.purchase.buy(sku)` first
 *  to get a `PurchaseReceipt`, then passes that receipt here. Direct
 *  callers of `topupWallet` should be rare — kept public so debug /
 *  admin tools can grant gems in dev.
 *
 *  Payload shape (JSON body):
 *      { uuid, sku, paymentKind, transactionId?, platformReceipt? }
 *  The receipt fields are optional so old dev flows that just call
 *  `topupWallet('gems_60')` still work (server defaults them). */
export async function topupWallet(
    sku:            string,
    paymentKind:    'mock' | 'stripe' | 'apple' | 'google' = 'mock',
    transactionId?: string,
    platformReceipt?: string,
): Promise<TopupResult> {
    const url = `${BACKEND_BASE_URL}/player/wallet/topup`;
    return httpPostJson<TopupResult>(url, {
        uuid: PlayerProfile.uuid,
        sku,
        paymentKind,
        transactionId,
        platformReceipt,
    }, BACKEND_TIMEOUT_MS);
}

/**
 * Format a SKU's price for display. Precedence:
 *   1. `sku.displayPrice` (set by a real IAP platform's localized
 *      price string) — used verbatim
 *   2. `sku.currency + sku.priceCents` — formatted via CURRENCY_INFO
 *
 * Examples:
 *   USD/2 dec: 499 → "$4.99"
 *   CNY/2 dec: 499 → "¥4.99"
 *   JPY/0 dec: 500 → "¥500"
 *   KRW/0 dec: 6500 → "₩6500"
 */
export function formatPrice(sku: WalletSku): string {
    if (sku.displayPrice) return sku.displayPrice;
    const info = CURRENCY_INFO[sku.currency] ?? CURRENCY_INFO.USD;
    const value = sku.priceCents / Math.pow(10, info.decimals);
    const digits = value.toFixed(info.decimals);
    return `${info.symbol}${digits}`;
}

/**
 * Override a SKU's price at runtime — call this once you've fetched
 * localized prices from Apple StoreKit / Google Play Billing. Pass
 * the platform's `localizedPrice` string directly; the formatter
 * will use it verbatim next time the card renders.
 *
 *   overrideSkuDisplayPrice('gems_300', '¥6.00');
 *   overrideSkuDisplayPrice('gems_300', '₩6500');
 *
 * TopUpController repaints on every `show()`, so calling this
 * before opening the panel is enough.
 */
export function overrideSkuDisplayPrice(id: string, displayPrice: string): void {
    const sku = WALLET_SKUS.find(s => s.id === id);
    if (sku) sku.displayPrice = displayPrice;
}
