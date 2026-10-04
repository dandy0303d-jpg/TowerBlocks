/**
 * RunApi — server-authoritative run certification (anti-cheat).
 *
 * Replaces the direct `submitScore` / `submitLevelTime` / activity-progress-
 * reporter path with a `/run/start` + `/run/finish` pair that the server
 * uses to verify the run (serverElapsed vs client elapsedSec, line/piece
 * rate caps, levelIdx must be ≤ server-authoritative maxClearedIdx + 1).
 * See INBOX_CLIENT.md 2026-10-05 message from claude-5d for the full
 * contract.
 *
 * Shape of a run from the client's point of view:
 *
 *     RunApi.startRun('level' | 'endless' | 'blind', levelIdx?)
 *         → { runId, startedAt, maxClearedIdx, counted }
 *         counted=false means server's levelIdx gate rejected this one;
 *         player still plays, we just skip finish's leaderboard/badge
 *         updates (server would 200 them anyway — no harm — but logging
 *         explicitly avoids wasted analytics).
 *
 *     // during the run
 *     RunApi.recordPieceLock()
 *     RunApi.recordLineClears(n)
 *     RunApi.recordRevive()        // bumps revivedCount; NO finish sent
 *
 *     RunApi.finishRun({ result: 'cleared' | 'failed' | 'quit',
 *                        score, linesClearedOverride?, elapsedSec? })
 *         → { ok, maxClearedIdx, newBadgeGroups, levelTime?, score?,
 *             activityAffected } | null  (null = offline run / finish queued)
 *
 * Lifecycle guarantees:
 *   - exactly ONE currentRun at a time; starting a new one abandons any
 *     previous (useful if the player quits via home and immediately
 *     re-enters mode-select without the finish having gone through —
 *     the orphan run will expire via its 6h server TTL).
 *   - revive does NOT fire finish — same runId stays live across the
 *     revive timeline. revivedCount is sent on the eventual real finish
 *     so server can widen its serverElapsed tolerance.
 *   - offline flow: if startRun fails (no network, 5xx), currentRun stays
 *     null and finishRun becomes a no-op. The player's run is "offline"
 *     and doesn't count for leaderboard / activity / badges, but local
 *     progress (LevelProgress, endless-best) is still written by the
 *     caller as before.
 *
 * Retry queue (persisted):
 *   - `/run/finish` failures (network / 5xx) are JSON-serialised and
 *     stored under RUN_PENDING_KEY in localStorage. On every subsequent
 *     RunApi call the module runs a quick drain, trying each pending
 *     entry at most RETRY_MAX_ATTEMPTS times across RETRY_MAX_AGE_MS.
 *   - 410 run-expired / 409 run-already-finishing / any 4xx that isn't
 *     retryable → drop silently (server has the authoritative decision).
 *
 * Not retried:
 *   - startRun — if the user quits mid-run and reopens, the server-side
 *     Redis entry has probably expired anyway, and a fresh startRun is
 *     cheap enough to just call again on the next session.
 */

import { sys } from 'cc';
import { BACKEND_BASE_URL, BACKEND_TIMEOUT_MS } from './BackendConfig';
import { httpPostJson } from './Http';
import { LevelProgress } from './LevelProgress';

/** The run modes `/run/start` understands. */
export type RunMode = 'level' | 'endless' | 'blind';

/** Natural outcomes `/run/finish` accepts. */
export type RunResult = 'cleared' | 'failed' | 'quit';

export interface StartRunResponse {
    runId:          string;
    /** ISO8601 — server's wall-clock at start; we use it for logging
     *  / debugging only, local elapsed is tracked from Date.now(). */
    startedAt:      string;
    /** Server-authoritative max cleared level idx (-1 = never cleared any). */
    maxClearedIdx:  number;
    /** false = server rejected the levelIdx gate (ahead of server's
     *  progress). Run still plays locally but finish won't update anything. */
    counted:        boolean;
}

export interface LevelTimeOutcome {
    updated:        boolean;
    personalBest:   number;    // seconds
    rank:           number;
}

export interface ScoreOutcome {
    updated:        boolean;
    personalBest:   number;
    rank:           number;
}

export interface FinishRunResponse {
    ok:                 boolean;
    /** Server-authoritative post-finish max cleared idx. May bump by 1
     *  if `result:'cleared'` for a level == maxClearedIdx + 1. */
    maxClearedIdx:      number;
    /** Badge group indices newly unlocked by this run (empty if none).
     *  Caller displays "新徽章!" FX / lets player claim via /badge/claim. */
    newBadgeGroups:     number[];
    /** Present only for level-mode cleared runs where levelIdx ≥ 9. */
    levelTime?:         LevelTimeOutcome;
    /** Present only for endless/blind runs. */
    score?:             ScoreOutcome;
    /** Activity ids whose progress just changed server-side (triggers
     *  the main-menu red-dot refresh). */
    activityAffected?:  string[];
}

