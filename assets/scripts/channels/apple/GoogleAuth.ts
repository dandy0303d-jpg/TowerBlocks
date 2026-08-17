/**
 * GoogleAuth — TypeScript wrapper for the iOS Google Sign-In bridge.
 *
 * Mirrors AppleAuth's shape so MenuController can treat both flows
 * symmetrically. On non-iOS platforms signIn() rejects with
 * 'platform-unsupported'.
 *
 * Usage:
 *   import { GoogleAuth } from '../channels/apple/GoogleAuth';
 *   try {
 *       const cred = await GoogleAuth.signIn();
 *       // cred.idToken → send to server /player/link/google
 *   } catch (e) {
 *       if ((e as Error).message.startsWith('user-cancelled')) return;
 *   }
 */

import { native, sys } from 'cc';

const EV = {
    signIn:       'google.signIn',
    signInResult: 'google.signInResult',
} as const;

export interface GoogleCredential {
    /** JWT signed by Google — send to server for verification + link.
     *  Obtained via authorization_code + PKCE + token exchange (see
     *  GoogleAuthBridge.swift). Replay-safe by construction: Google's
     *  token endpoint enforces one-time use of the (code, code_verifier)
     *  pair, so a captured id_token can't be re-minted. */
    idToken:   string;
    /** Google's stable per-user identifier (extracted client-side for
     *  logging; server re-extracts after signature verify). */
    googleSub: string;
}

export type GoogleErrorKind =
    | 'user-cancelled'
    | 'failed'
    | 'platform-unsupported'
    | 'unknown';

// ---------------------------------------------------------------------------
// Router — piggy-backs on the shared native.bridge.onNative fan-out used
// by AppleAuth / StoreKit / GameCenter so all channel modules coexist.
// ---------------------------------------------------------------------------

interface SlotWaiter {
    resolve: (result: any) => void;
    reject:  (err: Error) => void;
    timer:   ReturnType<typeof setTimeout>;
}
let pendingSignIn: SlotWaiter | null = null;

if (sys.isNative && sys.os === sys.OS.IOS && (native as any).bridge) {
    const prev = (native as any).bridge.onNative;
    (native as any).bridge.onNative = (event: string, arg: string | null) => {
        if (event === EV.signInResult) {
            const w = pendingSignIn;
            pendingSignIn = null;
            if (!w) return;
            clearTimeout(w.timer);
            try {
                const parsed = JSON.parse(arg ?? '{}');
                if (parsed.success) {
                    w.resolve(parsed);
                } else {
                    w.reject(new Error(`${parsed.kind ?? 'unknown'}: ${parsed.error ?? ''}`));
                }
            } catch (e) {
                w.reject(new Error(`parse error: ${String(e)}`));
            }
            return;
        }
        if (typeof prev === 'function') prev(event, arg);
    };
}

export const GoogleAuth = {
    /** Start Google Sign-In. Presents the ASWebAuthenticationSession
     *  modal via the native bridge; resolves with the Google id_token
     *  or rejects with a typed error string ('user-cancelled: ...',
     *  'failed: ...'). */
    signIn(timeoutMs = 120_000): Promise<GoogleCredential> {
        if (!sys.isNative || sys.os !== sys.OS.IOS) {
            return Promise.reject(new Error('platform-unsupported: iOS-only'));
        }
        if (pendingSignIn) {
            return Promise.reject(new Error('failed: sign-in already in flight'));
        }
        return new Promise<GoogleCredential>((resolve, reject) => {
            const timer = setTimeout(() => {
                pendingSignIn = null;
                reject(new Error(`failed: sign-in timed out after ${timeoutMs}ms`));
            }, timeoutMs);
            pendingSignIn = { resolve, reject, timer };
            (native as any).bridge.sendToNative(EV.signIn, '');
        });
    },
};
