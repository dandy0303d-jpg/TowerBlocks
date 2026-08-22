/**
 * Cross-module constants. Mirrors the values used by the original HTML/Canvas
 * prototype so that the migrated game logic produces byte-identical behavior.
 *
 * All visual constants (cube size, gradients, particle counts) belong in the
 * render layer — this file is rendering-agnostic.
 */

// -------- Board ----------
export const COLS = 24;
export const ROWS = 20;

// -------- Piece types ----------
export type PieceType = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L' | 'DOT';
export type CellValue = PieceType | 'X' | 'H';   // X = gray reserved, H = hail

// Runtime const stubs sharing the type names — required so Rollup
// (the build-time bundler, stricter than the editor's preview loader)
// can resolve `import { PieceType }` / `import { CellValue }`.
// Concrete string values rather than `undefined` so the SWC/babel
// TS transform can't dead-strip the declarations during bundling.
// Code never reads these — they're naming-only re-exports.
export const PieceType = '__type_PieceType__' as any;
export const CellValue = '__type_CellValue__' as any;

export const SHAPES: Record<PieceType, number[][]> = {
    I:   [[0,0,0,0],[1,1,1,1],[0,0,0,0],[0,0,0,0]],
    O:   [[1,1],[1,1]],
    T:   [[0,1,0],[1,1,1],[0,0,0]],
    S:   [[0,1,1],[1,1,0],[0,0,0]],
    Z:   [[1,1,0],[0,1,1],[0,0,0]],
    J:   [[1,0,0],[1,1,1],[0,0,0]],
    L:   [[0,0,1],[1,1,1],[0,0,0]],
    DOT: [[1]],
};

/** Random-bag pickable types. DOT is meteor-shower only, never randomly picked. */
export const BAG_TYPES: PieceType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

// Balanced palette — sits between the pastel-bright and muted-grey
// extremes we tried before. Each colour has ~55% saturation: still
// clearly identifiable at a glance, but not shouting under the crystal
// PBR + neon UI.
export const COLORS: Record<CellValue, string> = {
    I:   '#489abd',   // balanced cyan
    O:   '#c4a04d',   // balanced gold
    T:   '#8253bd',   // balanced purple
    S:   '#5cb266',   // balanced green
    Z:   '#c35555',   // balanced red
    J:   '#587fbd',   // balanced blue
    L:   '#c47f42',   // balanced orange
    X:   '#7a7e88',   // stone gray (unchanged)
    DOT: '#c4aa4d',   // balanced amber
    H:   '#f5f7ff',   // hail stays icy-white
};

// -------- Drop speed / timing ----------
export const BASE_DROP_INTERVAL_MS = 800;
export const LOCK_DELAY_MS         = 500;
export const LOCK_RESET_LIMIT      = 3;

// -------- Meteor shower (DOT mode) ----------
// Default piece count — used by LEVEL-PROP triggers (chest / cleared
// cell) and as a fallback when a magic item doesn't specify a tier.
// Magic-item tiers 1/2/3 use METEOR_TIER_COUNT (5 / 10 / 15) instead.
export const METEOR_PIECES         = 10;
export const METEOR_DROP_INTERVAL  = 67;                                        // ms per row — matches Gatling bullet speed
export const METEOR_SPEED_MULT     = BASE_DROP_INTERVAL_MS / METEOR_DROP_INTERVAL; // ~11.94×

// -------- Magic items ----------
// Wrecker (拆迁队) used to be on this list; it was moved to the
// piece-embed prop pool (see `injectRandomMagicProp`) where it rolls
// as the rarest drop, alongside row/col bombs and range-blast booms.
export type MagicItemKey =
    | 'hourglass1'    // 1 min slow-fall
    | 'hourglass2'    // 2 min slow-fall
    | 'hourglass3'    // 3 min slow-fall
    | 'rewind'
    | 'shapeshifter'
    | 'rocket1'       // 8 rockets
    | 'rocket2'       // 16 rockets
    | 'rocket3'       // 24 rockets
    | 'meteor1'       // 5 dots
    | 'meteor2'       // 10 dots
    | 'meteor3'       // 15 dots
    | 'gatling1'      // 4 bullets
    | 'gatling2'      // 8 bullets
    | 'gatling3'      // 12 bullets
    | 'excavator1'    // bottom 1 row
    | 'excavator2'    // bottom 2 rows
    | 'excavator3'    // bottom 3 rows (was `excavator`)
    | 'excavatorTop1' // top 1 row
    | 'excavatorTop2' // top 2 rows
    | 'excavatorTop3' // top 3 rows (was `excavatorTop`)
    | 'mortar5'
    | 'mortar10'
    | 'mortar15';