interface CurrentRun {
    runId:            string;
    mode:             RunMode;
    levelIdx:         number;      // -1 for endless/blind
    counted:          boolean;
    /** Local wall-clock at startRun resolution; used to derive elapsedSec
     *  if the caller doesn't override it. */
    localStartedMs:   number;
    /** Server's startedAt echoed back; log-only. */
    serverStartedAt:  string;
    /** Server's maxClearedIdx snapshot (useful for client to self-correct
     *  if local LevelProgress is ahead of server). */
    maxClearedIdx:    number;
    piecesPlaced:     number;
    /** Natural line clears accumulated during this run. */
    linesCleared:     number;
    revivedCount:     number;
}

/** Pending `/run/finish` payload kept in localStorage so a network outage
 *  during gameover doesn't lose the run. Serialised directly as JSON. */
interface PendingFinish {
    runId:         string;
    body:          Record<string, unknown>;
    firstAttemptMs: number;
    attempts:      number;
}

const RUN_PENDING_KEY = 'tt.run.pending_finishes';
const RETRY_MAX_ATTEMPTS = 3;
/** Drop pending finishes older than this. Matches the server-side Redis
 *  TTL of 6h for runId — anything older will 410 anyway. */
const RETRY_MAX_AGE_MS = 6 * 60 * 60 * 1000;

let currentRun: CurrentRun | null = null;

