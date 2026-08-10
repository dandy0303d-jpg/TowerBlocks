/**
 * Bomb kind parsing and the row/column ranges they affect when triggered.
 * The original prototype stored bombs as `'row1' | 'row2' | 'row3' | 'col1' |
 * 'col2' | 'col3'` strings; legacy saves used bare `'row'` / `'col'` (treated
 * as count = 1). We accept both on parse and emit only the canonical forms.
 */

import { COLS } from './Constants';
import { BombKind, BoomLevel } from './Types';
import { wrap } from './Board';

export interface ParsedBomb {
    axis:  'row' | 'col';
    count: 1 | 2 | 3 | 4;
}

/** Parse any bomb identifier (legacy or canonical) into axis/count.
 *  Returns `null` for unrecognised values. Accepts tier 4 — reachable
 *  via the bomb × boom adjacency amplification (tier + level, cap 4). */
export function parseBombKind(kind: string | BombKind | null | undefined): ParsedBomb | null {
    if (!kind) return null;
    if (kind === 'row') return { axis: 'row', count: 1 };
    if (kind === 'col') return { axis: 'col', count: 1 };
    const m = /^(row|col)([1-4])$/.exec(kind);
    if (m) {
        const axis = m[1] as 'row' | 'col';
        const count = parseInt(m[2], 10) as 1 | 2 | 3 | 4;
        return { axis, count };
    }
    return null;
}

/** Normalise legacy `'row'` / `'col'` strings into `'row1'` / `'col1'`. */
export function normalizeBombKind(kind: string | null | undefined): BombKind | null {
    if (!kind) return null;
    if (kind === 'row') return 'row1';
    if (kind === 'col') return 'col1';
    if (/^(row|col)[1-4]$/.test(kind)) return kind as BombKind;
    return null;
}

/**
 * Rows affected by an N-row bomb anchored at row `r`:
 *   1 → [r]                       single row
 *   2 → [r, r + 1]                anchor + one row below
 *   3 → [r − 1, r, r + 1]         anchor + one above and one below
 *   4 → [r − 1, r, r + 1, r + 2]  centre-3 extended one row further down
 *
 * Out-of-range rows are kept in the output — callers clip against the live
 * board height.
 */
export function bombRowRange(r: number, count: 1 | 2 | 3 | 4): number[] {
    if (count <= 1) return [r];
    if (count === 2) return [r, r + 1];
    if (count === 3) return [r - 1, r, r + 1];
    return [r - 1, r, r + 1, r + 2];
}

/**
 * Columns affected by an N-col bomb anchored at column `c`. Wraps the cylinder.
 *   1 → [c]
 *   2 → [c, c + 1]
 *   3 → [c − 1, c, c + 1]
 *   4 → [c − 1, c, c + 1, c + 2]
 */
export function bombColRange(c: number, count: 1 | 2 | 3 | 4): number[] {
    if (count <= 1) return [wrap(c)];
    if (count === 2) return [wrap(c), wrap(c + 1)];
    if (count === 3) return [wrap(c - 1), wrap(c), wrap(c + 1)];
    return [wrap(c - 1), wrap(c), wrap(c + 1), wrap(c + 2)];
}

/** Build an empty bombs grid matching the shape of a tetromino. */
export function makeEmptyBombs(shape: number[][]): (BombKind | null)[][] {
    const out: (BombKind | null)[][] = [];
    for (let r = 0; r < shape.length; r++) {
        out.push(new Array<BombKind | null>(shape[r].length).fill(null));
    }
    return out;
}

/** Deep-clone a bombs grid. */
export function cloneBombs(bombs: (BombKind | null)[][]): (BombKind | null)[][] {
    return bombs.map(row => row.slice());
}

/** Flip a bomb's blast axis: `rowN` ↔ `colN`. Used when the carrier piece
 *  rotates 90° — the bomb visually points the same direction as the piece. */
export function flipBombAxis(kind: BombKind | null): BombKind | null {
    if (kind === 'row1') return 'col1';
    if (kind === 'row2') return 'col2';
    if (kind === 'row3') return 'col3';
    if (kind === 'row4') return 'col4';
    if (kind === 'col1') return 'row1';
    if (kind === 'col2') return 'row2';
    if (kind === 'col3') return 'row3';
    if (kind === 'col4') return 'row4';
    return kind;
}

/**
 * Embed a single bomb of the given tier into a piece's `bombs` grid. The host
 * cell is picked uniformly at random from the piece's filled cells. The axis
 * (row vs col) is also randomised, so the player can't predict orientation.
 * Mutates `bombsShape` in place.
 *
 *   tier = 1 → row1 / col1
 *   tier = 2 → row2 / col2
 *   tier = 3 → row3 / col3
 *
 * Returns the placed `BombKind`, or `null` if the shape has no filled cells.
 */
export function injectRandomBomb(
    bombsShape: (BombKind | null)[][],
    shape: number[][],
    tier: 1 | 2 | 3,
    rng: () => number = Math.random,
): BombKind | null {
    const filled: Array<[number, number]> = [];
    for (let r = 0; r < shape.length; r++) {
        for (let c = 0; c < shape[r].length; c++) {
            if (shape[r][c]) filled.push([r, c]);
        }
    }
    if (!filled.length) return null;
    const [r, c] = filled[Math.floor(rng() * filled.length)];
    const axis: 'row' | 'col' = rng() < 0.5 ? 'row' : 'col';
    const kind = `${axis}${tier}` as BombKind;
    bombsShape[r][c] = kind;
    return kind;
}

/** Build an empty booms grid (parallel to `bombsShape`) for a piece. */
export function makeEmptyBooms(shape: number[][]): (BoomLevel | null)[][] {
    const out: (BoomLevel | null)[][] = [];
    for (let r = 0; r < shape.length; r++) {
        out.push(new Array<BoomLevel | null>(shape[r].length).fill(null));
    }
    return out;
}

