/**
 * Hourglass magic item — for `durationMs` after activation the falling
 * piece moves at half speed (drop interval ×2). Tiered into 1-/2-/3-minute
 * variants via `HOURGLASS_DURATIONS_MS` in Constants. Stacking re-applies
 * the full window from the moment of the second activation — the
 * original prototype used `Math.max`, but with tiered durations we'd
 * have to track which tier we're stacking against. We extend with the
 * NEW duration so a fresh activation always feels responsive.
 */

import { HOURGLASS_DURATIONS_MS } from '../Constants';
import { Clock, realClock } from '../Clock';

export class HourglassState {
    private until: number = 0;

    constructor(private clock: Clock = realClock) {}

    /** Returns true while the slow-fall window is still open. */
    isActive(): boolean {
        return this.clock.now() < this.until;
    }

    /** Trigger the slow-fall window for the given duration (defaults to
     *  the 1-minute tier). Returns true to mark the item consumed. */
    activate(durationMs: number = HOURGLASS_DURATIONS_MS.hourglass1): boolean {
        // Stack by extending: new window starts now, regardless of any
        // leftover from a prior activation.
        this.until = this.clock.now() + durationMs;
        return true;
    }

    /** Cancel any active effect (used by `reset` / `newGame`). */
    reset(): void {
        this.until = 0;
    }

    /** Test helper: remaining ms before expiry (0 when inactive). */
    remainingMs(): number {
        const left = this.until - this.clock.now();
        return left > 0 ? left : 0;
    }
}
