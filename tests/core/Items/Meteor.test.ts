import { describe, it, expect, vi } from 'vitest';
import { METEOR_PIECES } from '../../../assets/scripts/core/Constants';
import { Bag } from '../../../assets/scripts/core/Bag';
import { activateMeteor } from '../../../assets/scripts/core/Items/Meteor';

describe('activateMeteor — magic item (swapCurrent = true)', () => {
    it('swap + override + 8 from bag = 10 total', () => {
        const bag = new Bag(() => 0);
        const onSwap     = vi.fn(() => true);   // pretend there IS a live piece
        const onOverride = vi.fn();
        activateMeteor(bag, { swapCurrent: true, onSwapLivePiece: onSwap, onOverrideNextType: onOverride });
        expect(onSwap).toHaveBeenCalled();
        expect(onOverride).toHaveBeenCalled();
        // 8 picks should still be DOT.
        let dotsFromBag = 0;
        while (bag.meteorRemaining > 0) {
            if (bag.pick().type === 'DOT') dotsFromBag++;
        }
        expect(dotsFromBag).toBe(METEOR_PIECES - 1 - 1);   // 8
    });

    it('swap + override + 9 from bag = 10 when there is no live piece', () => {
        const bag = new Bag(() => 0);
        const onSwap     = vi.fn(() => false);   // no live piece → swap skipped
        const onOverride = vi.fn();
        activateMeteor(bag, { swapCurrent: true, onSwapLivePiece: onSwap, onOverrideNextType: onOverride });
        let dotsFromBag = 0;
        while (bag.meteorRemaining > 0) {
            if (bag.pick().type === 'DOT') dotsFromBag++;
        }
        expect(dotsFromBag).toBe(METEOR_PIECES - 0 - 1);   // 9
    });
});

describe('activateMeteor — level prop (swapCurrent = false)', () => {
    it('does NOT call onSwapLivePiece', () => {
        const bag = new Bag(() => 0);
        const onSwap = vi.fn();
        activateMeteor(bag, { swapCurrent: false, onSwapLivePiece: onSwap, onOverrideNextType: () => {} });
        expect(onSwap).not.toHaveBeenCalled();
    });

    it('queues 9 DOTs to the bag (1 swap skipped + 1 nextType)', () => {
        const bag = new Bag(() => 0);
        activateMeteor(bag, { swapCurrent: false, onOverrideNextType: () => {} });
        let dotsFromBag = 0;
        while (bag.meteorRemaining > 0) {
            if (bag.pick().type === 'DOT') dotsFromBag++;
        }
        expect(dotsFromBag).toBe(METEOR_PIECES - 0 - 1);   // 9
    });
});

describe('activateMeteor — re-trigger refills (never shrinks)', () => {
    it('second activation with the bag already mid-shower does not lower the count', () => {
        const bag = new Bag(() => 0);
        bag.queueDots(20);   // simulate a fat existing shower
        activateMeteor(bag, { swapCurrent: false, onOverrideNextType: () => {} });
        expect(bag.meteorRemaining).toBe(20);   // unchanged
    });
});
