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
        // Server doesn't include the other uuid in its 409 payload, so
        // linkedUuid stays undefined — the recovery dialog copy doesn't
        // rely on it, and loginWithGoogle will resolve to the correct
        // uuid on its own.
        const msg = String(err?.message ?? err);
        if (msg.startsWith('HTTP 409') && /already[\s_-]?linked/i.test(msg)) {
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
