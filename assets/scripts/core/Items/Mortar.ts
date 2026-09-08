/**
 * Mortar (灰泥) magic item — fills every empty cell whose 4-neighbours
 * (with cylinder column wrap) include at least one colored cell, with
 * the fill colour matching the first colored neighbour found.
 *
 * Visually, the cells don't pop in instantly — they rain down hail
 * style. Activation captures the fill plan against the board snapshot
 * at trigger time and queues one colored drop per target. Each drop
 * spawns at `y = -3 - random offset`, falls at `MORTAR_DROP_INTERVAL_PER_ROW_MS`
 * and stamps its colour onto the board when its `y` reaches `targetR`.
 *
 * Reserved 'X' and hail 'H' cells are left alone — mortar only paints
 * into truly-null cells.
 */

import {
    COLS,
    MORTAR_DROP_INTERVAL_PER_ROW_MS,
    MORTAR_SPAWN_STAGGER_MS,
    BAG_TYPES,
    CellValue,
} from '../Constants';
import { BoardState, MortarDrop } from '../Types';
import { isColoredCell } from '../Board';

export interface MortarHooks {
    /** Storm finished — caller resumes piece spawn. */
    onFinish?(): void;
    /** Fired when a drop lands. (Renderer FX hook, optional.) */
    onPlacedCell?(r: number, c: number, color: CellValue): void;
}

export class MortarState {
    /** While `true`, piece play is frozen and the rain is in flight. */
    mode = false;

    private queue:     Array<{ r: number; c: number; color: CellValue }> = [];
    private falling:   MortarDrop[]                                       = [];
    private spawnAccum = 0;

    /** Caller computed the fill plan; this just queues it and flips the
     *  storm flag. Returns true if anything was queued (caller can use
     *  the return to decide whether to consume the item). */
    activate(plan: Array<{ r: number; c: number; color: CellValue }>): boolean {
        if (!plan.length) return false;
        this.mode = true;
        for (const t of plan) this.queue.push(t);
        return true;
    }

    /** Frame tick. `dt` in ms. Returns the number of drops that landed. */
    tick(dt: number, state: BoardState, hooks: MortarHooks = {}): number {
        if (!this.mode) return 0;
        let landed = 0;

        // Stagger spawns so the wall builds up rather than dumping.
        this.spawnAccum += dt;
        while (this.spawnAccum >= MORTAR_SPAWN_STAGGER_MS && this.queue.length > 0) {
            this.spawnAccum -= MORTAR_SPAWN_STAGGER_MS;
            const t = this.queue.shift()!;
            this.falling.push({
                col:     t.c,
                y:       -3 - Math.random() * 12,
                targetR: t.r,
                targetC: t.c,
                color:   t.color,
            });
        }

        for (let i = this.falling.length - 1; i >= 0; i--) {
            const m = this.falling[i];
            m.y += dt / MORTAR_DROP_INTERVAL_PER_ROW_MS;
            if (m.y >= m.targetR) {
                // Defence-in-depth: if the target cell got filled by
                // some other path between activation and landing, just
                // drop the drop silently rather than over-writing.
                if (state.board[m.targetR] && state.board[m.targetR][m.targetC] === null) {
                    state.board[m.targetR][m.targetC] = m.color;
                    hooks.onPlacedCell?.(m.targetR, m.targetC, m.color);
                }
                this.falling.splice(i, 1);
                landed++;
            }
        }

        if (this.queue.length === 0 && this.falling.length === 0) {
            this.finish(hooks);
        }
        return landed;
    }

    reset(): void {
        this.mode = false;
        this.queue.length = 0;
        this.falling.length = 0;
        this.spawnAccum = 0;
    }

    getFalling(): ReadonlyArray<MortarDrop> {
        return this.falling;
    }

    private finish(hooks: MortarHooks): void {
        this.mode = false;
        this.queue.length = 0;
        this.falling.length = 0;
        this.spawnAccum = 0;
        hooks.onFinish?.();
    }
}

/** Pure plan computation — scan the board and decide where mortar
 *  drops should land + what colour they'll be.
 *
 *  Rule (iterate from colored cells, applied to convergence):
 *    For every coloured cell, if the cell DIRECTLY BELOW it is empty,
 *    paint it with that colour. Repeat until no fills happen. With
 *    iteration, each colored cell's column drips downward through
 *    every empty cell underneath it until it hits something non-empty
 *    (another colour, gray reserved, hail, or the bottom edge).
 *
 *  We simulate the fills on a board snapshot so freshly-painted cells
 *  become the next pass's "drippers".
 *
 *  Exported so the caller can no-op the item activation when there's
 *  nothing fillable. */
