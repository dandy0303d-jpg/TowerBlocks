/**
 * TutorialSteps — data-driven configuration for the 4-gesture intro.
 *
 * Each step has:
 *   - gestureType — what the player must perform to advance
 *   - hintKey     — i18n key for the bottom hint label
 *   - hand{Start,End,Hold} — where the animated hand draws / travels;
 *                             values are FRACTIONS of the design canvas
 *                             (750×1334), so the animation scales across
 *                             aspect ratios.
 *   - autoAdvance — a step never "fails". If the player idles for
 *                    `RETRY_IDLE_MS`, TutorialController replays the demo.
 */

/** The 4 gesture kinds TutorialController listens for. */
export type TutorialGesture =
    | 'tap'             // quick tap-release, short travel, short duration
    | 'swipe-release'   // horizontal swipe of some distance, then release
    | 'swipe-hold'      // horizontal swipe + still holding after ≥ HOLD_MS
    | 'swipe-down';     // vertical swipe (down direction)

/** Position + travel description for the hand demo. All coords are
 *  fractions of the design canvas (750 × 1334) — TutorialHandFX
 *  multiplies by the actual canvas size at draw time. */
export interface HandTravel {
    /** Starting position (fractional). */
    start: { x: number; y: number };
    /** Ending position — omit for a stationary tap. */
    end?: { x: number; y: number };
    /** For swipe-hold: how long to visually "sit" at end (ms). */
    holdMs?: number;
}

export interface TutorialStep {
    id:          string;
    gestureType: TutorialGesture;
    hintKey:     string;
    hand:        HandTravel;
    /** How many times to play the demo animation before waiting for
     *  the player. Defaults to 2 — most gestures benefit from a
     *  repeat. Set to 1 for the final hard-drop step because it
     *  ends the tutorial and a second demo just delays the payoff. */
    demoRepeats?: number;
}

/** If the player is idle for this long after a demo, replay the demo. */
export const RETRY_IDLE_MS = 5000;

/** Full 4-step operations tutorial. Order matters — steps run sequentially. */
export const TUTORIAL_STEPS: TutorialStep[] = [
    {
        id:          'tap-morph',
        gestureType: 'tap',
        hintKey:     'tutorial.hint.tap',
        hand: {
            // Center of the screen — the piece is somewhere in the
            // middle, tapping anywhere works.
            start: { x: 0.5, y: 0.5 },
        },
    },
    {
        id:          'swipe-release',
        gestureType: 'swipe-release',
        hintKey:     'tutorial.hint.swipeRelease',
        hand: {
            // Right-middle → left-middle, quick horizontal swipe.
            start: { x: 0.75, y: 0.55 },
            end:   { x: 0.35, y: 0.55 },
        },
    },
    {
        id:          'swipe-hold',
        gestureType: 'swipe-hold',
        hintKey:     'tutorial.hint.swipeHold',
        hand: {
            // Fast horizontal FLING — hand slides quickly across the
            // screen and releases (no hold). Matches the new control
            // scheme where a fast swipe + release makes the tower
            // spin with inertia. Longer travel emphasises the flick.
            start:  { x: 0.80, y: 0.55 },
            end:    { x: 0.30, y: 0.55 },
        },
    },
    {
        id:          'swipe-down',
        gestureType: 'swipe-down',
        hintKey:     'tutorial.hint.swipeDown',
        hand: {
            // Top-of-play-area → bottom-of-play-area vertical swipe.
            start: { x: 0.5, y: 0.65 },
            end:   { x: 0.5, y: 0.35 },
        },
        // Only one demo — this is the last step. A second demo
        // just delays scattering the tower + entering level 1.
        demoRepeats: 1,
    },
];
