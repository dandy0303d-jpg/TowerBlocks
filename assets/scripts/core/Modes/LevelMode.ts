/**
 * Level-mode mechanics:
 *   - `convertReservedZoneToGray` — any colored cell that ends up inside the
 *     reserved zone is recolored to 'X'. The reserved zone is the bottom
 *     `levelReservedHeight` rows; player blocks that fall through there get
 *     "absorbed" visually.
 *   - `checkLevelWin` — win when every cell on the board is either null or
 *     gray 'X'. (Hail 'H' and any colored cell prevent winning.)
 *   - `LevelChestProgress` — counts cleared rows + tracks multi-clear bonuses
 *     and a per-5-rows cumulative bonus. Returns the number of chests the
 *     caller should grant; doesn't mutate inventory itself.
 */

import { COLS, LEVEL_CUMULATIVE_INTERVAL, LEVEL_MULTI_CLEAR_THRESHOLD,
         ENDLESS_HEIGHT_LIMIT, ENDLESS_FAIL_MARGIN } from '../Constants';
import { BoardState } from '../Types';

/** Recolor any colored (non-X, non-H) cell inside the reserved zone to 'X'. */
export function convertReservedZoneToGray(state: BoardState, levelReservedHeight: number): void {
    if (levelReservedHeight <= 0) return;
    const reservedStartRow = state.board.length - levelReservedHeight;
    for (let r = reservedStartRow; r < state.board.length; r++) {
        for (let c = 0; c < COLS; c++) {
            const v = state.board[r][c];
            if (v && v !== 'X' && v !== 'H') state.board[r][c] = 'X';
        }
    }
}

/**
 * Win condition.
 *   • When `reservedHeight` > 0: rows ABOVE the reserved zone must be
 *     completely empty (null). X cells that ended up above the reserved
 *     zone (left over from level obstacles, bombs, or stray colored
 *     blocks that fell in and got recolored) DO disqualify the win —
 *     the visible stack must be exactly `reservedHeight` rows tall.
 *   • When `reservedHeight` is 0 (legacy / test path): no colored or
 *     hail cells anywhere on the board.
 */
export function checkLevelWin(state: BoardState, reservedHeight: number = 0): boolean {
    if (reservedHeight > 0) {
        const reservedStartRow = state.board.length - reservedHeight;
        // Scan rows ABOVE the reserved zone — any non-null cell
        // (colored, X, hail, anything) disqualifies the win.
        for (let r = 0; r < reservedStartRow; r++) {
            for (let c = 0; c < COLS; c++) {
                if (state.board[r][c] !== null) return false;
            }
        }
        return true;
    }
    for (let r = 0; r < state.board.length; r++) {
        for (let c = 0; c < COLS; c++) {
            const v = state.board[r][c];
            if (v && v !== 'X') return false;
        }
    }
    return true;
}

/**
 * Level mode top-out failure — mirrors endless-mode's warning-line
 * relationship: the visible warning ring sits `ENDLESS_HEIGHT_LIMIT`
 * rows above the task+reserved foundation, and game-over fires when
 * the stack goes `ENDLESS_FAIL_MARGIN` rows further past the ring.
 *
 * With current tuning (10 + 0) that means "fill the row right above
 * the warning ring → you die". Previously this check was hard-wired
 * to row 0 (LEVEL_SAFETY_ROWS = 16 rows above the task-zone top),
 * which was 6 rows above the ring — no fail on the row you were
 * clearly told about.
 */
export function checkLevelTooTall(
    state: BoardState,
    foundationRows: number,
): boolean {
    // Row that a fresh brick MUST NOT occupy. Anything at this row
    // (or higher — smaller r values are visually higher on the tower)
    // means we've cleared the warning line and the fail margin.
    const failRow = state.board.length - foundationRows
                  - ENDLESS_HEIGHT_LIMIT - ENDLESS_FAIL_MARGIN - 1;
    // Very short levels or very small `foundationRows` values could
    // in theory push `failRow` above the board — treat that as "no
    // valid fail line" and skip the check.
    if (failRow < 0) return false;
    for (let r = 0; r <= failRow; r++) {
        for (let c = 0; c < COLS; c++) {
            if (state.board[r][c] !== null) return true;
        }
    }
    return false;
}

/**
 * Tracks the row-clear progress for level-mode chest drops:
 *   - Multi-clear (≥2 rows in a single lock) → 1 chest immediately.
 *   - Cumulative every `LEVEL_CUMULATIVE_INTERVAL` (5) full clears → 1 chest.
 * The caller invokes `consume(clearedThisLock)` after each piece lock and
 * grants the returned number of chests.
 */
export class LevelChestProgress {
    cumulativeCleared: number = 0;
    lastQuintile:      number = 0;

    consume(clearedThisLock: number): number {
        if (clearedThisLock <= 0) return 0;
        let chests = 0;
        if (clearedThisLock >= LEVEL_MULTI_CLEAR_THRESHOLD) chests += 1;
        this.cumulativeCleared += clearedThisLock;
        const newQuintile = Math.floor(this.cumulativeCleared / LEVEL_CUMULATIVE_INTERVAL);
        if (newQuintile > this.lastQuintile) {
            chests += newQuintile - this.lastQuintile;
            this.lastQuintile = newQuintile;
        }
        return chests;
    }

    reset(): void {
        this.cumulativeCleared = 0;
        this.lastQuintile = 0;
    }
}
