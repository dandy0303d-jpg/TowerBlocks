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

/** Google OAuth 2.0 Client ID used by the CLIENT for the Android-based
 *  authorization flow (Custom Tabs + PKCE + custom-scheme redirect).
 *  This MUST be the "Android" type client from Google Cloud Console —
 *  the Web type rejects the `com.tetritower.oauth://` scheme.
 *
 *  Android-type clients are validated in Google's backend by package
 *  name + signing SHA-1, so no client_secret is needed (public client,
 *  PKCE-protected).
 *
 *  The server verifies the resulting id_token's `aud` claim, so the
 *  server env's GOOGLE_ALLOWED_AUDIENCES list MUST include this ID.
 *  Server may also list a matching Web Client ID for server-side flows;
 *  they belong to the same project but are separate Client IDs. */
export const GOOGLE_OAUTH_CLIENT_ID = '898144979904-2msavmk9b0c63fbi4bl29kl7ud1iknj1.apps.googleusercontent.com';

/** Sister Web Application client for the same Google Cloud project.
 *  NOT sent from the client; kept here as documentation of the "server
 *  audience" the backend can also accept when verifying id_tokens (some
 *  Google flows populate the token's `aud` with this instead of the
 *  Android ID). Server config: GOOGLE_ALLOWED_AUDIENCES must include it. */
export const GOOGLE_OAUTH_WEB_CLIENT_ID = '898144979904-6qcfcmp21s5o9lhn7l64mpe9u89u9ekc.apps.googleusercontent.com';

/** OAuth redirect URI — must exactly match the value registered in
 *  Google Cloud Console → OAuth 2.0 Client → Authorized redirect URIs.
 *  The custom scheme is picked up by the intent-filter in
 *  AndroidManifest.xml (com.tetritower.oauth → AppActivity), which
 *  invokes GoogleWebOAuthBridge.handleRedirect. */
export const GOOGLE_OAUTH_REDIRECT_URI = 'com.tetritower.oauth://google/callback';