export const RunApi = {

    /** Public read-only accessor for the current run, if any. */
    get current(): Readonly<CurrentRun> | null {
        return currentRun;
    },

    /** True while a run is active (post-startRun, pre-finishRun). */
    get isRunActive(): boolean {
        return currentRun !== null;
    },

    /** Does the current run count toward leaderboards/badges/activity?
     *  false when the server rejected the levelIdx gate OR when we're
     *  in an "offline run" (no runId). */
    get isRunCounted(): boolean {
        return currentRun !== null && currentRun.counted;
    },

    /** Open a run with the server. On network/server failure returns
     *  null (offline mode); the caller lets the player play but should
     *  skip finishRun. On success, populates `current` and returns the
     *  server's response.
     *
     *  Does NOT auto-call finishRun on the previous run — the caller is
     *  expected to finish/quit before switching modes. If it doesn't,
     *  the stale run just expires on the server (6h TTL). */
    async startRun(mode: RunMode, levelIdx?: number): Promise<StartRunResponse | null> {
        void _drainPendingFinishes();
        currentRun = null;
        const body: Record<string, unknown> = { mode };
        if (mode === 'level') {
            if (!Number.isInteger(levelIdx) || (levelIdx as number) < 0) {
                console.warn(`[RunApi] startRun(level) called without valid levelIdx: ${levelIdx}`);
                return null;
            }
            body.levelIdx = levelIdx;
        }
        const url = `${BACKEND_BASE_URL}/run/start`;
        try {
            const res = await httpPostJson<StartRunResponse>(url, body, BACKEND_TIMEOUT_MS);
            currentRun = {
                runId:           res.runId,
                mode,
                levelIdx:        mode === 'level' ? (levelIdx as number) : -1,
                counted:         res.counted,
                localStartedMs:  Date.now(),
                serverStartedAt: res.startedAt,
                maxClearedIdx:   res.maxClearedIdx,
                piecesPlaced:    0,
                linesCleared:    0,
                revivedCount:    0,
            };
            console.log(`[RunApi] startRun ok — mode=${mode} levelIdx=${levelIdx ?? -1} runId=${res.runId.slice(0, 8)}… counted=${res.counted} serverMaxCleared=${res.maxClearedIdx}`);
            // Max-merge progress — if the server knows higher than
            // local (e.g. another device cleared further), bump local
            // so the level-select UI reflects it.
            if (Number.isFinite(res.maxClearedIdx)
                    && res.maxClearedIdx > LevelProgress.maxClearedIdx) {
                console.log(`[RunApi] startRun bumping local LevelProgress ${LevelProgress.maxClearedIdx} → ${res.maxClearedIdx}`);
                LevelProgress.restoreFrom(res.maxClearedIdx);
            }
            return res;
        } catch (err: any) {
            console.warn(`[RunApi] startRun failed (offline?) — mode=${mode}: ${err?.message ?? err}`);
            currentRun = null;
            return null;
        }
    },

    /** Increment piece-lock counter. No-op when no run is active (menu
     *  / tutorial / editor preview). Called from GameController's
     *  onPieceLock hook. */
    recordPieceLock(): void {
        if (!currentRun) return;
        currentRun.piecesPlaced += 1;
    },

    /** Increment line-clear counter. `n` is the NATURAL rows cleared this
     *  lock (not item-induced). Called from onNaturalRowClears. */
    recordLineClears(n: number): void {
        if (!currentRun) return;
        if (!Number.isFinite(n) || n <= 0) return;
        currentRun.linesCleared += n;
    },

    /** Flag that a revive just happened. Server-side widens the
     *  serverElapsed tolerance by `revivedCount × reviveIntervalMax`.
     *  Does NOT send finish — the run continues under the same runId. */
    recordRevive(): void {
        if (!currentRun) return;
        currentRun.revivedCount += 1;
        console.log(`[RunApi] revive recorded — total ${currentRun.revivedCount} for runId=${currentRun.runId.slice(0, 8)}…`);
    },

    /** Send `/run/finish`. On network failure the payload is queued and
     *  retried on subsequent RunApi calls (and at the next cold boot).
     *
     *  `score`         — for endless/blind: tower height (= linesCleared).
     *                     for level: 0 (server ignores it for level mode).
     *  `linesClearedOverride` — if provided, replaces the accumulated
     *                     natural-clear counter. Only needed for the
     *                     endless/blind path where the server treats
     *                     `score` and `linesCleared` as the same number;
     *                     passing both explicitly keeps the two fields
     *                     consistent in audit logs.
     *  `elapsedSec`    — if provided, overrides the Date.now()-derived
     *                     local elapsed. Level mode caller passes
     *                     gameState.levelElapsedSec which is paused on
     *                     modal overlays, more accurate than wall-clock.
     *
     *  Resolves with the server response on success, null when the
     *  request was queued (offline / 5xx), and null for offline runs
     *  (no currentRun). Caller shouldn't rely on the resolution for
     *  critical UI — treat as fire-and-forget. */
    async finishRun(opts: {
        result:                 RunResult;
        score:                  number;
        linesClearedOverride?:  number;
        elapsedSec?:            number;
    }): Promise<FinishRunResponse | null> {
        void _drainPendingFinishes();
        const run = currentRun;
        if (!run) {
            console.log(`[RunApi] finishRun no-op — no active run (offline?)`);
            return null;
        }
        // Clear currentRun BEFORE the network call so a concurrent
        // startRun (impossible under current callers but defensive)
        // doesn't double-count. The already-sent payload keeps a local
        // reference.
        currentRun = null;
        const elapsedSec = Number.isFinite(opts.elapsedSec)
            ? Math.max(0, Math.floor(opts.elapsedSec as number))
            : Math.max(0, Math.floor((Date.now() - run.localStartedMs) / 1000));
        const linesCleared = Number.isFinite(opts.linesClearedOverride)
            ? Math.max(0, Math.floor(opts.linesClearedOverride as number))
            : run.linesCleared;
        const body: Record<string, unknown> = {
            runId:        run.runId,
            result:       opts.result,
            score:        Math.max(0, Math.floor(opts.score)),
            linesCleared,
            elapsedSec,
            piecesPlaced: run.piecesPlaced,
            revivedCount: run.revivedCount,
        };
        return _sendFinish(body);
    },

    /** Explicitly drop the current run tracking without sending finish.
     *  Used by GameController's abort / scene-reload paths (recovery
     *  swap wipes everything). The server's Redis entry will expire on
     *  its own via 6h TTL. */
    discardCurrentRun(): void {
        if (currentRun) {
            console.log(`[RunApi] discarding runId=${currentRun.runId.slice(0, 8)}… (no finish sent)`);
            currentRun = null;
        }
    },
};

// ============================================================
//  Internal — send + retry queue
// ============================================================

async function _sendFinish(body: Record<string, unknown>): Promise<FinishRunResponse | null> {
    const url = `${BACKEND_BASE_URL}/run/finish`;
    try {
        const res = await httpPostJson<FinishRunResponse>(url, body, BACKEND_TIMEOUT_MS);
        console.log(`[RunApi] finishRun ok — runId=${String(body.runId).slice(0, 8)}… result=${body.result} newBadges=${(res.newBadgeGroups ?? []).length} serverMaxCleared=${res.maxClearedIdx}`);
        _applyServerProgress(res);
        return res;
    } catch (err: any) {
        const msg = String(err?.message ?? err);
        // 410 run-expired → nothing to retry, server dropped the token.
        // 4xx (non-429) → the server made an authoritative decision,
        //                 don't thrash. 429 / 5xx / network → retry.
        if (msg.startsWith('HTTP 410')) {
            console.warn(`[RunApi] finishRun dropped — ${msg.slice(0, 120)}`);
            return null;
        }
        const retryable =
            /network error|Request timeout|HTTP 429|HTTP 5\d\d/i.test(msg);
        if (retryable) {
            console.warn(`[RunApi] finishRun failed (retryable) — queuing: ${msg.slice(0, 120)}`);
            _enqueuePending(body);
        } else {
            console.warn(`[RunApi] finishRun failed (non-retryable) — ${msg.slice(0, 160)}`);
        }
        return null;
    }
}

