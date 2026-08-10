/**
 * PlayerProfile — the local player's persistent identity.
 *
 * First launch: `ensureRegistered()` calls the server's
 * `POST /player/register` to get a server-issued userid + default
 * nickname (`user-<shortId>`). The server tracks ownership, so a
 * later "bind account" flow can migrate this uuid to a real Google
 * / email / Apple identity without losing scores.
 *
 * Network fail fallback: if the register call fails on first launch,
 * we generate a temporary UUID locally so the game stays playable
 * offline. `accountType` stays null, which causes the next launch
 * to retry the server call (and, once succeeded, swap the local
 * UUID out — TODO for a later reconciliation pass).
 *
 * Public API:
 *   PlayerProfile.uuid              — string, present after first use
 *   PlayerProfile.name              — string, current display name
 *   PlayerProfile.accountType       — 'anonymous' | 'email' | 'google' | 'apple' | null
 *   PlayerProfile.ensureRegistered()— async; boot flow awaits this
 *   PlayerProfile.setName(s)        — updates + persists display name
 */

import { sys } from 'cc';
import { registerPlayer, updatePlayerProfile, fetchPlayerProfile, refreshPlayerToken } from './LeaderboardApi';
import { setBearerToken } from './Http';

const UUID_KEY    = 'tt.player.uuid';
const NAME_KEY    = 'tt.player.name';
const ACCOUNT_KEY = 'tt.player.accountType';
const AVATAR_KEY  = 'tt.player.avatarIdx';
const TOKEN_KEY   = 'tt.player.token';
const TOKEN_EXP_KEY = 'tt.player.tokenExpEpochSec';

/** Refresh the bearer if less than this many seconds until expiry.
 *  Default 7d — small enough that a normal player who opens the
 *  app once a week always has a fresh token, large enough that we
 *  don't hammer /player/refresh on every boot. */
const REFRESH_WINDOW_SEC = 60 * 60 * 24 * 7;

/** How the player is currently identified. `anonymous` = server
 *  issued the uuid; player hasn't bound a real account yet. */
export type AccountType = 'anonymous' | 'email' | 'google' | 'apple';

/** Fallback UUID generator — used ONLY when the server register call
 *  fails on first launch and we need to keep the game playable
 *  offline. The next launch retries and (eventually) replaces the
 *  local UUID with a server-issued one. */
function generateLocalUuid(): string {
    try {
        const g: any = globalThis;
        if (g.crypto && typeof g.crypto.randomUUID === 'function') {
            return g.crypto.randomUUID();
        }
    } catch (_) { /* ignore */ }
    const hex = (n: number) => n.toString(16).padStart(2, '0');
    const bytes = new Uint8Array(16);
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    return (
        Array.from(bytes.slice(0, 4)).map(hex).join('') + '-' +
        Array.from(bytes.slice(4, 6)).map(hex).join('') + '-' +
        Array.from(bytes.slice(6, 8)).map(hex).join('') + '-' +
        Array.from(bytes.slice(8, 10)).map(hex).join('') + '-' +
        Array.from(bytes.slice(10, 16)).map(hex).join('')
    );
}

class Profile {
    private _uuid: string | null = null;
    private _name: string | null = null;
    private _accountType: AccountType | null | undefined = undefined;   // undefined = not loaded
    private _avatarIdx: number | null = null;   // null = never picked → renderer falls back to uuid hash

    /** Current uuid. If `ensureRegistered()` hasn't succeeded yet,
     *  returns a lazily-generated local UUID (offline fallback). */
    get uuid(): string {
        if (this._uuid) return this._uuid;
        const stored = sys.localStorage.getItem(UUID_KEY);
        if (stored && stored.length >= 8) {
            this._uuid = stored;
            return stored;
        }
        // No uuid yet AND no server round-trip has completed. Generate
        // a local fallback so callers (e.g. score submits from a game
        // that ended before ensureRegistered resolved) still get
        // SOMETHING. Persist so future accesses match. When the
        // server register eventually succeeds, this gets overwritten.
        const local = generateLocalUuid();
        sys.localStorage.setItem(UUID_KEY, local);
        this._uuid = local;
        console.warn('[PlayerProfile] using LOCAL fallback UUID (server not yet reached):', local);
        return local;
    }

    get name(): string {
        if (this._name === null) {
            const stored = sys.localStorage.getItem(NAME_KEY);
            // Default to `user-<uuidPrefix>` if never set — matches the
            // server-side default so offline-fallback display stays
            // consistent with server-side identity naming.
            this._name = stored && stored.length > 0
                ? stored
                : `user-${this.uuid.replace(/-/g, '').slice(0, 8)}`;
        }
        return this._name;
    }

    get accountType(): AccountType | null {
        if (this._accountType === undefined) {
            const stored = sys.localStorage.getItem(ACCOUNT_KEY);
            this._accountType = (stored === 'anonymous' || stored === 'email'
                              || stored === 'google' || stored === 'apple') ? stored : null;
        }
        return this._accountType;
    }

    /** Persist a new display name. Server-side truncates to MAX_NAME_LEN.
     *  Ignored for empty / whitespace-only strings so accidental clears
     *  don't wipe the current name. Also fires a fire-and-forget PUT
     *  to the server so the change survives cross-device play. */
    setName(next: string): void {
        const trimmed = next.trim();
        if (!trimmed) return;
        this._name = trimmed;
        sys.localStorage.setItem(NAME_KEY, trimmed);
        console.log(`[PlayerProfile] setName → "${trimmed}" — syncing to server…`);
        updatePlayerProfile({ name: trimmed })
            .then((r) => console.log(`[PlayerProfile] setName synced: server saved "${r.name}"`))
            .catch((err) => console.warn(`[PlayerProfile] setName sync FAILED: ${err?.message}`));
    }

