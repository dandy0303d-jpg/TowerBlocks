/**
 * GoogleAuthApi — HTTP calls for Google Sign-In binding + login.
 * Mirrors AppleAuthApi's shape one-for-one.
 *
 *   POST /player/link/google    — bind current guest uuid to Google
 *                                  (requires current bearer token)
 *   POST /player/login/google   — recover previously-linked uuid on
 *                                  a fresh install (no bearer required)
 */

import { httpPostJson } from '../../core/Http';
import { BACKEND_BASE_URL } from '../../core/BackendConfig';

export interface LinkGoogleResult {
    linked:        boolean;
    /** true if the (uuid, googleSub) pair already existed — idempotent replay. */
    alreadyLinked: boolean;
}

/** Bind the current player's uuid to the given Google identity.
 *  Requires bearer token. `idToken` is the JWT the client obtained via
 *  authorization_code + PKCE + Google token exchange; the server
 *  verifies its signature against Google's JWKS. Replay-safe by
 *  construction — Google's token endpoint enforces one-time use of
 *  the code+verifier pair, so a captured id_token can't be re-minted. */
export async function linkGoogleAccount(idToken: string): Promise<LinkGoogleResult> {
    const url = `${BACKEND_BASE_URL}/player/link/google`;
    return httpPostJson<LinkGoogleResult>(url, { idToken });
}

export interface LoginGoogleResult {
    uuid:   string;
    bearer: string;
}

/** Recover a previously-linked uuid via a fresh Google sign-in.
 *  No bearer required — "reinstalled, want my progress back" flow.
 *  Server verifies id_token, looks up google_sub → uuid, mints a
 *  fresh bearer. */
export async function loginWithGoogle(idToken: string): Promise<LoginGoogleResult> {
    const url = `${BACKEND_BASE_URL}/player/login/google`;
    return httpPostJson<LoginGoogleResult>(url, { idToken });
}
