/**
 * Top-level game state and main loop. Owns every subsystem — board, bag,
 * inventory, history, hourglass/blizzard timers, hail/rocket animation
 * machines — and wires their hooks together so a single `tick(dt)` call
 * drives the whole game.
 *
 * The render and input layers talk to a `GameState` instance via two
 * interfaces:
 *   - Inputs:  `hardDrop()`, `softDrop()`, `tryRotate(dir)`, `moveCylinder(dir)`,
 *              `hold()`, `useItem(key)`, `applyShapeshifterPick(type)`.
 *   - Outputs: optional `GameRenderHooks` passed to the constructor — every
 *              relevant event (lock, score, win, particle, …) fires as a hook
 *              call so the renderer can react without polling.
 */

import {
    COLS,
    ROWS,
    SHAPES,
    BASE_DROP_INTERVAL_MS,
    LOCK_DELAY_MS,
    LOCK_RESET_LIMIT,
    METEOR_DROP_INTERVAL,
    PieceType,
    CellValue,
    MagicItemKey,
    ENERGY_FULL_THRESHOLD,
    ENERGY_PICKER_CHOICE_COUNT,
    ENERGY_PICKER_POOL,
    MORTAR_TIER_COUNT,
    METEOR_TIER_COUNT,
    METEOR_PIECES,
    GATLING_TIER_COUNT,
    ROCKET_TIER_COUNT,
    HOURGLASS_DURATIONS_MS,
    ENDLESS_FATE_MILESTONE,
    WRECKER_TARGETS,
    ITEM_BASE_PROBS,
    PITY_BOOST_PER_DRAW,
    rarityForKey,
} from './Constants';
import {
    BoardState,
    Piece,
    BombKind,
    BoomLevel,
    EmbedProp,
    HistorySnapshot,
    Inventory,
    LevelData,
} from './Types';
import {
    emptyEndlessBoardState,
    emptyLevelBoardState,
    isColoredCell,
    wrap,
} from './Board';
import { makeEmptyBombs, makeEmptyBooms, makeEmptyWreckers, injectRandomMagicProp } from './Bombs';
import { collides, rotateBombs, rotateBooms, rotateWreckers } from './Pieces';
import { Bag } from './Bag';
import { applyColumnGravity, applyDiagonalGravity } from './ColumnGravity';
import { clearLines, ClearLinesHooks } from './ClearLines';
import { detonateBombs, DetonateHooks } from './Detonate';
import { spawn, lock, gatherLevelBombs, gatherAdjacentBombs, gatherAdjacentBooms, gatherAdjacentWreckers } from './PieceOps';
import { activateBoom, processClearedBooms } from './Items/Boom';
import { Clock, realClock } from './Clock';
import { makeEmptyInventory, grantRandomItem, consumeItem } from './Inventory';
import { HourglassState } from './Items/Hourglass';
import { BlizzardState } from './Items/Blizzard';
import { activateChest } from './Items/Chest';
import { activateExcavator } from './Items/Excavator';
import { MortarState, computeMortarPlan, computeMortarFallbackPlan } from './Items/Mortar';
import { activateWrecker, pickWreckerPlan, applyWreckerPlan, WreckerPlan } from './Items/Wrecker';
import { activateMeteor } from './Items/Meteor';
import { HailState } from './Items/Hail';
import { RocketState } from './Items/Rocket';
import { GatlingState } from './Items/Gatling';
import { RewindHistory } from './Items/Rewind';
import { applyShapeshifterPick } from './Items/Shapeshifter';
import {
    convertReservedZoneToGray,
    checkLevelWin,
    checkLevelTooTall,
    LevelChestProgress,
} from './Modes/LevelMode';
import {
    convertCompleteRowsToGray,
    checkTrappedHole,
    manageEndlessBoard,
    peelGrayAboveFoundation,
    EndlessChestProgress,
} from './Modes/EndlessMode';
import { loadLevel } from './LevelData';

export type GameMode = 'level' | 'endless' | 'collect' | 'blind';

/** Endless-like modes share stacking mechanics: no level task, no
 *  collect goals, grays cap via `manageEndlessBoard`, fail on
 *  trapped-hole / stack-too-tall. `blind` is a variant of endless
 *  (tower hidden, no fate modal, no embed props). */
export function isEndlessLike(m: GameMode): boolean {
    return m === 'endless' || m === 'blind';
}

/** Per-color collection target for `collect` mode levels. */
export interface CollectGoal {
    color: import('./Constants').PieceType;
    count: number;
}
export type FailureReason = 1 | 2;   // 1 = sealed hole; 2 = stack too tall

export interface GameRenderHooks {
    onPieceLand?(piece: Piece): void;
    onPieceLock?(piece: Piece): void;
    onPartialShatter?(r: number, content: ReadonlyArray<CellValue | null>): void;
    /** Fires after any clearing operation with the list of cells that
     *  diagonal-gravity moved. Each entry has {fromR, toR, c}; the
     *  renderer plays an animated fall between fromR and toR instead
     *  of teleporting the cube to its new row. */
    onCellsFell?(moves: ReadonlyArray<import('./ColumnGravity').CellFallMove>): void;
    /** Wrecker fired from a board-embedded prop at (srcR, srcC). The
     *  renderer:
     *    1. Spawns projectiles from the source cell out to each pick.
     *    2. On projectile arrival, stamps a temp prop on the target
     *       matching the combo kind so the player reads the impending
     *       effect at a glance (wrecker cube for a plain sweep, row/col
     *       blast cube for a directional-bomb combo, boom cube for a
     *       range-blast combo).
     *    3. Once every marker's pulse finishes, calls
     *       `commitPendingWreckerPlans` on the GameState to apply the
     *       clear.
     *  `srcR/srcC = -1` means "no known source" (magic-item activation,
     *  or a legacy call site) — renderer should fall back to firing the
     *  pulse immediately with no projectile stage.
     *  `comboBoomLevel` (0-3) is the boom tier a neighbour boom
     *  contributes; `comboBombAxis` is 'row'/'col' for directional-bomb
     *  neighbours. Both are always level-1 blasts per pick regardless
     *  of the neighbour's authored tier (see Wrecker.ts docstring). */
    onWreckerPrePulse?(
        srcR: number,
        srcC: number,
        picks: ReadonlyArray<{ r: number; c: number; color: CellValue }>,
        comboBoomLevel?: 0 | 1 | 2 | 3,
        comboBombAxis?: 'row' | 'col' | null,
    ): void;
    /** Wrecker plain sweep — fired in place of `onPartialShatter` so the
     *  renderer plays a PER-CELL shatter at each pick instead of a
     *  row-wide flash. */
    onWreckerPicksShatter?(picks: ReadonlyArray<{ r: number; c: number; color: CellValue }>): void;
    /** Rocket bullet 1:1-cancelled a cell — renderer plays a single-cell
     *  shatter FX at (r,c). Same payload shape as the wrecker hook so
     *  the renderer can route both through the same code path. */
    onRocketHit?(picks: ReadonlyArray<{ r: number; c: number; color: CellValue }>): void;
    /** Gatling bullet 1:1-cancelled a cell — see `onRocketHit`. */
    onGatlingHit?(picks: ReadonlyArray<{ r: number; c: number; color: CellValue }>): void;
    /** Fired the moment a rocket / gatling projectile is spawned.
     *  Renderer uses these to play the launch SFX. */
    onRocketFire?(col: number): void;
    onGatlingFire?(col: number): void;
    /** Fired every time a DOT (meteor rain) piece spawns as the
     *  active piece. Renderer plays the launch SFX per DOT so each
     *  falling meteor gets its own sound (matches rocket / gatling). */
    onMeteorFire?(): void;
    /** Fired every time a mortar (灰泥) drop lands + stamps its
     *  colour onto the board. Renderer plays a per-drop lock SFX. */
    onMortarLanded?(r: number, c: number, color: CellValue): void;
    /** Endless / blind — one or more 24-col rows just got fully
     *  filled + converted to gray. Fired ONCE per lock, with the
     *  count of newly-gray rows. Renderer plays the same line-clear
     *  audio cue as level mode gets for its shatter clears. */
    onEndlessRowsFilled?(count: number): void;
    /** Fires once per ROW cleared by a row bomb (`row1`..`row4`).
     *  `tier` is the max tier that touched this row — GameController
     *  uses it to gate the screen-shake on ≥ level 3 blasts. */
    onRowBombDetonate?(r: number, tier: 1 | 2 | 3 | 4): void;
    /** Fires once per COLUMN cleared by a column bomb (`col1`..`col4`).
     *  `r` is the anchor row of the bomb that triggered the column,
     *  `tier` is the max tier touching this column. */
    onColBombDetonate?(r: number, c: number, tier: 1 | 2 | 3 | 4): void;
    /** Fires once per lock when the player naturally clears `count`
     *  rows (before detonate-triggered splices). GameController uses
     *  this to gate the screen-shake on ≥ 3-row clears (Tetris /
     *  Tetris-4). Only fires when `count >= 1`. */
    onNaturalRowClears?(count: number): void;
    /** Fires once per CELL cleared by a `box3` area bomb (backpack
     *  `bomb_block` card) — up to 9 calls per bomb. `isAnchor` marks
     *  the bomb's origin cell so the renderer can play a slightly
     *  bigger burst there. */
    onBoxBombDetonate?(r: number, c: number, isAnchor: boolean): void;
    /** Fires when a BOOM (diamond range-blast) item activates. `r`/`c`
     *  is the centre of the blast, `level` is the radius (1/2/3), and
     *  `cleared` is the list of cells the engine just wiped — handy for
     *  the renderer to layer a per-cell flash on top. */
    onBoomTriggered?(r: number, c: number, level: 1 | 2 | 3,
        cleared: ReadonlyArray<{ r: number; c: number }>): void;
    onClearSound?(intensity: number): void;
    onItemGranted?(key: MagicItemKey): void;
    onScoreChanged?(score: number): void;
    onLinesChanged?(lines: number): void;
    onLevelChanged?(level: number): void;
    onInventoryChanged?(inventory: Readonly<Inventory>): void;
    onNextChanged?(type: PieceType): void;
    onHoldChanged?(type: PieceType | null): void;
    onGameOver?(reason: FailureReason | null): void;
    onLevelWin?(): void;
    onMeteorActivated?(): void;
    onBlizzardActivated?(): void;
    onHailActivated?(): void;
    onRocketActivated?(): void;
    onGatlingActivated?(): void;
    onMortarActivated?(): void;
    onWreckerActivated?(): void;
    onShapeshifterRequest?(apply: (type: PieceType) => void): void;
    /** Collect-mode progress update — fires whenever a cleared cell of a
     *  goal colour increments the running total. `progress` is the live
     *  per-colour collected count, `goals` is the per-colour target. */
    onCollectProgress?(
        progress: Readonly<Partial<Record<PieceType, number>>>,
        goals: ReadonlyArray<{ color: PieceType; count: number }>,
    ): void;
    onRotate?(): void;

    // ---------- Energy bar / picker reward ----------
    /** Fires whenever the energy charge changes (after a natural clear).
     *  `max = ENERGY_FULL_THRESHOLD`. UI uses this to animate the bar. */
    onEnergyChanged?(charge: number, max: number): void;
    /** Fires when the bar fills up and the 2-choice picker should appear.
     *  `choices` contains exactly `ENERGY_PICKER_CHOICE_COUNT` magic-item
     *  keys. UI shows the picker overlay. Game state is "frozen" until the
     *  player calls `pickEnergyReward` or `refreshEnergyPicker`. */
    onEnergyPickerOpen?(choices: MagicItemKey[]): void;
    /** Fires when the picker overlay should close (after pick OR cancel). */
    onEnergyPickerClose?(): void;
    /** Fires when the player picked an option and it activated. */
    onEnergyPickerPicked?(key: MagicItemKey): void;
    /** Fires when the endless-mode cumulative-rows counter crosses a
     *  new ENDLESS_FATE_MILESTONE multiple. `milestone` = 1, 2, 3, ...
     *  Renderer plays a celebration FX; independent of the fate modal
     *  (which is level/endless only). Blind mode ALSO fires this so the
     *  player gets audible/textual milestone feedback even though the
     *  tower is hidden. */
    onEndlessMilestone?(milestone: number, cumulative: number): void;
}

export interface GameStateOpts {
    hooks?:  GameRenderHooks;
    clock?:  Clock;
    rng?:    () => number;
}

/** How long a `box3` bomb "arms" before detonating after lock. During
 *  this window the locked cube plays a danger ramp-up animation
 *  (shake, expand, red → dark red) via CubeManager.placeBox3LockedCube.
 *  Kept short (~0.5 s) so the player doesn't lose game-flow tempo. */
export const BOX3_ARM_DURATION_MS = 500;

export class GameState {
    // ---------- Subsystems ----------
    state:              BoardState;
    inventory:          Inventory;
    readonly bag:       Bag;
    readonly hourglass: HourglassState;
    readonly blizzard:  BlizzardState;
    readonly hail:      HailState;
    readonly rocket:    RocketState;
    readonly gatling:   GatlingState;
    readonly mortar:    MortarState;
    readonly history:   RewindHistory;
    readonly levelProgress:   LevelChestProgress;
    readonly endlessProgress: EndlessChestProgress;

    // ---------- Mode / lifecycle ----------
    mode:        GameMode = 'endless';
    running:     boolean  = false;
    paused:      boolean  = false;
    gameOver:    boolean  = false;
    failureReason: FailureReason | null = null;
    /** Set to true after the one-shot "watch ad to revive" is spent in
     *  endless / blind mode. Reset to false at every startEndless /
     *  startBlind so each fresh run gets its own single revive. Result
     *  panel checks this to decide whether to show the revive button. */
    endlessReviveUsed: boolean = false;

    currentLevel:        LevelData | null = null;
    levelReservedHeight: number = 0;
    levelTaskHeight:     number = 0;

    // ---------- Collect mode ----------
    /** Per-colour collection goals copied from the level data. Empty
     *  when not running a collect-mode level. */
    collectGoals:    Array<{ color: PieceType; count: number }> = [];
    /** Live per-colour tally of how many of each goal colour the player
     *  has cleared so far. Compared against `collectGoals[*].count` to
     *  decide the win condition. */
    collectProgress: Partial<Record<PieceType, number>> = {};

    // ---------- Energy bar (picker reward) ----------
    /** Cumulative naturally-cleared rows since the last picker activation.
     *  Caps at `ENERGY_FULL_THRESHOLD`. Driven by `naturalClearsThisLock`. */
    energyCharge: number = 0;
    /** Picker state. While `active`, the game tick freezes — the player must
     *  call `pickEnergyReward(key)` or `refreshEnergyPicker()` to resume. */
    energyPicker: { active: boolean; choices: MagicItemKey[] } = { active: false, choices: [] };
    /** Cumulative WHOLE SECONDS elapsed in the CURRENT level-mode /
     *  collect-mode run. Ticks only when the game is actively running
     *  (not paused, not in a modal / picker) so watch-and-plan opens
     *  don't burn the clock. Reset to 0 in reset() so each fresh level
     *  starts at 00:00. Endless / blind modes leave this at 0 (there's
     *  no "clear time" concept for endless — the HUD reads this field
     *  only when mode is 'level' | 'collect').
     *
     *  Second granularity throughout (display, server payload) — the
     *  fractional accumulator lives in _elapsedSubSec below so a 60fps
     *  tick doesn't lose sub-second time to Math.floor rounding. */
    public levelElapsedSec: number = 0;
    /** Sub-second accumulator (0..1). Prevents a naive `+= dt` from
     *  losing precision to Math.floor when advancing levelElapsedSec.
     *  Reset to 0 in reset(). */
    private _elapsedSubSec: number = 0;

    /** Pity counter — number of picker draws (opens + refreshes) the
     *  player has done WITHOUT committing to a pick. Each roll passes
     *  the current value into rollEnergyChoices() to scale rare/epic
     *  weights (see PITY_BOOST_PER_DRAW in Constants). Reset to 0 on
     *  a successful pickEnergyReward, so the moment the player takes
     *  an item the odds fall back to base ITEM_BASE_PROBS.
     *  Not persisted across matches — a new GameState starts fresh
     *  at 0, matching how energyCharge resets per run. */
    private _pickerDrawStreak: number = 0;
    /** Modal-pause flag — set to true while the shapeshifter picker (or
     *  any other blocking overlay that doesn't route through
     *  `energyPicker.active`) is open. Gates `tick` and `canAcceptInput`
     *  just like `paused` / `energyPicker.active`, but WITHOUT triggering
     *  the pause-UI overlay path. */
    modalPaused: boolean = false;

    // ---------- Backpack-armed "next piece" modifier ----------
    /** ARMED but not yet applied — set by BackpackController when the
     *  player uses a mini_block / bomb_block card. GameController's
     *  next-piece spawner MUST check this on every spawn call:
     *
     *    • 'mini' → force the next spawned piece to a single 1×1 cell
     *      (regardless of what Bag.next() rolled). Preserves the piece
     *      colour (visual continuity).
     *    • 'bomb' → same 1×1 forcing PLUS flag the cell with
     *      Bombs.ts kind 'box3'. On lock, PieceOps' clear routine sees
     *      the flag and clears the same-layer 3×3 area (Bombs.ts →
     *      bombBoxRange3x3 helper).
     *    • null   → no override, spawn normally.
     *
     *  MUST be cleared to null the moment it's consumed (before the
     *  piece actually spawns, not after) so a spawn failure / reset
     *  doesn't burn the arm for free.
     *
     *  Cleared to null at start of every reset() so a card armed in one
     *  run doesn't carry into the next.
     *
     *  Wire point (GameController): search for the site that calls
     *  Bag.next() to build the incoming piece; right before returning
     *  the piece, snapshot this field, null it, then transform the
     *  piece per the snapshot value. */
    pendingNextPieceModifier: 'mini' | 'bomb' | null = null;

    /** Backpack `bomb_block` (kind 'box3') — after a piece with a
     *  box3 tag locks, we DELAY the actual detonate for
     *  BOX3_ARM_DURATION_MS so the client can play a "danger ramp-up"
     *  animation on the locked cube (shake grows, scale grows, red →
     *  dark red). Populated in lockAndNext + drained in tick(). Empty
     *  the 99.9% of the time; only ever contains 1 entry in practice
     *  (bomb_block card forces a 1×1 piece).
     *
     *  Cells stay in `state.board` + `state.boardBombs` during the
     *  delay so CubeManager can render them via placeBox3LockedCube.
     *  On expiry we clear those grids and fire detonateBombs with the
     *  seed. */
    pendingBox3Detonations: Array<{ r: number; c: number; kind: BombKind; startTimeMs: number }> = [];