/** Deep-clone a booms grid. */
export function cloneBooms(booms: (BoomLevel | null)[][]): (BoomLevel | null)[][] {
    return booms.map(row => row.slice());
}

/** Build an empty wreckers grid (parallel to `bombsShape`) for a piece. */
export function makeEmptyWreckers(shape: number[][]): (true | null)[][] {
    const out: (true | null)[][] = [];
    for (let r = 0; r < shape.length; r++) {
        out.push(new Array<true | null>(shape[r].length).fill(null));
    }
    return out;
}

/** Deep-clone a wreckers grid. */
export function cloneWreckers(wreckers: (true | null)[][]): (true | null)[][] {
    return wreckers.map(row => row.slice());
}

/** Tier distribution weights by rows-cleared bucket.
 *
 *   N = 1  → mostly tier-1, rare tier-3
 *   N = 2  → balanced
 *   N ≥ 3 → mostly tier-3 with tier-2 backup
 *
 *  Indexed `[tier-1]`. */
const TIER_WEIGHTS_BY_N: Record<1 | 2 | 3, [number, number, number]> = {
    1: [0.70, 0.25, 0.05],
    2: [0.30, 0.50, 0.20],
    3: [0.10, 0.40, 0.50],
};

/** Family weights — row/col (direction blast) vs boom (range blast) vs
 *  wrecker (10-cell random sweep). Direction stays the most common
 *  because it stacks predictably; boom is the mid-rarity surprise;
 *  wrecker is the rare "wildcard" drop that triggers a board-wide
 *  random sweep when the host row clears. */
const FAMILY_WEIGHT_DIRECTION = 0.60;
const FAMILY_WEIGHT_BOOM      = 0.35;
const FAMILY_WEIGHT_WRECKER   = 0.05;

function pickTier(rowsCleared: number, rng: () => number): 1 | 2 | 3 {
    const bucket = (rowsCleared >= 3 ? 3 : rowsCleared >= 2 ? 2 : 1) as 1 | 2 | 3;
    const w = TIER_WEIGHTS_BY_N[bucket];
    const roll = rng();
    if (roll < w[0]) return 1;
    if (roll < w[0] + w[1]) return 2;
    return 3;
}

/**
 * Reward an N-row clear by embedding a single magic prop into the next
 * piece. Picks (tier, family) randomly:
 *
 *   - tier ∈ {1, 2, 3}, weighted toward higher tiers as `rowsCleared`
 *     grows (see TIER_WEIGHTS_BY_N).
 *   - family ∈ {direction, range}, weighted (default 60/40) toward
 *     direction so the rarer range blast still feels special.
 *   - if direction: axis ∈ {row, col} 50/50 → writes into `bombsShape`.
 *   - if range:    writes the tier as `BoomLevel` into `boomsShape`.
 *
 * Both shapes are mutated in place. Returns a tag string for logging /
 * tests, or `null` if the piece is empty.
 */
export function injectRandomMagicProp(
    bombsShape: (BombKind | null)[][],
    boomsShape: (BoomLevel | null)[][],
    shape: number[][],
    rowsCleared: number,
    rng: () => number = Math.random,
    wreckersShape: (true | null)[][] | null = null,
): string | null {
    const filled: Array<[number, number]> = [];
    for (let r = 0; r < shape.length; r++) {
        for (let c = 0; c < shape[r].length; c++) {
            if (shape[r][c]) filled.push([r, c]);
        }
    }
    if (!filled.length) return null;
    const [r, c] = filled[Math.floor(rng() * filled.length)];

    const familyRoll = rng();
    if (familyRoll < FAMILY_WEIGHT_DIRECTION) {
        // Direction blast: row or col, tiered by rows cleared.
        const tier = pickTier(rowsCleared, rng);
        const axis: 'row' | 'col' = rng() < 0.5 ? 'row' : 'col';
        const kind = `${axis}${tier}` as BombKind;
        bombsShape[r][c] = kind;
        if (boomsShape[r])   boomsShape[r][c]   = null;
        if (wreckersShape && wreckersShape[r]) wreckersShape[r][c] = null;
        return kind;
    }
    if (familyRoll < FAMILY_WEIGHT_DIRECTION + FAMILY_WEIGHT_BOOM) {
        // Range blast (boom), tiered by rows cleared.
        const tier = pickTier(rowsCleared, rng);
        const level = tier as BoomLevel;
        boomsShape[r][c] = level;
        if (bombsShape[r]) bombsShape[r][c] = null;
        if (wreckersShape && wreckersShape[r]) wreckersShape[r][c] = null;
        return `boom${level}`;
    }
    // Wrecker — rarest. No tier (always 10-cell random sweep). Only
    // applied when the caller supplied a wreckers grid (older callers
    // that don't yet plumb one fall back to a directional bomb).
    if (wreckersShape && wreckersShape[r]) {
        wreckersShape[r][c] = true;
        if (bombsShape[r]) bombsShape[r][c] = null;
        if (boomsShape[r]) boomsShape[r][c] = null;
        return 'wrecker';
    }
    // Fallback: caller didn't pass a wreckers grid — drop a direction
    // blast instead so the roll isn't wasted.
    const tier = pickTier(rowsCleared, rng);
    const axis: 'row' | 'col' = rng() < 0.5 ? 'row' : 'col';
    const kind = `${axis}${tier}` as BombKind;
    bombsShape[r][c] = kind;
    if (boomsShape[r]) boomsShape[r][c] = null;
    return kind;
}

// Re-export COLS so test files don't have to dual-import.
export { COLS };
