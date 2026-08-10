/**
 * Piece lifecycle helpers — `spawn`, `lock`, and the two bomb-gathering passes
 * that feed `detonateBombs`. Kept here (rather than inlined in `GameState`)
 * so they're individually testable as pure functions.
 */

import { COLS, SHAPES, PieceType, CellValue } from './Constants';
import { BoardState, Piece, BombKind, BoomLevel } from './Types';
import { wrap } from './Board';
import { makeEmptyBombs, cloneBombs, makeEmptyBooms, cloneBooms, makeEmptyWreckers, cloneWreckers, parseBombKind } from './Bombs';
import { BombSeed } from './Detonate';

/**
 * Pad a (possibly rectangular) shape matrix to a square. Returns a fresh
 * matrix sized `n × n` where `n = max(rows, maxCols)`. Existing cells are
 * copied into the top-left; new cells are 0. No-op when the input is
 * already square.
 *
 * Needed because `rotate()` in GameState assumes a square grid (it uses
 * `n = grid.length` for both row and column counts). Standard tetrominoes
 * are always square, but FATE_SHAPES entries are trimmed to bounding box
 * — some are 1×3, 2×4, etc. — and rotating one without padding silently
 * drops every cell beyond row `n`.
 */
function padShapeToSquare(shape: number[][]): number[][] {
    const rows = shape.length;
    let cols = 0;
    for (const r of shape) if (r.length > cols) cols = r.length;
    const n = Math.max(rows, cols);
    if (rows === n && cols === n && shape.every(r => r.length === n)) return shape;
    const out: number[][] = [];
    for (let r = 0; r < n; r++) {
        const row = new Array<number>(n).fill(0);
        if (r < rows) {
            const src = shape[r];
            const w = Math.min(src.length, n);
            for (let c = 0; c < w; c++) row[c] = src[c] ? 1 : 0;
        }
        out.push(row);
    }
    return out;
}

/** Pad a parallel prop grid (bombs / booms / wreckers) to `n × n`,
 *  filling new cells with `null`. Used when the source shape was
 *  rectangular and we square-padded it — the parallel grids must keep
 *  the same dimensions or the rotate / lock / render passes go off the
 *  end. */
function padGridToSquare<T>(grid: (T | null)[][] | null, n: number): (T | null)[][] | null {
    if (!grid) return null;
    if (grid.length === n && grid.every(r => r.length === n)) return grid;
    const out: (T | null)[][] = [];
    for (let r = 0; r < n; r++) {
        const row: (T | null)[] = new Array(n).fill(null);
        if (r < grid.length) {
            const src = grid[r];
            const w = Math.min(src.length, n);
            for (let c = 0; c < w; c++) row[c] = src[c] ?? null;
        }
        out.push(row);
    }
    return out;
}

/**
 * Mixed-prop collision bonus: when a directional bomb (`rowN`/`colN`)
 * sits next to a range-blast boom (level M), the bomb's tier becomes
 * `tier × M` clamped to 4:
 *
 *   row1 + boom2 → row2  (1×2)
 *   row1 + boom3 → row3  (1×3)
 *   row2 + boom2 → row4  (2×2)
 *   col2 + boom3 → col4  (capped from 6)
 *   row3 + boom3 → row4  (capped from 9)
 *
 * Tier 4 (row4 / col4) is reachable ONLY through this amplification —
 * see `bombRowRange` for the 4-row blast pattern. Same-family
 * neighbours (bomb+bomb, bomb+wrecker, boom+boom) are NOT amplified,
 * and a boom-1 neighbour leaves the tier unchanged (×1 is a no-op).
 */
