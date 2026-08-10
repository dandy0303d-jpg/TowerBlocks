import { describe, it, expect } from 'vitest';
import {
    COLS,
    ENDLESS_HEIGHT_LIMIT,
    ENDLESS_GRAY_CAP,
    ENDLESS_SCROLL_THRESHOLD,
    ENDLESS_DECILE_INTERVAL,
    ENDLESS_STREAK_THRESHOLD,
} from '../../../assets/scripts/core/Constants';
import { emptyEndlessBoardState } from '../../../assets/scripts/core/Board';
import {
    checkTrappedHole,
    countBottomCompleteRows,
    checkStackTooTall,
    convertCompleteRowsToGray,
    manageEndlessBoard,
    EndlessChestProgress,
} from '../../../assets/scripts/core/Modes/EndlessMode';

function fillRow(state: ReturnType<typeof emptyEndlessBoardState>, r: number, value: 'I' | 'O' | 'T' | 'X' = 'X') {
    for (let c = 0; c < COLS; c++) state.board[r][c] = value;
}

describe('checkTrappedHole', () => {
    it('empty board has no trapped hole', () => {
        const s = emptyEndlessBoardState();
        expect(checkTrappedHole(s)).toBe(false);
    });

    it('sealed pocket inside a stack is trapped', () => {
        const s = emptyEndlessBoardState();
        // Build a "lid" — top row full of cells with a single empty pocket below.
        for (let c = 0; c < COLS; c++) s.board[5][c] = 'T';
        s.board[6][3] = null;   // single pocket
        for (let c = 0; c < COLS; c++) if (c !== 3) s.board[6][c] = 'T';
        // Cells above row 5 are all empty. BFS from top should NOT reach (6, 3)
        // because row 5 is fully sealed.
        expect(checkTrappedHole(s)).toBe(true);
    });

    it('open pocket from the top is not trapped', () => {
        const s = emptyEndlessBoardState();
        // Stack with a vertical chute open to the top.
        for (let r = 5; r < s.board.length; r++) {
            for (let c = 0; c < COLS; c++) s.board[r][c] = 'T';
            s.board[r][12] = null;   // chute column 12 stays open
        }
        expect(checkTrappedHole(s)).toBe(false);
    });

    it('horizontal wrap counts as connectivity', () => {
        const s = emptyEndlessBoardState();
        // Wall in middle, but the edges (col 0, col COLS-1) stay open. Wrap should
        // let BFS reach the right side via col 0 → col COLS-1 connection.
        for (let c = 1; c < COLS - 1; c++) s.board[5][c] = 'T';
        expect(checkTrappedHole(s)).toBe(false);
    });
});

describe('countBottomCompleteRows', () => {
    it('counts contiguous full rows at the bottom', () => {
        const s = emptyEndlessBoardState();
        fillRow(s, s.board.length - 1);
        fillRow(s, s.board.length - 2);
        fillRow(s, s.board.length - 3);
        // row -4 is empty
        expect(countBottomCompleteRows(s)).toBe(3);
    });

    it('stops at the first non-full row', () => {
        const s = emptyEndlessBoardState();
        fillRow(s, s.board.length - 1);
        // row -2 has a gap
        s.board[s.board.length - 2][5] = null;
        expect(countBottomCompleteRows(s)).toBe(1);
    });
});

describe('checkStackTooTall', () => {
    it('empty board → not too tall', () => {
        const s = emptyEndlessBoardState();
        expect(checkStackTooTall(s)).toBe(false);
    });

    it('exactly HEIGHT_LIMIT non-gray rows → not too tall', () => {
        const s = emptyEndlessBoardState();
        const startR = s.board.length - ENDLESS_HEIGHT_LIMIT;
        // Leave one gap per row so they're NOT counted as part of the gray foundation
        // (countBottomCompleteRows treats any fully-filled row, gray or not, as
        // "complete" — the gap keeps each row genuinely "partial").
        for (let r = startR; r < s.board.length; r++) {
            fillRow(s, r, 'T');
            s.board[r][0] = null;
        }
        expect(checkStackTooTall(s)).toBe(false);
    });

    it('HEIGHT_LIMIT + 1 non-gray rows → too tall', () => {
        const s = emptyEndlessBoardState();
        const startR = s.board.length - ENDLESS_HEIGHT_LIMIT - 1;
        for (let r = startR; r < s.board.length; r++) {
            fillRow(s, r, 'T');
            s.board[r][0] = null;
        }
        expect(checkStackTooTall(s)).toBe(true);
    });

    it('gray foundation does not count toward the limit', () => {
        const s = emptyEndlessBoardState();
        // Bottom 5 rows are gray (foundation), 10 partial rows above.
        for (let r = s.board.length - 5; r < s.board.length; r++) fillRow(s, r, 'X');
        const startR = s.board.length - 5 - ENDLESS_HEIGHT_LIMIT;
        for (let r = startR; r < s.board.length - 5; r++) {
            fillRow(s, r, 'T');
            s.board[r][0] = null;
        }
        expect(checkStackTooTall(s)).toBe(false);
    });
});

