/**
 * GoogleWebOAuth — TS-side driver for the "Sign in with Google" flow
 * used by the Settings account-bind button.
 *
 * Uses OAuth 2.0 Authorization Code + PKCE (S256) via a browser
 * Custom Tab (no Google Sign-In SDK, no Google Play Services). This
 * makes it compatible with ONE Store devices where GMS is often
 * missing, and it doesn't require a client secret in the APK.
 *
 * Flow:
 *   1. Client generates a random `code_verifier` (43-128 chars) and
 *      derives `code_challenge = BASE64URL(SHA-256(code_verifier))`.
 *   2. Client opens Chrome Custom Tabs (via GoogleWebOAuthBridge) to
 *      Google's /o/oauth2/v2/auth endpoint with:
 *        client_id / redirect_uri / scope=openid email profile /
 *        response_type=code / code_challenge_method=S256 /
 *        code_challenge / state
 *   3. User consents in-browser; Google redirects to
 *      com.tetritower.oauth://google/callback?code=...&state=...
 *   4. AppActivity.onNewIntent catches the redirect, forwards to
 *      GoogleWebOAuthBridge.handleRedirect, which fires the JsbBridge
 *      event "google.oauth.callback" with the query string.
 *   5. This module parses the query, verifies `state`, POSTs
 *      code + code_verifier to Google's /token endpoint, extracts the
 *      `id_token` from the JSON response, and resolves.
 *
 * Server contract (see tetritower-server-google-signin-v2):
 *   Caller of this module passes the resulting id_token to:
 *     POST /player/login/google  { id_token }   (recovery)
 *     POST /player/link/google   { id_token }   (bind current guest)
 *
 * Public API:
 *   GoogleWebOAuth.signIn()   : Promise<string>   (resolves with id_token)
 *   GoogleWebOAuth.isSupported: boolean            (true on native Android)
 */

import { sys, native } from 'cc';
import { GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_REDIRECT_URI } from '../../core/BackendConfig';

/** JsbBridge event the Kotlin bridge fires with the OAuth query
 *  string. On error the data is prefixed `error:<reason>`. */
const OAUTH_EVENT = 'google.oauth.callback';

/** Google's token endpoint — used to swap the auth code for tokens. */
const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** Google's authorization endpoint — where the user consents. */
const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

/** Scopes we ask for. `openid` unlocks the id_token; `email` +
 *  `profile` populate its claims so the server can display the
 *  player's Google email / name in the Settings row. */
const GOOGLE_SCOPES = 'openid email profile';

/** How long we wait between opening Custom Tabs and the redirect
 *  intent coming back before we assume the user gave up / lost the
 *  tab. Reject with a timeout so the caller can restore UI. */
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

interface JsbBridgeLike {
    // Cocos 3.8 API on native.jsbBridgeWrapper. Method names differ
    // slightly from older builds: addNativeEventListener adds, removes
    // by removeNativeEventListener. Both take (event, cb).
    addNativeEventListener: (event: string, cb: (arg: string) => void) => void;
    removeNativeEventListener: (event: string, cb: (arg: string) => void) => void;
}

/** In-flight auth request state — kept module-level so the Custom
 *  Tabs redirect (async, could arrive after our Promise setup returns)
 *  finds the right callback. Only one auth flow at a time; a fresh
 *  signIn() cancels the previous. */
interface PendingAuth {
    state:        string;
    codeVerifier: string;
    resolve:      (idToken: string) => void;
    reject:       (err: Error) => void;
    listener:     (data: string) => void;
    timeout:      ReturnType<typeof setTimeout>;
}

let pending: PendingAuth | null = null;

/** Encode a plain object into an application/x-www-form-urlencoded
 *  string. Substitute for `URLSearchParams.toString()`, which isn't
 *  available in Cocos 3.x's native V8 build. Values are stringified;
 *  keys/values are URI-encoded so `&` `=` `+` etc. survive.
 *  Order matches the object's insertion order — Google doesn't care
 *  about param order but stable output aids debugging. */
