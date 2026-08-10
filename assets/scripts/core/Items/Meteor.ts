/**
 * Meteor shower — dual-purpose:
 *   - As a MAGIC ITEM (player triggers from sidebar): swap the live piece into
 *     a DOT immediately and queue the next N-1 spawns as DOTs (N total).
 *     N depends on the tier — meteor1 = 5, meteor2 = 10, meteor3 = 15.
 *   - As a LEVEL PROP (host cell cleared): don't touch the live piece (which
 *     might be the one that just locked + triggered the clear). Queue the
 *     default METEOR_PIECES (10) DOTs for upcoming spawns.
 *
 * The Bag's `meteorRemaining` counter is the source of truth; this module
 * just nudges it. Activation arithmetic:
 *
 *   total wanted   = opts.pieces ?? METEOR_PIECES
 *   already-in-play = swapCurrent ? 1 : 0
 *   queued nextType = 1   (caller overrides nextType to DOT explicitly)
 *   → Bag picks    = total − swap − 1
 *
 * The "swap live piece" and "override nextType" steps are the caller's
 * responsibility — this module is engine-agnostic and shouldn't know about
 * the Piece object or rendering. The caller supplies an optional swap callback.
 */

import { METEOR_PIECES } from '../Constants';
import { Bag } from '../Bag';

export interface MeteorActivateOpts {
    /** Whether to swap the in-flight piece (true for magic item, false for level prop). */
    swapCurrent: boolean;
    /**
     * Caller-provided hook: if `swapCurrent === true` and there's a live piece,
     * this is invoked so the caller can replace `current` with a DOT in place.
     * If the caller returns false (e.g. no live piece), the swap is counted as skipped.
     */
    onSwapLivePiece?: () => boolean;
    /** Caller-provided hook to override the queued next-piece type to DOT. */
    onOverrideNextType?: () => void;
    /** Total DOT pieces to rain, including the swapped live piece + queued
     *  next. Defaults to METEOR_PIECES (10). Magic-item tiers pass 5 / 10 / 15. */
    pieces?: number;
}

export function activateMeteor(bag: Bag, opts: MeteorActivateOpts): boolean {
    const didSwap = opts.swapCurrent && (opts.onSwapLivePiece?.() ?? false);
    // Caller always overrides nextType (counts as one of the N).
    opts.onOverrideNextType?.();

    const total = opts.pieces ?? METEOR_PIECES;
    const fromBag = total - (didSwap ? 1 : 0) - 1;
    // Stacking: a re-trigger never SHRINKS the remaining count. We top the
    // bag up to at least `fromBag` without ever decrementing it.
    const topUp = fromBag - bag.meteorRemaining;
    if (topUp > 0) bag.queueDots(topUp);
    return true;
}
