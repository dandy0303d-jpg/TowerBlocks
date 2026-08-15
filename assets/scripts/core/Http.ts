/**
 * Http — thin XMLHttpRequest wrapper for the game's REST calls.
 *
 * Why XHR instead of fetch()?
 *   Cocos Creator 3.x on Android bundles a `fetch` polyfill, but it
 *   has edge cases with `AbortController` and body streams that make
 *   it flaky on real devices — panels open empty because the fetch
 *   silently fails or hangs past our client-side timeout. XHR is
 *   plumbed straight through Cocos's JSB layer into Android's stock
 *   HTTP stack; it's rock-solid and supports request timeouts natively.
 *
 * Anti-cheat additions:
 *   - `getBearerToken` / `setBearerToken`: module-level bearer token
 *     store. PlayerProfile sets this after register / refresh. Every
 *     httpXxx call injects `Authorization: Bearer <token>` when set.
 *   - `signRequest`: adds X-Signature + X-Signature-Ts headers,
 *     HMAC-SHA256(clientSecret, METHOD|PATH|BODY|TS). The server
 *     verifies these to defeat MITM tampering + replay.
 *
 * All helpers return Promises resolved with parsed JSON, or reject
 * with a descriptive Error. Callers should `.catch()` and either
 * surface the message in the UI or fall back gracefully.
 */

// ---- Bearer token store ----
let bearerToken: string | null = null;
export function setBearerToken(t: string | null): void { bearerToken = t; }
export function getBearerToken(): string | null { return bearerToken; }

// ---- Client HMAC key ----
// KEEP IN SYNC with the server's `CLIENT_SECRET` env var. This is
// intentionally embedded in the client — rotating it means shipping
// a new build. Real anti-tamper would obfuscate this key inside
// native code; embedded here as plain text is Tier-2 (raise the bar,
// not impregnable).
const CLIENT_SECRET = 'dev-only-client-key';

/** Sync SHA-256 HMAC-hex, no dependencies. Ported from RFC 2104 —
 *  cheap enough for the ~few-per-second calls we make. */
function hmacSha256Hex(key: string, msg: string): string {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const CryptoJS = getCryptoJS();
    if (CryptoJS) {
        return CryptoJS.HmacSHA256(msg, key).toString();
    }
    // Fallback pure-JS implementation.
    return pureHmacSha256Hex(key, msg);
}

function getCryptoJS(): any | null {
    // Optional — if crypto-js is bundled we prefer it (faster).
    try { return (globalThis as any).CryptoJS || null; } catch { return null; }
}

