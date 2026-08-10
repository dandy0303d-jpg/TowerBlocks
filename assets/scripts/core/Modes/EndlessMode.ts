/**
 * Endless-mode mechanics.
 *
 * Failure conditions:
 *   1. **Trapped hole** — at least one empty cell is unreachable from the top
 *      of the board via 4-neighbour BFS (with horizontal wrap). The cylinder
 *      becomes unwinnable when the stack seals off a pocket.
 *   2. **Stack too tall** — the non-gray content above the gray foundation
 *      exceeds `ENDLESS_HEIGHT_LIMIT` rows AND the player has no full row to
 *      clear with their next piece.
 *
 * Per-lock pipeline (call in this order from GameState):
 *   1. `convertCompleteRowsToGray(state)` → number of newly-filled rows
 *   2. Check failures: `checkTrappedHole(state)`, `checkStackTooTall(state)`
 *   3. `manageEndlessBoard(state)` → caps gray foundation + grows the board
 *      upward if the stack is too close to the ceiling
 *   4. `endlessProgress.consume(filledThisLock)` → chest count to grant
 */

import {
    COLS,
    ENDLESS_HEIGHT_LIMIT,
    ENDLESS_FAIL_MARGIN,
    ENDLESS_GRAY_CAP,
    ENDLESS_SCROLL_THRESHOLD,
    ENDLESS_DECILE_INTERVAL,
    ENDLESS_STREAK_THRESHOLD,
    CellValue,
} from '../Constants';
import { BoardState, Piece, BombKind, StoneHP, BoomLevel } from '../Types';
import { wrap } from '../Board';

// ---------- Failure detection ----------

/**
 * BFS from every empty cell on row 0 across 4-neighbours (with horizontal
 * wrap). If any empty cell is unreachable, the board has a sealed hole and
 * the game is over.
 */
export function checkTrappedHole(state: BoardState): boolean {
    const rows = state.board.length;
    const visited: boolean[][] = [];
    for (let r = 0; r < rows; r++) visited.push(new Array<boolean>(COLS).fill(false));

    // Queue of encoded `r * COLS + c` indices.
    const queue: number[] = [];
    for (let c = 0; c < COLS; c++) {
        if (!state.board[0][c]) {
            visited[0][c] = true;
            queue.push(0 * COLS + c);
        }
    }
    let head = 0;
    while (head < queue.length) {
        const code = queue[head++];
        const r = (code / COLS) | 0;
        const c = code - r * COLS;
        const nbrs: Array<[number, number]> = [
            [r - 1, c],
            [r + 1, c],
            [r, wrap(c - 1)],
            [r, wrap(c + 1)],
        ];
        for (const [nr, nc] of nbrs) {
            if (nr < 0 || nr >= rows) continue;
            if (visited[nr][nc] || state.board[nr][nc]) continue;
            visited[nr][nc] = true;
            queue.push(nr * COLS + nc);
        }
    }
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < COLS; c++) {
            if (!state.board[r][c] && !visited[r][c]) return true;
        }
    }
    return false;
}

/**
 * Same BFS as `checkTrappedHole` but returns the list of trapped cells
 * (empty cells unreachable from row 0 via 4-neighbour flood fill with
 * horizontal wrap) instead of a boolean. Used by the fail-reveal FX
 * to pulse-highlight exactly which cells sealed the tower off.
 */
export function findTrappedCells(state: BoardState): Array<{ r: number; c: number }> {
    const rows = state.board.length;
    const visited: boolean[][] = [];
    for (let r = 0; r < rows; r++) visited.push(new Array<boolean>(COLS).fill(false));
    const queue: number[] = [];
    for (let c = 0; c < COLS; c++) {
        if (!state.board[0][c]) {
            visited[0][c] = true;
            queue.push(0 * COLS + c);
        }
    }
    let head = 0;
    while (head < queue.length) {
        const code = queue[head++];
        const r = (code / COLS) | 0;
        const c = code - r * COLS;
        const nbrs: Array<[number, number]> = [
            [r - 1, c],
            [r + 1, c],
            [r, wrap(c - 1)],
            [r, wrap(c + 1)],
        ];
        for (const [nr, nc] of nbrs) {
            if (nr < 0 || nr >= rows) continue;
            if (visited[nr][nc] || state.board[nr][nc]) continue;
            visited[nr][nc] = true;
            queue.push(nr * COLS + nc);
        }
    }
    const trapped: Array<{ r: number; c: number }> = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < COLS; c++) {
            if (!state.board[r][c] && !visited[r][c]) trapped.push({ r, c });
        }
    }
    return trapped;
}

