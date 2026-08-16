/**
 * CloudSync — iCloud key-value identity sync for guest continuity.
 *
 * The problem this solves: a guest player (never bound Apple ID) is
 * device-local. On reinstall or on a new device, the app registers
 * a fresh uuid + wipes their gems + progress. Bad UX.
 *
 * Solution: mirror the identity blob (uuid + bearer + name +
 * avatarIdx + tokenExp) to NSUbiquitousKeyValueStore. On any new
 * install where localStorage.uuid is empty but iCloud has one, seed
 * localStorage from iCloud BEFORE ensureRegistered runs. The player
 * lands back on their old server-side account transparently.
 *
 * Semantics:
 *   - `syncNow()`  push local identity to iCloud (call after any
 *                   PlayerProfile mutation).
 *   - `restore()`  fetch iCloud identity blob; return parsed or null.
 *                   Boot code calls this before ensureRegistered.
 *   - `clear()`    wipe the iCloud blob (delete-account flow).
 *
 * All calls are iOS-native-only. Non-iOS resolves to no-op / null.
 */

import { native, sys } from 'cc';

const EV = {
    setIdentity:      'cloudkv.setIdentity',
    getIdentity:      'cloudkv.getIdentity',
    clearIdentity:    'cloudkv.clearIdentity',
    identityResult:   'cloudkv.identityResult',
    identityChanged:  'cloudkv.identityChanged',
} as const;

export interface CloudIdentity {
    uuid:             string;
    bearer?:          string;
    tokenExpEpochSec?: number;
    name?:            string;
    avatarIdx?:       number;
    /** Schema version — bump when adding required fields. Restore
     *  logic can decide whether an older blob is still usable. */
    v:                number;
}

const IDENTITY_SCHEMA_V = 1;

// ---------------------------------------------------------------------------
// Native event routing — piggy-back onto the shared onNative fan-out.
// ---------------------------------------------------------------------------

let pendingResolve: ((val: string) => void) | null = null;

if (sys.isNative && sys.os === sys.OS.IOS && (native as any).bridge) {
    const prev = (native as any).bridge.onNative;
    (native as any).bridge.onNative = (event: string, arg: string | null) => {
        if (event === EV.identityResult) {
            const cb = pendingResolve;
            pendingResolve = null;
            if (cb) cb(arg ?? '');
            return;
        }
        if (event === EV.identityChanged) {
            // Another device pushed a change. For MVP: log + let the
            // next natural restore path pick it up. In a future
            // iteration we could hot-swap the identity mid-session.
            console.log('[CloudSync] iCloud pushed identity change from another device — restart to apply');
            return;
        }
        if (typeof prev === 'function') prev(event, arg);
    };
}

const bridgeAvailable = sys.isNative && sys.os === sys.OS.IOS && !!(native as any).bridge;

export const CloudSync = {

    /** Push the current identity snapshot to iCloud. Fire-and-forget —
     *  Apple's iCloud daemon syncs when it can. Silently no-ops on
     *  non-iOS or if uuid is missing (nothing to save).
     *
     *  Caller supplies the snapshot to avoid CloudSync taking a hard
     *  dependency on PlayerProfile (which would create an import
     *  cycle for PlayerProfile → CloudSync → PlayerProfile). */
    syncNow(snapshot: Omit<CloudIdentity, 'v'>): void {
        if (!bridgeAvailable) return;
        if (!snapshot.uuid) return;
        const blob: CloudIdentity = { v: IDENTITY_SCHEMA_V, ...snapshot };
        try {
            (native as any).bridge.sendToNative(EV.setIdentity, JSON.stringify(blob));
        } catch (e) {
            console.warn('[CloudSync] syncNow threw:', e);
        }
    },

    /** Fetch the iCloud identity blob. Resolves with parsed identity
     *  or null (nothing stored / non-iOS / bridge unavailable /
     *  timeout). Timeout 3s — iCloud read is local disk cache, should
     *  be instant; anything longer is broken. */
    restore(timeoutMs = 3_000): Promise<CloudIdentity | null> {
        if (!bridgeAvailable) return Promise.resolve(null);
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                pendingResolve = null;
                console.warn('[CloudSync] restore timed out');
                resolve(null);
            }, timeoutMs);
            pendingResolve = (raw: string) => {
                clearTimeout(timer);
                try {
                    const outer = JSON.parse(raw) as { success: boolean; identity?: string };
                    if (!outer.success || !outer.identity) {
                        resolve(null);
                        return;
                    }
                    const inner = JSON.parse(outer.identity) as CloudIdentity;
                    if (!inner.uuid) {
                        resolve(null);
                        return;
                    }
                    resolve(inner);
                } catch (e) {
                    console.warn('[CloudSync] restore parse failed:', e, raw);
                    resolve(null);
                }
            };
            (native as any).bridge.sendToNative(EV.getIdentity, '');
        });
    },

    /** Wipe the iCloud blob. Called from the delete-account flow so
     *  the deleted uuid doesn't get restored on next launch. */
    clear(): void {
        if (!bridgeAvailable) return;
        try {
            (native as any).bridge.sendToNative(EV.clearIdentity, '');
        } catch (e) {
            console.warn('[CloudSync] clear threw:', e);
        }
    },
};
