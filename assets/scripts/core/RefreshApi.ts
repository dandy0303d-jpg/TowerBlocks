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
 *  have rebalanced since the last time we looked). */
export async function fetchRefreshCost(type: RefreshType): Promise<RefreshCostResult> {
    const url = `${BACKEND_BASE_URL}/refresh/cost/${encodeURIComponent(type)}`;
    return httpGetJson<RefreshCostResult>(url, BACKEND_TIMEOUT_MS);
}

/** Client-side cost tiers for successive paid refreshes within a
 *  single modal open. Kept in sync with the server-side tier table
 *  in refresh.ts so UI shows the actual charge amount. Cap at 2 uses
 *  per modal (client-enforced — the button goes dead after that). */
export const REFRESH_COST_TIERS: readonly number[] = [10, 15, 20];
export const MAX_PAID_REFRESHES_PER_MODAL = 2;

/** Deduct gems for a refresh of `type`. Rejects with an Error whose
 *  message includes `HTTP 402` when the player's balance is short —
 *  callers should surface a "not enough gems" toast in that case.
 *
 *  `tier` is the 0-based index into REFRESH_COST_TIERS. Server also
 *  keeps a tier table and charges the correct incremental cost.
 *  Omitting tier (or passing 0) falls back to the server's default
 *  base cost — backward compat with older server builds. */
export async function purchaseRefresh(
    type: RefreshType,
    tier: number = 0,
): Promise<RefreshPurchaseResult> {
    const url = `${BACKEND_BASE_URL}/refresh/purchase/${encodeURIComponent(type)}`;
    return httpPostJson<RefreshPurchaseResult>(url, { tier }, BACKEND_TIMEOUT_MS);
}
