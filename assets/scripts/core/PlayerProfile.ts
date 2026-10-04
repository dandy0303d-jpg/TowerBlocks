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
import { AnalyticsApi } from './AnalyticsApi';
import type { DailyFreeState } from './LeaderboardApi';
import { setBearerToken, clearSessionExpiredState } from './Http';
import { GameCenter } from '../channels/apple/GameCenter';
import { loginWithGameCenter, linkGameCenterAccount } from '../channels/apple/GameCenterAuthApi';
import { getLang, subscribe as subscribeLang } from './i18n/I18n';

const UUID_KEY    = 'tt.player.uuid';
const NAME_KEY    = 'tt.player.name';
const ACCOUNT_KEY = 'tt.player.accountType';
const AVATAR_KEY  = 'tt.player.avatarIdx';
const TOKEN_KEY   = 'tt.player.token';
const TOKEN_EXP_KEY = 'tt.player.tokenExpEpochSec';
/** Comma-separated list of providers the current uuid is bound to on
 *  the server. Distinct from ACCOUNT_KEY (which is a SINGLE "primary"
 *  value): a player can be linked to Apple AND Google simultaneously,
 *  and the Settings UI must render both as "bound". Hydrated from
 *  GET /player/accounts; see Profile.setLinkedProviders. */
