/**
 * AppleAuth — TypeScript wrapper for the iOS Sign in with Apple bridge.
 *
 * Only functional on iOS. On other platforms the calls resolve with a
 * `platform-unsupported` error so callers can guard by catching.
 *
 * Usage (from SettingsController or similar):
 *
 *   import { AppleAuth } from '../channels/apple/AppleAuth';
 *
 *   try {
 *       const cred = await AppleAuth.signIn();
 *       console.log('SIWA success:', cred.appleSub);
 *       // send cred.identityToken to server for verification + linking
 *   } catch (e) {
 *       if ((e as Error).message.startsWith('user-cancelled')) return;
 *       showError(t('siwa.failed'));
 *   }
 *
 *   const state = await AppleAuth.getCredentialState(cachedAppleSub);
 *   // 'authorized' | 'revoked' | 'notFound' | 'transferred' | 'unknown'
 */

import { native, sys } from 'cc';

// ---------------------------------------------------------------------------
// Native event names — mirror AppleAuthBridgeGlue.mm's schema.
// ---------------------------------------------------------------------------

const EV = {
    signIn:        'siwa.signIn',
    signInResult:  'siwa.signInResult',
    getState:      'siwa.getState',
    stateResult:   'siwa.stateResult',
} as const;

export interface AppleCredential {
    identityToken:     string;
    authorizationCode: string;
    appleSub:          string;
}

export type AppleErrorKind =
    | 'user-cancelled'
    | 'not-handled'
    | 'failed'
    | 'platform-unsupported'
    | 'unknown';

export type AppleCredentialState =
    | 'authorized'
    | 'revoked'
    | 'notFound'
    | 'transferred'
    | 'unknown';

// ---------------------------------------------------------------------------
// Per-event-kind slot for request/response correlation. Same pattern as
// StoreKitProvider. SIWA UI is modal so one at a time is fine.
// ---------------------------------------------------------------------------

class Slot<T> {
    private pending: {
        resolve: (v: T) => void;
        reject:  (e: Error) => void;
        timer:   number;
    } | null = null;

    constructor(private kind: string, private timeoutMs = 5 * 60_000) {}

    wait(): Promise<T> {
        if (this.pending) {
            return Promise.reject(new Error(`${this.kind}: another call in progress`));
        }
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending) {
                    this.pending = null;
                    reject(new Error(`${this.kind}: timeout after ${this.timeoutMs}ms`));
                }
            }, this.timeoutMs) as unknown as number;
            this.pending = { resolve, reject, timer };
        });
    }

    deliver(rawJson: string): void {
        const p = this.pending;
        if (!p) return;
        this.pending = null;
        clearTimeout(p.timer);
        try {
            p.resolve(JSON.parse(rawJson) as T);
        } catch (e) {
            p.reject(new Error(`${this.kind}: invalid JSON from native: ${(e as Error).message}`));
        }
    }
}

// ---------------------------------------------------------------------------
// Response shapes from Swift.
// ---------------------------------------------------------------------------

interface NativeSignInSuccess {
    success:            true;
    identityToken:      string;
    authorizationCode:  string;
    appleSub:           string;
}

interface NativeSignInError {
    success:  false;
    kind:     AppleErrorKind;
    error:    string;
}

type NativeSignInResult = NativeSignInSuccess | NativeSignInError;

interface NativeStateResult {
    state: AppleCredentialState;
}

// ---------------------------------------------------------------------------
// Router — folded into the existing native.bridge.onNative fan-out used
// by StoreKitProvider. Registered once on first use.
// ---------------------------------------------------------------------------

class AppleAuthImpl {
    private readonly signInSlot = new Slot<NativeSignInResult>(EV.signIn);
    private readonly stateSlot  = new Slot<NativeStateResult>(EV.getState, 10_000);

    private routerInstalled = false;

    private ensureRouter(): void {
        if (this.routerInstalled) return;
        const prev = native.bridge.onNative;
        native.bridge.onNative = (event: string, arg: string | null) => {
            const payload = arg ?? '';
            switch (event) {
                case EV.signInResult: this.signInSlot.deliver(payload); return;
                case EV.stateResult:  this.stateSlot.deliver(payload);  return;
                default:
                    prev?.(event, arg);
            }
        };
        this.routerInstalled = true;
    }

    async signIn(): Promise<AppleCredential> {
        if (sys.os !== sys.OS.IOS) {
            throw new Error('platform-unsupported: Sign in with Apple is iOS-only');
        }
        this.ensureRouter();
        const wait = this.signInSlot.wait();
        native.bridge.sendToNative(EV.signIn, '');
        const result = await wait;
        if (!result.success) {
            throw new Error(`${result.kind}: ${result.error}`);
        }
        return {
            identityToken:     result.identityToken,
            authorizationCode: result.authorizationCode,
            appleSub:          result.appleSub,
        };
    }

    async getCredentialState(appleSub: string): Promise<AppleCredentialState> {
        if (sys.os !== sys.OS.IOS) {
            return 'unknown';
        }
        if (!appleSub || appleSub.length === 0) {
            return 'notFound';
        }
        this.ensureRouter();
        const wait = this.stateSlot.wait();
        native.bridge.sendToNative(EV.getState, appleSub);
        const result = await wait;
        return result.state;
    }
}

export const AppleAuth = new AppleAuthImpl();
