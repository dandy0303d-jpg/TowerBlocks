import { describe, it, expect } from 'vitest';
import { BLIZZARD_DURATION_MS } from '../../../assets/scripts/core/Constants';
import { FakeClock } from '../../../assets/scripts/core/Clock';
import { BlizzardState } from '../../../assets/scripts/core/Items/Blizzard';

describe('BlizzardState', () => {
    it('initially inactive', () => {
        const clock = new FakeClock();
        const b = new BlizzardState(clock);
        expect(b.isActive()).toBe(false);
    });

    it('activate keeps the window open for BLIZZARD_DURATION_MS', () => {
        const clock = new FakeClock();
        const b = new BlizzardState(clock);
        b.activate();
        clock.advance(BLIZZARD_DURATION_MS - 1);
        expect(b.isActive()).toBe(true);
        clock.advance(1);
        expect(b.isActive()).toBe(false);
    });

    it('re-trigger extends but never SHRINKS the window', () => {
        const clock = new FakeClock();
        const b = new BlizzardState(clock);
        b.activate();
        clock.advance(BLIZZARD_DURATION_MS - 100);
        // Now there's only 100 ms left. Re-triggering must extend, not reset to <100.
        b.activate();
        expect(b.remainingMs()).toBe(BLIZZARD_DURATION_MS);
    });
});
