/**
 * Excavator magic item — scans the board for rows that contain any colored
 * (non-gray, non-hail) cell, then destroys up to `rowCount` such rows.
 *   • `fromTop = false` (bottom family `excavator1/2/3`): scans BOTTOM-UP,
 *     hits the lowest N colored rows. Useful for fishing chests / clearing
 *     the foundation.
 *   • `fromTop = true` (top family `excavatorTop1/2/3`): scans TOP-DOWN,
 *     hits the highest N colored rows. Useful when the tower is about to
 *     top out in endless mode.
 *
 * `rowCount` defaults to 3 (the legacy tier-3 behaviour). The 1- and 2-row
 * tiers are the new lighter / cheaper variants.
 *
 * If there's nothing to dig (all-empty or only X/H), the activator returns
 * false so the inventory entry isn't consumed.
 *
 * Props sitting in cleared cells fire their hooks via the standard
 * `ItemTriggerHooks` interface; the caller wires those hooks to the matching
 * activate functions to chain chest / meteor / blizzard / wrecker / hail /
 * rocket triggers.
 */

import { COLS, CellValue } from '../Constants';
import { BoardState, BombKind } from '../Types';
import { isColoredCell } from '../Board';
import {
    ClearLinesHooks,
    processClearedChests,
    processClearedMeteors,
    processClearedBlizzards,
    processClearedWreckers,
    processClearedHails,
    processClearedRockets,
    spliceRows,
} from '../ClearLines';
import { applyDiagonalGravity } from '../ColumnGravity';
import { fireStackedPropCollisionsAfterGravity } from '../ClearLines';
import { detonateBombs, DetonateHooks, BombSeed } from '../Detonate';
/** Returns true if any rows were dug (i.e. the inventory entry is consumed). */
export function activateExcavator(
    state: BoardState,
    reservedTop: number,
    hooks: ClearLinesHooks = {},
    fromTop: boolean = false,
    rowCount: number = 3,
): boolean {
    // 1. Two-pass row picking. Colored rows are cleared FIRST; gray-only
    //    reserved rows are only touched if pass 1 didn't produce enough.
    //    "Colored row" = at least one isColoredCell entry. "Gray-only row"
    //    = at least one 'X' but no colored cells.
    //    Scan direction depends on the variant: bottom-up for the bottom
    //    family, top-down for the top family.
    const target = Math.max(1, Math.floor(rowCount));
    const isSolid = (v: CellValue | null) => isColoredCell(v) || v === 'X';
    const rowKind = (r: number): 'colored' | 'gray' | 'empty' => {
        let hasColored = false, hasGray = false;
        for (let c = 0; c < COLS; c++) {
            const v = state.board[r][c];
            if (isColoredCell(v)) { hasColored = true; break; }
            if (v === 'X') hasGray = true;
        }
        if (hasColored) return 'colored';
        if (hasGray)    return 'gray';
        return 'empty';
    };

    /** Two-pass row picker: colored rows first, gray-only fallback if we
     *  came up short. Returns rows in descending order (matches
     *  `spliceRows` contract). Factored out so we can re-pick after a
     *  bomb chain detonation shifts row indices. */
    const pickRows = (): number[] => {
        const H = state.board.length;
        const orderedIdxs: number[] = [];
        if (fromTop) {
            for (let r = 0; r < H; r++) orderedIdxs.push(r);
        } else {
            for (let r = H - 1; r >= 0; r--) orderedIdxs.push(r);
        }
        const coloredRows: number[] = [];
        const grayRows:    number[] = [];
        for (const r of orderedIdxs) {
            const k = rowKind(r);
            if      (k === 'colored') coloredRows.push(r);
            else if (k === 'gray')    grayRows.push(r);
        }
        let out = coloredRows.slice(0, target);
        if (out.length < target) {
            out = out.concat(grayRows.slice(0, target - out.length));
        }
        return out.slice().sort((a, b) => b - a);
    };

    const initialPicked = pickRows();
    if (!initialPicked.length) return false;

    // ── Row/col bomb pre-detonation ──────────────────────────────
    // If any of the picked rows contain a row/col bomb, seed those
    // into `detonateBombs` FIRST so the bomb's row/col blast fires
    // (and chains through any adjacent bombs) BEFORE the excavator
    // does its own row splice. Without this the previous impl just
    // nulled the bomb marker along with the rest of the cell — the
    // player saw the bomb visual disappear but got no rowN/colN
    // expansion. detonateBombs handles its own splice + gravity.
    if (state.boardBombs) {
        const bombSeeds: BombSeed[] = [];
        for (const r of initialPicked) {
            for (let c = 0; c < COLS; c++) {
                const k = state.boardBombs[r] && state.boardBombs[r][c];
                if (k) {
                    bombSeeds.push({ r, c, kind: k as BombKind });
                    // Consume the marker so detonateBombs' chain
                    // step doesn't try to re-fire it as a neighbour.
                    state.boardBombs[r][c] = null;
                }
            }
        }
        if (bombSeeds.length > 0) {
            detonateBombs(state, bombSeeds, reservedTop, hooks as DetonateHooks);
        }
    }

    // Re-pick on the (possibly transformed) board. The bomb chain may
    // have cleared some of the originally picked rows already; re-run
    // the two-pass picker to fill the remaining excavator quota with
    // whatever colored/gray rows are still standing. If the bomb chain
    // consumed enough that nothing's left to dig, the item still
    // counts as consumed — the bomb blast IS the dig, in effect.
    const rows = pickRows();
    if (!rows.length) return true;

    // 2. Snapshot + clear each picked row's solid cells (colored + gray).
    for (const r of rows) {
        const content: (CellValue | null)[] = new Array(COLS).fill(null);
        for (let c = 0; c < COLS; c++) {
            if (isSolid(state.board[r][c])) {
                content[c] = state.board[r][c];
            }
        }
        hooks.onPartialShatter?.(r, content);
        for (let c = 0; c < COLS; c++) {
            if (isSolid(state.board[r][c])) {
                state.board[r][c] = null;
                if (state.boardBombs && state.boardBombs[r])   state.boardBombs[r][c]   = null;
                if (state.boardStones && state.boardStones[r]) state.boardStones[r][c]  = null;
                if (state.boardChests && state.boardChests[r] && state.boardChests[r][c]) {
                    state.boardChests[r][c] = null;
                    hooks.onChestTriggered?.(r, c);
                }
                if (state.boardMeteors && state.boardMeteors[r] && state.boardMeteors[r][c]) {
                    state.boardMeteors[r][c] = null;
                    hooks.onMeteorTriggered?.(r, c);
                }
                if (state.boardBlizzards && state.boardBlizzards[r] && state.boardBlizzards[r][c]) {
                    state.boardBlizzards[r][c] = null;
                    hooks.onBlizzardTriggered?.(r, c);
                }
                if (state.boardWreckers && state.boardWreckers[r] && state.boardWreckers[r][c]) {
                    state.boardWreckers[r][c] = null;
                    hooks.onWreckerTriggered?.(r, c);
                }
                if (state.boardHails && state.boardHails[r] && state.boardHails[r][c]) {
                    state.boardHails[r][c] = null;
                    hooks.onHailTriggered?.(r, c);
                }
                if (state.boardRockets && state.boardRockets[r] && state.boardRockets[r][c]) {
                    state.boardRockets[r][c] = null;
                    hooks.onRocketTriggered?.(r, c);
                }
            }
        }
    }

    // 3. Splice the dug rows out of every parallel array (and unshift
    //    matching empty rows at the top), so the structure ABOVE the
    //    cleared zone falls down WHOLE — preserving its original
    //    shape and prop layout. This is different from
    //    `applyColumnGravity` (which packs every column flush to the
    //    floor and collapses intentional gaps) and from "leave
    //    floating cells" (which looks broken). `spliceRows` takes
    //    rows in DESCENDING order; the scan above already pushes
    //    rows bottom-up, so `rows` is naturally descending.
    // Splice the dug rows; the returned moves cover the structure that
    // shifts down by N (one per dug row above it) so the render layer
    // animates the bulk drop instead of teleporting.
    const spliceMoves = spliceRows(state, rows);
    // Diagonal gravity catches anything left dangling after the splice
    // (e.g., towers that lost their base support but the splice alone
    // didn't drop them onto a stable footing).
    const fellMoves = applyDiagonalGravity(state, reservedTop);
    const allMoves = spliceMoves.concat(fellMoves);
    if (allMoves.length && hooks.onCellsFell) hooks.onCellsFell(allMoves);
    // Fire stacked prop-on-prop collisions produced by this gravity pass:
    // a bomb / clear-trigger prop pushed onto another prop must fire THIS
    // tick instead of waiting for the next lock's adjacency scan.
    const collisionBombSeeds = fireStackedPropCollisionsAfterGravity(
        state, fellMoves, hooks as DetonateHooks, reservedTop,
    );
    if (collisionBombSeeds.length) {
        detonateBombs(state, collisionBombSeeds, reservedTop, hooks as DetonateHooks);
    }
    processClearedChests(state, hooks);
    processClearedMeteors(state, hooks);
    processClearedBlizzards(state, hooks);
    processClearedWreckers(state, hooks);
    processClearedHails(state, hooks);
    processClearedRockets(state, hooks);
    hooks.onClearSound?.(1);
    return true;
}
