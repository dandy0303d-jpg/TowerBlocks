/**
 * EventNewbie14Api — 14-day newbie gift event client.
 *
 * Server contract (see tetritower-server-newbie14-event):
 *   GET  /player/event/newbie14/status
 *     Auth: bearer
 *     → { active, daysRemaining, canClaimToday, claimedToday,
 *         totalClaimed, dailyReward }
 *
 *   POST /player/event/newbie14/claim
 *     Auth: bearer + HMAC signature
 *     Body: {}
 *     → 200 { granted, wallet: { gems, updatedAt } }
 *     → 409 { error: 'already_claimed_today' }
 *     → 410 { error: 'event_ended' }
 *
 * The event window is 14 UTC days from the player's `created_at`.
 * Missed days can NOT be back-filled — the client should treat the
 * status response as authoritative (do not compute
 * `canClaimToday` locally).
 */

import { httpGetJson, httpPostJson } from './Http';
import { BACKEND_BASE_URL, BACKEND_TIMEOUT_MS } from './BackendConfig';

export interface Newbie14Status {
    /** false ⇒ hide the main-menu entry button entirely (past day 14
     *  or, in the future, event globally disabled). */
    active:        boolean;
    /** Whole days left in the 14-day window, INCLUDING today. 0 when
     *  inactive. Client should show `活动剩余 N 天` from this. */
    daysRemaining: number;
    /** true ⇒ the claim button should be enabled RIGHT NOW. */
    canClaimToday: boolean;
    /** true ⇒ player already claimed for today; button shows the
     *  "已领取" state until UTC midnight. */
    claimedToday:  boolean;
    /** Cumulative claims (0..14). Only used for progress UI if we add
     *  a "3 / 14" indicator later. */
    totalClaimed:  number;
    /** Gems credited per claim. Client should show this on the button
     *  so we can tune server-side without shipping a new build. */
    dailyReward:   number;
}

export interface Newbie14ClaimResult {
    /** Gems added by THIS claim (matches server DAILY_REWARD_GEMS). */
    granted: number;
    /** Fresh wallet snapshot after the credit — save the caller a
     *  follow-up GET /player/wallet. */
    wallet:  { gems: number; updatedAt: string };
}

/** GET the event status. Read-only; safe to call on every menu
 *  refresh. */
export function fetchNewbie14Status(): Promise<Newbie14Status> {
    const url = `${BACKEND_BASE_URL}/player/event/newbie14/status`;
    return httpGetJson<Newbie14Status>(url, BACKEND_TIMEOUT_MS);
}

/** POST claim. Server is the sole authority on "can I claim now" —
 *  callers should not gate on client state.
 *
 *  Rejects on ALL non-200 responses (409, 410, 5xx, network). The
 *  429/exhausted-style "well-formed no" pattern from DailyFreeApi
 *  isn't needed here: the popup UI already reads status first, so
 *  a 409 in practice means a race (double-tap during the same day)
 *  which we surface as an error toast, not a silent no-op. */
export function claimNewbie14(): Promise<Newbie14ClaimResult> {
    const url = `${BACKEND_BASE_URL}/player/event/newbie14/claim`;
    return httpPostJson<Newbie14ClaimResult>(url, {}, BACKEND_TIMEOUT_MS);
}