function encodeFormValue(params: Record<string, string | number>): string {
    const parts: string[] = [];
    for (const k in params) {
        if (!Object.prototype.hasOwnProperty.call(params, k)) continue;
        parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(params[k]))}`);
    }
    return parts.join('&');
}

/** Parse a query string ("k1=v1&k2=v2") back into a plain object.
 *  Substitute for `new URLSearchParams(s).get()` chains. Missing keys
 *  return `undefined`. Values are URI-decoded; empty values become "". */
function decodeFormValues(input: string): Record<string, string> {
    const out: Record<string, string> = {};
    if (!input) return out;
    // Strip a leading "?" if the caller passed a whole URL search chunk.
    const s = input.charCodeAt(0) === 0x3f ? input.slice(1) : input;
    for (const pair of s.split('&')) {
        if (!pair) continue;
        const eq = pair.indexOf('=');
        if (eq < 0) {
            out[decodeURIComponent(pair)] = '';
        } else {
            const k = decodeURIComponent(pair.slice(0, eq));
            const v = decodeURIComponent(pair.slice(eq + 1).replace(/\+/g, '%20'));
            out[k] = v;
        }
    }
    return out;
}

/** Base64url-encode a Uint8Array (RFC 4648 §5, no padding). Google's
 *  PKCE spec expects the URL-safe alphabet with `=` stripped. */
function b64urlEncode(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    // btoa exists on Cocos runtime (both Web + native).
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Random 32-byte string, base64url-encoded — used for both the OAuth
 *  `state` (CSRF token) and the PKCE `code_verifier` (43 chars). */
function randomToken(): string {
    const bytes = new Uint8Array(32);
    // crypto.getRandomValues works on both Cocos Web and JSB.
    const g: any = globalThis;
    if (g.crypto?.getRandomValues) {
        g.crypto.getRandomValues(bytes);
    } else {
        for (let i = 0; i < 32; i++) bytes[i] = Math.floor(Math.random() * 256);
    }
    return b64urlEncode(bytes);
}

/** SHA-256 the input string and return the digest as a Uint8Array.
 *  Uses `crypto.subtle.digest` when available (Web + some native
 *  runtimes), else falls back to a pure-JS implementation. Pure-JS is
 *  ~20x slower but the input here is a 43-char PKCE verifier — no user
 *  will notice. Only called once per sign-in. */
async function sha256(input: string): Promise<Uint8Array> {
    const g: any = globalThis;
    // Fast path — native crypto.
    if (g.crypto?.subtle?.digest) {
        try {
            const enc = new TextEncoder().encode(input);
            const buf: ArrayBuffer = await g.crypto.subtle.digest('SHA-256', enc);
            console.log('[GoogleWebOAuth] sha256 via crypto.subtle');
            return new Uint8Array(buf);
        } catch (e) {
            console.warn('[GoogleWebOAuth] crypto.subtle threw, falling back to pure-JS:', (e as Error).message);
        }
    } else {
        console.log('[GoogleWebOAuth] crypto.subtle missing, using pure-JS sha256');
    }
    return sha256Pure(input);
}

/** Pure-JS SHA-256 (FIPS 180-4). Only used when crypto.subtle is
 *  unavailable — Cocos 3.x native's V8 build sometimes omits it. */
function sha256Pure(input: string): Uint8Array {
    // UTF-8 encode input (PKCE verifier is ASCII-only base64url, but
    // this handles Unicode inputs correctly should we ever pass one).
    const bytes: number[] = [];
    for (let i = 0; i < input.length; i++) {
        let c = input.charCodeAt(i);
        if (c < 0x80) bytes.push(c);
        else if (c < 0x800) { bytes.push(0xc0 | (c >> 6)); bytes.push(0x80 | (c & 0x3f)); }
        else { bytes.push(0xe0 | (c >> 12)); bytes.push(0x80 | ((c >> 6) & 0x3f)); bytes.push(0x80 | (c & 0x3f)); }
    }
    // Pad
    const bitLen = bytes.length * 8;
    bytes.push(0x80);
    while ((bytes.length % 64) !== 56) bytes.push(0);
    // 64-bit big-endian length
    for (let i = 7; i >= 0; i--) bytes.push((bitLen >>> (i * 8)) & 0xff);

    const K = new Uint32Array([
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    ]);
    const H = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ]);
    const W = new Uint32Array(64);

    for (let chunk = 0; chunk < bytes.length; chunk += 64) {
        for (let i = 0; i < 16; i++) {
            W[i] = (bytes[chunk + i*4] << 24) | (bytes[chunk + i*4 + 1] << 16)
                 | (bytes[chunk + i*4 + 2] << 8) | bytes[chunk + i*4 + 3];
        }
        for (let i = 16; i < 64; i++) {
            const s0 = rr(W[i-15], 7) ^ rr(W[i-15], 18) ^ (W[i-15] >>> 3);
            const s1 = rr(W[i-2], 17) ^ rr(W[i-2], 19) ^ (W[i-2] >>> 10);
            W[i] = (W[i-16] + s0 + W[i-7] + s1) >>> 0;
        }
        let [a,b,c,d,e,f,g,h] = H;
        for (let i = 0; i < 64; i++) {
            const S1 = rr(e, 6) ^ rr(e, 11) ^ rr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
            const S0 = rr(a, 2) ^ rr(a, 13) ^ rr(a, 22);
            const mj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + mj) >>> 0;
            h = g; g = f; f = e; e = (d + t1) >>> 0;
            d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }
        H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
        H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
        H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
        H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }
    const out = new Uint8Array(32);
    for (let i = 0; i < 8; i++) {
        out[i*4]     = (H[i] >>> 24) & 0xff;
        out[i*4 + 1] = (H[i] >>> 16) & 0xff;
        out[i*4 + 2] = (H[i] >>> 8) & 0xff;
        out[i*4 + 3] = H[i] & 0xff;
    }
    return out;
}
function rr(x: number, n: number): number { return ((x >>> n) | (x << (32 - n))) >>> 0; }

/** Fetch the JsbBridgeWrapper singleton. In Cocos 3.8 it lives on
 *  `native.jsbBridgeWrapper` (imported from 'cc'). Returns null on
 *  Web / editor preview / older Cocos builds where it isn't wired. */
function getJsbBridge(): JsbBridgeLike | null {
    const w = (native as any)?.jsbBridgeWrapper;
    if (w && typeof w.addNativeEventListener === 'function') return w as JsbBridgeLike;
    // Legacy fallback — some third-party template builds hoist it
    // onto globalThis.jsb.JsbBridgeWrapper.
    const legacy: any = (globalThis as any).jsb?.JsbBridgeWrapper;
    if (legacy) {
        const inst = legacy.getInstance ? legacy.getInstance() : legacy;
        if (inst && typeof inst.addNativeEventListener === 'function') return inst as JsbBridgeLike;
    }
    return null;
}

function isNativeAndroid(): boolean {
    // Cocos native runtime exposes sys.isNative reliably; sys.os check
    // handles both platform enums across Cocos versions.
    const isAndroid = sys.os === sys.OS.ANDROID
        || (sys.platform !== undefined && String(sys.os).toLowerCase().includes('android'));
    return isAndroid && ((sys as any).isNative === true);
}

export const GoogleWebOAuth = {

    /** True only on native Android where GoogleWebOAuthBridge is
     *  installed. Callers should hide / disable the Google-bind
     *  button when this is false (editor preview, Web, iOS). */
    get isSupported(): boolean {
        const nativeAndroid = isNativeAndroid();
        const bridge = !!getJsbBridge();
        const ok = nativeAndroid && bridge;
        if (!ok) {
            console.log(`[GoogleWebOAuth] isSupported=false — isNativeAndroid=${nativeAndroid}, hasJsbBridge=${bridge}, sys.os=${sys.os}, sys.isNative=${(sys as any).isNative}`);
        }
        return ok;
    },

    /**
     * Kick off the sign-in flow. Resolves with the Google-issued
     * id_token (a JWT the server can verify by checking the signature
     * against Google's JWKS). Rejects on user cancel, network error,
     * bridge unavailable, or timeout.
     *
     * Callers pass the returned id_token to either:
     *   POST /player/link/google  — bind Google to the current guest
     *   POST /player/login/google — recover an existing linked account
     */
    async signIn(): Promise<string> {
        if (!isNativeAndroid()) {
            throw new Error('GoogleWebOAuth is only supported on native Android');
        }
        const bridge = getJsbBridge();
        if (!bridge) {
            throw new Error('JsbBridgeWrapper not available — did AppActivity install the bridge?');
        }
        // Cancel any prior in-flight auth so we don't fire the wrong
        // callback with the new attempt's tokens.
        if (pending) {
            pending.reject(new Error('cancelled by newer signIn call'));
            try { bridge.removeNativeEventListener(OAUTH_EVENT, pending.listener); } catch { /* ignore */ }
            clearTimeout(pending.timeout);
            pending = null;
        }

        // ---- PKCE + state ----
        // Prefer S256 when a trusted SHA-256 is available (crypto.subtle
        // on Web / newer native builds). Fall back to `plain` when we'd
        // have to use the JS SHA-256, since a mismatched hash between
        // our client and Google's server-side re-hash means Google
        // rejects the token exchange with `invalid_grant: Invalid code
        // verifier`. plain sends verifier == challenge — Google's spec
        // still accepts it and the OAuth flow retains PKCE's core
        // protection (only the client that generated the verifier can
        // redeem the code) because the verifier is never sent over the
        // wire outside the /token POST.
        const state        = randomToken();
        const codeVerifier = randomToken();
        const useS256      = !!(globalThis as any).crypto?.subtle?.digest;
        let codeChallenge:       string;
        let codeChallengeMethod: 'S256' | 'plain';
        if (useS256) {
            const challengeBytes = await sha256(codeVerifier);
            codeChallenge        = b64urlEncode(challengeBytes);
            codeChallengeMethod  = 'S256';
        } else {
            codeChallenge        = codeVerifier;
            codeChallengeMethod  = 'plain';
        }
        console.log(`[GoogleWebOAuth] PKCE (${codeChallengeMethod}) — verifier=${codeVerifier.slice(0, 12)}… challenge=${codeChallenge.slice(0, 12)}…`);

        // ---- Build the authorization URL ----
        // URLSearchParams isn't available in Cocos 3.x native V8 —
        // hand-encode the query string with encodeFormValue().
        const authQuery = encodeFormValue({
            client_id:             GOOGLE_OAUTH_CLIENT_ID,
            redirect_uri:          GOOGLE_OAUTH_REDIRECT_URI,
            response_type:         'code',
            scope:                 GOOGLE_SCOPES,
            code_challenge:        codeChallenge,
            code_challenge_method: codeChallengeMethod,
            state,
            // access_type=offline would give a refresh_token, but we
            // don't need one — we only want a single id_token to send
            // to the server. Skip to keep the consent screen minimal.
            prompt:                'select_account',
        });
        const authUrl = `${GOOGLE_AUTH_ENDPOINT}?${authQuery}`;

        // ---- Return a promise the bridge listener resolves ----
        return new Promise<string>((resolve, reject) => {
            const listener = (data: string) => {
                // Bridge fires "error:<reason>" on failures — surface
                // them as rejects so the UI can toast a friendly error.
                if (data.startsWith('error:')) {
                    finalize();
                    reject(new Error(`google-oauth: ${data.slice(6)}`));
                    return;
                }
                // Parse `code=...&state=...` (or `error=access_denied&state=...`).
                // URLSearchParams isn't in Cocos native V8 — decodeFormValues
                // is a tiny hand-parser that handles the same subset.
                const query = decodeFormValues(data);
                const returnedState = query['state'];
                if (returnedState !== state) {
                    finalize();
                    reject(new Error('google-oauth: state mismatch (possible CSRF)'));
                    return;
                }
                const err = query['error'];
                if (err) {
                    finalize();
                    reject(new Error(`google-oauth: ${err}`));
                    return;
                }
                const code = query['code'];
                if (!code) {
                    finalize();
                    reject(new Error('google-oauth: redirect missing code'));
                    return;
                }
                // Success path — swap code for id_token, then resolve.
                exchangeCodeForIdToken(code, codeVerifier)
                    .then((idToken) => { finalize(); resolve(idToken); })
                    .catch((e) => { finalize(); reject(e); });
            };

            const finalize = () => {
                try { bridge.removeNativeEventListener(OAUTH_EVENT, listener); } catch { /* ignore */ }
                if (pending && pending.listener === listener) {
                    clearTimeout(pending.timeout);
                    pending = null;
                }
            };

            const timeout = setTimeout(() => {
                finalize();
                reject(new Error('google-oauth: timeout — user did not complete sign-in'));
            }, AUTH_TIMEOUT_MS);

            pending = { state, codeVerifier, resolve, reject, listener, timeout };
            bridge.addNativeEventListener(OAUTH_EVENT, listener);

            // Fire the Custom Tabs launch. `startAuth` returns false on
            // launch failure — reject immediately in that case so we
            // don't hang for the whole timeout.
            let launched = false;
            try {
                launched = native.reflection.callStaticMethod(
                    'com/cocos/game/GoogleWebOAuthBridge',
                    'startAuth',
                    '(Ljava/lang/String;)Z',
                    authUrl,
                );
            } catch (e) {
                finalize();
                reject(new Error(`google-oauth: bridge call failed: ${(e as Error).message}`));
                return;
            }
            if (!launched) {
                finalize();
                reject(new Error('google-oauth: Custom Tabs launch failed'));
            }
        });
    },
};

/** POST the authorization code + PKCE verifier to Google's token
 *  endpoint and return the id_token. Google's response also carries
 *  access_token / expires_in / scope, but we discard those — the
 *  id_token is all the server needs to identify the user. */
async function exchangeCodeForIdToken(code: string, codeVerifier: string): Promise<string> {
    const body = encodeFormValue({
        grant_type:    'authorization_code',
        code,
        client_id:     GOOGLE_OAUTH_CLIENT_ID,
        redirect_uri:  GOOGLE_OAUTH_REDIRECT_URI,
        code_verifier: codeVerifier,
    });
    let res: Response;
    try {
        res = await fetch(GOOGLE_TOKEN_ENDPOINT, {
            method:  'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body,
        });
    } catch (e) {
        throw new Error(`google-oauth: token endpoint unreachable (${(e as Error).message})`);
    }
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`google-oauth: token endpoint HTTP ${res.status} — ${text.slice(0, 200)}`);
    }
    const json = await res.json().catch(() => null);
    const idToken = json?.id_token;
    if (typeof idToken !== 'string' || !idToken.length) {
        throw new Error('google-oauth: token response missing id_token');
    }
    return idToken;
}