// ---- Pure-JS SHA-256 + HMAC (fallback when CryptoJS isn't around) ----
// Minimal, allocation-friendly implementation. Not constant-time —
// fine for signing, we never verify with this on the client.
function pureHmacSha256Hex(key: string, msg: string): string {
    const blockSize = 64;
    let keyBytes = utf8ToBytes(key);
    if (keyBytes.length > blockSize) keyBytes = sha256(keyBytes);
    if (keyBytes.length < blockSize) {
        const padded = new Uint8Array(blockSize);
        padded.set(keyBytes);
        keyBytes = padded;
    }
    const oKey = new Uint8Array(blockSize);
    const iKey = new Uint8Array(blockSize);
    for (let i = 0; i < blockSize; i++) {
        oKey[i] = keyBytes[i] ^ 0x5c;
        iKey[i] = keyBytes[i] ^ 0x36;
    }
    const inner = sha256(concat(iKey, utf8ToBytes(msg)));
    const outer = sha256(concat(oKey, inner));
    return bytesToHex(outer);
}
function utf8ToBytes(s: string): Uint8Array {
    const out: number[] = [];
    for (let i = 0; i < s.length; i++) {
        let c = s.charCodeAt(i);
        if (c < 0x80) out.push(c);
        else if (c < 0x800) { out.push(0xc0 | (c >> 6)); out.push(0x80 | (c & 0x3f)); }
        else if (c < 0xd800 || c >= 0xe000) {
            out.push(0xe0 | (c >> 12)); out.push(0x80 | ((c >> 6) & 0x3f)); out.push(0x80 | (c & 0x3f));
        } else {
            i++;
            const cp = 0x10000 + (((c & 0x3ff) << 10) | (s.charCodeAt(i) & 0x3ff));
            out.push(0xf0 | (cp >> 18));
            out.push(0x80 | ((cp >> 12) & 0x3f));
            out.push(0x80 | ((cp >> 6) & 0x3f));
            out.push(0x80 | (cp & 0x3f));
        }
    }
    return new Uint8Array(out);
}
function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
    const out = new Uint8Array(a.length + b.length);
    out.set(a); out.set(b, a.length); return out;
}
function bytesToHex(b: Uint8Array): string {
    let s = '';
    for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, '0');
    return s;
}
function sha256(bytes: Uint8Array): Uint8Array {
    // Standard SHA-256; constants from FIPS 180-4.
    const K = new Uint32Array([
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2,
    ]);
    // Pad
    const l = bytes.length;
    const withOne = new Uint8Array(l + 1);
    withOne.set(bytes); withOne[l] = 0x80;
    const padLen = (56 - (withOne.length % 64) + 64) % 64;
    const total = withOne.length + padLen + 8;
    const buf = new Uint8Array(total);
    buf.set(withOne);
    const bitLen = l * 8;
    // 64-bit big-endian length. JavaScript's bitwise ops are
    // 32-bit and shift amount is masked to 5 bits, so `x >>> 32`
    // returns `x` (not 0) — writing bitLen at i>=4 would corrupt
    // the high 4 bytes. For any message under ~500 MB the length
    // fits in 32 bits, so the high 4 bytes are always zero.
    for (let i = 0; i < 8; i++) {
        buf[total - 1 - i] = i < 4 ? (bitLen >>> (i * 8)) & 0xff : 0;
    }
    let h0 = 0x6a09e667, h1 = 0xbb67ae85, h2 = 0x3c6ef372, h3 = 0xa54ff53a,
        h4 = 0x510e527f, h5 = 0x9b05688c, h6 = 0x1f83d9ab, h7 = 0x5be0cd19;
    const w = new Uint32Array(64);
    for (let chunk = 0; chunk < total; chunk += 64) {
        for (let i = 0; i < 16; i++) {
            const j = chunk + i * 4;
            w[i] = (buf[j] << 24) | (buf[j + 1] << 16) | (buf[j + 2] << 8) | buf[j + 3];
        }
        for (let i = 16; i < 64; i++) {
            const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let a = h0, b = h1, c = h2, d = h3, e = h4, f = h5, g = h6, hh = h7;
        for (let i = 0; i < 64; i++) {
            const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
            const ch = (e & f) ^ (~e & g);
            const temp1 = (hh + S1 + ch + K[i] + w[i]) | 0;
            const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const temp2 = (S0 + maj) | 0;
            hh = g; g = f; f = e; e = (d + temp1) | 0;
            d = c; c = b; b = a; a = (temp1 + temp2) | 0;
        }
        h0 = (h0 + a) | 0; h1 = (h1 + b) | 0; h2 = (h2 + c) | 0; h3 = (h3 + d) | 0;
        h4 = (h4 + e) | 0; h5 = (h5 + f) | 0; h6 = (h6 + g) | 0; h7 = (h7 + hh) | 0;
    }
    const out = new Uint8Array(32);
    const hs = [h0, h1, h2, h3, h4, h5, h6, h7];
    for (let i = 0; i < 8; i++) {
        out[i * 4]     = (hs[i] >>> 24) & 0xff;
        out[i * 4 + 1] = (hs[i] >>> 16) & 0xff;
        out[i * 4 + 2] = (hs[i] >>>  8) & 0xff;
        out[i * 4 + 3] =  hs[i]         & 0xff;
    }
    return out;
}
function rotr(n: number, k: number): number { return (n >>> k) | (n << (32 - k)); }

/** Extract path (no query) from a full URL. */
function pathOf(url: string): string {
    const idx = url.indexOf('://');
    const afterScheme = idx < 0 ? url : url.slice(idx + 3);
    const slash = afterScheme.indexOf('/');
    const pathAndQuery = slash < 0 ? '/' : afterScheme.slice(slash);
    const q = pathAndQuery.indexOf('?');
    return q < 0 ? pathAndQuery : pathAndQuery.slice(0, q);
}

/** Common JSON POST/GET/PUT wrapper. Not exported; use httpGetJson /
 *  httpPostJson / httpPutJson from callers.
 *
 *  Auth + signature headers:
 *   - `Authorization: Bearer <token>` on every request when the module
 *     has a bearer token (all except /player/register + public GETs).
 *   - `X-Signature` + `X-Signature-Ts` on every mutating request
 *     (`sign=true`), HMAC-SHA256 over METHOD|PATH|BODY|TS. */
function xhrJson<T>(
    method: 'GET' | 'POST' | 'PUT' | 'DELETE',
    url: string,
    body: string | null,
    timeoutMs: number,
    sign: boolean = false,
): Promise<T> {
    const startedAt = Date.now();
    const tag = `[Http] ${method} ${pathOf(url)}`;
    const hasAuth = !!bearerToken;
    console.log(`${tag} → sending (auth=${hasAuth ? 'yes' : 'NO'}, sign=${sign ? 'yes' : 'no'}, body=${body ? body.length + 'B' : '0B'})`);
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest();
        xhr.timeout = timeoutMs;
        xhr.open(method, url, true);
        xhr.setRequestHeader('Content-Type', 'application/json');
        if (bearerToken) {
            xhr.setRequestHeader('Authorization', `Bearer ${bearerToken}`);
        }
        if (sign) {
            const ts = Math.floor(Date.now() / 1000).toString();
            const canonical = `${method}|${pathOf(url)}|${body ?? ''}|${ts}`;
            const sig = hmacSha256Hex(CLIENT_SECRET, canonical);
            xhr.setRequestHeader('X-Signature-Ts', ts);
            xhr.setRequestHeader('X-Signature', sig);
        }
        xhr.onload = () => {
            const status = xhr.status;
            const text   = xhr.responseText;
            const ms = Date.now() - startedAt;
            if (status >= 200 && status < 300) {
                console.log(`${tag} ← ${status} OK (${ms}ms) ${text.slice(0, 200)}`);
                // 204 No Content (and any other empty body) — resolve with
                // null cast to T so DELETE-style endpoints don't crash on
                // JSON.parse('').
                if (!text || text.length === 0) {
                    resolve(null as unknown as T);
                    return;
                }
                try {
                    resolve(JSON.parse(text) as T);
                } catch (e) {
                    reject(new Error(`Invalid JSON response: ${text}`));
                }
                return;
            }
            console.warn(`${tag} ← ${status} FAIL (${ms}ms) ${text.slice(0, 200)}`);
            reject(new Error(`HTTP ${status}: ${text}`));
        };
        xhr.onerror = () => {
            // xhr.status is 0 here — Android's HTTP stack couldn't
            // even connect (DNS, refused, network offline, cert error).
            const ms = Date.now() - startedAt;
            console.warn(`${tag} ← network error (${ms}ms)`);
            reject(new Error('Network error (no response)'));
        };
        xhr.ontimeout = () => {
            const ms = Date.now() - startedAt;
            console.warn(`${tag} ← timeout after ${ms}ms (limit ${timeoutMs}ms)`);
            reject(new Error(`Request timeout after ${timeoutMs}ms`));
        };
        xhr.send(body);
    });
}

