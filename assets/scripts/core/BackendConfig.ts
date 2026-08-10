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
