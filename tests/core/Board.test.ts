import { describe, it, expect } from 'vitest';
import { COLS, ROWS } from '../../assets/scripts/core/Constants';
import {
    emptyBoard,
    emptyParallel,
    emptyEndlessBoardState,
    emptyLevelBoardState,
    cloneBoardLike,
    cloneBoardState,
    wrap,
    isColoredCell,
} from '../../assets/scripts/core/Board';

describe('emptyBoard', () => {
    it('produces ROWS × COLS of nulls', () => {
        const b = emptyBoard();
        expect(b.length).toBe(ROWS);
        for (const row of b) {
            expect(row.length).toBe(COLS);
            expect(row.every(v => v === null)).toBe(true);
        }
    });

    it('rows are independent (no shared reference)', () => {
        const b = emptyBoard();
        b[0][0] = 'T';
        expect(b[1][0]).toBeNull();
    });
});

describe('emptyEndlessBoardState / emptyLevelBoardState', () => {
    it('endless state has no parallel prop arrays', () => {
        const s = emptyEndlessBoardState();
        expect(s.board).toHaveLength(ROWS);
        expect(s.boardBombs).toBeNull();
        expect(s.boardStones).toBeNull();
        expect(s.boardChests).toBeNull();
        expect(s.boardMeteors).toBeNull();
        expect(s.boardBlizzards).toBeNull();
        expect(s.boardWreckers).toBeNull();
        expect(s.boardHails).toBeNull();
        expect(s.boardHailPlaced).toBeNull();
        expect(s.boardRockets).toBeNull();
    });

    it('level state has every parallel prop array initialised', () => {
        const s = emptyLevelBoardState();
        for (const arr of [
            s.boardBombs, s.boardStones, s.boardChests, s.boardMeteors,
            s.boardBlizzards, s.boardWreckers, s.boardHails, s.boardHailPlaced,
            s.boardRockets,
        ]) {
            expect(arr).not.toBeNull();
            expect(arr!.length).toBe(ROWS);
            expect(arr![0].length).toBe(COLS);
        }
    });
});

describe('cloneBoardLike', () => {
    it('returns null for null input', () => {
        expect(cloneBoardLike(null)).toBeNull();
    });
    it('produces an independent copy', () => {
        const src = emptyParallel<true>(3);
        src[1][2] = true;
        const dst = cloneBoardLike(src)!;
        expect(dst).toEqual(src);
        dst[0][0] = true;
        expect(src[0][0]).toBeNull();   // original untouched
    });
});

describe('cloneBoardState', () => {
    it('deep-clones every parallel array', () => {
        const s = emptyLevelBoardState();
        s.board[5][3] = 'T';
        s.boardBombs![5][3] = 'row1';
        const copy = cloneBoardState(s);
        copy.board[5][3] = null;
        copy.boardBombs![5][3] = null;
        // Original survives.
        expect(s.board[5][3]).toBe('T');
        expect(s.boardBombs![5][3]).toBe('row1');
    });
});

describe('wrap', () => {
    it('handles in-range values', () => {
        expect(wrap(0)).toBe(0);
        expect(wrap(COLS - 1)).toBe(COLS - 1);
    });
    it('wraps positive overflow', () => {
        expect(wrap(COLS)).toBe(0);
        expect(wrap(COLS + 5)).toBe(5);
        expect(wrap(COLS * 3 + 7)).toBe(7);
    });
    it('wraps negatives', () => {
        expect(wrap(-1)).toBe(COLS - 1);
        expect(wrap(-COLS)).toBe(0);
        expect(wrap(-COLS - 3)).toBe(COLS - 3);
    });
});

describe('isColoredCell', () => {
    it('treats every tetromino color as colored', () => {
        for (const v of ['I', 'O', 'T', 'S', 'Z', 'J', 'L', 'DOT'] as const) {
            expect(isColoredCell(v)).toBe(true);
        }
    });
    it('rejects null, gray reserved (X), and hail (H)', () => {
        expect(isColoredCell(null)).toBe(false);
        expect(isColoredCell('X')).toBe(false);
        expect(isColoredCell('H')).toBe(false);
    });
});
