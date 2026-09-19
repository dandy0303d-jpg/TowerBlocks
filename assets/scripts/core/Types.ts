/**
 * Shared types for the game-logic layer. Kept rendering-agnostic so they can
 * be unit-tested in isolation and reused across Cocos / future ports.
 */

import { CellValue, MagicItemKey, PieceType } from './Constants';

export type GameMode = 'level' | 'endless';

// Bomb identifiers as stored in boardBombs (`row1` … `col4`).
//   Tiers 1-3 are natural drops (`injectRandomMagicProp`). Tier 4 is
//   reachable ONLY via the bomb × boom adjacency-amplification rule
//   (tier + level, capped at 4) — players never roll a row4/col4 from
//   a clear directly.
export type BombKind =
    | 'row1' | 'row2' | 'row3' | 'row4'
    | 'col1' | 'col2' | 'col3' | 'col4'
    // Backpack-only: 3×3 same-layer area bomb centred on the tagged
    // cell. Comes from the `bomb_block` backpack card — the whole
    // spawned piece is a single 1×1 cell tagged with this kind. On
    // lock, clears the 3×3 area at the lock layer (周向 wrap,
    // 纵深 clamp). See Bombs.ts → bombBox3Cells().
    | 'box3';

/** Stone HP — colored cell that needs N clears before it disappears. */
export type StoneHP = 2 | 3 | 4;

/** Diamond-blast prop level — radius 1 (5 cells, plus), 2 (13 cells), or
 *  3 (25 cells). Triggers when the host cell is cleared. */
export type BoomLevel = 1 | 2 | 3;

/** A single tetromino in flight. */
export interface Piece {
    type:   PieceType;
    shape:  number[][];
    bombs:  (BombKind | null)[][];
    /** Parallel grid for embedded boom (diamond range-blast) props —
     *  one cell can carry either a `bomb` OR a `boom`, never both at
     *  the same time. Empty grid if no boom is embedded. */
    booms:  (BoomLevel | null)[][];
    /** Parallel grid for embedded wrecker (10-cell random sweep) props.
     *  Only one cell per piece carries a wrecker — same exclusivity rule
     *  as bombs vs booms (it's mutually exclusive with both). Triggers
     *  via the standard wrecker chain when the host row clears. */
    wreckers: (true | null)[][];
    x:      number;
    y:      number;
    /** True when this piece carries a hand-authored custom shape (the
     *  fate piece in endless mode, or a level-editor custom piece).
     *  Set by `spawn()` when a `shapeOverride` is provided. Used by
     *  the shapeshifter and hold logic to preserve the custom geometry
     *  across transforms — without this flag, a rotated standard
     *  tetromino could be misclassified by structural shape comparison. */
    isCustomShape?: boolean;
}

/**
 * The parallel-array board state. Mirrors the original HTML implementation —
 * a colored cell at (r, c) is `board[r][c]`, and any prop sitting on top of
 * that cell lives in the corresponding side array.
 */
export interface BoardState {
    board:           (CellValue | null)[][];
    boardBombs:      (BombKind | null)[][] | null;
    boardStones:     (StoneHP | null)[][]  | null;
    boardChests:     (true | null)[][]     | null;
    boardMeteors:    (true | null)[][]     | null;
    boardBlizzards:  (true | null)[][]     | null;
    boardWreckers:   (true | null)[][]     | null;
    boardHails:      (true | null)[][]     | null;
    boardHailPlaced: (true | null)[][]     | null;
    boardRockets:    (true | null)[][]     | null;
    boardGatlings:   (true | null)[][]     | null;
    boardBooms:      (BoomLevel | null)[][] | null;
}

/** Inventory of magic items the player currently holds. */
export type Inventory = Record<MagicItemKey, number>;

/** Editor-authored level payload. Matches the JSON schema produced by the
 *  standalone HTML level editor (`level-editor.html` → "导出 JSON"). */
export interface LevelData {
    id:               string;
    order:            number;
    name:             string;
    author:           string;
    taskHeight:       number;
    reservedHeight:   number;

    taskZone:         (CellValue | null)[][];
    reservedZone:     (CellValue | null)[][];

    taskBombs:        (BombKind | null)[][];
    reservedBombs:    (BombKind | null)[][];