function maybeAmplifyBombKind(state: BoardState, r: number, c: number, kind: BombKind): BombKind {
    if (!state.boardBooms) return kind;
    const H = state.board.length;
    const candidates: Array<[number, number]> = [
        [r - 1, c],
        [r + 1, c],
        [r, wrap(c - 1)],
        [r, wrap(c + 1)],
    ];
    let maxBoom: number = 0;
    for (const [nr, nc] of candidates) {
        if (nr < 0 || nr >= H) continue;
        const lvl = state.boardBooms[nr] && state.boardBooms[nr][nc];
        if (lvl && lvl > maxBoom) maxBoom = lvl;
    }
    if (maxBoom <= 1) return kind;     // ×1 (or no boom) → unchanged
    const parsed = parseBombKind(kind);
    if (!parsed) return kind;
    const newTier = Math.min(4, parsed.count * maxBoom) as 1 | 2 | 3 | 4;
    if (newTier === parsed.count) return kind;
    return `${parsed.axis}${newTier}` as BombKind;
}

/**
 * Build a fresh piece of `type`. If `lastSpawnCenterCol` is provided, align
 * the new piece's centre to that column so the cylinder doesn't visually
 * snap when a new piece spawns mid-rotation.
 *
 * `bombs` is the bomb-template the next piece should carry (the queued
 * `nextBombsShape`); when omitted the piece spawns with an empty bombs grid.
 *
 * `shapeOverride` lets a custom-shape piece (drawn in the level editor)
 * supply its own matrix instead of looking up `SHAPES[type]`. The `type`
 * still drives the cell colour at lock time.
 */
export function spawn(
    type: PieceType,
    lastSpawnCenterCol: number | null = null,
    bombs: (BombKind | null)[][] | null = null,
    shapeOverride: number[][] | null = null,
    booms: (BoomLevel | null)[][] | null = null,
    wreckers: (true | null)[][] | null = null,
): Piece {
    // Pad the source matrix to a square so `rotate()` (which iterates an
    // n×n grid based on `grid.length`) doesn't silently drop cells outside
    // the row count. FATE_SHAPES are trimmed to bbox and can be 1×3, 2×4,
    // etc. — without padding, rotating one collapses the trailing columns
    // to nothing. Standard tetrominoes from `SHAPES` are already square
    // (3×3 or 4×4), so this is a no-op for them.
    const shape = padShapeToSquare((shapeOverride ?? SHAPES[type]).map(r => r.slice()));
    let spawnX = Math.floor((COLS - shape[0].length) / 2);
    if (lastSpawnCenterCol !== null) {
        let minX = shape[0].length, maxX = -1;
        for (let r = 0; r < shape.length; r++) {
            for (let c = 0; c < shape[r].length; c++) {
                if (shape[r][c]) {
                    if (c < minX) minX = c;
                    if (c > maxX) maxX = c;
                }
            }
        }
        const offset = maxX < 0 ? 0 : (minX + maxX + 1) / 2;
        spawnX = wrap(Math.round(lastSpawnCenterCol - offset));
    }
    const n = shape.length;
    // Square-pad the parallel grids to match the (now-square) shape so
    // rotate / lock / render passes don't drift off the end.
    const finalBombs    = bombs    ? padGridToSquare(cloneBombs(bombs), n)       : makeEmptyBombs(shape);
    const finalBooms    = booms    ? padGridToSquare(cloneBooms(booms), n)       : makeEmptyBooms(shape);
    const finalWreckers = wreckers ? padGridToSquare(cloneWreckers(wreckers), n) : makeEmptyWreckers(shape);
    return {
        type, shape,
        bombs:    finalBombs    as (BombKind | null)[][],
        booms:    finalBooms    as (BoomLevel | null)[][],
        wreckers: finalWreckers as (true | null)[][],
        x: spawnX,
        y: type === 'I' ? -1 : 0,
        // Mark fate / level-editor custom pieces so downstream code
        // (shapeshifter, hold) can preserve their hand-authored
        // geometry without relying on fragile structural matches.
        isCustomShape: shapeOverride !== null && shapeOverride !== undefined,
    };
}

/**
 * Stamp a piece's filled cells onto the board. Cells above the board top
 * (y < 0) are silently dropped — the piece extends past the spawn buffer.
 * Bombs riding on filled cells get written into `boardBombs` only if the
 * cell didn't already have a bomb there (so an explicit level bomb isn't
 * overwritten).
 */
