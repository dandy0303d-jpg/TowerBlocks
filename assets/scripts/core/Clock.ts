/**
 * Injectable monotonic clock for time-based effects (Hourglass, Blizzard).
 * Production uses `performance.now()` when available, falling back to
 * `Date.now()`. Tests inject their own ticking clock.
 */

export interface Clock {
    now(): number;
}

export const realClock: Clock = {
    now(): number {
        return (typeof performance !== 'undefined' && performance.now)
            ? performance.now()
            : Date.now();
    },
};

/** Test helper — a clock you can step manually. */
export class FakeClock implements Clock {
    private t: number;
    constructor(start: number = 0) { this.t = start; }
    now(): number { return this.t; }
    advance(ms: number): void { this.t += ms; }
    set(ms: number): void { this.t = ms; }
}
