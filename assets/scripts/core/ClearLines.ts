/**
 * Full-row detection, stone HP handling, and the splice/unshift pipeline.
 *
 * Algorithm:
 *   1. Find every row whose cells are ALL non-null AND not hail ('H').
 *      Hail blocks intentionally do not contribute to "completing" a row;
 *      they only evaporate on the 3-piece timer.
 *   2. For each candidate row, decrement any stone HPs. Rows with at least
 *      one surviving stone stay in place but their non-stone cells null out
 *      (partial clear). Rows with no surviving stone get spliced (full clear).
 *   3. Before splicing, fire prop hooks (chest / meteor / blizzard / wrecker /
 *      hail / rocket) for every prop sitting in a soon-to-be-discarded row.
 *   4. Splice + unshift to keep the array length stable.
 *   5. If any partial rows existed, run column gravity to settle hanging cells.
 *   6. Run the post-clear orphan-prop pass — props whose host cell got nulled
 *      by a partial clear (not splice) need their hooks fired too.
 *
 * Score / line counting is intentionally NOT done here — the caller knows the
 * speed tier and game mode.
 */

import { COLS, CellValue } from './Constants';
import { BoardState, BombKind, StoneHP, BoomLevel } from './Types';
import { applyDiagonalGravity, CellFallMove } from './ColumnGravity';
import { activateBoom, processClearedBooms } from './Items/Boom';
export { processClearedBooms } from './Items/Boom';

export interface ItemTriggerHooks {
    onChestTriggered?(r: number, c: number): void;
    onMeteorTriggered?(r: number, c: number): void;
    onBlizzardTriggered?(r: number, c: number): void;
    onWreckerTriggered?(r: number, c: number): void;
    onHailTriggered?(r: number, c: number): void;
    onRocketTriggered?(r: number, c: number): void;
    onGatlingTriggered?(r: number, c: number): void;
    onBoomTriggered?(r: number, c: number, level: 1 | 2 | 3, cleared: Array<{ r: number; c: number }>): void;
}

export interface ClearLinesHooks extends ItemTriggerHooks {
    /** Called once per partially-cleared row so the renderer can spawn debris. */
    onPartialShatter?(r: number, content: ReadonlyArray<CellValue | null>): void;
    /** Called once per full pipeline run if at least one row was cleared. */
    onClearSound?(intensity: number): void;
    /** Called once per clearing operation with the list of cells that
     *  diagonal-gravity moved. The renderer uses this to play a falling
     *  animation between the fromR and toR for each entry instead of
     *  teleporting cubes to their new positions. */
    onCellsFell?(moves: ReadonlyArray<CellFallMove>): void;
    /** Wrecker fired — these are the cells it's about to demolish. The
     *  renderer plays a pre-pulse flash on them, then the GameState
     *  commits the actual clear (via `commitPendingWreckerPlans`) after
     *  the pulse window. */
    onWreckerPrePulse?(picks: ReadonlyArray<{ r: number; c: number; color: CellValue }>): void;
    /** Wrecker (plain sweep, no directional-bomb combo) — fired in
     *  place of the per-row `onPartialShatter`. Tells the renderer
     *  to play a PER-CELL shatter at each pick, not a horizontal row
     *  flash, so a sparse 10-cell sweep doesn't look like 10 full
     *  rows lit up across the cylinder. */
    onWreckerPicksShatter?(picks: ReadonlyArray<{ r: number; c: number; color: CellValue }>): void;
}

export interface ClearLinesResult {
    /** Count of rows fully spliced out (the basis for scoring + line stats). */
    fullyCleared: number;
    /** Count of rows that partially cleared but had surviving stones. */
    partialCount: number;
}

/**
 * Mutates `state` in place; returns counts so the caller can update score.
 */
