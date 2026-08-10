import { describe, it, expect } from 'vitest';
import { COLS, SHAPES } from '../../assets/scripts/core/Constants';
import { emptyEndlessBoardState, emptyLevelBoardState } from '../../assets/scripts/core/Board';
import { spawn, lock, gatherPieceBombs, gatherLevelBombs } from '../../assets/scripts/core/PieceOps';

describe('spawn', () => {
    it('centers a piece when lastSpawnCenterCol is null', () => {
        const piece = spawn('T', null);
        expect(piece.type).toBe('T');
        // T's shape spans cols 0..2, centered at COLS/2-ish.
        expect(piece.x).toBe(Math.floor((COLS - SHAPES.T[0].length) / 2));
    });

    it('I piece spawns with y = -1 so it can rotate without colliding', () => {
        const piece = spawn('I', null);
        expect(piece.y).toBe(-1);
    });

    it('non-I pieces spawn at y = 0', () => {
        for (const t of ['O', 'T', 'S', 'Z', 'J', 'L'] as const) {
            expect(spawn(t, null).y).toBe(0);
        }
    });

    it('aligns to lastSpawnCenterCol so the cylinder does not snap', () => {
        // Force the spawn centre to land near column 5.
        const piece = spawn('T', 5);
        // The piece's centre column should now be ≈ 5.
        const minX = (() => { for (let c = 0; c < piece.shape[0].length; c++) { for (let r = 0; r < piece.shape.length; r++) if (piece.shape[r][c]) return c; } return 0; })();
        const maxX = (() => { for (let c = piece.shape[0].length - 1; c >= 0; c--) { for (let r = 0; r < piece.shape.length; r++) if (piece.shape[r][c]) return c; } return 0; })();
        const center = piece.x + (minX + maxX + 1) / 2;
        expect(Math.abs(center - 5)).toBeLessThanOrEqual(0.5);
    });
});

describe('lock', () => {
    it('stamps filled cells onto the board', () => {
        const s = emptyEndlessBoardState();
        const piece = spawn('T', null);
        piece.y = 5;
        lock(s, piece);
        // T at (5+r, piece.x + c) wherever shape[r][c] is 1.
        let placed = 0;
        for (let r = 0; r < piece.shape.length; r++) {
            for (let c = 0; c < piece.shape[r].length; c++) {
                if (piece.shape[r][c]) {
                    expect(s.board[piece.y + r][(piece.x + c) % COLS]).toBe('T');
                    placed++;
                }
            }
        }
        expect(placed).toBe(4);   // T has 4 filled cells
    });

    it('drops cells with negative y silently', () => {
        const s = emptyEndlessBoardState();
        const piece = spawn('I', null);
        piece.y = -2;
        // No throw; nothing should land.
        lock(s, piece);
        for (let r = 0; r < s.board.length; r++) {
            for (let c = 0; c < COLS; c++) {
                expect(s.board[r][c]).toBeNull();
            }
        }
    });

    it('does NOT overwrite an existing level bomb in the same cell', () => {
        const s = emptyLevelBoardState();
        s.boardBombs![5][12] = 'row2';   // pre-existing level bomb
        const piece = spawn('T', null);
        piece.x = 11; piece.y = 4;
        // T's cell at (r=1, c=1) lands at (5, 12) — same as the pre-existing bomb.
        piece.bombs[1][1] = 'col1';   // piece carries a different bomb
        lock(s, piece);
        // The pre-existing bomb wins.
        expect(s.boardBombs![5][12]).toBe('row2');
    });
});

describe('gatherPieceBombs', () => {
    it('returns seeds for every bomb on a filled cell', () => {
        const s = emptyEndlessBoardState();
        const piece = spawn('T', null);
        piece.y = 4;
        piece.bombs[1][0] = 'row1';   // T has a cell at (1, 0)
        piece.bombs[1][2] = 'col2';
        const seeds = gatherPieceBombs(s, piece);
        expect(seeds.length).toBe(2);
        // Verify positions.
        const kinds = new Set(seeds.map(s => s.kind));
        expect(kinds.has('row1')).toBe(true);
        expect(kinds.has('col2')).toBe(true);
    });

    it('ignores bombs at out-of-bounds rows', () => {
        const s = emptyEndlessBoardState();
        const piece = spawn('I', null);
        piece.y = -3;   // entirely off-board
        piece.bombs[1][0] = 'row1';
        const seeds = gatherPieceBombs(s, piece);
        // The I piece has its filled row at index 1, so y+1 = -2 → still off-board.
        expect(seeds.length).toBe(0);
    });
});

describe('gatherLevelBombs', () => {
    it('returns bombs sitting in fully-filled rows', () => {
        const s = emptyLevelBoardState();
        const r = 10;
        for (let c = 0; c < COLS; c++) s.board[r][c] = 'T';
        s.boardBombs![r][5] = 'row1';
        s.boardBombs![r][15] = 'col2';
        const seeds = gatherLevelBombs(s);
        expect(seeds.length).toBe(2);
    });

    it('does NOT count hail-containing rows', () => {
        const s = emptyLevelBoardState();
        const r = 10;
        for (let c = 0; c < COLS; c++) s.board[r][c] = 'T';
        s.board[r][7] = 'H';   // hail breaks the "fullness"
        s.boardBombs![r][5] = 'row1';
        expect(gatherLevelBombs(s).length).toBe(0);
    });

    it('returns empty array when boardBombs is null', () => {
        const s = emptyEndlessBoardState();
        expect(gatherLevelBombs(s)).toEqual([]);
    });
});
