import { describe, it, expect } from 'vitest';
import { COLS, ROWS } from '../../assets/scripts/core/Constants';
import { emptyLevelBoardState, emptyEndlessBoardState } from '../../assets/scripts/core/Board';
import { applyColumnGravity, evaporateHailPerColumn } from '../../assets/scripts/core/ColumnGravity';

describe('applyColumnGravity', () => {
    it('endless: cells fall to the literal board floor', () => {
        const s = emptyEndlessBoardState();
        s.board[0][3] = 'T';
        s.board[5][3] = 'I';
        applyColumnGravity(s, s.board.length);   // endless → floor = full height
        // Cells should be packed at the bottom: rows 18, 19 in column 3.
        expect(s.board[ROWS - 2][3]).toBe('T');  // upper one lands higher
        expect(s.board[ROWS - 1][3]).toBe('I');  // lower one lands at the floor
        // Everything else null in this column.
        for (let r = 0; r < ROWS - 2; r++) expect(s.board[r][3]).toBeNull();
    });

    it('level mode: cells stop above the reserved zone', () => {
        const s = emptyLevelBoardState();
        const reservedHeight = 4;
        const reservedTop = s.board.length - reservedHeight;   // 16
        // Pretend reserved zone is filled with X (the gravity should NOT touch those).
        for (let r = reservedTop; r < s.board.length; r++) {
            for (let c = 0; c < COLS; c++) s.board[r][c] = 'X';
        }
        // One colored cell floating in the task zone.
        s.board[2][5] = 'I';
        applyColumnGravity(s, reservedTop);
        // I should land at row reservedTop - 1 = 15 (just above the reserved zone).
        expect(s.board[reservedTop - 1][5]).toBe('I');
        expect(s.board[2][5]).toBeNull();
        // Reserved zone untouched.
        for (let r = reservedTop; r < s.board.length; r++) {
            for (let c = 0; c < COLS; c++) expect(s.board[r][c]).toBe('X');
        }
    });

    it('parallel props (bombs, chests) follow their host cell', () => {
        const s = emptyLevelBoardState();
        s.board[3][7] = 'T';
        s.boardBombs![3][7] = 'row2';
        s.boardChests![3][7] = true;
        const reservedTop = s.board.length - 4;
        applyColumnGravity(s, reservedTop);
        // 'T' moved to reservedTop - 1 = 15.
        expect(s.board[reservedTop - 1][7]).toBe('T');
        expect(s.boardBombs![reservedTop - 1][7]).toBe('row2');
        expect(s.boardChests![reservedTop - 1][7]).toBe(true);
        // Original slot empty.
        expect(s.board[3][7]).toBeNull();
        expect(s.boardBombs![3][7]).toBeNull();
        expect(s.boardChests![3][7]).toBeNull();
    });

    it('preserves relative top-to-bottom order in a column', () => {
        const s = emptyLevelBoardState();
        s.board[0][2] = 'I';
        s.board[2][2] = 'O';
        s.board[5][2] = 'T';
        const reservedTop = s.board.length - 4;
        applyColumnGravity(s, reservedTop);
        // Original order I, O, T (top→bottom). After gravity they should land
        // at rows 13, 14, 15 (reservedTop-3, reservedTop-2, reservedTop-1).
        expect(s.board[reservedTop - 3][2]).toBe('I');
        expect(s.board[reservedTop - 2][2]).toBe('O');
        expect(s.board[reservedTop - 1][2]).toBe('T');
    });
});

describe('evaporateHailPerColumn', () => {
    it('removes hail and drops cells above into the gap', () => {
        const s = emptyLevelBoardState();
        const col = 4;
        // Set up: colored cells above and below a hail column.
        // Row 5: T (above hail) — player placed it during hail life
        // Rows 8-9: hail
        // Row 13: I (below hail, untouched by evaporation)
        s.board[5][col]  = 'T';
        s.board[8][col]  = 'H'; s.boardHailPlaced![8][col]  = true;
        s.board[9][col]  = 'H'; s.boardHailPlaced![9][col]  = true;
        s.board[13][col] = 'I';

        evaporateHailPerColumn(s);

        // Cells in [0, 9] should be repacked at row 9 going up.
        // Only T exists above the hail → it should land at row 9.
        expect(s.board[9][col]).toBe('T');
        // Everything else in [0, 8] should be null.
        for (let r = 0; r <= 8; r++) expect(s.board[r][col]).toBeNull();
        // Row 13 cell ('I' below hail) MUST stay put.
        expect(s.board[13][col]).toBe('I');
        // Hail-placed markers all cleared.
        for (let r = 0; r < s.board.length; r++) {
            expect(s.boardHailPlaced![r][col]).toBeNull();
        }
    });

    it('column with no hail is untouched', () => {
        const s = emptyLevelBoardState();
        s.board[5][0] = 'T';
        s.board[10][0] = 'I';
        evaporateHailPerColumn(s);
        // Both cells should remain exactly where they were.
        expect(s.board[5][0]).toBe('T');
        expect(s.board[10][0]).toBe('I');
    });
});
