/**
 * Tetromino-shape math: rotation, center column, collision against a board.
 * Bombs are carried on each piece via a parallel `bombs` grid that rotates
 * in lockstep with the shape.
 */

import { CellValue } from './Constants';
import { BombKind, BoomLevel, Piece } from './Types';
import { wrap } from './Board';
import { flipBombAxis } from './Bombs';

/** Rotate a square shape grid `dir` × 90°. `dir > 0` = clockwise. */
export function rotateShape(shape: number[][], dir: number): number[][] {
    const n = shape.length;
    const out: number[][] = [];
    for (let r = 0; r < n; r++) out.push(new Array<number>(n).fill(0));
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            if (dir > 0) out[c][n - 1 - r] = shape[r][c]; // CW
            else         out[n - 1 - c][r] = shape[r][c]; // CCW
        }
    }
    return out;
}

/** Rotate a same-shape bombs grid alongside its piece. Each 90° rotation
 *  also flips the bomb's blast axis (`rowN` ↔ `colN`) so the bomb visually
 *  "points" the same direction as the rotated piece. */
export function rotateBombs(bombs: (BombKind | null)[][], dir: number): (BombKind | null)[][] {
    const n = bombs.length;
    const out: (BombKind | null)[][] = [];
    for (let r = 0; r < n; r++) out.push(new Array<BombKind | null>(n).fill(null));
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            const kind = bombs[r][c];
            if (!kind) continue;
            const flipped = flipBombAxis(kind);
            if (dir > 0) out[c][n - 1 - r] = flipped;
            else         out[n - 1 - c][r] = flipped;
        }
    }
    return out;
}

/** Rotate a same-shape booms grid alongside its piece. Booms are radial
 *  (Manhattan-distance diamond) so the level value is rotation-invariant
 *  — no axis flip, just a simple 90° transpose. */
export function rotateBooms(booms: (BoomLevel | null)[][], dir: number): (BoomLevel | null)[][] {
    const n = booms.length;
    const out: (BoomLevel | null)[][] = [];
    for (let r = 0; r < n; r++) out.push(new Array<BoomLevel | null>(n).fill(null));
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            const lvl = booms[r][c];
            if (!lvl) continue;
            if (dir > 0) out[c][n - 1 - r] = lvl;
            else         out[n - 1 - c][r] = lvl;
        }
    }
    return out;
}

/** Rotate a same-shape wreckers grid alongside its piece. Wrecker is a
 *  scalar marker (true/null), so this is just a 90° transpose — no
 *  per-cell value to flip. */
export function rotateWreckers(wreckers: (true | null)[][], dir: number): (true | null)[][] {
    const n = wreckers.length;
    const out: (true | null)[][] = [];
    for (let r = 0; r < n; r++) out.push(new Array<true | null>(n).fill(null));
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            if (!wreckers[r][c]) continue;
            if (dir > 0) out[c][n - 1 - r] = true;
            else         out[n - 1 - c][r] = true;
        }
    }
    return out;
}

/**
 * The "centre column" of a piece — `piece.x + (minX + maxX + 1) / 2`. Used
 * by the cylinder to keep the camera aligned with the active piece and by
 * the spawn logic to remember rotation between pieces.
 *
 * Empty shape → returns `piece.x`.
 */
export function pieceCenter(piece: Piece): number {
    if (!piece) return 0;
    let minX = piece.shape[0].length;
    let maxX = -1;
    for (let r = 0; r < piece.shape.length; r++) {
        for (let c = 0; c < piece.shape[r].length; c++) {
            if (piece.shape[r][c]) {
                if (c < minX) minX = c;
                if (c > maxX) maxX = c;
            }
        }
    }
    if (maxX < 0) return piece.x;
    return piece.x + (minX + maxX + 1) / 2;
}

/**
 * Collide a candidate piece position against a board.
 *   - Outside vertical bounds (top is OK, bottom is blocked) → collision.
 *   - Existing filled cell at `(y + r, wrap(x + c))` → collision.
 *
 * The cylinder wraps horizontally so we always wrap the column.
 */
export function collides(
    board: (CellValue | null)[][],
    piece: Piece,
    dx: number,
    dy: number,
    shape: number[][],
): boolean {
    for (let r = 0; r < shape.length; r++) {
        for (let c = 0; c < shape[r].length; c++) {
            if (!shape[r][c]) continue;
            const ny = piece.y + r + dy;
            const nx = wrap(piece.x + c + dx);
            if (ny < 0) continue;            // above the board — OK while spawning
            if (ny >= board.length) return true;
            const cell = board[ny][nx];
            if (cell !== null) return true;
        }
    }
    return false;
}