    /** True while the new-player operations tutorial is running. Gates
     *  a bunch of level-mode side effects (level win check, embed-prop
     *  rewards, energy charging, fate modal, fail on stack too tall)
     *  so the tutorial's dummy level stays inert. GameController
     *  sets this via `startTutorial()`. */
    tutorialActive: boolean = false;

    // ---------- Active piece ----------
    current:  Piece | null = null;
    nextType: PieceType    = 'T';
    /** Shape matrix for the queued next piece. `null` means "use the
     *  default `SHAPES[nextType]`" — set to a real matrix only when the
     *  bag draws the level's custom-shape entry. */
    nextShape: number[][] | null = null;
    nextBombsShape: (BombKind | null)[][] = makeEmptyBombs(SHAPES.T);
    /** Parallel boom (range-blast) embed grid for the queued next piece. */
    nextBoomsShape: (BoomLevel | null)[][] = makeEmptyBooms(SHAPES.T);
    /** Wrecker (rare random-sweep) embed grid for the queued next piece.
     *  Mirrors `nextBombsShape` / `nextBoomsShape` but stores a boolean
     *  marker per cell — only one cell per piece is ever set. */
    nextWreckersShape: (true | null)[][] = makeEmptyWreckers(SHAPES.T);
    holdType: PieceType | null = null;
    /** Parallel storage for the held piece's hand-authored shape. Only
     *  populated when the held piece carried `isCustomShape = true`
     *  (fate / level-editor custom). Null for standard tetrominoes,
     *  which restore from `SHAPES[holdType]` as usual. */
    holdShape: number[][] | null = null;
    canHold:  boolean = true;
    lastSpawnCenterCol: number | null = null;

    // ---------- Stats ----------
    score:       number = 0;
    lines:       number = 0;
    level:       number = 1;    // speed tier
    towerHeight: number = 0;
    best:        number = 0;

    /** How many endless-mode fate-piece milestones (each every
     *  ENDLESS_FATE_MILESTONE cumulative rows) have already popped the
     *  fate modal this run. Compared against
     *  `endlessProgress.cumulative / interval` after every lock to
     *  decide whether to queue another modal. */
    private endlessFateMilestonesPopped: number = 0;

    /** Highest cumulative-rows value the celebration FX has already
     *  fired for this run. Celebration fires EVERY layer — this is a
     *  latest-cum watermark, not a milestone count. Tracked separately
     *  from `endlessFateMilestonesPopped` because the celebration also
     *  fires in blind mode (where the fate modal is skipped). */
    private endlessCelebrationsFired: number = 0;

    /** Set by the last `clearLines` call inside the lock pipeline —
     *  read a few lines later for the embed-prop reward decision. Just
     *  a temp field so we don't have to plumb the value through
     *  multiple call sites. */
    private _lastClearLinesFullyCleared: number = 0;
    /** Set when an endless milestone fires. The renderer polls
     *  `hasPendingFateModal()` and shows the modal once FX have
     *  settled. The flag is cleared by `commitPendingFateModal`. */
    pendingFateModal: boolean = false;

    /** Type picked by the shapeshifter modal when the modal was opened
     *  BEFORE the next piece had spawned (typical picker flow: energy
     *  fills → spawn deferred → picker opens → player picks
     *  shapeshifter → picks a type). `spawnNext` consumes this and
     *  applies the recolour/reshape on the freshly-spawned piece. */
    pendingShapeshifterType: PieceType | null = null;

    // ---------- Timing ----------
    dropAccum:   number  = 0;
    dropInterval: number = BASE_DROP_INTERVAL_MS;

    /** DEV-only speed override for testing endless-mode ramping. When
     *  non-null, per-lock recalculation uses this value instead of the
     *  cumulative-derived multiplier. Set/cleared by the DEV speed button
     *  on the HUD (HudController.authoredDebugSpeedButton). */
    debugSpeedMultOverride: number | null = null;

    /** Row (piece.y coordinate) where the most recent piece was spawned
     *  by GameController.spawnNext. Written by GameController immediately
     *  after computing `visibleTopRow + 1`; read by Gatling.activate so
     *  bullets can materialise at the exact same on-screen height as a
     *  meteor DOT (both go through this Y). Default 0 = safe fallback
     *  for the pre-first-spawn window. */
    lastPieceSpawnY: number = 0;
    isGrounded:  boolean = false;
    lockDelay:   number  = 0;
    lockResets:  number  = 0;

    /** Deferred spawn flag — set by `lockAndNext` (post-clear) and
     *  storm-finish hooks instead of calling `spawnNext()` directly.
     *  The renderer (GameController) polls `hasPendingSpawn()` each
     *  frame and calls `commitPendingSpawn()` once every active FX
     *  (rainbow flash, sparkle stars, pre-pulse, ribbon detonation,
     *  shatter dust) has finished playing — so the next piece doesn't
     *  pop into a still-celebrating scene. */
    private pendingSpawn: boolean = false;
    /** Deferred picker-open flag — same idea as `pendingSpawn`. Set
     *  by `lockAndNext` when the bar fills, drained by the renderer
     *  once the line-clear / detonation FX finishes. Without this,
     *  the picker would pop up while shatter shards are still flying
     *  and (worse) while the just-locked piece's stamped cells are
     *  still visible at the top — looking like a fresh spawn. */
    private pendingPickerOpen: boolean = false;

    /** Rows cleared by DOT pieces during an in-flight meteor shower
     *  while the NEXT piece is also a DOT. The embed-prop injection
     *  fires on the FIRST lock where `nextType !== 'DOT'` (the last
     *  DOT of the shower) using `this lock's clears + accumulator`.
     *  Without this counter every DOT-cleared row during the shower
     *  was silently dropped from the reward calculation. */
    private meteorAccumulatedClears: number = 0;

    /** Wrecker × Boom combo cache. Populated at the start of the bomb/boom
     *  pipeline (in `lockAndNext` and `processMortarClears`) BEFORE any
     *  adjacent boom detonates. The boom firing-loop wipes its own
     *  `boardBooms` entry, so without this snapshot the wrecker activation
     *  later in the chain would see an empty cell and silently degrade
     *  the combo to a plain 10-cell sweep. Keyed by `${r}-${c}` (the
     *  wrecker's pre-fire position). Cleared at the top of each pipeline run. */
    private wreckerBoomComboCache: Map<string, 1 | 2 | 3> = new Map();
    /** Wrecker × directional-bomb combo cache. Same snapshot pattern as
     *  `wreckerBoomComboCache` — captured before the bomb pipeline fires
     *  so the wrecker can still see "I had a rowN/colN neighbour" even
     *  though that bomb has since detonated and been wiped. Stores just
     *  the axis (row vs col); the bomb's tier is intentionally
     *  discarded — every wrecker pick fires a level-1 blast on the
     *  captured axis. */
    private wreckerBombComboCache: Map<string, 'row' | 'col'> = new Map();
    /** Wrecker × wrecker adjacency combo cache. Two (or more) adjacent
     *  wreckers stack their pick pools into ONE bigger sweep instead of
     *  firing separately: the "leader" (the wrecker with the lexically-
     *  smallest key in a connected 4-neighbour cluster) picks
     *  `WRECKER_TARGETS × clusterSize` cells, everyone else in the
     *  cluster is marked "passive" and picks 0. This guarantees a
     *  visible 20-cell demolition for a pair without double-counting
     *  overlapping candidate pools. Keyed by `${r}-${c}`. */
    private wreckerAdjacencyPickCountCache: Map<string, number> = new Map();
    /** Wrecker activations that picked their cells but haven't committed
     *  the clear yet. Filled by `triggerWreckerFromBoard` (phase 1) and
     *  drained by `commitPendingWreckerPlans` (phase 2) after the renderer
     *  finishes its pre-pulse flash. */
    private pendingWreckerPlans: WreckerPlan[] = [];

    // ---------- External wiring ----------
    private readonly hooks: GameRenderHooks;
    private readonly rng:   () => number;

    constructor(opts: GameStateOpts = {}) {
        this.hooks = opts.hooks ?? {};
        this.rng   = opts.rng ?? Math.random;
        const clock = opts.clock ?? realClock;

        this.state = emptyEndlessBoardState();
        this.inventory = makeEmptyInventory();
        this.bag       = new Bag(this.rng);
        this.hourglass = new HourglassState(clock);
        this.blizzard  = new BlizzardState(clock);
        this.hail      = new HailState();
        this.rocket    = new RocketState(this.rng);
        this.gatling   = new GatlingState(this.rng);
        this.mortar    = new MortarState();
        this.history   = new RewindHistory();
        this.levelProgress   = new LevelChestProgress();
        this.endlessProgress = new EndlessChestProgress();
    }

    // ============================================================
    //  Lifecycle
    // ============================================================

    newGame(customPiece?: { baseType: PieceType; shape: number[][] }): void {
        this.mode = 'endless';
        this.currentLevel = null;
        this.levelReservedHeight = 0;
        this.levelTaskHeight = 0;
        this.collectGoals = [];
        this.collectProgress = {};
        this.state = emptyEndlessBoardState();
        // Endless starts with an EMPTY board — no prefilled gray
        // foundation. (Was a 4-row X prefill; removed per UX request
        // so the tower begins clean and gray only grows from actual
        // player fills.) The `already-gray subtraction` in
        // `lockAndNext` still holds up: with no prefill, `alreadyGray`
        // is simply 0 at game start and grows organically as fills
        // convert rows.
        // Inline the resetCommon work so we can register the custom-
        // shape piece (本命方块) BETWEEN bag.reset() and bag.refill().
        // Without this the first refill draws from the standard 7
        // tetrominoes, and the custom piece would only appear once the
        // bag exhausts and re-fills.
        this.reset();
        if (customPiece) {
            this.bag.setCustomShape({ type: customPiece.baseType, shape: customPiece.shape });
        }
        this.bag.refill();
        const d = this.bag.pick();
        this.nextType  = d.type;
        this.nextShape = d.shape;
        this.nextBombsShape    = makeEmptyBombs(this.nextShape ?? SHAPES[this.nextType]);
        this.nextBoomsShape    = makeEmptyBooms(this.nextShape ?? SHAPES[this.nextType]);
        this.nextWreckersShape = makeEmptyWreckers(this.nextShape ?? SHAPES[this.nextType]);
        this.startRunning();
    }

    /** Blind mode — endless mechanics minus the "spice":
     *   - No fate piece (skips bag.setCustomShape, fate modal never fires)
     *   - No embed props on the NEXT piece (endless already skips this;
     *     blind reuses the same check via `isEndlessLike`)
     *   - Tower rendering hidden (handled at the render layer; game state
     *     stays fully accurate so the player's stacking is real)
     *  Same failure conditions as endless (trapped hole / stack too tall)
     *  and the same gray-cap behaviour (`manageEndlessBoard`). */
    newBlindGame(): void {
        this.mode = 'blind';
        this.currentLevel = null;
        this.levelReservedHeight = 0;
        this.levelTaskHeight = 0;
        this.collectGoals = [];
        this.collectProgress = {};
        this.state = emptyEndlessBoardState();
        // Blind starts EMPTY — no prefilled gray foundation. Paired
        // with the `peelGrayAboveFoundation(state, 0)` call in
        // `lockAndNext` (was `..., 4)`) that keeps the total gray
        // count locked at 0, so completed rows collapse Tetris-style:
        // a row that becomes fully filled is converted to gray, then
        // immediately peeled, dropping the player's stack by one row.
        this.reset();
        // No customPiece registration — blind mode plays with the
        // standard 7 tetrominoes only.
        this.bag.refill();
        const d = this.bag.pick();
        this.nextType  = d.type;
        this.nextShape = d.shape;
        this.nextBombsShape    = makeEmptyBombs(this.nextShape ?? SHAPES[this.nextType]);
        this.nextBoomsShape    = makeEmptyBooms(this.nextShape ?? SHAPES[this.nextType]);
        this.nextWreckersShape = makeEmptyWreckers(this.nextShape ?? SHAPES[this.nextType]);
        this.startRunning();
    }

    startLevel(lvl: LevelData, embed: EmbedProp | null = null): void {
        // Reset the prior level's embed record — a fresh startLevel is
        // authoritative regardless of what the previous run left.
        this.lastEmbedInjection = null;
        const loaded = loadLevel(lvl);
        // Collect-mode levels carry a `collectGoals` array — they boot
        // into the dedicated collect mode (win = goals met, not the
        // clear-task-zone check).
        const goals = (lvl.collectGoals ?? []).filter(g => g && g.color && g.count > 0);
        this.mode = goals.length > 0 ? 'collect' : 'level';
        this.collectGoals    = goals.map(g => ({ color: g.color, count: g.count }));
        this.collectProgress = {};
        this.currentLevel = lvl;
        this.levelTaskHeight     = loaded.taskHeight;
        this.levelReservedHeight = loaded.reservedHeight;
        this.state = loaded.state;
        // Optional pre-level embed prop (level 16+ picker in HudController).
        // Injects the picked prop into one random colored cell BEFORE the
        // player sees the board — see `_injectEmbedProp` for details.
        if (embed) this._injectEmbedProp(embed);
        // `resetCommon` would re-shuffle the bag immediately, so we
        // inline its work here and register the level's optional
        // custom-shape piece BETWEEN bag.reset() and bag.refill() —
        // otherwise the custom entry would be wiped before the first
        // refill ever sees it.
        this.reset();
        if (loaded.customPiece) {
            this.bag.setCustomShape({
                type:  loaded.customPiece.baseType,
                shape: loaded.customPiece.shape,
            });
        }
        this.bag.refill();
        // Tutorial: force the FIRST spawn to be the registered custom
        // piece (the tutorial's "practice" I) so the tap-to-morph demo
        // has a piece with visible rotation instead of a random O.
        // Non-tutorial paths use the normal shuffled draw.
        const d = this.tutorialActive
            ? this.bag.pickCustomFirst()
            : this.bag.pick();
        this.nextType = d.type;
        this.nextShape = d.shape;
        this.nextBombsShape = makeEmptyBombs(this.nextShape ?? SHAPES[this.nextType]);
        this.nextBoomsShape = makeEmptyBooms(this.nextShape ?? SHAPES[this.nextType]);
        this.nextWreckersShape = makeEmptyWreckers(this.nextShape ?? SHAPES[this.nextType]);
        // Seed starting items.
        for (const k of Object.keys(loaded.startingItems) as MagicItemKey[]) {
            const v = loaded.startingItems[k];
            if (v) this.inventory[k] = v;
        }
        this.hooks.onInventoryChanged?.(this.inventory);
        this.startRunning();
    }

    /** Pending embed prop from the Lvl 16+ picker.
     *
     *  Deferred-commit design: `startLevel` picks the target cell but
     *  does NOT write to `boardBooms` / `boardBombs` / `boardWreckers`.
     *  The prop is committed by `commitPendingEmbedProp()` — called by
     *  GameController AFTER the yellow-orb FX lands on the cell, so the
     *  reveal reads as "the orb hits and forms the prop". The frame
     *  right after commit, `syncCubes` renders the overlay.
     *
     *  Non-null between `_injectEmbedProp` and `commitPendingEmbedProp`.
     *  Cleared on commit and on a fresh `startLevel`. */
    public lastEmbedInjection: { r: number; c: number; kind: EmbedProp } | null = null;

    /** Drop the player-picked embed prop onto a single colored cell.
     *
     *  Landing rule (matches the picker copy "任意一个彩色方块"):
     *    1. Scan every non-null cell in `state.board` — both the task
     *       zone AND the reserved zone qualify.
     *    2. Prefer "clean" cells that carry no existing prop (bomb,
     *       boom, stone, chest, meteor, blizzard, wrecker, hail,
     *       rocket, gatling). This keeps a hand-authored level bomb
     *       from being silently overwritten.
     *    3. If the level is stone/prop-saturated and no clean cell
     *       exists, fall back to any colored cell — the player asked
     *       for an embed, better to grant SOMETHING than skip silently.
     *    4. If the board has no colored cells at all (extreme edge
     *       case), the embed is dropped — no crash, no cell to host it.
     *
     *  Both target props are single-cell:
     *    'boom1' → `boardBooms[r][c] = 1`   (5-cell plus on host clear)
     *    'row1'  → `boardBombs[r][c] = 'row1'` (row clear when host row fills)
     *
     *  Called BEFORE `reset()` / hook events fire, so no repaint work
     *  is needed here — the first render of the new state already
     *  includes the injected prop. */
    private _injectEmbedProp(embed: EmbedProp): void {
        const board = this.state.board;
        if (!board || board.length === 0) return;
        const bombs = this.state.boardBombs;
        const booms = this.state.boardBooms;
        if (!bombs || !booms) return;   // level state always has both, guard is TypeScript-belt

        // Row-grouped pools. Stratified pick — random ROW first, then
        // random CELL within that row — so a level with wildly varying
        // per-row cell counts doesn't bias toward the densest rows.
        // Previously used a flat "shuffle every cell" pool; rows with
        // more colored cells (typically the bottom of a task zone
        // once gaps are added) statistically won the pick, which
        // read as "always lands on the bottom row".
        const cleanByRow:      Map<number, number[]> = new Map();
        const anyColoredByRow: Map<number, number[]> = new Map();
        const stones    = this.state.boardStones;
        const chests    = this.state.boardChests;
        const meteors   = this.state.boardMeteors;
        const blizzards = this.state.boardBlizzards;
        const wreckers  = this.state.boardWreckers;
        const hails     = this.state.boardHails;
        const rockets   = this.state.boardRockets;
        const gatlings  = this.state.boardGatlings;

        for (let r = 0; r < board.length; r++) {
            const row = board[r];
            if (!row) continue;
            for (let c = 0; c < row.length; c++) {
                const v = row[c];
                if (v == null) continue;
                // Gray cells (endless-mode debris) do exist in level
                // mode via `X` stones? No — 'X' is endless-only. But
                // guard anyway: treat only proper colored letters as
                // valid hosts.
                if (v === 'X') continue;
                if (!anyColoredByRow.has(r)) anyColoredByRow.set(r, []);
                anyColoredByRow.get(r)!.push(c);
                const dirty =
                       (bombs[r]?.[c] != null)
                    || (booms[r]?.[c] != null)
                    || (stones?.[r]?.[c] != null)
                    || (chests?.[r]?.[c] != null)
                    || (meteors?.[r]?.[c] != null)
                    || (blizzards?.[r]?.[c] != null)
                    || (wreckers?.[r]?.[c] != null)
                    || (hails?.[r]?.[c] != null)
                    || (rockets?.[r]?.[c] != null)
                    || (gatlings?.[r]?.[c] != null);
                if (!dirty) {
                    if (!cleanByRow.has(r)) cleanByRow.set(r, []);
                    cleanByRow.get(r)!.push(c);
                }
            }
        }
        const byRow = cleanByRow.size > 0 ? cleanByRow : anyColoredByRow;
        if (byRow.size === 0) return;
        // Pick a random row from the eligible-row set, THEN a random
        // column within that row. Each row gets equal weight — a row
        // with 20 cells doesn't outvote a row with 5.
        const rows = Array.from(byRow.keys());
        const pickR = rows[Math.floor(Math.random() * rows.length)];
        const cols  = byRow.get(pickR)!;
        const pickC = cols[Math.floor(Math.random() * cols.length)];
        // Deferred commit — the cell stays a plain colored cube until
        // GameController's post-assembly FX calls `commitPendingEmbedProp`
        // at orb impact, so the reveal reads as "orb → prop forms here".
        this.lastEmbedInjection = { r: pickR, c: pickC, kind: embed };
        console.log(`[EmbedProp] queued ${embed} at r=${pickR} c=${pickC} (eligibleRows=${rows.length} rowRange=[${Math.min(...rows)}..${Math.max(...rows)}])`);
    }