/** GET a URL and parse JSON. Rejects on non-2xx / network error /
 *  timeout. */
export function httpGetJson<T>(url: string, timeoutMs = 8000): Promise<T> {
    return xhrJson<T>('GET', url, null, timeoutMs);
}

/** POST a JSON body and parse the response. `body` is object-in
 *  string-out (auto-JSON.stringify) for ergonomics. Signed by default
 *  so mutating endpoints get their X-Signature guard. Pass sign=false
 *  for register (there's no token yet). */
export function httpPostJson<T>(
    url: string,
    body: object,
    timeoutMs = 8000,
    sign: boolean = true,
): Promise<T> {
    return xhrJson<T>('POST', url, JSON.stringify(body), timeoutMs, sign);
}

/** PUT a JSON body and parse the response. Always signed. */
export function httpPutJson<T>(
    url: string,
    body: object,
    timeoutMs = 8000,
): Promise<T> {
    return xhrJson<T>('PUT', url, JSON.stringify(body), timeoutMs, true);
}

/** DELETE a URL. Always signed (destructive operation). Response is
 *  usually 204 No Content — the returned Promise resolves with null
 *  in that case. T defaults to `void` for the common empty-response
 *  case; pass an explicit type if the endpoint returns a body. */
export function httpDelete<T = void>(
    url: string,
    timeoutMs = 8000,
): Promise<T> {
    return xhrJson<T>('DELETE', url, null, timeoutMs, true);
}
