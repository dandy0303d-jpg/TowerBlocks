/**
 * Hail level prop — freezes normal piece spawning, then rains down
 * `HAIL_TOTAL` (72) white 1×1 blocks at 10× the base level-1 drop speed.
 *
 * Target selection rules (preserved from the original prototype):
 *   - A cell is eligible if no colored cell sits above it in the same column.
 *     (Cells above the topmost-non-null are eligible; everything else isn't.)
 *   - Targets are sorted lowest-row first; within a row the order is shuffled
 *     so the rain doesn't look like a zipper.
 *
 * Timing rules:
 *   - Target computation is DEFERRED to the first tick after activation. The
 *     trigger fires inside `clearLines` / `detonateBombs` BEFORE the splice
 *     finishes, so computing right away would pin to stale row indices and
 *     leave a one-row gap. See "white blocks left a gap" bug from earlier.
 *   - Drops are spawned every `HAIL_SPAWN_STAGGER_MS` (25ms) so they appear
 *     to rain rather than dump simultaneously.
 *   - Once placed, hail cells immune to line-clear / bomb / wrecker / rocket
 *     (the ClearLines / Detonate modules check `v !== 'H'`).
 *   - After all 72 land, `lifeRemaining` is set to `HAIL_LIFE_PIECES` (3).
 *     Every subsequent normal piece lock ticks it down; when it hits 0 the
 *     hail evaporates and `evaporateHailPerColumn` settles the colored cells
 *     that were sitting on top.
 */

import {
    COLS,
    HAIL_TOTAL,
    HAIL_DROP_INTERVAL_PER_ROW_MS,
    HAIL_LIFE_PIECES,
    HAIL_SPAWN_STAGGER_MS,
} from '../Constants';
import { BoardState, FallingDrop } from '../Types';
import { evaporateHailPerColumn } from '../ColumnGravity';

export interface HailHooks {
    /** Fired once when the storm finishes landing — caller spawns the next piece. */
    onFinish?(): void;
    /** Fired each frame so the renderer can re-read positions. (Optional.) */
    onPlacedCell?(r: number, c: number): void;
    /** Fired when the 3-piece life timer expires and the hail evaporates. */
    onEvaporate?(): void;
}

export class HailState {
    /** While `true`, normal piece spawn is frozen and we're driving the rain. */
    mode = false;
    /** Normal-piece locks remaining until placed hail evaporates. */
    lifeRemaining = 0;

    private queue:       Array<{ r: number; c: number }> = [];
    private falling:     FallingDrop[]                   = [];
    private pendingDrops = 0;
    private spawnAccum   = 0;

    /** Caller invokes this when a hail prop fires (or for any chain re-entry).
     *  Adds another wave of `HAIL_TOTAL` pending drops — they'll be turned
     *  into concrete targets on the next tick once the board has settled. */
    activate(): void {
        this.mode = true;
        this.pendingDrops += HAIL_TOTAL;
    }

    /** Frame tick. `dt` in ms. Returns the number of drops that landed this frame. */
    tick(dt: number, state: BoardState, hooks: HailHooks = {}): number {
        if (!this.mode) return 0;
        let landed = 0;

        // Deferred target compute — wait until queue + falling drain so we
        // always pick against a settled board.
        if (this.pendingDrops > 0 && this.queue.length === 0 && this.falling.length === 0) {
            const fresh = computeHailTargets(state, this.pendingDrops);
            for (const t of fresh) this.queue.push(t);
            this.pendingDrops = 0;
        }

        // Spawn drops at a steady stagger so they appear to rain, not dump.
        this.spawnAccum += dt;
        while (this.spawnAccum >= HAIL_SPAWN_STAGGER_MS && this.queue.length > 0) {
            this.spawnAccum -= HAIL_SPAWN_STAGGER_MS;
            const t = this.queue.shift()!;
            this.falling.push({
                col:     t.c,
                y:       -3 - Math.random() * 18,
                targetR: t.r,
                targetC: t.c,
            });
        }

        // Advance every in-flight drop. Speed is row-per-ms via the fixed interval.
        for (let i = this.falling.length - 1; i >= 0; i--) {
            const h = this.falling[i];
            h.y += dt / HAIL_DROP_INTERVAL_PER_ROW_MS;
            if (h.y >= h.targetR) {
                if (landHailDrop(state, h)) hooks.onPlacedCell?.(h.targetR, h.targetC);
                this.falling.splice(i, 1);
                landed++;
            }
        }

        // Storm done?
        if (this.pendingDrops === 0 && this.queue.length === 0 && this.falling.length === 0) {
            this.finish(hooks);
        }
        return landed;
    }