    /** Currently-selected avatar index. `null` means the player hasn't
     *  picked one yet — the renderer picks a default based on the
     *  uuid hash so different guests still look different. */
    get avatarIdx(): number | null {
        if (this._avatarIdx !== null) return this._avatarIdx;
        const stored = sys.localStorage.getItem(AVATAR_KEY);
        if (stored) {
            const n = parseInt(stored, 10);
            if (Number.isFinite(n) && n >= 0) {
                this._avatarIdx = n;
                return n;
            }
        }
        return null;
    }

    /** Persist the chosen avatar index. Clamps to >=0. Fires a fire-
     *  and-forget PUT so the choice survives cross-device play. */
    setAvatarIdx(idx: number): void {
        if (!Number.isFinite(idx) || idx < 0) return;
        const n = Math.floor(idx);
        this._avatarIdx = n;
        sys.localStorage.setItem(AVATAR_KEY, String(n));
        console.log(`[PlayerProfile] setAvatarIdx → ${n} — syncing to server…`);
        updatePlayerProfile({ avatarIdx: n })
            .then((r) => console.log(`[PlayerProfile] setAvatarIdx synced: server saved ${r.avatarIdx}`))
            .catch((err) => console.warn(`[PlayerProfile] setAvatarIdx sync FAILED: ${err?.message}`));
    }

    /** Pull the authoritative profile from the server (name, avatar,
     *  best scores). Rejects on network / 4xx / 5xx — callers decide
     *  whether to swallow or surface. Also mirrors name+avatar into
     *  localStorage so offline reads see the latest values. */
    async fetchProfile(): Promise<{
        name:       string;
        avatarIdx:  number;
        bestScores: { level: number; endless: number; blind: number };
    }> {
        const p = await fetchPlayerProfile();
        this._name = p.name;
        this._avatarIdx = p.avatarIdx;
        sys.localStorage.setItem(NAME_KEY, p.name);
        sys.localStorage.setItem(AVATAR_KEY, String(p.avatarIdx));
        return {
            name: p.name,
            avatarIdx: p.avatarIdx,
            bestScores: p.bestScores,
        };
    }

    /**
     * Called by MenuController.beginBootAfterLoading before showing
     * the main menu. If we've already registered with the server
     * (accountType is non-null AND uuid is stored), this is a fast
     * no-op. Otherwise it calls POST /player/register, stores the
     * server-issued uuid + nickname, and marks accountType='anonymous'.
     *
     * Network failures don't throw — we log and let the game boot
     * with a locally-generated UUID fallback. The next launch retries.
     */
    async ensureRegistered(): Promise<void> {
        // Already registered — restore bearer token to Http module and
        // refresh if we're inside the rotation window.
        if (this.accountType && sys.localStorage.getItem(UUID_KEY)) {
            const storedToken = sys.localStorage.getItem(TOKEN_KEY);
            const storedExp   = parseInt(sys.localStorage.getItem(TOKEN_EXP_KEY) || '0', 10);
            if (storedToken) setBearerToken(storedToken);
            const now = Math.floor(Date.now() / 1000);
            const secondsLeft = storedExp - now;
            if (!storedToken || secondsLeft <= 0) {
                // No token or expired — silently re-register anonymously
                // to mint a fresh one. Old uuid stays; a new one only
                // happens if the register call succeeds AND the old
                // localStorage was cleared, which it isn't.
                console.warn('[PlayerProfile] token missing/expired — rotating via /player/refresh not possible, would need re-register. Skipping — score submits will 401 until reinstall.');
                return;
            }
            if (secondsLeft < REFRESH_WINDOW_SEC) {
                try {
                    const r = await refreshPlayerToken();
                    sys.localStorage.setItem(TOKEN_KEY, r.token);
                    sys.localStorage.setItem(TOKEN_EXP_KEY, String(r.expEpochSec));
                    setBearerToken(r.token);
                    console.log('[PlayerProfile] bearer refreshed, new exp:', r.expEpochSec);
                } catch (err) {
                    console.warn('[PlayerProfile] token refresh failed (offline?), keeping old:', err);
                }
            }
            return;
        }
        try {
            const { uuid, nickname, token, expEpochSec } = await registerPlayer();
            sys.localStorage.setItem(UUID_KEY, uuid);
            sys.localStorage.setItem(NAME_KEY, nickname);
            sys.localStorage.setItem(ACCOUNT_KEY, 'anonymous');
            sys.localStorage.setItem(TOKEN_KEY, token);
            sys.localStorage.setItem(TOKEN_EXP_KEY, String(expEpochSec));
            setBearerToken(token);
            this._uuid = uuid;
            this._name = nickname;
            this._accountType = 'anonymous';
            console.log('[PlayerProfile] registered with server:', uuid, nickname);
        } catch (err) {
            console.warn('[PlayerProfile] server register failed — falling back to local uuid, will retry next launch. Error:', err);
            void this.uuid;
        }
    }
}

/** Module-singleton — everywhere in the game reads from this. */
export const PlayerProfile = new Profile();
