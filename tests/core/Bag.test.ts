import { describe, it, expect } from 'vitest';
import { BAG_TYPES } from '../../assets/scripts/core/Constants';
import { Bag } from '../../assets/scripts/core/Bag';

/** Deterministic RNG that always returns 0 → permutation stays in declaration order. */
const zeroRng = () => 0;

describe('Bag — normal play', () => {
    it('first 7 picks cover every BAG_TYPES entry exactly once', () => {
        const bag = new Bag(zeroRng);
        const seen = new Set<string>();
        for (let i = 0; i < BAG_TYPES.length; i++) {
            seen.add(bag.pick().type);
        }
        expect(seen.size).toBe(BAG_TYPES.length);
        for (const t of BAG_TYPES) expect(seen.has(t)).toBe(true);
    });

    it('14 picks see two full bags (each type appears twice)', () => {
        const bag = new Bag(zeroRng);
        const counts: Record<string, number> = {};
        for (let i = 0; i < BAG_TYPES.length * 2; i++) {
            const t = bag.pick().type;
            counts[t] = (counts[t] || 0) + 1;
        }
        for (const t of BAG_TYPES) expect(counts[t]).toBe(2);
    });

    it('never picks DOT from the random bag', () => {
        const bag = new Bag(zeroRng);
        for (let i = 0; i < 100; i++) {
            expect(bag.pick().type).not.toBe('DOT');
        }
    });

    it('standard picks carry null shape (use SHAPES[type])', () => {
        const bag = new Bag(zeroRng);
        for (let i = 0; i < 14; i++) {
            expect(bag.pick().shape).toBeNull();
        }
    });
});

describe('Bag — custom shape', () => {
    it('mixed into the bag — 8 picks see all 7 standard types + 1 custom', () => {
        const bag = new Bag(zeroRng);
        const custom = [[1,1],[0,1]];
        bag.setCustomShape({ type: 'T', shape: custom });
        const drawnShapes: ({ type: string; shape: number[][] | null })[] = [];
        for (let i = 0; i < BAG_TYPES.length + 1; i++) drawnShapes.push(bag.pick());
        // Exactly one of the 8 carries the custom shape.
        const customs = drawnShapes.filter(d => d.shape !== null);
        expect(customs.length).toBe(1);
        expect(customs[0].type).toBe('T');
        // The other 7 are the standard set.
        const standardTypes = drawnShapes.filter(d => d.shape === null).map(d => d.type).sort();
        expect(standardTypes).toEqual([...BAG_TYPES].sort());
    });
});

describe('Bag — meteor shower override', () => {
    it('queueDots(N) makes the next N picks all DOT', () => {
        const bag = new Bag(zeroRng);
        bag.queueDots(3);
        expect(bag.pick().type).toBe('DOT');
        expect(bag.pick().type).toBe('DOT');
        expect(bag.pick().type).toBe('DOT');
        // Then back to normal bag.
        expect(bag.pick().type).not.toBe('DOT');
    });

    it('queueDots stacks additively', () => {
        const bag = new Bag(zeroRng);
        bag.queueDots(2);
        bag.queueDots(3);  // total 5
        for (let i = 0; i < 5; i++) expect(bag.pick().type).toBe('DOT');
        expect(bag.pick().type).not.toBe('DOT');
    });

    it('inspect() reveals remaining DOTs', () => {
        const bag = new Bag(zeroRng);
        bag.queueDots(4);
        expect(bag.inspect().meteorRemaining).toBe(4);
        bag.pick();
        expect(bag.inspect().meteorRemaining).toBe(3);
    });
});

describe('Bag — reset', () => {
    it('reset() clears contents and meteor', () => {
        const bag = new Bag(zeroRng);
        bag.queueDots(5);
        bag.pick();   // forces refill of bag
        bag.reset();
        expect(bag.inspect().contents.length).toBe(0);
        expect(bag.inspect().meteorRemaining).toBe(0);
    });
});