// Runtime const stub — see the PieceType / CellValue notes above for why.
export const MagicItemKey = '__type_MagicItemKey__' as any;

/** Listed in drop-probability order, HIGH → LOW. */
export const ITEM_KEYS: MagicItemKey[] = [
    'rewind', 'shapeshifter', 'hourglass1',
    'hourglass2', 'mortar5',
    'excavator1', 'excavatorTop1',
    'hourglass3',
    'gatling1',
    'rocket1',
    'meteor1', 'mortar10', 'excavator2', 'excavatorTop2',
    'gatling2',
    'meteor2',
    'rocket2',
    'excavator3', 'excavatorTop3',
    'mortar15', 'meteor3',
    'gatling3', 'rocket3',
];

/** Drop weights — sum to 1.0. Hand-tuned per user spec.
 *  Storm items (加特林 / 火箭 / 流星雨) get significantly more weight in
 *  this pass; hourglass / excavator / mortar tier-1s got quieter to
 *  make room, while rewind / shapeshifter stay at the "always in the
 *  running" tier.
 *
 *  Family totals at this balance:
 *    • Rewind                → 0.120
 *    • Shapeshifter          → 0.120
 *    • Hourglass  1/2/3      → 0.120 + 0.050 + 0.025  = 0.195
 *    • Meteor     1/2/3      → 0.120 + 0.050 + 0.0125 = 0.1825
 *    • Gatling    1/2/3      → 0.100 + 0.050 + 0.0125 = 0.1625
 *    • Rocket     1/2/3      → 0.050 + 0.050 + 0.0125 = 0.1125
 *    • Mortar     5/10/15    → 0.025 + 0.0125 + 0.003 = 0.0405
 *    • Excavator  bottom     → 0.025 + 0.006 + 0.0025 = 0.0335
 *    • Excavator  top        → 0.025 + 0.006 + 0.0025 = 0.0335
 *  Grand total = 1.000. */
export const ITEM_BASE_PROBS: Record<MagicItemKey, number> = {
    rewind:        0.120,
    shapeshifter:  0.120,
    hourglass1:    0.120,
    hourglass2:    0.050,
    hourglass3:    0.025,
    mortar5:       0.025,
    mortar10:      0.0125,
    mortar15:      0.003,
    excavator1:    0.025,
    excavator2:    0.006,
    excavator3:    0.0025,
    excavatorTop1: 0.025,
    excavatorTop2: 0.006,
    excavatorTop3: 0.0025,
    gatling1:      0.100,
    gatling2:      0.050,
    gatling3:      0.0125,
    rocket1:       0.050,
    rocket2:       0.050,
    rocket3:       0.0125,
    meteor1:       0.120,
    meteor2:       0.050,
    meteor3:       0.0125,
};

/** Mortar tier → number of drops the storm rains. Indexed by the magic-
 *  item key suffix (5/10/15). The fill plan is sliced down to this count
 *  before the storm starts, so each tier delivers a controlled amount of
 *  mortar instead of "fill everything below colored cells". */
export const MORTAR_TIER_COUNT: Record<'mortar5' | 'mortar10' | 'mortar15', number> = {
    mortar5:  5,
    mortar10: 10,
    mortar15: 15,
};

/** Meteor tier → number of DOTs the shower rains. Indexed by the magic-
 *  item key suffix (1/2/3). Level-prop-triggered meteors (from cleared
 *  host cells) still use the default METEOR_PIECES constant above. */
export const METEOR_TIER_COUNT: Record<'meteor1' | 'meteor2' | 'meteor3', number> = {
    meteor1:  5,
    meteor2: 10,
    meteor3: 15,
};

/** Gatling tier → number of bullets the storm fires. Level-prop / board-
 *  triggered gatling storms use the default GATLING_TOTAL below. */
export const GATLING_TIER_COUNT: Record<'gatling1' | 'gatling2' | 'gatling3', number> = {
    gatling1:  4,
    gatling2:  8,
    gatling3: 12,
};

/** Rocket tier → number of rockets the storm launches. Level-prop /
 *  board-triggered rocket storms use the default ROCKET_TOTAL below. */
export const ROCKET_TIER_COUNT: Record<'rocket1' | 'rocket2' | 'rocket3', number> = {
    rocket1:  8,
    rocket2: 16,
    rocket3: 24,
};