/**
 * Count fully (24-col) filled rows stacked contiguously at the BOTTOM of
 * the board. These rows form the gray foundation.
 */
export function countBottomCompleteRows(state: BoardState): number {
    let count = 0;
    for (let r = state.board.length - 1; r >= 0; r--) {
        if (state.board[r].every(v => v !== null)) count++;
        else break;
    }
    return count;
}

/**
 * Failure check 2: non-gray content above the gray foundation grew taller
 * than `ENDLESS_HEIGHT_LIMIT + ENDLESS_FAIL_MARGIN`.
 *
 * The visible warning ring sits at `ENDLESS_HEIGHT_LIMIT` rows above the
 * foundation; failure fires when the stack top goes ONE row past the ring
 * (the check is strict `>`, so a stack ending at the ring's row is still
 * safe — the very next brick that pushes higher triggers game-over).
 */
export function checkStackTooTall(state: BoardState): boolean {
    let stackTopR = state.board.length;
    for (let r = 0; r < state.board.length; r++) {
        let found = false;
        for (let c = 0; c < COLS; c++) {
            if (state.board[r][c]) { found = true; break; }
        }
        if (found) { stackTopR = r; break; }
    }
    const totalFilled = state.board.length - stackTopR;
    const bottomGray = countBottomCompleteRows(state);
    return (totalFilled - bottomGray) > (ENDLESS_HEIGHT_LIMIT + ENDLESS_FAIL_MARGIN);
}

// ---------- Per-lock board management ----------

/**
 * Recolor any row that just became fully (24-col) filled to all-gray.
 * Returns the count of rows that FRESHLY transitioned (i.e. had at least
 * one non-gray cell before). The count drives `EndlessChestProgress`.
 *
 * `onConverted` fires once per freshly-converted row with a SNAPSHOT of
 * the row's PRE-conversion content (the colored cells the player just
 * completed). Used by blind mode to trigger the same rainbow-flash /
 * shatter FX that level mode gets via `clearLines.onPartialShatter` —
 * without it, blind's peel-per-fill would silently swap the row for an
 * empty one and the player never sees a "row completed!" cue.
 */
export function convertCompleteRowsToGray(
    state: BoardState,
    onConverted?: (r: number, content: ReadonlyArray<CellValue | null>) => void,
): number {
    let newlyFilled = 0;
    for (let r = 0; r < state.board.length; r++) {
        if (state.board[r].every(v => v !== null)) {
            let hadNonGray = false;
            for (let c = 0; c < COLS; c++) {
                if (state.board[r][c] !== 'X') { hadNonGray = true; break; }
            }
            if (hadNonGray) {
                // Snapshot BEFORE overwriting, so the callback sees the
                // original colored cells.
                const content = onConverted ? state.board[r].slice() : null;
                for (let c = 0; c < COLS; c++) state.board[r][c] = 'X' as CellValue;
                newlyFilled++;
                if (content) onConverted!(r, content);
            }
        }
    }
    return newlyFilled;
}

/**
 * Two-step manager called after every lock:
 *   1. If the gray foundation exceeds `ENDLESS_GRAY_CAP` (20), peel the
 *      bottom-most gray rows off until it fits.
 *   2. If the topmost filled row is within `ENDLESS_SCROLL_THRESHOLD` (6)
 *      of the ceiling, prepend empty rows so the active piece always has
 *      enough spawn buffer. The board grows on demand.
 *
 * Returns the count of rows added at the top (so the caller can shift the
 * live piece's `y` to match — every prepended row pushes everything else
 * down by 1 row).
 */
/**
 * Blind-mode variant: keep the gray foundation locked at exactly
 * `foundationRows` rows. Any all-gray rows ABOVE the bottom-most
 * `foundationRows` (i.e. rows freshly converted by
 * `convertCompleteRowsToGray`) get spliced out; an empty row is
 * prepended per splice so the board length stays stable.
 *
 * Effect for the player: completed rows collapse and the tower's
 * player-built portion drops by one row, exactly like classic Tetris.
 * The 4-row foundation never grows.
 *
 * All parallel prop arrays (bombs / stones / etc.) get spliced in
 * lockstep so cell coordinates stay in sync — same pattern that
 * `clearLines` uses. In practice blind mode doesn't populate any of
 * these arrays (no fate / no embed props / no picker / no storms),
 * but keeping them aligned is cheap and defensive.
 *
 * Returns the number of rows peeled (0 if nothing changed).
 */
