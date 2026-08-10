import { describe, it, expect } from 'vitest';
import { COLS, SHAPES } from '../../assets/scripts/core/Constants';
import { emptyBoard } from '../../assets/scripts/core/Board';
import { makeEmptyBombs } from '../../assets/scripts/core/Bombs';
import { rotateShape, rotateBombs, pieceCenter, collides } from '../../assets/scripts/core/Pieces';
import { Piece } from '../../assets/scripts/core/Types';

function makePiece(type: keyof typeof SHAPES, x: number, y: number): Piece {
    const shape = SHAPES[type].map(r => r.slice());
    return {
        type,
        shape,
        bombs: makeEmptyBombs(shape),
        x, y,
    };
}

describe('rotateShape', () => {
    it('CW rotation of T', () => {
        const t = [
            [0, 1, 0],
            [1, 1, 1],
            [0, 0, 0],
        ];
        const expected = [
            [0, 1, 0],
            [0, 1, 1],
            [0, 1, 0],
        ];
        expect(rotateShape(t, 1)).toEqual(expected);
    });

    it('CCW rotation of T', () => {
        const t = [
            [0, 1, 0],
            [1, 1, 1],
            [0, 0, 0],
        ];
        const expected = [
            [0, 1, 0],
            [1, 1, 0],
            [0, 1, 0],
        ];
        expect(rotateShape(t, -1)).toEqual(expected);
    });

    it('4 CW rotations return to original', () => {
        const t = SHAPES.T.map(r => r.slice());
        let cur = t;
        for (let i = 0; i < 4; i++) cur = rotateShape(cur, 1);
        expect(cur).toEqual(t);
    });
});

describe('rotateBombs', () => {
    it('rotates same as shape', () => {
        const bombs: ('row1' | null)[][] = [
            ['row1', null,   null],
            [null,   null,   null],
            [null,   null,   null],
        ];
        const rotated = rotateBombs(bombs, 1);
        // 'row1' was at (0,0) → CW → (0, 2)
        expect(rotated[0][2]).toBe('row1');
        expect(rotated[0][0]).toBeNull();
    });
});

describe('pieceCenter', () => {
    it('T piece (shape spans cols 0..2) at x=10 → center 11.5', () => {
        const p = makePiece('T', 10, 0);
        expect(pieceCenter(p)).toBe(11.5);
    });

    it('O piece (shape spans cols 0..1) at x=5 → center 6', () => {
        const p = makePiece('O', 5, 0);
        expect(pieceCenter(p)).toBe(6);
    });

    it('DOT at x=12 → center 12.5', () => {
        const p = makePiece('DOT', 12, 0);
        expect(pieceCenter(p)).toBe(12.5);
    });
});

describe('collides', () => {
    it('empty board, piece in bounds → no collision', () => {
        const b = emptyBoard();
        const p = makePiece('T', 10, 5);
        expect(collides(b, p, 0, 0, p.shape)).toBe(false);
    });

    it('piece occupying a filled cell collides', () => {
        const b = emptyBoard();
        b[6][11] = 'I';
        const p = makePiece('T', 10, 5);  // T at (10,5) — filled cell at (6, 11)
        // T has cell at row 1, col 1 (true center). Compose: y+r=5+1=6, x+c=10+1=11 ✓
        expect(collides(b, p, 0, 0, p.shape)).toBe(true);
    });

    it('falling past the bottom collides', () => {
        const b = emptyBoard();
        const p = makePiece('T', 10, b.length - 1);
        expect(collides(b, p, 0, 1, p.shape)).toBe(true);   // would go off bottom
    });

    it('wraps horizontally across the cylinder', () => {
        const b = emptyBoard();
        b[5][0] = 'I';   // cell at col 0
        // O piece (2-wide) at x=COLS-1, y=4: occupies (4, COLS-1), (4, 0), (5, COLS-1), (5, 0).
        const p = makePiece('O', COLS - 1, 4);
        expect(collides(b, p, 0, 0, p.shape)).toBe(true);
    });

    it('above-board rows don\'t collide', () => {
        const b = emptyBoard();
        b[0][12] = 'I';
        const p = makePiece('T', 11, -2);  // entirely above the board
        expect(collides(b, p, 0, 0, p.shape)).toBe(false);
    });
});
