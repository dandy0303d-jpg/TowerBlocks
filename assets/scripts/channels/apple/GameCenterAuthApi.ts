/**
 * GameCenterAuthApi — HTTP calls for Game Center silent auth.
 * Mirrors AppleAuthApi / GoogleAuthApi shape one-for-one.
 *
 *   POST /player/link/gamecenter    — bind current guest uuid to a
 *                                     Game Center player identity
 *                                     (requires current bearer token)
 *   POST /player/login/gamecenter   — recover previously-linked uuid
 *                                     on a fresh install (no bearer)
 *
 * The payload is the entire GameCenterIdentitySuccess object returned
 * by `GameCenter.fetchIdentity()` — the server does its own signature
 * verification against Apple's public key.
 */

import { httpPostJson } from '../../core/Http';
import { BACKEND_BASE_URL } from '../../core/BackendConfig';
import type { GameCenterIdentitySuccess } from './GameCenter';

export interface LinkGameCenterResult {
    linked:        boolean;
    /** true if the (uuid, gc_player_id) pair already existed — idempotent replay. */
    alreadyLinked: boolean;
}

/** Bind the current player's uuid to a Game Center identity.
 *  Requires bearer token. Server verifies the signature, records
 *  gc_player_id → uuid in game_center_id_links, returns 200 on success
 *  or 409 if either side is already linked to a DIFFERENT partner. */
export async function linkGameCenterAccount(
    identity: GameCenterIdentitySuccess,
): Promise<LinkGameCenterResult> {
    const url = `${BACKEND_BASE_URL}/player/link/gamecenter`;
    return httpPostJson<LinkGameCenterResult>(url, identity);
}

export interface LoginGameCenterResult {
    /** uuid the player owned before this device install. */
    uuid:   string;
    /** Fresh bearer token minted for that uuid — client stores + swaps
     *  its local uuid with the returned one. */
    bearer: string;
}

/** Recover a previously-linked uuid via a fresh Game Center identity.
 *  No bearer required — this is the "reinstalled the app, want my
 *  progress back" flow. Server verifies the signature, looks up
 *  gc_player_id → uuid, mints a bearer token.
 *
 *  Throws on non-2xx. Caller (typically PlayerProfile.ensureRegistered)
 *  should catch and fall back to guest register on 404 (this GC player
 *  has never linked before) or on any auth error (signature invalid /
 *  stale timestamp — proceed as guest and let the user re-try later
 *  via a manual link). */
export async function loginWithGameCenter(
    identity: GameCenterIdentitySuccess,
): Promise<LoginGameCenterResult> {
    const url = `${BACKEND_BASE_URL}/player/login/gamecenter`;
    return httpPostJson<LoginGameCenterResult>(url, identity);
}
