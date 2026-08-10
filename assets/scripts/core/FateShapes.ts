/**
 * 99 distinct "fate piece" shapes (1..5 cells, 8-connected, free under
 * rotation/reflection/translation). Generated offline via Python BFS +
 * canonicalisation; mirrors the FATE_SHAPES embedded in `tetris.html`.
 *
 * Each entry is a trimmed-to-bbox bitmap (number[][]) where 1 = filled.
 * Sizes:
 *   1 格: 1 形状
 *   2 格: 2 形状
 *   3 格: 5 形状
 *   4 格: 22 形状
 *   5 格: 69 形状
 *
 * Used by the "本命方块" entry modal — the player can keep the shape the
 * level assigned, or hit "逆天改命" to reroll a random one.
 */

import { PieceType } from './Constants';
import { CustomPieceDef } from './Types';

export const FATE_SHAPES: number[][][] = [
    [[1]],
    [[1,1]],
    [[1,0],[0,1]],
    [[1,1,1]],
    [[1,1],[1,0]],
    [[1,1,0],[0,0,1]],
    [[1,0,1],[0,1,0]],
    [[1,0,0],[0,1,0],[0,0,1]],
    [[1,1,1,1]],
    [[1,1,1],[1,0,0]],
    [[1,1,1],[0,1,0]],
    [[1,1,1],[0,0,0,1]],
    [[1,1,0,1],[0,0,1,0]],
    [[1,1],[1,1]],
    [[1,1,0],[1,0,1]],
    [[1,1,0],[0,1,1]],
    [[1,1,0],[0,1,0],[0,0,1]],
    [[1,1,0,0],[0,0,1,1]],
    [[1,1,0],[0,0,1],[0,1,0]],
    [[1,1,0],[0,0,1],[0,0,1]],
    [[1,1,0,0],[0,0,1,0],[0,0,0,1]],
    [[1,0,1,0],[0,1,0,1]],
    [[1,0,1],[0,1,0],[1,0,0]],
    [[1,0,1],[0,1,0],[0,1,0]],
    [[1,0,0,1],[0,1,1,0]],
    [[1,0,0],[0,1,1],[0,1,0]],
    [[1,0,0,0],[0,1,1,0],[0,0,0,1]],
    [[1,0,0],[0,1,0,1],[0,0,1,0]],
    [[1,0,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]],
    [[0,1,0],[1,0,1],[0,1,0]],
    [[1,1,1,1],[1,0,0,0]],
    [[1,1,1,1],[0,1,0,0]],
    [[1,1,1],[1,1,0]],
    [[1,1,1],[1,0,1]],
    [[1,1,1,0],[1,0,0,1]],
    [[1,1,1],[1,0,0],[1,0,0]],
    [[1,1,1],[1,0,0],[0,1,0]],
    [[1,1,1,0],[0,1,0,1]],
    [[1,1,1],[0,1,0],[1,0,0]],
    [[1,1,1],[0,1,0],[0,1,0]],
    [[1,1,1,0],[0,0,1,1]],
    [[1,1,1,0],[0,0,1,0],[0,0,0,1]],
    [[1,1,1,0],[0,0,0,1],[0,0,1,0]],
    [[1,1,1,0],[0,0,0,1],[0,0,0,1]],
    [[1,1,0,1],[1,0,1,0]],
    [[1,1,0,1],[0,1,1,0]],
    [[1,1,0,1],[0,0,1,1]],
    [[1,1,0,1],[0,0,1,0],[0,1,0,0]],
    [[1,1,0,1],[0,0,1,0],[0,0,1,0]],
    [[1,1,0,1],[0,0,1,0],[0,0,0,1]],
    [[1,1,0],[1,1,0],[0,0,1]],
    [[1,1,0],[1,0,1],[0,1,0]],
    [[1,1,0],[1,0,1],[0,0,1]],
    [[1,1,0,0],[1,0,1,0],[0,0,0,1]],
    [[1,1,0],[0,1,1],[1,0,0]],
    [[1,1,0],[0,1,1],[0,1,0]],
    [[1,1,0],[0,1,1],[0,0,1]],
    [[1,1,0,0],[0,1,1,0],[0,0,0,1]],
    [[1,1,0,0],[0,1,0,1],[0,0,1,0]],
    [[1,1,0],[0,1,0],[1,0,1]],
    [[1,1,0],[0,1,0],[0,1,1]],
    [[1,1,0],[0,1,0],[0,1,0],[0,0,1]],
    [[1,1,0,0],[0,1,0,0],[0,0,1,1]],
    [[1,1,0],[0,1,0],[0,0,1],[0,1,0]],
    [[1,1,0],[0,1,0],[0,0,1],[0,0,1]],
    [[1,1,0,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]],
    [[1,1,0,0],[0,0,1,1],[0,1,0,0]],
    [[1,1,0,0],[0,0,1,1],[0,0,1,0]],
    [[1,1,0],[0,0,1],[1,1,0]],
    [[1,1,0,0],[0,0,1,0],[0,1,0,1]],
    [[1,1,0,0],[0,0,1,0],[0,1,0,0],[1,0,0,0]],
    [[1,1,0],[0,0,1],[0,1,0],[0,1,0]],
    [[1,1,0,0],[0,0,1,0],[0,1,0,0],[0,0,1,0]],
    [[1,1,0,0],[0,0,1,0],[0,0,1,0],[0,1,0,0]],
    [[1,1,0,0],[0,0,1,0],[0,0,1,0],[0,0,0,1]],
    [[1,1,0,0],[0,0,1,0],[0,0,0,1],[0,0,1,0]],
    [[1,1,0,0],[0,0,1,0],[0,0,0,1],[0,0,0,1]],
    [[1,0,1,0],[0,1,1,0],[0,0,0,1]],
    [[1,0,1,0],[0,1,0,1],[1,0,0,0]],
    [[1,0,1,0],[0,1,0,1],[0,1,0,0]],
    [[1,0,1,0],[0,1,0,1],[0,0,1,0]],
    [[1,0,1],[0,1,0],[1,0,1]],
    [[1,0,1,0],[0,1,0,0],[0,1,0,0],[1,0,0,0]],
    [[1,0,1],[0,1,0],[0,1,0],[0,1,0]],
    [[1,0,1,0],[0,1,0,0],[0,0,1,0],[0,0,0,1]],
    [[1,0,0,1],[0,1,1,0],[0,1,0,0]],
    [[1,0,0],[0,1,1,1],[0,1,0,0]],
    [[1,0,0],[0,1,1,1],[0,0,1,0]],
    [[1,0,0,0],[0,1,1,0],[0,0,1,0],[0,1,0,0]],
    [[1,0,0,0],[0,1,1,0],[0,0,1,0],[0,0,0,1]],
    [[1,0,0,0],[0,1,1,0],[0,0,0,1],[0,0,1,0]],
    [[1,0,0,0],[0,1,0,1],[0,0,1,0],[0,1,0,0]],
    [[1,0,0,0],[0,1,0,1],[0,0,1,0],[0,0,1,0]],
    [[1,0,0],[0,1,0],[0,0,1,1],[0,0,1,0]],
    [[0,1,1,0],[1,0,0,1],[0,1,0,0]],
    [[0,1,0],[1,1,1],[0,1,0]],
    [[0,1,0,0],[1,1,0,1],[0,0,1,0]],
    [[0,1,0,0],[1,0,1,1],[0,1,0,0]],
    [[0,1,0,0],[1,0,1,0],[0,0,0,1],[0,0,1,0]],
];

