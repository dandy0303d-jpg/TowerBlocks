import { describe, it, expect } from 'vitest';
import { HOURGLASS_DURATION_MS } from '../../../assets/scripts/core/Constants';
import { FakeClock } from '../../../assets/scripts/core/Clock';
import { HourglassState } from '../../../assets/scripts/core/Items/Hourglass';

describe('HourglassState', () => {
    it('inactive before any activation', () => {
        const clock = new FakeClock();
        const h = new HourglassState(clock);
        expect(h.isActive()).toBe(false);
        expect(h.remainingMs()).toBe(0);
    });

    it('activate() turns it on for HOURGLASS_DURATION_MS', () => {
        const clock = new FakeClock();
        const h = new HourglassState(clock);
        expect(h.activate()).toBe(true);
        expect(h.isActive()).toBe(true);
        expect(h.remainingMs()).toBe(HOURGLASS_DURATION_MS);
    });

    it('expires after the window', () => {
        const clock = new FakeClock();
        const h = new HourglassState(clock);
        h.activate();
        clock.advance(HOURGLASS_DURATION_MS - 1);
        expect(h.isActive()).toBe(true);
        clock.advance(1);
        expect(h.isActive()).toBe(false);
    });

    it('re-activation extends the window', () => {
        const clock = new FakeClock();
        const h = new HourglassState(clock);
        h.activate();
        clock.advance(HOURGLASS_DURATION_MS / 2);
        h.activate();   // resets the timer
        clock.advance(HOURGLASS_DURATION_MS - 1);
        expect(h.isActive()).toBe(true);   // still inside the second window
    });

    it('reset() forces inactive', () => {
        const clock = new FakeClock();
        const h = new HourglassState(clock);
        h.activate();
        h.reset();
        expect(h.isActive()).toBe(false);
    });
});
