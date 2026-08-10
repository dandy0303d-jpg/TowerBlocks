import { describe, it, expect, vi } from 'vitest';
import { COLS, ROCKET_TOTAL } from '../../../assets/scripts/core/Constants';
import { emptyLevelBoardState } from '../../../assets/scripts/core/Board';
import { RocketState } from '../../../assets/scripts/core/Items/Rocket';

function runStormToFinish(
    rs: RocketState,
    state: ReturnType<typeof emptyLevelBoardState>,
    reservedTop: number,
    hooks: object = {},
): number {
    let totalResolved = 0;
    for (let i = 0; i < 100; i++) {
        totalResolved += rs.tick(500, state, reservedTop, hooks);
        if (!rs.mode) break;
    }
    return totalResolved;
}

/** Round-robin RNG that spreads rockets across distinct columns so the test
 *  is deterministic AND every rocket can find a target. (A pure `() => 0`
 *  RNG would dump every rocket into column 0 and exhaust its target cells
 *  before the 24th rocket spawns.) */
function makeRoundRobinRng(): () => number {
    let i = 0;
    return () => {
        const v = (i % COLS) / COLS + 0.0001;   // small offset to avoid boundary issues
        i++;
        return v;
    };
}

describe('RocketState — activation', () => {
    it('starts inactive', () => {
        const rs = new RocketState();
        expect(rs.mode).toBe(false);
        expect(rs.getFalling()).toHaveLength(0);
    });

    it('activate enables mode', () => {
        const rs = new RocketState();
        rs.activate();
        expect(rs.mode).toBe(true);
    });
});

describe('RocketState — full storm', () => {
    it('all 24 rockets resolve and onFinish fires', () => {
        const rs = new RocketState(makeRoundRobinRng());
        const s = emptyLevelBoardState();
        // Plant a vertical stack of colored cells so rockets have targets.
        for (let r = 5; r < 16; r++) {
            for (let c = 0; c < COLS; c++) s.board[r][c] = 'T';
        }
        const onFinish = vi.fn();
        rs.activate();
        const resolved = runStormToFinish(rs, s, s.board.length - 4, { onFinish });
        expect(resolved).toBe(ROCKET_TOTAL);
        expect(rs.mode).toBe(false);
        expect(onFinish).toHaveBeenCalledTimes(1);
    });

    it('each rocket erases exactly one colored cell when it hits', () => {
        const rs = new RocketState(makeRoundRobinRng());
        const s = emptyLevelBoardState();
        // Fill the entire task zone so every column has 16 candidates.
        for (let r = 0; r < s.board.length - 4; r++) {
            for (let c = 0; c < COLS; c++) s.board[r][c] = 'T';
        }
        let initialCount = 0;
        for (let r = 0; r < s.board.length; r++) {
            for (let c = 0; c < COLS; c++) {
                if (s.board[r][c] === 'T') initialCount++;
            }
        }
        rs.activate();
        runStormToFinish(rs, s, s.board.length - 4);
        let finalCount = 0;
        for (let r = 0; r < s.board.length; r++) {
            for (let c = 0; c < COLS; c++) {
                if (s.board[r][c] === 'T') finalCount++;
            }
        }
        // 24 rockets, each round-robin'd to a distinct column with 16 targets.
        // All 24 should hit.
        expect(initialCount - finalCount).toBe(ROCKET_TOTAL);
    });

    it('fizzles on an empty board (no T cells)', () => {
        const rs = new RocketState(makeRoundRobinRng());
        const s = emptyLevelBoardState();
        rs.activate();
        const onFinish = vi.fn();
        const resolved = runStormToFinish(rs, s, s.board.length - 4, { onFinish });
        // All 24 still resolve (as fizzles), and onFinish still fires.
        expect(resolved).toBe(ROCKET_TOTAL);
        expect(onFinish).toHaveBeenCalledTimes(1);
    });

    it('does NOT erase X (gray reserved) or H (hail) cells', () => {
        const rs = new RocketState(makeRoundRobinRng());
        const s = emptyLevelBoardState();
        for (let c = 0; c < COLS; c++) s.board[10][c] = 'X';   // gray row
        for (let c = 0; c < COLS; c++) s.board[12][c] = 'H';   // hail row
        // No colored cells → all rockets fizzle, X and H untouched.
        rs.activate();
        runStormToFinish(rs, s, s.board.length - 4);
        for (let c = 0; c < COLS; c++) {
            expect(s.board[10][c]).toBe('X');
            expect(s.board[12][c]).toBe('H');
        }
    });
});

describe('RocketState — onHit hook', () => {
    it('fires once per successful 1:1 cancellation', () => {
        const rs = new RocketState(makeRoundRobinRng());
        const s = emptyLevelBoardState();
        for (let r = 0; r < s.board.length - 4; r++) {
            for (let c = 0; c < COLS; c++) s.board[r][c] = 'T';
        }
        const onHit = vi.fn();
        rs.activate();
        runStormToFinish(rs, s, s.board.length - 4, { onHit });
        expect(onHit).toHaveBeenCalledTimes(ROCKET_TOTAL);
    });
});