export function lock(state: BoardState, piece: Piece): void {
    for (let r = 0; r < piece.shape.length; r++) {
        for (let c = 0; c < piece.shape[r].length; c++) {
            if (!piece.shape[r][c]) continue;
            const wx = wrap(piece.x + c);
            const wy = piece.y + r;
            if (wy < 0 || wy >= state.board.length) continue;
            state.board[wy][wx] = piece.type as CellValue;
            if (piece.bombs[r][c] && state.boardBombs && state.boardBombs[wy]) {
                if (!state.boardBombs[wy][wx]) {
                    state.boardBombs[wy][wx] = piece.bombs[r][c];
                }
            }
            // Booms — same "don't overwrite an existing prop" guard as bombs.
            if (piece.booms && piece.booms[r] && piece.booms[r][c]
                && state.boardBooms && state.boardBooms[wy]) {
                if (!state.boardBooms[wy][wx]) {
                    state.boardBooms[wy][wx] = piece.booms[r][c];
                }
            }
            // Wreckers — piece-embed prop. Stamps into boardWreckers,
            // fires via the existing wrecker chain when the host row
            // clears (processClearedWreckers / fireRowProps).
            if (piece.wreckers && piece.wreckers[r] && piece.wreckers[r][c]
                && state.boardWreckers && state.boardWreckers[wy]) {
                if (!state.boardWreckers[wy][wx]) {
                    state.boardWreckers[wy][wx] = piece.wreckers[r][c];
                }
            }
        }
    }
}

/** Gather any bombs embedded in a just-locked piece. */
export function gatherPieceBombs(state: BoardState, piece: Piece): BombSeed[] {
    const seeds: BombSeed[] = [];
    if (!piece || !piece.bombs) return seeds;
    for (let r = 0; r < piece.shape.length; r++) {
        for (let c = 0; c < piece.shape[r].length; c++) {
            if (piece.shape[r][c] && piece.bombs[r][c]) {
                const bx = wrap(piece.x + c);
                const by = piece.y + r;
                if (by < 0 || by >= state.board.length) continue;
                seeds.push({ r: by, c: bx, kind: piece.bombs[r][c]! });
            }
        }
    }
    return seeds;
}

/** Gather every level bomb sitting in a now-fully-filled row. Hail cells
 *  do NOT contribute to "fullness" (matches `clearLines`). */
export function gatherLevelBombs(state: BoardState): BombSeed[] {
    if (!state.boardBombs) return [];
    const seeds: BombSeed[] = [];
    for (let r = 0; r < state.board.length; r++) {
        let full = true;
        for (let c = 0; c < COLS; c++) {
            const v = state.board[r][c];
            if (v === null || v === 'H') { full = false; break; }
        }
        if (!full) continue;
        for (let c = 0; c < COLS; c++) {
            const k = state.boardBombs[r]?.[c];
            if (k) seeds.push({ r, c, kind: maybeAmplifyBombKind(state, r, c, k) });
        }
    }
    return seeds;
}

/** Gather every bomb whose 4-neighbour (up/down/left/right, columns wrap
 *  around the cylinder) carries ANOTHER PROP (bomb, boom, or wrecker).
 *  Bombs do NOT fire from touching a plain colored cell — landing on
 *  the stack alone shouldn't pop the bomb, only landing next to another
 *  prop should. The bomb otherwise waits for its host row to fill.
 *  Both halves of each pair emit separate seeds; `detonateBombs`'
 *  `triggered` set dedups so the chain count stays honest. */
export function gatherAdjacentBombs(state: BoardState): BombSeed[] {
    if (!state.boardBombs) return [];
    const seeds: BombSeed[] = [];
    const H = state.board.length;
    for (let r = 0; r < H; r++) {
        for (let c = 0; c < COLS; c++) {
            const kind = state.boardBombs[r]?.[c];
            if (!kind) continue;
            const candidates: Array<[number, number]> = [
                [r - 1, c],
                [r + 1, c],
                [r, wrap(c - 1)],
                [r, wrap(c + 1)],
            ];
            for (const [nr, nc] of candidates) {
                if (nr < 0 || nr >= H) continue;
                const nbBomb    = state.boardBombs[nr] && state.boardBombs[nr][nc];
                const nbBoom    = state.boardBooms && state.boardBooms[nr] && state.boardBooms[nr][nc];
                const nbWrecker = state.boardWreckers && state.boardWreckers[nr] && state.boardWreckers[nr][nc];
                if (nbBomb || nbBoom || nbWrecker) {
                    seeds.push({ r, c, kind: maybeAmplifyBombKind(state, r, c, kind) });
                    break;
                }
            }
        }
    }
    return seeds;
}

