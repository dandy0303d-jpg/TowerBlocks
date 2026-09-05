/**
 * RefreshApi — HTTP client for the paid-refresh endpoints.
 *
 *   GET  /refresh/cost/:type       — read current gem cost. Public.
 *   POST /refresh/purchase/:type   — deduct gems and return new
 *                                    balance. Requires bearer + signed.
 *
 * `type` is 'fate' (fate-piece reroll popup) or 'magic' (magic-item
 * picker reroll). The client only tells the server the TYPE — cost
 * is server-configured so we can rebalance without a client rebuild.
 */

import { BACKEND_BASE_URL, BACKEND_TIMEOUT_MS } from './BackendConfig';
import { httpGetJson, httpPostJson } from './Http';
import { emitBalance } from './WalletApi';

export type RefreshType = 'fate' | 'magic';

export interface RefreshCostResult {
    type: RefreshType;
    gems: number;
}

export interface RefreshPurchaseResult {
    ok:        boolean;
    type:      RefreshType;
    gemsSpent: number;
    balance:   number;
}

/** Server-configured cost of one refresh for `type`. Callers should
 *  invoke this every time the corresponding modal opens (server may
 *  have rebalanced since the last time we looked). NOTE: fate uses
 *  client-side REFRESH_COST_TIERS + per-modal tier counter for
 *  escalating pricing (10 → 15 → 20 gems), so `fetchRefreshCost('fate')`
 *  isn't in the hot path anymore. Kept for the magic picker which
 *  still fetches its price on modal open. */
export async function fetchRefreshCost(type: RefreshType): Promise<RefreshCostResult> {
    const url = `${BACKEND_BASE_URL}/refresh/cost/${encodeURIComponent(type)}`;
    return httpGetJson<RefreshCostResult>(url, BACKEND_TIMEOUT_MS);
}

/** Per-modal escalating cost table for paid refreshes. Tier index is
 *  0-based and mirrors the count of prior purchases in the same
 *  modal open: tier 0 = first purchase of this open, tier 1 = second
 *  purchase, etc. Client sends `tier` to the server so the server can
 *  charge the matching amount; both sides must agree on the table.
 *
 *  Currently applied to FATE ONLY (本命方块 逆天改命 paid refresh).
 *  Magic picker still uses the single server-fetched cost. */
export const REFRESH_COST_TIERS: readonly number[] = [10, 15, 20];

/** Hard cap on paid refreshes per modal open. Once used equals this,
 *  the paid-refresh button is disabled + shows "已达上限". Set to
 *  REFRESH_COST_TIERS.length so every tier gets used at most once. */
export const MAX_PAID_REFRESHES_PER_MODAL = REFRESH_COST_TIERS.length;

/** Deduct gems for a refresh of `type`. Rejects with an Error whose
 *  message includes `HTTP 402` when the player's balance is short —
 *  callers should surface a "not enough gems" toast in that case.
 *
 *  `tier` (0-based) tells the server which price tier from
 *  REFRESH_COST_TIERS to charge. Client is responsible for tracking
 *  the per-modal count; server also enforces the tier ceiling as a
 *  safety net. Omit for backward compat with servers that don't yet
 *  understand the field (they'll fall back to their base cost). */
export async function purchaseRefresh(
    type: RefreshType,
    tier: number = 0,
): Promise<RefreshPurchaseResult> {
    const url = `${BACKEND_BASE_URL}/refresh/purchase/${encodeURIComponent(type)}`;
    const res = await httpPostJson<RefreshPurchaseResult>(url, { tier }, BACKEND_TIMEOUT_MS);
    // Server just deducted gems — broadcast so main-page balance label
    // + any other subscribed UI repaints instead of showing the stale
    // pre-purchase amount until the next fetchWallet.
    emitBalance(res.balance);
    return res;
}