const LINKED_PROVIDERS_KEY = 'tt.player.linkedProviders';

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
     *  on unbind flows to demote back to 'anonymous'.
     *
     *  NOTE: this is the "primary" / most-recently-bound provider for
     *  the account-row label and for legacy single-value checks. A
     *  player can be linked to multiple providers simultaneously —
     *  callers should ALSO call `addLinkedProvider(provider)` so the
     *  Settings bind-buttons repaint correctly for both. */
    setAccountType(next: AccountType): void {
        this._accountType = next;
        sys.localStorage.setItem(ACCOUNT_KEY, next);
        console.log(`[PlayerProfile] setAccountType → ${next}`);
    }

    // ============================================================
    // Multi-provider link state
    // ============================================================
    /** Set of providers the server says this uuid is currently bound
     *  to. Hydrated by `setLinkedProviders` after a GET /player/accounts
     *  call. `null` means we haven't fetched yet since boot — callers
     *  that care about correctness (e.g. the Settings panel) should
     *  await a fetch before trusting `isLinked`. */
    private _linkedProviders: Set<AccountType> | null = null;

    /** Read-only snapshot of the server-known linked providers. See
     *  setLinkedProviders for the hydration contract. */
    get linkedProviders(): ReadonlySet<AccountType> {
        if (this._linkedProviders === null) {
            // Fall back to the comma-separated localStorage cache from
            // the last session so a fresh boot's first paint doesn't
            // regress to "nothing bound" before the first server fetch
            // lands. Guards against the server call being slow / offline.
            const stored = sys.localStorage.getItem(LINKED_PROVIDERS_KEY);
            const set = new Set<AccountType>();
            if (stored && stored.length > 0) {
                for (const p of stored.split(',')) {
                    const trimmed = p.trim();
                    if (trimmed === 'apple' || trimmed === 'google' || trimmed === 'email') {
                        set.add(trimmed as AccountType);
                    }
                }
            }
            // Back-compat: if the previous session only ever used
            // accountType (never populated linkedProviders), include
            // that one provider so the Settings panel doesn't look
            // empty on first upgrade. Harmless if it's already in the set.
            const acct = this.accountType;
            if (acct === 'apple' || acct === 'google' || acct === 'email') {
                set.add(acct);
            }
            this._linkedProviders = set;
        }
        return this._linkedProviders;
    }

    /** Server-authoritative hydration — callers (Settings panel open,
     *  post-bind, post-recovery) fetch GET /player/accounts and pass
     *  the returned providers list here. Persisted so a cold boot's
     *  first paint comes from the last known-good set, before the next
     *  server fetch confirms. */
    setLinkedProviders(providers: ReadonlyArray<AccountType>): void {
        const set = new Set<AccountType>();
        for (const p of providers) {
            if (p === 'apple' || p === 'google' || p === 'email') set.add(p);
        }
        this._linkedProviders = set;
        sys.localStorage.setItem(LINKED_PROVIDERS_KEY, Array.from(set).join(','));
        console.log(`[PlayerProfile] setLinkedProviders → [${Array.from(set).join(',')}]`);
    }

    /** Mark `provider` as linked locally. Used by the bind handlers
     *  immediately after a successful link call, before the next
     *  fetchLinkedAccounts round-trip returns, so the Settings UI
     *  repaints without waiting on the network. Idempotent. */
    addLinkedProvider(provider: AccountType): void {
        if (provider !== 'apple' && provider !== 'google' && provider !== 'email') return;
        // Force the getter path so _linkedProviders is initialised
        // (reads any cached value from storage).
        void this.linkedProviders;
        this._linkedProviders!.add(provider);
        sys.localStorage.setItem(
            LINKED_PROVIDERS_KEY,
            Array.from(this._linkedProviders!).join(','),
        );
    }

    /** True if the current uuid is bound to `provider` on the server
     *  (per the last hydration). Used by Settings bind-buttons to
     *  render the "已绑定 / 未绑定" state for Google / Apple
     *  independently — unlike `accountType === provider`, this doesn't
     *  flip to false when the player binds a SECOND provider. */
    isLinked(provider: AccountType): boolean {
        return this.linkedProviders.has(provider);
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
        this._accountType = undefined;   // force reload from localStorage on next read
        this._avatarIdx = null;
        this._linkedProviders = null;
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
     *  down on the next fetchProfile call.
     *
     *  Overload for Apple callers (channel/app-store): the Apple GC
     *  path only had bearer+uuid (no expEpochSec), so it passed the
     *  raw bearer whose middle segment decodes to the exp claim.
     *  For clarity we still accept the (uuid, bearer) shape and lazily
     *  decode the exp when caller doesn't supply one. */
    swapToRecoveredAccount(
        uuid: string,
        bearer: string,
        expEpochSec?: number,
        accountType: AccountType = 'google',
    ): void {
        // Decode exp from bearer JWT if caller didn't supply one
        // (channel/app-store's Apple GC path uses this overload).
        let exp = typeof expEpochSec === 'number' ? expEpochSec : 0;
        if (exp === 0) {
            try {
                const parts = bearer.split('.');
                if (parts.length === 3) {
                    const b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
                    const pad = b64.length % 4;
                    const b64Padded = pad ? b64 + '='.repeat(4 - pad) : b64;
                    exp = parseInt(atob(b64Padded), 10);
                }
            } catch {
                // Fall through — the very next auth'd call will 401 and
                // we'll re-register anonymously via ensureRegistered.
            }
        }

        this._uuid = uuid;
        // Force the name getter to fall back to the server-side default
        // ('user-<hex>') until a fetchProfile call comes back with the
        // real name — the recovered account's name isn't in the login
        // response.
        this._name = null;
        this._accountType = accountType;
        // Linked-providers set belongs to the OUTGOING guest — the
        // recovered uuid has its own list on the server. Seed with
        // `accountType` as a lower bound (we know THIS provider is
        // bound since we just logged in with it) and let the next
        // fetchLinkedAccounts fill in any others (e.g. an account
        // bound to BOTH Apple and Google).
        this._linkedProviders = new Set<AccountType>([accountType]);
        sys.localStorage.setItem(LINKED_PROVIDERS_KEY, accountType);
        // Avatar intentionally kept — see docstring.
        // Nickname cooldown is per-account and lives server-side; clear
        // the local cache so the settings panel doesn't lie until the
        // next fetchProfile catches up.
        this._nicknameNextChangeAt = undefined;

        sys.localStorage.setItem(UUID_KEY, uuid);
        sys.localStorage.setItem(ACCOUNT_KEY, accountType);
        sys.localStorage.setItem(TOKEN_KEY, bearer);
        sys.localStorage.setItem(TOKEN_EXP_KEY, String(exp));
        sys.localStorage.removeItem(NAME_KEY);

        setBearerToken(bearer);

        // A successful swap re-arms the Http session-expired latch —
        // the new bearer is live, so a future 401 (next key rotation /
        // server-side delete) should fire the handler again.
        clearSessionExpiredState();
        console.log(`[PlayerProfile] swapped to recovered ${accountType} account: ${uuid}`);
    }

    /** Attempt to recover from a server 401 (bearer rejected). Called by
     *  the Http session-expired handler. Returns:
     *    - `'self-healed'`     — we re-registered as a fresh anonymous
     *                            guest and have a working bearer again.
     *                            Old uuid is abandoned (guest accounts
     *                            can't be recovered without a bound
     *                            provider — that's the inherent trade-
     *                            off of staying unbound).
     *    - `'needs-rebind'`    — this player is bound to Apple / Google /
     *                            etc.; the id_token flows we'd need to
     *                            call /player/login/* can't run from
     *                            Http.ts (they need UI). Caller surfaces
     *                            a "please re-link your account in
     *                            Settings" prompt and lets the player
     *                            drive the recovery via the existing
     *                            Settings bind buttons (which hit the
     *                            same /player/login/* endpoints on 409
     *                            and persist via swapToRecoveredAccount
     *                            above).
     *    - `'failed'`          — the self-register call failed
     *                            (offline / server down); nothing to
     *                            do but let the player retry later.
     *
     *  Guard: once a bound-player prompt has fired, the Http latch
     *  stays set so repeated 401s don't spam the UI. Clearing happens
     *  via swapToRecoveredAccount (set above) or a fresh register. */
    async attemptSessionHeal(): Promise<'self-healed' | 'needs-rebind' | 'failed'> {
        const providers = this.linkedProviders;
        const isBound = providers.has('apple') || providers.has('google') || providers.has('email');
        if (isBound) {
            // Can't silently restore a bound account from Http.ts — the
            // id_token / authCode flows live in native bridges and need
            // UI (Chrome Custom Tabs / WebView / SIWA sheet / Play Games
            // overlay). Leave the Http latch set; MenuController's
            // handler will show a toast + nudge the player to Settings.
            console.warn('[PlayerProfile] session heal: bound account, needs manual re-link');
            return 'needs-rebind';
        }
        // Anonymous guest — the old uuid is lost (no provider to anchor
        // it back). Mint a fresh one via /player/register. Local progress
        // (level clears, endless best, wallet) is DEVICE-scoped under the
        // old uuid; after a re-register the server shows a fresh profile
        // and the player effectively loses everything. This is the
        // documented downside of staying unbound and is why the
        // "needs-rebind" case above is important for bound players.
        console.warn('[PlayerProfile] session heal: re-registering as fresh anonymous');
        try {
            const { uuid, nickname, avatarIdx, token, expEpochSec } = await registerPlayer(getLang());
            sys.localStorage.setItem(UUID_KEY, uuid);
            sys.localStorage.setItem(NAME_KEY, nickname);
            sys.localStorage.setItem(ACCOUNT_KEY, 'anonymous');
            sys.localStorage.setItem(TOKEN_KEY, token);
            sys.localStorage.setItem(TOKEN_EXP_KEY, String(expEpochSec));
            if (typeof avatarIdx === 'number' && Number.isFinite(avatarIdx)) {
                sys.localStorage.setItem(AVATAR_KEY, String(avatarIdx));
                this._avatarIdx = avatarIdx;
            }
            setBearerToken(token);
            this._uuid = uuid;
            this._name = nickname;
            this._accountType = 'anonymous';
            // Re-arm the Http latch so a future 401 fires the handler
            // again (next key rotation, next delete, etc.).
            clearSessionExpiredState();
            AnalyticsApi.setUserId(uuid);
            AnalyticsApi.logCustom('session_heal', { outcome: 'reregister' });
            console.log('[PlayerProfile] session heal: re-registered as', uuid);
            return 'self-healed';
        } catch (err) {
            console.warn('[PlayerProfile] session heal: register failed', err);
            AnalyticsApi.logError(err instanceof Error ? err : String(err), {
                where: 'PlayerProfile.attemptSessionHeal',
            });
            return 'failed';
        }
    }

    /** Persist a new display name. Server-side validates for
     *  profanity, reserved names, length — a 400 response ('nickname:
     *  <code>') or 429 cooldown REJECTS the change AND rolls the
     *  local name back to what it was, so callers can toast an error
     *  and re-open the prompt with the OLD name.
     *
     *  Local state is updated optimistically for snappy repaint, then
     *  rolled back on server rejection. Returns the server-saved name
     *  on success (may differ from `next` if server truncated). Rejects
     *  with the raw HTTP error message on failure — callers should
     *  parse `err.message` for the `nickname: <code>` payload (codes:
     *  profanity / reserved / too-short / too-long / cooldown). */
    async setName(next: string): Promise<string | null> {
        const trimmed = next.trim();
        if (!trimmed) return null;
        // Snapshot the CURRENT persisted name so we can roll back on a
        // server rejection.
        const prevName = this.name;
        // Optimistic local update — most callers repaint immediately.
        this._name = trimmed;
        sys.localStorage.setItem(NAME_KEY, trimmed);
        console.log(`[PlayerProfile] setName → "${trimmed}" — syncing to server…`);
        try {
            // Rename now gates on the `rename_card` backpack item —
            // the server consumes 1 card atomically as part of the
            // rename. The old 7-day cooldown is retired. See
            // updatePlayerProfile's `useRenameCard` docstring +
            // BackpackController.ts _applyEffect('rename_card').
            const r = await updatePlayerProfile({ name: trimmed, useRenameCard: true });
            // Server may have truncated — re-persist whatever the server
            // ended up storing so getters + storage agree with server.
            this._name = r.name;
            sys.localStorage.setItem(NAME_KEY, r.name);
            // Server just armed the 7-day cooldown; adopt its
            // authoritative next-change timestamp so the Settings
            // countdown flips to "6 days" without a fetchProfile
            // round-trip.
            if (r.nicknameNextChangeAt !== undefined) {
                this._nicknameNextChangeAt = r.nicknameNextChangeAt;
            }
            console.log(`[PlayerProfile] setName saved: "${r.name}" nextChangeAt=${r.nicknameNextChangeAt}`);
            return r.name;
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            // 429 nickname:cooldown — pull retryAt out of the payload
            // so the local cooldown cache stays in sync with server
            // (needed by callers that show remaining time).
            //   { error: 'nickname:cooldown', retryAt: '<iso>' }
            if (typeof msg === 'string' && msg.startsWith('HTTP 429')) {
                const bodyStart = msg.indexOf('{');
                if (bodyStart > 0) {
                    try {
                        const body = JSON.parse(msg.slice(bodyStart));
                        if (body?.error === 'nickname:cooldown' && typeof body.retryAt === 'string') {
                            this._nicknameNextChangeAt = body.retryAt;
                        }
                    } catch { /* ignore malformed body */ }
                }
            }
            console.warn(`[PlayerProfile] setName rejected: ${msg} — keeping "${prevName}"`);
            // Server rejected — roll back local state so UI reflects
            // the pre-change name after refresh.
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
        // Adopt server-authoritative daily-free state. Older builds
        // omit this → keep whatever we had cached (null on cold boot,
        // safe default: client optimistically shows "3/3" and the
        // atomic consume call corrects it).
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

    /** Server-authoritative epoch (ms) when nickname can next be
     *  changed. `null` when the player has never changed a name or
     *  the cooldown has elapsed. `undefined` folded to `null` so
     *  callers (channel/app-store MenuController's cooldown gate)
     *  see a stable number | null shape. */
    get nicknameNextChangeAt(): number | null {
        if (this._nicknameNextChangeAt == null) return null;
        const ms = Date.parse(this._nicknameNextChangeAt);
        return Number.isFinite(ms) ? ms : null;
    }

    /** Days remaining before the nickname can be changed again, per
     *  the server-authoritative cooldown. Returns:
     *    - `0` — the change is allowed right now (either never renamed
     *      or the 7-day window has fully elapsed).
     *    - a positive integer (rounded up) — days left in the cooldown.
     *    - `null` — we haven't heard from the server yet (fresh boot /
     *      offline) or the server doesn't support the field; callers
     *      should hide the countdown UI in that case. */
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
     *  optimistically show 3 and let the atomic consume call correct
     *  it". Returns 0 when the slot is exhausted for today. */
    dailyFreeRemaining(kind: 'magic' | 'fate'): number | null {
        if (!this._dailyFree) return null;
        return this._dailyFree[kind]?.remaining ?? null;
    }

    /** Overwrite the local cache of a slot's remaining count after a
     *  successful DailyFreeApi.consume — keeps HUD labels fresh without
     *  needing a full profile refetch. */
    setDailyFreeRemaining(kind: 'magic' | 'fate', remaining: number): void {
        if (!this._dailyFree) return;
        const slot = this._dailyFree[kind];
        if (!slot) return;
        slot.remaining = Math.max(0, remaining);
        slot.used = Math.max(0, slot.max - slot.remaining);
    }

    /** Update cached cooldown after a successful nickname change or
     *  when the server rejects a change with `retryAt`. Accepts an
     *  ISO string, epoch ms, or null. Internal storage is ISO for
     *  simple round-tripping with the server payload. */
    setNicknameNextChangeAt(next: string | number | null): void {
        if (next === null || next === undefined) {
            this._nicknameNextChangeAt = null;
            return;
        }
        this._nicknameNextChangeAt =
            typeof next === 'number' ? new Date(next).toISOString() : next;
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
            // Wire the returning-player uuid into Firebase so events
            // are attributed correctly. Safe even if data collection
            // is still gated by consent — Firebase just holds the id.
            AnalyticsApi.setUserId(sys.localStorage.getItem(UUID_KEY) || null);
            AnalyticsApi.logCustom('login_success', { method: 'stored_token' });
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
                    const r = await refreshPlayerToken(getLang());
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
        // ---- iOS: try Game Center silent login BEFORE guest register ----
        // Only fires on iOS with a live Game Center session. On success
        // we recover the previously-linked uuid + bearer and skip guest
        // register entirely — this is how "reinstall and progress comes
        // back automatically" works.
        //
        // On any failure (not-linked, not-authenticated, signature error,
        // network) we silently fall through to guest register + attempt
        // to link GC to the fresh uuid so future reinstalls succeed.
        if (sys.os === sys.OS.IOS) {
            const gcRecovered = await this._tryGameCenterRecover();
            if (gcRecovered) {
                console.log('[PlayerProfile] recovered via Game Center:', gcRecovered.uuid);
                return;
            }
        }

        try {
            const { uuid, nickname, avatarIdx, token, expEpochSec } = await registerPlayer(getLang());
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
            // First-time registration → tell Firebase who the player is
            // + fire a lifetime-once event we can filter on later. Both
            // events are also fired even if analytics is currently
            // consent-gated: SDK holds the id and drops the event body,
            // no PII leaks.
            AnalyticsApi.setUserId(uuid);
            AnalyticsApi.logCustom('player_register', {
                account_type: 'anonymous',
            });
            AnalyticsApi.logCustom('login_success', { method: 'register' });
            console.log('[PlayerProfile] registered with server:', uuid, nickname);

            // Opportunistically link Game Center to this fresh uuid so
            // that a future reinstall recovers automatically. Fire-and-
            // forget — a link failure is not user-visible.
            if (sys.os === sys.OS.IOS) {
                void this._tryGameCenterLink();
            }
        } catch (err) {
            console.warn('[PlayerProfile] server register failed — falling back to local uuid, will retry next launch. Error:', err);
            AnalyticsApi.logError(err instanceof Error ? err : String(err), {
                where: 'PlayerProfile.ensureRegistered',
            });
            void this.uuid;
        }
    }

    /** Attempt GC-based uuid recovery. On success writes localStorage +
     *  bearer + instance state and returns { uuid, bearer }. On any
     *  failure returns null (silent — caller falls back to guest). */
    private async _tryGameCenterRecover(): Promise<{ uuid: string; bearer: string } | null> {
        try {
            // Wait for GC's authenticateHandler to resolve before asking
            // for the identity signature — GC auto-login can take a
            // couple of seconds on cold boot and fetchIdentity() before
            // that returns "not-authenticated".
            const auth = await GameCenter.authenticate();
            if (!auth.success) {
                console.log('[PlayerProfile][GC] auth not available:', auth.kind, auth.error);
                return null;
            }
            const ident = await GameCenter.fetchIdentity();
            if (!ident.success) {
                console.log('[PlayerProfile][GC] fetchIdentity not available:', ident.kind);
                return null;
            }

            const r = await loginWithGameCenter(ident);
            // Persist and hydrate — matches the registerPlayer branch above.
            sys.localStorage.setItem(UUID_KEY, r.uuid);
            sys.localStorage.setItem(ACCOUNT_KEY, 'anonymous');
            sys.localStorage.setItem(TOKEN_KEY, r.bearer);
            // Server issues 14-day tokens — write a conservative exp so
            // the refresh-window logic works on subsequent boots. We
            // don't get the exp back from /login/gamecenter so estimate.
            const expEpochSec = Math.floor(Date.now() / 1000) + 14 * 24 * 3600;
            sys.localStorage.setItem(TOKEN_EXP_KEY, String(expEpochSec));

            setBearerToken(r.bearer);
            this._uuid = r.uuid;
            this._accountType = 'anonymous';

            // Nickname/avatar not returned by /login — fetch them so
            // the UI has the right values on first paint.
            try {
                const p = await fetchPlayerProfile();
                if (p?.name) {
                    this._name = p.name;
                    sys.localStorage.setItem(NAME_KEY, p.name);
                }
                if (typeof p?.avatarIdx === 'number' && Number.isFinite(p.avatarIdx)) {
                    this._avatarIdx = p.avatarIdx;
                    sys.localStorage.setItem(AVATAR_KEY, String(p.avatarIdx));
                }
            } catch (e) {
                console.warn('[PlayerProfile][GC] profile fetch after recovery failed:', e);
            }
            return { uuid: r.uuid, bearer: r.bearer };
        } catch (e: any) {
            // 404 = not linked (normal for a first-time GC player). Any
            // other error also drops through to guest register.
            const msg = String(e?.message || e);
            if (msg.includes('404')) {
                console.log('[PlayerProfile][GC] not linked yet — will link after guest register');
            } else {
                console.warn('[PlayerProfile][GC] login attempt failed:', msg);
            }
            return null;
        }
    }

    /** Link the current (already-registered) uuid to the current GC
     *  player identity. Best-effort; fire-and-forget from ensureRegistered. */
    private async _tryGameCenterLink(): Promise<void> {
        try {
            // Same reason as _tryGameCenterRecover — wait for auto-login
            // before fetching the identity signature.
            const auth = await GameCenter.authenticate();
            if (!auth.success) {
                console.log('[PlayerProfile][GC] link skipped — auth:', auth.kind, auth.error);
                return;
            }
            const ident = await GameCenter.fetchIdentity();
            if (!ident.success) {
                console.log('[PlayerProfile][GC] link skipped — fetchIdentity:', ident.kind);
                return;
            }
            const r = await linkGameCenterAccount(ident);
            console.log('[PlayerProfile][GC] linked to fresh uuid — alreadyLinked=', r.alreadyLinked);
        } catch (e: any) {
            console.warn('[PlayerProfile][GC] link attempt failed (non-fatal):', String(e?.message || e));
        }
    }
}

/** Module-singleton — everywhere in the game reads from this. */
export const PlayerProfile = new Profile();

// ---------------------------------------------------------------------------
// Language-change → server sync
//
// When the player changes UI language mid-session, push it to the server
// so subsequent leaderboard `?lang=` queries include their score in the
// new cohort. Fire-and-forget: token refresh piggybacks the lang payload
// (see LeaderboardApi.refreshPlayerToken). If offline / not yet
// registered we skip — next session's boot-time refresh will heal.
// ---------------------------------------------------------------------------
subscribeLang(() => {
    // Guard: skip if we never completed a real register (no persisted
    // token means the server doesn't have a row for us to update).
    try {
        const hasToken = !!sys.localStorage.getItem(TOKEN_KEY);
        if (!hasToken) return;
    } catch (_) { return; }

    refreshPlayerToken(getLang()).then((r) => {
        try {
            sys.localStorage.setItem(TOKEN_KEY, r.token);
            sys.localStorage.setItem(TOKEN_EXP_KEY, String(r.expEpochSec));
            setBearerToken(r.token);
        } catch (_) { /* ignore */ }
    }).catch((err) => {
        console.warn('[PlayerProfile] lang-change refresh failed (will retry next session):', err);
    });
});