/** Boom-side counterpart of `gatherAdjacentBombs`: returns every boom
 *  whose 4-neighbour carries another PROP (bomb, boom, or wrecker).
 *  Unlike bombs, booms do NOT fire just from touching a colored cell —
 *  the per-pick Manhattan-N blast is too powerful to spend on every
 *  ordinary landing. A boom either waits for its host row to fill, or
 *  for a prop neighbour (which is what the wrecker × boom and
 *  bomb × boom combos rely on). Caller is expected to fire each entry
 *  through `activateBoom` BEFORE the regular detonate pass — otherwise
 *  the bomb's row-blast may splice the row that contains the boom,
 *  taking its data with it. */
export function gatherAdjacentBooms(state: BoardState): Array<{ r: number; c: number; level: 1 | 2 | 3 }> {
    if (!state.boardBooms) return [];
    const seeds: Array<{ r: number; c: number; level: 1 | 2 | 3 }> = [];
    const H = state.board.length;
    for (let r = 0; r < H; r++) {
        for (let c = 0; c < COLS; c++) {
            const lvl = state.boardBooms[r]?.[c];
            if (!lvl) continue;
            const candidates: Array<[number, number]> = [
                [r - 1, c],
                [r + 1, c],
                [r, wrap(c - 1)],
                [r, wrap(c + 1)],
            ];
            for (const [nr, nc] of candidates) {
                if (nr < 0 || nr >= H) continue;
                const nbBomb    = state.boardBombs && state.boardBombs[nr] && state.boardBombs[nr][nc];
                const nbBoom    = state.boardBooms[nr] && state.boardBooms[nr][nc];
                const nbWrecker = state.boardWreckers && state.boardWreckers[nr] && state.boardWreckers[nr][nc];
                if (nbBomb || nbBoom || nbWrecker) {
                    seeds.push({ r, c, level: lvl as 1 | 2 | 3 });
                    break;
                }
            }
        }
    }
    return seeds;
}

/** Wrecker adjacency rule (parallel to `gatherAdjacentBombs` and
 *  `gatherAdjacentBooms`): returns every wrecker whose 4-neighbour
 *  carries ANOTHER PROP (bomb, boom, or wrecker). Wreckers do NOT fire
 *  from touching a plain colored cell — landing on the stack alone
 *  shouldn't trigger the 10-pick sweep. The wrecker otherwise waits
 *  for its host cell to be cleared by something else. */
export function gatherAdjacentWreckers(state: BoardState): Array<{ r: number; c: number }> {
    if (!state.boardWreckers) return [];
    const seeds: Array<{ r: number; c: number }> = [];
    const H = state.board.length;
    for (let r = 0; r < H; r++) {
        for (let c = 0; c < COLS; c++) {
            if (!state.boardWreckers[r]?.[c]) continue;
            const candidates: Array<[number, number]> = [
                [r - 1, c],
                [r + 1, c],
                [r, wrap(c - 1)],
                [r, wrap(c + 1)],
            ];
            for (const [nr, nc] of candidates) {
                if (nr < 0 || nr >= H) continue;
                const nbBomb    = state.boardBombs && state.boardBombs[nr] && state.boardBombs[nr][nc];
                const nbBoom    = state.boardBooms && state.boardBooms[nr] && state.boardBooms[nr][nc];
                const nbWrecker = state.boardWreckers[nr] && state.boardWreckers[nr][nc];
                if (nbBomb || nbBoom || nbWrecker) {
                    seeds.push({ r, c });
                    break;
                }
            }
        }
    }
    return seeds;
}
