/**
 * Backend service URL — single point of truth. Change here when the
 * server moves to a new IP / gets a domain / gains HTTPS.
 *
 * Current: HTTPS via `tetritower.konenine.kr` (nginx reverse proxy on
 * the VPS, Let's Encrypt cert auto-renewed by certbot). Passes iOS App
 * Transport Security requirements (TLS 1.2+, valid cert) so this URL
 * is safe for App Store submission.
 *
 * Was `http://101.32.254.170:8080` (plain HTTP on VPS IP) — swap back
 * if you're testing against a fresh unproxied server, but never ship
 * plain HTTP.
 */

export const BACKEND_BASE_URL = 'https://tetritower.konenine.kr';

/** Timeout for a single HTTP request. Fetch aborts after this if the
 *  server doesn't respond — keeps the leaderboard UI from hanging
 *  when the network is flaky. */
export const BACKEND_TIMEOUT_MS = 8000;

/** Google OAuth 2.0 Web application Client ID. Same value the server
 *  uses to validate incoming ID tokens (server's env: GOOGLE_CLIENT_ID).
 *  Configured in Google Cloud Console → APIs & Services → Credentials.
 *
 *  Client uses this to construct the authorization URL. Client secret
 *  is intentionally NOT here — PKCE (S256) replaces the secret, so the
 *  code_verifier proves this app initiated the flow without shipping
 *  a shared secret in the APK.
 *
 *  TODO(google-oauth): fill in the real Web Client ID before shipping.
 *  Format: 1234567890-xxxxxxxxxxxxxxxxxxxx.apps.googleusercontent.com */
export const GOOGLE_OAUTH_CLIENT_ID = 'REPLACE_WITH_GOOGLE_WEB_CLIENT_ID.apps.googleusercontent.com';

/** OAuth redirect URI — must exactly match the value registered in
 *  Google Cloud Console → OAuth 2.0 Client → Authorized redirect URIs.
 *  The custom scheme is picked up by the intent-filter in
 *  AndroidManifest.xml (com.tetritower.oauth → AppActivity), which
 *  invokes GoogleWebOAuthBridge.handleRedirect. */
export const GOOGLE_OAUTH_REDIRECT_URI = 'com.tetritower.oauth://google/callback';