export function clearLines(
    state: BoardState,
    reservedTop: number,
    hooks: ClearLinesHooks = {},
): ClearLinesResult {
    // 1. Detect candidate rows (descending so split operations stay valid).
    const candidates: number[] = [];
    for (let r = state.board.length - 1; r >= 0; r--) {
        let full = true;
        for (let c = 0; c < COLS; c++) {
            const v = state.board[r][c];
            if (v === null || v === 'H') { full = false; break; }
        }
        if (full) candidates.push(r);
    }
    if (!candidates.length) return { fullyCleared: 0, partialCount: 0 };

    // 2. Stones — decrement, partition into "partial" vs "splice".
    const rowsToPartial: number[] = [];
    const rowsToSplice: number[] = [];
    for (const r of candidates) {
        let hasSurvivingStone = false;
        if (state.boardStones && state.boardStones[r]) {
            for (let c = 0; c < COLS; c++) {
                const hp = state.boardStones[r][c];
                if (hp !== null && hp > 0) {
                    const next = (hp - 1) as (0 | StoneHP);
                    state.boardStones[r][c] = next > 0 ? (next as StoneHP) : null;
                    if (next > 0) hasSurvivingStone = true;
                }
            }
        }
        if (hasSurvivingStone) rowsToPartial.push(r);
        else                   rowsToSplice.push(r);
    }

    // 3. Partial clears: null non-stone cells (and matching bomb markers).
    for (const r of rowsToPartial) {
        const content: (CellValue | null)[] = new Array(COLS).fill(null);
        for (let c = 0; c < COLS; c++) {
            const hasStone = state.boardStones && state.boardStones[r] && state.boardStones[r][c] !== null;
            if (!hasStone) {
                content[c] = state.board[r][c];
                state.board[r][c] = null;
                if (state.boardBombs && state.boardBombs[r]) state.boardBombs[r][c] = null;
            }
        }
        hooks.onPartialShatter?.(r, content);
    }

    // 4. Trigger props sitting in soon-to-be-spliced rows.
    fireRowProps(state, rowsToSplice, hooks);

    // 4b. Shatter visuals for fully-cleared rows — same hook the renderer
    //     uses for partial clears, fired with the row's contents before
    //     it's removed. (Without this only stone-hit rows ever burst.)
    if (hooks.onPartialShatter) {
        for (const r of rowsToSplice) {
            const content: (CellValue | null)[] = state.board[r].slice();
            hooks.onPartialShatter(r, content);
        }
    }

    // 5. Splice + unshift to keep array length stable. Returns the cells
    //    whose array index changed — the renderer animates the visible
    //    "everything above the cleared row falls by N" so the player
    //    sees the structure drop instead of teleporting.
    const spliceMoves = spliceRows(state, rowsToSplice);

    // 6. Diagonal-support gravity. Splice already handled the bulk of
    //    the drop; this catches residual floaters (partial clears, col
    //    blasts, sparse wrecker picks, etc.).
    const fellMoves = applyDiagonalGravity(state, reservedTop);
    const allMoves = spliceMoves.concat(fellMoves);
    if (allMoves.length && hooks.onCellsFell) hooks.onCellsFell(allMoves);

    // 7. Orphan-prop pass — partial clears null the host but keep the prop.
    processClearedChests(state, hooks);
    processClearedMeteors(state, hooks);
    processClearedBlizzards(state, hooks);
    processClearedWreckers(state, hooks);
    processClearedHails(state, hooks);
    processClearedRockets(state, hooks);
    processClearedGatlings(state, hooks);
    processClearedBooms(state, {
        onBoomActivated: (r, c, level, cleared) => hooks.onBoomTriggered?.(r, c, level, cleared),
    });

    // Second gravity pass — booms punch NEW holes in the interior of
    // the tower on their way out (each boom's diamond blast happens
    // AFTER the step-6 gravity above), so cells sitting on top of a
    // boom-cleared cell stay floating without another sweep. The
    // other prop chains (chest / meteor / blizzard / wrecker / hail /
    // rocket / gatling) either don't clear cells themselves or run
    // their own gravity inline (wrecker), so booms are the one that
    // needs this catch-up pass here.
    //
    // Pass reservedTop = state.board.length so falling cells drop
    // ALL THE WAY to the true bottom (through any nulls the boom
    // punched into the reserved foundation). 'X' cells in the
    // reserved zone still act as obstacles — falling cells stack on
    // them — so an intact foundation catches drops at its top edge
    // just like before.
    const boomFellMoves = applyDiagonalGravity(state, state.board.length);
    if (boomFellMoves.length && hooks.onCellsFell) hooks.onCellsFell(boomFellMoves);

    if (rowsToSplice.length > 0 || rowsToPartial.length > 0) {
        hooks.onClearSound?.(1);
    }

    return { fullyCleared: rowsToSplice.length, partialCount: rowsToPartial.length };
}

// ---------- internal helpers ----------

/** Fire prop hooks for every prop sitting in the given rows. Nulls the prop
 *  AFTER calling the hook so the hook still sees the prop value if it cares. */
