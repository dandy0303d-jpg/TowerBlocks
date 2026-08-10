/**
 * Board state factories and clone helpers. The board itself is a `ROWS × COLS`
 * 2D array of cell values (or `null`). Every prop / overlay (bombs, stones,
 * chests, …) lives in its own parallel array with the same shape so a cell at
 * `(r, c)` always lines up across all layers.
 *
 * All functions here are PURE — they never mutate their inputs and never
 * touch the engine. They're the bedrock the rest of the logic layer builds on.
 */

import { COLS, ROWS, CellValue } from './Constants';
import { BoardState, BombKind, StoneHP, BoomLevel } from './Types';

// ---------- Empty factories ----------

/** Create an empty `rows × COLS` 2D array filled with `null`. Defaults to
 *  the baseline `ROWS` but the caller can request a taller board for
 *  high-difficulty levels (tetris.html uses the same dynamic growth). */
export function emptyBoard(rows: number = ROWS): (CellValue | null)[][] {
    const b: (CellValue | null)[][] = [];
    for (let r = 0; r < rows; r++) {
        b.push(new Array<CellValue | null>(COLS).fill(null));
    }
    return b;
}

/** Generic empty parallel array of `rows × COLS` filled with `null`. */
export function emptyParallel<T>(rows: number = ROWS): (T | null)[][] {
    const g: (T | null)[][] = [];
    for (let r = 0; r < rows; r++) {
        g.push(new Array<T | null>(COLS).fill(null));
    }
    return g;
}

/** Fresh `BoardState` for endless mode (no level props). `boardBombs` is
 *  initialised so piece-embedded bombs (the natural-clear reward) survive
 *  the lock and only fire when their host row gets fully filled. */
export function emptyEndlessBoardState(): BoardState {
    return {
        board:           emptyBoard(),
        boardBombs:      emptyParallel<BombKind>(),
        boardStones:     null,
        boardChests:     null,
        boardMeteors:    null,
        boardBlizzards:  null,
        boardWreckers:   null,
        boardHails:      null,
        boardHailPlaced: null,
        boardRockets:    null,
        boardGatlings:   null,
        boardBooms:      null,
    };
}

/** Fresh `BoardState` for level mode (all parallel arrays initialised).
 *  `rows` defaults to the baseline `ROWS` but levels with taller task
 *  zones pass a larger value so the board still has spawn buffer above
 *  the populated area. */
export function emptyLevelBoardState(rows: number = ROWS): BoardState {
    return {
        board:           emptyBoard(rows),
        boardBombs:      emptyParallel<BombKind>(rows),
        boardStones:     emptyParallel<StoneHP>(rows),
        boardChests:     emptyParallel<true>(rows),
        boardMeteors:    emptyParallel<true>(rows),
        boardBlizzards:  emptyParallel<true>(rows),
        boardWreckers:   emptyParallel<true>(rows),
        boardHails:      emptyParallel<true>(rows),
        boardHailPlaced: emptyParallel<true>(rows),
        boardRockets:    emptyParallel<true>(rows),
        boardGatlings:   emptyParallel<true>(rows),
        boardBooms:      emptyParallel<BoomLevel>(rows),
    };
}

// ---------- Deep clone ----------

/** Deep-clone a 2D parallel array. Returns `null` when given `null`. */
export function cloneBoardLike<T>(b: (T | null)[][] | null): (T | null)[][] | null {
    if (!b) return null;
    return b.map(row => row.slice());
}

/** Deep-clone an entire `BoardState`. */
export function cloneBoardState(s: BoardState): BoardState {
    return {
        board:           cloneBoardLike(s.board) as (CellValue | null)[][],
        boardBombs:      cloneBoardLike(s.boardBombs),
        boardStones:     cloneBoardLike(s.boardStones),
        boardChests:     cloneBoardLike(s.boardChests),
        boardMeteors:    cloneBoardLike(s.boardMeteors),
        boardBlizzards:  cloneBoardLike(s.boardBlizzards),
        boardWreckers:   cloneBoardLike(s.boardWreckers),
        boardHails:      cloneBoardLike(s.boardHails),
        boardHailPlaced: cloneBoardLike(s.boardHailPlaced),
        boardRockets:    cloneBoardLike(s.boardRockets),
        boardGatlings:   cloneBoardLike(s.boardGatlings),
        boardBooms:      cloneBoardLike(s.boardBooms),
    };
}

// ---------- Tiny query helpers ----------

/** Wrap a column index into `[0, COLS)`. Cylinder wraps left/right. */
export function wrap(c: number): number {
    return ((c % COLS) + COLS) % COLS;
}

/** Whether the cell at (r, c) is *colorable* — non-empty AND not gray reserved
 *  AND not hail. Used by wrecker / rocket / excavator to filter "real" cells. */
export function isColoredCell(value: CellValue | null): boolean {
    return value !== null && value !== 'X' && value !== 'H';
}
