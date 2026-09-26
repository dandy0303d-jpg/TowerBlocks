/**
 * Unified bomb-chain processor.
 *
 * Given a set of seed bombs (each a `{r, c, kind}`), we explode them and chain
 * through every board-level bomb whose row or column intersects the affected
 * region. Row bombs clear their row + chain horizontally. Column bombs clear
 * their column + chain vertically. The two interact freely.
 *
 *   Row bomb of count N → bombRowRange(r, N) rows are fully spliced. Every
 *                         bomb sitting in those rows joins the queue.
 *   Col bomb of count N → bombColRange(c, N) columns are blasted from top to
 *                         the reserved zone (column blasts do NOT splice; they
 *                         null the cells in place). Every bomb in those cols
 *                         joins the queue.
 *
 * After the chain queue drains we:
 *   - Trigger props sitting in splice rows
 *   - Splice + unshift those rows
 *   - applyColumnGravity to settle anything left dangling above col blasts
 *   - Run the post-clear orphan-prop pass
 */

import { COLS, CellValue } from './Constants';
import { BoardState, BombKind, StoneHP, BoomLevel } from './Types';
import { parseBombKind, bombRowRange, bombColRange, bombBox3Cells } from './Bombs';
import { activateBoom, processClearedBooms } from './Items/Boom';
import { applyDiagonalGravity } from './ColumnGravity';
import {
    ClearLinesHooks,
    spliceRows,
    processClearedChests,
    processClearedMeteors,
    processClearedBlizzards,
    processClearedWreckers,
    processClearedHails,
    processClearedRockets,
    processClearedGatlings,
} from './ClearLines';

export interface BombSeed {
    r:    number;
    c:    number;
    kind: BombKind;
}

export interface DetonateHooks extends ClearLinesHooks {
    /** Called once per detonation pass — used to schedule sound/particles. */
    onDetonationStart?(): void;
    /** Fires once for each ROW that is cleared by a row bomb in this
     *  detonation pass. Used by the renderer to spawn the rainbow-ribbon
     *  sweep at that row's height. */
    onRowBombDetonate?(r: number, tier: 1 | 2 | 3 | 4): void;
    /** Fires once for each COLUMN that is cleared by a column bomb in
     *  this detonation pass. `r` is the anchor row of the FIRST col
     *  bomb seed that triggered this column (so the renderer has a
     *  height to spawn its visual at). `tier` is the max tier (1..4)
     *  of any col bomb that contributed this column — GameController
     *  uses it to gate the screen-shake on ≥ level 3 blasts. */
    onColBombDetonate?(r: number, c: number, tier: 1 | 2 | 3 | 4): void;
    /** Fires ONCE PER CELL that a `box3` area bomb clears — up to 9
     *  invocations per bomb (some may be culled by row-clip / splice
     *  overlap). The renderer plays a small per-cell explosion at
     *  each (r, c) so the 3×3 area reads as nine individual pops
     *  rather than one big flash. Anchor cell (`isAnchor=true`) is
     *  the bomb's origin — the renderer can optionally play a
     *  slightly bigger burst there. */
    onBoxBombDetonate?(r: number, c: number, isAnchor: boolean): void;
}