function fireRowProps(state: BoardState, rows: number[], hooks: ItemTriggerHooks): void {
    if (state.boardChests) {
        for (const r of rows) {
            for (let c = 0; c < COLS; c++) {
                if (state.boardChests[r] && state.boardChests[r][c]) {
                    state.boardChests[r][c] = null;
                    hooks.onChestTriggered?.(r, c);
                }
            }
        }
    }
    if (state.boardMeteors) {
        for (const r of rows) {
            for (let c = 0; c < COLS; c++) {
                if (state.boardMeteors[r] && state.boardMeteors[r][c]) {
                    state.boardMeteors[r][c] = null;
                    hooks.onMeteorTriggered?.(r, c);
                }
            }
        }
    }
    if (state.boardBlizzards) {
        for (const r of rows) {
            for (let c = 0; c < COLS; c++) {
                if (state.boardBlizzards[r] && state.boardBlizzards[r][c]) {
                    state.boardBlizzards[r][c] = null;
                    hooks.onBlizzardTriggered?.(r, c);
                }
            }
        }
    }
    if (state.boardWreckers) {
        for (const r of rows) {
            for (let c = 0; c < COLS; c++) {
                if (state.boardWreckers[r] && state.boardWreckers[r][c]) {
                    state.boardWreckers[r][c] = null;
                    hooks.onWreckerTriggered?.(r, c);
                }
            }
        }
    }
    if (state.boardHails) {
        for (const r of rows) {
            for (let c = 0; c < COLS; c++) {
                if (state.boardHails[r] && state.boardHails[r][c]) {
                    state.boardHails[r][c] = null;
                    hooks.onHailTriggered?.(r, c);
                }
            }
        }
    }
    if (state.boardRockets) {
        for (const r of rows) {
            for (let c = 0; c < COLS; c++) {
                if (state.boardRockets[r] && state.boardRockets[r][c]) {
                    state.boardRockets[r][c] = null;
                    hooks.onRocketTriggered?.(r, c);
                }
            }
        }
    }
    if (state.boardGatlings) {
        for (const r of rows) {
            for (let c = 0; c < COLS; c++) {
                if (state.boardGatlings[r] && state.boardGatlings[r][c]) {
                    state.boardGatlings[r][c] = null;
                    hooks.onGatlingTriggered?.(r, c);
                }
            }
        }
    }
    // Booms in to-be-spliced rows must fire BEFORE splice — otherwise the
    // row data goes away with the splice/unshift and `processClearedBooms`
    // has nothing to find.
    if (state.boardBooms) {
        for (const r of rows) {
            for (let c = 0; c < COLS; c++) {
                const lvl = state.boardBooms[r] && state.boardBooms[r][c];
                if (lvl) {
                    state.boardBooms[r][c] = null;
                    const cleared = activateBoom(state, r, c, lvl);
                    hooks.onBoomTriggered?.(r, c, lvl, cleared);
                }
            }
        }
    }
}

/** Splice the listed rows out of every parallel array, then unshift the same
 *  number of empty rows at the top so the array length stays constant.
 *  Returns the list of cells that effectively moved (their new index is
 *  `fromR + shift`, where `shift` = number of spliced rows above them).
 *  The render layer plays this as an animated fall instead of teleporting. */
export function spliceRows(state: BoardState, rowsDesc: number[]): CellFallMove[] {
    const moves: CellFallMove[] = [];
    if (!rowsDesc.length) return moves;
    // Snapshot moves BEFORE mutating — every non-null cell at row r that
    // SURVIVES the splice (i.e., r is not in `rowsDesc`) shifts down by
    // `numSpliced - (count of spliced rows < r)`. Cells below all the
    // spliced rows have shift = 0 and aren't included.
    const numSpliced = rowsDesc.length;
    const splicedSet = new Set(rowsDesc);
    for (let r = 0; r < state.board.length; r++) {
        if (splicedSet.has(r)) continue;
        let countBelow = 0;
        for (const sr of rowsDesc) if (sr < r) countBelow++;
        const shift = numSpliced - countBelow;
        if (shift === 0) continue;
        for (let c = 0; c < COLS; c++) {
            const v = state.board[r][c];
            if (v && v !== 'H') moves.push({ fromR: r, toR: r + shift, c });
        }
    }
    // The caller passes rows in descending order so splice indices stay valid.
    for (const r of rowsDesc) {
        state.board.splice(r, 1);
        if (state.boardBombs)      state.boardBombs.splice(r, 1);
        if (state.boardStones)     state.boardStones.splice(r, 1);
        if (state.boardChests)     state.boardChests.splice(r, 1);
        if (state.boardMeteors)    state.boardMeteors.splice(r, 1);
        if (state.boardBlizzards)  state.boardBlizzards.splice(r, 1);
        if (state.boardWreckers)   state.boardWreckers.splice(r, 1);
        if (state.boardHails)      state.boardHails.splice(r, 1);
        if (state.boardHailPlaced) state.boardHailPlaced.splice(r, 1);
        if (state.boardRockets)    state.boardRockets.splice(r, 1);
        if (state.boardGatlings)   state.boardGatlings.splice(r, 1);
        if (state.boardBooms)      state.boardBooms.splice(r, 1);
    }
    for (let i = 0; i < rowsDesc.length; i++) {
        state.board.unshift(new Array<CellValue | null>(COLS).fill(null));
        if (state.boardBombs)      state.boardBombs.unshift(new Array<BombKind | null>(COLS).fill(null));
        if (state.boardStones)     state.boardStones.unshift(new Array<StoneHP | null>(COLS).fill(null));
        if (state.boardChests)     state.boardChests.unshift(new Array<true | null>(COLS).fill(null));
        if (state.boardMeteors)    state.boardMeteors.unshift(new Array<true | null>(COLS).fill(null));
        if (state.boardBlizzards)  state.boardBlizzards.unshift(new Array<true | null>(COLS).fill(null));
        if (state.boardWreckers)   state.boardWreckers.unshift(new Array<true | null>(COLS).fill(null));
        if (state.boardHails)      state.boardHails.unshift(new Array<true | null>(COLS).fill(null));
        if (state.boardHailPlaced) state.boardHailPlaced.unshift(new Array<true | null>(COLS).fill(null));
        if (state.boardRockets)    state.boardRockets.unshift(new Array<true | null>(COLS).fill(null));
        if (state.boardGatlings)   state.boardGatlings.unshift(new Array<true | null>(COLS).fill(null));
        if (state.boardBooms)      state.boardBooms.unshift(new Array<BoomLevel | null>(COLS).fill(null));
    }
    return moves;
}