    /** Write the picker's pending embed prop into the board's prop
     *  arrays, then null out `lastEmbedInjection`. Called by
     *  GameController when the yellow-orb FX lands on the target cell
     *  — the next `syncCubes` frame paints the overlay, giving the
     *  glow pulse a real prop to reveal. Idempotent when nothing's
     *  pending. */
    public commitPendingEmbedProp(): void {
        const inj = this.lastEmbedInjection;
        if (!inj) return;
        const bombs = this.state.boardBombs;
        const booms = this.state.boardBooms;
        const board = this.state.board;
        if (inj.kind === 'boom1' && booms) {
            booms[inj.r][inj.c] = 1;
        } else if (inj.kind === 'row1' && bombs) {
            bombs[inj.r][inj.c] = 'row1';
        } else if (inj.kind === 'wrecker') {
            if (!this.state.boardWreckers) {
                const cols = board[0]?.length ?? 0;
                this.state.boardWreckers = board.map(() => new Array<true | null>(cols).fill(null));
            }
            this.state.boardWreckers[inj.r][inj.c] = true;
        }
        console.log(`[EmbedProp] committed ${inj.kind} at r=${inj.r} c=${inj.c}`);
        this.lastEmbedInjection = null;
    }

    togglePause(): void {
        if (!this.running || this.gameOver) return;
        this.paused = !this.paused;
    }

    /** Backpack item — 甩干机 (Dryer). For every row IN THE TASK
     *  ZONE, gather all colored cells (along with any per-cell props:
     *  bombs, booms, stones, chests, wreckers, meteors, blizzards,
     *  hails, rockets, gatlings) and repack them into the first N
     *  columns starting from col 0, leaving the rest of the row
     *  empty. The cylinder wraps around at COLS, so the semantic is
     *  "close every gap in the row" — colored cells clump into one
     *  contiguous arc segment per layer.
     *
     *  Level-mode reserved zone (the gray/black foundation at the
     *  bottom) is UNTOUCHED — the item only affects the task-zone
     *  colored cells the player is actively clearing. Endless-like
     *  modes have no reserved zone so every row qualifies.
     *
     *  Purely a state mutation — GameController handles the visual
     *  (1-second 360° tower rotation) around the call. */
    applyDryerRowCompact(): void {
        const board = this.state.board;
        if (!board || board.length === 0) return;
        const cols = board[0]?.length ?? 0;
        if (cols === 0) return;
        // Skip the reserved-zone rows so the black foundation stays
        // exactly where the level author placed it.
        const reservedTop = this.computeReservedTop();

        // For each per-cell prop grid, gather + reset + repack in
        // sync with the base board. Wall-of-nulls guards handle
        // level modes where a grid is null (e.g. endless has no
        // stones / chests).
        for (let r = 0; r < reservedTop; r++) {
            const row = board[r];
            if (!row) continue;
            const cells:      (typeof row[0])[] = [];
            const bombs:      any[] = [];
            const booms:      any[] = [];
            const stones:     any[] = [];
            const chests:     any[] = [];
            const meteors:    any[] = [];
            const blizzards:  any[] = [];
            const wreckers:   any[] = [];
            const hails:      any[] = [];
            const hailPlaced: any[] = [];
            const rockets:    any[] = [];
            const gatlings:   any[] = [];
            for (let c = 0; c < cols; c++) {
                if (row[c] == null) continue;
                cells.push(row[c]);
                bombs.push(this.state.boardBombs?.[r]?.[c] ?? null);
                booms.push(this.state.boardBooms?.[r]?.[c] ?? null);
                stones.push(this.state.boardStones?.[r]?.[c] ?? null);
                chests.push(this.state.boardChests?.[r]?.[c] ?? null);
                meteors.push(this.state.boardMeteors?.[r]?.[c] ?? null);
                blizzards.push(this.state.boardBlizzards?.[r]?.[c] ?? null);
                wreckers.push(this.state.boardWreckers?.[r]?.[c] ?? null);
                hails.push(this.state.boardHails?.[r]?.[c] ?? null);
                hailPlaced.push(this.state.boardHailPlaced?.[r]?.[c] ?? null);
                rockets.push(this.state.boardRockets?.[r]?.[c] ?? null);
                gatlings.push(this.state.boardGatlings?.[r]?.[c] ?? null);
            }
            // Wipe the row.
            for (let c = 0; c < cols; c++) {
                row[c] = null;
                if (this.state.boardBombs?.[r])      this.state.boardBombs[r][c]      = null;
                if (this.state.boardBooms?.[r])      this.state.boardBooms[r][c]      = null;
                if (this.state.boardStones?.[r])     this.state.boardStones[r][c]     = null;
                if (this.state.boardChests?.[r])     this.state.boardChests[r][c]     = null;
                if (this.state.boardMeteors?.[r])    this.state.boardMeteors[r][c]    = null;
                if (this.state.boardBlizzards?.[r])  this.state.boardBlizzards[r][c]  = null;
                if (this.state.boardWreckers?.[r])   this.state.boardWreckers[r][c]   = null;
                if (this.state.boardHails?.[r])      this.state.boardHails[r][c]      = null;
                if (this.state.boardHailPlaced?.[r]) this.state.boardHailPlaced[r][c] = null;
                if (this.state.boardRockets?.[r])    this.state.boardRockets[r][c]    = null;
                if (this.state.boardGatlings?.[r])   this.state.boardGatlings[r][c]   = null;
            }
            // Repack starting at col 0.
            for (let i = 0; i < cells.length; i++) {
                row[i] = cells[i];
                if (this.state.boardBombs?.[r])      this.state.boardBombs[r][i]      = bombs[i];
                if (this.state.boardBooms?.[r])      this.state.boardBooms[r][i]      = booms[i];
                if (this.state.boardStones?.[r])     this.state.boardStones[r][i]     = stones[i];
                if (this.state.boardChests?.[r])     this.state.boardChests[r][i]     = chests[i];
                if (this.state.boardMeteors?.[r])    this.state.boardMeteors[r][i]    = meteors[i];
                if (this.state.boardBlizzards?.[r])  this.state.boardBlizzards[r][i]  = blizzards[i];
                if (this.state.boardWreckers?.[r])   this.state.boardWreckers[r][i]   = wreckers[i];
                if (this.state.boardHails?.[r])      this.state.boardHails[r][i]      = hails[i];
                if (this.state.boardHailPlaced?.[r]) this.state.boardHailPlaced[r][i] = hailPlaced[i];
                if (this.state.boardRockets?.[r])    this.state.boardRockets[r][i]    = rockets[i];
                if (this.state.boardGatlings?.[r])   this.state.boardGatlings[r][i]   = gatlings[i];
            }
        }
    }

    /** Backpack item — 重力压制 (Gravity Press), settle phase.
     *  Every column's colored cells (with their props) settle
     *  downward to fill any empty spaces below them. Delegates to
     *  the well-tested `applyColumnGravity` primitive, passing
     *  `computeReservedTop` so the level-mode reserved zone (the
     *  black/gray foundation) is untouched — colored cells settle
     *  onto the top of the reserved zone rather than being scooped
     *  into it. Endless-like modes have no reserved zone, so the
     *  whole tower compresses.
     *
     *  Row clearing is DEFERRED — call `applyGravityPressClearSweep`
     *  after a 0.5 s pause so the player sees the settled state
     *  before rows disappear. */
    applyGravityPress(): void {
        if (!this.state.board || this.state.board.length === 0) return;
        applyColumnGravity(this.state, this.computeReservedTop());
    }

    /** Follow-up to `applyGravityPress` (called by GameController after
     *  a short delay). Sweeps any rows that ended up fully packed
     *  through the standard `clearLines` pipeline: flash FX, stone
     *  HP decrement, chest progress hooks — all the usual side
     *  effects. Score bonus is intentionally NOT applied — the
     *  player paid a backpack item for the clear, layering score
     *  points on top would double-dip. */
    applyGravityPressClearSweep(): void {
        if (!this.state.board || this.state.board.length === 0) return;
        const reservedTop = this.computeReservedTop();
        const result = clearLines(this.state, reservedTop, this.makeClearHooks());
        if (result.fullyCleared > 0) {
            this._lastClearLinesFullyCleared = result.fullyCleared;
            this.lines += result.fullyCleared;
            this.hooks.onLinesChanged?.(this.lines);
            const chests = this.levelProgress.consume(result.fullyCleared);
            for (let i = 0; i < chests; i++) this.grantOneChest();
            // Also fire the natural-clears hook so screen-shake +
            // downstream systems that hook on multi-line clears see
            // the event.
            if (result.fullyCleared >= 1) {
                this.hooks.onNaturalRowClears?.(result.fullyCleared);
            }
        }
    }

    /** Scan the just-locked `piece` for any `box3` bomb tags and
     *  return them as BombSeeds at their board-space (r, c). Called
     *  right after `lock()` so we can add box-bomb seeds to the
     *  standard row/adjacent seeds fed into `detonateBombs`. Empty
     *  array when no box3 tag is present (the 99.9% case — box3 only
     *  comes from the `bomb_block` backpack card).
     *
     *  Kept private + tiny so the two lock paths (`lockAndNext` +
     *  `mortarLockAndNext`) don't duplicate the piece-cell walk. The
     *  mortar path doesn't actually need this today (mortar drops
     *  don't carry piece bombs), but keeping the API consistent
     *  future-proofs it if mortar ever spawns a bomb-tagged cell.
     */
    private _gatherJustLockedBox3s(piece: Piece): Array<{ r: number; c: number; kind: BombKind }> {
        const out: Array<{ r: number; c: number; kind: BombKind }> = [];
        if (!piece) return out;
        const COLS_LOCAL = this.state.board[0].length;
        for (let pr = 0; pr < piece.shape.length; pr++) {
            for (let pc = 0; pc < piece.shape[pr].length; pc++) {
                if (!piece.shape[pr][pc]) continue;
                const kind = piece.bombs[pr]?.[pc];
                if (kind !== 'box3') continue;
                const wx = ((piece.x + pc) % COLS_LOCAL + COLS_LOCAL) % COLS_LOCAL;
                const wy = piece.y + pr;
                if (wy < 0 || wy >= this.state.board.length) continue;
                out.push({ r: wy, c: wx, kind: 'box3' });
            }
        }
        return out;
    }

    /** Fire any pendingBox3Detonations whose armed-time has elapsed.
     *  Called from tick() every frame. Once a pending entry's age
     *  exceeds BOX3_ARM_DURATION_MS, we clear its cell from the
     *  boardBombs grid, fire detonateBombs with just that seed, and
     *  remove it from the pending list. The cube animation is
     *  driven from CubeManager reading the pending list; when we
     *  remove the entry the animation naturally stops and detonate
     *  proceeds to null the cell + run the 3×3 clear + FX. */
    private _drainPendingBox3Detonations(): void {
        if (this.pendingBox3Detonations.length === 0) return;
        const now = this.clock ? this.clock.now() : Date.now();
        const stillPending: typeof this.pendingBox3Detonations = [];
        const ready: typeof this.pendingBox3Detonations = [];
        for (const p of this.pendingBox3Detonations) {
            if (now - p.startTimeMs >= BOX3_ARM_DURATION_MS) ready.push(p);
            else                                             stillPending.push(p);
        }
        this.pendingBox3Detonations = stillPending;
        if (ready.length === 0) return;
        // Drop expired entries whose cell no longer holds the box3
        // tag — this catches the case where the bomb's row got
        // naturally cleared (full row) between lock and expiry, so
        // the bomb was consumed WITH the row-clear. Firing detonate
        // at the stored (r, c) after that would either explode empty
        // space or worse: whatever cells were shifted INTO those
        // coords by the splice. Silent drop matches player intuition
        // ("I completed a row with the bomb — cool, that's the effect").
        const alive = ready.filter(p =>
            this.state.boardBombs?.[p.r]?.[p.c] === 'box3'
        );
        if (alive.length === 0) return;
        // Fire all live entries together — Detonate.detonateBombs
        // dedupes chains, so passing multiple box3 seeds in one call
        // is fine and slightly cheaper than one call per bomb.
        const seeds = alive.map(p => ({ r: p.r, c: p.c, kind: p.kind }));
        // Clear the bomb tag from boardBombs BEFORE detonating — the
        // detonate loop guards against re-triggering an already-nulled
        // bomb, but leaving the tag around would confuse
        // CubeManager into keeping the danger animation for one more
        // frame.
        for (const s of seeds) {
            if (this.state.boardBombs && this.state.boardBombs[s.r]) {
                this.state.boardBombs[s.r][s.c] = null;
            }
        }
        detonateBombs(this.state, seeds, this.computeReservedTop(), this.makeDetonateHooks());
    }

    /** Public read-only view of pending box3 detonations — used by
     *  the renderer (CubeManager) to identify cells that should be
     *  drawn with the danger ramp-up animation instead of the
     *  normal cube. Returns the same array reference; caller must
     *  NOT mutate. */
    public getPendingBox3Detonations(): ReadonlyArray<{ r: number; c: number; kind: BombKind; startTimeMs: number }> {
        return this.pendingBox3Detonations;
    }

    /** Immediately transform the CURRENTLY-QUEUED "next" piece to the
     *  backpack-armed override AND clear the pending flag. Called by
     *  BackpackController the moment a mini_block / bomb_block card
     *  is consumed on the server, so the HUD next-preview visually
     *  confirms the arm without waiting for the next spawn cycle.
     *
     *  Effects:
     *    • 'mini' → next piece is a single 1×1 cell (colour preserved
     *      from the bag pick so the preview still shows a coloured
     *      block, just one cell)
     *    • 'bomb' → same 1×1 forcing PLUS the cell is tagged as
     *      Bombs.ts kind 'box3'. PieceOps' clear routine sees the
     *      tag on lock and clears the same-layer 3×3 area centred on
     *      the locked cell.
     *
     *  A no-op if there's no queued next yet (very early boot before
     *  bag.refill()). In that case pendingNextPieceModifier stays
     *  set and the transformation happens when the next preview is
     *  first populated — but every startXxx() path picks a next
     *  before the player can open the backpack, so this is defense
     *  in depth.
     *
     *  Idempotent-ish — calling it twice with the same modifier is
     *  fine; calling with a different modifier overwrites (last write
     *  wins).
     */
    applyBackpackNextPieceOverride(mod: 'mini' | 'bomb'): void {
        // No queued next yet — leave the arm on so a later pick applies.
        if (this.nextShape === null && !this.nextType) return;
        // Force the shape to a single 1×1 cell.
        this.nextShape = [[1]];
        // Force the piece TYPE so its colour is deterministic — matches
        // the backpack card's visual identity so the player learns
        // "red small = bomb, yellow small = mini" at a glance instead
        // of a random tetromino colour.
        //   • bomb → 'Z' (COLORS.Z = balanced red `#c35555`). The
        //     falling piece renders via placeBox3PieceCube's dark-red
        //     pulse anyway, but pinning type=Z keeps the HUD next-
        //     preview swatch red too.
        //   • mini → 'O' (COLORS.O = balanced gold `#c4a04d`). This
        //     one drives both the HUD preview AND the falling cube's
        //     placeCube colour.
        this.nextType = (mod === 'bomb' ? 'Z' : 'O');
        // Fresh bombs / booms / wreckers grids sized to the new shape.
        this.nextBombsShape    = makeEmptyBombs(this.nextShape);
        this.nextBoomsShape    = makeEmptyBooms(this.nextShape);
        this.nextWreckersShape = makeEmptyWreckers(this.nextShape);
        if (mod === 'bomb') {
            // Tag the sole cell as a 3×3 box bomb.
            this.nextBombsShape[0][0] = 'box3' as BombKind;
        }
        // Clear the arm — we've applied it.
        this.pendingNextPieceModifier = null;
        // Repaint the HUD next-preview.
        this.hooks.onNextChanged?.(this.nextType);
    }

    reset(): void {
        this.running = false;
        this.paused = false;
        this.modalPaused = false;
        this.gameOver = false;
        this.failureReason = null;
        // Fresh run — the one-shot revive is available again.
        this.endlessReviveUsed = false;
        this.current = null;
        this.holdType = null;
        this.holdShape = null;
        this.canHold = true;
        this.score = 0;
        this.lines = 0;
        this.level = 1;
        this.towerHeight = 0;
        this.dropAccum = 0;
        this.dropInterval = BASE_DROP_INTERVAL_MS;
        this.isGrounded = false;
        this.lockDelay = 0;
        this.lockResets = 0;
        this.lastSpawnCenterCol = null;
        this.pendingSpawn = false;
        this.pendingPickerOpen = false;
        this.pendingFateModal = false;
        this.pendingShapeshifterType = null;
        this.endlessFateMilestonesPopped = 0;
        this.endlessCelebrationsFired = 0;
        this.meteorAccumulatedClears = 0;
        this.levelElapsedSec = 0;
        this._elapsedSubSec = 0;
        this.bag.reset();
        this.hourglass.reset();
        this.blizzard.reset();
        this.hail.reset();
        this.rocket.reset();
        this.gatling.reset();
        this.mortar.reset();
        this.pendingWreckerPlans = [];
        // Backpack-armed next-piece modifier does NOT survive a reset —
        // the arm is meant for the current match; a match restart
        // means the player has to reuse another card if they still
        // want the effect.
        this.pendingNextPieceModifier = null;
        // Any half-armed box3 gets dropped on match restart — the
        // player doesn't get a delayed detonation on their next run.
        this.pendingBox3Detonations = [];
        this.history.reset();
        this.levelProgress.reset();
        this.endlessProgress.reset();
        this.inventory = makeEmptyInventory();
        // Energy bar resets to empty + picker closed.
        this.energyCharge = 0;
        this.energyPicker.active = false;
        this.energyPicker.choices = [];
        this.hooks.onEnergyChanged?.(0, ENERGY_FULL_THRESHOLD);
        this.hooks.onEnergyPickerClose?.();
    }