/** Hourglass tier → slow-fall window duration. Multiples of 60s. */
export const HOURGLASS_DURATIONS_MS: Record<'hourglass1' | 'hourglass2' | 'hourglass3', number> = {
    hourglass1:  60_000,
    hourglass2: 120_000,
    hourglass3: 180_000,
};

export const ITEM_MAX = 2;
export const HISTORY_MAX = 16;   // rewind history depth

// -------- Level-prop runtime constants ----------
/** Blizzard releases its drag-debuff after this many piece-locks. */
export const BLIZZARD_PIECE_LOCKS  = 5;
export const WRECKER_TARGETS       = 10;
export const HAIL_TOTAL            = 72;
export const HAIL_DROP_INTERVAL_PER_ROW_MS = 80;   // 10× base level-1 drop
export const HAIL_LIFE_PIECES      = 3;
export const HAIL_SPAWN_STAGGER_MS = 25;
export const ROCKET_TOTAL          = 24;
export const ROCKET_DROP_INTERVAL_PER_ROW_MS = 80;
export const ROCKET_SPAWN_STAGGER_MS = 35;

// -------- Mortar (灰泥) magic item — hail-style falling drops --------
//   Mortar fills every empty cell adjacent to a colored cell. Each
//   target gets a colored drop that falls from above and lands in
//   place. Timing borrowed from hail so the visual reads as the
//   same family of animation.
export const MORTAR_DROP_INTERVAL_PER_ROW_MS = 80;
export const MORTAR_SPAWN_STAGGER_MS         = 25;

// -------- Gatling (rapid-fire rocket-style 1:1 cancellation) ----------
export const GATLING_TOTAL                   = 12;   // 12 rounds from the
                                                     // activation column.
export const GATLING_DROP_INTERVAL_PER_ROW_MS = 67;  // 3× faster than before
                                                     // (200 → 67). Each bullet
                                                     // crosses the board in
                                                     // ~1.5 s.
export const GATLING_SPAWN_STAGGER_MS         = 1072;// 2× the previous gap —
                                                     // 16 rows between bullets
                                                     // at 67 ms/row.

// -------- Endless-mode constants ----------
export const ENDLESS_HEIGHT_LIMIT     = 10;
/** Extra rows of buffer between the visible warning ring and the
 *  actual game-over line. 0 = fail one row above the ring — the
 *  check is `totalFilled - bottomGray > ENDLESS_HEIGHT_LIMIT`,
 *  which triggers exactly when the stack goes 1 row past the ring.
 *  (Off-by-one nuance: the check is strict `>`, so margin 0 already
 *  gives the player the row AT the ring as the last safe row.) */
export const ENDLESS_FAIL_MARGIN      = 0;
// Max gray-foundation rows kept in the board. Beyond this cap,
// `manageEndlessBoard` peels the bottom-most gray row on each new
// lock. The camera anchors the TOP of a full 20-row gray stack at
// screen centre (see `targetBoardYOffset`), so ~6 rows of gray sit
// below the screen edge; on screen the player sees ~14 rows of gray
// as a solid base with the play area occupying the upper half.
export const ENDLESS_GRAY_CAP         = 20;
export const ENDLESS_SCROLL_THRESHOLD = 6;   // grow the board upward when the stack tops out within this many rows of the ceiling
export const ENDLESS_DECILE_INTERVAL  = 10;  // every cumulative 10 filled rows → chest
export const ENDLESS_STREAK_THRESHOLD = 4;   // 4 layers in a row → chest
/** Every cumulative N filled rows in endless mode, pop the 本命方块 modal
 *  so the player can re-pick the fate shape mid-run. The pick replaces
 *  the bag's custom-shape entry on the next refill (current piece and
 *  the queued next piece keep playing). */
export const ENDLESS_FATE_MILESTONE   = 12;

// -------- Level-mode chest progress ----------
export const LEVEL_CUMULATIVE_INTERVAL = 5;  // every 5 fully-cleared rows → chest
export const LEVEL_MULTI_CLEAR_THRESHOLD = 2; // clearing ≥2 rows at once → chest

// -------- Energy bar (picker reward system) ----------
// Each naturally-cleared row charges the bar by 1; at full charge the player
// gets a 2-of-N magic item picker. The "1 free refresh" / "watch ad for
// another refresh" gating lives in the UI layer; the game state just
// exposes `pickEnergyReward(key)` and `refreshEnergyPicker()`.
export const ENERGY_FULL_THRESHOLD = 5;
export const ENERGY_PICKER_CHOICE_COUNT = 2;
/** Pool the picker draws from. Same 5 magic items as the chest reward pool. */
export const ENERGY_PICKER_POOL: MagicItemKey[] = ITEM_KEYS;