    /** Caller invokes this once per NORMAL piece lock. When the counter ticks
     *  to zero, every placed hail evaporates and the colored cells above each
     *  hail column drop down to fill the gap (see `evaporateHailPerColumn`). */
    tickLifeOnPieceLock(state: BoardState, hooks: HailHooks = {}): void {
        if (this.lifeRemaining <= 0) return;
        this.lifeRemaining--;
        if (this.lifeRemaining > 0) return;
        evaporateHailPerColumn(state);
        hooks.onEvaporate?.();
    }

    reset(): void {
        this.mode = false;
        this.lifeRemaining = 0;
        this.queue.length = 0;
        this.falling.length = 0;
        this.pendingDrops = 0;
        this.spawnAccum = 0;
    }

    /** Render-side read of the active in-flight drops. */
    getFalling(): ReadonlyArray<FallingDrop> {
        return this.falling;
    }

    private finish(hooks: HailHooks): void {
        this.mode = false;
        this.lifeRemaining = HAIL_LIFE_PIECES;
        this.queue.length = 0;
        this.falling.length = 0;
        this.pendingDrops = 0;
        this.spawnAccum = 0;
        hooks.onFinish?.();
    }
}

// ---------- helpers ----------

/** Per-column, find every empty cell that sits above the column's topmost
 *  non-null cell. Sort lowest-row first (within a row, shuffled). Take the
 *  first `maxCount` after sorting. */
export function computeHailTargets(state: BoardState, maxCount: number): Array<{ r: number; c: number }> {
    const eligible: Array<{ r: number; c: number }> = [];
    for (let c = 0; c < COLS; c++) {
        let topNonNull = state.board.length;
        for (let r = 0; r < state.board.length; r++) {
            if (state.board[r][c]) { topNonNull = r; break; }
        }
        // Rows 0 .. topNonNull-1 are eligible (all empty above the topmost block).
        for (let r = topNonNull - 1; r >= 0; r--) {
            eligible.push({ r, c });
        }
    }
    eligible.sort((a, b) => {
        if (b.r !== a.r) return b.r - a.r;       // lowest row first
        return Math.random() - 0.5;              // shuffle within a row
    });
    return eligible.slice(0, maxCount);
}

/** Place one hail drop. Returns true if a cell was placed. */
function landHailDrop(state: BoardState, h: FallingDrop): boolean {
    const r = h.targetR, c = h.targetC;
    // Defence-in-depth: if something occupied the target between scheduling
    // and landing (another fast clear shifted cells), try to slide down to
    // the lowest empty cell in this column.
    if (state.board[r] && state.board[r][c]) {
        let slot = -1;
        for (let rr = state.board.length - 1; rr >= 0; rr--) {
            if (!state.board[rr][c]) { slot = rr; break; }
        }
        if (slot === -1) return false;
        placeHailCell(state, slot, c);
        return true;
    }
    placeHailCell(state, r, c);
    return true;
}

function placeHailCell(state: BoardState, r: number, c: number): void {
    state.board[r][c] = 'H';
    if (!state.boardHailPlaced) {
        // Late-init the placed array on first land (it's expected for level mode
        // but `emptyEndlessBoardState` leaves it null — defensive).
        state.boardHailPlaced = [];
        for (let i = 0; i < state.board.length; i++) {
            state.boardHailPlaced.push(new Array(COLS).fill(null));
        }
    }
    state.boardHailPlaced[r][c] = true;
}
