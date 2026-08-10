import { describe, it, expect } from 'vitest';
import { SHAPES, COLS } from '../../../assets/scripts/core/Constants';
import { makeEmptyBombs } from '../../../assets/scripts/core/Bombs';
import { pieceCenter } from '../../../assets/scripts/core/Pieces';
import { applyShapeshifterPick, SHAPESHIFTER_OPTIONS } from '../../../assets/scripts/core/Items/Shapeshifter';
import { Piece } from '../../../assets/scripts/core/Types';

function makePiece(type: keyof typeof SHAPES, x: number, y: number): Piece {
    const shape = SHAPES[type].map(r => r.slice());
    return { type, shape, bombs: makeEmptyBombs(shape), x, y };
}

describe('SHAPESHIFTER_OPTIONS', () => {
    it('exposes the 7 standard tetrominoes (no DOT)', () => {
        expect(SHAPESHIFTER_OPTIONS).toEqual(['I', 'O', 'T', 'S', 'Z', 'J', 'L']);
    });
});

describe('applyShapeshifterPick', () => {
    it('returns a piece of the new type', () => {
        const old = makePiece('T', 10, 5);
        const picked = applyShapeshifterPick(old, 'I');
        expect(picked.type).toBe('I');
        expect(picked.shape).toEqual(SHAPES.I);
    });

    it('keeps the center column aligned', () => {
        const old = makePiece('T', 10, 5);   // T at col 11.5 center
        const beforeCenter = pieceCenter(old);
        const picked = applyShapeshifterPick(old, 'I');
        const afterCenter = pieceCenter(picked);
        // The center should be at most 0.5 columns off (rounding).
        expect(Math.abs(beforeCenter - afterCenter)).toBeLessThanOrEqual(0.5);
    });

    it('y position is preserved', () => {
        const old = makePiece('T', 10, 7);
        const picked = applyShapeshifterPick(old, 'O');
        expect(picked.y).toBe(7);
    });

    it('bombs grid resets to match the new shape', () => {
        const old = makePiece('T', 10, 5);
        old.bombs[1][0] = 'row1';   // T has a cell at (1, 0)
        const picked = applyShapeshifterPick(old, 'I');
        // I has a different shape; bombs grid should match I's dims and be empty.
        expect(picked.bombs.length).toBe(SHAPES.I.length);
        expect(picked.bombs[0].length).toBe(SHAPES.I[0].length);
        expect(picked.bombs.every(row => row.every(v => v === null))).toBe(true);
    });

    it('respects cylinder wrap when center is near col 0', () => {
        const old = makePiece('I', COLS - 2, 5);   // I spans cols COLS-2 .. COLS+1
        const picked = applyShapeshifterPick(old, 'T');
        // No assertion on exact x, just that it doesn't crash and stays in [0, COLS).
        expect(picked.x).toBeGreaterThanOrEqual(0);
        expect(picked.x).toBeLessThan(COLS);
    });
});