// ---------- orphan-prop passes ----------

/** Any chest whose host cell is now empty → trigger and clear. */
export function processClearedChests(state: BoardState, hooks: ItemTriggerHooks): void {
    if (!state.boardChests) return;
    for (let r = 0; r < state.board.length; r++) {
        if (!state.boardChests[r]) continue;
        for (let c = 0; c < COLS; c++) {
            if (state.boardChests[r][c] && !state.board[r][c]) {
                state.boardChests[r][c] = null;
                hooks.onChestTriggered?.(r, c);
            }
        }
    }
}
export function processClearedMeteors(state: BoardState, hooks: ItemTriggerHooks): void {
    if (!state.boardMeteors) return;
    for (let r = 0; r < state.board.length; r++) {
        if (!state.boardMeteors[r]) continue;
        for (let c = 0; c < COLS; c++) {
            if (state.boardMeteors[r][c] && !state.board[r][c]) {
                state.boardMeteors[r][c] = null;
                hooks.onMeteorTriggered?.(r, c);
            }
        }
    }
}
export function processClearedBlizzards(state: BoardState, hooks: ItemTriggerHooks): void {
    if (!state.boardBlizzards) return;
    for (let r = 0; r < state.board.length; r++) {
        if (!state.boardBlizzards[r]) continue;
        for (let c = 0; c < COLS; c++) {
            if (state.boardBlizzards[r][c] && !state.board[r][c]) {
                state.boardBlizzards[r][c] = null;
                hooks.onBlizzardTriggered?.(r, c);
            }
        }
    }
}
/** Wrecker can chain through other wreckers (its hook clears more cells,
 *  some of which can host more wreckers). Re-scan until stable. */
export function processClearedWreckers(state: BoardState, hooks: ItemTriggerHooks): void {
    if (!state.boardWreckers) return;
    let progress = true;
    while (progress) {
        progress = false;
        for (let r = 0; r < state.board.length; r++) {
            if (!state.boardWreckers[r]) continue;
            for (let c = 0; c < COLS; c++) {
                if (state.boardWreckers[r][c] && !state.board[r][c]) {
                    state.boardWreckers[r][c] = null;
                    hooks.onWreckerTriggered?.(r, c);
                    progress = true;
                }
            }
        }
    }
}
export function processClearedHails(state: BoardState, hooks: ItemTriggerHooks): void {
    if (!state.boardHails) return;
    for (let r = 0; r < state.board.length; r++) {
        if (!state.boardHails[r]) continue;
        for (let c = 0; c < COLS; c++) {
            if (state.boardHails[r][c] && !state.board[r][c]) {
                state.boardHails[r][c] = null;
                hooks.onHailTriggered?.(r, c);
            }
        }
    }
}
export function processClearedRockets(state: BoardState, hooks: ItemTriggerHooks): void {
    if (!state.boardRockets) return;
    for (let r = 0; r < state.board.length; r++) {
        if (!state.boardRockets[r]) continue;
        for (let c = 0; c < COLS; c++) {
            if (state.boardRockets[r][c] && !state.board[r][c]) {
                state.boardRockets[r][c] = null;
                hooks.onRocketTriggered?.(r, c);
            }
        }
    }
}
export function processClearedGatlings(state: BoardState, hooks: ItemTriggerHooks): void {
    if (!state.boardGatlings) return;
    for (let r = 0; r < state.board.length; r++) {
        if (!state.boardGatlings[r]) continue;
        for (let c = 0; c < COLS; c++) {
            if (state.boardGatlings[r][c] && !state.board[r][c]) {
                state.boardGatlings[r][c] = null;
                hooks.onGatlingTriggered?.(r, c);
            }
        }
    }
}
