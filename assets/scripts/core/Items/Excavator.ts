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
import { BoardState } from '../Types';
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
/** Returns true if any rows were dug (i.e. the inventory entry is consumed). */
export function activateExcavator(
    state: BoardState,
    reservedTop: number,
    hooks: ClearLinesHooks = {},
    fromTop: boolean = false,
    rowCount: number = 3,
): boolean {
    // 1. Find the first `rowCount` rows containing at least one solid
    //    cell (colored OR gray 'X'). Scan direction depends on the
    //    variant: bottom-up for the bottom family, top-down for the
    //    top family. Gray-only reserved rows now count as valid targets
    //    since the gray-is-bomb-proof rule was lifted.
    const target = Math.max(1, Math.floor(rowCount));
    const rows: number[] = [];
    const isSolid = (v: CellValue | null) => isColoredCell(v) || v === 'X';
    if (fromTop) {
        for (let r = 0; r < state.board.length && rows.length < target; r++) {
            for (let c = 0; c < COLS; c++) {
                if (isSolid(state.board[r][c])) {
                    rows.push(r);
                    break;
                }
            }
        }
        // `spliceRows` (below) requires rows in DESCENDING order; reverse.
        rows.reverse();
    } else {
        for (let r = state.board.length - 1; r >= 0 && rows.length < target; r--) {
            for (let c = 0; c < COLS; c++) {
                if (isSolid(state.board[r][c])) {
                    rows.push(r);
                    break;
                }
            }
        }
    }
    if (!rows.length) return false;

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
    processClearedChests(state, hooks);
    processClearedMeteors(state, hooks);
    processClearedBlizzards(state, hooks);
    processClearedWreckers(state, hooks);
    processClearedHails(state, hooks);
    processClearedRockets(state, hooks);
    hooks.onClearSound?.(1);
    return true;
}