const BASE_TYPES_ROT: PieceType[] = ['I','O','T','S','Z','J','L'];

/** True iff every filled cell of `shape` is reachable from any other
 *  filled cell using ONLY orthogonal (4-direction) adjacency. The
 *  canonical FATE_SHAPES list is 8-connected — diagonal-only shapes
 *  like [[1,0],[0,1]] create unrecoverable holes when they land on an
 *  uneven stack in endless mode, so endless restricts itself to the
 *  4-connected subset. */
function isFourConnected(shape: number[][]): boolean {
    let total = 0;
    let startR = -1, startC = -1;
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
        const nbrs = [[r - 1, c], [r + 1, c], [r, c - 1], [r, c + 1]];
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

/** Indices of FATE_SHAPES entries that are 4-connected. Endless mode
 *  picks fate pieces from this filtered list to avoid dead-locking
 *  shapes (diagonals create holes too narrow for any tetromino to
 *  fill on an uneven stack). Computed once at module load. */
export const FATE_SHAPES_4CONNECTED_INDICES: number[] = (() => {
    const out: number[] = [];
    for (let i = 0; i < FATE_SHAPES.length; i++) {
        if (isFourConnected(FATE_SHAPES[i])) out.push(i);
    }
    return out;
})();

/** Cell count per FATE_SHAPES entry — number of `1`s in the bitmap.
 *  Precomputed once at module load; drives the weighted-random rolls
 *  in `pickFateIndex*` (larger shapes have proportionally higher pick
 *  probability). */
const FATE_SHAPE_CELL_COUNTS: number[] = FATE_SHAPES.map(shape => {
    let n = 0;
    for (let r = 0; r < shape.length; r++) {
        for (let c = 0; c < shape[r].length; c++) {
            if (shape[r][c]) n++;
        }
    }
    return n;
});

/** Draw one index from `pool` (an array of FATE_SHAPES indices), weighted
 *  by each shape's cell count — a 5-cell shape is 5× more likely to be
 *  picked than a 1-cell shape, so larger pieces dominate the roll while
 *  smaller pieces stay accessible. Rejects `avoid` (retries up to a few
 *  times, then falls back to unweighted). */
function pickWeightedFromPool(pool: number[], avoid: number, rng: () => number): number {
    if (pool.length === 0) return 0;
    if (pool.length === 1) return pool[0];

    // Total weight, skipping the `avoid` index so it can never be drawn.
    let total = 0;
    for (const i of pool) {
        if (i === avoid) continue;
        total += FATE_SHAPE_CELL_COUNTS[i];
    }
    if (total <= 0) {
        // Degenerate (pool contains only `avoid`, or all zero-cell) —
        // just return anything non-avoid, or the first entry.
        for (const i of pool) if (i !== avoid) return i;
        return pool[0];
    }
    // Draw a real in [0, total) and walk the cumulative weights.
    let r = rng() * total;
    for (const i of pool) {
        if (i === avoid) continue;
        r -= FATE_SHAPE_CELL_COUNTS[i];
        if (r < 0) return i;
    }
    // Floating-point slop fallback — shouldn't happen in practice.
    return pool[pool.length - 1];
}

/** Endless-mode variant of {@link pickFateIndex} — draws from the
 *  4-connected subset only, weighted by cell count. `avoid` should be
 *  a FATE_SHAPES index (not a subset index). */
export function pickFateIndex4Connected(avoid: number, rng: () => number = Math.random): number {
    return pickWeightedFromPool(FATE_SHAPES_4CONNECTED_INDICES, avoid, rng);
}

/** Match a 4×4 shape against the canonical FATE_SHAPES list. Returns -1
 *  if no exact match — eg. a hand-authored custom piece in a level. */
export function fateIndexOfShape(shape: number[][] | undefined | null): number {
    if (!Array.isArray(shape)) return -1;
    // Trim shape to its bbox for comparison.
    const flatRows = shape.filter(row => Array.isArray(row));
    if (!flatRows.length) return -1;
    let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
    for (let r = 0; r < flatRows.length; r++) {
        for (let c = 0; c < flatRows[r].length; c++) {
            if (flatRows[r][c]) {
                if (r < minR) minR = r; if (r > maxR) maxR = r;
                if (c < minC) minC = c; if (c > maxC) maxC = c;
            }
        }
    }
    if (minR > maxR) return -1;
    const h = maxR - minR + 1, w = maxC - minC + 1;
    for (let i = 0; i < FATE_SHAPES.length; i++) {
        const s = FATE_SHAPES[i];
        if (s.length !== h || s[0].length !== w) continue;
        let ok = true;
        for (let r = 0; r < h && ok; r++) {
            for (let c = 0; c < w && ok; c++) {
                const a = flatRows[minR + r] && flatRows[minR + r][minC + c] ? 1 : 0;
                if (a !== s[r][c]) ok = false;
            }
        }
        if (ok) return i;
    }
    return -1;
}

/** All FATE_SHAPES indices — used as the pool for the unweighted
 *  variant's replacement (see `pickFateIndex`). Precomputed to save
 *  allocating a fresh 0..N-1 array on every roll. */
const FATE_SHAPES_ALL_INDICES: number[] = FATE_SHAPES.map((_, i) => i);

/** Pick a random FATE_SHAPES index distinct from `avoid`, weighted by
 *  cell count — larger shapes get proportionally higher pick odds
 *  (a 5-cell shape is 5× more likely than a 1-cell shape). Keeps
 *  small shapes accessible but makes them rare. */
export function pickFateIndex(avoid: number, rng: () => number = Math.random): number {
    return pickWeightedFromPool(FATE_SHAPES_ALL_INDICES, avoid, rng);
}

/** Build a CustomPieceDef for the level system from a FATE_SHAPES index. */
export function fateShapeAsCustomPiece(idx: number, baseType?: PieceType): CustomPieceDef {
    const shape = FATE_SHAPES[idx].map(row => row.slice());
    const type  = baseType ?? BASE_TYPES_ROT[idx % BASE_TYPES_ROT.length];
    return { baseType: type, shape };
}
