/**
 * PlayerApi — misc player-scoped endpoints that don't belong to
 * WalletApi / LeaderboardApi / RefreshApi.
 *
 * Currently: account deletion. Room to grow (change email, export
 * data, etc.) as we add features.
 */

import { httpDelete } from './Http';
import { BACKEND_BASE_URL } from './BackendConfig';

/**
 * Permanently delete the current player and all associated data
 * server-side. Wipes: players record, wallet balance, purchase log,
 * leaderboard entries, and any linked social accounts (Apple, ...).
 *
 * This is a REQUIRED endpoint for App Store review (guideline 5.1.1(v),
 * enforced since 2022-06). Caller MUST follow up by wiping localStorage
 * client-side AND resetting PlayerProfile in-memory state, otherwise
 * the client will try to use a bearer token that no longer maps to
 * anything on the server and all subsequent calls will 401.
 *
 * Server returns 204 No Content — this promise resolves with undefined
 * on success or rejects with an Error otherwise. Both bearer + HMAC
 * signature are sent (destructive operation).
 *
 * On iOS with Sign in with Apple linked, the server-side player-delete
 * handler also calls Apple's /auth/revoke to satisfy 5.1.1(v)'s second
 * requirement (must revoke SIWA authorization on account deletion).
 * That's transparent to the client — no extra work here.
 */
export async function deletePlayerSelf(): Promise<void> {
    const url = `${BACKEND_BASE_URL}/player/self`;
    await httpDelete<void>(url);
}
