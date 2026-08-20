/**
 * GameCenter — TypeScript wrapper for the iOS Game Center (GameKit) bridge.
 *
 * On iOS: the native GameCenterBridgeGlue auto-fires the login flow
 * at app boot via AppDelegate. This module just listens for the
 * `gc.authResult` event and caches the outcome so the game can:
 *   - show the player's Game Center display name / avatar
 *   - use `gamePlayerID` as a stable per-app identifier
 *   - later: submit leaderboards / achievements via GameKit
 *
 * On non-iOS platforms (Android, web preview, editor): everything is
 * a no-op. `authenticate()` resolves with `{success:false, kind:
 * 'platform-unsupported'}` so callers can guard by kind.
 *
 * Usage:
 *   import { GameCenter } from '../channels/apple/GameCenter';
 *
 *   // Fire-and-forget at boot (already auto-fired on iOS native,
 *   // but calling explicitly gives us a Promise to await if we
 *   // want to gate UI on the result).
 *   GameCenter.authenticate().then((r) => {
 *       if (r.success) console.log('GC:', r.displayName);
 *   });
 */

import { native, sys } from 'cc';

const EV = {
    authenticate:            'gc.authenticate',
    getState:                'gc.getState',
    authResult:              'gc.authResult',
    fetchIdentity:           'gc.fetchIdentity',
    identityResult:          'gc.identityResult',
    submitScore:             'gc.submitScore',
    submitScoreResult:       'gc.submitScoreResult',
    reportAchievement:       'gc.reportAchievement',
    reportAchievementResult: 'gc.reportAchievementResult',
    showUI:                  'gc.showUI',
    showUIResult:            'gc.showUIResult',
} as const;

/** ID constants — must match ASC → Game Center configuration. */
export const GC_LEADERBOARD = {
    endless: 'WuJinMoShi',
} as const;
export const GC_ACHIEVEMENT = {
    levelMode: 'GuanQiaMoShi',
} as const;

export interface GameCenterPlayer {
    success: true;
    gamePlayerID: string;
    teamPlayerID: string;
    displayName:  string;
    alias:        string;
    isUnderage:   boolean;
}

export type GameCenterErrorKind =
    | 'platform-unsupported'
    | 'pending'
    | 'auth-failed'
    | 'no-present-vc'
    | 'encode-failed'
    | 'unknown';

export interface GameCenterError {
    success: false;
    kind:    GameCenterErrorKind;
    error:   string;
}

export type GameCenterResult = GameCenterPlayer | GameCenterError;

// ---------------------------------------------------------------------------
// Event routing — install ONCE at module import time. Piggy-backs on
// the same native.bridge.onNative fan-out used by AppleAuth so the
// two don't clobber each other.
// ---------------------------------------------------------------------------

type Listener = (result: GameCenterResult) => void;
const listeners: Set<Listener> = new Set();
let lastResult: GameCenterResult | null = null;

// Pending one-shot resolvers for submitScore / reportAchievement /
// showUI / fetchIdentity. Keyed by event name — only one in flight
// per kind at a time (calls are serialised by the caller; overlap
// replaces the prior slot which is fine for fire-and-forget game
// telemetry).
type OneShot = (payload: any) => void;
const oneShotSlots: Record<string, OneShot | null> = {
    [EV.submitScoreResult]:       null,
    [EV.reportAchievementResult]: null,
    [EV.showUIResult]:            null,
    [EV.identityResult]:          null,
};

// Install the router only when running on native iOS. On other
// platforms `native.bridge` is undefined and the fan-out is skipped.
if (sys.isNative && sys.os === sys.OS.IOS && (native as any).bridge) {
    const prev = (native as any).bridge.onNative;
    (native as any).bridge.onNative = (event: string, arg: string | null) => {
        if (event === EV.authResult) {
            try {
                const parsed = JSON.parse(arg ?? '{}') as GameCenterResult;
                lastResult = parsed;
                for (const fn of listeners) {
                    try { fn(parsed); } catch (e) { console.warn('[GC] listener threw:', e); }
                }
            } catch (e) {
                console.warn('[GC] failed to parse authResult payload:', e, arg);
            }
            return;
        }
        // One-shot response events — dispatch to whoever's waiting.
        if (event in oneShotSlots) {
            const slot = oneShotSlots[event];
            oneShotSlots[event] = null;
            if (slot) {
                try {
                    const parsed = JSON.parse(arg ?? '{}');
                    slot(parsed);
                } catch (e) {
                    slot({ success: false, kind: 'parse-error', error: String(e) });
                }
            }
            return;
        }
        // Not our event — forward to the previous handler (AppleAuth,
        // StoreKit, etc.).
        if (typeof prev === 'function') prev(event, arg);
    };
}

