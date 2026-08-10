import { describe, it, expect, vi } from 'vitest';
import {
    COLS,
    HAIL_TOTAL,
    HAIL_LIFE_PIECES,
    HAIL_DROP_INTERVAL_PER_ROW_MS,
    HAIL_SPAWN_STAGGER_MS,
} from '../../../assets/scripts/core/Constants';
import { emptyLevelBoardState } from '../../../assets/scripts/core/Board';
import { HailState, computeHailTargets } from '../../../assets/scripts/core/Items/Hail';

/** Run hail tick in large enough chunks for the storm to fully resolve. */
function runStormToFinish(hail: HailState, state: ReturnType<typeof emptyLevelBoardState>, hooks: object = {}): number {
    let totalLanded = 0;
    // 50 iterations × 500ms = 25 seconds wall time, more than enough.
    for (let i = 0; i < 50; i++) {
        totalLanded += hail.tick(500, state, hooks);
        if (!hail.mode) break;
    }
    return totalLanded;
}

describe('computeHailTargets', () => {
    it('all columns empty → 24 lowest-row targets per row (full board)', () => {
        const s = emptyLevelBoardState();
        const targets = computeHailTargets(s, 50);
        // Lowest row is s.board.length - 1; 24 columns at that row should come first.
        const lowest = s.board.length - 1;
        let lowestCount = 0;
        for (const t of targets) if (t.r === lowest) lowestCount++;
        expect(lowestCount).toBe(COLS);
    });

    it('column with a cell at row 14 → only rows 0..13 are eligible in that column', () => {
        const s = emptyLevelBoardState();
        s.board[14][5] = 'I';
        const targets = computeHailTargets(s, 1000);
        const col5 = targets.filter(t => t.c === 5);
        expect(col5.length).toBe(14);                     // rows 0..13
        expect(col5.every(t => t.r < 14)).toBe(true);
    });
});

describe('HailState — activation + spawn', () => {
    it('starts inactive', () => {
        const h = new HailState();
        expect(h.mode).toBe(false);
        expect(h.lifeRemaining).toBe(0);
        expect(h.getFalling()).toHaveLength(0);
    });

    it('activate() turns on mode', () => {
        const h = new HailState();
        h.activate();
        expect(h.mode).toBe(true);
    });

    it('first tick after activate computes the deferred targets', () => {
        const h = new HailState();
        const s = emptyLevelBoardState();
        h.activate();
        // First tick — should compute targets and start spawning.
        h.tick(HAIL_SPAWN_STAGGER_MS, s, {});
        // At least one drop should be in flight.
        expect(h.getFalling().length).toBeGreaterThanOrEqual(1);
    });
});

describe('HailState — full storm', () => {
    it('lands exactly HAIL_TOTAL drops, sets lifeRemaining = 3, fires onFinish', () => {
        const h = new HailState();
        const s = emptyLevelBoardState();
        // Fill one column with cells so there's something for hail to "rest on".
        // Actually not needed — empty board still allows hail to fill from bottom.
        const onFinish = vi.fn();
        h.activate();
        const landed = runStormToFinish(h, s, { onFinish });
        expect(landed).toBe(HAIL_TOTAL);
        expect(h.mode).toBe(false);
        expect(h.lifeRemaining).toBe(HAIL_LIFE_PIECES);
        expect(onFinish).toHaveBeenCalledTimes(1);
        // 72 H cells should now exist on the board.
        let hailCount = 0;
        for (let r = 0; r < s.board.length; r++) {
            for (let c = 0; c < COLS; c++) {
                if (s.board[r][c] === 'H') hailCount++;
            }
        }
        expect(hailCount).toBe(HAIL_TOTAL);
    });
});

describe('HailState — life timer', () => {
    it('decrements only after life is set and triggers evaporation at 0', () => {
        const h = new HailState();
        const s = emptyLevelBoardState();
        // Place hail manually so we have something to evaporate.
        s.board[10][5] = 'H';
        s.boardHailPlaced![10][5] = true;
        h.lifeRemaining = HAIL_LIFE_PIECES;   // pretend storm just finished

        const onEvaporate = vi.fn();
        h.tickLifeOnPieceLock(s, { onEvaporate });
        expect(h.lifeRemaining).toBe(2);
        expect(onEvaporate).not.toHaveBeenCalled();

        h.tickLifeOnPieceLock(s, { onEvaporate });
        expect(h.lifeRemaining).toBe(1);

        h.tickLifeOnPieceLock(s, { onEvaporate });
        expect(h.lifeRemaining).toBe(0);
        expect(onEvaporate).toHaveBeenCalledTimes(1);
        // Hail should now be gone.
        expect(s.board[10][5]).toBeNull();
        expect(s.boardHailPlaced![10][5]).toBeNull();
    });

    it('no-op when lifeRemaining is already 0', () => {
        const h = new HailState();
        const s = emptyLevelBoardState();
        const onEvaporate = vi.fn();
        h.tickLifeOnPieceLock(s, { onEvaporate });
        expect(h.lifeRemaining).toBe(0);
        expect(onEvaporate).not.toHaveBeenCalled();
    });
});

describe('HailState — reset', () => {
    it('clears everything', () => {
        const h = new HailState();
        const s = emptyLevelBoardState();
        h.activate();
        h.tick(HAIL_SPAWN_STAGGER_MS, s, {});
        h.lifeRemaining = 3;
        h.reset();
        expect(h.mode).toBe(false);
        expect(h.lifeRemaining).toBe(0);
        expect(h.getFalling()).toHaveLength(0);
    });
});