describe('convertCompleteRowsToGray', () => {
    it('flips fully-filled non-gray rows to all X, returns the count', () => {
        const s = emptyEndlessBoardState();
        fillRow(s, 5, 'T');
        fillRow(s, 8, 'I');
        const count = convertCompleteRowsToGray(s);
        expect(count).toBe(2);
        for (let c = 0; c < COLS; c++) {
            expect(s.board[5][c]).toBe('X');
            expect(s.board[8][c]).toBe('X');
        }
    });

    it('already-gray rows do NOT recount', () => {
        const s = emptyEndlessBoardState();
        fillRow(s, 5, 'X');
        const count = convertCompleteRowsToGray(s);
        expect(count).toBe(0);
    });

    it('partial rows are ignored', () => {
        const s = emptyEndlessBoardState();
        for (let c = 0; c < COLS - 1; c++) s.board[5][c] = 'T';
        expect(convertCompleteRowsToGray(s)).toBe(0);
    });
});

describe('manageEndlessBoard', () => {
    it('caps gray foundation at ENDLESS_GRAY_CAP', () => {
        const s = emptyEndlessBoardState();
        // Stack ENDLESS_GRAY_CAP + 3 gray rows at the bottom.
        // We need to grow the board first since defaults are only ROWS rows.
        while (s.board.length < ENDLESS_GRAY_CAP + 5) {
            s.board.unshift(new Array(COLS).fill(null));
        }
        for (let i = 0; i < ENDLESS_GRAY_CAP + 3; i++) {
            fillRow(s, s.board.length - 1 - i, 'X');
        }
        manageEndlessBoard(s);
        let gray = 0;
        for (let r = 0; r < s.board.length; r++) {
            if (s.board[r].every(v => v === 'X')) gray++;
        }
        expect(gray).toBeLessThanOrEqual(ENDLESS_GRAY_CAP);
    });

    it('grows the board upward when the stack tops out within the threshold', () => {
        const s = emptyEndlessBoardState();
        // Put a cell within ENDLESS_SCROLL_THRESHOLD of row 0.
        s.board[0][5] = 'T';   // forces scroll
        const before = s.board.length;
        const added = manageEndlessBoard(s);
        expect(added).toBeGreaterThan(0);
        expect(s.board.length).toBeGreaterThan(before);
    });

    it('does nothing when the stack is well below the ceiling', () => {
        const s = emptyEndlessBoardState();
        s.board[s.board.length - 1][5] = 'T';   // single cell at the very bottom
        const added = manageEndlessBoard(s);
        expect(added).toBe(0);
    });
});

describe('EndlessChestProgress', () => {
    it('streak of 4 fully-filled rows → 1 chest', () => {
        const p = new EndlessChestProgress();
        let total = 0;
        for (let i = 0; i < 3; i++) total += p.consume(1);
        expect(total).toBe(0);
        total += p.consume(1);   // 4th
        expect(total).toBe(1);
    });

    it('locking with 0 filled rows resets the streak', () => {
        const p = new EndlessChestProgress();
        p.consume(1);
        p.consume(1);
        p.consume(0);            // reset
        expect(p.streak).toBe(0);
    });

    it('cumulative every 10 filled rows → 1 chest each', () => {
        const p = new EndlessChestProgress();
        let chests = 0;
        for (let i = 0; i < ENDLESS_DECILE_INTERVAL; i++) chests += p.consume(1);
        // After 10 single-rows, we've hit (streak chest @4) + (streak chest @8 → 2 streak chests)
        // PLUS cumulative chest at 10. So total = 2 streak + 1 cumulative = 3.
        expect(chests).toBe(3);
    });

    it('reset() clears everything', () => {
        const p = new EndlessChestProgress();
        p.consume(5);
        p.reset();
        expect(p.streak).toBe(0);
        expect(p.cumulative).toBe(0);
        expect(p.lastDecile).toBe(0);
    });
});
