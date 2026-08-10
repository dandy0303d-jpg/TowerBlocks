/**
 * TutorialLevelData — programmatically-generated LevelData for the
 * new-player operations tutorial.
 *
 * Layout (per player spec):
 *   - 4 gray reserved rows at the bottom (foundation)
 *   - 2 colored task rows above, each with ONE empty gap; the two
 *     gaps sit far apart (col 5 and col 17) so tower rotation feels
 *     meaningful when the player practises horizontal-swipe gestures
 *   - Starting piece: J (asymmetric — makes the tap-to-morph
 *     demonstration visually obvious)
 *
 * `GameState.tutorialActive` is set alongside this load so:
 *   - `failGame` is a no-op (player can't lose)
 *   - `maybeFireLevelWin` short-circuits (clearing the 2 colored
 *     rows won't fire "level clear")
 *   - Energy bar / picker / embed-prop rewards all skipped
 * All the short-circuits live in `GameState.ts`.
 */

import { COLS, CellValue, PieceType } from './Constants';
import {
    LevelData,
    CustomPieceDef,
    BombKind,
    StoneHP,
    BoomLevel,
} from './Types';

/** Where the two gaps are on each colored row. Kept far apart so
 *  rotating the tower actually swings the visible content. */
const TASK_ROW_GAPS = [5, 17];

/** Which colours the two task rows use — alternating so the visual
 *  reads as different rows even without gap awareness. */
const TASK_ROW_COLORS: CellValue[] = ['J', 'S'];

/** Gap positions for the 4 gray rows. Spread across the cylinder
 *  every ~6 columns so the tower looks visually varied and rotating
 *  during demos always reveals a different gap through the middle. */
const RESERVED_ROW_GAPS = [3, 9, 15, 21];

/** Build a 2D grid of null of the given shape. */
function makeNullGrid<T>(rows: number, cols: number): (T | null)[][] {
    const out: (T | null)[][] = [];
    for (let r = 0; r < rows; r++) out.push(new Array<T | null>(cols).fill(null));
    return out;
}

/** Build one task-zone row: fill with the given color EXCEPT one gap. */
function buildTaskRow(gapCol: number, color: CellValue): (CellValue | null)[] {
    const row: (CellValue | null)[] = [];
    for (let c = 0; c < COLS; c++) row.push(c === gapCol ? null : color);
    return row;
}

/** Build one reserved-zone row: gray 'X' everywhere EXCEPT one gap. */
function buildReservedRow(gapCol: number): (CellValue | null)[] {
    const row: (CellValue | null)[] = [];
    for (let c = 0; c < COLS; c++) row.push(c === gapCol ? null : ('X' as CellValue));
    return row;
}

/**
 * Construct a fresh LevelData for the tutorial. The tutorial NEVER
 * completes as a "level" (short-circuited in GameState), so the
 * `taskHeight` is real (2) but the win check is disabled.
 */
export function buildTutorialLevel(): LevelData {
    const taskHeight     = TASK_ROW_GAPS.length;     // 2
    const reservedHeight = RESERVED_ROW_GAPS.length; // 4 gray rows (with gaps)

    const taskZone: (CellValue | null)[][] = [];
    for (let r = 0; r < taskHeight; r++) {
        taskZone.push(buildTaskRow(TASK_ROW_GAPS[r], TASK_ROW_COLORS[r % TASK_ROW_COLORS.length]));
    }
    const reservedZone: (CellValue | null)[][] = [];
    for (let r = 0; r < reservedHeight; r++) {
        reservedZone.push(buildReservedRow(RESERVED_ROW_GAPS[r % RESERVED_ROW_GAPS.length]));
    }

    // Starting piece: I. Rotates between a horizontal 4-wide bar
    // and a vertical 4-tall bar — the most visually obvious morph
    // of all 7 tetrominos, so tap-to-morph reads clearly at a glance.
    // Encoded the same as Constants.SHAPES.I.
    const iPiece: CustomPieceDef = {
        baseType: 'I' as PieceType,
        shape: [
            [0, 0, 0, 0],
            [1, 1, 1, 1],
            [0, 0, 0, 0],
            [0, 0, 0, 0],
        ],
    };

    return {
        id:               'tutorial-ops',
        order:            0,
        name:             'Tutorial (operations)',
        author:           'system',
        taskHeight,
        reservedHeight,

        taskZone,
        reservedZone,

        // All prop layers empty. The tutorial explicitly demonstrates
        // basic gestures only — no bombs, wreckers, stones, hail, etc.
        taskBombs:        makeNullGrid<BombKind>(taskHeight,     COLS),
        reservedBombs:    makeNullGrid<BombKind>(reservedHeight, COLS),

        taskStones:       makeNullGrid<StoneHP>(taskHeight,      COLS),
        reservedStones:   makeNullGrid<StoneHP>(reservedHeight,  COLS),

        taskChests:       makeNullGrid<true>(taskHeight,         COLS),
        reservedChests:   makeNullGrid<true>(reservedHeight,     COLS),

        taskMeteors:      makeNullGrid<true>(taskHeight,         COLS),
        reservedMeteors:  makeNullGrid<true>(reservedHeight,     COLS),

        taskBlizzards:    makeNullGrid<true>(taskHeight,         COLS),
        reservedBlizzards:makeNullGrid<true>(reservedHeight,     COLS),

        taskWreckers:     makeNullGrid<true>(taskHeight,         COLS),
        reservedWreckers: makeNullGrid<true>(reservedHeight,     COLS),

        taskHails:        makeNullGrid<true>(taskHeight,         COLS),
        reservedHails:    makeNullGrid<true>(reservedHeight,     COLS),

        taskRockets:      makeNullGrid<true>(taskHeight,         COLS),
        reservedRockets:  makeNullGrid<true>(reservedHeight,     COLS),

        taskGatlings:     makeNullGrid<true>(taskHeight,         COLS),
        reservedGatlings: makeNullGrid<true>(reservedHeight,     COLS),

        taskBooms:        makeNullGrid<BoomLevel>(taskHeight,     COLS),
        reservedBooms:    makeNullGrid<BoomLevel>(reservedHeight, COLS),

        // No pre-granted items during tutorial.
        startingItems:    {},

        // Register the I piece so the FIRST spawn (right after
        // startLevel) draws it. Bag will fall back to standard 7
        // after the custom shape has been dealt.
        customPiece:      iPiece,
    };
}