    private resetCommon(): void {
        this.reset();
        this.bag.refill();
        const d = this.bag.pick();
        this.nextType = d.type;
        this.nextShape = d.shape;
        this.nextBombsShape = makeEmptyBombs(this.nextShape ?? SHAPES[this.nextType]);
        this.nextBoomsShape = makeEmptyBooms(this.nextShape ?? SHAPES[this.nextType]);
        this.nextWreckersShape = makeEmptyWreckers(this.nextShape ?? SHAPES[this.nextType]);
    }

    private startRunning(): void {
        this.running = true;
        this.spawnNext();
    }

    /** Spawn the next piece using `nextType` + `nextBombsShape`. */
    private spawnNext(): void {
        this.current = spawn(this.nextType, this.lastSpawnCenterCol, this.nextBombsShape, this.nextShape, this.nextBoomsShape, this.nextWreckersShape);
        // Consume any shapeshifter pick that came in while there was
        // no live piece (the energy picker path deferred spawn until
        // FX cleared). Applying here means the just-spawned piece is
        // the one the transformation lands on.
        if (this.pendingShapeshifterType && this.current) {
            this.current = applyShapeshifterPick(this.current, this.pendingShapeshifterType);
            this.pendingShapeshifterType = null;
        }
        // Meteor shower per-DOT SFX — fire once per DOT spawn (not
        // once at activation) so each falling meteor gets its own
        // launch sound, matching the rocket / gatling pattern.
        if (this.current && this.current.type === 'DOT') {
            this.hooks.onMeteorFire?.();
        }
        const d = this.bag.pick();
        this.nextType = d.type;
        this.nextShape = d.shape;
        this.nextBombsShape = makeEmptyBombs(this.nextShape ?? SHAPES[this.nextType]);
        this.nextBoomsShape = makeEmptyBooms(this.nextShape ?? SHAPES[this.nextType]);
        this.nextWreckersShape = makeEmptyWreckers(this.nextShape ?? SHAPES[this.nextType]);
        this.isGrounded = false;
        this.lockDelay = 0;
        this.lockResets = 0;
        this.hooks.onNextChanged?.(this.nextType);
    }

    // ============================================================
    //  Main tick
    // ============================================================

    tick(dt: number): void {
        if (!this.running || this.paused || this.gameOver) return;

        // Energy picker freezes the game until the player picks.
        if (this.energyPicker.active) return;
        // Shapeshifter picker (and any other blocking modal that flips
        // modalPaused) — same treatment.
        if (this.modalPaused) return;

        // Backpack `bomb_block` armed but not-yet-fired detonations.
        // Fire the actual detonateBombs after BOX3_ARM_DURATION_MS —
        // during the delay the client renders the locked cube via
        // CubeManager.placeBox3LockedCube (shake, expand, red→dark red).
        this._drainPendingBox3Detonations();

        // Level timer — accrue only for level / collect modes, and only
        // when the game is actively running (all pause / picker / modal
        // gates above have early-returned). `dt` here is MILLISECONDS
        // (caller in GameController.update does `gameState.tick(dt * 1000)`
        // to convert Cocos's second-based deltaTime), so divide by 1000
        // to get seconds. Whole seconds land in levelElapsedSec (what
        // the HUD + server read); the sub-second remainder rolls up in
        // _elapsedSubSec so a 60fps tick doesn't lose ~16ms per frame
        // to floor rounding. Endless / blind leave both at 0.
        if (this.mode === 'level' || this.mode === 'collect') {
            this._elapsedSubSec += dt / 1000;
            const whole = Math.floor(this._elapsedSubSec);
            if (whole > 0) {
                this.levelElapsedSec += whole;
                this._elapsedSubSec -= whole;
            }
        }

        // Hail/rocket/gatling/mortar storms freeze normal piece movement.
        if (this.hail.mode || this.rocket.mode || this.gatling.mode || this.mortar.mode) {
            if (this.hail.mode)    this.hail.tick(dt, this.state, this.makeStormHooks());
            // Endless / blind: preserve the gray foundation from
            // magic-item storm damage. Rocket + gatling both pass
            // through 'X' cells without stopping or clearing them
            // in these modes. Level / collect keep the existing
            // "storms chew through gray" behaviour.
            const preserveGray = isEndlessLike(this.mode);
            if (this.rocket.mode)  this.rocket.tick(dt, this.state, this.computeReservedTop(), {
                ...this.makeStormHooks(),
                onHit:  (r, c, color) => this.hooks.onRocketHit?.([{ r, c, color }]),
                onFire: (col) => this.hooks.onRocketFire?.(col),
            }, preserveGray);
            if (this.gatling.mode) this.gatling.tick(
                dt,
                this.state,
                this.computeReservedTop(),
                // Live target column: the camera-facing column at this
                // very tick. Updated by `rotate()` so rotating the
                // tower mid-storm redirects new+in-flight bullets onto
                // whatever's now in front.
                this.lastSpawnCenterCol ?? 0,
                {
                    ...this.makeStormHooks(),
                    onHit:  (r, c, color) => this.hooks.onGatlingHit?.([{ r, c, color }]),
                    onFire: (col) => this.hooks.onGatlingFire?.(col),
                },
                preserveGray,
            );
            if (this.mortar.mode)  this.mortar.tick(dt, this.state, this.makeMortarHooks());
            // Mid-storm win check: if the gatling / rocket / mortar
            // cleared the last colored cell, fire the level-win popup
            // RIGHT NOW instead of waiting for every pending bullet /
            // drop to play through. Aborts the active storm(s) so the
            // remaining projectiles don't keep raining over a finished
            // board.
            if ((this.mode === 'level' || this.mode === 'collect') && this.maybeFireLevelWin()) {
                this.hail.reset();
                this.rocket.reset();
                this.gatling.reset();
                this.mortar.reset();
            }
            return;
        }

        if (!this.current) return;

        // Drop / lock loop.
        const grounded = collides(this.state.board, this.current, 0, 1, this.current.shape);
        if (grounded) {
            // DOT pieces lock instantly on touchdown (meteor shower).
            if (this.current.type === 'DOT') {
                this.lockAndNext();
                this.dropAccum = 0;
                return;
            }
            if (!this.isGrounded) {
                this.isGrounded = true;
                this.lockDelay  = LOCK_DELAY_MS;
            }
            this.lockDelay -= dt;
            if (this.lockDelay <= 0) {
                this.lockAndNext();
                this.dropAccum = 0;
            }
        } else {
            this.isGrounded = false;
            this.lockDelay = 0;
            // Tutorial: freeze gravity. The piece hovers wherever it
            // spawned until the player hard-drops it via a swipe-down
            // gesture. This lets the player take their time on each
            // gesture demo without racing the drop.
            if (this.tutorialActive) return;
            this.dropAccum += dt;
            let interval: number;
            if (this.current.type === 'DOT') {
                interval = METEOR_DROP_INTERVAL;
            } else {
                interval = this.hourglass.isActive() ? this.dropInterval * 2 : this.dropInterval;
            }
            if (this.dropAccum >= interval) {
                this.dropAccum = 0;
                if (!collides(this.state.board, this.current, 0, 1, this.current.shape)) {
                    this.current.y += 1;
                    this.lockResets = 0;
                }
            }
        }
    }

    // ============================================================
    //  Input commands
    // ============================================================

    /** Rotate the tower one column in `dir`.
     *  Returns:
     *   - true  : the piece actually moved, OR a storm was active so we
     *             panned the camera instead (both count as "the tower
     *             visually responded" — caller can play rotate_tower).
     *   - false : the falling piece is jammed against a stack cell and
     *             can't move (caller should play rotate_blocked). Input
     *             gating (canAcceptInput false) also returns false — a
     *             no-op call also counts as "blocked" for SFX purposes
     *             since the tower didn't move; keeps the audio honest. */
    moveCylinder(dir: -1 | 1): boolean {
        if (!this.canAcceptInput()) return false;
        // Storms (hail / rocket / gatling) freeze piece play — the input
        // pans the camera even if a piece is technically alive. Critical
        // for gatling: bullets target `lastSpawnCenterCol`, and the
        // renderer uses the same value to place the stream at screen
        // centre. If we moved the piece instead, the renderer would
        // follow the piece while the bullets' targeting column stayed
        // fixed, and the visual/collision would desync.
        if (!this.current || this.hail.mode || this.rocket.mode || this.gatling.mode || this.mortar.mode) {
            this.lastSpawnCenterCol = (this.lastSpawnCenterCol ?? 0) + dir;
            return true;
        }
        if (!collides(this.state.board, this.current, dir, 0, this.current.shape)) {
            this.current.x = wrap(this.current.x + dir);
            this.tryResetLockDelay();
            return true;
        }
        return false;
    }

    tryRotate(dir: 1 | -1): void {
        if (!this.canAcceptInput() || !this.current) return;
        const newShape = rotate(this.current.shape, dir);
        // `rotateBombs` is bomb-aware: it rotates the cells in lockstep with the
        // shape AND flips each bomb's blast axis (rowN ↔ colN) per 90°, so the
        // bomb's direction visually matches the rotated piece. `rotateBooms`
        // does the same for radial (boom) props — no axis flip since the
        // diamond blast is rotation-invariant.
        const newBombs    = this.current.bombs    ? rotateBombs(this.current.bombs, dir) : null;
        const newBooms    = this.current.booms    ? rotateBooms(this.current.booms, dir) : null;
        const newWreckers = this.current.wreckers ? rotateWreckers(this.current.wreckers, dir) : null;
        if (!collides(this.state.board, this.current, 0, 0, newShape)) {
            this.current.shape = newShape;
            if (newBombs)    this.current.bombs    = newBombs;
            if (newBooms)    this.current.booms    = newBooms;
            if (newWreckers) this.current.wreckers = newWreckers;
            this.tryResetLockDelay();
            this.hooks.onRotate?.();
            return;
        }
        // Kick attempt: try shifting up 1, then 2 rows.
        for (const ky of [-1, -2]) {
            if (!collides(this.state.board, this.current, 0, ky, newShape)) {
                this.current.shape = newShape;
                if (newBombs)    this.current.bombs    = newBombs;
                if (newBooms)    this.current.booms    = newBooms;
                if (newWreckers) this.current.wreckers = newWreckers;
                this.current.y += ky;
                this.tryResetLockDelay();
                this.hooks.onRotate?.();
                return;
            }
        }
    }

    hardDrop(): void {
        if (!this.canAcceptInput() || !this.current) return;
        let d = 0;
        while (!collides(this.state.board, this.current, 0, d + 1, this.current.shape)) d++;
        this.current.y += d;
        this.score += d * 2;
        this.hooks.onScoreChanged?.(this.score);
        if (d > 0) this.lockResets = 0;
    }

    /** Return the y-coordinate at which the current piece would land if
     *  hard-dropped RIGHT NOW (no piece movement, just gravity). Used by
     *  the renderer to draw a translucent "ghost" preview.
     *
     *  Returns `null` when there's no live piece, or when the piece is
     *  already grounded (ghost overlaps current, no point drawing). */
    getGhostDropY(): number | null {
        if (!this.current) return null;
        let d = 0;
        while (!collides(this.state.board, this.current, 0, d + 1, this.current.shape)) d++;
        if (d === 0) return null;
        return this.current.y + d;
    }

    softDrop(): void {
        if (!this.canAcceptInput() || !this.current) return;
        if (!collides(this.state.board, this.current, 0, 1, this.current.shape)) {
            this.current.y += 1;
            this.score += 1;
            this.hooks.onScoreChanged?.(this.score);
            this.tryResetLockDelay();
        }
    }

    hold(): void {
        if (!this.canAcceptInput() || !this.current || !this.canHold) return;
        this.lastSpawnCenterCol = pieceCenterOf(this.current);
        const prevHold = this.holdType;
        const prevHoldShape = this.holdShape;
        // Save the outgoing piece's identity into the hold slot. Custom
        // pieces (fate / level-editor) snapshot their shape so a later
        // swap-back restores the hand-authored geometry instead of the
        // standard tetromino shape.
        this.holdType  = this.current.type;
        this.holdShape = this.current.isCustomShape
            ? this.current.shape.map(r => r.slice())
            : null;
        if (prevHold === null) {
            this.current = spawn(this.nextType, this.lastSpawnCenterCol, this.nextBombsShape, this.nextShape, this.nextBoomsShape, this.nextWreckersShape);
            const d = this.bag.pick();
            this.nextType = d.type;
            this.nextShape = d.shape;
            this.nextBombsShape = makeEmptyBombs(this.nextShape ?? SHAPES[this.nextType]);
        this.nextBoomsShape = makeEmptyBooms(this.nextShape ?? SHAPES[this.nextType]);
        this.nextWreckersShape = makeEmptyWreckers(this.nextShape ?? SHAPES[this.nextType]);
            this.hooks.onNextChanged?.(this.nextType);
        } else {
            // Swap back from hold. Standard pieces use SHAPES[prevHold];
            // custom pieces restore their saved shape so the fate piece
            // (or level-editor custom) doesn't degrade to a vanilla
            // tetromino on the round trip.
            this.current = spawn(prevHold, this.lastSpawnCenterCol, null, prevHoldShape);
        }
        this.canHold = false;
        this.hooks.onHoldChanged?.(this.holdType);
    }

    /** Magic-item activation. Returns true if the item was consumed. */
    // ============================================================
    //  Energy picker API
    // ============================================================

    /** Open the picker with 2 fresh choices (called from `lockAndNext` when
     *  the bar fills). Idempotent — repeated calls re-roll choices. */
    private openEnergyPicker(): void {
        this.energyPicker.choices = this.rollEnergyChoices();
        this.energyPicker.active  = true;
        this.hooks.onEnergyPickerOpen?.([...this.energyPicker.choices]);
    }

    /** Roll `ENERGY_PICKER_CHOICE_COUNT` distinct items from the pool.
     *  Rule: at most ONE tier per family per picker — if `mortar5` is
     *  drawn, all other `mortar*` keys are removed from the pool before
     *  the next draw, so the player never sees "mortar ×5 vs mortar ×10"
     *  (which is just "more or less of the same thing"). The picker
     *  should give a meaningful choice between DIFFERENT items.
     *
     *  Note: 挖底机 (excavator*) and 掀顶机 (excavatorTop*) are treated
     *  as ONE family for exclusion — they're both "clear an entire
     *  horizontal slice" effects that would feel redundant paired
     *  against each other in the picker. */
    private rollEnergyChoices(): MagicItemKey[] {
        // Weighted sample with pity boost. Each item's effective weight is
        //     w_eff(k) = ITEM_BASE_PROBS[k] * (1 + streak * PITY_BOOST_PER_DRAW[rarity(k)])
        // where `streak` is the number of past picker draws that didn't
        // end in a pick. Common tier gets a 0 multiplier by convention
        // (see PITY_BOOST_PER_DRAW), so pity strictly amplifies the
        // rare / epic tail — commons don't spam harder just because
        // the player kept refreshing.
        //
        // Streak snapshot for THIS roll is taken BEFORE the increment,
        // so the very first open of a fresh GameState uses the pure
        // ITEM_BASE_PROBS distribution. Every draw (open + refresh)
        // ticks the counter; pickEnergyReward resets it to 0.
        const streak = this._pickerDrawStreak;
        const boostFor = (k: MagicItemKey): number =>
            1 + streak * PITY_BOOST_PER_DRAW[rarityForKey(k)];

        // Same family map as before — used to remove sibling tiers
        // from the pool after the first pick so a roll never surfaces
        // two hourglass tiers / two mortars / etc. in the same picker.
        const familyOf = (k: MagicItemKey): string | null => {
            if (k === 'mortar5'  || k === 'mortar10'  || k === 'mortar15')     return 'mortar';
            if (k === 'excavator1'    || k === 'excavator2'    || k === 'excavator3'
             || k === 'excavatorTop1' || k === 'excavatorTop2' || k === 'excavatorTop3') return 'excavator';
            if (k === 'hourglass1'    || k === 'hourglass2'    || k === 'hourglass3')    return 'hourglass';
            if (k === 'meteor1'       || k === 'meteor2'       || k === 'meteor3')       return 'meteor';
            if (k === 'rocket1'       || k === 'rocket2'       || k === 'rocket3')       return 'rocket';
            if (k === 'gatling1'      || k === 'gatling2'      || k === 'gatling3')      return 'gatling';
            return null;
        };

        const pool = [...ENERGY_PICKER_POOL];
        const out: MagicItemKey[] = [];
        for (let i = 0; i < ENERGY_PICKER_CHOICE_COUNT && pool.length > 0; i++) {
            // Compute total effective weight over remaining pool, then
            // roulette-scan. O(n) per pick; n ≤ 23 so ignore perf.
            let total = 0;
            for (const k of pool) total += ITEM_BASE_PROBS[k] * boostFor(k);
            let r = this.rng() * total;
            let picked: MagicItemKey = pool[pool.length - 1];   // float-slop fallback
            let pickedIdx = pool.length - 1;
            for (let j = 0; j < pool.length; j++) {
                const w = ITEM_BASE_PROBS[pool[j]] * boostFor(pool[j]);
                if (r < w) { picked = pool[j]; pickedIdx = j; break; }
                r -= w;
            }
            out.push(picked);
            pool.splice(pickedIdx, 1);
            const fam = familyOf(picked);
            if (fam) {
                for (let j = pool.length - 1; j >= 0; j--) {
                    if (familyOf(pool[j]) === fam) pool.splice(j, 1);
                }
            }
        }
        // Tick the streak AFTER using its current value — every draw
        // (opens AND refreshes) counts as one unlucky pull toward the
        // next roll's pity boost. Reset lives in pickEnergyReward.
        this._pickerDrawStreak++;
        return out;
    }

