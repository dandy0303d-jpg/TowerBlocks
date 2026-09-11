/**
 * ReviveApi — HTTP client for the endless-mode gem-revive endpoint.
 *
 *   GET  /revive/cost            — public, returns { gems: number }.
 *   POST /revive/purchase        — bearer + signed, deducts gems and
 *                                  returns new balance.
 *
 * Only endless / blind mode expose a revive path; level mode has its
 * own retry flow. The server tracks per-run "revive used" state so a
 * client can't just re-hit the endpoint after the first success; the
 * client also maintains its own `gameState.endlessReviveUsed` flag so
 * the UI hides the button after the first successful revive.
 */

import { BACKEND_BASE_URL, BACKEND_TIMEOUT_MS } from './BackendConfig';
import { httpGetJson, httpPostJson } from './Http';
import { emitBalance } from './WalletApi';

export interface ReviveCostResult {
    gems: number;
}

export interface RevivePurchaseResult {
    ok:        boolean;
    gemsSpent: number;
    balance:   number;
    /** Populated when ok=false. Common values: 'insufficient-gems',
     *  'already-revived-this-run', 'not-in-endless'. */
    reason?:   string;
}

/** Client-side fallback cost — kept in sync with the server default so
 *  the button label paints something sensible before `fetchReviveCost`
 *  resolves. Server value wins after the fetch.  */
export const DEFAULT_REVIVE_COST_GEMS = 60;

export async function fetchReviveCost(): Promise<ReviveCostResult> {
    const url = `${BACKEND_BASE_URL}/revive/cost`;
    return httpGetJson<ReviveCostResult>(url, BACKEND_TIMEOUT_MS);
}

/** Deduct gems and grant one endless-mode revive. Client MUST call
 *  `gameState.reviveEndless()` after a 200 response — this endpoint
 *  only handles the ledger, not the gameplay reset.
 *
 *  Throws on network / 5xx (Http.ts unwraps). Non-throwing 4xx come
 *  back as `{ ok: false, reason: '...' }`. */
export async function purchaseRevive(): Promise<RevivePurchaseResult> {
    const url = `${BACKEND_BASE_URL}/revive/purchase`;
    const res = await httpPostJson<RevivePurchaseResult>(url, {}, BACKEND_TIMEOUT_MS);
    if (res.ok) emitBalance(res.balance);
    return res;
}