export function detonateBombs(
    state: BoardState,
    seeds: BombSeed[],
    reservedTop: number,
    hooks: DetonateHooks = {},
): void {
    if (!seeds || !seeds.length) return;
    if (!state.boardBombs) return;

    hooks.onDetonationStart?.();

    const rowBombRows = new Set<number>();
    const colBombCols = new Set<number>();
    /** Per-column: the anchor row of the FIRST col-bomb seed that hit it.
     *  Passed to onColBombDetonate so visuals have a meaningful Y. */
    const colBombFirstRow = new Map<number, number>();
    /** Per-row / per-col max tier (1..4) of any row/col bomb that
     *  contributed. Passed to the detonate hooks so GameController
     *  can gate the screen-shake on ≥ level 3 blasts. */
    const rowBombTier = new Map<number, number>();
    const colBombTier = new Map<number, number>();
    /** Cells cleared by `box3` area bombs. `${r}-${c}` string keys so we
     *  dedupe across overlapping box bombs cleanly. Anchor points fed to
     *  onBoxBombDetonate live in a parallel array so we can fire one FX
     *  per bomb (not per cell). */
    const boxCells   = new Set<string>();
    const boxAnchors: Array<{ r: number; c: number }> = [];
    const triggered   = new Set<string>();   // `${r}-${c}-${kind}` to avoid double-chain
    const queue: BombSeed[]  = seeds.slice();

    while (queue.length) {
        const bomb = queue.shift()!;
        const key = `${bomb.r}-${bomb.c}-${bomb.kind}`;
        if (triggered.has(key)) continue;
        triggered.add(key);

        // Backpack area bomb — 3×3 same-layer at the bomb's cell.
        // Handled specially since parseBombKind returns null for it
        // (the row/col count math doesn't apply to a box axis).
        if (bomb.kind === 'box3') {
            boxAnchors.push({ r: bomb.r, c: bomb.c });
            const cells = bombBox3Cells(bomb.r, bomb.c);
            for (const cell of cells) {
                if (cell.r < 0 || cell.r >= state.board.length) continue;
                boxCells.add(`${cell.r}-${cell.c}`);
                // Chain into any other bomb sitting in this cell.
                const k = state.boardBombs[cell.r]?.[cell.c];
                if (k) queue.push({ r: cell.r, c: cell.c, kind: k });
            }
            continue;
        }

        const parsed = parseBombKind(bomb.kind);
        if (!parsed) continue;

        if (parsed.axis === 'row') {
            const rows = bombRowRange(bomb.r, parsed.count);
            for (const r of rows) {
                if (r < 0 || r >= state.board.length) continue;
                rowBombRows.add(r);
                // Track the max tier that contributed this row —
                // GameController.onRowBombDetonate gates the screen
                // shake on tier ≥ 3.
                const prev = rowBombTier.get(r) ?? 0;
                if (parsed.count > prev) rowBombTier.set(r, parsed.count);
                // Chain into any other bomb sitting in this row.
                for (let c = 0; c < COLS; c++) {
                    const k = state.boardBombs[r]?.[c];
                    if (k) queue.push({ r, c, kind: k });
                }
            }
        } else {
            const cols = bombColRange(bomb.c, parsed.count);
            for (const c of cols) {
                colBombCols.add(c);
                if (!colBombFirstRow.has(c)) colBombFirstRow.set(c, bomb.r);
                const prev = colBombTier.get(c) ?? 0;
                if (parsed.count > prev) colBombTier.set(c, parsed.count);
                // Chain into any bomb sitting in this column (within play zone).
                for (let r = 0; r < reservedTop; r++) {
                    const k = state.boardBombs[r]?.[c];
                    if (k) queue.push({ r, c, kind: k });
                }
            }
        }
    }

    if (!rowBombRows.size && !colBombCols.size && !boxCells.size) return;

    // ---- Per-bomb FX hooks ----
    // Fire once for each unique row / column / box that was actually
    // affected, so the renderer can spawn its detonation visuals.
    if (hooks.onRowBombDetonate) {
        for (const r of rowBombRows) {
            const tier = (rowBombTier.get(r) ?? 1) as 1 | 2 | 3 | 4;
            hooks.onRowBombDetonate(r, tier);
        }
    }
    if (hooks.onColBombDetonate) {
        for (const c of colBombCols) {
            const r = colBombFirstRow.get(c) ?? 0;
            const tier = (colBombTier.get(c) ?? 1) as 1 | 2 | 3 | 4;
            hooks.onColBombDetonate(r, c, tier);
        }
    }
    if (hooks.onBoxBombDetonate) {
        // Fire once per cell so the renderer can play a small per-cell
        // explosion at each (r, c). Clip out-of-range rows here so
        // the renderer doesn't have to deal with negative Y — same
        // rule the row/col bomb hooks follow. Skip cells whose row
        // is being spliced whole (splice sweep already covers them).
        const H = state.board.length;
        for (const anchor of boxAnchors) {
            const cells = bombBox3Cells(anchor.r, anchor.c);
            for (const cell of cells) {
                if (cell.r < 0 || cell.r >= H) continue;
                if (rowBombRows.has(cell.r)) continue;   // row splice covers it
                const isAnchor = (cell.r === anchor.r && cell.c === anchor.c);
                hooks.onBoxBombDetonate(cell.r, cell.c, isAnchor);
            }
        }
    }

    // ---- Resolve what's actually cleared ----
    // Stones in the blast zone take ONE hit, not an instant kill. So we
    // partition row-bomb rows into:
    //   • "fully splice" — no stones, or every stone died from the hit
    //   • "partial"      — at least one stone survives (HP > 0 after −1)
    // and we handle column blasts cell-by-cell with the same HP rule.
    const rowsToFullySplice: number[] = [];
    const rowsToPartial:     number[] = [];
    for (const r of rowBombRows) {
        let anyStoneSurvives = false;
        if (state.boardStones && state.boardStones[r]) {
            for (let c = 0; c < COLS; c++) {
                const hp = state.boardStones[r][c];
                if (hp !== null && hp > 0) {
                    const next = (hp - 1) as 0 | StoneHP;
                    state.boardStones[r][c] = next > 0 ? (next as StoneHP) : null;
                    if (next > 0) anyStoneSurvives = true;
                }
            }
        }
        if (anyStoneSurvives) rowsToPartial.push(r);
        else                  rowsToFullySplice.push(r);
    }
    const splicedRowsDesc = rowsToFullySplice.sort((a, b) => b - a);
    const splicedSet = new Set(splicedRowsDesc);

    // FX: snapshot the spliced rows for shatter particles before we mutate.
    if (hooks.onPartialShatter) {
        for (const r of splicedRowsDesc) {
            const content: (CellValue | null)[] = new Array(COLS).fill(null);
            for (let c = 0; c < COLS; c++) content[c] = state.board[r][c];
            hooks.onPartialShatter(r, content);
        }
    }

    // Partial rows (a stone tanked the hit): null non-stone cells, leave
    // the surviving stone in place. Same shape as ClearLines' partial
    // path so the renderer's `onPartialShatter` fires identically.
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

    // Helper: is row `r` currently fully filled (treating null + 'H' as gaps)?
    // A col blast that lands on a row already-full would otherwise turn it
    // into 23-cell "not full", and `clearLines` would miss the natural row
    // clear. So we skip full rows here — clearLines runs right after and
    // splices them properly. (The bomb that triggered from such a row has
    // already fired its chain by the time we get here.)
    const isRowFull = (r: number): boolean => {
        for (let cc = 0; cc < COLS; cc++) {
            const v = state.board[r][cc];
            if (v === null || v === 'H') return false;
        }
        return true;
    };

    // Column blast: at each cell in [0, reservedTop) of the affected
    // columns, either decrement the stone (and keep the cell intact if
    // it survives) or null the cell normally. Skip cells in splicedSet
    // (they'll be removed wholesale by the splice path below) and cells
    // in currently-full rows (those become clearLines' job).
    for (const c of colBombCols) {
        for (let r = 0; r < reservedTop; r++) {
            if (splicedSet.has(r)) continue;
            if (isRowFull(r)) continue;
            if (state.board[r][c] === null) continue;
            const hp = state.boardStones && state.boardStones[r] ? state.boardStones[r][c] : null;
            if (hp !== null && hp > 0) {
                const next = (hp - 1) as 0 | StoneHP;
                if (next > 0) {
                    // Stone survives — keep the cell, do not null bombs/props.
                    state.boardStones![r][c] = next as StoneHP;
                    continue;
                }
                state.boardStones![r][c] = null;
                // Fall through: stone died this hit, null the cell.
            }
            state.board[r][c] = null;
            if (state.boardBombs && state.boardBombs[r]) state.boardBombs[r][c] = null;
            // Props (chests / meteors / blizzards / wreckers / hails / rockets)
            // are NOT touched here — processClearedXxx will catch them once
            // their host cell turns null below.
        }
    }

    // ---- box3 area-bomb per-cell nulls ----
    // Nine cells around each `box3` anchor. Same stone-HP rules as col
    // blast (stone tanks one hit; only nulls the cell if the stone dies
    // this hit). Skip cells caught in a splice row or currently-full
    // row so the splice / clearLines paths still see them intact.
    // Props sitting in these cells fire immediately — reuses the
    // per-cell prop-firing helper below.
    const boxCellCoords: Array<{ r: number; c: number }> = [];
    for (const key of boxCells) {
        const parts = key.split('-');
        const r = parseInt(parts[0], 10);
        const c = parseInt(parts[1], 10);
        boxCellCoords.push({ r, c });
        if (r < 0 || r >= state.board.length) continue;
        if (splicedSet.has(r)) continue;
        if (isRowFull(r)) continue;
        if (state.board[r][c] === null) continue;
        const hp = state.boardStones && state.boardStones[r] ? state.boardStones[r][c] : null;
        if (hp !== null && hp > 0) {
            const next = (hp - 1) as 0 | StoneHP;
            if (next > 0) {
                state.boardStones![r][c] = next as StoneHP;
                continue;
            }
            state.boardStones![r][c] = null;
        }
        state.board[r][c] = null;
        if (state.boardBombs && state.boardBombs[r]) state.boardBombs[r][c] = null;
    }
    // Fire any props (chest/meteor/blizzard/wrecker/hail/rocket/gatling)
    // sitting in the box cells. Uses the same per-cell null pattern as
    // fireRowProps but scoped to arbitrary (r, c) pairs.
    fireCellProps(state, boxCellCoords, hooks, reservedTop);

    // Trigger props sitting in soon-to-be-spliced rows.
    fireRowProps(state, splicedRowsDesc, hooks, reservedTop);

    // Splice the row-bomb rows (this is identical to clearLines' splice
    // path). The returned moves cover "everything above the spliced row
    // drops by N" so the row blast animates instead of teleporting.
    const spliceMoves = spliceRows(state, splicedRowsDesc);

    // Diagonal-support gravity. Cells that lose their support after the
    // blast (col-blast neighbours, partial-clear holes, or anything left
    // dangling) drop one row at a time until the board is stable.
    const fellMoves = applyDiagonalGravity(state, reservedTop);
    const allMoves = spliceMoves.concat(fellMoves);
    if (allMoves.length && hooks.onCellsFell) hooks.onCellsFell(allMoves);

    // Orphan-prop pass — anything whose host cell got nulled by a col blast.
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

    hooks.onClearSound?.(1);
}