    /** Player picked one of the choices. Activates the item immediately,
     *  drains the bar, closes the picker. Returns true on success.
     *
     *  Order: close the picker UI FIRST, THEN run `useItem`. Otherwise
     *  the rocket/gatling/meteor storms (and any other item that paints
     *  a heavy effect over the playfield) start while the picker
     *  overlay is still covering the canvas — the player only sees the
     *  effect after they happen to dismiss the overlay on their own. */
    /** Post-pick delay (ms) between hiding the picker and actually
     *  firing the item's effect. Gives the popup dismiss animation +
     *  the player's eye a moment to move from the card to the tower
     *  before the item's visual FX kicks in. */
    private static readonly PICK_EXECUTE_DELAY_MS = 250;

    pickEnergyReward(key: MagicItemKey): boolean {
        if (!this.energyPicker.active) return false;
        if (!this.energyPicker.choices.includes(key)) return false;
        // Activate the item bypass-inventory: temporarily grant +1, useItem
        // consumes it back to 0. Net inventory delta = 0; effect applied.
        const before = this.inventory[key];
        this.inventory[key] = before + 1;
        // Close picker immediately so the card visibly reacts to the tap.
        // Keep `modalPaused` on so no input sneaks in during the pause
        // window between popup-close and effect-fire.
        this.energyPicker.active = false;
        this.modalPaused = true;
        this.hooks.onEnergyPickerClose?.();
        // Fire the item's effect AFTER a short delay — user feedback:
        // popup should visibly close first, then the effect plays. Without
        // the gap, close + FX overlap in the same frame and read as one
        // muddled blip.
        setTimeout(() => {
            this.modalPaused = false;
            const ok = this.useItem(key);
            if (!ok) {
                // Roll back the inventory grant — item couldn't activate
                // (e.g. rewind without enough history). Reopen picker so
                // the player can choose the other option.
                this.inventory[key] = before;
                this.energyPicker.active = true;
                this.hooks.onEnergyPickerOpen?.([...this.energyPicker.choices]);
                return;
            }
            // Drain the bar and notify the UI.
            this.energyCharge = 0;
            this.energyPicker.choices = [];
            this.hooks.onEnergyChanged?.(0, ENERGY_FULL_THRESHOLD);
            // Reset pity — the player committed to an item, so the next
            // picker opens with base ITEM_BASE_PROBS odds. Rollback path
            // above (ok === false) intentionally does NOT reset, since
            // the player didn't actually receive an item.
            this._pickerDrawStreak = 0;
            this.hooks.onEnergyPickerPicked?.(key);
        }, GameState.PICK_EXECUTE_DELAY_MS);
        // Return true optimistically — the pick has been accepted, even
        // though the effect fires on the next microtask. All existing
        // callers ignore the return value beyond a debug log.
        return true;
    }

    /** Re-roll the 2 choices without consuming the bar. The UI is expected
     *  to gate this behind a "watch ad" / "free refresh once" rule — the
     *  game state itself happily refreshes on demand. */
    refreshEnergyPicker(): void {
        if (!this.energyPicker.active) return;
        this.energyPicker.choices = this.rollEnergyChoices();
        this.hooks.onEnergyPickerOpen?.([...this.energyPicker.choices]);
    }

    useItem(key: MagicItemKey): boolean {
        if (!this.canAcceptInput()) return false;
        if (this.inventory[key] <= 0) return false;
        let consumed = false;
        switch (key) {
            case 'hourglass1':
                consumed = this.hourglass.activate(HOURGLASS_DURATIONS_MS.hourglass1);
                break;
            case 'hourglass2':
                consumed = this.hourglass.activate(HOURGLASS_DURATIONS_MS.hourglass2);
                break;
            case 'hourglass3':
                consumed = this.hourglass.activate(HOURGLASS_DURATIONS_MS.hourglass3);
                break;
            case 'excavator1':
                consumed = activateExcavator(this.state, this.computeReservedTop(), this.makeClearHooks(), false, 1);
                break;
            case 'excavator2':
                consumed = activateExcavator(this.state, this.computeReservedTop(), this.makeClearHooks(), false, 2);
                break;
            case 'excavator3':
                consumed = activateExcavator(this.state, this.computeReservedTop(), this.makeClearHooks(), false, 3);
                break;
            case 'excavatorTop1':
                consumed = activateExcavator(this.state, this.computeReservedTop(), this.makeClearHooks(), true, 1);
                break;
            case 'excavatorTop2':
                consumed = activateExcavator(this.state, this.computeReservedTop(), this.makeClearHooks(), true, 2);
                break;
            case 'excavatorTop3':
                consumed = activateExcavator(this.state, this.computeReservedTop(), this.makeClearHooks(), true, 3);
                break;
            case 'shapeshifter':
                // Always route the shape swap to the NEXT piece — never
                // yank the piece the player is actively steering. Applies
                // in every mode (endless / blind / level) for consistency.
                // Embedded next-piece props are dropped since they were
                // assigned to a different tetromino shape and would
                // misalign against the new outline.
                consumed = true;
                this.hooks.onShapeshifterRequest?.((newType: PieceType) => {
                    this.nextType          = newType;
                    this.nextShape         = null;
                    this.nextBombsShape    = makeEmptyBombs(SHAPES[newType]);
                    this.nextBoomsShape    = makeEmptyBooms(SHAPES[newType]);
                    this.nextWreckersShape = makeEmptyWreckers(SHAPES[newType]);
                    this.hooks.onNextChanged?.(this.nextType);
                });
                break;
            case 'rewind':
                consumed = this.applyRewind();
                break;
            case 'meteor1':
            case 'meteor2':
            case 'meteor3': {
                // Tier suffix picks how many DOTs rain: 5 / 10 / 15.
                const pieces = METEOR_TIER_COUNT[key];
                consumed = this.triggerMeteorFromInventory(pieces);
                break;
            }
            case 'rocket1':
            case 'rocket2':
            case 'rocket3': {
                // Same as level-prop rocket trigger: enter rocket-storm
                // mode and fire the FX hook so the renderer can launch
                // the falling rockets. Tier suffix picks 8 / 16 / 24.
                this.rocket.activate(ROCKET_TIER_COUNT[key]);
                consumed = true;
                break;
            }
            case 'gatling1':
            case 'gatling2':
            case 'gatling3': {
                // Anchor the gatling storm at the column currently
                // facing the camera so all bullets stream down the
                // centre of the screen. Tier suffix picks 4 / 8 / 12.
                // Pass current piece's Y as spawn hint so bullets appear
                // at the same on-screen height as a meteor DOT would.
                this.gatling.activate(this.lastSpawnCenterCol ?? 0, GATLING_TIER_COUNT[key], this.lastPieceSpawnY);
                consumed = true;
                break;
            }
            case 'mortar5':
            case 'mortar10':
            case 'mortar15': {
                // Compute the fill plan against a board snapshot, then
                // enter mortar-storm mode. The tier suffix (5 / 10 / 15)
                // caps the plan length — picking `mortar15` rains 15
                // drops, `mortar5` only 5. Drops rain in hail-style
                // (one per target) and stamp their colour on landing.
                // Any newly-complete rows clear on the NEXT piece lock
                // via the normal clearLines path — the engine doesn't
                // try to chain clears off a storm.
                //
                // Mortar ALWAYS consumes the item — even if the board has
                // nothing to drip onto right now (only X reserved cells,
                // empty board, etc). Returning false here would refund
                // the pick via `pickEnergyReward`'s rollback, which keeps
                // the picker pinned open while the player presses the
                // useless option over and over. Better UX: take the
                // input, drain the bar, no storm fires.
                const cap = MORTAR_TIER_COUNT[key];
                // Level mode's bottom `levelReservedHeight` rows are the
                // gray foundation — those rows may contain designer holes
                // that the mortar must NOT fill. Endless mode passes 0.
                const reserved = this.levelReservedHeight;
                // 1. Drip plan (colour-inherit-downward rule), truncated
                //    to `cap`. May be shorter than cap when few gaps
                //    qualify — that's when we top up.
                const drip = computeMortarPlan(this.state, reserved).slice(0, cap);
                let plan = drip;
                // 2. Top up with the bottom-up fill so the mortar ALWAYS
                //    delivers `cap` blocks (as long as the board has that
                //    many non-reserved empty cells). The exclude set
                //    prevents the fallback from re-targeting drip cells.
                if (plan.length < cap) {
                    const excluded = new Set<string>();
                    for (const t of drip) excluded.add(`${t.r},${t.c}`);
                    const remaining = cap - plan.length;
                    const topUp = computeMortarFallbackPlan(
                        this.state, remaining, this.rng, undefined, excluded, reserved,
                    );
                    if (topUp.length) plan = plan.concat(topUp);
                }
                if (plan.length) this.mortar.activate(plan);
                consumed = true;
                break;
            }
        }
        if (consumed) {
            consumeItem(this.inventory, key);
            this.hooks.onInventoryChanged?.(this.inventory);
            if (key === 'meteor1'  || key === 'meteor2'  || key === 'meteor3')  this.hooks.onMeteorActivated?.();
            if (key === 'rocket1'  || key === 'rocket2'  || key === 'rocket3')  this.hooks.onRocketActivated?.();
            if (key === 'gatling1' || key === 'gatling2' || key === 'gatling3') this.hooks.onGatlingActivated?.();
            if (key === 'mortar5' || key === 'mortar10' || key === 'mortar15') this.hooks.onMortarActivated?.();
            // Excavator runs synchronously and may have just cleared
            // the entire task zone. The current piece is still alive,
            // so we can't pipe through `commitPendingSpawn`'s win gate.
            // Check the win condition directly — `maybeFireLevelWin`
            // will null the piece + flip `running` if the level is done.
            if (key === 'excavator1'    || key === 'excavator2'    || key === 'excavator3'
             || key === 'excavatorTop1' || key === 'excavatorTop2' || key === 'excavatorTop3') {
                this.maybeFireLevelWin();
            }
        }
        return consumed;
    }

    // ============================================================
    //  Lock + next pipeline (the heart of the game)
    // ============================================================

