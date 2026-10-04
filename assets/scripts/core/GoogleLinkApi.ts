/**
 * GoogleLinkApi — HTTP client for the two server endpoints that link
 * a player uuid to a Google account.
 *
 * Contract (see server: tetritower-server-google-signin-v2):
 *   POST /player/link/google
 *     Auth: bearer of the CURRENT guest account
 *     Body: { id_token }
 *     Response: { linked: true }              — Google now bound to this uuid
 *                { linked: false,
 *                  alreadyLinked: true,
 *                  linkedUuid: '<other-uuid>' } — This Google already owns
 *                                               another uuid; caller should
 *                                               offer to recover it via login.
 *
 *   POST /player/login/google
 *     Auth: none (server issues a fresh bearer)
 *     Body: { id_token }
 *     Response: { uuid, bearer, expEpochSec } — recovered uuid + fresh token
 *              404                             — no player linked to this Google
 *
 * The token exchange happens on-device (GoogleWebOAuth.signIn returns
 * the id_token directly), so this module only speaks to our own
 * server, never to Google's.
 */

import { BACKEND_BASE_URL, BACKEND_TIMEOUT_MS } from './BackendConfig';
import { httpPostJson } from './Http';

export interface GoogleLinkResult {
    linked:        boolean;
    /** Server sets true when this Google account already owns a
     *  DIFFERENT uuid. Client should surface the "recover linked
     *  account?" confirmation and, on user assent, call
     *  loginWithGoogle() with the same id_token to swap identity. */
    alreadyLinked?: boolean;
    /** UUID (of the OTHER account) that currently owns this Google
     *  account — only set when `alreadyLinked` is true. Useful for
     *  the confirmation dialog if you want to show a hint. */
    linkedUuid?:    string;
    /** When present (currently only on the google-games 409 response),
     *  the server has pre-minted a recovery session for the OTHER uuid
     *  this Google account owns. The caller just proved it holds this
     *  Google (the server did the token exchange), so handing out the
     *  recovery bearer in the same response saves an extra sign-in round-
     *  trip (`authCode` is one-shot — recovering via loginWithGoogleGames
     *  afterwards would need a fresh code from Play Games).
     *
     *  Callers that have a "no local progress" early-exit (fresh install
     *  / PlayGamesAutoBind) should use this to silently swap identity;
     *  callers with existing progress should prompt before applying
     *  (`PlayerProfile.swapToRecoveredAccount(recovery.uuid, recovery.bearer,
     *  recovery.expEpochSec, 'google')`). */
    recovery?: GoogleLoginResult;
}

export interface GoogleLoginResult {
    uuid:        string;
    bearer:      string;
    expEpochSec: number;
}

/** Bind the caller's CURRENT guest uuid to a Google account. Requires
 *  a valid bearer for the guest (Http module reads the bearer from
 *  its module-level store — see setBearerToken).
 *
 *  On success: { linked: true } — future logins from this device that
 *  supply the same Google id_token will recover this uuid.
 *
 *  On conflict: { linked: false, alreadyLinked: true, linkedUuid: '...' }
 *  — the caller should ask the player if they want to switch to that
 *  linked account (calls loginWithGoogle), which abandons the current
 *  guest. */
export async function linkGoogleToCurrentAccount(idToken: string): Promise<GoogleLinkResult> {
    const url = `${BACKEND_BASE_URL}/player/link/google`;
    console.log(`[GoogleLink] linking current account — id_token length=${idToken.length}`);
    try {
        return await httpPostJson<GoogleLinkResult>(url, { idToken: idToken }, BACKEND_TIMEOUT_MS);
    } catch (err: any) {
        // Server returns 409 { "error": "google already linked" } when
        // this Google account is already bound to a DIFFERENT uuid —
        // this is a RECOVERABLE conflict, not a hard failure. The
        // original doc-comment contract above says 200 + { linked:
        // false, alreadyLinked: true } but the current server rejects
        // the whole request with a 409 instead. Reshape here so
        // MenuController's `link.alreadyLinked` branch (which opens the
        // recovery-confirm modal → loginWithGoogle) still runs.
        //
        // ONLY reshape the "google already linked" variant. The server
        // also returns 409 'uuid already linked' when the CURRENT uuid
        // is already bound to a DIFFERENT Google — recovery wouldn't
        // help (loginWithGoogle would succeed into the OTHER Google
        // account, losing the current progress silently), so we let that
        // one throw up to the handler's catch which surfaces an error
        // toast. Previously a loose /already[\s_-]?linked/ regex caught
        // both, which was wrong.
        //
        // Server doesn't include the other uuid in its 409 payload, so
        // linkedUuid stays undefined — the recovery dialog copy doesn't
        // rely on it, and loginWithGoogle will resolve to the correct
        // uuid on its own.
        const msg = String(err?.message ?? err);
        if (msg.startsWith('HTTP 409') && /google already linked/i.test(msg)) {
            return { linked: false, alreadyLinked: true };
        }
        throw err;
    }
}

