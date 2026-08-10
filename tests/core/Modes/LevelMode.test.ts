import { describe, it, expect } from 'vitest';
import { COLS } from '../../../assets/scripts/core/Constants';
import { emptyLevelBoardState } from '../../../assets/scripts/core/Board';
import {
    convertReservedZoneToGray,
    checkLevelWin,
    LevelChestProgress,
} from '../../../assets/scripts/core/Modes/LevelMode';

describe('convertReservedZoneToGray', () => {
    it('turns colored cells in reserved zone into X', () => {
        const s = emptyLevelBoardState();
        const reservedHeight = 4;
        const startRow = s.board.length - reservedHeight;
        s.board[startRow + 1][5] = 'T';
        s.board[startRow + 2][7] = 'I';
        convertReservedZoneToGray(s, reservedHeight);
        expect(s.board[startRow + 1][5]).toBe('X');
        expect(s.board[startRow + 2][7]).toBe('X');
    });

    it('leaves task-zone cells untouched', () => {
        const s = emptyLevelBoardState();
        const reservedHeight = 4;
        s.board[5][3] = 'T';   // task zone
        convertReservedZoneToGray(s, reservedHeight);
        expect(s.board[5][3]).toBe('T');
    });

    it('does NOT touch hail H cells', () => {
        const s = emptyLevelBoardState();
        const reservedHeight = 4;
        const startRow = s.board.length - reservedHeight;
        s.board[startRow + 1][5] = 'H';
        convertReservedZoneToGray(s, reservedHeight);
        expect(s.board[startRow + 1][5]).toBe('H');
    });

    it('no-op when reservedHeight === 0', () => {
        const s = emptyLevelBoardState();
        s.board[s.board.length - 1][0] = 'T';
        convertReservedZoneToGray(s, 0);
        expect(s.board[s.board.length - 1][0]).toBe('T');
    });
});

describe('checkLevelWin', () => {
    it('empty board wins', () => {
        const s = emptyLevelBoardState();
        expect(checkLevelWin(s)).toBe(true);
    });

    it('all-X reserved zone wins (no colored anywhere)', () => {
        const s = emptyLevelBoardState();
        for (let r = s.board.length - 4; r < s.board.length; r++) {
            for (let c = 0; c < COLS; c++) s.board[r][c] = 'X';
        }
        expect(checkLevelWin(s)).toBe(true);
    });

    it('any colored cell prevents winning', () => {
        const s = emptyLevelBoardState();
        s.board[3][5] = 'T';
        expect(checkLevelWin(s)).toBe(false);
    });

    it('hail cells prevent winning', () => {
        const s = emptyLevelBoardState();
        s.board[3][5] = 'H';
        // Note: my implementation says 'X' is the only allowed non-null. Hail counts as colored.
        // Actually re-reading the logic: `v && v !== 'X'` — for v='H', it's truthy AND not 'X', so returns false.
        expect(checkLevelWin(s)).toBe(false);
    });
});

describe('LevelChestProgress', () => {
    it('1 cleared row → no chest', () => {
        const p = new LevelChestProgress();
        expect(p.consume(1)).toBe(0);
    });

    it('2 cleared in one lock → 1 chest (multi-clear)', () => {
        const p = new LevelChestProgress();
        expect(p.consume(2)).toBe(1);
    });

    it('3+ cleared in one lock → 1 chest', () => {
        const p = new LevelChestProgress();
        expect(p.consume(3)).toBe(1);
    });

    it('every 5 cumulative → 1 chest', () => {
        const p = new LevelChestProgress();
        // 5 single clears → 1 cumulative chest at the 5th.
        let total = 0;
        for (let i = 0; i < 5; i++) total += p.consume(1);
        expect(total).toBe(1);
    });

    it('multi-clear and cumulative stack', () => {
        const p = new LevelChestProgress();
        // One lock clears 5 at once → 1 multi-clear chest + 1 cumulative chest = 2 chests
        expect(p.consume(5)).toBe(2);
    });

    it('reset() zeroes everything', () => {
        const p = new LevelChestProgress();
        p.consume(7);
        p.reset();
        expect(p.cumulativeCleared).toBe(0);
        expect(p.lastQuintile).toBe(0);
    });
});