export function peelGrayAboveFoundation(
    state: BoardState,
    foundationRows: number,
): number {
    const board = state.board;
    let peeled = 0;
    while (true) {
        // Count all-gray rows currently on the board.
        let grayCount = 0;
        for (let r = 0; r < board.length; r++) {
            if (board[r].every(v => v === 'X')) grayCount++;
        }
        if (grayCount <= foundationRows) break;

        // Splice out the TOPMOST all-gray row (the just-converted one;
        // the initial foundation sits at the bottom).
        let sliceAt = -1;
        for (let r = 0; r < board.length; r++) {
            if (board[r].every(v => v === 'X')) { sliceAt = r; break; }
        }
        if (sliceAt < 0) break;   // shouldn't happen given grayCount > foundationRows

        board.splice(sliceAt, 1);
        if (state.boardBombs)      state.boardBombs.splice(sliceAt, 1);
        if (state.boardStones)     state.boardStones.splice(sliceAt, 1);
        if (state.boardChests)     state.boardChests.splice(sliceAt, 1);
        if (state.boardMeteors)    state.boardMeteors.splice(sliceAt, 1);
        if (state.boardBlizzards)  state.boardBlizzards.splice(sliceAt, 1);
        if (state.boardWreckers)   state.boardWreckers.splice(sliceAt, 1);
        if (state.boardHails)      state.boardHails.splice(sliceAt, 1);
        if (state.boardHailPlaced) state.boardHailPlaced.splice(sliceAt, 1);
        if (state.boardRockets)    state.boardRockets.splice(sliceAt, 1);
        if (state.boardGatlings)   state.boardGatlings.splice(sliceAt, 1);
        if (state.boardBooms)      state.boardBooms.splice(sliceAt, 1);

        board.unshift(new Array<CellValue | null>(COLS).fill(null));
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

        peeled++;
    }
    return peeled;
}

export function manageEndlessBoard(state: BoardState): number {
    // Step 1: cap the gray foundation at ENDLESS_GRAY_CAP.
    let grayCount = 0;
    for (let r = 0; r < state.board.length; r++) {
        if (state.board[r].every(v => v === 'X')) grayCount++;
    }
    while (grayCount > ENDLESS_GRAY_CAP) {
        // Remove the bottom-most gray row.
        for (let r = state.board.length - 1; r >= 0; r--) {
            if (state.board[r].every(v => v === 'X')) {
                state.board.splice(r, 1);
                grayCount--;
                break;
            }
        }
    }

    // Step 2: ensure spawn buffer above the stack.
    let rowsAdded = 0;
    while (true) {
        let stackTopR = state.board.length;
        for (let r = 0; r < state.board.length; r++) {
            let found = false;
            for (let c = 0; c < COLS; c++) {
                if (state.board[r][c]) { stackTopR = r; found = true; break; }
            }
            if (found) break;
        }
        if (stackTopR >= ENDLESS_SCROLL_THRESHOLD) break;
        // Grow upward: prepend an empty row. The caller will shift `current.y`.
        state.board.unshift(new Array<CellValue | null>(COLS).fill(null));
        rowsAdded++;
    }
    return rowsAdded;
}

// ---------- Chest progress ----------

/**
 * Tracks endless-mode chest drops:
 *   - **Streak**: every `ENDLESS_STREAK_THRESHOLD` (4) consecutive fully-
 *     filled rows → 1 chest. The counter is reset when a lock produces zero
 *     fully-filled rows.
 *   - **Cumulative**: 1 chest per `ENDLESS_DECILE_INTERVAL` (10) total
 *     fully-filled rows over the run.
 */
export class EndlessChestProgress {
    streak:     number = 0;
    cumulative: number = 0;
    lastDecile: number = 0;

    /** Returns the number of chests to grant for this lock. */
    consume(filledThisLock: number): number {
        let chests = 0;
        if (filledThisLock > 0) {
            this.streak += filledThisLock;
            this.cumulative += filledThisLock;
            if (this.streak >= ENDLESS_STREAK_THRESHOLD) {
                chests += 1;
                this.streak = 0;
            }
            const newDecile = Math.floor(this.cumulative / ENDLESS_DECILE_INTERVAL);
            if (newDecile > this.lastDecile) {
                chests += newDecile - this.lastDecile;
                this.lastDecile = newDecile;
            }
        } else {
            this.streak = 0;
        }
        return chests;
    }

    reset(): void {
        this.streak = 0;
        this.cumulative = 0;
        this.lastDecile = 0;
    }
}
