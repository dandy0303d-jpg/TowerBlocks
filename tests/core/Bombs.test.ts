import { describe, it, expect } from 'vitest';
import { COLS } from '../../assets/scripts/core/Constants';
import {
    parseBombKind,
    normalizeBombKind,
    bombRowRange,
    bombColRange,
    makeEmptyBombs,
    cloneBombs,
} from '../../assets/scripts/core/Bombs';

describe('parseBombKind', () => {
    it('handles canonical kinds', () => {
        expect(parseBombKind('row1')).toEqual({ axis: 'row', count: 1 });
        expect(parseBombKind('row2')).toEqual({ axis: 'row', count: 2 });
        expect(parseBombKind('row3')).toEqual({ axis: 'row', count: 3 });
        expect(parseBombKind('col1')).toEqual({ axis: 'col', count: 1 });
        expect(parseBombKind('col2')).toEqual({ axis: 'col', count: 2 });
        expect(parseBombKind('col3')).toEqual({ axis: 'col', count: 3 });
    });
    it('accepts legacy short forms', () => {
        expect(parseBombKind('row')).toEqual({ axis: 'row', count: 1 });
        expect(parseBombKind('col')).toEqual({ axis: 'col', count: 1 });
    });
    it('rejects junk', () => {
        expect(parseBombKind(null)).toBeNull();
        expect(parseBombKind(undefined)).toBeNull();
        expect(parseBombKind('')).toBeNull();
        expect(parseBombKind('row4')).toBeNull();
        expect(parseBombKind('foo')).toBeNull();
    });
});

describe('normalizeBombKind', () => {
    it('promotes short forms', () => {
        expect(normalizeBombKind('row')).toBe('row1');
        expect(normalizeBombKind('col')).toBe('col1');
    });
    it('passes through canonical forms', () => {
        expect(normalizeBombKind('row2')).toBe('row2');
        expect(normalizeBombKind('col3')).toBe('col3');
    });
    it('returns null for invalid', () => {
        expect(normalizeBombKind(null)).toBeNull();
        expect(normalizeBombKind('garbage')).toBeNull();
    });
});

describe('bombRowRange', () => {
    it('count=1 → single anchor', () => {
        expect(bombRowRange(10, 1)).toEqual([10]);
    });
    it('count=2 → anchor + below', () => {
        expect(bombRowRange(10, 2)).toEqual([10, 11]);
    });
    it('count=3 → above + anchor + below', () => {
        expect(bombRowRange(10, 3)).toEqual([9, 10, 11]);
    });
});

describe('bombColRange', () => {
    it('count=1 wraps cleanly', () => {
        expect(bombColRange(0, 1)).toEqual([0]);
        expect(bombColRange(COLS - 1, 1)).toEqual([COLS - 1]);
    });
    it('count=2 wraps right edge', () => {
        expect(bombColRange(COLS - 1, 2)).toEqual([COLS - 1, 0]);
    });
    it('count=3 wraps both sides', () => {
        expect(bombColRange(0, 3)).toEqual([COLS - 1, 0, 1]);
        expect(bombColRange(COLS - 1, 3)).toEqual([COLS - 2, COLS - 1, 0]);
    });
});

describe('makeEmptyBombs / cloneBombs', () => {
    it('makeEmptyBombs matches shape dims', () => {
        const shape = [[1, 1, 1], [0, 1, 0]];
        const b = makeEmptyBombs(shape);
        expect(b.length).toBe(2);
        expect(b[0].length).toBe(3);
        expect(b.every(row => row.every(v => v === null))).toBe(true);
    });
    it('cloneBombs is independent', () => {
        const src = makeEmptyBombs([[1, 1], [1, 1]]);
        src[0][1] = 'row2';
        const dst = cloneBombs(src);
        dst[0][1] = null;
        expect(src[0][1]).toBe('row2');
    });
});
