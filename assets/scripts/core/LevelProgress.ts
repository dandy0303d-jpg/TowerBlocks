/**
 * Persistent per-user level completion state.
 *
 * Storage strategy
 *   Uses Cocos's `sys.localStorage` (falls back to in-memory Map when
 *   localStorage is unavailable — e.g. the editor's Preview-in-Editor
 *   sandbox occasionally blocks writes). We persist the **highest
 *   cleared index** (`maxClearedIdx`) rather than a full bitset because
 *   levels are strictly linear here — once level N is beaten, levels
 *   0..N are all considered cleared.
 *
 * Unlock rule
 *   - Level 0 is always unlocked.
 *   - Level N (N > 0) is unlocked iff level N-1 has been cleared,
 *     i.e. `maxClearedIdx >= N - 1`.
 *
 * Public API
 *   LevelProgress.instance.isUnlocked(idx)      → bool
 *   LevelProgress.instance.isCleared(idx)       → bool
 *   LevelProgress.instance.markCleared(idx)     → void  (persists)
 *   LevelProgress.instance.maxClearedIdx        → number (-1 if none)
 *   LevelProgress.instance.reset()              → void  (dev/debug)
 */

import { sys } from 'cc';

const STORAGE_KEY = 'cb.levelProgress.maxClearedIdx';

class LevelProgressStore {
    private _maxClearedIdx = -1;
    private _memoryFallback: string | null = null;
    private _useMemory = false;

    constructor() {
        try {
            const raw = sys.localStorage?.getItem(STORAGE_KEY);
            if (raw !== null && raw !== undefined) {
                const n = parseInt(raw, 10);
                if (Number.isFinite(n)) this._maxClearedIdx = n;
            }
        } catch (e) {
            // localStorage denied — fall back to session memory.
            this._useMemory = true;
        }
    }

    /** Highest level index that's been cleared this profile (-1 if none). */
    public get maxClearedIdx(): number { return this._maxClearedIdx; }

    /** Is level idx currently playable? */
    public isUnlocked(idx: number): boolean {
        if (idx <= 0) return true;
        return this._maxClearedIdx >= idx - 1;
    }

    /** Has level idx already been beaten? */
    public isCleared(idx: number): boolean {
        return this._maxClearedIdx >= idx;
    }

    /** The "next up" level — the lowest unlocked-but-uncleared index.
     *  Used by the menu to render the "current" highlight ring. */
    public get currentIdx(): number {
        return this._maxClearedIdx + 1;
    }

    /** Persist a cleared level. No-op if this idx is already covered. */
    public markCleared(idx: number): void {
        if (idx <= this._maxClearedIdx) return;
        this._maxClearedIdx = idx;
        this._persist();
    }

    /** Wipe progress. Only used by dev/debug tooling. */
    public reset(): void {
        this._maxClearedIdx = -1;
        this._persist();
    }

    private _persist(): void {
        const str = String(this._maxClearedIdx);
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
}

export const LevelProgress = new LevelProgressStore();
