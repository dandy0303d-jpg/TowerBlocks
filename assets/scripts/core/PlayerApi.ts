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
 * server-side. Wipes:
 *   - players record itself
 *   - player_wallets (gem balance)
 *   - purchase_log (IAP history — Apple's monthly reports are the
 *     tax source of truth, so no need to keep locally)
 *   - best_scores + score_history (leaderboard)
 *   - apple_id_links (Sign in with Apple linkage)
 *
 * This is a REQUIRED endpoint for App Store review (guideline 5.1.1(v),
 * enforced since 2022-06). Caller MUST follow up by wiping localStorage
 * client-side and re-booting the game into fresh guest state, otherwise
 * the client will try to use a bearer token that no longer maps to
 * anything on the server and all subsequent calls will 401.
 *
 * Server returns 204 No Content — this promise resolves with undefined
 * on success or rejects with an Error otherwise. Both bearer + HMAC
 * signature are sent (destructive operation).
 */
export async function deletePlayerSelf(): Promise<void> {
    const url = `${BACKEND_BASE_URL}/player/self`;
    await httpDelete<void>(url);
}
