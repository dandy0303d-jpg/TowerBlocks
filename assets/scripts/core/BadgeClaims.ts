/**
 * Persistent per-player set of badge groupIdxs that have had their
 * "1 gem" reward claimed.
 *
 * Storage strategy
 *   Same pattern as LevelProgress — Cocos `sys.localStorage` with a
 *   session-memory fallback. Value is a sorted, comma-separated list
 *   of groupIdxs so a hand-edited localStorage still round-trips.
 *
 * Semantics
 *   Whether the player has EARNED a badge is derived from
 *   LevelProgress.maxClearedIdx (see MenuController._earnedBadgeCount).
 *   This store tracks orthogonally which of those earned badges have
 *   had their gem reward CLAIMED. Once claimed, the reward cannot be
 *   re-claimed for the same group.
 *
 * Public API
 *   BadgeClaims.isClaimed(groupIdx)  → bool
 *   BadgeClaims.markClaimed(groupIdx) → void (persists; idempotent)
 *   BadgeClaims.reset()               → void (dev/debug)
 *   BadgeClaims.all()                 → readonly number[]
 */

import { sys } from 'cc';

const STORAGE_KEY = 'tt.badges.claimed';

class BadgeClaimsStore {
    private _set: Set<number> = new Set();
    private _useMemory = false;
    private _memoryFallback: string | null = null;

    constructor() {
        try {
            const raw = sys.localStorage?.getItem(STORAGE_KEY);
            if (raw) this._parse(raw);
        } catch (e) {
            this._useMemory = true;
        }
    }

    private _parse(raw: string): void {
        for (const s of raw.split(',')) {
            const n = parseInt(s, 10);
            if (Number.isFinite(n) && n >= 0) this._set.add(n);
        }
    }

    private _persist(): void {
        const sorted = Array.from(this._set).sort((a, b) => a - b);
        const str = sorted.join(',');
        if (this._useMemory) {
            this._memoryFallback = str;
            return;
        }
        try {
            sys.localStorage?.setItem(STORAGE_KEY, str);
        } catch (e) {
            this._useMemory = true;
            this._memoryFallback = str;
        }
    }

    /** True when `groupIdx`'s gem reward has already been claimed. */
    public isClaimed(groupIdx: number): boolean {
        return this._set.has(groupIdx);
    }

    /** Persist a fresh claim. No-op when already claimed (so the
     *  server double-tap protection has a client twin). */
    public markClaimed(groupIdx: number): void {
        if (this._set.has(groupIdx)) return;
        this._set.add(groupIdx);
        this._persist();
    }

    /** Wipe the claim set — dev/debug only. */
    public reset(): void {
        this._set.clear();
        this._persist();
    }

    /** Read-only snapshot of every claimed groupIdx. Ordered by
     *  groupIdx ascending. */
    public all(): readonly number[] {
        return Array.from(this._set).sort((a, b) => a - b);
    }

    /** Count of claimed badges. */
    public get size(): number { return this._set.size; }
}

export const BadgeClaims = new BadgeClaimsStore();