/** Local copy of ClearLines.fireRowProps so Detonate's splice-path matches. */
function fireRowProps(
    state: BoardState,
    rows: number[],
    hooks: ClearLinesHooks,
    reservedTop: number = state.board.length,
): void {
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
    // Boom in to-be-spliced rows must fire BEFORE splice — same reasoning
    // as `ClearLines.fireRowProps`.
    if (state.boardBooms) {
        for (const r of rows) {
            for (let c = 0; c < COLS; c++) {
                const lvl = state.boardBooms[r] && state.boardBooms[r][c];
                if (lvl) {
                    state.boardBooms[r][c] = null;
                    const cleared = activateBoom(state, r, c, lvl, reservedTop);
                    hooks.onBoomTriggered?.(r, c, lvl, cleared);
                }
            }
        }
    }
}

/** Per-cell twin of fireRowProps — fires any chest/meteor/blizzard/
 *  wrecker/hail/rocket/gatling/boom sitting in the given (r, c)
 *  coordinates. Used by the box3 area-bomb path so props in the 9
 *  cells detonate as if the cell were cleared normally. Silently
 *  ignores out-of-range coordinates so the caller can pass raw
 *  bombBox3Cells output (some cells may be above/below the board).
 */
function fireCellProps(
    state: BoardState,
    cells: ReadonlyArray<{ r: number; c: number }>,
    hooks: ClearLinesHooks,
    reservedTop: number = state.board.length,
): void {
    const H = state.board.length;
    for (const { r, c } of cells) {
        if (r < 0 || r >= H) continue;
        if (state.boardChests?.[r]?.[c]) {
            state.boardChests[r][c] = null;
            hooks.onChestTriggered?.(r, c);
        }
        if (state.boardMeteors?.[r]?.[c]) {
            state.boardMeteors[r][c] = null;
            hooks.onMeteorTriggered?.(r, c);
        }
        if (state.boardBlizzards?.[r]?.[c]) {
            state.boardBlizzards[r][c] = null;
            hooks.onBlizzardTriggered?.(r, c);
        }
        if (state.boardWreckers?.[r]?.[c]) {
            state.boardWreckers[r][c] = null;
            hooks.onWreckerTriggered?.(r, c);
        }
        if (state.boardHails?.[r]?.[c]) {
            state.boardHails[r][c] = null;
            hooks.onHailTriggered?.(r, c);
        }
        if (state.boardRockets?.[r]?.[c]) {
            state.boardRockets[r][c] = null;
            hooks.onRocketTriggered?.(r, c);
        }
        if (state.boardGatlings?.[r]?.[c]) {
            state.boardGatlings[r][c] = null;
            hooks.onGatlingTriggered?.(r, c);
        }
        if (state.boardBooms?.[r]?.[c]) {
            const lvl = state.boardBooms[r][c]!;
            state.boardBooms[r][c] = null;
            const cleared = activateBoom(state, r, c, lvl, reservedTop);
            hooks.onBoomTriggered?.(r, c, lvl, cleared);
        }
    }
}
