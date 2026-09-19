/**
 * LeaderboardApi — thin HTTP client for the TetriTower backend.
 *
 * Wraps `fetch()` so callers get typed results + timeout + a single
 * place to change the base URL. All three endpoints return simple
 * plain-object shapes (no classes, no magic) — easy to plug into
 * the LeaderboardController's existing `LeaderboardEntry` type.
 *
 * Errors surface as thrown Errors — callers catch and show whatever
 * "offline / retry" UI they want.
 */

import { BACKEND_BASE_URL, BACKEND_TIMEOUT_MS } from './BackendConfig';
import { PlayerProfile } from './PlayerProfile';
import { httpGetJson, httpPostJson, httpPutJson } from './Http';

export type LeaderboardApiMode = 'level' | 'endless' | 'blind';

export interface LeaderboardApiEntry {
    rank:      number;
    uuid:      string;
    name:      string;
    score:     number;
    /** Server-stored avatar index for this player. 0 if the player
     *  hasn't picked one yet (default). Client falls back to a
     *  rank-based cycle when this is missing. */
    avatarIdx: number;
}

export interface SubmitResult {
    updated:      boolean;
    personalBest: number | null;
    rank:         number | null;
}

export interface MyRankResult {
    rank:  number | null;
    score: number | null;
}

export interface RegisterResult {
    uuid:        string;
    nickname:    string;
    /** Server-assigned initial avatar index (0..pool-1). Random on
     *  register so different guests start with different-looking
     *  avatars; player can change it later via the picker. */
    avatarIdx:   number;
    token:       string;
    expEpochSec: number;
}

export interface RefreshResult {
    token:       string;
    expEpochSec: number;
}

/** Full profile shape returned by GET /player/:uuid/profile.
 *  bestScores values are 0 when the player has no submitted run
 *  for that mode yet. */
export interface DailyFreeSlotState {
    /** How many free uses the player consumed today for this slot. */
    used:      number;
    /** Max free uses per day (config; identical across players today
     *  but exposed per-slot so future A/B testing is trivial). */
    max:       number;
    /** Convenience — max - used, clamped ≥ 0. */
    remaining: number;
}

export interface DailyFreeState {
    magic:   DailyFreeSlotState;
    fate:    DailyFreeSlotState;
    /** ISO timestamp when the counters reset (server midnight UTC).
     *  Client can use this to show "resets in N hours" if desired. */
    resetAt: string;
}

export interface PlayerProfileResult {
    uuid:       string;
    name:       string;
    avatarIdx:  number;
    bestScores: { level: number; endless: number; blind: number };
    /** ISO timestamp when the player can next change their nickname,
     *  or null if they can change immediately (never changed / cooldown
     *  already elapsed). Server enforces the 7-day rule authoritatively. */
    nicknameNextChangeAt?: string | null;
    /** Server-authoritative daily free reroll counters for the two
     *  ad-gated placements. Missing on older server builds — clients
     *  fall back to client-side counters in that case. */
    dailyFree?: DailyFreeState;
}

/** Response from the PUT profile endpoint — same shape as the
 *  register call plus avatarIdx (never the bestScores block). Plus
 *  the updated `nicknameNextChangeAt` when a name change succeeded. */
export interface PlayerProfileUpdateResult {
    uuid:      string;
    name:      string;
    avatarIdx: number;
    nicknameNextChangeAt?: string | null;
}

/** Fetch the top N entries for `mode`. Backend caps at 500 regardless
 *  of what you ask; asking for less just skips the tail. */
export async function fetchTop(mode: LeaderboardApiMode, limit = 500): Promise<LeaderboardApiEntry[]> {
    const url = `${BACKEND_BASE_URL}/leaderboard/${mode}/top?limit=${limit}`;
    const data = await httpGetJson<{ entries: LeaderboardApiEntry[] }>(url, BACKEND_TIMEOUT_MS);
    return data.entries ?? [];
}

/** Submit the current player's score. Server does best-of merging;
 *  submitting a lower score than an existing personal best returns
 *  `{ updated: false }` with the existing best preserved. */
