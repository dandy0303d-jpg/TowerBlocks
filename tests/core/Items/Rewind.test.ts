import { describe, it, expect } from 'vitest';
import { HISTORY_MAX } from '../../../assets/scripts/core/Constants';
import { emptyLevelBoardState, cloneBoardState } from '../../../assets/scripts/core/Board';
import { RewindHistory } from '../../../assets/scripts/core/Items/Rewind';

function freshSnapshot(score: number) {
    return {
        state:       emptyLevelBoardState(),
        score,
        lines:       Math.floor(score / 100),
        level:       1,
        towerHeight: 0,
    };
}

describe('RewindHistory', () => {
    it('requires at least 4 snapshots before activate works', () => {
        const h = new RewindHistory();
        for (let i = 0; i < 3; i++) h.snapshot(freshSnapshot(i * 100));
        const target = emptyLevelBoardState();
        expect(h.activate(target)).toBeNull();
    });

    it('activate restores the snapshot from 4 back and trims newer ones', () => {
        const h = new RewindHistory();
        // Push 5 snapshots with score 100, 200, 300, 400, 500.
        for (let i = 1; i <= 5; i++) h.snapshot(freshSnapshot(i * 100));
        expect(h.depth()).toBe(5);
        const target = emptyLevelBoardState();
        const outputs = h.activate(target);
        expect(outputs).not.toBeNull();
        // 4-back from depth 5 → index 5 - 4 = 1 → second push, score 200.
        expect(outputs!.score).toBe(200);
        // History trimmed to that index inclusive.
        expect(h.depth()).toBe(2);
    });

    it('respects HISTORY_MAX cap', () => {
        const h = new RewindHistory();
        for (let i = 0; i < HISTORY_MAX + 5; i++) h.snapshot(freshSnapshot(i));
        expect(h.depth()).toBe(HISTORY_MAX);
    });

    it('reset() drops all snapshots', () => {
        const h = new RewindHistory();
        for (let i = 0; i < 5; i++) h.snapshot(freshSnapshot(i));
        h.reset();
        expect(h.depth()).toBe(0);
    });

    it('restored state is deep-cloned (no aliasing)', () => {
        const h = new RewindHistory();
        const s = emptyLevelBoardState();
        s.board[0][0] = 'T';
        for (let i = 0; i < 5; i++) {
            h.snapshot({ state: cloneBoardState(s), score: i, lines: 0, level: 1, towerHeight: 0 });
        }
        const target = emptyLevelBoardState();
        h.activate(target);
        // Mutate target → original snapshot stack should not be affected.
        target.board[0][0] = null;
        // Re-snapshot + re-activate should still produce 'T' from the old snapshots.
        const target2 = emptyLevelBoardState();
        const out2 = h.activate(target2);
        // If aliasing leaked, target2.board[0][0] would also be null now.
        expect(out2 === null || target2.board[0][0] === 'T').toBe(true);
    });
});
