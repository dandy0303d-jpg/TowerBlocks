/**
 * AppleAuthApi — HTTP calls for the Sign in with Apple binding + login
 * endpoints. Thin wrapper around Http.ts.
 *
 *   POST /player/link/apple    — bind current guest uuid to an Apple ID
 *                                (requires current bearer token)
 *   POST /player/login/apple   — recover previously-linked uuid on a
 *                                fresh install (no bearer required)
 */

import { httpGetJson, httpPostJson } from '../../core/Http';
import { BACKEND_BASE_URL } from '../../core/BackendConfig';

/** Provider names the server understands. Kept as string-literal type so
 *  the client's Settings toggles can `.includes('apple')` safely. */
export type LinkedProvider = 'apple' | 'google' | 'email';

export interface LinkedAccountsResult {
    providers: LinkedProvider[];
}

/** GET /player/accounts — server-authoritative list of providers the
 *  current uuid is bound to. Requires bearer. Empty array = guest.
 *  Client uses this to reconcile stale localStorage state and to paint
 *  the Settings toggles. */
export async function fetchLinkedAccounts(): Promise<LinkedAccountsResult> {
    const url = `${BACKEND_BASE_URL}/player/accounts`;
    return httpGetJson<LinkedAccountsResult>(url);
}

export interface LinkAppleResult {
    linked:         boolean;
    /** true if the (uuid, appleSub) pair already existed — idempotent replay. */
    alreadyLinked:  boolean;
}

/** Bind the current player's uuid to the given Apple identity.
 *  Requires the current bearer token — caller must be authenticated
 *  as the guest uuid they want to attach.
 *
 *  `authorizationCode` is what the native SIWA sheet returns alongside
 *  the identityToken. Server exchanges it for a refresh_token which is
 *  needed to call Apple's /auth/revoke when the user later deletes
 *  their account (App Store review requires it). Missing it works but
 *  the account-delete will only wipe our DB — Apple-side authorization
 *  will stay until it naturally expires. */
export async function linkAppleAccount(
    identityToken: string,
    appleSub: string,
    authorizationCode: string,
): Promise<LinkAppleResult> {
    const url = `${BACKEND_BASE_URL}/player/link/apple`;
    return httpPostJson<LinkAppleResult>(url, { identityToken, appleSub, authorizationCode });
}

export interface LoginAppleResult {
    /** The uuid the player owned before losing the device. */
    uuid:    string;
    /** Fresh bearer token minted for that uuid. Client should store
     *  this + swap its local uuid with the returned one. */
    bearer:  string;
}

/** Recover a previously-linked uuid using a fresh Apple sign-in.
 *  NO bearer required — this is the "reinstalled the app, want my
 *  progress back" flow. Server verifies the identity token, looks up
 *  apple_sub → uuid, mints a fresh bearer token. */
export async function loginWithApple(identityToken: string): Promise<LoginAppleResult> {
    const url = `${BACKEND_BASE_URL}/player/login/apple`;
    return httpPostJson<LoginAppleResult>(url, { identityToken });
}
