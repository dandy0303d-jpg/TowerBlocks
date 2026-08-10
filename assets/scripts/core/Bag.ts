/**
 * The standard 7-bag randomiser plus the meteor-shower override.
 *
 * - In normal play, `pick()` draws from a refilling permutation of the seven
 *   non-DOT tetromino types. This guarantees every 7 picks the player sees one
 *   of each type — the same fairness contract Tetris Guideline games offer.
 * - A single OPTIONAL custom-shape piece can be registered via
 *   `setCustomShape()`. When present, the refill mixes it into the bag as an
 *   8th draw, so it spawns with equal probability (1 in 8) and the per-bag
 *   fairness contract still holds (1 of each piece per refill).
 * - When `meteorRemaining > 0` (the player or a level prop triggered a meteor
 *   shower), every `pick()` returns DOT until the counter drains. The counter
 *   ticks down ON EACH PICK regardless of the bag state.
 *
 * `pick()` returns a `PieceDescriptor` carrying both the colour-bearing
 * `PieceType` and (for custom pieces) the shape matrix the level editor
 * authored. Standard picks leave `shape` null and the spawn helper falls back
 * to `SHAPES[type]`.
 *
 * `rng` is injectable so tests can use a seeded sequence; production defaults
 * to `Math.random`.
 */

import { PieceType, BAG_TYPES } from './Constants';

export type RandomFn = () => number;

/** What `Bag.pick()` returns. `shape === null` means "use SHAPES[type]". */
export interface PieceDescriptor {
    type:  PieceType;
    shape: number[][] | null;
}

export class Bag {
    private contents: PieceDescriptor[] = [];
    /** Remaining DOT pieces to deal during the current meteor shower. */
    meteorRemaining: number = 0;
    /** Optional custom-shape entry. Mixed into every refill. */
    private customShape: { type: PieceType; shape: number[][] } | null = null;

    constructor(private rng: RandomFn = Math.random) {}

    /** Register (or clear) the level's single custom-shape piece. Pass `null`
     *  to remove. Takes effect on the NEXT refill. */
    setCustomShape(def: { type: PieceType; shape: number[][] } | null): void {
        this.customShape = def
            ? { type: def.type, shape: def.shape.map(r => r.slice()) }
            : null;
    }

    /** Re-fill and shuffle the underlying piece permutation. */
    refill(): void {
        this.contents = BAG_TYPES.map<PieceDescriptor>(t => ({ type: t, shape: null }));
        if (this.customShape) {
            this.contents.push({
                type:  this.customShape.type,
                shape: this.customShape.shape.map(r => r.slice()),
            });
        }
        for (let i = this.contents.length - 1; i > 0; i--) {
            const j = Math.floor(this.rng() * (i + 1));
            [this.contents[i], this.contents[j]] = [this.contents[j], this.contents[i]];
        }
    }

    /** Draw one piece descriptor. Refills the bag automatically when empty. */
    pick(): PieceDescriptor {
        if (this.meteorRemaining > 0) {
            this.meteorRemaining--;
            return { type: 'DOT', shape: null };
        }
        if (this.contents.length === 0) this.refill();
        return this.contents.pop()!;
    }

    /** Draw a piece, but if a custom-shape entry exists in the current
     *  bag contents, return that FIRST — bypassing shuffle order.
     *  Used by the tutorial to guarantee the first spawned piece is
     *  the pre-registered "practice" piece (an I). Falls back to a
     *  standard `pick()` if the bag has no custom entry queued. */
    pickCustomFirst(): PieceDescriptor {
        if (this.contents.length === 0) this.refill();
        // Find the (only) entry whose type + shape matches our custom
        // registration. `customShape` is the source of truth on which
        // entry to prefer; the bag can have `customShape.type` also
        // present as a standard entry (with shape=null), so we
        // specifically look for the `shape !== null` copy.
        const custom = this.customShape;
        if (custom) {
            for (let i = 0; i < this.contents.length; i++) {
                const c = this.contents[i];
                if (c.type === custom.type && c.shape !== null) {
                    this.contents.splice(i, 1);
                    return c;
                }
            }
        }
        return this.pick();
    }

    /** Inject `n` more DOTs into the upcoming picks (additive). */
    queueDots(n: number): void {
        this.meteorRemaining += n;
    }

    /** Reset to a clean state (new game / restart). Clears the custom shape
     *  too — callers re-register it after loading a level. */
    reset(): void {
        this.contents = [];
        this.meteorRemaining = 0;
        this.customShape = null;
    }

    /** Discard the current bag-permutation contents, keeping
     *  `customShape` and `meteorRemaining` intact. The next `pick()`
     *  triggers a fresh `refill()` that uses the CURRENT `customShape`.
     *  Used when the player picks a new fate piece mid-run so the
     *  stale OLD-custom descriptor sitting in `contents` doesn't get
     *  drawn before the new shape kicks in. */
    clearContents(): void {
        this.contents = [];
    }

    /** Test inspection: current bag contents (read-only snapshot). */
    inspect(): { contents: ReadonlyArray<PieceDescriptor>; meteorRemaining: number } {
        return {
            contents: this.contents.slice(),
            meteorRemaining: this.meteorRemaining,
        };
    }
}
