/**
 * DailyFreeApi — server-authoritative daily-free counter for
 * ad-gated placements (magic item picker refresh, fate piece reroll).
 *
 * Design contract:
 *   POST /player/:uuid/daily-free/consume  { kind: 'magic' | 'fate' }
 *   → 200 { ok: true,  remaining: number }   — consumed one free use
 *   → 429 { ok: false, remaining: 0, error: 'daily-free:exhausted', resetAt: '<iso>' }
 *
 * On the 200 path, server has already atomically incremented the
 * counter — client SHOULD proceed with the free action. On 429, the
 * player is out of free uses for today; client falls through to the
 * rewarded-ad path.
 *
 * Rationale for a dedicated endpoint (vs. reading state and
 * client-side gating): a laggy client can otherwise double-consume by
 * spamming the button before the state fetch lands. Atomic
 * check-and-increment on the server is the only correct model.
 */

import { httpPostJson } from './Http';
import { BACKEND_BASE_URL, BACKEND_TIMEOUT_MS } from './BackendConfig';
import { PlayerProfile } from './PlayerProfile';

export type DailyFreeKind = 'magic' | 'fate';

export interface ConsumeResult {
    /** true = server granted a free use (client should proceed); false =
     *  exhausted for today (client should fall through to ad). */
    ok:        boolean;
    /** Remaining free uses after this call (0 if exhausted). */
    remaining: number;
    /** Server-side reset boundary (ISO), for UI countdown/messaging.
     *  Only set on the exhausted-error path; on success it can be
     *  omitted (client refetches profile on the next boot anyway). */
    resetAt?:  string;
}

/**
 * Attempt to consume one free daily use for `kind`. Returns
 * `{ok: false}` (never rejects) on the exhausted path so callers
 * gate cleanly with a single `if (r.ok)` check. Any other error
 * (network, 5xx) does reject — caller decides whether to fall
 * through to the ad path or surface a toast.
 */
export async function consumeDailyFree(kind: DailyFreeKind): Promise<ConsumeResult> {
    const uuid = encodeURIComponent(PlayerProfile.uuid);
    const url  = `${BACKEND_BASE_URL}/player/${uuid}/daily-free/consume`;
    try {
        const r = await httpPostJson<ConsumeResult>(url, { kind }, BACKEND_TIMEOUT_MS);
        return r;
    } catch (err: any) {
        const msg: string = err?.message ?? String(err);
        // 429 = exhausted — treat as a well-formed "no free left" result
        // rather than a caller-visible error. Body shape mirrors the
        // 200 path so downstream code doesn't branch.
        if (msg.startsWith('HTTP 429')) {
            const bodyStart = msg.indexOf('{');
            if (bodyStart > 0) {
                try {
                    const body = JSON.parse(msg.slice(bodyStart));
                    return {
                        ok:        false,
                        remaining: typeof body.remaining === 'number' ? body.remaining : 0,
                        resetAt:   typeof body.resetAt === 'string' ? body.resetAt : undefined,
                    };
                } catch { /* fall through to generic 429 */ }
            }
            return { ok: false, remaining: 0 };
        }
        // Any other status (or network) — rethrow so caller can pick
        // fall-through-to-ad vs. show-toast. HudController's ad path
        // already handles "ad not ready" so ‘let the ad flow decide’
        // is a safe default.
        throw err;
    }
}
