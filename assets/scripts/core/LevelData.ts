/**
 * Level data loader. Takes a `LevelData` JSON (produced by the standalone
 * HTML level editor) and mutates a fresh `BoardState` to match.
 *
 * The editor's JSON layout:
 *   - `taskHeight` rows of `taskZone` sit ABOVE `reservedHeight` rows of
 *     `reservedZone`. Both zones live in the bottom portion of `ROWS`.
 *   - Every prop layer (bombs, stones, chests, …) has matching `task*` and
 *     `reserved*` arrays of the same dimensions.
 *   - Optional `startingItems` seeds the player's magic-item inventory.
 *
 * On import we ALSO normalize a few legacy values:
 *   - `'row'` / `'col'` bomb kinds → `'row1'` / `'col1'`
 *   - Stone HP that isn't 2/3/4 → null
 *   - Any prop sitting on top of a higher-priority prop → cleared
 *     (matches the editor's `ensureBombArrays.fix` mutual-exclusion rules)
 */

import { COLS, ROWS, CellValue, MagicItemKey, ITEM_KEYS, BAG_TYPES, PieceType } from './Constants';
import { BoardState, BombKind, LevelData, Inventory, StoneHP, CustomPieceDef } from './Types';
import { emptyLevelBoardState } from './Board';
import { normalizeBombKind } from './Bombs';

export interface LoadedLevel {
    state:          BoardState;
    startingItems:  Partial<Inventory>;
    taskHeight:     number;
    reservedHeight: number;
    /** Optional custom-shape piece sanitised + ready for `Bag.setCustomShape`. */
    customPiece:    CustomPieceDef | null;
}

export function loadLevel(lvl: LevelData): LoadedLevel {
    const total = lvl.taskHeight + lvl.reservedHeight;
    // Grow the board dynamically so high-difficulty levels (up to ~50 task
    // rows + 4 reserved) fit. We reserve a generous `LEVEL_SAFETY_ROWS`
    // pad above the populated area: that's where pieces spawn AND it's
    // the room the player has to stack before topping out. Without this,
    // taller levels (think level 39 with 25 populated rows) would only
    // leave a tiny strip of room above the task zone, making the
    // `checkLevelTooTall` failure threshold feel cramped. The same
    // 16-row buffer matches what the default 20-row board gave a 4-row
    // reserved zone (i.e., it preserves the original feel at scale).
    const LEVEL_SAFETY_ROWS = 16;
    const neededRows = Math.max(ROWS, total + LEVEL_SAFETY_ROWS);
    const state = emptyLevelBoardState(neededRows);
    const startRow = neededRows - total;

    // Task zone (top of the populated area).
    paintZone(state, lvl, startRow, lvl.taskHeight, 'task');
    // Reserved zone sits immediately below the task zone.
    paintZone(state, lvl, startRow + lvl.taskHeight, lvl.reservedHeight, 'reserved');

    // Starting items — clamp each to [0, ITEM_MAX].
    const startingItems: Partial<Inventory> = {};
    if (lvl.startingItems) {
        for (const k of ITEM_KEYS) {
            const v = lvl.startingItems[k];
            if (typeof v === 'number' && v > 0) startingItems[k] = v;
        }
    }

    return {
        state,
        startingItems,
        taskHeight:     lvl.taskHeight,
        reservedHeight: lvl.reservedHeight,
        customPiece:    sanitiseCustomPiece(lvl.customPiece ?? null),
    };
}

/**
 * Validate + clean an editor-authored custom piece. Rejects empty matrices,
 * trims off rows/cols of all zeros, and falls back to a base type the bag
 * already knows about. Returns `null` for anything unusable.
 */
function sanitiseCustomPiece(def: CustomPieceDef | null | undefined): CustomPieceDef | null {
    if (!def || !Array.isArray(def.shape)) return null;
    if (!(BAG_TYPES as readonly PieceType[]).includes(def.baseType)) return null;
    // Coerce each row to a 0/1 array and require at least one filled cell.
    const rows: number[][] = [];
    let anyFilled = false;
    for (const r of def.shape) {
        if (!Array.isArray(r)) continue;
        const row = r.map(v => (v ? 1 : 0));
        if (row.some(v => v === 1)) anyFilled = true;
        rows.push(row);
    }
    if (!anyFilled) return null;
    // Pad shorter rows to a uniform width.
    const w = Math.max(...rows.map(r => r.length), 1);
    for (const r of rows) while (r.length < w) r.push(0);
    // Reject only TRULY disjoint shapes (no 8-connectivity — cells that
    // don't even touch at a corner). Diagonal-chain fate pieces ARE
    // allowed: the level editor authored them intentionally as
    // progressive difficulty, and the spawn/lock/rotate pipeline
    // handles them correctly — the piece just locks into two
    // separate columns, same as a horizontal 2-cell would.
    // (The previous 4-connectivity rejection was an over-correction
    // to a level-65 bug whose real cause was unrelated.)
    if (!isEightConnectedShape(rows)) {
        console.warn(`[LevelData] customPiece rejected: not 8-connected (baseType=${def.baseType})`);
        return null;
    }
    return { baseType: def.baseType, shape: rows };
}

/** Local 8-connectivity BFS (includes diagonal neighbours). Cells that
 *  only touch at a corner still count as one connected cluster. */