    taskStones:       (StoneHP | null)[][];
    reservedStones:   (StoneHP | null)[][];

    taskChests:       (true | null)[][];
    reservedChests:   (true | null)[][];

    taskMeteors:      (true | null)[][];
    reservedMeteors:  (true | null)[][];

    taskBlizzards:    (true | null)[][];
    reservedBlizzards:(true | null)[][];

    taskWreckers:     (true | null)[][];
    reservedWreckers: (true | null)[][];

    taskHails:        (true | null)[][];
    reservedHails:    (true | null)[][];

    taskRockets:      (true | null)[][];
    reservedRockets:  (true | null)[][];

    taskGatlings:     (true | null)[][];
    reservedGatlings: (true | null)[][];

    /** Diamond-blast props. Each cell is null | 1 | 2 | 3 — the integer is
     *  the blast radius. Triggered like wrecker (host cell cleared). */
    taskBooms?:       (BoomLevel | null)[][];
    reservedBooms?:   (BoomLevel | null)[][];

    startingItems?:   Partial<Inventory>;

    /**
     * Optional custom-shape piece. When defined, this shape is added to
     * the random-bag alongside the standard 7 tetrominos, so it spawns
     * with equal probability (1 in 8 per pick). Omitted / null → bag
     * uses only the standard 7.
     *
     * `baseType` is one of the 7 standard piece types and supplies the
     * color when the piece locks; `shape` is the editor-drawn matrix,
     * same `number[][]` schema as `Constants.SHAPES`.
     */
    customPiece?:     CustomPieceDef | null;

    /** Collect-mode goals — if present, the level boots into "collect"
     *  game mode. Each goal lists a piece-type colour and how many of
     *  that colour the player must clear from the board to pass the
     *  level. All goals must be met simultaneously to win. Omitting the
     *  field leaves the level in the regular clear-all-task mode. */
    collectGoals?:    Array<{ color: PieceType; count: number }>;
}

/** Editor-authored custom piece definition. */
export interface CustomPieceDef {
    baseType: PieceType;
    shape:    number[][];
}

/** Snapshot stored for time-rewind. */
export interface HistorySnapshot {
    board:           (CellValue | null)[][];
    boardBombs:      (BombKind | null)[][] | null;
    boardStones:     (StoneHP | null)[][]  | null;
    boardBooms:      (BoomLevel | null)[][] | null;
    boardChests:     (true | null)[][]     | null;
    boardMeteors:    (true | null)[][]     | null;
    boardBlizzards:  (true | null)[][]     | null;
    boardWreckers:   (true | null)[][]     | null;
    boardHails:      (true | null)[][]     | null;
    boardHailPlaced: (true | null)[][]     | null;
    boardRockets:    (true | null)[][]     | null;
    boardGatlings:   (true | null)[][]     | null;
    score:           number;
    lines:           number;
    level:           number;
    towerHeight:     number;
}

/** Animated objects being managed by the rendering layer between piece spawns. */
export interface FallingDrop {
    col:     number;
    y:       number;     // float row coord
    targetR: number;
    targetC: number;
}
export interface RocketProjectile {
    col: number;
    y:   number;         // float row coord
    /** Monotonically increasing per-rocket id, assigned at spawn. Used
     *  by the renderer to key ribbon-trail history so a pool slot that
     *  gets reused across rockets (rocket A lands → slot goes to
     *  rocket B) doesn't accidentally reuse A's trail points on B.
     *  Optional so older test fixtures don't need to backfill. */
    id?: number;
}

/** Mortar drop — like a hail drop but carries a colour value so the
 *  renderer can tint it to match what'll land on the board. */
export interface MortarDrop {
    col:     number;
    y:       number;
    targetR: number;
    targetC: number;
    color:   CellValue;
}

export type ShatterContent = { r: number; content: (CellValue | null)[] };

// ---- Runtime const stubs for Rollup ----------------------------------
// See Constants.ts for the rationale. Concrete string values defeat
// any "dead store" optimisation in the TS-to-JS transform.
export const GameMode        = '__type_GameMode__'        as any;
export const BombKind        = '__type_BombKind__'        as any;
export const StoneHP         = '__type_StoneHP__'         as any;
export const BoomLevel       = '__type_BoomLevel__'       as any;
export const ShatterContent  = '__type_ShatterContent__'  as any;