    private lockAndNext(): void {
        if (!this.current) return;
        const piece = this.current;
        this.lastSpawnCenterCol = pieceCenterOf(piece);
        this.hooks.onPieceLand?.(piece);

        // DOT sifting (endless / blind only): a DOT rain piece is 1×1
        // and lands wherever gravity naturally rests it — on top of
        // the column's current stack. If the column has EMPTY cells
        // deeper down (a hole trapped under solid cells), the DOT
        // would sit on top and eventually create MORE trapped holes
        // once regular tetrominoes land above. That's fatal for the
        // trapped-hole fail check.
        //
        // Fix: DOT "sifts" like sand — before stamping, teleport
        // piece.y down to the DEEPEST empty cell in its column. This
        // both avoids creating new holes and actively fills existing
        // ones. Only applies in endless-like modes where trapped
        // holes are fatal; level mode preserves the designer's DOT
        // landing behaviour.
        if (piece.type === 'DOT' && isEndlessLike(this.mode)) {
            const col = wrap(piece.x);
            let deepestEmpty = -1;
            for (let r = this.state.board.length - 1; r >= 0; r--) {
                if (this.state.board[r][col] === null) {
                    deepestEmpty = r;
                    break;
                }
            }
            if (deepestEmpty > piece.y) {
                piece.y = deepestEmpty;
            }
        }

        // Stamp the piece onto the board. Embedded bombs go into
        // `boardBombs` and stay DORMANT until their host row fills —
        // they no longer detonate on impact.
        lock(this.state, piece);
        this.hooks.onPieceLock?.(piece);

        /** Natural clears this lock — used to gift the NEXT piece a bomb.
         *  Counted BEFORE detonate, so a col-bomb in a full row doesn't get
         *  hidden by its own column blast nulling cells. Bomb-chain
         *  cascade rows (e.g. row2 bomb splicing an extra row) don't count
         *  — the user wants the reward to come from skill, not feedback loop. */
        let naturalClearsThisLock = this.countFullRows();
        // Endless mode: the gray foundation (initial 4 X-rows + anything
        // converted on previous locks) registers as "full" in
        // `countFullRows`. Subtract that baseline so score, energy and
        // chest progress only react to NEW colored rows that just
        // became full this lock. Blind mode uses the same stacking
        // mechanics as endless — apply the same baseline correction.
        if (isEndlessLike(this.mode)) {
            let alreadyGray = 0;
            const b = this.state.board;
            for (let r = 0; r < b.length; r++) {
                if (b[r].every(v => v === 'X')) alreadyGray++;
            }
            naturalClearsThisLock = Math.max(0, naturalClearsThisLock - alreadyGray);
        }
        // Notify renderer of the pre-detonate natural clear count so
        // it can play mode-agnostic "big clear" FX (screen shake for
        // ≥ 3-row clears is wired in GameController). Fired before
        // any bomb-triggered splice so cascade rows don't double-count.
        if (naturalClearsThisLock >= 1) {
            this.hooks.onNaturalRowClears?.(naturalClearsThisLock);
        }

        // Gather BOTH bomb seeds AND boom seeds against the same pre-trigger
        // snapshot — otherwise a boom's diamond may erase the host cell of
        // an adjacent bomb before the bomb-side scan runs, and the bomb
        // never fires. Adjacency rules:
        //   - bomb seed:  host row full, OR 4-neighbour carries a prop
        //     (bomb OR boom)
        //   - boom seed:  4-neighbour carries a prop (bomb OR boom)
        // gatherLevelBombs scans full rows and returns EVERY bomb on
        // them — including box3 if the bomb_block piece happens to
        // complete a row on lock. That would fire the box3 detonate
        // TWICE: once here (immediate) and once via
        // pendingBox3Detonations 500 ms later. Filter box3 out so
        // the pending path stays the single source of truth for
        // box3 timing.
        const fullRowSeeds  = gatherLevelBombs(this.state).filter(s => s.kind !== 'box3');
        // Same filter for adjacent bombs — a box3 next to another
        // prop shouldn't skip its ramp-up window either.
        const adjacentSeeds = gatherAdjacentBombs(this.state).filter(s => s.kind !== 'box3');
        const adjBooms      = gatherAdjacentBooms(this.state);
        // Backpack `bomb_block` card: box3 area bomb has two paths:
        //   • Normal lock       → push to pendingBox3Detonations, wait
        //                         BOX3_ARM_DURATION_MS while the cube
        //                         plays a red-pulse ramp-up animation,
        //                         THEN detonate via tick().
        //   • Filled full row   → fire IMMEDIATELY as part of this
        //                         lock's detonate. Otherwise the
        //                         natural row-clear (via clearLines
        //                         below) splices the bomb cell away
        //                         before the pending timer expires,
        //                         and the alive-check in
        //                         _drainPendingBox3Detonations
        //                         silently drops it → player sees
        //                         row clear but no bomb explosion.
        //                         Immediate path skips the ramp-up
        //                         (the row-clear visual already
        //                         signals "big thing happening").
        const box3Seeds = this._gatherJustLockedBox3s(piece);
        const immediateBox3Seeds: typeof box3Seeds = [];
        // Helper: has any 4-neighbour got a bomb / boom / wrecker
        // prop on it? Same predicate gatherAdjacentBombs uses to
        // decide "chain me now". We roll our own here to avoid
        // touching PieceOps signatures.
        const has4NbrProp = (r: number, c: number): boolean => {
            const H = this.state.board.length;
            const W = this.state.board[0].length;
            const wrap = (x: number) => ((x % W) + W) % W;
            const nbs: Array<[number, number]> = [
                [r - 1, c], [r + 1, c], [r, wrap(c - 1)], [r, wrap(c + 1)],
            ];
            for (const [nr, nc] of nbs) {
                if (nr < 0 || nr >= H) continue;
                if (this.state.boardBombs?.[nr]?.[nc]) return true;
                if (this.state.boardBooms?.[nr]?.[nc]) return true;
                if (this.state.boardWreckers?.[nr]?.[nc]) return true;
            }
            return false;
        };
        for (const s of box3Seeds) {
            // Fire immediately if EITHER:
            //   (a) the host row is currently full — natural clearLines
            //       would splice the bomb away before the 500ms timer,
            //       leaving pending's alive-check to silently drop it.
            //   (b) a 4-neighbour has a prop that gatherAdjacentBombs
            //       will chain-fire this same tick — if that neighbour's
            //       blast punches OUR row or column, ditto.
            // In both cases the ramp-up would be swallowed / lost, so
            // fire alongside the other detonations on this same lock.
            let rowFull = true;
            for (let cc = 0; cc < COLS; cc++) {
                const v = this.state.board[s.r][cc];
                if (v === null || v === 'H') { rowFull = false; break; }
            }
            if (rowFull || has4NbrProp(s.r, s.c)) {
                immediateBox3Seeds.push(s);
            } else {
                this.pendingBox3Detonations.push({
                    r: s.r, c: s.c, kind: s.kind,
                    startTimeMs: (this.clock ? this.clock.now() : Date.now()),
                });
            }
        }
        // Snapshot adjacent wreckers BEFORE the boom firing loop. The
        // boom side's diamond will wipe `boardBooms` and may clear the
        // wrecker's neighbour cells, so by the time the wrecker tried
        // to find an adjacent prop on its own, the live board would
        // already be empty and the combo wouldn't fire.
        const adjWreckers   = gatherAdjacentWreckers(this.state);
        // Delayed box3 is NOT in `seeds`; immediate box3 IS.
        const seeds = fullRowSeeds.concat(adjacentSeeds).concat(immediateBox3Seeds);

        // Snapshot every wrecker's adjacent boom level + bomb axis BEFORE
        // the booms detonate (the next block wipes them from `boardBooms`).
        // Without this cache the wrecker × boom / wrecker × bomb combo
        // would silently degrade to a plain sweep.
        this.captureWreckerBoomCombos();

        // Fire adjacent booms first so their diamond clears feed the
        // orphan-chain that processClearedBooms runs at the end of
        // detonate / clearLines — but seeds for the parallel bomb chain
        // were already snapshotted above, so erasing cells here doesn't
        // hide them from the detonate pass below. Effect: both visuals
        // (boom rainbow ripple + bomb row/col blast) fire on the same
        // frame and visually stack.
        if (adjBooms.length) {
            const fire = (r: number, c: number, level: 1 | 2 | 3,
                          cleared: Array<{ r: number; c: number }>) =>
                this.hooks.onBoomTriggered?.(r, c, level, cleared);
            for (const { r, c, level } of adjBooms) {
                // Re-check — chain activations may have already wiped this.
                const stillThere = this.state.boardBooms
                    && this.state.boardBooms[r] && this.state.boardBooms[r][c];
                if (!stillThere) continue;
                this.state.boardBooms![r][c] = null;
                const cleared = activateBoom(this.state, r, c, level);
                fire(r, c, level, cleared);
            }
            processClearedBooms(this.state, { onBoomActivated: fire });
        }

        // Fire every wrecker that the pre-boom scan marked. The cache
        // lookups inside `triggerWreckerFromBoard` resolve to the
        // pre-detonate boom level / bomb axis, so every pick still
        // gets the combo blast even though the neighbour prop has
        // since been wiped.
        //
        // NOTE: this MUST run BEFORE the boom-side gravity below —
        // gravity moves the wrecker prop layer along with its host
        // cell, so a wrecker whose host got cleared by the boom's
        // diamond ends up at a NEW (r, c) after gravity. Firing here
        // uses the original coordinates captured in `adjWreckers`.
        for (const { r, c } of adjWreckers) {
            const stillThere = this.state.boardWreckers
                && this.state.boardWreckers[r] && this.state.boardWreckers[r][c];
            if (!stillThere) continue;
            this.state.boardWreckers![r][c] = null;
            this.triggerWreckerFromBoard(r, c);
        }

        if (adjBooms.length) {
            // Apply gravity NOW that wreckers have finished firing.
            // Cubes above the just-cleared boom diamond fall down;
            // without this the downstream clearLines /
            // convertCompleteRowsToGray path skips gravity whenever
            // there are no full rows.
            //
            // Pass state.board.length instead of the real reservedTop
            // so falling cells drop THROUGH any holes the boom
            // punched into the gray foundation and settle at the
            // true bottom of the column. Surviving 'X' cells still
            // act as obstacles.
            const fellMoves = applyDiagonalGravity(this.state, this.state.board.length);
            if (fellMoves.length) this.hooks.onCellsFell?.(fellMoves);
        }

        if (seeds.length) {
            detonateBombs(this.state, seeds, this.computeReservedTop(), this.makeDetonateHooks());
        }

        // Collect-mode pre-snapshot: capture per-goal colour counts BEFORE
        // the level pipeline (clearLines + reserved-zone conversion). The
        // diff against the post-snapshot tells us how many cells of each
        // goal colour the player just cleared, which feeds collectProgress.
        const collectPreCounts: Partial<Record<PieceType, number>> =
            this.mode === 'collect' ? this.countGoalColours() : {};

        if (this.mode === 'level' || this.mode === 'collect') {
            // clearLines splices any rows that are STILL full (i.e. weren't
            // already spliced by detonate's row-bomb path, and survived col
            // blasts because the col-blast loop skips currently-full rows).
            const result = clearLines(this.state, this.computeReservedTop(), this.makeClearHooks());
            this._lastClearLinesFullyCleared = result.fullyCleared;
            convertReservedZoneToGray(this.state, this.levelReservedHeight);
            // Score + lines for level mode. Use the pre-detonate full count
            // so col-bomb-host rows count even though detonate spliced them.
            if (naturalClearsThisLock > 0) {
                const pts = [0, 100, 300, 500, 800][Math.min(naturalClearsThisLock, 4)] * this.level;
                this.score += pts;
                this.lines += naturalClearsThisLock;
                this.hooks.onScoreChanged?.(this.score);
                this.hooks.onLinesChanged?.(this.lines);
            }
            // Chest progress — driven by the pre-detonate natural-clear count.
            const chests = this.levelProgress.consume(naturalClearsThisLock);
            for (let i = 0; i < chests; i++) this.grantOneChest();
            // Collect-mode post-snapshot: diff against pre to credit the
            // player for cells of goal colours that disappeared during
            // the lock pipeline (clearLines / detonate / boom).
            if (this.mode === 'collect') {
                const post = this.countGoalColours();
                let advanced = false;
                for (const g of this.collectGoals) {
                    const before = collectPreCounts[g.color] ?? 0;
                    const after  = post[g.color] ?? 0;
                    const delta  = before - after;
                    if (delta > 0) {
                        const prev = this.collectProgress[g.color] ?? 0;
                        this.collectProgress[g.color] = Math.min(g.count, prev + delta);
                        advanced = true;
                    }
                }
                if (advanced) {
                    this.hooks.onCollectProgress?.(this.collectProgress, this.collectGoals);
                }
                // Win when every goal has been hit.
                if (this.collectGoals.every(g =>
                    (this.collectProgress[g.color] ?? 0) >= g.count
                )) {
                    this.running = false;
                    this.current = null;
                    this.hooks.onLevelWin?.();
                    return;
                }
            } else {
                // Standard level mode — original win check (clear task zone).
                if (checkLevelWin(this.state, this.levelReservedHeight)) {
                    this.running = false;
                    // Clear the locked-piece reference — `playerLock` would
                    // normally call `spawnNext()` at its tail and overwrite
                    // `current`, but we're returning early on the win path.
                    // Without this, the renderer still draws the just-locked
                    // piece's shape ON TOP of the X cells that absorbed it,
                    // making the stack look one row taller than it is.
                    this.current = null;
                    this.hooks.onLevelWin?.();
                    return;
                }
            }
            // Top-out: any brick at row 0 ⇒ pieces can't spawn, fail.
            if (checkLevelTooTall(this.state,
                    this.levelTaskHeight + this.levelReservedHeight)) {
                this.failGame(2);
                return;
            }
        } else {
            // Endless / blind mode branch (both use trapped-hole + stack-
            // too-tall failure model rather than the level-completion model).
            // Both modes now fire per-row `onPartialShatter` for the
            // freshly-filled colored content, giving the same rainbow-
            // flash "row cleared" FX level mode has (via `clearLines`).
            //   - Blind: the row is then peeled, so the flash reads as
            //     "row cleared and gone" (classic tetris feel).
            //   - Endless: the row stays as gray after the flash — the
            //     shatter animates the "just filled" moment before the
            //     cells settle into the gray foundation. Was skipped
            //     earlier out of concern about a strobe artefact; user
            //     wants the visual cue back for mortar-filled rows too.
            const filled = convertCompleteRowsToGray(
                this.state,
                (r, content) => this.hooks.onPartialShatter?.(r, content),
            );
            // `onEndlessRowsFilled` used to play `line_clear` once per
            // lock as a fallback for modes without shatter. Now shatter
            // fires for BOTH endless and blind and it plays `line_clear`
            // itself per row — suppress this hook entirely to avoid
            // double-audio. Kept in the hook interface for potential
            // future modes.
            void filled;
            // (naturalClearsThisLock was already captured before detonate; in
            // endless that equals `filled` plus any rows the col-blast skip
            // logic preserved. It's the correct figure for the bomb reward.)
            // Blind mode: keep the gray count locked at 0 — peel any
            // freshly-converted grays right after the conversion, before
            // the failure checks run against the new (shorter) stack.
            // Used to hold a 4-row foundation as the anchor; foundation
            // was removed per UX request, so the target is now 0 and
            // completed rows disappear Tetris-style with the stack
            // above collapsing down.
            if (this.mode === 'blind') {
                peelGrayAboveFoundation(this.state, 0);
            }
            if (checkTrappedHole(this.state)) {
                this.failGame(1);
                return;
            }
            // Was: `checkStackTooTall` (height-line fail model). Removed
            // in favour of the spawn-collision model — the game now
            // fails at the moment a fresh piece is spawned and overlaps
            // the tower. Trigger lives in GameController.realignPieceSpawnRow,
            // which calls back into `spawnCollisionFail()` after
            // positioning the new piece.
            // Endless grows the board on demand + caps gray at
            // ENDLESS_GRAY_CAP. Blind mode does neither — its 4-row
            // foundation stays and its board size is fixed.
            if (this.mode !== 'blind') {
                const rowsAdded = manageEndlessBoard(this.state);
                if (rowsAdded > 0 && this.current) this.current.y += rowsAdded;
            }
            const chests = this.endlessProgress.consume(filled);
            // Blind mode grants NO items — inventory picker is disabled
            // (energy pipeline off in `lockAndNext`, no picker UI), so
            // handing out chest items would just pile them up unused.
            if (this.mode !== 'blind') {
                for (let i = 0; i < chests; i++) this.grantOneChest();
            }
            // Fate-piece modal cadence: FIRST popup fires at layer
            // ENDLESS_FATE_MILESTONE + 1 (14 at the default value 13),
            // then every ENDLESS_FATE_MILESTONE layers after that —
            // so 14, 27, 40, 53… The `cumulative - 1` shift turns the
            // "N-row spacing starting at 1" into the floor-div form.
            // Defer through the FX gate so the modal doesn't pop over
            // still-playing shatter / ribbon FX.
            const cum = this.endlessProgress.cumulative;
            // Endless speed ramp: every ENDLESS_FATE_MILESTONE (12) layers,
            // drop speed +0.1× (i.e. dropInterval / (1 + 0.1 × N)), capped at
            // 8.0× (dropInterval reduced to an eighth). Blind mode also gets
            // the ramp because its scoring/pace is the same as endless.
            // Level mode is untouched — it has its own per-level tuning.
            const naturalMult = Math.min(8.0, 1.0 + Math.floor(cum / ENDLESS_FATE_MILESTONE) * 0.1);
            const speedMult = this.debugSpeedMultOverride ?? naturalMult;
            this.dropInterval = BASE_DROP_INTERVAL_MS / speedMult;
            const milestones = cum > 0
                ? Math.floor((cum - 1) / ENDLESS_FATE_MILESTONE)
                : 0;
            // Blind mode explicitly skips the fate modal — the player
            // asked for a no-frills stacking mode: no fate piece, no
            // embed props, tower hidden.
            if (milestones > this.endlessFateMilestonesPopped
                && this.mode !== 'blind') {
                this.endlessFateMilestonesPopped = milestones;
                this.pendingFateModal = true;
            }
            // Layer celebration FX — fires EVERY layer (endless +
            // blind). A single lock that clears N rows fires the hook
            // ONCE with the new `cum`, not N times, to avoid stacking
            // multiple text-pops on top of each other. The `milestone`
            // param carries the new layer count; text uses it verbatim.
            if (cum > this.endlessCelebrationsFired) {
                this.endlessCelebrationsFired = cum;
                this.hooks.onEndlessMilestone?.(cum, cum);
            }
        }

        // Charge the energy bar (caps at threshold; overflow rolls into next
        // cycle after the picker consumes the current charge).
        //
        // Blind mode SKIPS the energy pipeline entirely — no bar, no
        // picker, no magic items. It's a pure stacking challenge.
        // Tutorial also skips — the practice tower shouldn't gift the
        // player items or pop the picker mid-demo.
        if (naturalClearsThisLock > 0 && this.mode !== 'blind' && !this.tutorialActive) {
            this.energyCharge = Math.min(
                ENERGY_FULL_THRESHOLD,
                this.energyCharge + naturalClearsThisLock,
            );
            this.hooks.onEnergyChanged?.(this.energyCharge, ENERGY_FULL_THRESHOLD);
            // Bar is full — queue the picker open behind the FX gate.
            // GameController polls `hasPendingPickerOpen()` and calls
            // `commitPendingPickerOpen()` once shatter shards / row
            // flash / ribbon FX have all settled. Without the defer,
            // the popup would cover the canvas while the locked piece's
            // stamped cells (which are still at the top until clearLines
            // runs gravity) are visible — looks like a fresh spawn.
            if (this.energyCharge >= ENERGY_FULL_THRESHOLD && !this.energyPicker.active) {
                this.pendingPickerOpen = true;
            }
        }

        // Reward natural clears: the NEXT piece gets a RANDOM magic prop
        // (direction blast row*/col*, range blast boom1/2/3, or rare
        // wrecker). Probabilities are tier-weighted by total rows
        // cleared so multi-row clears push toward higher tiers.
        //
        // Endless mode SKIPS this reward — the embed-prop pipeline is
        // a level/collect mechanic. Endless is the long-haul stacking
        // mode, and the player explicitly asked that no embed props
        // spawn there. Energy-bar magic items are the only prop source
        // in endless.
        //
        // Meteor-shower handling: while the queued next piece is still
        // a DOT (shower not over), accumulate the row count silently.
        // Then on the FIRST lock where `nextType !== 'DOT'` (the LAST
        // DOT of the shower, or any normal piece), inject using
        // `this lock's clears + accumulator`. This way DOT clears
        // earlier in the shower aren't wasted just because the host
        // Embed reward only fires on a FULL 24-column row clear.
        // Explicit design call (2026-09-13):
        //   - Row/col directional-bomb firings alone do NOT count —
        //     the bomb wipes cells but the row isn't a "true" clear.
        //   - Boom / wrecker firings alone also do NOT count.
        //   - Only a naturally-full row (piece-placement filled every
        //     column) triggers the next-piece embed drop.
        // Rationale: bombs would otherwise chain-grant props every
        // time they fire and the piece pool would drown in props.
        const clearsForTier = Math.max(
            naturalClearsThisLock,
            this.mode === 'level' || this.mode === 'collect'
                ? (this._lastClearLinesFullyCleared ?? 0)
                : 0,
        );

        if (isEndlessLike(this.mode) || this.tutorialActive) {
            // Endless / blind / tutorial all skip the embed-prop reward.
            // Endless is a long-haul stacking mode; blind is minimal;
            // tutorial doesn't want random props popping onto the next
            // piece and confusing the demonstration.
            this.meteorAccumulatedClears = 0;
        } else if (this.nextType === 'DOT') {
            this.meteorAccumulatedClears += clearsForTier;
        } else {
            const effectiveRowsCleared = clearsForTier + this.meteorAccumulatedClears;
            if (effectiveRowsCleared >= 1) {
                const shape = this.nextShape ?? SHAPES[this.nextType];
                // Preserve any box3 tags on the queued next piece BEFORE
                // injectRandomMagicProp runs — it writes to
                // nextBombsShape and would overwrite our 'box3' with a
                // random 'row1' / 'col2' / etc, destroying the bomb-
                // card effect. After the inject, we walk the cells:
                //   • cell was box3 AND inject wrote a directional
                //     bomb   → migrate that bomb to a boom of matching
                //             tier (nextBoomsShape[r][c] = tier), then
                //             restore box3 in bombsShape. Result: cell
                //             now carries BOTH box3 (dark-red pulse
                //             piece) AND a boom icon overlay.
                //   • cell was box3 AND inject wrote to boomsShape or
                //     wreckersShape → those grids don't overlap with
                //     bombsShape, so nothing to restore. Coexistence
                //     is automatic.
                //   • cell was box3 AND inject did nothing here → no
                //     change.
                const box3Cells: Array<{ r: number; c: number }> = [];
                for (let r = 0; r < this.nextBombsShape.length; r++) {
                    const row = this.nextBombsShape[r];
                    if (!row) continue;
                    for (let c = 0; c < row.length; c++) {
                        if (row[c] === 'box3') box3Cells.push({ r, c });
                    }
                }
                injectRandomMagicProp(
                    this.nextBombsShape,
                    this.nextBoomsShape,
                    shape,
                    effectiveRowsCleared,
                    this.rng,
                    this.nextWreckersShape,
                );
                for (const { r, c } of box3Cells) {
                    const injected = this.nextBombsShape[r]?.[c];
                    if (injected !== 'box3') {
                        // inject wrote a directional bomb over the box3.
                        // Migrate to a boom of matching tier so both effects
                        // land on this cell.
                        if (injected && /^(row|col)([1-3])$/.test(injected as string)) {
                            const tier = parseInt((injected as string).slice(-1), 10) as 1 | 2 | 3;
                            if (this.nextBoomsShape[r]) {
                                this.nextBoomsShape[r][c] = tier as BoomLevel;
                            }
                        }
                        // Restore box3 either way — inject that wasn't a
                        // directional bomb (e.g. nothing) still needs the
                        // box3 tag back.
                        if (this.nextBombsShape[r]) {
                            this.nextBombsShape[r][c] = 'box3' as BombKind;
                        }
                    }
                }
                // Hand the renderer the updated "next" preview so the prop glyph shows.
                this.hooks.onNextChanged?.(this.nextType);
            }
            this.meteorAccumulatedClears = 0;
        }
        // Reset the clearLines counter so a subsequent lock that skips
        // clearLines (e.g. because seeds spliced all full rows) can't
        // reuse a stale value.
        this._lastClearLinesFullyCleared = 0;

        this.canHold = true;
        // Push a rewind snapshot AFTER all post-lock processing settled.
        this.history.snapshot({
            state: this.state, score: this.score, lines: this.lines,
            level: this.level, towerHeight: this.towerHeight,
        });

        // Hail life ticks down on every normal piece lock.
        if (!this.hail.mode) {
            this.hail.tickLifeOnPieceLock(this.state, { onEvaporate: () => {/* hooks left for renderer */} });
        }
        // Blizzard release counter: each piece-lock consumes one tick of
        // the active blizzard window. When it hits 0 the drag input
        // returns to normal continuous-rotation mode.
        this.blizzard.onPieceLock();
        // Hail / rocket / gatling / mortar storms freeze spawn — they'll
        // call onFinish themselves to resume normal play when their
        // animations complete.
        if (this.hail.mode || this.rocket.mode || this.gatling.mode || this.mortar.mode) {
            this.current = null;
            return;
        }
        // Defer the actual spawn until every active FX has played
        // through. GameController polls `hasPendingSpawn()` each frame
        // and calls `commitPendingSpawn()` once the scene is quiet.
        this.current = null;
        this.pendingSpawn = true;
    }

    // ============================================================
    //  Helpers
    // ============================================================

    private canAcceptInput(): boolean {
        return this.running && !this.paused && !this.gameOver && !this.modalPaused;
    }

    private tryResetLockDelay(): void {
        if (!this.isGrounded) return;
        if (this.lockResets >= LOCK_RESET_LIMIT) return;
        this.lockResets++;
        this.lockDelay = LOCK_DELAY_MS;
    }

    private computeReservedTop(): number {
        if (this.mode === 'level' && this.levelReservedHeight > 0) {
            return this.state.board.length - this.levelReservedHeight;
        }
        return this.state.board.length;
    }