function oneShotCall(
    sendEvent: string,
    replyEvent: string,
    argPayload: string,
    timeoutMs = 8_000,
): Promise<{ success: boolean; kind?: string; error?: string }> {
    if (!sys.isNative || sys.os !== sys.OS.IOS) {
        return Promise.resolve({ success: false, kind: 'platform-unsupported', error: 'iOS-only' });
    }
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            if (oneShotSlots[replyEvent]) oneShotSlots[replyEvent] = null;
            resolve({ success: false, kind: 'timeout', error: `no reply after ${timeoutMs}ms` });
        }, timeoutMs);
        oneShotSlots[replyEvent] = (r) => { clearTimeout(timer); resolve(r); };
        (native as any).bridge.sendToNative(sendEvent, argPayload);
    });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export const GameCenter = {

    /** Kick off (or replay) the login flow. Resolves with the first
     *  auth result — success or failure. Timeout after 30s so a
     *  never-firing handler doesn't hang the caller forever. */
    authenticate(timeoutMs = 30_000): Promise<GameCenterResult> {
        if (!sys.isNative || sys.os !== sys.OS.IOS) {
            return Promise.resolve<GameCenterError>({
                success: false,
                kind: 'platform-unsupported',
                error: 'Game Center is iOS-only',
            });
        }
        // Fast path — auth already resolved.
        if (lastResult) return Promise.resolve(lastResult);
        return new Promise((resolve) => {
            const listener: Listener = (r) => {
                listeners.delete(listener);
                clearTimeout(timer);
                resolve(r);
            };
            listeners.add(listener);
            const timer = setTimeout(() => {
                listeners.delete(listener);
                resolve({
                    success: false,
                    kind: 'pending',
                    error: `Game Center authenticate timed out after ${timeoutMs}ms`,
                });
            }, timeoutMs);
            (native as any).bridge.sendToNative(EV.authenticate, '');
        });
    },

    /** Get the last-known auth result WITHOUT triggering the bridge.
     *  `null` if the handler hasn't fired yet. Useful for UI code
     *  that wants to render Game Center state on demand. */
    getCachedResult(): GameCenterResult | null {
        return lastResult;
    },

    /** Subscribe to future auth results. Fires immediately with the
     *  cached result if one exists. Returns an unsubscribe function. */
    subscribe(fn: Listener): () => void {
        listeners.add(fn);
        if (lastResult) {
            try { fn(lastResult); } catch (e) { console.warn('[GC] subscribe fire threw:', e); }
        }
        return () => { listeners.delete(fn); };
    },

    /** Submit a score to a Game Center leaderboard. `score` is an
     *  integer (whatever units the ASC leaderboard was configured
     *  for). Non-blocking — callers should NOT await this on the
     *  hot path; treat it as fire-and-forget. */
    submitScore(leaderboardID: string, score: number): Promise<{ success: boolean; error?: string }> {
        return oneShotCall(EV.submitScore, EV.submitScoreResult,
            JSON.stringify({ leaderboardID, score: Math.floor(score) }));
    },

    /** Report progress on a Game Center achievement. `percentComplete`
     *  is 0-100; 100 unlocks the achievement + shows the native banner. */
    reportAchievement(achievementID: string, percentComplete: number): Promise<{ success: boolean; error?: string }> {
        const pct = Math.max(0, Math.min(100, percentComplete));
        return oneShotCall(EV.reportAchievement, EV.reportAchievementResult,
            JSON.stringify({ achievementID, percentComplete: pct }));
    },

    /** Present the native Game Center UI. `stateKind`:
     *    ''             — dashboard (default landing)
     *    'leaderboards' — leaderboards list
     *    'achievements' — achievements list
     *    'leaderboard:<id>' — specific leaderboard */
    showUI(stateKind: string = ''): Promise<{ success: boolean; error?: string }> {
        return oneShotCall(EV.showUI, EV.showUIResult, stateKind);
    },

    /** Fetch the identity-verification payload used to authenticate
     *  the current Game Center player with the game's own backend.
     *  Server verifies the RSA-SHA256 signature against Apple's
     *  public key and, on success, mints a bearer token bound to
     *  the player's uuid.
     *
     *  Returns:
     *    success = true  → payload ready to POST to
     *                       /player/login/gamecenter (or /link/gamecenter)
     *    success = false → error kind ("not-authenticated" is the
     *                       common one — GC auto-login hasn't fired
     *                       or the user is signed out of Game Center)
     */
    fetchIdentity(timeoutMs = 15_000): Promise<GameCenterIdentityResult> {
        return oneShotCall(EV.fetchIdentity, EV.identityResult, '', timeoutMs) as
            Promise<GameCenterIdentityResult>;
    },
};

/** Payload returned by `GameCenter.fetchIdentity()`. Fields match the
 *  shape produced by GKLocalPlayer.fetchItems(forIdentityVerificationSignature:)
 *  and are POSTed verbatim to the server's /player/{login,link}/gamecenter
 *  routes. */
export interface GameCenterIdentitySuccess {
    success:      true;
    gamePlayerID: string;
    teamPlayerID: string;
    displayName:  string;
    alias:        string;
    publicKeyURL: string;
    signature:    string;   // base64
    salt:         string;   // base64
    timestamp:    number;   // uint64 ms since epoch
    bundleID:     string;
}

export interface GameCenterIdentityFailure {
    success:  false;
    kind:     string;
    error?:   string;
}

export type GameCenterIdentityResult = GameCenterIdentitySuccess | GameCenterIdentityFailure;