export function computeMortarPlan(
    state: BoardState,
    // Kept in the signature for backwards-compat with the existing
    // GameState caller. Ignored now — the reserved zone used to be a
    // no-drip barrier; that restriction was lifted so mortar can fill
    // designer-authored holes in the gray foundation too.
    _reservedHeight: number = 0,
): Array<{ r: number; c: number; color: CellValue }> {
    const H = state.board.length;
    // Mutable snapshot — fills here become the next pass's drippers.
    const sim: (CellValue | null)[][] = state.board.map(row => row.slice());
    const plan: Array<{ r: number; c: number; color: CellValue }> = [];

    let added = true;
    while (added) {
        added = false;
        for (let r = 0; r < H; r++) {
            for (let c = 0; c < COLS; c++) {
                const v = sim[r][c];
                if (!isColoredCell(v)) continue;
                if (r + 1 >= H) continue;
                if (sim[r + 1][c] !== null) continue;      // below must be empty
                plan.push({ r: r + 1, c, color: v as CellValue });
                sim[r + 1][c] = v;
                added = true;
            }
        }
    }
    return plan;
}

/** Bottom-up fill plan — fills empty cells starting from the BOTTOM
 *  of the board upward, up to `cap` targets. Used both as
 *    1. TOP-UP for {@link computeMortarPlan} whenever the drip rule
 *       yields fewer than `cap` targets (e.g. only 2 gaps drip-eligible
 *       but mortar15 wants 15), so mortar always delivers its promised
 *       block count as long as the board has room; and
 *    2. STANDALONE fallback when the drip rule finds nothing (fresh
 *       endless board, flat foundation etc).
 *
 *  `exclude` lets the caller pass cells already targeted by the drip
 *  plan so they aren't double-scheduled. Keys are "r,c" strings.
 *
 *  Colour pick: inherits the first colored cell found anywhere on the
 *  board (consistency with the dripping rule's spirit). If the board
 *  has zero colored cells, picks `fallbackColor` (defaults to a random
 *  standard tetromino type via `rng`).
 *
 *  Both 'X' (gray reserved) and 'H' (hail) cells are treated as
 *  occupied — fillable cells are the strict-null subset. */
export function computeMortarFallbackPlan(
    state: BoardState,
    cap: number,
    rng: () => number = Math.random,
    fallbackColor?: CellValue,
    exclude?: ReadonlySet<string>,
    // Kept for backwards-compat with the GameState caller; ignored now
    // — the reserved-zone barrier was removed so mortar fills any empty
    // cell top-down, including holes in the gray foundation.
    _reservedHeight: number = 0,
): Array<{ r: number; c: number; color: CellValue }> {
    if (cap <= 0) return [];
    const H = state.board.length;
    // Pick the fill colour: first colored cell on the board, otherwise
    // a random standard tetromino type (so the mortar still does
    // something visible when the board is completely empty).
    let color: CellValue | null = null;
    for (let r = 0; r < H && color === null; r++) {
        for (let c = 0; c < COLS; c++) {
            if (isColoredCell(state.board[r][c])) {
                color = state.board[r][c];
                break;
            }
        }
    }
    if (color === null) {
        color = fallbackColor
            ?? (BAG_TYPES[Math.floor(rng() * BAG_TYPES.length)] as CellValue);
    }

    // Two-pass fill (bottom-up in each pass) to PICK which rows the
    // mortar wants to serve:
    //   Pass 1 — rows that contain any colored cell.
    //   Pass 2 — rows that are gray-only ('X' present, no colored).
    //   Empty rows are never TARGETED here, but a targeted drop may
    //   still fall THROUGH an empty row below during the resting-
    //   position adjustment at the end.
    const targets: Array<{ r: number; c: number; color: CellValue }> = [];
    const fillRow = (r: number) => {
        for (let c = 0; c < COLS && targets.length < cap; c++) {
            if (state.board[r][c] !== null) continue;
            if (exclude && exclude.has(`${r},${c}`)) continue;
            targets.push({ r, c, color: color as CellValue });
        }
    };
    // Pass 1 — colored rows, bottom-up.
    for (let r = H - 1; r >= 0 && targets.length < cap; r--) {
        let hasColored = false;
        for (let c = 0; c < COLS; c++) {
            if (isColoredCell(state.board[r][c])) { hasColored = true; break; }
        }
        if (hasColored) fillRow(r);
    }
    // Pass 2 — gray-only rows, bottom-up.
    if (targets.length < cap) {
        for (let r = H - 1; r >= 0 && targets.length < cap; r--) {
            let hasColored = false, hasGray = false;
            for (let c = 0; c < COLS; c++) {
                const v = state.board[r][c];
                if (isColoredCell(v)) { hasColored = true; break; }
                if (v === 'X') hasGray = true;
            }
            if (!hasColored && hasGray) fillRow(r);
        }
    }
    // Resting-position pass — for each target, drop the intended row
    // DOWN to the lowest empty cell in the same column at-or-below it.
    // Otherwise a mortar drop aimed at a colored row above an empty
    // one (or above a gray row that has holes below) would sit
    // floating on top of the empty space. Claimed cells stack so
    // multiple drops in the same column pile up correctly.
    const claimed = new Set<string>();
    if (exclude) for (const k of exclude) claimed.add(k);
    const plan: Array<{ r: number; c: number; color: CellValue }> = [];
    for (const t of targets) {
        let finalR = t.r;
        for (let r = t.r + 1; r < H; r++) {
            if (state.board[r][t.c] !== null) break;
            if (claimed.has(`${r},${t.c}`))    break;
            finalR = r;
        }
        claimed.add(`${finalR},${t.c}`);
        plan.push({ r: finalR, c: t.c, color: t.color });
    }
    return plan;
}