    /** Number of rows currently fully filled (24 colored cells, no nulls,
     *  no hail). Used to capture "natural" clears at lock time, BEFORE
     *  detonate can hide them by clearing column cells. */
    /** Scan the live board and count cells of each goal colour. Returns
     *  a sparse map (colours not in `collectGoals` are absent). Used by
     *  the collect-mode pipeline to diff cell counts before/after a
     *  lock and credit the player for cleared cells. */
    private countGoalColours(): Partial<Record<PieceType, number>> {
        const out: Partial<Record<PieceType, number>> = {};
        if (!this.collectGoals.length) return out;
        const wanted = new Set<PieceType>(this.collectGoals.map(g => g.color));
        const board = this.state.board;
        for (let r = 0; r < board.length; r++) {
            for (let c = 0; c < COLS; c++) {
                const v = board[r][c];
                if (v && wanted.has(v as PieceType)) {
                    out[v as PieceType] = (out[v as PieceType] ?? 0) + 1;
                }
            }
        }
        return out;
    }

    private countFullRows(): number {
        let count = 0;
        const board = this.state.board;
        // Scan the WHOLE board (including the reserved zone). When the
        // player fills the gap in a reserved row, that row becomes 24/24
        // (23 X + 1 colored) and should count toward score / energy /
        // chest progress / embed-prop reward — just like a regular row
        // clear in the task zone. Endless mode subtracts the pre-existing
        // all-X gray foundation downstream (see `naturalClearsThisLock`
        // adjustment in lockAndNext).
        for (let r = 0; r < board.length; r++) {
            let full = true;
            for (let c = 0; c < COLS; c++) {
                const v = board[r][c];
                if (v === null || v === 'H') { full = false; break; }
            }
            if (full) count++;
        }
        return count;
    }

    /** Public entry-point for GameController's spawn-collision check.
     *  After `realignPieceSpawnRow` positions a freshly-spawned piece,
     *  the controller tests `collides(...)` — if the piece overlaps a
     *  filled tower cell at its spawn row, it calls this to end the
     *  run with the "stack too tall" (reason 2) fail state. */
    public spawnCollisionFail(): void {
        if (this.gameOver) return;
        this.failGame(2);
    }

    private failGame(reason: FailureReason): void {
        // Tutorial mode disables ALL fail conditions — the practice
        // tower is small and the player is free to explore without
        // punishment. If they stack too tall / trap a hole during
        // demos, nothing happens.
        if (this.tutorialActive) return;
        this.failureReason = reason;
        this.gameOver = true;
        this.running = false;
        this.hooks.onGameOver?.(reason);
    }

    /** Endless / blind revive — called after the rewarded ad completes
     *  OR after the gems purchase succeeds. Wipes every colored (piece
     *  origin) cell across the whole board — the tower resets to its
     *  bare foundation ('X' gray + 'H' hail cells stay) so the player
     *  gets a clean slate. Cumulative score / height / inventory are
     *  all preserved. Returns true if the revive actually ran; false
     *  if it was rejected (already revived this run, or not currently
     *  in a game-over state).
     *
     *  The `_clearRows` argument is kept for API stability but is
     *  ignored — the revive is now full-board.
     *
     *  The result panel is NOT dismissed here — the caller is expected
     *  to do that (via MenuController). */
    public reviveEndless(_clearRows: number = 5): boolean {
        if (!this.gameOver) return false;
        if (this.endlessReviveUsed) return false;
        // Level mode has its own retry flow — revive is endless / blind
        // only. Cheap defence-in-depth against a caller wiring the
        // button in the wrong mode.
        if (this.mode !== 'endless' && this.mode !== 'blind') return false;
        this.endlessReviveUsed = true;
        // ---- Full colored-cell wipe. Iterate every cell; null out
        //      anything that came from a piece (isColoredCell). Leave
        //      'X' (gray foundation, endless has none but blind might)
        //      and 'H' (hail) in place — hail is part of the level
        //      mechanic, not the player's tower.
        //      Every parallel prop layer is cleared too so bombs /
        //      booms / wreckers / chest markers etc. don't get left
        //      floating on empty cells after the wipe.
        const H = this.state.board.length;
        for (let r = 0; r < H; r++) {
            for (let c = 0; c < COLS; c++) {
                if (!isColoredCell(this.state.board[r][c])) continue;
                this.state.board[r][c] = null;
                if (this.state.boardBombs    && this.state.boardBombs[r])    this.state.boardBombs[r][c]    = null;
                if (this.state.boardBooms    && this.state.boardBooms[r])    this.state.boardBooms[r][c]    = null;
                if (this.state.boardWreckers && this.state.boardWreckers[r]) this.state.boardWreckers[r][c] = null;
                if (this.state.boardStones   && this.state.boardStones[r])   this.state.boardStones[r][c]   = null;
                if (this.state.boardChests   && this.state.boardChests[r])   this.state.boardChests[r][c]   = null;
                if (this.state.boardMeteors  && this.state.boardMeteors[r])  this.state.boardMeteors[r][c]  = null;
                if (this.state.boardBlizzards&& this.state.boardBlizzards[r])this.state.boardBlizzards[r][c]= null;
                if (this.state.boardHails    && this.state.boardHails[r])    this.state.boardHails[r][c]    = null;
                if (this.state.boardRockets  && this.state.boardRockets[r])  this.state.boardRockets[r][c]  = null;
                if (this.state.boardGatlings && this.state.boardGatlings[r]) this.state.boardGatlings[r][c] = null;
            }
        }
        // Drop any survivors that lost support. Pass state.board.length
        // as reservedTop so gravity uses the true bottom (endless has
        // no reserved zone anyway, but keeps this defensive).
        applyDiagonalGravity(this.state, this.state.board.length);
        // Reset the failure state so the tick loop resumes.
        this.gameOver      = false;
        this.failureReason = null;
        this.paused        = false;
        this.running       = true;
        // Kill any in-flight lock delay so the next tick starts clean.
        this.isGrounded = false;
        this.lockDelay  = 0;
        this.lockResets = 0;
        // Spawn a fresh piece — the one that killed the player is gone,
        // and the next-piece queue rolls forward naturally. Piece uses
        // the same spawn helper as the normal pipeline (spawnCollisionFail
        // will still trigger if the new piece STILL can't fit, but with
        // 5 rows cleared that's extremely unlikely).
        this.current = spawn(this.nextType, this.lastSpawnCenterCol, this.nextBombsShape, this.nextShape, this.nextBoomsShape, this.nextWreckersShape);
        const d = this.bag.pick();
        this.nextType          = d.type;
        this.nextShape         = d.shape;
        this.nextBombsShape    = makeEmptyBombs(this.nextShape ?? SHAPES[this.nextType]);
        this.nextBoomsShape    = makeEmptyBooms(this.nextShape ?? SHAPES[this.nextType]);
        this.nextWreckersShape = makeEmptyWreckers(this.nextShape ?? SHAPES[this.nextType]);
        this.hooks.onNextChanged?.(this.nextType);
        return true;
    }

    private grantOneChest(): void {
        const k = grantRandomItem(this.inventory, this.rng);
        if (k) {
            this.hooks.onItemGranted?.(k);
            this.hooks.onInventoryChanged?.(this.inventory);
        }
    }

    private applyRewind(): boolean {
        const out = this.history.activate(this.state);
        if (!out) return false;
        this.score = out.score;
        this.lines = out.lines;
        this.level = out.level;
        this.towerHeight = out.towerHeight;
        // Respawn a fresh piece so the player has something to play with.
        this.current = spawn(this.nextType, this.lastSpawnCenterCol, this.nextBombsShape, this.nextShape, this.nextBoomsShape, this.nextWreckersShape);
        const d = this.bag.pick();
        this.nextType = d.type;
        this.nextShape = d.shape;
        this.nextBombsShape = makeEmptyBombs(this.nextShape ?? SHAPES[this.nextType]);
        this.nextBoomsShape = makeEmptyBooms(this.nextShape ?? SHAPES[this.nextType]);
        this.nextWreckersShape = makeEmptyWreckers(this.nextShape ?? SHAPES[this.nextType]);
        this.hooks.onScoreChanged?.(this.score);
        this.hooks.onLinesChanged?.(this.lines);
        this.hooks.onNextChanged?.(this.nextType);
        return true;
    }

    private triggerMeteorFromInventory(pieces: number = METEOR_PIECES): boolean {
        return activateMeteor(this.bag, {
            pieces,
            swapCurrent: true,
            onSwapLivePiece: () => {
                if (!this.current) return false;
                const center = pieceCenterOf(this.current);
                const newShape = SHAPES.DOT.map(r => r.slice());
                this.current.type  = 'DOT';
                this.current.shape = newShape;
                this.current.bombs    = makeEmptyBombs(newShape);
                this.current.booms    = makeEmptyBooms(newShape);
                this.current.wreckers = makeEmptyWreckers(newShape);
                this.current.x = wrap(Math.round(center - 0.5));
                // Drift up if the new dot would collide where current.y sits.
                for (let dy = 0; dy >= -4; dy--) {
                    if (!collides(this.state.board, this.current, 0, dy, newShape)) {
                        this.current.y += dy;
                        break;
                    }
                }
                return true;
            },
            onOverrideNextType: () => {
                this.nextType = 'DOT';
                this.nextShape = null;   // DOT uses the standard SHAPES.DOT
                this.nextBombsShape = makeEmptyBombs(SHAPES.DOT);
                this.nextBoomsShape = makeEmptyBooms(SHAPES.DOT);
                this.nextWreckersShape = makeEmptyWreckers(SHAPES.DOT);
                this.hooks.onNextChanged?.(this.nextType);
            },
        });
    }

    // ---------- Hook factories ----------

    private makeClearHooks(): ClearLinesHooks {
        return {
            onChestTriggered:    () => this.grantOneChest(),
            onMeteorTriggered:   () => this.triggerMeteorFromBoard(),
            onBlizzardTriggered: () => { this.blizzard.activate(); this.hooks.onBlizzardActivated?.(); },
            onWreckerTriggered:  (r, c) => this.triggerWreckerFromBoard(r, c),
            onHailTriggered:     () => { this.hail.activate(); this.hooks.onHailActivated?.(); },
            onRocketTriggered:   () => { this.rocket.activate(); this.hooks.onRocketActivated?.(); },
            onGatlingTriggered:  () => {
                // Anchor the storm at the column currently facing the
                // camera so all 12 bullets fire straight down the centre
                // of the screen — and stay there even if the player
                // rotates the tower mid-storm.
                // Pass current piece's Y so bullets spawn at the same
                // on-screen height as a meteor DOT.
                this.gatling.activate(
                    this.lastSpawnCenterCol ?? 0,
                    undefined,
                    this.lastPieceSpawnY,
                );
                this.hooks.onGatlingActivated?.();
            },
            onBoomTriggered:     (r, c, level, cleared) =>
                this.hooks.onBoomTriggered?.(r, c, level, cleared),
            onPartialShatter:    (r, content) => this.hooks.onPartialShatter?.(r, content),
            onCellsFell:         moves => this.hooks.onCellsFell?.(moves),
            // Forwarded — ClearLines/Detonate paths don't know the
            // wrecker's source cell, so pass -1 sentinels to signal
            // "no projectile phase, just run the immediate pulse".
            onWreckerPrePulse:   picks => this.hooks.onWreckerPrePulse?.(-1, -1, picks),
            onWreckerPicksShatter: picks => this.hooks.onWreckerPicksShatter?.(picks),
            onClearSound:        intensity => this.hooks.onClearSound?.(intensity),
        };
    }

    /** Same as `makeClearHooks` but also forwards bomb-specific FX hooks
     *  (used by detonateBombs to fire row/col detonation visuals). */
    private makeDetonateHooks(): DetonateHooks {
        return {
            ...this.makeClearHooks(),
            onRowBombDetonate: (r, tier) => this.hooks.onRowBombDetonate?.(r, tier),
            onColBombDetonate: (r, c, tier) => this.hooks.onColBombDetonate?.(r, c, tier),
            onBoxBombDetonate: (r, c, isAnchor) =>
                this.hooks.onBoxBombDetonate?.(r, c, isAnchor),
        };
    }

    private makeStormHooks(): DetonateHooks & { onFinish?(): void } {
        // Extend `makeDetonateHooks` instead of `makeClearHooks` — the
        // rocket / gatling bullet "1:1 cancel" path now routes any
        // directional bomb it hits through `detonateBombs`, and the
        // row/col blast visuals need `onRowBombDetonate` /
        // `onColBombDetonate` to fire. Without these the block gets
        // cleared silently and the player sees no blast FX.
        return {
            ...this.makeDetonateHooks(),
            onFinish: () => {
                // Storm finished — queue the spawn behind any still-
                // playing FX (smoke trails, shatter dust, etc.). If the
                // current piece is still alive (mortar fired via the
                // picker while a piece was mid-fall), DON'T queue a
                // spawn — let the existing piece resume playing.
                if (!this.hail.mode && !this.rocket.mode && !this.gatling.mode && !this.mortar.mode
                    && this.running && !this.gameOver
                    && this.current === null) {
                    this.pendingSpawn = true;
                }
            },
        };
    }

    /** Mortar-specific storm hooks. Identical to `makeStormHooks` but
     *  the `onFinish` runs the post-clear pipeline (detonate row bombs
     *  in newly-full rows + clearLines + mode-specific bookkeeping)
     *  BEFORE queuing the spawn. Mortar drops just paint colored cells
     *  onto the board — they don't run the clear hooks themselves —
     *  so the lock-style pipeline has to fire from this hook instead. */
    private makeMortarHooks(): ClearLinesHooks & { onFinish?(): void; onPlacedCell?(r: number, c: number, color: CellValue): void } {
        return {
            ...this.makeClearHooks(),
            onFinish: () => {
                this.processMortarClears();
                if (!this.hail.mode && !this.rocket.mode && !this.gatling.mode && !this.mortar.mode
                    && this.running && !this.gameOver
                    && this.current === null) {
                    this.pendingSpawn = true;
                }
            },
            // Per-drop lock hook — fires when a mortar drop stamps its
            // colour onto a board cell. Forwarded to GameRenderHooks
            // for the SFX + any future FX.
            onPlacedCell: (r, c, color) => this.hooks.onMortarLanded?.(r, c, color),
        };
    }

    /** Run the post-mortar clearing pipeline: count rows that became
     *  fully filled, detonate any bombs sitting in them, then run the
     *  mode-appropriate clearLines / convert-to-gray / fail-check
     *  sequence. Score is awarded for the natural clears. Energy bar
     *  charging + next-piece embed reward are deliberately SKIPPED
     *  because they're tied to actual piece locks — granting them
     *  here would create a mortar→picker→mortar feedback loop. */
    private processMortarClears(): void {
        let naturalClearsThisLock = this.countFullRows();
        // Endless / blind mode baseline: subtract pre-existing all-X
        // gray rows (initial 4 + previously-converted) so mortar
        // doesn't claim score / lines credit for the foundation it
        // didn't create.
        if (isEndlessLike(this.mode)) {
            let alreadyGray = 0;
            const b = this.state.board;
            for (let r = 0; r < b.length; r++) {
                if (b[r].every(v => v === 'X')) alreadyGray++;
            }
            naturalClearsThisLock = Math.max(0, naturalClearsThisLock - alreadyGray);
        }
        // Mirror lockAndNext's bomb / boom adjacency gathering — mortar's
        // freshly-painted cells are eligible adjacency triggers for
        // existing bombs/booms sitting next to them.
        // Mirror lockAndNext's wrecker × boom combo snapshot so a mortar-painted
        // wrecker adjacent to a boom still combos when the boom fires first.
        this.captureWreckerBoomCombos();
        const fullRowSeeds  = gatherLevelBombs(this.state);
        const adjacentSeeds = gatherAdjacentBombs(this.state);
        const adjBooms      = gatherAdjacentBooms(this.state);
        const seeds = fullRowSeeds.concat(adjacentSeeds);
        const adjWreckersMortar = gatherAdjacentWreckers(this.state);
        if (adjBooms.length) {
            const fire = (r: number, c: number, level: 1 | 2 | 3,
                          cleared: Array<{ r: number; c: number }>) =>
                this.hooks.onBoomTriggered?.(r, c, level, cleared);
            for (const { r, c, level } of adjBooms) {
                const stillThere = this.state.boardBooms
                    && this.state.boardBooms[r] && this.state.boardBooms[r][c];
                if (!stillThere) continue;
                this.state.boardBooms![r][c] = null;
                const cleared = activateBoom(this.state, r, c, level);
                fire(r, c, level, cleared);
            }
            processClearedBooms(this.state, { onBoomActivated: fire });
        }
        // Wreckers BEFORE gravity — see comment in lockAndNext for the
        // rationale (gravity shifts the wrecker prop layer along with
        // its host cell, so post-gravity (r, c) coords go stale).
        for (const { r, c } of adjWreckersMortar) {
            const stillThere = this.state.boardWreckers
                && this.state.boardWreckers[r] && this.state.boardWreckers[r][c];
            if (!stillThere) continue;
            this.state.boardWreckers![r][c] = null;
            this.triggerWreckerFromBoard(r, c);
        }
        if (adjBooms.length) {
            // Now apply gravity — pull cells above the boom diamond
            // back down. Skipped if no adjacent boom actually fired.
            const fellMoves = applyDiagonalGravity(this.state, this.computeReservedTop());
            if (fellMoves.length) this.hooks.onCellsFell?.(fellMoves);
        }
        if (seeds.length) {
            detonateBombs(this.state, seeds, this.computeReservedTop(), this.makeDetonateHooks());
        }
        if (this.mode === 'level' || this.mode === 'collect') {
            clearLines(this.state, this.computeReservedTop(), this.makeClearHooks());
            convertReservedZoneToGray(this.state, this.levelReservedHeight);
            if (naturalClearsThisLock > 0) {
                const pts = [0, 100, 300, 500, 800][Math.min(naturalClearsThisLock, 4)] * this.level;
                this.score += pts;
                this.lines += naturalClearsThisLock;
                this.hooks.onScoreChanged?.(this.score);
                this.hooks.onLinesChanged?.(this.lines);
            }
            // Win check — mortar may have just cleared the task zone.
            if (this.maybeFireLevelWin()) return;
            if (checkLevelTooTall(this.state,
                    this.levelTaskHeight + this.levelReservedHeight)) {
                this.failGame(2);
                return;
            }
        } else {
            // Endless / blind (post-storm-resolution branch). Same
            // shatter wiring as the primary convertCompleteRowsToGray
            // call above — both modes fire per-row `onPartialShatter`
            // for the freshly-filled colored content so the player
            // gets the rainbow-flash cue whether the row came from a
            // normal lock or from a storm follow-up (mortar drops
            // hitting the pile after the piece already locked). Also
            // covers the "灰泥填满 24 列没特效" case reported by the
            // user — mortar-triggered fills go through here.
            const filledPost = convertCompleteRowsToGray(
                this.state,
                (r, content) => this.hooks.onPartialShatter?.(r, content),
            );
            void filledPost;   // `onEndlessRowsFilled` suppressed — see main branch above
            if (checkTrappedHole(this.state)) { this.failGame(1); return; }
            // `checkStackTooTall` removed — see comment above.
            const rowsAdded = manageEndlessBoard(this.state);
            if (rowsAdded > 0 && this.current) this.current.y += rowsAdded;
            if (naturalClearsThisLock > 0) {
                const pts = [0, 100, 300, 500, 800][Math.min(naturalClearsThisLock, 4)] * this.level;
                this.score += pts;
                this.lines += naturalClearsThisLock;
                this.hooks.onScoreChanged?.(this.score);
                this.hooks.onLinesChanged?.(this.lines);
            }
        }
    }

