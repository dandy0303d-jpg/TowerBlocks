/**
 * Blizzard level prop — after activation, drag-rotation on the cylinder
 * degrades to "one column per swipe" instead of continuous rotation. The
 * effect is metered in piece-locks (not wall-clock time) so the player
 * can take their time without the debuff expiring on a long pause.
 *
 * Each new activation refreshes the counter to `BLIZZARD_PIECE_LOCKS`
 * via `Math.max`, so a re-trigger near the end of the window never
 * shortens an already-active blizzard.
 *
 * Lifecycle expected from the host (GameState):
 *   - call `activate()` when a blizzard prop fires
 *   - call `onPieceLock()` once per piece that lands while active
 *     (the host already runs a centralised post-lock callback)
 */

import { BLIZZARD_PIECE_LOCKS } from '../Constants';
import { Clock, realClock } from '../Clock';

export class BlizzardState {
    private piecesLeft = 0;

    // Constructor takes a Clock for API compatibility with the previous
    // time-based BlizzardState — the new piece-lock counter doesn't read
    // it, but callers (GameState) still construct with one.
    constructor(_clock: Clock = realClock) {
        void _clock;
    }

    isActive(): boolean {
        return this.piecesLeft > 0;
    }

    /** Returns true if this call started a fresh window (caller may
     *  want to play a toast / sound only on the leading edge). */
    activate(): boolean {
        const wasActive = this.isActive();
        this.piecesLeft = Math.max(this.piecesLeft, BLIZZARD_PIECE_LOCKS);
        return !wasActive;
    }

    /** Host calls this exactly once per regular piece lock. */
    onPieceLock(): void {
        if (this.piecesLeft > 0) this.piecesLeft -= 1;
    }

    reset(): void {
        this.piecesLeft = 0;
    }

    /** Locks remaining before the blizzard releases its grip. 0 when
     *  inactive. UI uses this for the "N locks left" badge. */
    remainingLocks(): number {
        return this.piecesLeft;
    }
}
