/**
 * Smoke test for the constants module. Mostly proves the Vitest + TypeScript
 * + alias wiring is healthy. Real behavioural tests live next to each gameplay
 * module they cover (Bag, ClearLines, Detonate, items/*, etc).
 */
import { describe, it, expect } from 'vitest';
import {
    COLS,
    ROWS,
    BASE_DROP_INTERVAL_MS,
    METEOR_DROP_INTERVAL,
    METEOR_SPEED_MULT,
    SHAPES,
    BAG_TYPES,
    COLORS,
    ITEM_KEYS,
    ITEM_BASE_PROBS,
    HAIL_TOTAL,
    ROCKET_TOTAL,
    WRECKER_TARGETS,
} from '../../assets/scripts/core/Constants';

describe('Constants', () => {
    it('board is 24 × 20', () => {
        expect(COLS).toBe(24);
        expect(ROWS).toBe(20);
    });

    it('all 7 random-bag shapes exist', () => {
        for (const t of BAG_TYPES) {
            expect(SHAPES[t]).toBeDefined();
            expect(SHAPES[t].length).toBeGreaterThan(0);
        }
        // DOT must NOT be in the random bag — only the meteor activator injects it.
        expect(BAG_TYPES).not.toContain('DOT' as never);
        // …but DOT's shape must still be defined for explicit spawns.
        expect(SHAPES.DOT).toEqual([[1]]);
    });

    it('meteor speed is exactly 7× base', () => {
        expect(METEOR_SPEED_MULT).toBe(7);
        expect(METEOR_DROP_INTERVAL).toBeCloseTo(BASE_DROP_INTERVAL_MS / 7);
    });

    it('every BAG_TYPES entry has a paired color', () => {
        for (const t of BAG_TYPES) {
            expect(COLORS[t]).toMatch(/^#[0-9a-f]{6}$/i);
        }
    });

    it('item base probabilities cover the full set', () => {
        for (const k of ITEM_KEYS) {
            expect(ITEM_BASE_PROBS[k]).toBeGreaterThan(0);
        }
        const sum = ITEM_KEYS.reduce((s, k) => s + ITEM_BASE_PROBS[k], 0);
        // Probs are normalised at runtime; just sanity-check the source values.
        expect(sum).toBeCloseTo(1.0, 5);
    });

    it('storm prop counts match the design doc', () => {
        expect(HAIL_TOTAL).toBe(72);
        expect(ROCKET_TOTAL).toBe(24);
        expect(WRECKER_TARGETS).toBe(10);
    });
});
