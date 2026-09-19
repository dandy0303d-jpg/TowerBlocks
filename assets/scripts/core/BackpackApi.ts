/**
 * BackpackApi — HTTP client for the player's server-side inventory.
 *
 *   GET  /player/backpack   — bearer + signed; returns the player's
 *                              live inventory as a flat item list.
 *
 * The client-side `GameState.inventory` is an in-run counter used to
 * gate item usage during gameplay; the SERVER inventory is the
 * authoritative persistent record (what the backpack UI shows across
 * sessions / devices). Two separate concepts.
 *
 * Response shape:
 *   {
 *     items: [
 *       { id: "hourglass1", count: 3 },
 *       { id: "rewind",     count: 1 },
 *       ...
 *     ]
 *   }
 *
 * Server contract:
 *   • Only items the player actually owns (count > 0) are returned.
 *   • `id` matches the client's MagicItemKey strings (hourglass1 /
 *     hourglass2 / rewind / shapeshifter / excavator1 / gatling3 / …).
 *   • Ordering is the server's choice — the UI paints them in the
 *     order received. Suggested server-side order: by drop-tier /
 *     acquisition time, so the player sees their newest / rarest
 *     items first.
 */

import { BACKEND_BASE_URL, BACKEND_TIMEOUT_MS } from './BackendConfig';
import { httpGetJson, httpPostJson } from './Http';

export interface BackpackItem {
    id:    string;
    count: number;
}

export interface BackpackResult {
    items: BackpackItem[];
}

/** Fetch the player's server-side inventory. Throws on network / 5xx
 *  (Http.ts unwraps); non-throwing 4xx come back as an empty items
 *  array so the caller can render an empty backpack instead of
 *  crashing on the "not found" case (fresh players). */
/** Last successful fetch snapshot + timestamp. Populated by every
 *  `fetchBackpack()` that returns 200. Used by `getCachedBackpack()`
 *  callers that want to skip a network round-trip when a recent
 *  answer is already available (e.g. LoadingController prefetches
 *  during boot, and HudController's first paint after game-start
 *  uses that cached value instead of blocking on the network). */
let _lastSnapshot: { at: number; items: BackpackItem[] } | null = null;

export async function fetchBackpack(): Promise<BackpackResult> {
    const url = `${BACKEND_BASE_URL}/player/backpack`;
    try {
        // sign=true — server requires X-Signature on this route
        // (registered with `preHandler: [requireAuth, requireSignature]`
        // in backpack.ts). Without it we get HTTP 401 "missing signature
        // headers".
        const r = await httpGetJson<BackpackResult>(url, BACKEND_TIMEOUT_MS, true);
        _lastSnapshot = { at: Date.now(), items: r.items || [] };
        return r;
    } catch (err: any) {
        const msg = String(err?.message || err);
        // 404 on fresh accounts is not an error — server just hasn't
        // seen this player before. Treat as empty (and cache the empty
        // result so subsequent callers don't re-hit the 404).
        if (/HTTP 404/.test(msg)) {
            _lastSnapshot = { at: Date.now(), items: [] };
            return { items: [] };
        }
        throw err;
    }
}

/** Non-blocking peek at the last-known backpack contents. Returns the
 *  cached snapshot if it's newer than `maxAgeMs` (default 60 s), else
 *  `null`. Callers should treat a null return as "no cache — fall
 *  back to `fetchBackpack()`" (see HudController's paint path).
 *
 *  The cache is populated by every successful `fetchBackpack()` call,
 *  including the LoadingController's boot-time prefetch, so a game
 *  that starts within a minute of finishing loading paints the
 *  quick-use buttons instantly without waiting on the network. */
export function getCachedBackpack(maxAgeMs: number = 60_000): BackpackResult | null {
    if (!_lastSnapshot) return null;
    if (Date.now() - _lastSnapshot.at > maxAgeMs) return null;
    return { items: _lastSnapshot.items.slice() };
}

/** Response from POST /player/backpack/consume — the new remaining
 *  count of the item after the atomic debit. On not-enough / unknown
 *  item the server returns HTTP 409 which Http.ts surfaces as a
 *  throw with a message starting `HTTP 409`. */
export interface ConsumeResult {
    ok:     true;
    itemId: string;
    count:  number;
}

/** Server-authoritative "use one" — debits ONE copy of `itemId` from
 *  the player's server inventory. Resolves on success with the new
 *  count; rejects on any of:
 *    • network / 5xx  → error message from Http.ts (e.g. "HTTP 500")
 *    • not-enough     → error message "HTTP 409: not-enough"
 *      (caller should refresh backpack + show a soft toast; the
 *      client thought it had one but the server disagreed —
 *      probably a stale UI after grant/revoke)
 *    • missing itemId → "HTTP 400: itemId required"
 *
 *  ALWAYS call this BEFORE painting the gameplay effect (e.g. before
 *  arming a "next piece = mini_block" modifier). The effect must
 *  only fire on server confirmation — otherwise a player can spam-tap
 *  『使用』 while offline and get infinite uses. */
export async function consumeBackpackItem(itemId: string): Promise<ConsumeResult> {
    const url = `${BACKEND_BASE_URL}/player/backpack/consume`;
    return httpPostJson<ConsumeResult>(url, { itemId }, BACKEND_TIMEOUT_MS);
}