export async function submitScore(
    mode: LeaderboardApiMode,
    score: number,
): Promise<SubmitResult> {
    console.log(`[Leaderboard] submit mode=${mode} score=${score} uuid=${PlayerProfile.uuid.slice(0, 8)} name=${PlayerProfile.name}`);
    const url = `${BACKEND_BASE_URL}/leaderboard/${mode}/submit`;
    try {
        const r = await httpPostJson<SubmitResult>(url, {
            uuid:  PlayerProfile.uuid,
            name:  PlayerProfile.name,
            score,
        }, BACKEND_TIMEOUT_MS);
        console.log(`[Leaderboard] submit OK — updated=${r.updated} personalBest=${r.personalBest} rank=${r.rank}`);
        return r;
    } catch (err: any) {
        console.warn(`[Leaderboard] submit FAILED: ${err?.message}`);
        throw err;
    }
}

/** Fetch the current player's rank + score for `mode`. Both fields
 *  are `null` if the player hasn't submitted any score for that
 *  mode yet. */
export async function fetchMyRank(mode: LeaderboardApiMode): Promise<MyRankResult> {
    const uuid = encodeURIComponent(PlayerProfile.uuid);
    const url = `${BACKEND_BASE_URL}/leaderboard/${mode}/rank/${uuid}`;
    return httpGetJson<MyRankResult>(url, BACKEND_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Per-level top-time leaderboard (replaces the count-cleared level board).
//
// SERVER API CONTRACT (backend TODO — this repo doesn't ship the server):
//
//   POST /leaderboard/level-time/submit
//     Body: { uuid, name, levelIdx, elapsedSec }
//     Auth: bearer
//     Response: { updated: boolean, personalBest: number|null, rank: number|null }
//
//     Server behaviour per (uuid, levelIdx):
//       - Keep the FASTEST elapsedSec the player has ever submitted for
//         that level (min-of-best merging — resubmitting a slower time
//         does NOT downgrade the record; returns updated=false).
//       - Reject elapsedSec < 1 (obvious cheat / clock glitch) with HTTP 400.
//
//     Server-side global table per level:
//       - Store TOP-10 fastest times per levelIdx (over-provisioned so
//         bans / cheat removals promote #11 into #10 without a re-crawl).
//       - Return the caller's own rank + best in the response so the
//         client can paint an inline "you are #7" line without a
//         second GET.
//
//   GET /leaderboard/level-time/tops
//     Query: none (returns the CURRENT #1 for every level with any entry)
//     Auth: bearer optional
//     Response: { entries: LevelTopEntry[] }
//       LevelTopEntry = { levelIdx, uuid, name, avatarIdx, elapsedSec }
//       Missing levels (nobody has cleared them yet) are simply omitted
//       from the array — client fills the row with "—".
//
//   All time fields are WHOLE SECONDS (integer). Matches HUD display
//   and avoids sub-second sort tie-breakers with no user-visible
//   effect (M:SS granularity is what the leaderboard shows).
// ---------------------------------------------------------------------------

/** One row of the per-level leaderboard — the top-1 (fastest) player
 *  for a specific level index, painted onto the LeaderboardController's
 *  level tab as "Floor X: <name> <MM:SS>". */
export interface LevelTopEntry {
    levelIdx:   number;   // 0-based index into the flatLevels array
    uuid:       string;
    name:       string;
    avatarIdx:  number;
    elapsedSec: number;   // whole seconds; format as MM:SS in UI
}

export interface LevelTimeSubmitResult {
    updated:      boolean;
    personalBest: number | null;  // fastest elapsedSec the player has for this level
    rank:         number | null;  // caller's rank among top-10 (1-based), null if outside
}

/** Submit a level-clear time (whole seconds). Server keeps the
 *  min-of-best per (uuid, levelIdx) — resubmitting a SLOWER time
 *  won't downgrade the personal best (server returns updated=false).
 *  Called from GameController.onLevelWin. */
export async function submitLevelTime(
    levelIdx: number,
    elapsedSec: number,
): Promise<LevelTimeSubmitResult> {
    console.log(`[Leaderboard] submitLevelTime levelIdx=${levelIdx} elapsedSec=${elapsedSec} uuid=${PlayerProfile.uuid.slice(0, 8)}`);
    const url = `${BACKEND_BASE_URL}/leaderboard/level-time/submit`;
    try {
        const r = await httpPostJson<LevelTimeSubmitResult>(url, {
            uuid:       PlayerProfile.uuid,
            name:       PlayerProfile.name,
            levelIdx,
            elapsedSec,
        }, BACKEND_TIMEOUT_MS);
        console.log(`[Leaderboard] submitLevelTime OK — updated=${r.updated} personalBest=${r.personalBest} rank=${r.rank}`);
        return r;
    } catch (err: any) {
        console.warn(`[Leaderboard] submitLevelTime FAILED: ${err?.message}`);
        throw err;
    }
}

/** Fetch the current #1 (fastest) player for every level. Returns
 *  a sparse array — levels with zero entries are simply not present.
 *  Client-side renderer indexes by `levelIdx` for O(1) row lookup
 *  when painting the 1..99 list. */
export async function fetchLevelTops(): Promise<LevelTopEntry[]> {
    const url = `${BACKEND_BASE_URL}/leaderboard/level-time/tops`;
    const data = await httpGetJson<{ entries: LevelTopEntry[] }>(url, BACKEND_TIMEOUT_MS);
    return data.entries ?? [];
}

/** One entry in the local player's own per-level PB list — used by
 *  the leaderboard's LEVEL tab to show "your fastest clear on this
 *  floor" in the bottom my-row when the player taps a scroll row. */
export interface MyLevelTimeEntry {
    levelIdx:   number;
    elapsedSec: number;
}

/** Fetch the local player's personal-best time for every level they've
 *  cleared. Sparse: levels with no clear are simply omitted (client
 *  displays "—" in that case). Server derives the caller identity from
 *  the bearer token, so no uuid param needed.
 *
 *  Server contract:
 *    GET /leaderboard/level-time/mine
 *      Auth: bearer
 *      Response: { entries: MyLevelTimeEntry[] }
 */
export async function fetchMyLevelTimes(): Promise<MyLevelTimeEntry[]> {
    const url = `${BACKEND_BASE_URL}/leaderboard/level-time/mine`;
    const data = await httpGetJson<{ entries: MyLevelTimeEntry[] }>(url, BACKEND_TIMEOUT_MS);
    return data.entries ?? [];
}

/** Server-issued anonymous account bootstrap. Called by PlayerProfile
 *  on first launch. Server generates a fresh UUID + default nickname
 *  + bearer token; the token is what future mutating calls carry in
 *  the Authorization header. `sign=false` because we don't have a
 *  token yet to prove identity — the server intentionally allows
 *  unsigned register. */
export async function registerPlayer(): Promise<RegisterResult> {
    const url = `${BACKEND_BASE_URL}/player/register`;
    return httpPostJson<RegisterResult>(url, {}, BACKEND_TIMEOUT_MS, /*sign=*/false);
}

/** Rotate the bearer token before it expires. Requires the current
 *  (non-expired) bearer to be already set via setBearerToken. Server
 *  returns a fresh token + expiry. */
export async function refreshPlayerToken(): Promise<RefreshResult> {
    const url = `${BACKEND_BASE_URL}/player/refresh`;
    return httpPostJson<RefreshResult>(url, {}, BACKEND_TIMEOUT_MS, /*sign=*/false);
}

/** Fetch the local player's full profile — name, avatar index, and
 *  best scores per mode. Rejects on network error / 4xx / 5xx. */
export async function fetchPlayerProfile(): Promise<PlayerProfileResult> {
    const uuid = encodeURIComponent(PlayerProfile.uuid);
    const url  = `${BACKEND_BASE_URL}/player/${uuid}/profile`;
    return httpGetJson<PlayerProfileResult>(url, BACKEND_TIMEOUT_MS);
}

/** Patch the local player's profile. `name` and `avatarIdx` are
 *  independently optional — pass whichever you're changing. Server
 *  trims + caps name to its own MAX_NAME_LEN (20 today).
 *
 *  `useRenameCard` (nickname rename only): when true, the server
 *  attempts to consume 1 `rename_card` from the caller's backpack
 *  atomically as part of the rename. On no-card the server responds
 *  409 `nickname: no-card`. On success the card is debited and the
 *  rename applies. The old 7-day cooldown is retired — the card is
 *  the only gate. Server ignores this flag when the patch has no
 *  `name` (e.g. avatar-only edits skip the card check). */
export async function updatePlayerProfile(
    patch: { name?: string; avatarIdx?: number; useRenameCard?: boolean },
): Promise<PlayerProfileUpdateResult> {
    const uuid = encodeURIComponent(PlayerProfile.uuid);
    const url  = `${BACKEND_BASE_URL}/player/${uuid}/profile`;
    return httpPutJson<PlayerProfileUpdateResult>(url, patch, BACKEND_TIMEOUT_MS);
}