/** Recover an account previously linked to this Google. Returns the
 *  server-issued bearer for the recovered uuid. Caller is expected
 *  to persist the returned uuid + bearer (via PlayerProfile.swap*)
 *  BEFORE making any further authenticated call, otherwise those
 *  calls will use the outgoing guest's bearer. */
export async function loginWithGoogle(idToken: string): Promise<GoogleLoginResult> {
    const url = `${BACKEND_BASE_URL}/player/login/google`;
    console.log(`[GoogleLink] recovery login — id_token length=${idToken.length}`);
    // sign=false because the /login endpoint is unsigned — the caller
    // may not have a valid bearer yet (that's the whole point of login).
    return httpPostJson<GoogleLoginResult>(url, { idToken: idToken }, BACKEND_TIMEOUT_MS, /*sign=*/false);
}

// =========================================================================
// Play Games Services v2 variants
// =========================================================================
// Play Games v2 returns an auth-code (not an id_token) that MUST be
// exchanged on the server for an id_token/access_token using the OAuth
// Web client's secret. The server endpoint handles the Google token
// exchange and then applies the same linking / recovery logic as the
// web OAuth path.
//
// Expected server contract (tetritower-server-google-signin-v2 or newer):
//   POST /player/link/google-games
//     Auth: bearer of the CURRENT guest account
//     Body: { authCode: string }
//     Response: { linked: true }                         — bound ✓
//                { linked: false, alreadyLinked: true,
//                  linkedUuid?: '<other-uuid>' }         — conflict (same as web)
//   POST /player/login/google-games
//     Auth: none
//     Body: { authCode: string }
//     Response: { uuid, bearer, expEpochSec }            — recovered uuid
//                404                                     — no player linked
//
// If the server doesn't implement these endpoints yet, the HTTP calls
// 404 and PlayGamesAutoBind marks tried=true (silent fallback to guest).

export async function linkGoogleGamesToCurrentAccount(authCode: string): Promise<GoogleLinkResult> {
    const url = `${BACKEND_BASE_URL}/player/link/google-games`;
    console.log(`[GoogleLink] linking via Play Games authCode (${authCode.length} chars)`);
    try {
        return await httpPostJson<GoogleLinkResult>(url, { authCode }, BACKEND_TIMEOUT_MS);
    } catch (err: any) {
        // Server shape (per INBOX_CLIENT.md 2026-10-04 message from
        // claude-5d):
        //   409 { error: "google already linked",
        //         linkedUuid: "...",
        //         recovery: { uuid, bearer, expEpochSec } }
        //   409 { error: "uuid already linked" }   — this uuid is bound
        //                                            to ANOTHER Google;
        //                                            recovery can't help
        //
        // httpPostJson throws `Error('HTTP 409: <body>')` so we parse the
        // body back out of err.message. Only reshape 'google already linked'
        // (recoverable via the attached recovery session, or via a fresh
        // loginWithGoogleGames round-trip); let 'uuid already linked' fall
        // through to the handler's catch so it surfaces an error toast
        // rather than silently swapping the player into the OTHER Google-
        // Games account they just signed into. Attach `recovery` + `linkedUuid`
        // when the server includes them so callers can silently swap
        // (fresh install / no progress case) without burning a second
        // Play Games authCode.
        const msg = String(err?.message ?? err);
        if (msg.startsWith('HTTP 409')) {
            const parsed = _tryParse409Body(msg);
            if (parsed && /google already linked/i.test(parsed.error ?? '')) {
                const out: GoogleLinkResult = { linked: false, alreadyLinked: true };
                if (typeof parsed.linkedUuid === 'string') out.linkedUuid = parsed.linkedUuid;
                if (parsed.recovery
                    && typeof parsed.recovery.uuid === 'string'
                    && typeof parsed.recovery.bearer === 'string'
                    && typeof parsed.recovery.expEpochSec === 'number') {
                    out.recovery = {
                        uuid:        parsed.recovery.uuid,
                        bearer:      parsed.recovery.bearer,
                        expEpochSec: parsed.recovery.expEpochSec,
                    };
                }
                return out;
            }
            // Non-JSON body / unknown error / 'uuid already linked' falls
            // through to the generic throw so the handler shows an error.
        }
        throw err;
    }
}

/** Extract the JSON body from Http.ts's `HTTP <status>: <body>` error
 *  message so we can inspect fields like `error`, `linkedUuid`, `recovery`.
 *  Returns null if the body isn't JSON (shouldn't happen with the
 *  current server but keep the parse defensive). */
function _tryParse409Body(msg: string): any | null {
    const colonIdx = msg.indexOf(': ');
    if (colonIdx < 0) return null;
    const body = msg.slice(colonIdx + 2);
    try { return JSON.parse(body); }
    catch { return null; }
}

export async function loginWithGoogleGames(authCode: string): Promise<GoogleLoginResult> {
    const url = `${BACKEND_BASE_URL}/player/login/google-games`;
    console.log(`[GoogleLink] recovery login via Play Games authCode (${authCode.length} chars)`);
    return httpPostJson<GoogleLoginResult>(url, { authCode }, BACKEND_TIMEOUT_MS, /*sign=*/false);
}