function isEightConnectedShape(shape: number[][]): boolean {
    let total = 0, startR = -1, startC = -1;
    for (let r = 0; r < shape.length; r++) {
        for (let c = 0; c < shape[r].length; c++) {
            if (shape[r][c]) {
                total++;
                if (startR < 0) { startR = r; startC = c; }
            }
        }
    }
    if (total <= 1) return true;
    const seen: boolean[][] = shape.map(row => row.map(() => false));
    const queue: number[] = [startR * 1000 + startC];
    seen[startR][startC] = true;
    let visited = 1;
    while (queue.length) {
        const code = queue.shift()!;
        const r = Math.floor(code / 1000);
        const c = code - r * 1000;
        const nbrs = [
            [r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1],
            [r - 1, c - 1], [r - 1, c + 1], [r + 1, c - 1], [r + 1, c + 1],
        ];
        for (const [nr, nc] of nbrs) {
            if (nr < 0 || nr >= shape.length) continue;
            if (nc < 0 || nc >= shape[nr].length) continue;
            if (!shape[nr][nc] || seen[nr][nc]) continue;
            seen[nr][nc] = true;
            visited++;
            queue.push(nr * 1000 + nc);
        }
    }
    return visited === total;
}

type ZoneId = 'task' | 'reserved';

function paintZone(state: BoardState, lvl: LevelData, baseRow: number, height: number, zone: ZoneId): void {
    const cells     = zone === 'task' ? lvl.taskZone      : lvl.reservedZone;
    const bombs     = zone === 'task' ? lvl.taskBombs     : lvl.reservedBombs;
    const stones    = zone === 'task' ? lvl.taskStones    : lvl.reservedStones;
    const chests    = zone === 'task' ? lvl.taskChests    : lvl.reservedChests;
    const meteors   = zone === 'task' ? lvl.taskMeteors   : lvl.reservedMeteors;
    const blizzards = zone === 'task' ? lvl.taskBlizzards : lvl.reservedBlizzards;
    const wreckers  = zone === 'task' ? lvl.taskWreckers  : lvl.reservedWreckers;
    const hails     = zone === 'task' ? lvl.taskHails     : lvl.reservedHails;
    const rockets   = zone === 'task' ? lvl.taskRockets   : lvl.reservedRockets;
    const gatlings  = zone === 'task' ? lvl.taskGatlings  : lvl.reservedGatlings;
    const booms     = zone === 'task' ? lvl.taskBooms     : lvl.reservedBooms;

    for (let r = 0; r < height; r++) {
        for (let c = 0; c < COLS; c++) {
            const dstR = baseRow + r;
            const v = cellAt(cells, r, c);
            if (v) state.board[dstR][c] = v as CellValue;

            // Bomb (mutually exclusive with stones/chests/etc; bomb wins).
            const b = normalizeBombKind(cellAt(bombs, r, c) as string | null);
            if (b) {
                state.boardBombs![dstR][c] = b as BombKind;
                // bombs imply the cell is solid — keep the existing color or
                // leave null (renderer treats null as "trap marker").
                continue;
            }

            // Stone.
            const s = cellAt(stones, r, c);
            if (s === 2 || s === 3 || s === 4) {
                state.boardStones![dstR][c] = s as StoneHP;
                continue;
            }

            // Higher-priority overlay props.
            if (cellAt(chests, r, c) === true) {
                state.boardChests![dstR][c] = true;
                continue;
            }
            if (cellAt(meteors, r, c) === true) {
                state.boardMeteors![dstR][c] = true;
                continue;
            }
            if (cellAt(blizzards, r, c) === true) {
                state.boardBlizzards![dstR][c] = true;
                continue;
            }
            if (cellAt(wreckers, r, c) === true) {
                state.boardWreckers![dstR][c] = true;
                continue;
            }
            if (cellAt(hails, r, c) === true) {
                state.boardHails![dstR][c] = true;
                continue;
            }
            if (cellAt(rockets, r, c) === true) {
                state.boardRockets![dstR][c] = true;
                continue;
            }
            if (cellAt(gatlings, r, c) === true) {
                state.boardGatlings![dstR][c] = true;
                continue;
            }
            // Boom — lowest priority overlay. Accept legacy 'boom1'/'boom2'/
            // 'boom3' strings too.
            const bm = cellAt(booms as unknown as (number | string | null)[][], r, c);
            const lvlNum = (bm === 1 || bm === 2 || bm === 3) ? bm
                         : bm === 'boom1' ? 1
                         : bm === 'boom2' ? 2
                         : bm === 'boom3' ? 3
                         : null;
            if (lvlNum && state.boardBooms) {
                state.boardBooms[dstR][c] = lvlNum as 1 | 2 | 3;
                continue;
            }
        }
    }
}

function cellAt<T>(grid: (T | null)[][] | undefined | null, r: number, c: number): T | null {
    if (!grid || !grid[r]) return null;
    return grid[r][c] ?? null;
}

/**
 * Validate a parsed JSON blob to be sure it looks like a `LevelData` before
 * we trust it. Returns the level on success, throws a descriptive error otherwise.
 */
export function validateLevelData(raw: unknown): LevelData {
    if (!raw || typeof raw !== 'object') throw new Error('Level JSON is not an object');
    const lvl = raw as Partial<LevelData>;
    const required: (keyof LevelData)[] = [
        'taskHeight', 'reservedHeight',
        'taskZone', 'reservedZone',
    ];
    for (const k of required) {
        if (lvl[k] === undefined) throw new Error(`Level JSON missing field: ${k}`);
    }
    if (typeof lvl.taskHeight !== 'number' || lvl.taskHeight < 1) {
        throw new Error('taskHeight must be a positive integer');
    }
    if (typeof lvl.reservedHeight !== 'number' || lvl.reservedHeight < 0) {
        throw new Error('reservedHeight must be a non-negative integer');
    }
    return lvl as LevelData;
}
