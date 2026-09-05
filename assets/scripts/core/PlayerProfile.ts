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
import type { DailyFreeState } from './LeaderboardApi';
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

    /** Server-authoritative daily-free reroll counters. `null` = not
     *  yet fetched (fresh boot, offline). HUD callers should call
     *  DailyFreeApi.consume() rather than reading this directly for
     *  the atomic check-and-increment; this cache exists so the UI
     *  can render "N left today" labels without a round-trip. */
    private _dailyFree: DailyFreeState | null = null;

    /** ISO timestamp of the earliest moment the player can rename
     *  again, per the server's 7-day nickname cooldown. `null` means
     *  either (a) the player has never been renamed, or (b) the
     *  cooldown has fully elapsed — in both cases the change is
     *  allowed. `undefined` means we haven't heard from the server
     *  yet (fresh boot / offline). Populated by fetchProfile + refreshed
     *  by every successful setName. */
    private _nicknameNextChangeAt: string | null | undefined = undefined;

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

    /** Persist a change to the player's linked-account kind. Called
     *  by channel-specific link handlers after a successful bind
     *  (e.g. Sign in with Apple returns → set to 'apple'). Also used
     *  on unbind flows to demote back to 'anonymous'. */
    setAccountType(next: AccountType): void {
        this._accountType = next;
        sys.localStorage.setItem(ACCOUNT_KEY, next);
        console.log(`[PlayerProfile] setAccountType → ${next}`);
    }

    /** Wipe ALL in-memory state — used by the delete-account flow.
     *  After this, PlayerProfile behaves as if the app just started
     *  fresh with no prior state. Caller MUST also clear localStorage
     *  keys BEFORE calling this (otherwise the getters will re-read
     *  from storage on next access), AND MUST then re-run
     *  ensureRegistered() to get a new server-issued anonymous account.
     *
     *  Also clears the Http module's bearer-token cache so subsequent
     *  requests don't send a stale token that no longer matches any
     *  server-side player row. */
    resetInMemoryState(): void {
        this._uuid = null;
        this._name = null;
        this._accountType = undefined;
        this._avatarIdx = null;
        setBearerToken(null);
        console.log('[PlayerProfile] in-memory state wiped');
    }

    /** Swap the current player identity to a RECOVERED one — used by
     *  the "this account is bound to another Google/Apple, restore it?"
     *  UX after a login call succeeds. Called after `/player/login/google`
     *  or `/player/login/apple` returns the previously-linked uuid +
     *  a freshly-minted bearer + expiry.
     *
     *  This is destructive — the guest account the caller was on
     *  BEFORE recovery is abandoned (server-side it's still there,
     *  just no longer connected to this device). Not undoable
     *  without another /login round-trip.
     *
     *  Avatar is deliberately NOT reset — many players change avatar
     *  BEFORE binding, and we want them to keep it. If the recovered
     *  account has a different avatar on another device, the recovered
     *  device's local pick wins locally, and the server-side one syncs
     *  down on the next fetchProfile call. */
    swapToRecoveredAccount(
        uuid: string,
        bearer: string,
        expEpochSec: number,
        accountType: AccountType = 'google',
    ): void {
        this._uuid = uuid;
        // Force the name getter to fall back to the server-side default
        // ('user-<hex>') until a fetchProfile call comes back with the
        // real name — the recovered account's name isn't in the login
        // response.
        this._name = null;
        this._accountType = accountType;
        // Avatar intentionally kept — see docstring.
        // Nickname cooldown is per-account and lives server-side; clear
        // the local cache so the settings panel doesn't lie until the
        // next fetchProfile catches up.
        this._nicknameNextChangeAt = undefined;

        sys.localStorage.setItem(UUID_KEY, uuid);
        sys.localStorage.setItem(ACCOUNT_KEY, accountType);
        sys.localStorage.setItem(TOKEN_KEY, bearer);
        sys.localStorage.setItem(TOKEN_EXP_KEY, String(expEpochSec));
        sys.localStorage.removeItem(NAME_KEY);

        setBearerToken(bearer);

        console.log(`[PlayerProfile] swapped to recovered ${accountType} account: ${uuid}`);
    }

    /** Persist a new display name. Server-side truncates to MAX_NAME_LEN
     *  AND rejects reserved words / profanity via `validateNickname`.
     *  Ignored for empty / whitespace-only strings so accidental clears
     *  don't wipe the current name.
     *
     *  Returns a Promise that:
     *    - resolves with the server-saved name on success (may differ
     *      from `next` if the server truncated it), OR
     *    - rejects with the raw HTTP error when the server refuses. The
     *      LOCAL name is rolled back to the previous value AND written
     *      back to localStorage before rejecting, so a rejected submit
     *      never leaves the app displaying an invalid name.
     *
     *  Callers that want to show a toast should await + catch and parse
     *  `err.message` for the `nickname: <code>` payload (codes:
     *  `profanity` / `reserved` / `too-short` / `too-long`). */
    async setName(next: string): Promise<string | null> {
        const trimmed = next.trim();
        if (!trimmed) return null;
        // Snapshot the CURRENT persisted name so we can roll back on a
        // server rejection. Reads from getter to make sure we pick up
        // whatever localStorage holds (not a stale field).
        const prevName = this.name;
        // Optimistic local update — most callers repaint immediately.
        this._name = trimmed;
        sys.localStorage.setItem(NAME_KEY, trimmed);
        console.log(`[PlayerProfile] setName → "${trimmed}" — syncing to server…`);
        try {
            const r = await updatePlayerProfile({ name: trimmed });
            // Server may have truncated — re-persist whatever the server
            // ended up storing so getters + storage agree with server.
            this._name = r.name;
            sys.localStorage.setItem(NAME_KEY, r.name);
            // Server arms the 7-day cooldown when a rename succeeds and
            // returns the new deadline in the same response. Refresh
            // the local cache so the Settings panel countdown flips to
            // "6 days" without a fetchProfile round-trip.
            if (r.nicknameNextChangeAt !== undefined) {
                this._nicknameNextChangeAt = r.nicknameNextChangeAt;
            }
            console.log(`[PlayerProfile] setName synced: server saved "${r.name}"`);
            return r.name;
        } catch (err: any) {
            console.warn(`[PlayerProfile] setName sync FAILED: ${err?.message} — rolling back to "${prevName}"`);
            // Server rejected — roll back local state so UI reflects the
            // pre-change name after refresh.
            this._name = prevName;
            sys.localStorage.setItem(NAME_KEY, prevName);
            throw err;
        }
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
        // Cache the server-authoritative daily-free counters (optional
        // field — older servers won't include it). HUD reads via
        // dailyFreeRemaining() below.
        if (p.dailyFree) this._dailyFree = p.dailyFree;
        // Cache the nickname-cooldown deadline (server-authoritative).
        // Optional field — older servers omit it entirely, in which
        // case we leave `_nicknameNextChangeAt` undefined so the UI
        // knows to hide the countdown rather than showing "0 days".
        if (p.nicknameNextChangeAt !== undefined) {
            this._nicknameNextChangeAt = p.nicknameNextChangeAt;
        }
        sys.localStorage.setItem(NAME_KEY, p.name);
        sys.localStorage.setItem(AVATAR_KEY, String(p.avatarIdx));
        return {
            name: p.name,
            avatarIdx: p.avatarIdx,
            bestScores: p.bestScores,
        };
    }

    /** Days remaining before the nickname can be changed again, per
     *  the server-authoritative cooldown. Returns:
     *    - `0` — the change is allowed right now (either never renamed
     *      or the 7-day window has fully elapsed).
     *    - a positive integer (rounded up) — days left in the cooldown.
     *    - `null` — we haven't heard from the server yet (fresh boot /
     *      offline) or the server doesn't support the field; callers
     *      should hide the countdown UI in that case.
     *  Callers repaint whenever this returns a different value; there's
     *  no push notification — settings-panel-open time is a fine cadence. */
    nicknameCooldownDaysRemaining(): number | null {
        if (this._nicknameNextChangeAt === undefined) return null;
        if (this._nicknameNextChangeAt === null) return 0;
        const readyAtMs = Date.parse(this._nicknameNextChangeAt);
        if (!Number.isFinite(readyAtMs)) return null;
        const deltaMs = readyAtMs - Date.now();
        if (deltaMs <= 0) return 0;
        return Math.max(1, Math.ceil(deltaMs / (24 * 60 * 60 * 1000)));
    }

    /** Remaining daily-free rerolls for a given slot, per the server's
     *  last known state. Returns `null` when server hasn't reported
     *  yet (fresh boot / offline) — UI should treat null as "unknown,
     *  optimistically show max and let the atomic consume call
     *  correct it". Returns 0 when the slot is exhausted for today. */
    dailyFreeRemaining(kind: 'magic' | 'fate'): number | null {
        if (!this._dailyFree) return null;
        return this._dailyFree[kind]?.remaining ?? null;
    }

    /** Overwrite the local cache of a slot's remaining count after a
     *  successful DailyFreeApi.consume — keeps HUD labels fresh
     *  without needing a full profile refetch. */
    setDailyFreeRemaining(kind: 'magic' | 'fate', remaining: number): void {
        if (!this._dailyFree) return;
        const slot = this._dailyFree[kind];
        if (!slot) return;
        slot.remaining = Math.max(0, remaining);
        slot.used = Math.max(0, slot.max - slot.remaining);
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
            const { uuid, nickname, avatarIdx, token, expEpochSec } = await registerPlayer();
            sys.localStorage.setItem(UUID_KEY, uuid);
            sys.localStorage.setItem(NAME_KEY, nickname);
            sys.localStorage.setItem(ACCOUNT_KEY, 'anonymous');
            sys.localStorage.setItem(TOKEN_KEY, token);
            sys.localStorage.setItem(TOKEN_EXP_KEY, String(expEpochSec));
            // Server-assigned initial avatar — random per registration
            // so guests visually distinct without the player picking.
            // Only stored if the server actually provided it (older
            // server versions may not).
            if (typeof avatarIdx === 'number' && Number.isFinite(avatarIdx)) {
                sys.localStorage.setItem(AVATAR_KEY, String(avatarIdx));
                this._avatarIdx = avatarIdx;
            }
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