    /** True when a piece spawn is queued behind active FX. */
    hasPendingSpawn(): boolean {
        return this.pendingSpawn;
    }

    /** Sub-row visual offset (0..1) for the current piece, based on how
     *  far into the next auto-drop tick we are. Renderers can add this
     *  to `current.y` to draw the piece mid-fall instead of teleporting
     *  one row at a time — used by meteor DOT pieces so the shower
     *  reads as continuous motion.
     *
     *  Returns 0 when there's no live piece, the piece has landed
     *  (grounded), or the piece isn't of a "smooth-fall" type. Non-DOT
     *  pieces stay stepped (classic Tetris feel). */
    getPieceVisualYOffset(): number {
        if (!this.current) return 0;
        if (this.isGrounded) return 0;
        // Smooth fall for everything: DOTs (meteor shower) use their
        // dedicated interval; regular tetrominoes interpolate against
        // the (hourglass-adjusted) grid dropInterval so the piece
        // glides between rows instead of stepping.
        let interval: number;
        if (this.current.type === 'DOT') {
            interval = METEOR_DROP_INTERVAL;
        } else {
            interval = this.hourglass.isActive() ? this.dropInterval * 2 : this.dropInterval;
        }
        if (interval <= 0) return 0;
        const f = this.dropAccum / interval;
        return f < 0 ? 0 : f > 1 ? 1 : f;
    }

    /** True when the energy picker is queued to open behind active FX. */
    hasPendingPickerOpen(): boolean {
        return this.pendingPickerOpen;
    }

    /** True when the endless-mode fate modal is queued for the next FX-quiet frame. */
    hasPendingFateModal(): boolean {
        return this.pendingFateModal;
    }

    /** Renderer calls this when it has popped the fate modal (or
     *  decided to drop it, e.g. game over) so subsequent frames don't
     *  re-pop. The actual UI lives in `GameController` / `HudController`. */
    commitPendingFateModal(): void {
        this.pendingFateModal = false;
    }

    /** Re-register the fate piece's shape + base type on the bag.
     *  Called by the renderer when the player confirms a pick in the
     *  mid-run fate modal. Three updates happen so the swap takes
     *  effect IMMEDIATELY, not just "eventually":
     *
     *    1. `bag.customShape` ← NEW. Future refills include the new
     *       shape in the 8-piece permutation.
     *    2. `bag.clearContents()`. Discards the current bag permutation
     *       (which may still have the OLD custom-shape descriptor
     *       buried in it). The next `pick()` triggers a fresh refill
     *       using the NEW custom shape.
     *    3. If the queued `nextShape` is a custom shape (i.e. the
     *       next piece is going to be the OLD fate piece), swap it
     *       for the NEW shape so the player sees the swap in the
     *       NEXT-piece preview immediately.
     *
     *  The CURRENT active piece is left alone — mid-fall swap would be
     *  jarring. */
    setEndlessFateShape(customPiece: { baseType: PieceType; shape: number[][] }): void {
        const baseType = customPiece.baseType;
        const shape    = customPiece.shape.map(r => r.slice());
        // 1. Update the bag's template.
        this.bag.setCustomShape({ type: baseType, shape });
        // 2. Discard the existing permutation so the OLD custom-shape
        //    descriptor doesn't get drawn before the next refill.
        this.bag.clearContents();
        // 3. If the queued next piece is a custom shape (nextShape !==
        //    null means "this descriptor carries a hand-authored
        //    matrix" — only fate pieces do that), swap its descriptor
        //    for the NEW shape so the preview / spawn use NEW.
        if (this.nextShape !== null) {
            this.nextType  = baseType;
            this.nextShape = shape.map(r => r.slice());
            this.nextBombsShape    = makeEmptyBombs(this.nextShape);
            this.nextBoomsShape    = makeEmptyBooms(this.nextShape);
            this.nextWreckersShape = makeEmptyWreckers(this.nextShape);
            this.hooks.onNextChanged?.(this.nextType);
        }
    }

    /** Renderer calls this once line-clear / detonation FX has finished
     *  so the picker pops up over a settled scene. */
    commitPendingPickerOpen(): void {
        if (!this.pendingPickerOpen) return;
        if (!this.running || this.gameOver) { this.pendingPickerOpen = false; return; }
        // Don't pop the picker while a storm is running.
        if (this.hail.mode || this.rocket.mode || this.gatling.mode || this.mortar.mode) return;
        // Energy may have been spent or the picker already opened via
        // a different path (currently none, but guard anyway).
        if (this.energyPicker.active || this.energyCharge < ENERGY_FULL_THRESHOLD) {
            this.pendingPickerOpen = false;
            return;
        }
        this.pendingPickerOpen = false;
        this.openEnergyPicker();
    }

    /** Renderer calls this once every FX has played through. Idempotent
     *  on the empty/already-spawned case. */
    commitPendingSpawn(): void {
        if (!this.pendingSpawn) return;
        if (!this.running || this.gameOver) {
            // Game ended while spawn was queued — drop the request.
            this.pendingSpawn = false;
            return;
        }
        // Storms may have started AFTER the request (chained from a
        // wrecker / boom). Don't spawn during a storm; the storm's own
        // onFinish will re-queue once it ends.
        if (this.hail.mode || this.rocket.mode || this.gatling.mode || this.mortar.mode) return;
        // Backpack `bomb_block` is arming — hold the next piece until
        // the 3×3 blast has fired. Prevents a fresh piece falling on
        // top of the pulsing red bomb while it's charging up.
        // _drainPendingBox3Detonations clears this array on expiry;
        // the very next commitPendingSpawn tick will then spawn.
        if (this.pendingBox3Detonations.length > 0) return;
        this.pendingSpawn = false;
        // If a magic-item effect (excavator / wrecker / storm) cleared
        // the task zone, win the level NOW instead of spawning the next
        // piece. lockAndNext's natural-clear path already runs this
        // check; this catches the item-triggered case where no piece
        // ever locked but the board still ended up cleared.
        if (this.maybeFireLevelWin()) return;
        this.spawnNext();
    }

    /** Win-condition probe used after item-triggered clears (excavator,
     *  wrecker, storms). Returns true if the level was won and the win
     *  hook fired — caller should bail out of any spawn. */
    private maybeFireLevelWin(): boolean {
        // Tutorial short-circuit: the tower is dressing, not a real
        // level. Clearing the two colored rows during demos shouldn't
        // fire "level clear" — the tutorial owns its own completion
        // trigger (last gesture in the sequence).
        if (this.tutorialActive) return false;
        if (this.mode !== 'level' && this.mode !== 'collect') return false;
        if (this.mode === 'collect') {
            // collect mode: every goal hit?
            if (!this.collectGoals.length) return false;
            const won = this.collectGoals.every(g =>
                (this.collectProgress[g.color] ?? 0) >= g.count
            );
            if (!won) return false;
        } else {
            if (!checkLevelWin(this.state, this.levelReservedHeight)) return false;
        }
        this.running = false;
        this.current = null;
        this.hooks.onLevelWin?.();
        return true;
    }

    private triggerMeteorFromBoard(): void {
        activateMeteor(this.bag, {
            swapCurrent: false,
            onOverrideNextType: () => {
                this.nextType = 'DOT';
                this.nextShape = null;
                this.nextBombsShape = makeEmptyBombs(SHAPES.DOT);
                this.nextBoomsShape = makeEmptyBooms(SHAPES.DOT);
                this.hooks.onNextChanged?.(this.nextType);
            },
        });
        this.hooks.onMeteorActivated?.();
    }

    private triggerWreckerFromBoard(triggerR: number, triggerC: number): void {
        // THREE-phase wrecker firing:
        //   PHASE 0 (this method) — capture the trigger + combo cache
        //       snapshot and queue a MICROTASK that does the actual
        //       pick. We defer because this method is called from
        //       INSIDE detonateBombs / row-clear pipelines: at trigger
        //       time other cells in the same detonation chain haven't
        //       been nulled yet, so `pickWreckerPlan` would happily
        //       pick cells that are about to disappear. The microtask
        //       runs the instant the current synchronous call stack
        //       unwinds — after every bomb / boom / row-splice in
        //       this lock pipeline has settled — so the pick pool
        //       reflects the REAL surviving state.
        //   PHASE 1 (deferred pick) — pick cells + fire pre-pulse so
        //       the renderer can flash the picks.
        //   PHASE 2 (commit) — runs from `commitPendingWreckerPlans`
        //       after the pre-pulse window elapses (Wrecker.ts's
        //       filter+backfill catches any last-instant deaths).
        const key = `${triggerR}-${triggerC}`;
        const cachedBoomLevel = this.wreckerBoomComboCache.get(key) ?? 0;
        const cachedBombAxis  = this.wreckerBombComboCache.get(key) ?? null;
        const pickCount = this.wreckerAdjacencyPickCountCache.has(key)
            ? this.wreckerAdjacencyPickCountCache.get(key)!
            : WRECKER_TARGETS;
        // Defer the pick — see PHASE 0 doc above. queueMicrotask fires
        // after the current sync call stack (including whatever
        // detonateBombs / row-clear loop we're nested in), but before
        // the next Cocos tick / drainWreckerPulse call, so the
        // renderer still gets its pre-pulse frame before commit.
        queueMicrotask(() => this._doDeferredWreckerPick(
            triggerR, triggerC, cachedBoomLevel, cachedBombAxis, pickCount,
        ));
    }

    /** PHASE 1 of the three-phase wrecker fire (see triggerWreckerFromBoard).
     *  Runs on a microtask after the triggering detonation chain has
     *  fully settled, so `pickWreckerPlan`'s pool reflects the true
     *  post-detonation board — no picks land on cells that another
     *  prop was about to clear in the same chain. */
    private _doDeferredWreckerPick(
        triggerR: number,
        triggerC: number,
        cachedBoomLevel: 0 | BoomLevel,
        cachedBombAxis: 'row' | 'col' | null,
        pickCount: number,
    ): void {
        const plan = pickWreckerPlan(
            this.state, this.rng, triggerR, triggerC,
            cachedBoomLevel, cachedBombAxis, pickCount,
        );
        if (!plan) {
            this.hooks.onWreckerActivated?.();
            return;
        }
        this.pendingWreckerPlans.push(plan);
        // Pass the source cell (triggerR, triggerC) so the renderer can
        // launch projectiles from there to each pick. Renderer walks
        // arrival → pulse → shatter; the commit happens when the
        // renderer calls commitPendingWreckerPlans after the last pulse.
        // Include combo info so the renderer can stamp the correct
        // prop icon on each target (row-blast / col-blast / boom /
        // plain wrecker).
        this.hooks.onWreckerPrePulse?.(
            triggerR, triggerC, [...plan.picks],
            plan.comboBoomLevel,
            plan.comboBombAxis,
        );
        this.hooks.onWreckerActivated?.();
    }

    /** Renderer calls this once the pre-pulse flash has finished playing.
     *  Drains every queued wrecker plan and commits the actual clear —
     *  null cells, fire shatter, run combo bombs, settle gravity. */
    commitPendingWreckerPlans(): void {
        if (!this.pendingWreckerPlans.length) return;
        const reservedTop = this.computeReservedTop();
        const hooks = this.makeDetonateHooks();
        const plans = this.pendingWreckerPlans;
        this.pendingWreckerPlans = [];
        for (const plan of plans) applyWreckerPlan(this.state, plan, hooks, reservedTop);
        // The wrecker (alone or in combo with a Boom / directional bomb)
        // can clear the last colored cell on the board. Without this
        // check the next-piece spawner runs first and the player sees a
        // fresh tetromino dropped onto a "won" board.
        if (this.mode === 'level' || this.mode === 'collect') {
            this.maybeFireLevelWin();
        }
    }

    hasPendingWreckerPlans(): boolean {
        return this.pendingWreckerPlans.length > 0;
    }

    /** Snapshot each wrecker's strongest adjacent boom level into
     *  `wreckerBoomComboCache`. Must be called BEFORE the boom-side
     *  adjacency loop fires (which removes booms from the live board),
     *  otherwise the wrecker—which always fires later in the same frame—
     *  would lose access to its combo neighbour. */
    private captureWreckerBoomCombos(): void {
        this.wreckerBoomComboCache.clear();
        this.wreckerBombComboCache.clear();
        this.wreckerAdjacencyPickCountCache.clear();
        const wreckers = this.state.boardWreckers;
        const booms = this.state.boardBooms;
        const bombs = this.state.boardBombs;
        if (!wreckers) return;
        const H = this.state.board.length;
        // First pass: bomb/boom adjacency (unchanged behaviour).
        for (let r = 0; r < H; r++) {
            if (!wreckers[r]) continue;
            for (let c = 0; c < COLS; c++) {
                if (!wreckers[r][c]) continue;
                const candidates: Array<[number, number]> = [
                    [r - 1, c],
                    [r + 1, c],
                    [r, (c - 1 + COLS) % COLS],
                    [r, (c + 1) % COLS],
                ];
                let bestBoom: 0 | 1 | 2 | 3 = 0;
                let bombAxis: 'row' | 'col' | null = null;
                for (const [nr, nc] of candidates) {
                    if (nr < 0 || nr >= H) continue;
                    if (booms) {
                        const lvl = booms[nr] && booms[nr][nc];
                        if (lvl && lvl > bestBoom) bestBoom = lvl as 1 | 2 | 3;
                    }
                    if (bombs && !bombAxis) {
                        const kind = bombs[nr] && bombs[nr][nc];
                        if (kind && typeof kind === 'string') {
                            if (kind.startsWith('row')) bombAxis = 'row';
                            else if (kind.startsWith('col')) bombAxis = 'col';
                        }
                    }
                }
                const key = `${r}-${c}`;
                if (bestBoom) this.wreckerBoomComboCache.set(key, bestBoom);
                if (bombAxis) this.wreckerBombComboCache.set(key, bombAxis);
            }
        }
        // Second pass: wrecker×wrecker cluster combo. BFS every 4-connected
        // component. The lexically-smallest wrecker in each component
        // becomes the "leader" and picks WRECKER_TARGETS × clusterSize
        // cells; the rest are marked "passive" (pickCount = 0). Standalone
        // wreckers (cluster of size 1) still map to WRECKER_TARGETS.
        const visited = new Set<string>();
        for (let r = 0; r < H; r++) {
            if (!wreckers[r]) continue;
            for (let c = 0; c < COLS; c++) {
                if (!wreckers[r][c]) continue;
                const startKey = `${r}-${c}`;
                if (visited.has(startKey)) continue;
                // BFS this connected component.
                const cluster: string[] = [];
                const queue: Array<[number, number]> = [[r, c]];
                visited.add(startKey);
                while (queue.length) {
                    const [cr, cc] = queue.shift()!;
                    cluster.push(`${cr}-${cc}`);
                    const nbrs: Array<[number, number]> = [
                        [cr - 1, cc],
                        [cr + 1, cc],
                        [cr, (cc - 1 + COLS) % COLS],
                        [cr, (cc + 1) % COLS],
                    ];
                    for (const [nr, nc] of nbrs) {
                        if (nr < 0 || nr >= H) continue;
                        if (!wreckers[nr] || !wreckers[nr][nc]) continue;
                        const nk = `${nr}-${nc}`;
                        if (visited.has(nk)) continue;
                        visited.add(nk);
                        queue.push([nr, nc]);
                    }
                }
                // Elect a leader — smallest key wins deterministically.
                cluster.sort();
                const leaderKey = cluster[0];
                const leaderPickCount = WRECKER_TARGETS * cluster.length;
                for (const k of cluster) {
                    this.wreckerAdjacencyPickCountCache.set(
                        k, k === leaderKey ? leaderPickCount : 0,
                    );
                }
            }
        }
    }
}

// ---------- Inline helpers (kept here to avoid an extra import in the input handlers) ----------

function rotate(grid: number[][], dir: number): number[][] {
    const n = grid.length;
    const out: number[][] = [];
    for (let r = 0; r < n; r++) out.push(new Array<number>(n).fill(0));
    for (let r = 0; r < n; r++) {
        for (let c = 0; c < n; c++) {
            if (dir > 0) out[c][n - 1 - r] = grid[r][c];
            else         out[n - 1 - c][r] = grid[r][c];
        }
    }
    return out;
}

/** True if `piece` carries ANY embedded prop (bomb, boom, wrecker).
 *  Used by the shapeshifter path to protect prop-carrying pieces from
 *  being swapped out (their embed layers would be silently erased). */
function hasEmbedProps(piece: Piece): boolean {
    const scan = (grid: readonly (unknown | null)[][] | null | undefined): boolean => {
        if (!grid) return false;
        for (let r = 0; r < grid.length; r++) {
            const row = grid[r];
            if (!row) continue;
            for (let c = 0; c < row.length; c++) {
                if (row[c]) return true;
            }
        }
        return false;
    };
    return scan(piece.bombs) || scan(piece.booms) || scan(piece.wreckers);
}

function pieceCenterOf(piece: Piece): number {
    let minX = piece.shape[0].length, maxX = -1;
    for (let r = 0; r < piece.shape.length; r++) {
        for (let c = 0; c < piece.shape[r].length; c++) {
            if (piece.shape[r][c]) {
                if (c < minX) minX = c;
                if (c > maxX) maxX = c;
            }
        }
    }
    if (maxX < 0) return piece.x;
    return piece.x + (minX + maxX + 1) / 2;
}
