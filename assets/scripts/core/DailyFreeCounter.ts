/**
 * DailyFreeCounter — per-day "free chances" allowance tracked in
 * localStorage.
 *
 * Used by ad-gated actions (picker refresh, fate reroll) to grant N
 * free uses each day before the player has to watch a rewarded ad.
 * Different action types share the module but keep independent
 * counters via a `kind` key.
 *
 * Storage layout — one JSON string per kind:
 *   key   = `dailyFree:${kind}`
 *   value = `{"date":"YYYY-MM-DD","count":<int>}`
 *
 * Day boundary is local midnight (uses `Date` in the player's local
 * timezone). Cheating via device-clock rollback is possible but low
 * value — worst case a determined player gets a handful of extra
 * free rerolls per day. If that becomes an economy problem, move
 * the counter to a server-authoritative endpoint.
 *
 * Import example:
 *   import { DailyFreeCounter } from '../core/DailyFreeCounter';
 *   if (DailyFreeCounter.hasFree('magic')) { ... DailyFreeCounter.consume('magic'); }
 */

/** Types of daily-limited free actions. Add new kinds here. */
export type DailyFreeKind = 'magic' | 'fate';

/** How many free uses each kind gets per day. Tune per placement. */
const MAX_PER_DAY: Record<DailyFreeKind, number> = {
    magic: 3,
    fate:  3,
};

function todayKey(): string {
    // Local-timezone YYYY-MM-DD — sortable, no dependency on Intl.
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function storageKey(kind: DailyFreeKind): string {
    return `dailyFree:${kind}`;
}

interface StoredCount {
    date:  string;
    count: number;
}

function readRaw(kind: DailyFreeKind): StoredCount | null {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(storageKey(kind));
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw) as StoredCount;
        if (typeof parsed?.date === 'string' && typeof parsed?.count === 'number') {
            return parsed;
        }
    } catch { /* malformed — treat as no data */ }
    return null;
}

function writeRaw(kind: DailyFreeKind, value: StoredCount): void {
    if (typeof localStorage === 'undefined') return;
    try {
        localStorage.setItem(storageKey(kind), JSON.stringify(value));
    } catch { /* full/private mode — silent fallthrough */ }
}

export const DailyFreeCounter = {

    /** Max free uses per day for this kind. Constant per kind; exposed
     *  so UI can render "N/3" labels without duplicating the config. */
    max(kind: DailyFreeKind): number {
        return MAX_PER_DAY[kind];
    },

    /** How many free uses have been consumed today. Auto-resets to 0
     *  once the calendar day rolls over. */
    used(kind: DailyFreeKind): number {
        const stored = readRaw(kind);
        if (!stored || stored.date !== todayKey()) return 0;
        return Math.min(stored.count, MAX_PER_DAY[kind]);
    },

    /** How many free uses remain today. Clamped ≥ 0. */
    remaining(kind: DailyFreeKind): number {
        return Math.max(0, MAX_PER_DAY[kind] - this.used(kind));
    },

    /** True while the player still has at least one free use left today. */
    hasFree(kind: DailyFreeKind): boolean {
        return this.remaining(kind) > 0;
    },

    /** Increment the used count for today. Idempotent-safe — capped at
     *  MAX_PER_DAY so multiple accidental calls don't corrupt state. */
    consume(kind: DailyFreeKind): void {
        const cur = this.used(kind);
        writeRaw(kind, {
            date:  todayKey(),
            count: Math.min(cur + 1, MAX_PER_DAY[kind]),
        });
    },

    /** Reset today's counter for a kind. Debug/QA helper — not called
     *  from gameplay. Use via globalThis for manual testing:
     *      globalThis.__resetDailyFree?.('magic') */
    reset(kind: DailyFreeKind): void {
        if (typeof localStorage === 'undefined') return;
        try { localStorage.removeItem(storageKey(kind)); } catch { /* noop */ }
    },
};

// Debug hooks — Safari Web Inspector / editor console can reset
// counters without rewinding the device clock. Silent no-op if
// globalThis isn't available (SSR / editor lint contexts).
if (typeof globalThis !== 'undefined') {
    (globalThis as any).__resetDailyFree = (kind: DailyFreeKind) => DailyFreeCounter.reset(kind);
    (globalThis as any).__dailyFreeStatus = () => ({
        magic: { used: DailyFreeCounter.used('magic'), remaining: DailyFreeCounter.remaining('magic') },
        fate:  { used: DailyFreeCounter.used('fate'),  remaining: DailyFreeCounter.remaining('fate')  },
    });
}
