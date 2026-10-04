/**
 * BadgeClaimApi — HTTP client for the per-badge gem-reward endpoint.
 *
 *   GET  /player/badge/claims        — bearer + signed, returns
 *                                      `{ claimed: number[] }`. Used on
 *                                      main-page open / sign-in to
 *                                      hydrate the local BadgeClaims
 *                                      cache from the server.
 *   POST /player/badge/claim         — bearer + signed, credits gems
 *                                      for one groupIdx. Idempotent
 *                                      via ON CONFLICT DO NOTHING on
 *                                      (uuid, group_idx) —— dupes come
 *                                      back with alreadyClaimed=true.
 *
 * Server plugin: tetritower-badge-claim-v1/src/badge_claim.ts
 */

import { BACKEND_BASE_URL, BACKEND_TIMEOUT_MS } from './BackendConfig';
import { httpGetJson, httpPostJson } from './Http';
import { emitBalance } from './WalletApi';

export interface BadgeClaimListResult {
    claimed: number[];
}

export interface BadgeClaimResult {
    ok:             boolean;
    groupIdx:       number;
    gemsAwarded:    number;
    balance:        number;
    alreadyClaimed: boolean;
    reason?:        string;   // set when ok=false
}

/** Fetch every groupIdx this player has already claimed. Called from
 *  MenuController.onLoad / on-server-sync so the local BadgeClaims
 *  cache reflects reality across devices. */
export async function fetchBadgeClaims(): Promise<BadgeClaimListResult> {
    const url = `${BACKEND_BASE_URL}/player/badge/claims`;
    return httpGetJson<BadgeClaimListResult>(url, BACKEND_TIMEOUT_MS, true);
}

/** Claim `groupIdx`'s one-shot gem reward. Server credits `BADGE_REWARD_GEMS`
 *  gems atomically alongside inserting the claim row. Safe to retry —
 *  the second call returns `alreadyClaimed=true, gemsAwarded=0` and
 *  does NOT double-credit.
 *
 *  Broadcasts the new balance to subscribers on success so the topup
 *  chip / gem badge repaint without a fresh fetchWallet round-trip.
 *
 *  Under the run-token anti-cheat regime (INBOX_CLIENT.md 2026-10-05)
 *  the server rejects claims for groupIdx > floor((maxClearedIdx+1)/9) - 1
 *  with 403 `{ reason: 'not-earned' }`. httpPostJson throws on non-2xx
 *  so we catch and reshape into the same `{ ok: false, reason }` shape
 *  as the server's logical rejection — callers already branch on
 *  `res.ok`, so no extra try/catch needed at the call site. */
export async function claimBadgeReward(groupIdx: number): Promise<BadgeClaimResult> {
    const url = `${BACKEND_BASE_URL}/player/badge/claim`;
    try {
        const res = await httpPostJson<BadgeClaimResult>(url, { groupIdx }, BACKEND_TIMEOUT_MS);
        if (res.ok) emitBalance(res.balance);
        return res;
    } catch (err: any) {
        const msg = String(err?.message ?? err);
        // Parse the server's error body (format: `HTTP <status>: <json>`)
        // so we can propagate `reason` to the caller — 'not-earned' is
        // the server's run-token anti-cheat rejection, other reasons
        // may surface for future gates (banned, rate-limit, etc.).
        let reason = 'network-error';
        const match = /^HTTP (\d+): (.*)$/.exec(msg);
        if (match) {
            const status = parseInt(match[1], 10);
            try {
                const body = JSON.parse(match[2]);
                if (typeof body?.reason === 'string') reason = body.reason;
                else if (typeof body?.error === 'string') reason = body.error;
                else reason = `http-${status}`;
            } catch {
                reason = `http-${status}`;
            }
        }
        console.warn(`[BadgeClaim] claim ${groupIdx} rejected: ${reason} (${msg.slice(0, 120)})`);
        return {
            ok:             false,
            groupIdx,
            gemsAwarded:    0,
            balance:        0,
            alreadyClaimed: false,
            reason,
        };
    }
}
