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
    authenticate: 'gc.authenticate',
    getState:     'gc.getState',
    authResult:   'gc.authResult',
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
        // Not our event — forward to the previous handler (AppleAuth,
        // StoreKit, etc.).
        if (typeof prev === 'function') prev(event, arg);
    };
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
};