/** Max-merge the server-authoritative maxClearedIdx into LevelProgress.
 *  Server is always the truth of what the player has cleared (post-run-
 *  token). If the server says higher than local, bump local upward so
 *  the level-select UI unlocks the right range. We do NOT force-downward
 *  (local being ahead of server would mean a desync we don't want to
 *  silently roll back — more likely means a server-side race, log it). */
function _applyServerProgress(res: FinishRunResponse): void {
    if (!Number.isFinite(res.maxClearedIdx)) return;
    const serverIdx = res.maxClearedIdx;
    const localIdx = LevelProgress.maxClearedIdx;
    if (serverIdx > localIdx) {
        console.log(`[RunApi] bumping local LevelProgress ${localIdx} → ${serverIdx} from server`);
        LevelProgress.restoreFrom(serverIdx);
    } else if (serverIdx < localIdx) {
        console.warn(`[RunApi] server LevelProgress ${serverIdx} < local ${localIdx} — keeping local, server may be behind on this run's write`);
    }
}

function _loadPending(): PendingFinish[] {
    try {
        const raw = sys.localStorage?.getItem(RUN_PENDING_KEY);
        if (!raw) return [];
        const arr = JSON.parse(raw);
        return Array.isArray(arr) ? arr as PendingFinish[] : [];
    } catch (err) {
        console.warn('[RunApi] pending queue parse failed, resetting:', err);
        try { sys.localStorage?.removeItem(RUN_PENDING_KEY); } catch {}
        return [];
    }
}

function _savePending(list: PendingFinish[]): void {
    try {
        if (list.length === 0) {
            sys.localStorage?.removeItem(RUN_PENDING_KEY);
        } else {
            sys.localStorage?.setItem(RUN_PENDING_KEY, JSON.stringify(list));
        }
    } catch (err) {
        console.warn('[RunApi] pending queue persist failed:', err);
    }
}

function _enqueuePending(body: Record<string, unknown>): void {
    const runId = String(body.runId ?? '');
    if (!runId) return;
    const list = _loadPending();
    // Dedupe by runId — if the same run was already queued, overwrite
    // the body (newer counters are strictly better than older) and
    // leave the attempt counter alone.
    const existing = list.findIndex(e => e.runId === runId);
    if (existing >= 0) {
        list[existing].body = body;
    } else {
        list.push({ runId, body, firstAttemptMs: Date.now(), attempts: 0 });
    }
    _savePending(list);
}

/** Fire pending finishes in sequence, dropping entries that have exceeded
 *  the attempt / age limits. Fire-and-forget — never throws. Called at
 *  module load, startRun, and finishRun entry so the queue always gets
 *  attention as long as the game is in use. */
let _draining = false;
async function _drainPendingFinishes(): Promise<void> {
    if (_draining) return;
    _draining = true;
    try {
        const now = Date.now();
        const list = _loadPending();
        if (list.length === 0) return;
        const keep: PendingFinish[] = [];
        for (const entry of list) {
            if (now - entry.firstAttemptMs > RETRY_MAX_AGE_MS) {
                console.warn(`[RunApi] drop expired pending finish runId=${entry.runId.slice(0, 8)}… (age=${Math.floor((now - entry.firstAttemptMs) / 60000)}min)`);
                continue;
            }
            if (entry.attempts >= RETRY_MAX_ATTEMPTS) {
                console.warn(`[RunApi] drop pending finish runId=${entry.runId.slice(0, 8)}… — ${entry.attempts} attempts exhausted`);
                continue;
            }
            entry.attempts += 1;
            const url = `${BACKEND_BASE_URL}/run/finish`;
            try {
                const res = await httpPostJson<FinishRunResponse>(url, entry.body, BACKEND_TIMEOUT_MS);
                console.log(`[RunApi] drained pending finish runId=${entry.runId.slice(0, 8)}… (attempt ${entry.attempts})`);
                _applyServerProgress(res);
                // success — don't keep
            } catch (err: any) {
                const msg = String(err?.message ?? err);
                if (msg.startsWith('HTTP 410') || /HTTP 4\d\d/.test(msg) && !/HTTP 429/.test(msg)) {
                    console.warn(`[RunApi] drop pending (${msg.slice(0, 80)}) runId=${entry.runId.slice(0, 8)}…`);
                    continue;
                }
                keep.push(entry);
            }
        }
        _savePending(keep);
    } finally {
        _draining = false;
    }
}

// Drain any leftover pending finishes from a previous session on module
// load. Fire-and-forget — happens before any gameplay so a bad network
// won't stall it.
void _drainPendingFinishes();
