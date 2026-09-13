import {
    _decorator,
    Component,
    Node,
    Prefab,
    instantiate,
    MeshRenderer,
    Material,
    Color,
    Input,
    input,
    EventKeyboard,
    EventTouch,
    KeyCode,
    JsonAsset,
    log,
    math,
    director,
    primitives,
    screen,
    utils,
    Vec3,
    Mat4,
    Quat,
    Texture2D,
    tween,
    Button,
    Mesh,
} from 'cc';
import { COLS, COLORS, CellValue, ENDLESS_HEIGHT_LIMIT, ENDLESS_GRAY_CAP } from '../core/Constants';
import { isColoredCell } from '../core/Board';
import { SoundManager } from '../audio/SoundManager';
import { HapticsManager } from '../audio/HapticsManager';
import { getControlMode, subscribe as subscribeSettings } from '../core/Settings';
import { LevelProgress } from '../core/LevelProgress';
import { submitScore, submitLevelTime } from '../core/LeaderboardApi';
import { AnalyticsApi } from '../core/AnalyticsApi';
import { buildTutorialLevel } from '../core/TutorialLevelData';
// Settings.gestureMode currently unused — the gesture system was simplified
// to "left-half tap/hold/drag" (no flick branch). Import kept commented for
// quick restoration if the flick path comes back.
// import { getGestureMode } from '../core/Settings';
import { GameState } from '../core/GameState';
import { countBottomCompleteRows, findTrappedCells } from '../core/Modes/EndlessMode';
import { collides } from '../core/Pieces';
import { loadLevel, validateLevelData } from '../core/LevelData';
import { LevelData } from '../core/Types';
import { createCurvedBrickMesh } from './BrickMesh';
// (No import of MenuController — avoids circular import. MenuController
//  registers itself via setMenuController() below using a structural type.)
import { CubeManager } from './CubeManager';
import { WreckerCubeFX } from './WreckerCubeFX';
import { RowBlastCubeFX } from './RowBlastCubeFX';
import { BoomCubeFX } from './BoomCubeFX';
// CubeFX imports (RowBlast/Wrecker/Rocket/Hail/Meteor/Gatling/Boom) moved
// with the cube pools into CubeManager.
import { RowBlastDetonateEffect } from './RowBlastDetonateEffect';
import { ColBlastDetonateEffect } from './ColBlastDetonateEffect';

const { ccclass, property } = _decorator;

// ============================================================
//  3D layout constants (world units)
// ============================================================
/** Edge length of one cube in world units. */
const CELL_SIZE      = 1.0;
/** Tiny gap between cubes so neighbors don't z-fight or look fused.
 *  Now that we increased the camera near plane (Z-fight resolved),
 *  bricks can touch fully — set to 1.0 for seamless tiling. */
const CUBE_VISUAL    = 1.0;
/** Full 360° cylinder — no back gap. The original HTML game used a 60° back
 *  gap to give a "see-through" view; in real 3D the back is naturally
 *  occluded by the front wall once enough bricks accumulate, but the gap
 *  becomes visible during early-game when the front is sparse. Closing
 *  the cylinder gives a consistently solid look. */
const VISUAL_SPAN    = Math.PI * 2;
/** 24 cols spread across the full 360° — 15° per column. */
const ANGLE_PER_COL  = VISUAL_SPAN / COLS;
/** Cylinder radius such that chord at this arc width = CELL_SIZE. */
const RADIUS         = CELL_SIZE / (2 * Math.sin(ANGLE_PER_COL / 2));
/** How many board rows are nominally visible (used as the y-anchor reference).
 *  Endless mode can grow the board taller — extra rows just extend upward,
 *  off-camera until the player scrolls them down. */
const VISIBLE_ROWS   = 20;
/** Y position of the bottom-row cube centre. */
const Y_BOTTOM       = -(VISIBLE_ROWS / 2) * CELL_SIZE + CELL_SIZE / 2;

/**
 * 3D top-level controller — owns the live `GameState`, drives the main loop,
 * and paints the board as real 3D cubes around a cylinder. Each cube is an
 * instance of `Cube.prefab`; the controller maintains a fixed pool and only
 * toggles `node.active` + transform + material colour per frame, so there's
 * no per-frame allocation.
 *
 * The cubes live under `BoardRoot3D`, which we rotate around Y so that the
 * active piece's column always sits at world angle 0 (facing the camera).
 */
@ccclass('GameController')
export class GameController extends Component {

    /** Sibling component that owns every board-cell render pool. Drag the
     *  `CubeManager` component (usually on the SAME node as this one) into
     *  this slot. All cube prefab references and per-frame cell placement
     *  now live there. */
    @property(CubeManager)
    cubeManager: CubeManager | null = null;

    /** DEBUG toggle for 闭眼模式: when ON, the settled tower cells
     *  render normally so you can see what's really on the board
     *  (useful for tuning gameplay / verifying stacking). When OFF
     *  (default — real 闭眼模式), only the active piece + ghost show;
     *  the tower is invisible. No effect outside blind mode. */
    @property({ tooltip: '闭眼模式测试开关：勾上就把塔画出来（默认关，正式闭眼模式）' })
    blindShowTowerDebug: boolean = false;

    /** Drag the `BoardRoot3D` scene node here. */
    @property(Node)
    boardRoot3D: Node | null = null;

    /** Drag `cube-mat.mtl` here. This is the material every brick uses; the
     *  controller clones it per brick at runtime so `mainColor` can be
     *  unique per cell. */
    @property(Material)
    cubeMaterial: Material | null = null;

    /** Drag level JSON assets here from `assets/data/levels/`. Each asset can
     *  be either a single-level JSON (the legacy export from the H5 editor)
     *  OR a bundle `{ levels: [...] }` (the editor's "export all" output).
     *  Bundle files are flattened into individual levels at startup. */
    @property([JsonAsset])
    levels: JsonAsset[] = [];

    /** Which clear-effect to play when a row clears:
     *   0 = SHATTER (chunks + dust burst — Block Blast wave version)
     *   1 = FLASH (rainbow flash on the cleared row, then disappear)
     *  Other values fall back to no effect.
     *  The rainbow ribbon sweep is NOT a clear effect — it's reserved
     *  for blast-bomb detonations via `onRowBombDetonate`. */
    @property
    clearEffect: number = 1;

    /** How long the rainbow flash lasts before the row fades out (seconds). */
    @property
    flashDuration: number = 0.5;

    // ----- Hail storm rendering -----
    /** Icy colour for in-flight hail spheres. Slight blue tint reads
     *  as ice rather than plastic. */
    @property
    hailDropColor: Color = new Color(225, 240, 255, 235);

    /** Sphere diameter (multiplied by CELL_SIZE × CUBE_VISUAL). 0.6
     *  reads as a hail ball that fits inside a cell without filling it. */
    @property
    hailDropSize: number = 0.6;

    /** Total seconds of the "pre-pulse" — the 24-cell row flashes
     *  twice over this duration before the rainbow ribbon detonation
     *  spawns. Set 0 to skip the pulse and fire the ribbon immediately. */
    @property
    prePulseDuration: number = 0.30;

    /** Total seconds of the WRECKER pre-pulse. Independent from
     *  `prePulseDuration` so we can leave row-blast snappy while still
     *  giving the player plenty of time to register the wrecker's
     *  10 pick cells flashing twice. Default 0.9 s = 450 ms per pulse,
     *  much more visible than the 75 ms row-blast pulse. */
    @property
    wreckerPulseDuration: number = 0.9;

    /** Scale multiplier applied to the wrecker's pre-pulse halo cube
     *  (relative to a single tower cell). Row-blast pulses use 1.15
     *  (a visible outward glow ring around the brick); wrecker
     *  defaults to 1.05 — same-size-ish so the halo hugs the brick
     *  without spilling into neighbouring cells. Tunable in Inspector. */
    @property({ range: [0.5, 2.0, 0.01] })
    wreckerPulseScale: number = 1.05;

    /** Colour the row cells flash to during the pre-pulse. Default white
     *  reads as "ready to detonate" against any underlying cell colour. */
    @property
    prePulseColor: Color = new Color(255, 255, 255, 255);

    /** Peak alpha (0–255) for the pre-pulse flash cubes. */
    @property({ range: [0, 255, 1] })
    prePulseAlpha: number = 230;

    /** How many rows the column-bomb flash extends UP and DOWN from the
     *  trigger row. e.g. 10 = flashes 21 cells total (10 above, trigger,
     *  10 below) clamped to board bounds. */
    @property({ range: [1, 30, 1] })
    colFlashExtent: number = 12;

    /** Seconds of stagger PER row of distance from the trigger — the
     *  flash wave radiates outward at this speed. 0 = all cells light
     *  up simultaneously; ~0.04 reads as a clear "shockwave" outward. */
    @property
    colFlashStagger: number = 0.035;

    /** Boom (range-blast item) ripple speed — seconds of delay PER
     *  Manhattan-distance step away from the boom centre. Smaller =
     *  snappier "everything pops at once" feel; larger = clearer
     *  outward shockwave. 0.035 matches the col-flash wave speed. */
    @property
    boomFlashStagger: number = 0.035;

    /** Base opacity for the rainbow-flash cells. 0 = fully transparent,
     *  1 = fully opaque. Combined with the soft brightness fade so the
     *  end-of-life alpha approaches 0 regardless of this value. */
    @property
    flashOpacity: number = 0.6;

    /** Stars per cleared cell — small glowing specks bursting out of each
     *  filled column during a rainbow flash. */
    @property
    flashStarsPerCell: number = 6;

    /** Base size (edge length) of each star spec. Each star randomly scales
     *  this by 0.6 – 1.4 for natural variety. */
    @property
    flashStarSize: number = 0.18;

    /** Minimum / maximum spawn speed (world units / sec). */
    @property
    flashStarSpeedMin: number = 2.0;
    @property
    flashStarSpeedMax: number = 5.5;

    /** Minimum / maximum lifetime in seconds. */
    @property
    flashStarLifetimeMin: number = 0.5;
    @property
    flashStarLifetimeMax: number = 1.1;

    /** Downward acceleration applied to each star (world units / sec²).
     *  Set to 0 for floaty sparks, increase for popcorn-style arcs. */
    @property
    flashStarGravity: number = 4.0;

    /** Flattened list of LevelData built from the `levels` assets in onLoad. */
    public flatLevels: LevelData[] = [];

    /** MenuController registers itself here via setMenuController().
     *  Structural type avoids a circular import. */
    private menuController: {
        showGameOver(reason: number | null): void;
        showLevelWin(): void;
    } | null = null;

    public setMenuController(mc: {
        showGameOver(reason: number | null): void;
        showLevelWin(): void;
    }): void {
        this.menuController = mc;
    }

    /** HudController is registered via setHudController() by MenuController
     *  (which already has a wired reference). Structural type avoids the
     *  circular import from HudController pulling in GameController.
     *  Used by `onShapeshifterRequest` to open the tetromino picker,
     *  and by blind-mode to drive the top column indicator. */
    private hudController: {
        showShapeshifterPicker(apply: (type: import('../core/Constants').PieceType) => void): void;
        setBlindColumn?(col: number): void;
        setBlindIndicatorVisible?(on: boolean): void;
        showFailRevealPrompt?(onTap: () => void): void;
        hideFailRevealPrompt?(): void;
    } | null = null;

    public setHudController(hud: {
        showShapeshifterPicker(apply: (type: import('../core/Constants').PieceType) => void): void;
        setBlindColumn?(col: number): void;
        setBlindIndicatorVisible?(on: boolean): void;
        showFailRevealPrompt?(onTap: () => void): void;
        hideFailRevealPrompt?(): void;
    }): void {
        this.hudController = hud;
    }

    /** Public so HudController (and any other companion controller) can read
     *  the live game state. */
    gameState!: GameState;

    /** Dedicated pool for rainbow-flash cubes — plain box mesh + a single
     *  unlit transparent material instance per slot so colour can be set
     *  per-cube without disturbing the prefab brick pool. */
    private flashCubePool: Node[] = [];
    private flashCubeMRs: MeshRenderer[] = [];
    private flashCubeMats: Material[] = [];

    /** Pool of in-flight gatling bullet spheres (similar to hail drops). */
    private gatlingBulletPool: Node[] = [];
    private gatlingBulletCursor: number = 0;


    /** Pool of falling-rocket instances. Each frame `syncCubes`
     *  positions one node per entry in `gameState.rocket.getFalling()`
     *  and hides the rest. */
    private rocketPool: Node[] = [];
    private rocketCursor: number = 0;

    /** Pool of in-flight hail spheres. Each frame `syncCubes` positions
     *  one node per entry in `gameState.hail.getFalling()`. Placed hail
     *  cells (board[r][c]='H') render via the regular brick path using
     *  the `H` palette color, so this pool only handles the airborne
     *  storm projectiles. */
    private hailDropPool: Node[] = [];
    private hailDropCursor: number = 0;

    /** Pool of in-flight mortar drops. Same role as the hail pool but
     *  each drop's material `mainColor` is re-tinted every frame to
     *  match the colour it'll stamp on landing — mortar drops mirror the
     *  cell they're about to fill. */
    private mortarDropPool: Node[] = [];
    private mortarDropMats: Material[] = [];
    private mortarDropCursor: number = 0;

    /** Millisecond accumulator for the "sparkle trail" behind
     *  rocket / gatling bullets — spawnStarsAt fires every ~50ms per
     *  in-flight bullet (see `stepRocketTrail`). */
    private rocketTrailStarAccumMs: number = 0;

    /** Pending level-win popup — set by the `onLevelWin` hook, fired only
     *  after the active flash + sparkle effects finish so the popup
     *  doesn't paint over the celebration. */
    private pendingLevelWin = false;
    /** Which level idx is currently loaded (–1 = endless / none). Set by
     *  `loadLevelByIndex`; read by the `onLevelWin` hook so we can persist
     *  the completion into LevelProgress. */
    private _activeLevelIdx = -1;
    public get activeLevelIdx(): number { return this._activeLevelIdx; }

    /** Every N endless layers, auto-submit the current tower height to
     *  the leaderboard. See onEndlessMilestone. Set to 50 so a player
     *  crossing 50 / 100 / 150 / ... floors always has a recorded
     *  best even if the app dies before natural game-over. */
    private static readonly ENDLESS_AUTO_SUBMIT_INTERVAL = 50;

    /** Highest `endlessProgress.cumulative` value already auto-submitted
     *  in THIS run. Reset via resetEndlessAutoSubmitTracker() at the
     *  start of every fresh endless attempt so the first crossing of
     *  50 fires. Comparing against this instead of `cumulative % 50`
     *  survives multi-layer partial-shatter jumps that could skip past
     *  the boundary in a single lock. */
    private _lastEndlessAutoSubmit = 0;
    /** Pending game-over popup. `null` once consumed; otherwise holds the
     *  reason code passed by GameState. Same delay logic as level-win. */
    private pendingGameOverReason: number | null | undefined = undefined;

    /** True while the "look at your final tower, tap to continue"
     *  overlay is up (between the game-over signal firing and the
     *  actual fail popup showing). Blind mode uses this to force the
     *  tower cells visible during the reveal — the player couldn't see
     *  the tower during the run, so revealing it now is the whole
     *  point. Other modes keep it visible either way; the flag just
     *  gates the FX-hiding overrides. */
    private postFailRevealPending: boolean = false;
    /** Wall-clock (Date.now ms) when the most-recently-spawned ribbon
     *  detonation effect is expected to finish.  Used by
     *  `drainPendingPopups` to defer end-of-game popups until the
     *  detonation visual has played through. */
    private ribbonDetonateEndsAt = 0;
    /** Pre-built reusable ribbon detonation FX. Built once in `onLoad`
     *  (1440+ meshes is too expensive to build on-demand each trigger).
     *  Each call to `spawnRibbonDetonate` just repositions + re-triggers. */
    private rowBlastDetonateFx: RowBlastDetonateEffect | null = null;
    /** Pre-built reusable column-blast vertical-streak FX. Repositioned
     *  + re-triggered for each col bomb detonation. */
    private colBlastDetonateFx: ColBlastDetonateEffect | null = null;

    /** Cells currently flashing as a "pre-detonation pulse" — when a
     *  row-bomb triggers, the entire 24-cell row blinks twice over
     *  `prePulseDuration` before the ribbon spawns. Stored as (r, c)
     *  board indices — the render loop computes local coords from
     *  the CURRENT boardYOffset/centerCol every frame, so the pulse
     *  stays locked to the tower cells even when the camera lerps
     *  or boardRoot3D's scale/yaw changes mid-animation. */
    private prePulseCells: Array<{
        r: number;
        c: number;
        startTime: number;
        /** Optional per-cell override — when set, the cell uses this
         *  duration in ms instead of `this.prePulseDuration`. Lets the
         *  wrecker flash MUCH longer than the row-blast pulse without
         *  affecting either system. */
        durationMs?: number;
        /** Optional per-cell scale override — when set, the pulse cube
         *  renders at this scale instead of the row-blast default
         *  (1.15). Wrecker uses `wreckerPulseScale` so its halo hugs
         *  the brick tighter and doesn't visually leak into the
         *  neighbouring cells. */
        scale?: number;
        /** Brightness-pulse mode. When true, the pulse cube renders at
         *  scale 1.0 wrapping the brick exactly, tinted with the
         *  brick's OWN colour (looked up from state.board[r][c] →
         *  COLORS[cellValue]). Reads as "the brick brightens" instead
         *  of "a white halo appears around the brick". Used by the
         *  wrecker's per-target confirmation flash. */
        brightnessMode?: boolean;
    }> = [];

    /** Scheduled ribbon-detonation triggers that fire on a delay (after
     *  the pre-pulse completes). */
    private pendingRibbonTriggers: Array<{
        row: number;
        fireAt: number;
    }> = [];

    /** Trapped-hole highlight cells — board (r, c) coords that the
     *  BFS marked unreachable. Stored as INDICES (not world coords)
     *  so `renderTrappedHoleCells` can recompute the world position
     *  every frame using the current `boardYOffset` / `centerCol` —
     *  this keeps the pulse locked to the actual tower cells even
     *  if the camera lerps between queue-time and render-time (which
     *  matters in endless mode where the board has been shifted down
     *  to follow the tall tower). */
    private trappedHoleCells: Array<{
        r: number;
        c: number;
        startTime: number;
    }> = [];

    /** Same detection for the flash-cube pool's unlit material. */
    private canTintFlash  = false;
    /** Same detection for the star-pool's unlit material. */
    private canTintStars  = false;

    /** Active rainbow-flash cells. Populated by `onShatter` when
     *  `clearEffect === 1`. Stored as (r, c) board indices — `renderFlashingCells`
     *  computes LOCAL boardRoot3D coords per frame using the same placeCube
     *  formula the actual bricks use. This ensures the flash cube sits exactly
     *  on the destroyed brick regardless of boardRoot3D's scale (TOWER_VIEW_SCALE
     *  = 0.75) or camera-follow Y translation. */
    private flashingCells: Array<{
        r: number;
        c: number;
        colIndex: number;
        startTime: number;
        /** When true, the cell skips the pop-in growth phase and just
         *  shrinks from full size to zero over its life — gives the
         *  flash a flat leading edge with a tapered trailing edge.
         *  Used by the column-bomb flash wave. */
        trailOnly?: boolean;
        /** Optional per-cell alpha multiplier (0..1, default 1). */
        alphaScale?: number;
    }> = [];

    /** Endless-mode layer celebration — a single continuous glowing
     *  cylindrical sleeve that rises from the tower's base and grows
     *  UPWARD, ending at the top of the newly-gray foundation. One
     *  active pulse at a time; a fresh fire replaces any in-flight
     *  one. Rendered by `renderSpectrumRing` using a dedicated
     *  cylinder mesh node built lazily in `ensureSpectrumRingNode`.
     *
     *  `bottomY` is the FIXED Y coord of the ring's bottom edge in
     *  local boardRoot3D frame — the ring grows upward from here.
     *  `peakHeightCells` is the target height in cells at t = TOTAL. */
    private spectrumRingState: {
        bottomY: number;
        peakHeightCells: number;
        startTime: number;
    } | null = null;
    private spectrumRingNode: Node | null = null;
    private spectrumRingMat:  Material | null = null;

    /** Small sparkle particles that orbit with the celebration ring —
     *  each particle has a fixed angular offset around the tower Y
     *  axis + a radial + Y position. Every frame the ring's current
     *  spin angle is added to each particle's theta so they visually
     *  spin together with the ring. */
    private spectrumParticles: Array<{
        theta0: number;
        radialR: number;
        y0: number;
        yDrift: number;   // vertical drift over life (world units)
        size: number;
        startTime: number;
        lifeMs: number;
    }> = [];
    private spectrumParticleNodes: Node[] = [];
    private spectrumParticleMats:  Material[] = [];

    private static readonly SPECTRUM_TOTAL_MS = 600;
    /** Ring spin rate — degrees per second around the tower's Y axis
     *  during the celebration lifetime. Fast enough to blur the
     *  per-segment top-edge jaggedness into a rotating halo. */
    private static readonly SPECTRUM_SPIN_DEG_PER_SEC = 3600;


    /** Star-pool for rainbow-flash sparkles. Pre-allocated meshes the
     *  particle system re-uses each frame. */
    private starPool: Node[] = [];
    private starPoolMeshes: MeshRenderer[] = [];
    /** Active star particles (Euler integrated each frame). */
    private stars: Array<{
        px: number; py: number; pz: number;
        vx: number; vy: number; vz: number;
        spinX: number; spinY: number; spinZ: number;
        rotX: number; rotY: number; rotZ: number;
        age: number; lifetime: number;
        hue: number;
        size: number;
    }> = [];

    /** Keyboard dedupe — when Cocos `input` fires we mark a short-lived
     *  timestamp so the DOM fallback listener doesn't double-trigger. */
    private lastCocosKeyAt: number = 0;

    /** DAS auto-repeat state for left/right keys.
     *   leftHeld / rightHeld:  timestamp the key was first pressed (0 = not held)
     *   leftLastFire / rightLastFire: timestamp of the most recent action trigger */
    private leftHeld     = 0;
    private rightHeld    = 0;
    private leftLastFire = 0;
    private rightLastFire = 0;
    private static readonly DAS_DELAY     = 160;   // ms before auto-repeat starts
    private static readonly REPEAT_INTERVAL = 70;  // ms between auto-repeat fires

    /** The warning-line ring around the cylinder (endless mode only).
     *  Y position recomputed every frame from `bottomGray + HEIGHT_LIMIT`. */
    private warningRing: Node | null = null;

    /** 3D world-space light beam used by 闭眼模式. Width exactly one
     *  CELL_SIZE (= one tower column arc-width at the front) and stays
     *  at world x=0, z=RADIUS+ε — the same spot where the tower's
     *  currently-centered column and the falling piece render. Because
     *  the tower cell placement code rotates cubes so that `centerCol`
     *  always ends up at that world position, the beam automatically
     *  lines up with the front-facing column no matter how the player
     *  rotates. */
    private blindBeamNode: Node | null = null;

    // ---- Touch / mouse drag state ----
    //
    // Left half = tower rotation zone.  Within the left half:
    // Full-screen unified touch gestures (no left/right split, no 1/3-vs-2/3 zone):
    //   - ANY horizontal swipe (dominantly horizontal motion past
    //     TAP_MAX_PX), regardless of distance → on release, rotate the
    //     tower 1 column in the swipe direction.
    //   - Same swipe but finger held on screen ≥ HOLD_DELAY_MS →
    //     enter continuous rotation in that direction (repeats every
    //     HOLD_REPEAT_MS) until the finger lifts.
    //   - Pure tap (< TAP_MAX_PX movement, < TAP_MAX_MS): rotate the piece.
    //   - Vertical swipe DOWN past SWIPE_MIN_PX: hard drop.
    private touchStartX = 0;
    private touchStartY = 0;
    /** Latest finger position — updated by onTouchMove so the hold-timer
     *  callback (which fires without an event) can see where the finger
     *  currently is when deciding whether to enter continuous mode. */
    private touchLastX = 0;
    private touchLastY = 0;
    private touchStartTime = 0;
    private touchActive = false;
    /** Direction (-1 = left / 顺时针, +1 = right / 逆时针) locked in when
     *  continuous mode begins. `0` = no rotation happening yet. */
    private touchLastDir: 1 | -1 | 0 = 0;
    /** True once the hold-timer fires and continuous rotation has taken
     *  over. Suppresses the "one-shot rotation on release" branch in
     *  onTouchEnd, since we've been spinning the whole time already. */
    private touchIsContinuous = false;
    /** setTimeout / setInterval handles for hold-to-repeat (legacy mode). */
    private touchHoldDelayHandle: ReturnType<typeof setTimeout> | null = null;
    private touchHoldRepeatHandle: ReturnType<typeof setInterval> | null = null;

    // ---- Buttons mode: on-screen L/R rotate buttons (Settings picker) ----
    @property({ type: Button, tooltip: '按钮模式 — 塔"向左转"按钮（点击 = 转 1 格，按住 = 连续转）— 可空' })
    authoredRotateLeftButton: Button | null = null;

    @property({ type: Button, tooltip: '按钮模式 — 塔"向右转"按钮 — 可空' })
    authoredRotateRightButton: Button | null = null;

    @property({ type: Node, tooltip: '按钮模式 — 两个方向按钮的容器节点（脚本会根据操作方式切换 active）— 可空' })
    authoredRotateButtonsGroup: Node | null = null;

    @property({ type: Button, tooltip: '通用 — 硬降按钮（点击 = hardDrop，方块直接落底）— 所有操作模式都能用；可空' })
    authoredHardDropButton: Button | null = null;

    @property({ type: Button, tooltip: '通用 — 方块变形按钮（点击 = tryRotate(1)，旋转当前方块）— 所有操作模式都能用；可空' })
    authoredRotatePieceButton: Button | null = null;

    /** Held-button repeat timers (buttons mode). */
    private _btnHoldHandle: ReturnType<typeof setInterval> | null = null;
    private _btnHoldDelayHandle: ReturnType<typeof setTimeout> | null = null;
    /** Delay (ms) after TOUCH_START before the hold-to-repeat kicks
     *  in. A normal tap lasts 80-200 ms, so anything shorter than
     *  ~350 ms should be treated as a single click and NOT trigger
     *  the interval — otherwise fast taps end up rotating 2 columns. */
    private static readonly BTN_HOLD_START_MS = 350;

    // ---- Fling-rotation state (new drag-and-release scheme) ----
    /** Rolling window of recent finger x-samples used to compute
     *  release velocity in onTouchEnd. Old entries (older than
     *  FLING_SAMPLE_WINDOW_MS) are trimmed on each push. */
    private _touchSamples: Array<{ t: number; x: number }> = [];
    /** Cumulative columns already stepped during THIS drag — used so
     *  onTouchMove can figure out how many more column-steps to fire
     *  as the finger continues moving. Reset on onTouchStart. */
    private _touchDragCumCol: number = 0;
    /** True while the tower is spinning freely from a release-fling.
     *  The next touch-start cancels it immediately. */
    private _flingActive: boolean = false;
    /** Signed angular velocity in columns/sec. Positive = +dir. */
    private _flingVelocity: number = 0;
    /** Fractional-column accumulator — each frame's velocity*dt lands
     *  here; whenever |accum| ≥ 1 we fire moveCylinder and subtract 1. */
    private _flingAccum: number = 0;

    /** Touch gesture parameters:
     *   - No px minimum for the initial swipe — any horizontal motion
     *     above the tap-noise floor (TAP_MAX_PX) counts as "swiped".
     *   - HOLD_DELAY_MS ticks the swipe over into continuous mode. */
    private static readonly HOLD_DELAY_MS      = 200;  // ms after touch start; if still down + swiped, enter continuous mode
    private static readonly HOLD_REPEAT_MS     = 80;   // continuous-mode rotation interval — INITIAL rate (0-2s)
    private static readonly HOLD_REPEAT_FAST_MS = 60;  // faster rate applied after HOLD_FAST_AFTER_MS of continuous hold
    private static readonly HOLD_FAST_AFTER_MS = 2000; // switch to the fast interval this long after entering continuous mode
    // ---- Fling-and-friction rotation (new scheme) ----
    // Drag distance (px) required to advance the tower by ONE column
    // while the finger is held on-screen. Feels closest to the old
    // continuous-hold rate at typical swipe speeds.
    private static readonly PX_PER_COL_DRAG    = 125;
    // Sample window used to compute release velocity — only finger
    // movement in the last SAMPLE_WINDOW_MS before touch-end is
    // considered, so pausing mid-drag doesn't kill the fling.
    private static readonly FLING_SAMPLE_WINDOW_MS = 100;
    // Minimum release velocity (in columns/second) below which the
    // tower does NOT enter fling on touch-end — pretty much a "the
    // player was steering, not flinging" cutoff.
    private static readonly FLING_MIN_TRIGGER_CPS  = 3;
    // Hard cap on fling velocity so a super-fast flick doesn't spin
    // the cylinder faster than the renderer can keep up. Distance
    // formula: distance = V² / (2 × FRICTION) columns.
    //   Max cap V=24, friction 24 → max fling ≈ 12 cols (half circle)
    //   Light swipe V≈10        → fling ≈ 2 cols
    private static readonly FLING_MAX_VELOCITY_CPS = 24;
    // Linear deceleration in columns/sec² — friction. Higher = tower
    // stops quicker; typical fling lasts velocity / friction seconds.
    // Doubled from 12 → 24 to make light swipes stop after ~2 cols
    // instead of ~4-5 while keeping the max-cap swipe at half a circle.
    private static readonly FLING_FRICTION_CPS2    = 36;
    // Velocity magnitude at which we snap-stop the fling — prevents
    // an infinitely-slow crawl at the tail of the decay curve.
    private static readonly FLING_MIN_VELOCITY_CPS = 0.6;
    /** Uniform scale applied to BoardRoot3D so the tower occupies a smaller
     *  fraction of the screen on tall phone displays. 1.0 = original size. */
    private static readonly TOWER_VIEW_SCALE = 0.75;
    private static readonly TAP_MAX_PX      = 15;   // movement under this = tap (rotate piece)
    private static readonly TAP_MAX_MS      = 300;
    private static readonly SWIPE_MIN_PX    = 60;   // vertical swipe threshold

    onLoad(): void {
        log('[TowerBlocks] GameController.onLoad (3D)');

        // Bump up ambient lighting so the back/side faces of cubes that don't
        // receive direct light still have visible colour instead of pure black.
        const globals = director.getScene()?.globals;
        if (globals && globals.ambient) {
            globals.ambient.skyIllum = 25000;
            globals.ambient.skyColor = new Color(180, 200, 230, 255);
            globals.ambient.groundAlbedo = new Color(120, 120, 130, 255);
        }

        // Shrink the whole tower so it occupies a smaller fraction of the
        // screen. Done in code (rather than on BoardRoot3D's scene node) so
        // the change is guaranteed to take effect even when the Cocos editor
        // has stale in-memory scene state and overwrites the .scene file on
        // its next save. Tune via TOWER_VIEW_SCALE (0.5 = half size, 1 = original).
        if (this.boardRoot3D) {
            this.boardRoot3D.setScale(GameController.TOWER_VIEW_SCALE,
                                       GameController.TOWER_VIEW_SCALE,
                                       GameController.TOWER_VIEW_SCALE);
            log(`[TowerBlocks] tower view scale applied: ${GameController.TOWER_VIEW_SCALE} (boardRoot3D ✓)`);
        } else {
            log('[TowerBlocks] tower view scale SKIPPED — boardRoot3D is null at onLoad!');
        }

        // GameState boots no matter what — even if the prefab/root aren't
        // wired up yet, the logic runs cleanly and just doesn't paint cubes.
        this.gameState = new GameState({
            hooks: {
                onPieceLock:    (piece) => {
                    // Meteor-rain DOT drops sound like slabs of ice
                    // slapping the tower — reuse `hard_drop` for that
                    // "thud" instead of the softer `piece_lock`. Normal
                    // tetrominoes keep the regular lock sound.
                    if (piece && piece.type === 'DOT') {
                        SoundManager.instance?.play('hard_drop');
                    } else {
                        SoundManager.instance?.play('piece_lock');
                    }
                },
                onScoreChanged: (_s) => { /* silent */ },
                onGameOver:     (r) => {
                    log('[TowerBlocks] GAME OVER, reason=', r, '(deferred until effects clear)');
                    this.pendingGameOverReason = r;
                    SoundManager.instance?.play('game_over');
                    // ---- Firebase: stage_fail (custom event) ----
                    // Firebase's predefined `level_end` doesn't cover
                    // "failed with a distinct reason", so we log a
                    // custom stage_fail with the fail-reason string
                    // + mode + level for slicing.
                    AnalyticsApi.logCustom('stage_fail', {
                        mode:   String(this.gameState?.mode ?? 'unknown'),
                        level:  this._activeLevelIdx + 1,
                        reason: String(r ?? 'unknown'),
                    });
                    // ---- Leaderboard submission ----
                    // Endless / blind: submit the tower height reached this run.
                    // Level mode game-over is a FAIL, not a completion — skip.
                    this.submitEndlessHeightIfApplicable('game-over');
                },
                onLevelWin:     ()  => {
                    log('[TowerBlocks] LEVEL WIN (deferred until effects clear)');
                    // Fire the pending flag immediately — drainPendingPopups
                    // still gates on fxStillPlaying (colored-block shatter
                    // animation), so MenuController.showLevelWin only runs
                    // after that natural drain wait. THAT is the moment
                    // scatter + level_win + timer-move-to-center all fire
                    // simultaneously (see MenuController.showLevelWin —
                    // the timer animation is now triggered THERE, at the
                    // scatter-start beat, per user spec:
                    //   1. Colored blocks clear
                    //   2. Gray scatter + level_win SFX + timer move all
                    //      at the same beat
                    //   3. Timer sits at center 2s
                    //   4. Fate modal pops
                    this.pendingLevelWin = true;
                    // Persist the completion so the level-select page can
                    // unlock the next level. Endless mode uses idx = -1
                    // and is skipped here.
                    if (this._activeLevelIdx >= 0) {
                        LevelProgress.markCleared(this._activeLevelIdx);
                        // ---- Leaderboard submission ----
                        // Per-level top-time board. Server stores the top-10
                        // fastest times per level (over-provisioned buffer
                        // so bans / cheat removals can promote replacements
                        // without a re-crawl). Payload is WHOLE SECONDS —
                        // matches HUD display, avoids float noise, and
                        // sorts identically to milliseconds at this
                        // granularity. levelElapsedSec is frozen the moment
                        // running=false is set in maybeFireLevelWin, so
                        // reading it here (or later in MenuController for
                        // the timer display) both see the same value.
                        const elapsedSec = this.gameState?.levelElapsedSec ?? 0;
                        log(`[TowerBlocks] submitting level clear — idx=${this._activeLevelIdx} elapsedSec=${elapsedSec}`);
                        submitLevelTime(this._activeLevelIdx, elapsedSec).catch(err => {
                            console.warn('[TowerBlocks] level time submit failed:', err.message);
                        });
                        // Firebase predefined event — populates Progression
                        // report in the console (stage-N clear rate + time).
                        AnalyticsApi.logLevelEnd('level', this._activeLevelIdx + 1, elapsedSec, true);
                    }
                    // `level_win` SFX intentionally NOT played here —
                    // line_clear + shatter audio is still playing and
                    // would drown it out. MenuController plays it
                    // later when the scatter finishes and we jump
                    // back to the level-select stage (see showLevelWin).
                },
                onPartialShatter: (r, content) => {
                    SoundManager.instance?.play('line_clear');
            HapticsManager.impact('medium');
                    this.onShatter(r, content);
                },
                onCellsFell: moves => this.registerFallAnimations(moves),
                onWreckerPrePulse: (srcR, srcC, picks, comboBoomLevel, comboBombAxis) => {
                    HapticsManager.impact('heavy');
                    // Fire the "wrecker triggered" cue at the moment
                    // the projectiles LAUNCH from the source cell —
                    // the flight + pulse + shatter tail play out with
                    // their own audio (`line_clear` at commit time).
                    SoundManager.instance?.play('wrecker_fire');
                    this.queueWreckerPrePulse(
                        srcR, srcC, picks,
                        comboBoomLevel ?? 0,
                        comboBombAxis ?? null,
                    );
                },
                onWreckerPicksShatter: picks => {
                    this.queueWreckerPicksShatter(picks);
                    // Play the row-clear cue ONCE per wrecker sweep, not
                    // once per pick — 10 simultaneous `line_clear`s
                    // sound like a mud smash. One firm hit + heavy
                    // haptic covers the whole 10-cell demolition.
                    if (picks.length > 0) {
                        SoundManager.instance?.play('line_clear');
                        HapticsManager.impact('heavy');
                    }
                },
                // Rocket/gatling bullets 1:1-cancel a colored cell — reuse
                // the wrecker per-cell shatter path so each hit pops with
                // a flash + 3D chunk burst (matches 拆迁队 visual style).
                // Rocket/gatling: cube disappears instantly (GameState
                // already nulled the cell) and shatter FX fires at the
                // cell's position — reuses the wrecker per-cell shatter.
                onRocketHit:  picks => {
                    this.queueWreckerPicksShatter(picks);
                    // Per-hit SFX — one sound per cell the rocket
                    // erased. `picks` from a rocket-hit callback is
                    // typically a single cell but the array is
                    // future-proofed for range hits, so loop.
                    for (let i = 0; i < picks.length; i++) {
                        SoundManager.instance?.play('rocket_hit');
                        HapticsManager.impact('heavy');
                    }
                },
                onGatlingHit: picks => {
                    this.queueWreckerPicksShatter(picks);
                    // Share the rocket_hit SFX — gatling bullets
                    // 1:1-cancel colored cells the same way rockets
                    // do, so a common "cell hit" cue keeps the audio
                    // palette tight.
                    for (let i = 0; i < picks.length; i++) {
                        SoundManager.instance?.play('rocket_hit');
                        HapticsManager.impact('heavy');
                    }
                },
                // Fire SFX for a rocket storm: play `rocket_fire` three
                // times in quick succession as the salvo takes off —
                // reads as a rat-a-tat launch instead of a single blast.
                // 300ms delay before the first hit so the audio lands
                // with the visible "first rocket appears on screen"
                // moment; 150ms stagger between the three so they stay
                // distinct instead of stacking into one thicker impulse.
                onRocketActivated: () => {
                    HapticsManager.impact('heavy');
                    for (let i = 0; i < 3; i++) {
                        setTimeout(() => SoundManager.instance?.play('rocket_fire'), 300 + i * 150);
                    }
                },
                onGatlingFire: (_col) => {
                    SoundManager.instance?.play('gatling_fire');
                    HapticsManager.impact('medium');
                },
                // Meteor shower per-DOT launch — fires each time a
                // DOT piece spawns. SFX only; no haptic (per-DOT
                // haptic buzz was too busy alongside the rain audio;
                // rocket/gatling still buzz because they're
                // one-shot launches, not a shower).
                onMeteorFire:  ()     => {
                    SoundManager.instance?.play('meteor_fire');
                },
                // Mortar drop lock — play SFX only on the FIRST drop
                // of each storm. Subsequent drops in the same storm
                // are silent (the "first mortar landed" cue is enough,
                // per-drop was too noisy). `onMortarActivated` at
                // storm start re-arms the gate AND plays the shared
                // meteor_fire "rain begins" cue (mortar sounds like
                // meteor rain in this game's palette).
                onMortarActivated: () => {
                    this._mortarLandSfxArmed = true;
                    SoundManager.instance?.play('meteor_fire');
                    HapticsManager.impact('heavy');
                },
                // Endless / blind — 24-col row filled + converted to
                // gray. Play the same `line_clear` cue level mode
                // uses for its shatter clears so both modes share
                // the "row cleared!" audio feel. One play per lock
                // regardless of how many rows converted.
                onEndlessRowsFilled: (_count) => {
                    SoundManager.instance?.play('line_clear');
            HapticsManager.impact('medium');
                },
                onMortarLanded: (_r, _c, _color) => {
                    // Every mortar drop locks a tile into the stack — play
                    // the piece_lock cue so it feels like the block just
                    // landed (mortar's visual outcome IS a locked stack
                    // tile, so the audio matches).
                    SoundManager.instance?.play('piece_lock');
                    // First drop of each storm ALSO plays mortar_land
                    // (the "storm's first hit landed" cue) + a heavier
                    // haptic. Subsequent drops in the same storm get the
                    // piece_lock above only — keeps the audio busy but
                    // not overwhelming when many drops rain at once.
                    if (!this._mortarLandSfxArmed) return;
                    this._mortarLandSfxArmed = false;
                    SoundManager.instance?.play('mortar_land');
                    HapticsManager.impact('heavy');
                },
                // Row bombs re-use the regular row-clear flash (via
                // `onPartialShatter` above): bomb-spliced rows fire
                // onPartialShatter, which dispatches to the rainbow
                // flash like a normal clear.
                //
                // Column bombs get their own visual: a vertical rainbow
                // flash wave that radiates up and down from the bomb's
                // anchor position along that column — same look as the
                // horizontal row-clear flash, but oriented vertically.
                // Range-blast (boom) prop: when an item with
                // `boardBooms[r][c] = 1/2/3` fires, the engine reports
                // the centre + the diamond-shaped list of cleared cells.
                // We re-use the rainbow-flash pool — one flash per
                // cleared cell, time-staggered by Manhattan distance to
                // give a visible "shock-wave from centre" feel.
                onBoomTriggered: (r, c, level, cleared) => {
                    SoundManager.instance?.play('bomb_boom');
                    HapticsManager.impact('heavy');
                    this.queueBoomFlash(r, c, level, cleared);
                },
                onColBombDetonate: (r, c) => {
                    SoundManager.instance?.play('bomb_boom');
                    HapticsManager.impact('heavy');
                    this.queueColFlash(r, c);
                },
                // Shapeshifter (变形) magic item: GameState asks us to
                // open a 7-tetromino picker; the user's choice becomes
                // the argument to `apply`, which swaps the live piece.
                onShapeshifterRequest: (apply) => {
                    if (this.hudController) {
                        this.hudController.showShapeshifterPicker(apply);
                    } else {
                        // No HUD wired (headless / test) — pick a random
                        // shape so the item still resolves rather than
                        // silently doing nothing.
                        const pool: Array<'I'|'O'|'T'|'S'|'Z'|'J'|'L'> =
                            ['I','O','T','S','Z','J','L'];
                        apply(pool[Math.floor(Math.random() * pool.length)]);
                    }
                    SoundManager.instance?.play('item_pick');
                },
                onEndlessMilestone: (_milestone, cumulative) => {
                    this.playMilestoneShatter();
                    // Auto-report the tower height to the leaderboard on
                    // every ENDLESS_AUTO_SUBMIT_INTERVAL layers so a
                    // player who gets killed by app crash / OS-kill /
                    // battery-out mid-run still has SOMETHING recorded.
                    // Without this, only pause-quit and natural game-
                    // over submit — so a 200-layer run that dies to a
                    // background kill loses everything.
                    //
                    // We compare against the last submitted cumulative
                    // instead of using `cumulative % N === 0`, because
                    // a single row-lock can clear multiple layers in
                    // one hop (partial-shatter chains); modulo would
                    // step over the boundary silently in that case.
                    // Fire-and-forget: network failures just log, next
                    // milestone will retry.
                    if (cumulative - this._lastEndlessAutoSubmit >=
                            GameController.ENDLESS_AUTO_SUBMIT_INTERVAL) {
                        this._lastEndlessAutoSubmit = cumulative;
                        this.submitEndlessHeightIfApplicable('milestone-auto');
                    }
                },
            },
        });

        // Levels JSON parsing is independent of any 3D wiring — flatten
        // them up-front so the menu's level-select grid always populates
        // even if the renderer pools fail to build for some reason.
        this.expandLevels();

        if (!this.boardRoot3D) {
            log('[TowerBlocks] ERROR — boardRoot3D is not assigned.');
            return;
        }
        if (!this.cubeManager) {
            log('[TowerBlocks] ERROR — cubeManager is not assigned (drag the CubeManager component in the inspector).');
            return;
        }

        // CubeManager owns every BOARD-CELL pool (brick / row-col blast /
        // stone / wrecker / rocketCube / hail / meteor / gatling / boom)
        // — build them in one call.
        this.cubeManager.buildPools();

        // GameController-owned pools (flash overlay + falling animations).
        // Each pool wrapped in try/catch so a single missing/broken prefab
        // can't take down onLoad — without this, an unhandled throw inside
        // any of these builders leaves the splash screen waiting forever
        // for the scene to report "ready".
        const safeBuild = (label: string, fn: () => void): void => {
            try {
                console.log(`[GC] build ${label} …`);
                fn();
                console.log(`[GC] build ${label} OK`);
            } catch (err) {
                console.warn(`[GC] build ${label} FAILED:`, err);
            }
        };
        safeBuild('flashCube',     () => this.buildFlashCubePool());
        safeBuild('star',          () => this.buildStarPool());
        safeBuild('gatlingBullet', () => this.buildGatlingBulletPool());
        safeBuild('rocket',        () => this.buildRocketPool());
        safeBuild('hailDrop',      () => this.buildHailDropPool());
        safeBuild('mortarDrop',    () => this.buildMortarDropPool());
        safeBuild('rowDetFx',      () => this.buildRowBlastDetonateFx());
        safeBuild('colDetFx',      () => this.buildColBlastDetonateFx());
        safeBuild('warningRing',   () => this.createWarningRing());

        // Probe overlay pools for `mainColor` support — silences the
        // `illegal property name` / `localSetLayout` warnings.
        this.canTintFlash  = this.flashCubeMats.length > 0
            && materialHasProperty(this.flashCubeMats[0], 'mainColor');
        this.canTintStars  = this.starPoolMeshes.length > 0
            && materialHasProperty(this.starPoolMeshes[0].material, 'mainColor');
        log(`[TowerBlocks] tint probe: flash=${this.canTintFlash} stars=${this.canTintStars}`);
    }

    /** Warmup — briefly activate one node from each FX pool so the GPU
     *  driver compiles their shader variants + uploads textures NOW,
     *  rather than the first time a piece locks in gameplay. Pairs
     *  with `warmupCleanup()` a few frames later. Nodes are pushed
     *  off-screen so the player never sees them. */
    public warmupFxActivate(): void {
        // IMPORTANT: DON'T push warmup nodes far off-screen — Cocos
        // frustum-culls anything outside the camera view, and culled
        // nodes never enter the render pipeline, so the shader is
        // NEVER COMPILED. Place them at the world origin (inside the
        // tower / near camera focus) at their natural scale so they
        // enter the render pipeline. During loading the full-screen
        // LoadingPanel overlay hides them from the player.
        const warmupPos = new Vec3(0, 0, 0);
        const activate = (n: Node | undefined | null): void => {
            if (!n) return;
            n.setPosition(warmupPos);
            n.active = true;
        };
        // Activate MULTIPLE flash cubes + stars at once — a real row
        // clear activates 24 simultaneously, and the first-time render
        // at that scale has a batching / draw-call setup cost that's
        // NOT covered by activating a single node. Warming up at the
        // real usage scale flushes that setup during loading.
        const FLASH_WARMUP = 24;
        for (let i = 0; i < FLASH_WARMUP && i < this.flashCubePool.length; i++) {
            activate(this.flashCubePool[i]);
        }
        const STAR_WARMUP = 24;
        for (let i = 0; i < STAR_WARMUP && i < this.starPool.length; i++) {
            activate(this.starPool[i]);
        }
        activate(this.gatlingBulletPool[0]);
        activate(this.rocketPool[0]);
        activate(this.hailDropPool[0]);
        activate(this.mortarDropPool[0]);
        // Also warmup CubeManager's pools in the same frame so the
        // whole texture atlas + material set gets compiled together.
        if (this.cubeManager) this.cubeManager.warmupActivate();
        // Shatter — pre-alloc all colour materials + render one
        // fragment/dust so the row-clear burst doesn't hitch on first
        // Prime every SFX buffer at a MINIMAL non-zero volume so the
        // audio codec actually decodes the clip (Cocos may short-
        // circuit volume=0 playback without triggering decode). This
        // is the most common source of "first play hitch" on Android
        // — mp3/ogg codec kicks in on the very first playOneShot and
        // stalls the main thread for tens of milliseconds.
        try {
            const sm: any = SoundManager.instance;
            if (sm) {
                const keys: string[] = ['rotate_tower','piece_lock','piece_rotate','hard_drop',
                                        'line_clear','bomb_boom','item_pick','ui_click',
                                        'level_win','game_over'];
                for (const k of keys) sm.play(k, 0.0001);
            }
        } catch { /* ignore */ }
    }

    /** Fake elimination — populates flashingCells / prePulseCells /
     *  shatter bursts with synthetic entries at the world origin so
     *  the actual row-clear code paths (not just node activations)
     *  run once during loading. Exercises: shader compile + material
     *  bind + JIT compile of renderFlashingCells / renderPrePulseCells
     *  / renderFallingRockets / etc. + audio decode. Entries are wiped
     *  in warmupFxCleanup a couple frames later so they don't leak
     *  into gameplay. */
    public warmupFakeClear(): void {
        const now = Date.now();
        // 24 fake flash cells at the origin. World Y stays 0 so the
        // whole ring is at the same height. worldYawDeg spreads them
        // around the ring in case any per-cell shader path branches
        // on yaw.
        for (let c = 0; c < 24; c++) {
            // Warmup uses (r=0, c=col) — the whole point is to exercise
            // the flash shader / material bind pipeline before real play,
            // so any valid cell coord works. r=0 keeps them at the top of
            // whatever board is loaded, off-screen during boot.
            this.flashingCells.push({
                r: 0,
                c: c,
                colIndex: c,
                startTime: now,
            });
            // Warmup uses (r=0, c=col) — the whole point is to exercise
            // the shader / material bind pipeline before real play, so
            // any valid cell coord works. r=0 keeps them at the top of
            // whatever board is loaded, off-screen during boot.
            this.prePulseCells.push({
                r: 0,
                c: c,
                startTime: now,
            });
        }
        // Play the line_clear sound at (nearly) zero volume so its
        // audio codec decodes NOW, not on first real clear.
        try {
            SoundManager.instance?.play('line_clear', 0.0001);
        } catch { /* ignore */ }
    }

    /** Clear synthetic entries populated by warmupFakeClear so they
     *  don't leak visually into gameplay. Called from
     *  warmupFxCleanup. */
    public warmupFakeClearCleanup(): void {
        this.flashingCells.length = 0;
        this.prePulseCells.length = 0;
        // Shatter fragments are pool-managed and self-recycle when
        // their lifetime elapses — no explicit cleanup needed, and
        // stopping them mid-fly could corrupt the free-list state.
    }

    public warmupFxCleanup(): void {
        const deactivate = (n: Node | undefined | null): void => {
            if (n) n.active = false;
        };
        // Match the counts activated in warmupFxActivate so nothing
        // leaks past loading.
        const FLASH_WARMUP = 24;
        for (let i = 0; i < FLASH_WARMUP && i < this.flashCubePool.length; i++) {
            deactivate(this.flashCubePool[i]);
        }
        const STAR_WARMUP = 24;
        for (let i = 0; i < STAR_WARMUP && i < this.starPool.length; i++) {
            deactivate(this.starPool[i]);
        }
        deactivate(this.gatlingBulletPool[0]);
        deactivate(this.rocketPool[0]);
        deactivate(this.hailDropPool[0]);
        deactivate(this.mortarDropPool[0]);
        if (this.cubeManager) this.cubeManager.warmupCleanup();
        // Wipe fake-clear synthetic entries so nothing renders past
        // loading. Sound / shatter fragments self-manage.
        this.warmupFakeClearCleanup();
    }

    /** Build the dedicated rainbow-flash cube pool. These are PLAIN box
     *  meshes (1×1×1) with a unlit-transparent material — purposely NOT the
     *  prefab brick (whose vertex layout was authored for the PBR shader and
     *  isn't compatible with `builtin-unlit`, which is what was causing the
     *  `localSetLayout` / `illegal property name: mainColor` errors). */
    private buildFlashCubePool(): void {
        if (!this.boardRoot3D) return;
        const cubeMesh = utils.MeshUtils.createMesh(primitives.box({
            width: CELL_SIZE, height: CELL_SIZE, length: CELL_SIZE,
        }));
        // 128 = up to 5 simultaneous fully-flashing rows (24 cells × 5 + slack).
        // Row blast (rowN bomb) clears N rows AND now flashes every cell across
        // each row regardless of content, so the pool needs more headroom than
        // the old "one row at a time" sizing.
        const FLASH_POOL_SIZE = 128;
        for (let i = 0; i < FLASH_POOL_SIZE; i++) {
            const n = new Node(`Flash_${i}`);
            n.parent = this.boardRoot3D;
            n.layer  = this.boardRoot3D.layer;
            n.active = false;
            const mr = n.addComponent(MeshRenderer);
            mr.mesh = cubeMesh;
            const mat = new Material();
            mat.initialize({ effectName: 'builtin-unlit', technique: 1 });
            mat.setProperty('mainColor', new Color(255, 255, 255, 153));
            mr.material = mat;
            this.flashCubePool.push(n);
            this.flashCubeMRs.push(mr);
            // Re-fetch the per-instance material so subsequent setProperty
            // calls modify the instance and not the shared template.
            this.flashCubeMats.push(mr.material);
        }
        log(`[TowerBlocks] flash cube pool built: ${FLASH_POOL_SIZE} slots.`);
    }

    /** Build the star-pool used by the rainbow-flash sparkle effect. Each
     *  star is a small unlit cube on a shared base mesh (per-instance
     *  material so colour can be set per-spark). */
    private buildStarPool(): void {
        if (!this.boardRoot3D) return;
        // Small cube as the base star shape. We mutate node scale per-frame
        // to grow / shrink — and a cube reads as a sharp diamond at small
        // sizes regardless of viewing angle.
        const starMesh = utils.MeshUtils.createMesh(primitives.box({
            width: 1, height: 1, length: 1,
        }));
        const STAR_POOL_SIZE = 512;
        for (let i = 0; i < STAR_POOL_SIZE; i++) {
            const n = new Node(`Star_${i}`);
            n.parent = this.boardRoot3D;
            n.layer  = this.boardRoot3D.layer;
            n.active = false;
            const mr = n.addComponent(MeshRenderer);
            mr.mesh = starMesh;
            const mat = new Material();
            mat.initialize({ effectName: 'builtin-unlit' });
            mat.setProperty('mainColor', new Color(255, 255, 255, 255));
            mr.material = mat;
            this.starPool.push(n);
            this.starPoolMeshes.push(mr);
        }
        log(`[TowerBlocks] star pool built: ${STAR_POOL_SIZE} sparks.`);
    }


    /** Instantiate one bullet node from the shared `Cube.prefab` (same
     *  brick asset the board cubes and meteor DOTs use). Tint deep-red
     *  via a per-instance material so it visually reads as "hostile
     *  projectile" while keeping the same silhouette as the board
     *  bricks. Returns null if `cubeManager.cubePrefab` isn't wired. */
    private makeBulletCubeNode(name: string): Node | null {
        const prefab = this.cubeManager?.cubePrefab;
        // Parent to CubeManager's own boardRoot3D — this is the node
        // CubeManager positions the TOWER cubes under. If GameController's
        // own `boardRoot3D` prop points somewhere else in the scene, the
        // bullets would ride a different parent transform and drift out
        // of column alignment with the tower. Prefer cubeManager's slot
        // and fall back to ours only if unwired.
        const parent = this.cubeManager?.boardRoot3D ?? this.boardRoot3D;
        if (!prefab || !parent) return null;
        const n = instantiate(prefab);
        n.name = name;
        n.parent = parent;
        n.layer  = parent.layer;
        n.active = false;
        const s = n.scale;
        // Match the board bricks' size exactly — CUBE_VISUAL is the
        // same multiplier CubeManager.buildBrickPool applies, so the
        // bullet reads as "same brick as the tower" rather than a
        // shrunken projectile.
        n.setScale(s.x * CUBE_VISUAL, s.y * CUBE_VISUAL, s.z * CUBE_VISUAL);
        const mr = n.getComponent(MeshRenderer) ?? n.getComponentInChildren(MeshRenderer);
        if (mr) {
            // Per-instance material (Cocos lazy `mr.material` copy) so
            // tinting doesn't leak into the shared brick material.
            const mat = mr.material;
            if (mat) {
                mat.setProperty('mainColor', new Color(140, 30, 30, 255));
            }
        }
        return n;
    }

    /** Build a pool of rocket-projectile instances. ROCKET_TOTAL (24)
     *  rockets can be in-flight simultaneously, plus a small buffer
     *  for safety. Bullets render as deep-red `Cube.prefab` instances
     *  — same brick silhouette as meteor DOTs, tinted red per instance. */
    private buildRocketPool(): void {
        if (!this.boardRoot3D) return;
        const POOL_SIZE = 32;   // ROCKET_TOTAL is 24, +8 buffer
        for (let i = 0; i < POOL_SIZE; i++) {
            const n = this.makeBulletCubeNode(`Rocket_${i}`);
            if (!n) {
                log('[TowerBlocks] rocket pool: cubeManager.cubePrefab not wired, aborting.');
                return;
            }
            this.rocketPool.push(n);
        }
        log(`[TowerBlocks] rocket pool built: ${POOL_SIZE} red-brick bullets.`);
    }

    /** Build a pool of gatling "bullets" — same deep-red `Cube.prefab`
     *  as the rocket pool. Meteor-DOT visual language across the board. */
    private buildGatlingBulletPool(): void {
        if (!this.boardRoot3D) return;
        const POOL_SIZE = 40;       // GATLING_TOTAL (12) + safety
        for (let i = 0; i < POOL_SIZE; i++) {
            const n = this.makeBulletCubeNode(`GatlingBullet_${i}`);
            if (!n) {
                log('[TowerBlocks] gatling pool: cubeManager.cubePrefab not wired, aborting.');
                return;
            }
            this.gatlingBulletPool.push(n);
        }
        log(`[TowerBlocks] gatling bullet pool built: ${POOL_SIZE} red-brick bullets.`);
    }

    /** Position one rocket per in-flight gatling bullet from
     *  `gameState.gatling.getFalling()`.
     *
     *  All bullets render at the SAME local column —
     *  `currentCenterCol()` — so they appear at the camera-facing
     *  front of the cylinder. Because that local column is whatever
     *  the tower's current rotation puts at the world origin
     *  (0, _, RADIUS), rotating the tower mid-storm doesn't visually
     *  shift the bullets — they stay locked to screen centre.
     *
     *  Rotation matches the rocket storm: X=180° flips the model's
     *  +Y "nose" downward, and the Y rotation aligns the prefab's
     *  "front" with the cylinder's outward normal. */
    private renderFallingGatling(totalRows: number): void {
        if (!this.gameState || this.gatlingBulletPool.length === 0) return;
        this.gatlingBulletCursor = 0;
        const falling = this.gameState.gatling.getFalling();

        // Meteor-shower style: ALL bullets render at the screen-fixed
        // centre column (whatever the camera faces this frame). The
        // bullets do NOT visually rotate with the tower — rotating
        // the cylinder brings a different column under the same
        // screen-centre stream. GatlingState.tick keeps every
        // in-flight bullet's logical `col` synced to that same
        // screen column, so the cube that disappears is always the
        // one visibly under the bullets.
        const camCol = this.currentCenterCol();
        const theta  = camCol * ANGLE_PER_COL;
        const x      = RADIUS * Math.sin(theta);
        const z      = RADIUS * Math.cos(theta);
        const yawDeg = math.toDegree(theta) + 180;

        for (const b of falling) {
            if (this.gatlingBulletCursor >= this.gatlingBulletPool.length) break;
            const node = this.gatlingBulletPool[this.gatlingBulletCursor];
            this.gatlingBulletCursor++;
            if (!node.active) node.active = true;

            const y = Y_BOTTOM + ((totalRows - 1) - b.y) * CELL_SIZE;
            node.setPosition(x, y, z);
            // Cube.prefab brick — same X=90 orientation as board bricks
            // so the curved face points outward along the cylinder.
            node.setRotationFromEuler(90, yawDeg, 0);
        }
        for (let i = this.gatlingBulletCursor; i < this.gatlingBulletPool.length; i++) {
            if (this.gatlingBulletPool[i].active) this.gatlingBulletPool[i].active = false;
        }
    }

    /** Place one rocket node per in-flight projectile read from
     *  `gameState.rocket.getFalling()`. Y position comes from the
     *  projectile's float `y` (a continuous row coordinate that starts
     *  NEGATIVE — above the visible top — and ticks toward the reserved
     *  zone). Rotation flips the model 180° around X so the authored
     *  +Y "nose" points downward as the rocket falls. */
    private renderFallingRockets(totalRows: number): void {
        if (!this.gameState || this.rocketPool.length === 0) return;
        this.rocketCursor = 0;
        const falling = this.gameState.rocket.getFalling();
        for (const rk of falling) {
            if (this.rocketCursor >= this.rocketPool.length) break;
            const node = this.rocketPool[this.rocketCursor];
            this.rocketCursor++;
            if (!node.active) node.active = true;

            const theta = rk.col * ANGLE_PER_COL;
            const x = RADIUS * Math.sin(theta);
            const z = RADIUS * Math.cos(theta);
            // rk.y is a float row coord. Same Y formula as a brick
            // cell, just with continuous y instead of an int row.
            const y = Y_BOTTOM + ((totalRows - 1) - rk.y) * CELL_SIZE;
            node.setPosition(x, y, z);
            // Cube.prefab brick — same X=90 orientation as board bricks
            // so the curved face points outward along the cylinder.
            node.setRotationFromEuler(90, math.toDegree(theta) + 180, 0);
        }
        // Hide any rocket slots not used this frame.
        for (let i = this.rocketCursor; i < this.rocketPool.length; i++) {
            if (this.rocketPool[i].active) this.rocketPool[i].active = false;
        }
    }

    /** Build the pool of icy spheres used for in-flight hail projectiles.
     *  Sized to `HAIL_TOTAL` (72) + a small buffer; reused across waves. */
    private buildHailDropPool(): void {
        if (!this.boardRoot3D) return;
        // Low-segment sphere — small + many of them, no need for smoothness.
        const mesh = utils.MeshUtils.createMesh(primitives.sphere(0.5, {
            segments: 10,
        }));
        const POOL_SIZE = 80;
        for (let i = 0; i < POOL_SIZE; i++) {
            const n = new Node(`HailDrop_${i}`);
            n.parent = this.boardRoot3D;
            n.layer  = this.boardRoot3D.layer;
            n.active = false;
            const mr = n.addComponent(MeshRenderer);
            mr.mesh = mesh;
            const mat = new Material();
            // Transparent unlit so the icy tint reads cleanly against
            // both the cylinder wall and the dark backdrop.
            mat.initialize({ effectName: 'builtin-unlit', technique: 1 });
            mat.setProperty('mainColor', this.hailDropColor);
            mr.material = mat;
            this.hailDropPool.push(n);
        }
        log(`[TowerBlocks] hail drop pool built: ${POOL_SIZE} spheres.`);
    }

    /** Position one sphere per in-flight hail drop from
     *  `gameState.hail.getFalling()`. Like the rocket projectile
     *  renderer, `y` is a continuous float row coord that starts
     *  negative (above the visible top) and increases until landing
     *  at `targetR`. */
    private renderFallingHail(totalRows: number): void {
        if (!this.gameState || this.hailDropPool.length === 0) return;
        this.hailDropCursor = 0;
        const falling = this.gameState.hail.getFalling();
        const size = this.hailDropSize * CUBE_VISUAL;
        for (const h of falling) {
            if (this.hailDropCursor >= this.hailDropPool.length) break;
            const node = this.hailDropPool[this.hailDropCursor];
            this.hailDropCursor++;
            if (!node.active) node.active = true;

            const theta = h.col * ANGLE_PER_COL;
            const x = RADIUS * Math.sin(theta);
            const z = RADIUS * Math.cos(theta);
            const y = Y_BOTTOM + ((totalRows - 1) - h.y) * CELL_SIZE;
            node.setPosition(x, y, z);
            node.setScale(size, size, size);
        }
        for (let i = this.hailDropCursor; i < this.hailDropPool.length; i++) {
            if (this.hailDropPool[i].active) this.hailDropPool[i].active = false;
        }
    }

    /** Build the pool of small cubes used for in-flight mortar drops.
     *  Sized generously since one full mortar fire can target every
     *  empty cell on the playfield — caps at the visible playfield row
     *  count × column count + buffer. Each cube starts white and gets
     *  re-tinted per frame to match its drop's `color`. */
    private buildMortarDropPool(): void {
        const prefab = this.cubeManager?.cubePrefab;
        const parent = this.cubeManager?.boardRoot3D ?? this.boardRoot3D;
        if (!prefab || !parent) {
            log('[TowerBlocks] mortar drop pool: cubeManager.cubePrefab or boardRoot3D missing, aborting.');
            return;
        }
        const POOL_SIZE = 256;
        for (let i = 0; i < POOL_SIZE; i++) {
            const n = instantiate(prefab);
            n.name = `MortarDrop_${i}`;
            n.parent = parent;
            n.layer  = parent.layer;
            n.active = false;
            // Same scale mult tower bricks get.
            const s = n.scale;
            n.setScale(s.x * CUBE_VISUAL, s.y * CUBE_VISUAL, s.z * CUBE_VISUAL);
            // Grab the MeshRenderer + material for per-frame tinting.
            const mr = n.getComponent(MeshRenderer) ?? n.getComponentInChildren(MeshRenderer);
            let mat: Material | null = null;
            if (mr) mat = mr.material;
            this.mortarDropPool.push(n);
            this.mortarDropMats.push(mat as Material);
        }
        log(`[TowerBlocks] mortar drop pool built: ${POOL_SIZE} Cube.prefab bricks.`);
    }

    /** Position one cube per in-flight mortar drop from
     *  `gameState.mortar.getFalling()`. Same float-row treatment as
     *  hail; each drop's material `mainColor` is updated to match the
     *  colour it will stamp on the board on landing. */
    private renderFallingMortar(totalRows: number): void {
        if (!this.gameState || this.mortarDropPool.length === 0) return;
        this.mortarDropCursor = 0;
        const falling = this.gameState.mortar.getFalling();
        for (const m of falling) {
            if (this.mortarDropCursor >= this.mortarDropPool.length) break;
            const node = this.mortarDropPool[this.mortarDropCursor];
            const mat  = this.mortarDropMats[this.mortarDropCursor];
            this.mortarDropCursor++;
            if (!node.active) node.active = true;

            const theta = m.col * ANGLE_PER_COL;
            const x = RADIUS * Math.sin(theta);
            const z = RADIUS * Math.cos(theta);
            const y = Y_BOTTOM + ((totalRows - 1) - m.y) * CELL_SIZE;
            node.setPosition(x, y, z);
            // Cube.prefab brick — same X=90 orientation as board bricks
            // so the curved face points outward along the cylinder.
            node.setRotationFromEuler(90, math.toDegree(theta) + 180, 0);
            // Scale is fixed at pool-build time — the prefab has its
            // own baseline scale that we already multiplied by
            // CUBE_VISUAL. Skip resetting here (avoids overwriting the
            // brick's authored scale each frame).

            // Tint to match the colour the drop will stamp on landing.
            if (mat) {
                const hex = COLORS[m.color as CellValue] || '#ffffff';
                mat.setProperty('mainColor', hexToColor(hex));
            }
        }
        for (let i = this.mortarDropCursor; i < this.mortarDropPool.length; i++) {
            if (this.mortarDropPool[i].active) this.mortarDropPool[i].active = false;
        }
    }

    /** Per-frame trail update: emit rainbow star sparks at each falling
     *  rocket/gatling bullet's tail — matches the "single cube
     *  elimination" FX. */
    private stepRocketTrail(dt: number): void {
        if (!this.gameState) return;

        // ---- 1. Emit trail sparks at each bullet's tail ----
        const rows         = this.gameState.state.board.length;
        const yOffset      = this.boardYOffset(rows);
        const rocketFall   = this.gameState.rocket.getFalling();
        const gatlingFall  = this.gameState.gatling.getFalling();
        // Board yaw for world-position rotation (shared with the
        // shatter/star spawner's coordinate convention).
        const centerCol = this.currentCenterCol();
        const boardYawDeg = -math.toDegree(centerCol * ANGLE_PER_COL);
        const yawRad = math.toRadian(boardYawDeg);
        const cosY = Math.cos(yawRad), sinY = Math.sin(yawRad);

        // Throttle: burst every `spawnEveryMs` per bullet — spawnStarsAt
        // launches `flashStarsPerCell` sparks per call, and per-frame
        // per-bullet would overwhelm the star pool. ~50ms per bullet
        // reads as a continuous sparkle stream at 60 fps.
        const spawnEveryMs = 50;
        this.rocketTrailStarAccumMs += dt * 1000;
        const shouldEmit = this.rocketTrailStarAccumMs >= spawnEveryMs;
        if (shouldEmit) {
            this.rocketTrailStarAccumMs -= spawnEveryMs;
            // Trail sparks read best small + short-lived — a big
            // burst per bullet per 50ms feels overwhelming. 0.4 gets
            // us "fine sparkle dust" instead of "cube-shatter cloud".
            const TRAIL_SIZE = 0.4;
            // Match the Cube.prefab mesh offset — bullets and the
            // eventual shatter FX both live at (RADIUS - CELL_SIZE/2)
            // radially and Y + CELL_SIZE vertically. Without matching
            // the trail here, sparks emit from the bullet's NODE
            // position (outer-face + one row below), not from the
            // brick's visual centre — user sees the trail floating
            // beside/below the actual projectile.
            const trailRadius = RADIUS - CELL_SIZE * 0.5;
            const trailYBump  = CELL_SIZE;
            for (const rk of rocketFall) {
                const cellTheta = rk.col * ANGLE_PER_COL;
                const localX    = trailRadius * Math.sin(cellTheta);
                const localZ    = trailRadius * Math.cos(cellTheta);
                const worldX    = cosY * localX + sinY * localZ;
                const worldZ    = -sinY * localX + cosY * localZ;
                const rocketY   = Y_BOTTOM + ((rows - 1) - rk.y) * CELL_SIZE;
                const worldY    = rocketY + yOffset + trailYBump;
                this.spawnStarsAt(worldX, worldY, worldZ, cellTheta, boardYawDeg, TRAIL_SIZE);
            }
            for (const gk of gatlingFall) {
                const cellTheta = centerCol * ANGLE_PER_COL;
                // Gatling bullets are pinned to the camera-facing
                // column. Applying the -CELL_SIZE/2 radial offset in
                // local space (same as rocketFall above) becomes a
                // constant Z offset after the identity Y rotation.
                const worldX    = 0;
                const worldZ    = trailRadius;
                const rocketY   = Y_BOTTOM + ((rows - 1) - gk.y) * CELL_SIZE;
                const worldY    = rocketY + yOffset + trailYBump;
                this.spawnStarsAt(worldX, worldY, worldZ, cellTheta, boardYawDeg, TRAIL_SIZE);
            }
        }
        // No projectiles in flight — keep the accumulator drained so
        // the first tick of the next storm doesn't burst.
        if (rocketFall.length === 0 && gatlingFall.length === 0) {
            this.rocketTrailStarAccumMs = 0;
        }
    }


    /** Flatten the @property levels[] into an explicit LevelData array,
     *  expanding any `{ levels: [...] }` bundle files into their members. */
    private expandLevels(): void {
        this.flatLevels = [];
        for (const asset of this.levels) {
            if (!asset || !asset.json) continue;
            const j = asset.json as { levels?: unknown[]; taskHeight?: number };
            if (Array.isArray(j.levels)) {
                // Bundle format.
                for (const lvl of j.levels) {
                    this.flatLevels.push(lvl as LevelData);
                }
            } else if (j.taskHeight !== undefined) {
                // Single-level format.
                this.flatLevels.push(asset.json as LevelData);
            }
        }
        log(`[TowerBlocks] expanded levels: ${this.flatLevels.length} total`);
    }

    /** Build the warning-line — a dashed front-half ring around the cylinder.
     *  Only the 180° facing the camera is drawn (back half clipped). Each
     *  dash is its own MeshRenderer node sharing one torus-segment mesh. */
    private createWarningRing(): void {
        if (!this.boardRoot3D) return;
        const root = new Node('WarningRing');
        root.parent = this.boardRoot3D;
        root.layer = this.boardRoot3D.layer;

        // Geometry: thin torus segment for one dash. Dashes tile around the
        // front half-circle (180°) with equal dash/gap arcs.
        const DASH_COUNT = 12;
        const TUBE       = 0.02;                          // 1/3 of the original 0.06
        const RING_R     = RADIUS + 0.35;
        const FRONT_ARC  = Math.PI;                       // 180° front half only
        const DASH_ARC   = FRONT_ARC / (DASH_COUNT * 2);  // dash + gap each = DASH_ARC

        const dashMesh = utils.MeshUtils.createMesh(primitives.torus(RING_R, TUBE, {
            radialSegments: 8,
            tubularSegments: 6,
            arc: DASH_ARC,
        }));

        // Bright red emissive material; one instance shared by all dashes.
        const mat = new Material();
        if (this.cubeMaterial) mat.copy(this.cubeMaterial);
        else mat.initialize({ effectName: 'builtin-standard' });
        mat.setProperty('mainColor', new Color(255, 60, 50, 255));
        mat.setProperty('emissive', new Color(220, 30, 20, 255));

        // Lay dashes around -90° → +90° around Y axis (the front half).
        for (let i = 0; i < DASH_COUNT; i++) {
            const startAng = -Math.PI / 2 + i * (DASH_ARC * 2);
            const dash = new Node(`Dash_${i}`);
            dash.parent = root;
            dash.layer = root.layer;
            const mr = dash.addComponent(MeshRenderer);
            mr.mesh = dashMesh;
            mr.material = mat;
            dash.setRotationFromEuler(0, math.toDegree(startAng), 0);
        }

        root.active = false;
        this.warningRing = root;
    }

    /**
     * Build the 闭眼模式 light beam — a slim vertical box that locks
     * onto the tower column closest to the camera. The beam is parented
     * to `boardRoot3D` so the game's yaw + Y-scroll carry it along with
     * the tower cells; `updateBlindBeamPose` writes its LOCAL transform
     * every frame to place it exactly where a cube for the current
     * `Math.round(centerCol)` would sit. That way the beam and the
     * front-facing cube share the same world position and rotation,
     * even during smooth rotation animation (fractional centerCol) —
     * the beam drifts with the tower rather than floating in dead
     * center while the cubes slide past it.
     *
     * Sizing:
     *   - Width = CELL_SIZE (world units) → matches one cube's front-
     *     face width, so the beam looks exactly one cell wide.
     *   - Height 60 world units → covers the ortho camera's ±10 window
     *     with generous head/foot room in every scroll state.
     *   - Depth 0.08 → thin so it reads as a plane of light, not a wall.
     *
     * Default state: hidden. `setBlindBeamVisible(true)` from
     * `startBlind` turns it on; toggled off when leaving blind mode.
     * Idempotent.
     */
    private createBlindBeam(): void {
        if (!this.boardRoot3D) return;
        if (this.blindBeamNode) return;   // idempotent — build once

        const BEAM_WIDTH  = CELL_SIZE;
        const BEAM_HEIGHT = CELL_SIZE * 60;
        const BEAM_DEPTH  = 0.08;
        const mesh = utils.MeshUtils.createMesh(primitives.box({
            width: BEAM_WIDTH, height: BEAM_HEIGHT, length: BEAM_DEPTH,
        }));

        const beam = new Node('BlindColumnBeam');
        beam.parent = this.boardRoot3D;
        beam.layer  = this.boardRoot3D.layer;
        const mr = beam.addComponent(MeshRenderer);
        mr.mesh = mesh;

        // Warm-gold unlit material with alpha so it reads as light
        // rather than a solid pillar. technique 1 of builtin-unlit
        // is the transparent pass.
        const mat = new Material();
        mat.initialize({ effectName: 'builtin-unlit', technique: 1 });
        mat.setProperty('mainColor', new Color(255, 220, 90, 130));
        mr.material = mat;

        // Initial pose — updated per frame; the once-off setup here
        // just avoids a frame of undefined position before the first
        // updateBlindBeamPose fires.
        beam.setPosition(0, 0, RADIUS + 0.05);
        beam.active = false;
        this.blindBeamNode = beam;
    }

    /** Per-frame: place the blind-mode beam at the same local position
     *  and orientation that a cube for `col = Math.round(centerCol)`
     *  would use. Called from `syncCubes` while mode === 'blind'.
     *
     *  Rounding to the nearest integer column snaps the beam to a
     *  specific tower cell so it never floats "between" cubes; the
     *  small residual drift (up to ½ column arc, ~7.5° at 24 columns)
     *  is what the player sees as the beam sliding a hair with the
     *  tower — which is what the user asked for. */
    private updateBlindBeamPose(centerCol: number): void {
        if (!this.blindBeamNode) return;
        const col   = Math.round(centerCol);
        const theta = col * ANGLE_PER_COL;
        // Radial offset: sit just outside the cube surface so we don't
        // z-fight with the front-column cubes when `blindShowTowerDebug`
        // is on. Uses the SAME radius the cube placement code uses.
        const r = RADIUS + 0.05;
        this.blindBeamNode.setPosition(
            r * Math.sin(theta),
            0,
            r * Math.cos(theta),
        );
        // Local Y-rotation matches the cube's angular position around
        // the cylinder. After boardRoot3D yaws by -centerCol*ANGLE the
        // world-space rotation becomes (col - centerCol)*ANGLE — a
        // fraction of a column at most, small enough that the beam
        // still reads as facing the camera.
        this.blindBeamNode.setRotationFromEuler(0, math.toDegree(theta), 0);
    }

    /** Toggle the 3D blind-mode beam. Lazy-builds on first call so we
     *  don't pay the mesh allocation on non-blind sessions. */
    public setBlindBeamVisible(on: boolean): void {
        if (on && !this.blindBeamNode) this.createBlindBeam();
        if (this.blindBeamNode) this.blindBeamNode.active = on;
    }

    start(): void {
        if (!this.gameState) return;
        // Don't auto-start a game — MenuController kicks off endless/level mode
        // once the player picks. We just mark not-running so update() is a no-op.
        this.gameState.running = false;
        log('[TowerBlocks] GameController ready, waiting for menu selection.');
        input.on(Input.EventType.KEY_DOWN, this.onKeyDown, this);
        input.on(Input.EventType.KEY_UP,   this.onKeyUp,   this);
        // Touch / mouse drag.
        input.on(Input.EventType.TOUCH_START,  this.onTouchStart, this);
        input.on(Input.EventType.TOUCH_MOVE,   this.onTouchMove,  this);
        input.on(Input.EventType.TOUCH_END,    this.onTouchEnd,   this);
        input.on(Input.EventType.TOUCH_CANCEL, this.onTouchEnd,   this);
        if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
            window.addEventListener('keydown', this.onDomKeyDown);
            window.addEventListener('keyup',   this.onDomKeyUp);
        }
        this._wireRotateButtons();
        this._refreshControlModeUi();
        // Live-update the on-screen rotate buttons when the player
        // changes the control scheme from the Settings picker.
        subscribeSettings(() => this._refreshControlModeUi());
    }

    // ---- On-screen rotate buttons (buttons mode) ----
    private _wireRotateButtons(): void {
        const bind = (btn: Button | null, dir: 1 | -1): void => {
            if (!btn) return;
            btn.node.off(Node.EventType.TOUCH_START);
            btn.node.off(Node.EventType.TOUCH_END);
            btn.node.off(Node.EventType.TOUCH_CANCEL);
            btn.node.on(Node.EventType.TOUCH_START, () => this._rotateButtonHold(dir), this);
            btn.node.on(Node.EventType.TOUCH_END,   () => this._rotateButtonRelease(),  this);
            btn.node.on(Node.EventType.TOUCH_CANCEL,() => this._rotateButtonRelease(),  this);
        };
        bind(this.authoredRotateLeftButton,  -1);
        bind(this.authoredRotateRightButton, +1);
        // Hard-drop button — single click fires hardDrop, no hold repeat.
        if (this.authoredHardDropButton) {
            this.authoredHardDropButton.node.off('click');
            this.authoredHardDropButton.node.on('click', () => {
                if (!this.gameState) return;
                this.gameState.hardDrop();
                SoundManager.instance?.play('hard_drop');
            }, this);
        }
        // Rotate-piece (变形) button — single click fires tryRotate(1).
        if (this.authoredRotatePieceButton) {
            this.authoredRotatePieceButton.node.off('click');
            this.authoredRotatePieceButton.node.on('click', () => {
                if (!this.gameState) return;
                this.gameState.tryRotate(1);
                SoundManager.instance?.play('piece_rotate');
            }, this);
        }
        // Suppress the generic ui_click SFX on the 4 game-action
        // buttons — each already fires its own action-specific SFX
        // (rotate_tower / hard_drop / piece_rotate) and stacking
        // ui_click on top makes the audio muddy.
        SoundManager.suppressClickSound(this.authoredRotateLeftButton);
        SoundManager.suppressClickSound(this.authoredRotateRightButton);
        SoundManager.suppressClickSound(this.authoredHardDropButton);
        SoundManager.suppressClickSound(this.authoredRotatePieceButton);
    }

    /** Central "player tried to rotate the tower one column" side-effects.
     *  Called from every input path (buttons, keyboard, touch drag/fling,
     *  legacy swipe). Picks the SFX based on whether the piece actually
     *  moved — a rotate that got jammed by the falling piece plays
     *  rotate_blocked instead of rotate_tower so the audio matches what
     *  the player sees. Haptic is fired unconditionally (feels right for
     *  both "click" and "thunk"). */
    private _tryRotateTower(dir: 1 | -1): void {
        if (!this.gameState) return;
        const moved = this.gameState.moveCylinder(dir);
        SoundManager.instance?.play(moved ? 'rotate_tower' : 'rotate_blocked');
        HapticsManager.impact('light');
    }

    private _rotateButtonHold(dir: 1 | -1): void {
        if (!this.gameState) return;
        // First tap: single step immediately. The repeat interval is
        // DELAYED by BTN_HOLD_START_MS so a normal tap (< ~350 ms) only
        // fires the initial move and never enters continuous mode —
        // fixes the "one tap rotates 2 columns" bug where the interval's
        // 80 ms firing beat the TOUCH_END clear on average taps.
        this._tryRotateTower(dir);
        // Clear any leftover handles from a previous press.
        if (this._btnHoldHandle !== null) clearInterval(this._btnHoldHandle);
        if (this._btnHoldDelayHandle !== null) clearTimeout(this._btnHoldDelayHandle);
        this._btnHoldDelayHandle = setTimeout(() => {
            this._btnHoldDelayHandle = null;
            this._btnHoldHandle = setInterval(() => {
                if (!this.gameState) return;
                this._tryRotateTower(dir);
            }, GameController.HOLD_REPEAT_MS);
        }, GameController.BTN_HOLD_START_MS);
    }

    private _rotateButtonRelease(): void {
        if (this._btnHoldDelayHandle !== null) {
            clearTimeout(this._btnHoldDelayHandle);
            this._btnHoldDelayHandle = null;
        }
        if (this._btnHoldHandle !== null) {
            clearInterval(this._btnHoldHandle);
            this._btnHoldHandle = null;
        }
    }

    /** True while gameplay UI is visible on screen — driven by
     *  MenuController.setGameplayVisible() so mode-select / level-
     *  select screens can hide the on-screen action buttons even
     *  when control mode = 'buttons'. */
    private _gameplayVisible: boolean = false;

    /** True while the new-player tutorial is running — forces ALL
     *  four action buttons hidden regardless of control mode, so the
     *  tutorial's own hand-demo isn't buried under keyboard buttons. */
    private _tutorialActive: boolean = false;

    /** Public hook so MenuController can flip the gameplay-visible
     *  flag when the player enters / leaves a level. Repaints the
     *  button UI immediately. */
    public setGameplayUiVisible(on: boolean): void {
        this._gameplayVisible = on;
        this._refreshControlModeUi();
    }

    /** Public hook for TutorialController: while a tutorial is
     *  running, hide all 4 action buttons regardless of control mode. */
    public setTutorialActive(on: boolean): void {
        this._tutorialActive = on;
        this._refreshControlModeUi();
    }

    /** Show/hide the on-screen action buttons based on control mode
     *  AND gameplay visibility. Rotate L/R belong to buttons mode
     *  only; hard-drop + rotate-piece are gameplay-only regardless
     *  of mode (they replace touch input that also is gameplay-only).
     *  On level-select / main-menu screens, ALL four stay hidden. */
    public _refreshControlModeUi(): void {
        const buttonsMode = getControlMode() === 'buttons';
        const showRotate  = buttonsMode && this._gameplayVisible && !this._tutorialActive;
        const showAction  = this._gameplayVisible && !this._tutorialActive; // hard-drop + rotate-piece
        if (this.authoredRotateButtonsGroup) {
            this.authoredRotateButtonsGroup.active = showRotate;
        } else {
            if (this.authoredRotateLeftButton)  this.authoredRotateLeftButton.node.active  = showRotate;
            if (this.authoredRotateRightButton) this.authoredRotateRightButton.node.active = showRotate;
        }
        if (this.authoredHardDropButton)     this.authoredHardDropButton.node.active     = showAction;
        if (this.authoredRotatePieceButton)  this.authoredRotatePieceButton.node.active  = showAction;
    }

    onDestroy(): void {
        input.off(Input.EventType.KEY_DOWN, this.onKeyDown, this);
        input.off(Input.EventType.KEY_UP,   this.onKeyUp,   this);
        input.off(Input.EventType.TOUCH_START,  this.onTouchStart, this);
        input.off(Input.EventType.TOUCH_MOVE,   this.onTouchMove,  this);
        input.off(Input.EventType.TOUCH_END,    this.onTouchEnd,   this);
        input.off(Input.EventType.TOUCH_CANCEL, this.onTouchEnd,   this);
        if (typeof window !== 'undefined' && typeof window.removeEventListener === 'function') {
            window.removeEventListener('keydown', this.onDomKeyDown);
            window.removeEventListener('keyup',   this.onDomKeyUp);
        }
    }

    update(deltaTime: number): void {
        if (!this.gameState) return;
        // Level assembly is in progress — tweens on `boardRoot3D`
        // children own the cube transforms this frame; skip tick +
        // syncCubes so we don't fight them.
        if (this._assembling) return;
        // Tower fling-spin (post-swipe inertia). Runs each frame while
        // active; stops itself when friction bleeds velocity below the
        // min threshold. A fresh onTouchStart cancels it via the state
        // reset in that handler.
        this.stepTowerFling(deltaTime);
        this.gameState.tick(deltaTime * 1000);
        // Advance the camera-tracking offset FIRST so the piece-realign
        // step and the cube sync below both read the current snapped
        // value. Without this, the very first frame of a new game would
        // realign the spawned piece against a stale offset.
        this.updateBoardYOffset();
        // Detect a fresh spawn (the GameState swapped `current` to a new
        // Piece this tick) and pull its starting Y down to the top of
        // the visible window. Without this, on tall levels (or whenever
        // the camera has slid down to follow the stack) the piece would
        // spawn many rows above the screen and the player would watch
        // empty space for several seconds before it appears.
        const cur = this.gameState.current ?? null;
        if (cur && cur !== this.prevPieceRef) {
            this.realignPieceSpawnRow(cur);
        }
        this.prevPieceRef = cur;
        this.processHeldKeys();
        if (!this.cubeManager) return;          // no CubeManager wired, nothing to paint
        this.firePendingRibbonTriggers();
        this.cubeManager?.stepRocketPropFX(deltaTime);
        this.stepAndRenderStars(deltaTime);
        this.stepRocketTrail(deltaTime);
        // Wrecker pulse window expired? Then commit the queued clear.
        this.drainWreckerPulse();
        // Release any queued fall animations as soon as the row-clear
        // flash / ribbon detonation / shatter dust have finished — the
        // blocks drop AFTER the FX, not during them.
        this.drainPendingFallAnimations();
        this.syncCubes();
        this.rotateCylinder();
        // Order matters. FATE MODAL first — if both fate + energy
        // picker are pending on the same lock (20-layer milestone that
        // also filled the bar), the player picks a fate shape BEFORE
        // choosing a magic item. The picker drain below checks for a
        // still-open fate modal via `modalPaused` and holds until the
        // fate popup is dismissed. All three drains share
        // `fxStillPlaying()`.
        this.drainPendingFateModal();
        this.drainPendingPickerOpen();
        this.drainPendingSpawn();
        this.drainPendingPopups();
    }

    /** Fire any ribbon detonations whose pre-pulse delay has elapsed. */
    private firePendingRibbonTriggers(): void {
        if (this.pendingRibbonTriggers.length === 0) return;
        const now = Date.now();
        for (let i = this.pendingRibbonTriggers.length - 1; i >= 0; i--) {
            if (this.pendingRibbonTriggers[i].fireAt <= now) {
                this.spawnRibbonDetonate(this.pendingRibbonTriggers[i].row);
                this.pendingRibbonTriggers.splice(i, 1);
            }
        }
    }

    /** Fire the end-of-game popup queued by the `onLevelWin` / `onGameOver`
     *  hooks once every visual effect tied to the previous row clear has
     *  finished. We wait for BOTH `flashingCells` (the rainbow row) and
     *  `stars` (the sparkle particles) to empty out before showing the
     *  popup, so the celebration plays through uncovered. */
    private drainPendingPopups(): void {
        if (!this.pendingLevelWin && this.pendingGameOverReason === undefined) return;
        // Effects still playing — wait.
        if (this.fxStillPlaying()) return;

        if (this.pendingLevelWin) {
            this.pendingLevelWin = false;
            this.menuController?.showLevelWin();
        }
        if (this.pendingGameOverReason !== undefined) {
            const r = this.pendingGameOverReason;
            this.pendingGameOverReason = undefined;
            // Show the "reveal tower + tap to continue" overlay FIRST;
            // it fires the real showGameOver in its tap callback so
            // the fail popup doesn't cover the tower before the
            // player gets a chance to look at it. Especially important
            // for blind mode where the tower was invisible during play.
            this.enterPostFailReveal(r ?? null);
        }
    }

    /**
     * Two-stage game-over flow. Applies to:
     *   - 闭眼模式 (any reason): reveal the tower + tap to continue
     *   - 无尽 / 闭眼模式 with reason === 1 (trapped hole): also pulse
     *     the trapped cells so the player sees what killed them
     *
     * All other paths (endless reason=2 "too tall", level fail) fall
     * through to the fail modal directly — no extra tap gate.
     *
     * On tap → tear down overlay + effects + fire the real
     * MenuController.showGameOver.
     */
    private enterPostFailReveal(reason: number | null): void {
        const hud: any = this.hudController;
        const mode     = this.gameState?.mode;
        const isBlind          = mode === 'blind';
        const isTrappedHole    = (mode === 'endless' || mode === 'blind') && reason === 1;
        const hasPrompt = hud && typeof hud.showFailRevealPrompt === 'function';
        if (!hasPrompt || (!isBlind && !isTrappedHole)) {
            this.menuController?.showGameOver(reason);
            return;
        }
        this.postFailRevealPending = true;
        // Blind-mode fail: hide the beam + column label so the reveal
        // isn't cluttered with the "tower hidden" cues that no longer
        // apply now that the tower is visible.
        if (isBlind) {
            if (typeof hud.setBlindIndicatorVisible === 'function') {
                hud.setBlindIndicatorVisible(false);
            }
            if (this.blindBeamNode) this.blindBeamNode.active = false;
        }
        // Trapped-hole fail (endless OR blind): pulse the trapped cells
        // so the player sees exactly what killed them.
        if (isTrappedHole) {
            this.queueTrappedHoleHighlights();
        }

        hud.showFailRevealPrompt(() => {
            this.postFailRevealPending = false;
            if (typeof hud.hideFailRevealPrompt === 'function') {
                hud.hideFailRevealPrompt();
            }
            this.clearTrappedHoleHighlights();
            this.menuController?.showGameOver(reason);
        });
    }

    /** Single source of truth: are any clear-related FX (rainbow flash,
     *  sparkle stars, row pre-pulse, ribbon detonation) still on screen?
     *  Used by `drainPendingPopups` AND `drainPendingSpawn` so the level-
     *  win popup AND the next piece both wait on the same scene-quiet
     *  signal. */
    private fxStillPlaying(): boolean {
        if (this.fxNonFallStillPlaying()) return true;
        // Diagonal-gravity fall animations (both QUEUED and currently
        // running) need to settle before the next piece spawns —
        // otherwise the player would see a piece pop in while the
        // previous board's cubes are still mid-drop, or right when
        // they're about to start.
        if (this.fallAnimations.size > 0) return true;
        if (this.pendingFallMoves.length > 0) return true;
        return false;
    }

    /** GameState defers the next-piece spawn after a lock or storm-finish
     *  so the new piece doesn't pop in over a still-celebrating scene.
     *  Three gates before we commit:
     *    1. picker open — when the energy bar fills, the picker pops up
     *       and we MUST let the player pick + the item's FX play out
     *       before spawning; otherwise the new piece appears while the
     *       picker is still covering the canvas.
     *    2. FX still playing — rainbow flash, sparkle stars, pre-pulse,
     *       ribbon detonation; the new piece shouldn't pop over them.
     *    3. The `pendingSpawn` flag itself — nothing queued, no work. */
    private drainPendingSpawn(): void {
        if (!this.gameState || !this.gameState.hasPendingSpawn()) return;
        if (this.gameState.energyPicker.active) return;
        if (this.gameState.hasPendingPickerOpen()) return;
        // Don't spawn over a paused simulation — that covers both the
        // user-toggled pause AND the mid-run fate modal that temporarily
        // sets `paused = true` while the popup is up.
        if (this.gameState.paused) return;
        // Also block during the post-pick delay window: pickEnergyReward
        // closes the picker immediately but defers useItem by ~250ms so
        // the popup dismiss animation reads. Without this guard, the
        // spawn commit could fire between close and useItem — spawning
        // the NEXT piece (with its embedded bombs / booms / wreckers)
        // right before the item's effect wipes the row, robbing the
        // player of props they'd banked. `modalPaused` is set by
        // pickEnergyReward for exactly this reason.
        if (this.gameState.modalPaused) return;
        if (this.fxStillPlaying()) return;
        this.gameState.commitPendingSpawn();
    }

    /** Parallel drain for the energy picker. The picker open is queued
     *  when the bar fills during `lockAndNext`; we wait until line-clear /
     *  detonation FX has all played through before popping it. That way
     *  the locked piece's stamped cells aren't sitting visible at the
     *  top of the cylinder behind the popup. */
    private drainPendingPickerOpen(): void {
        if (!this.gameState || !this.gameState.hasPendingPickerOpen()) return;
        if (this.fxStillPlaying()) return;
        // Fate modal takes priority — wait until it's dismissed. Both
        // `hasPendingFateModal()` (queued, not yet shown) and
        // `modalPaused` (currently on-screen) block us so the picker
        // never covers the fate popup.
        if (this.gameState.hasPendingFateModal()) return;
        if (this.gameState.modalPaused) return;
        this.gameState.commitPendingPickerOpen();
    }

    /** Endless-mode milestone: every 20 cumulative filled rows the game
     *  state flips `pendingFateModal`. We wait for FX + the energy
     *  picker to settle, then pause the simulation (so the player can
     *  think) and pop the fate modal. On confirm, push the picked shape
     *  into the bag (future refills carry it) AND into MenuController's
     *  endless-restart cache. */
    private drainPendingFateModal(): void {
        if (!this.gameState || !this.gameState.hasPendingFateModal()) return;
        if (this.fxStillPlaying()) return;
        // Fate modal takes priority OVER the energy picker now — if the
        // picker happens to be visibly on-screen already (from a prior
        // frame), wait for it to close so we don't stack overlays. A
        // MERELY PENDING picker (queued, not yet shown) is fine — the
        // picker's own drain will hold while we're up.
        if (this.gameState.energyPicker.active) return;
        // Don't pop during a storm — it's already showing FX.
        if (this.gameState.hail.mode || this.gameState.rocket.mode
            || this.gameState.gatling.mode || this.gameState.mortar.mode) return;
        // Robust HUD lookup — HudController lives on the Canvas node,
        // which is a SIBLING of GameController's node, so a plain
        // `this.node.getComponent` returns null. Fall back to a full-
        // scene search the same way MenuController does. Without this
        // the milestone silently committed itself and no popup ever
        // appeared.
        let hud: any = this.node.getComponent('HudController') as any;
        if (!hud) {
            const scene = director.getScene();
            if (scene) hud = scene.getComponentInChildren('HudController' as any);
        }
        if (!hud || typeof hud.showFateModal !== 'function') {
            // No HUD path — drop the queue silently so the game keeps playing.
            this.gameState.commitPendingFateModal();
            return;
        }
        // Use `modalPaused` (not `paused`) — same gameplay freeze but
        // WITHOUT triggering the pause-UI overlay. Setting `paused` here
        // caused HudController.syncPauseUi to pop the pause modal on
        // top of the fate modal on every 20-layer milestone.
        this.gameState.modalPaused = true;
        this.gameState.commitPendingFateModal();
        const fakeLvl: any = { order: 0, customPiece: null };
        hud.showFateModal(
            fakeLvl,
            (picked: { baseType: string; shape: number[][] }) => {
                if (!this.gameState) return;
                this.gameState.setEndlessFateShape({
                    baseType: picked.baseType as any,
                    shape:    picked.shape,
                });
                // Keep the menu-side restart cache in sync so "再来一局"
                // resurrects the latest fate piece, not the original.
                // Same scene-wide fallback as the HUD lookup above —
                // MenuController is on a different node from GameController.
                let menu: any = this.node.getComponent('MenuController') as any;
                if (!menu) {
                    const scene = director.getScene();
                    if (scene) menu = scene.getComponentInChildren('MenuController' as any);
                }
                if (menu) {
                    menu.lastEndlessFatePiece = {
                        baseType: picked.baseType,
                        shape:    picked.shape.map(r => r.slice()),
                    };
                }
                this.gameState.modalPaused = false;
            },
            () => {
                // Cancel (escape / outside-tap) keeps the current fate
                // piece. Just resume the game.
                if (this.gameState) this.gameState.modalPaused = false;
            },
        );
    }

    /** Integrate every active star one tick + render. Stars that have aged
     *  past their lifetime are removed from the active list. */
    private stepAndRenderStars(dt: number): void {
        if (this.stars.length === 0) {
            // Hide any still-active pool entries (rare).
            for (const n of this.starPool) if (n.active) n.active = false;
            return;
        }

        // Step physics + cull
        for (let i = this.stars.length - 1; i >= 0; i--) {
            const s = this.stars[i];
            s.age += dt;
            if (s.age >= s.lifetime) {
                this.stars.splice(i, 1);
                continue;
            }
            s.vy -= this.flashStarGravity * dt;
            s.px += s.vx * dt;
            s.py += s.vy * dt;
            s.pz += s.vz * dt;
            s.rotX += s.spinX * dt;
            s.rotY += s.spinY * dt;
            s.rotZ += s.spinZ * dt;
        }

        // Render
        let cursor = 0;
        for (const s of this.stars) {
            if (cursor >= this.starPool.length) break;
            const n  = this.starPool[cursor];
            const mr = this.starPoolMeshes[cursor];
            cursor++;

            if (!n.active) n.active = true;
            n.setWorldPosition(s.px, s.py, s.pz);

            const t = s.age / s.lifetime;
            // Pop big at start, shrink to nothing at end.
            const popK = t < 0.15 ? (t / 0.15) : 1.0;
            const sizeK = popK * (1 - Math.max(0, (t - 0.15) / 0.85));
            const w = s.size * sizeK;
            n.setScale(w, w, w);
            n.setRotationFromEuler(
                math.toDegree(s.rotX),
                math.toDegree(s.rotY),
                math.toDegree(s.rotZ),
            );

            // Soft twinkle: hue drifts slightly, brightness fades.
            const hue = (s.hue + t * 0.4) % 1;
            const fade = 1 - t * 0.6;
            const col = hsvToColor(hue, 0.4, fade);   // pastel-ish sparkle
            if (mr.material && this.canTintStars) {
                mr.material.setProperty('mainColor', col);
            }
        }

        // Hide leftover pool slots
        for (let i = cursor; i < this.starPool.length; i++) {
            if (this.starPool[i].active) this.starPool[i].active = false;
        }
    }

    /** Continuous-rotation: if left/right has been held past DAS_DELAY, fire
     *  an extra `moveCylinder(±1)` every REPEAT_INTERVAL milliseconds. Other
     *  keys (rotate / drop / hold / pause) remain single-shot. */
    private processHeldKeys(): void {
        if (!this.gameState) return;
        const now = Date.now();
        if (this.leftHeld > 0 &&
            now - this.leftHeld >= GameController.DAS_DELAY &&
            now - this.leftLastFire >= GameController.REPEAT_INTERVAL) {
            this._tryRotateTower(-1);
            this.leftLastFire = now;
        }
        if (this.rightHeld > 0 &&
            now - this.rightHeld >= GameController.DAS_DELAY &&
            now - this.rightLastFire >= GameController.REPEAT_INTERVAL) {
            this._tryRotateTower(+1);
            this.rightLastFire = now;
        }
    }

    // ============================================================
    //  Cube rendering — board cells are delegated to CubeManager;
    //  GameController layers falling-projectile + flash overlays on top.
    // ============================================================
    private syncCubes(): void {
        if (!this.boardRoot3D || !this.gameState) return;
        const state = this.gameState.state;
        const rows  = state.board.length;
        const centerCol = this.currentCenterCol();

        // Delegate every board cell (brick / blast / stone / item cubes)
        // to CubeManager. Mortar specifically keeps `current` alive
        // mid-storm so the player doesn't lose their piece — but the
        // piece would still render on top of the colored mortar drops,
        // which the player reads as "an extra block per empty cell".
        // Hide the piece during the mortar storm; it returns the moment
        // the storm finishes.
        if (this.cubeManager) {
            const piece = this.gameState.mortar.mode ? null : this.gameState.current;
            const displayRowFor = (this.fallAnimations.size || this.pendingFallMoves.size)
                ? (r: number, c: number) => this.displayRowForCell(r, c)
                : undefined;
            // GameState reports a sub-row fractional offset so the piece
            // glides smoothly between grid steps instead of teleporting
            // one row per drop tick. Applies to both DOT (meteor) and
            // regular tetrominoes; snaps back to 0 the instant the piece
            // grounds so lock-delay UX / ghost alignment stay pixel-exact.
            const pieceYOffset = piece ? this.gameState.getPieceVisualYOffset() : 0;
            // Ghost piece — where the current would land if hard-dropped.
            // Suppress the ghost for DOT meteor fragments (they fall too
            // fast for the preview to help; already close to grounded).
            const ghostY = (piece && piece.type !== 'DOT')
                ? this.gameState.getGhostDropY()
                : null;
            // Blind mode hides settled cells (game state is intact, we
            // just don't paint). Debug switch overrides for testing.
            // Post-fail reveal ALSO overrides so the player can see
            // the final tower before the fail popup covers it. Active
            // piece + ghost keep rendering either way.
            const hideBoardCells = this.gameState.mode === 'blind'
                && !this.blindShowTowerDebug
                && !this.postFailRevealPending;
            this.cubeManager.syncBoardCells(
                state, piece, centerCol, rows, displayRowFor, pieceYOffset, ghostY,
                hideBoardCells,
            );
        }

        // Falling rocket-storm projectiles. Rendered AFTER board cells so
        // rockets pop in front of the cylinder wall when crossing visible rows.
        this.renderFallingRockets(rows);

        // In-flight hail spheres + gatling bullets + mortar drops.
        this.renderFallingHail(rows);
        this.renderFallingGatling(rows);
        this.renderFallingMortar(rows);

        // Rainbow flash overlay (renders AFTER board cells so it sits on top
        // of any cube that may have slid down into the cleared row's spot).
        this.renderFlashingCells();

        // Pre-detonation row pulse — shares the flash pool cursor.
        this.renderPrePulseCells();

        // Trapped-hole highlight (endless fail reveal) — same pool,
        // loops indefinitely until cleared on tap.
        this.renderTrappedHoleCells();

        // Layer-celebration ring — own dedicated cylinder mesh node,
        // does NOT share the flash cube pool.
        this.renderSpectrumRing();

        // Sparkle particles orbiting the ring — own dedicated pool,
        // rotated in sync with the ring's spin.
        this.renderSpectrumParticles();

        // Deactivate any flash-pool tail slots that no renderer above
        // claimed this frame.
        for (let i = this.flashCubeCursor; i < this.flashCubePool.length; i++) {
            if (this.flashCubePool[i].active) this.flashCubePool[i].active = false;
        }

        // Blind mode: push the camera-facing column into the HUD's
        // "列 N" label. setBlindColumn short-circuits when the integer
        // hasn't changed, so this is cheap on every frame. Also keep
        // the 3D world beam visibility in sync — if the mode flipped
        // to something else (menu, level load) without going through
        // an explicit hide path, this catches it.
        // Beam / column-label logic — suppressed during post-fail
        // reveal because we hid them explicitly in enterPostFailReveal
        // and don't want per-frame code to flip them back on.
        const isBlind = this.gameState.mode === 'blind'
            && !this.postFailRevealPending;
        if (isBlind) {
            const hud = this.hudController;
            if (hud && typeof hud.setBlindColumn === 'function') {
                hud.setBlindColumn(centerCol);
            }
            // Beam locks onto Math.round(centerCol) each frame so it
            // slides with the tower during rotation instead of floating
            // in dead camera-center while cubes shift underneath.
            this.updateBlindBeamPose(centerCol);
        }
        // Only touch the beam node if it exists (avoid lazy-building
        // during a non-blind session). If it doesn't exist and isBlind
        // is false, there's nothing to do.
        if (this.blindBeamNode && this.blindBeamNode.active !== isBlind) {
            this.blindBeamNode.active = isBlind;
        }
    }

    /** Render active rainbow-flash cells from the DEDICATED flash pool
     *  (independent of the prefab brick pool — avoids vertex-layout /
     *  shader mismatch errors).  Each flash cell cycles HSV hues offset by
     *  column index, drifts up slightly, and shrinks to 0 at end of life. */
    /** Shared cursor into `flashCubePool` for the current frame. Reset
     *  to 0 at the top of `syncCubes`; advanced by both
     *  `renderFlashingCells` (row-clear flash) and `renderPrePulseCells`
     *  (pre-detonation pulse). Unused tail slots are deactivated
     *  ONCE after both render passes. */
    private flashCubeCursor = 0;

    private renderFlashingCells(): void {
        this.flashCubeCursor = 0;
        const now = Date.now();
        const durationMs = this.flashDuration * 1000;

        // Drop expired entries.
        for (let i = this.flashingCells.length - 1; i >= 0; i--) {
            if (now - this.flashingCells[i].startTime >= durationMs) {
                this.flashingCells.splice(i, 1);
            }
        }

        if (this.flashingCells.length === 0) return;
        const rows = this.gameState ? this.gameState.state.board.length : 0;

        for (const fc of this.flashingCells) {
            if (this.flashCubeCursor >= this.flashCubePool.length) break;
            const cube = this.flashCubePool[this.flashCubeCursor];
            const mat  = this.flashCubeMats[this.flashCubeCursor];
            this.flashCubeCursor++;

            if (!cube.active) cube.active = true;

            const elapsed = (now - fc.startTime) / 1000;
            const t = Math.min(1, elapsed / this.flashDuration);

            // Compute LOCAL boardRoot3D coords each frame from (r, c) —
            // same placeCube formula as the actual bricks. Parent
            // (boardRoot3D) supplies the 0.75 tower scale + yaw +
            // endless camera-follow translate, so the flash cube lands
            // exactly on the destroyed brick regardless of tower height.
            const cellTheta = fc.c * ANGLE_PER_COL;
            const localX = RADIUS * Math.sin(cellTheta);
            const localZ = RADIUS * Math.cos(cellTheta);
            const localY = Y_BOTTOM + ((rows - 1) - fc.r) * CELL_SIZE;
            const yDrift = t * 0.4;
            cube.setPosition(localX, localY + yDrift, localZ);
            cube.setRotationFromEuler(0, math.toDegree(cellTheta), 0);

            // Scale animation. Two flavours:
            //   • Normal (row-clear flash): pop 1.0 → 1.25 in the first
            //     30%, then shrink to 0 — pointy at BOTH ends, looks
            //     like a momentary "blink" per cell.
            //   • trailOnly (col-bomb wave): start at peak 1.25 and
            //     just shrink. Combined with the staggered startTime
            //     this gives the wave a FLAT leading edge (full-size
            //     cells just appearing) and a TAPERED trailing edge
            //     (older cells shrinking down).
            let s: number;
            if (fc.trailOnly) {
                // Peak 0.5 — leading head reads as a sleek comet
                // rather than a fat cube. Trail tapers to 0.
                s = 0.5 * (1 - t);
            } else {
                // Row-clear flash: pop to peak 1.0 in the first 30%,
                // then shrink to 0. Start 0.8 keeps the original 25%
                // pop ratio relative to the new peak.
                if (t < 0.3) s = 0.8 + (t / 0.3) * 0.2;
                else         s = 1.0 * (1 - (t - 0.3) / 0.7);
            }
            cube.setScale(s, s, s);

            const hue  = (fc.colIndex / COLS + t * 2) % 1;
            const fade = 1 - t * 0.4;
            const col  = hsvToColor(hue, 1, fade);
            const alphaScale = fc.alphaScale ?? 1;
            const alpha = Math.max(0, Math.min(1, this.flashOpacity * (1 - t) * alphaScale));
            col.a = Math.floor(alpha * 255);
            if (mat && this.canTintFlash) mat.setProperty('mainColor', col);
        }
        // Leftover slot cleanup happens AFTER renderPrePulseCells.
    }

    /** Render the pre-detonation row pulse: 24 cells flashing twice
     *  with a smooth sine-pulse alpha curve, no rotation/scale animation.
     *  Shares the flash cube pool with `renderFlashingCells`.
     *
     *  Positions computed in LOCAL boardRoot3D space so the pulse
     *  inherits scale (0.75), yaw, and Y translation from boardRoot3D
     *  automatically — matches CubeManager.placeCube for tower cubes
     *  and stays locked to the target cell even during camera lerps. */
    /** Number of radial segments on the ring mesh. Also = the number
     *  of independent per-segment top heights, so a higher value gives
     *  a smoother "spectrum-peaks" top edge but costs more vertices
     *  per rebuild. */
    private static readonly SPECTRUM_RING_SEGMENTS = 32;

    /** Lazily build the cylinder-sleeve mesh node used for the layer-
     *  celebration ring. Hollow — only the SIDE wall, no top/bottom
     *  caps. The mesh's actual top-edge heights are (re)generated on
     *  every fire in `rebuildSpectrumRingMesh`, so this initial mesh
     *  is just a flat placeholder. */
    private ensureSpectrumRingNode(): void {
        if (this.spectrumRingNode || !this.boardRoot3D) return;
        const n = new Node('SpectrumRing');
        n.parent = this.boardRoot3D;
        n.layer  = this.boardRoot3D.layer;
        n.active = false;
        const mr = n.addComponent(MeshRenderer);
        // Default placeholder: flat top at Y = 1. Replaced on each
        // fire with a randomly-varying top edge.
        const flat = new Array(GameController.SPECTRUM_RING_SEGMENTS).fill(1);
        mr.mesh = this.buildSpectrumRingMesh(flat);
        const mat = new Material();
        // technique 1 = transparent (alpha blending). Same effect the
        // other flash cubes use, so the ring's semi-transparency reads
        // consistently against the rest of the celebration.
        mat.initialize({ effectName: 'builtin-unlit', technique: 1 });
        mat.setProperty('mainColor', new Color(255, 220, 90, 255));
        mr.material = mat;
        this.spectrumRingNode = n;
        this.spectrumRingMat  = mr.material;
    }

    /** Build a hollow-tube mesh with a variable-height top edge.
     *  `heights[i]` is the NORMALIZED Y position (in the range that
     *  scales to peakHeight at max) of the top vertex at segment `i`.
     *  Bottom vertices sit at Y = 0 so the mesh's origin = its bottom
     *  edge — position the node at `state.bottomY` and Y-scale = height
     *  in world units to grow it upward.
     *
     *  Both outer and inner face winding orders are emitted so the
     *  tube renders from any angle without depending on rasterizer
     *  cull-mode settings. */
    private buildSpectrumRingMesh(heights: number[]): import('cc').Mesh {
        const segments = heights.length;
        const ringRadius = RADIUS + 0.05;
        const positions: number[] = [];
        const normals:   number[] = [];
        const uvs:       number[] = [];
        const indices:   number[] = [];
        for (let i = 0; i <= segments; i++) {
            const idx = i % segments;
            const theta = (i / segments) * Math.PI * 2;
            const cos = Math.cos(theta);
            const sin = Math.sin(theta);
            positions.push(ringRadius * cos, 0, ringRadius * sin);
            normals.push(cos, 0, sin);
            uvs.push(i / segments, 1);
            positions.push(ringRadius * cos, heights[idx], ringRadius * sin);
            normals.push(cos, 0, sin);
            uvs.push(i / segments, 0);
        }
        for (let i = 0; i < segments; i++) {
            const b0 = i * 2;
            const t0 = b0 + 1;
            const b1 = b0 + 2;
            const t1 = b0 + 3;
            // Outer face (CCW) + inner face (CW).
            indices.push(b0, t0, b1);
            indices.push(b1, t0, t1);
            indices.push(b0, b1, t0);
            indices.push(b1, t1, t0);
        }
        return utils.MeshUtils.createMesh({
            positions, normals, uvs, indices,
        });
    }

    /** Lazily build the sparkle-particle pool used by the celebration
     *  ring. Small yellow boxes; each frame their position gets rotated
     *  by the ring's current spin angle so they orbit together. */
    private ensureSpectrumParticlePool(): void {
        if (this.spectrumParticleNodes.length > 0 || !this.boardRoot3D) return;
        const POOL_SIZE = 32;
        const mesh = utils.MeshUtils.createMesh(primitives.box({
            width: 1, height: 1, length: 1,
        }));
        for (let i = 0; i < POOL_SIZE; i++) {
            const n = new Node(`SpectrumParticle_${i}`);
            n.parent = this.boardRoot3D;
            n.layer  = this.boardRoot3D.layer;
            n.active = false;
            const mr = n.addComponent(MeshRenderer);
            mr.mesh = mesh;
            const mat = new Material();
            mat.initialize({ effectName: 'builtin-unlit', technique: 1 });
            mat.setProperty('mainColor', new Color(255, 220, 90, 255));
            mr.material = mat;
            this.spectrumParticleNodes.push(n);
            this.spectrumParticleMats.push(mr.material!);
        }
    }

    /** Populate `spectrumParticles` with a burst of sparkles positioned
     *  around the ring at spawn. Angle around the tower axis is random,
     *  radial distance jitters around the ring radius, Y is distributed
     *  along the ring's peak height. Each particle has a random size,
     *  life, and vertical drift. */
    private spawnSpectrumParticles(bottomY: number, peakHeightCells: number): void {
        this.ensureSpectrumParticlePool();
        const N = 24;
        const now = Date.now();
        const baseR = RADIUS + 0.05;
        for (let i = 0; i < N; i++) {
            this.spectrumParticles.push({
                theta0:  Math.random() * Math.PI * 2,
                // Slightly inside or outside the ring wall — small
                // radial jitter for a "cloud around the ring" look.
                radialR: baseR + (Math.random() - 0.5) * 0.5,
                // Spread along the ring's height, biased toward the top
                // half (rings are more interesting near the crown).
                y0:      bottomY + peakHeightCells * CELL_SIZE * (0.3 + Math.random() * 0.7),
                yDrift:  0.6 + Math.random() * 1.2,   // rise this many world units over life
                size:    0.15 + Math.random() * 0.15,
                startTime: now,
                lifeMs:  400 + Math.random() * 300,
            });
        }
    }

    /** Render sparkle particles orbiting with the celebration ring.
     *  Uses the ring's current spin angle so particles rotate in
     *  sync with it. Fades size + alpha over each particle's life. */
    private renderSpectrumParticles(): void {
        if (this.spectrumParticles.length === 0) {
            for (const n of this.spectrumParticleNodes) if (n.active) n.active = false;
            return;
        }
        const now = Date.now();
        // Cull expired.
        for (let i = this.spectrumParticles.length - 1; i >= 0; i--) {
            const p = this.spectrumParticles[i];
            if (now - p.startTime >= p.lifeMs) this.spectrumParticles.splice(i, 1);
        }
        if (this.spectrumParticles.length === 0) {
            for (const n of this.spectrumParticleNodes) if (n.active) n.active = false;
            return;
        }
        // Ring's current spin (deg → rad) — particles rotate with it.
        const ringState = this.spectrumRingState;
        let spinRad = 0;
        if (ringState) {
            const elapsedRingMs = now - ringState.startTime;
            const spinDeg = (elapsedRingMs / 1000) * GameController.SPECTRUM_SPIN_DEG_PER_SEC;
            spinRad = math.toRadian(spinDeg);
        }
        const cosS = Math.cos(spinRad);
        const sinS = Math.sin(spinRad);

        let cursor = 0;
        for (const p of this.spectrumParticles) {
            if (cursor >= this.spectrumParticleNodes.length) break;
            const n = this.spectrumParticleNodes[cursor];
            const mat = this.spectrumParticleMats[cursor];
            cursor++;

            if (!n.active) n.active = true;

            const t = (now - p.startTime) / p.lifeMs;
            // Orbital position: base polar coords rotated by the ring's
            // current spin.
            const cos = Math.cos(p.theta0);
            const sin = Math.sin(p.theta0);
            // (radialR * cos, y, radialR * sin) rotated by spinRad around Y.
            const xLocal = p.radialR * cos;
            const zLocal = p.radialR * sin;
            const x = cosS * xLocal + sinS * zLocal;
            const z = -sinS * xLocal + cosS * zLocal;
            const y = p.y0 + t * p.yDrift;
            n.setPosition(x, y, z);

            // Scale: pop in fast (first 15%), then linear shrink to 0.
            const popK = t < 0.15 ? t / 0.15 : 1;
            const sizeK = popK * (1 - Math.max(0, (t - 0.15) / 0.85));
            const s = p.size * sizeK;
            n.setScale(s, s, s);

            // Alpha fade over full life.
            const alpha = Math.max(0, Math.min(255, Math.floor(255 * (1 - t))));
            if (mat) mat.setProperty('mainColor', new Color(255, 220, 90, alpha));
        }
        // Hide unused pool tail.
        for (let i = cursor; i < this.spectrumParticleNodes.length; i++) {
            if (this.spectrumParticleNodes[i].active) this.spectrumParticleNodes[i].active = false;
        }
    }

    /** Render the endless-mode layer celebration ring. Single continuous
     *  translucent yellow cylinder that grows UPWARD from the tower's
     *  base with an accelerating height curve (quadratic ease-in), and
     *  vanishes at the peak — no rebound. Alpha stays full through most
     *  of the rise, then fades to 0 in the last stretch so the ring
     *  disappears exactly when it reaches its target height. */
    private renderSpectrumRing(): void {
        const state = this.spectrumRingState;
        if (!state) {
            if (this.spectrumRingNode && this.spectrumRingNode.active) {
                this.spectrumRingNode.active = false;
            }
            return;
        }
        this.ensureSpectrumRingNode();
        const node = this.spectrumRingNode;
        const mat  = this.spectrumRingMat;
        if (!node || !mat) return;

        const now = Date.now();
        const TOTAL = GameController.SPECTRUM_TOTAL_MS;
        const elapsed = now - state.startTime;
        if (elapsed >= TOTAL) {
            this.spectrumRingState = null;
            node.active = false;
            return;
        }

        // Height starts at the accelerating-rise peak and then
        // shrinks LINEARLY back to 0 over the remaining lifetime —
        // in sync with the alpha fade, so the ring's presence
        // dissolves in both dimensions together.
        //
        // Two phases:
        //   1. t < RISE_END: quartic ease-in from 0 → peakHeightCells
        //   2. t ≥ RISE_END: linear shrink from peakHeightCells → 0
        const t = elapsed / TOTAL;
        const RISE_END = 0.3;   // 30% of life spent rising, 70% shrinking
        let height: number;
        if (t < RISE_END) {
            const p = t / RISE_END;
            height = state.peakHeightCells * p * p * p * p;
        } else {
            const p = (t - RISE_END) / (1 - RISE_END);
            height = state.peakHeightCells * (1 - p);
        }
        if (height < 0.05) {
            node.active = false;
            return;
        }

        if (!node.active) node.active = true;

        // Position the node so the mesh's LOCAL Y=0 (which is the
        // bottom edge of the tube) sits at `state.bottomY`. The tube's
        // top vertices are at Y = heights[i] in mesh coords, so
        // Y-scale = heightWorld makes the tallest peak reach
        // `state.bottomY + heightWorld`, and shorter valleys reach
        // `state.bottomY + heightWorld * heights[i]`.
        // LOCAL boardRoot3D frame — inherits the tower's 0.75 scale +
        // yaw + camera-follow Y translation.
        const heightWorld = height * CELL_SIZE;
        node.setPosition(0, state.bottomY, 0);
        node.setScale(1, heightWorld, 1);
        // Spin around Y at SPIN_DEG_PER_SEC — blurs the jagged top
        // edge into a rotating halo, adds motion energy to the
        // celebration.
        const spinDeg = (elapsed / 1000) * GameController.SPECTRUM_SPIN_DEG_PER_SEC;
        node.setRotationFromEuler(0, spinDeg % 360, 0);

        // Alpha ramps linearly from 70% at spawn → 0% at peak. The
        // fade is monotonic over the full lifetime so the ring's
        // presence trails off smoothly as it grows, disappearing
        // exactly when it reaches its target height.
        const START_ALPHA = 0.7;
        const alphaFrac = START_ALPHA * (1 - t);
        const col = new Color(255, 220, 90, Math.floor(alphaFrac * 255));
        mat.setProperty('mainColor', col);
    }

    private renderPrePulseCells(): void {
        const now = Date.now();
        const defaultDurationMs = this.prePulseDuration * 1000;

        // Drop expired entries.
        for (let i = this.prePulseCells.length - 1; i >= 0; i--) {
            const dms = this.prePulseCells[i].durationMs ?? defaultDurationMs;
            if (now - this.prePulseCells[i].startTime >= dms) {
                this.prePulseCells.splice(i, 1);
            }
        }

        if (this.prePulseCells.length === 0 || !this.gameState) return;
        const rows = this.gameState.state.board.length;

        for (const pc of this.prePulseCells) {
            const durationMs = pc.durationMs ?? defaultDurationMs;
            if (this.flashCubeCursor >= this.flashCubePool.length) break;
            const cube = this.flashCubePool[this.flashCubeCursor];
            const mat  = this.flashCubeMats[this.flashCubeCursor];
            this.flashCubeCursor++;

            // Same math CubeManager.placeCube uses — LOCAL to boardRoot3D.
            const cellTheta = pc.c * ANGLE_PER_COL;
            const localX = RADIUS * Math.sin(cellTheta);
            const localZ = RADIUS * Math.cos(cellTheta);
            const localY = Y_BOTTOM + ((rows - 1) - pc.r) * CELL_SIZE;

            if (!cube.active) cube.active = true;
            cube.setPosition(localX, localY, localZ);
            // Simple radial-outward Y rotation. The tower cube uses
            // X=90 + Y+180 for its prefab's authored orientation, but
            // our flash box is symmetric — plain Y rotation is enough.
            cube.setRotationFromEuler(0, math.toDegree(cellTheta), 0);
            // Scale — brightnessMode overrides pc.scale to 1.0 so the
            // pulse cube overlays the brick EXACTLY (reads as the
            // brick brightening rather than a halo appearing around
            // it). Row-blast keeps 1.15 (halo ring), other wrecker
            // callers can still supply pc.scale explicitly.
            const s = pc.brightnessMode ? 1.0 : (pc.scale ?? 1.15);
            cube.setScale(s, s, s);

            // Two-pulse alpha curve: two sin half-waves, each lasting
            // 25 % of the duration, with 25 % rest gaps in between.
            const t = (now - pc.startTime) / durationMs;
            let pulseK = 0;
            if (t < 0.25) {
                pulseK = Math.sin(t * 4 * Math.PI);     // 1st pulse
            } else if (t >= 0.50 && t < 0.75) {
                pulseK = Math.sin((t - 0.50) * 4 * Math.PI); // 2nd pulse
            }
            if (mat && this.canTintFlash) {
                if (pc.brightnessMode) {
                    // Brightness mode: pulse the target BRICK'S OWN
                    // colour, brightened toward white by pulseK. The
                    // opaque overlay covers the brick exactly at
                    // scale 1.0, so the visible fragment is the pulse
                    // material — animating its rgb from base → white
                    // and back reads as "the brick pulses brighter".
                    // Falls back to white if the cell no longer has a
                    // known colour (e.g. the wrecker plan detonated
                    // into a bomb chain that cleared it early).
                    const cell = this.gameState.state.board[pc.r]?.[pc.c];
                    const hex = COLORS[cell as keyof typeof COLORS] ?? '#ffffff';
                    const base = this.hexToCcColor(hex);
                    // Lerp base → white by pulseK — peak (pulseK=1)
                    // is fully white, trough (pulseK=0) is the brick's
                    // authored colour. Fully opaque throughout so the
                    // underlying brick's own render doesn't bleed
                    // through (which would just cancel the tint).
                    const k = Math.max(0, Math.min(1, pulseK));
                    mat.setProperty('mainColor', new Color(
                        Math.floor(base.r + (255 - base.r) * k),
                        Math.floor(base.g + (255 - base.g) * k),
                        Math.floor(base.b + (255 - base.b) * k),
                        255,
                    ));
                } else {
                    const alpha = Math.max(0, Math.min(255,
                        Math.floor(this.prePulseAlpha * pulseK),
                    ));
                    mat.setProperty('mainColor', new Color(
                        this.prePulseColor.r,
                        this.prePulseColor.g,
                        this.prePulseColor.b,
                        alpha,
                    ));
                }
            }
        }

        // (Tail slot deactivation moved to syncCubes — runs after
        //  renderDissolvingCells too so all three passes share the pool.)
    }

    /**
     * Convert BFS-flagged trapped cells (r/c on the board) into
     * world-space queue entries for the flash-pool renderer. Called
     * once when a trapped-hole game-over triggers the reveal overlay.
     * Cleared via `clearTrappedHoleHighlights()` when the player taps.
     */
    private queueTrappedHoleHighlights(): void {
        if (!this.gameState) return;
        const cells = findTrappedCells(this.gameState.state);
        if (cells.length === 0) return;
        const now = Date.now();
        for (const { r, c } of cells) {
            this.trappedHoleCells.push({ r, c, startTime: now });
        }
        log(`[TowerBlocks] queued ${cells.length} trapped-hole highlights`);
    }

    private clearTrappedHoleHighlights(): void {
        this.trappedHoleCells.length = 0;
    }

    /**
     * Render the trapped-hole pulse — a soft red glow that loops until
     * cleared. Uses the same flash cube pool as `renderPrePulseCells`,
     * but positions in LOCAL boardRoot3D space (not world) so that
     * boardRoot3D's transform stack — SCALE (0.75), YAW (rotates when
     * player turns the tower), and Y TRANSLATION (negative when the
     * tall-tower camera follow kicks in) — all apply automatically.
     *
     * Positions match `CubeManager.placeCube` exactly: same RADIUS,
     * same localY formula, no fudge factors. The flash cube's own
     * simple box mesh is centered at the node origin, so setting
     * position to the tower-cell's local coords lands the pulse
     * squarely on the empty slot regardless of tower height.
     */
    private renderTrappedHoleCells(): void {
        if (this.trappedHoleCells.length === 0 || !this.gameState) return;
        const now  = Date.now();
        const rows = this.gameState.state.board.length;
        const PULSE_PERIOD_MS = 1000;
        const PEAK_ALPHA      = 220;

        for (const cell of this.trappedHoleCells) {
            if (this.flashCubeCursor >= this.flashCubePool.length) break;
            const cube = this.flashCubePool[this.flashCubeCursor];
            const mat  = this.flashCubeMats[this.flashCubeCursor];
            this.flashCubeCursor++;

            // Same math CubeManager.placeCube uses — LOCAL to boardRoot3D.
            const cellTheta = cell.c * ANGLE_PER_COL;
            const localX = RADIUS * Math.sin(cellTheta);
            const localZ = RADIUS * Math.cos(cellTheta);
            const localY = Y_BOTTOM + ((rows - 1) - cell.r) * CELL_SIZE;

            if (!cube.active) cube.active = true;
            cube.setPosition(localX, localY, localZ);
            // Simple radial-outward Y rotation. The tower cube uses an
            // additional X=90 + Y+180 for its prefab's authored
            // orientation, but our flash box is symmetric — a plain
            // Y rotation is enough to keep it facing outward.
            cube.setRotationFromEuler(0, math.toDegree(cellTheta), 0);
            // Full 1×1×1 — pulse cube exactly matches the tower cell's
            // dimensions on all three axes.
            cube.setScale(1, 1, 1);

            // 0 → 1 → 0 sine loop, no decay (0.5 - 0.5*cos wave).
            const phase  = ((now - cell.startTime) % PULSE_PERIOD_MS) / PULSE_PERIOD_MS;
            const pulseK = 0.5 - 0.5 * Math.cos(phase * 2 * Math.PI);
            const alpha  = Math.floor(PEAK_ALPHA * pulseK);
            if (mat && this.canTintFlash) {
                mat.setProperty('mainColor', new Color(255, 60, 60, alpha));
            }
        }
    }


    /** Y-offset applied to BoardRoot3D and every world-space prop helper.
     *
     *  Endless and level / collect modes now use the SAME rule: NO
     *  baseline shift. The board's natural position puts row N-1 at
     *  Y_BOTTOM, so the bottom of the board (reserved zone in levels,
     *  gray foundation in endless) sits at the visible bottom and the
     *  rest extends upward. The deadband camera tracker further
     *  adjusts as the tower top moves through the middle band — that
     *  logic is shared too. */
    /** Smoothed Y offset applied to BoardRoot3D and every world-space prop
     *  helper. Lerps toward `targetBoardYOffset` each frame in
     *  `rotateCylinder`. Storing a single number means every call site
     *  (cubes, ghost, falling props, FX) reads the same value within one
     *  frame so they all line up. */
    private currentBoardYOffsetVal = 0;
    /** Set on the first `rotateCylinder` call after a fresh board so we
     *  snap to the target instead of easing into it from 0. */
    private boardYOffsetInitialised = false;
    /** True while `playLevelAssembly` is running: cubes are being tweened
     *  from off-screen into their board positions before the level
     *  actually starts. During this window `update()` skips gameState.tick
     *  and syncCubes so the tweens can author cube transforms without
     *  the per-frame render loop stomping on them. */
    private _assembling = false;
    /** Last piece reference we processed in `realignPieceSpawnRow`. When
     *  this changes (the GameState spawned a fresh piece), we shift its
     *  starting row down into the visible window so the player doesn't
     *  watch an invisible piece drift through empty space above the
     *  camera for several seconds. */
    private prevPieceRef: import('../core/Types').Piece | null = null;
    /** Per-cell fall animation state. Keyed by `${toR}-${c}` (the cell's
     *  CURRENT board position, post-gravity). Each entry holds the
     *  `fromR` (pre-gravity row), `startTime`, and `duration`. The cube
     *  renders at a row LERPED between `fromR` and `toR` during this
     *  window, then snaps to `toR` when the timer expires. Populated by
     *  `registerFallAnimations` (called from the `onCellsFell` core hook). */
    private fallAnimations = new Map<string, { fromR: number; startTime: number; duration: number }>();
    /** Fall moves the core reported but that we're NOT animating yet —
     *  they wait until the rainbow flash / ribbons / shatter dust / etc.
     *  finish playing. Keyed by `${toR}-${c}` so `displayRowForCell` can
     *  also use it: while the entry is here we render the cube at
     *  `fromR` (visually held in place) even though the board state
     *  already has the cell at `toR`. Once `fxNonFallStillPlaying` is
     *  false, every entry gets promoted into `fallAnimations` and the
     *  cubes drop. */
    private pendingFallMoves: Map<string, { fromR: number }> = new Map();
    /** Scheduled time (Date.now ms) at which the queued wrecker plans
     *  should commit (cells nulled + shatter spawned). 0 = nothing
     *  pending. Set by `queueWreckerPrePulse`; checked each frame by
     *  `drainWreckerPulse`. */
    private wreckerCommitAt: number = 0;

    /** One-shot gate for the mortar landing SFX: armed by
     *  `onMortarActivated` (storm start) and consumed by the first
     *  `onMortarLanded` of that storm. Keeps a single "clay lands"
     *  cue per activation instead of one per drop (would spam). */
    private _mortarLandSfxArmed: boolean = false;
    /** How long each cell takes to fall ONE row. Cells that drop N rows
     *  scale their duration by N so the visual speed stays constant. */
    private readonly FALL_ROW_DURATION_MS = 90;

    /** Camera-tracking target with a deadband.
     *
     *  Layout: the visible window spans `VISIBLE_ROWS * CELL_SIZE` in Y.
     *  We divide it into three equal bands. The MIDDLE band is the
     *  deadband — as long as the LOCKED stack's top (NOT the falling
     *  piece) sits inside it, the camera holds still. Once the tower
     *  top climbs above the band, we shift the world DOWN just enough
     *  to put it back at the upper edge. Symmetrically, once it drops
     *  below the band (e.g., the player clears a tall run of rows), we
     *  shift the world UP to put it back at the lower edge.
     *
     *  Floor / ceiling (now shared across modes — endless was tweaked
     *  to behave like level mode per the latest UX request):
     *  - Never shift UP past the natural baseline (offset 0) so the
     *    bottom of the board never floats above Y_BOTTOM.
     *  - Down-shifts are unbounded so the camera can follow a tall
     *    tower all the way up. */
    private targetBoardYOffset(totalRows: number): number {
        if (totalRows <= 0) return 0;
        const scale = GameController.TOWER_VIEW_SCALE;
        const mode = this.gameState?.mode;
        const isEndlessLike = (mode === 'endless' || mode === 'blind');

        // ENDLESS / BLIND: base offset places the TOP row of a FULL
        // 20-row (= ENDLESS_GRAY_CAP) gray foundation at
        // `GRAY_TOP_ANCHOR_ROWS_ABOVE_CENTER` rows above screen centre.
        // That's the FINAL resting position once the foundation caps.
        //
        // For the "每填满 24 列，塔整体下移一行" rule to hold from the
        // FIRST fill (not just after cap), we add a `pendingShift` that
        // varies with the actual gray count: it starts at
        // `ENDLESS_GRAY_CAP * scale * CELL_SIZE` when the gray count
        // is 0 (tower begins its life `cap` on-screen rows above the
        // final target) and decreases by `scale * CELL_SIZE` every
        // time a fill converts one more row to gray. Once the gray
        // count reaches cap the pendingShift is 0 and `manageEndlessBoard`
        // takes over the per-fill drop via bottom-row peeling — same
        // visual outcome, different mechanism.
        //
        // NOTE: the necessary trade-off is that at G=0 the tower sits
        // ~15 world units above the final position (bottom row at
        // Y≈6.75). This "reserved sink height" is what lets 20 fills
        // each move the tower down by one row without the tower going
        // off-screen at the bottom.
        //
        // Derivation of base: top of a full ENDLESS_GRAY_CAP-row gray
        // stack has local Y = Y_BOTTOM + (ENDLESS_GRAY_CAP-1)*CELL_SIZE.
        // Setting scaled world Y = target:
        //   scale * (Y_BOTTOM + (ENDLESS_GRAY_CAP-1)*CELL) + baseOffset = target
        //   baseOffset = target - scale * (Y_BOTTOM + (ENDLESS_GRAY_CAP-1)*CELL)
        if (isEndlessLike) {
            // Positive = rows above screen centre; negative = rows below.
            // Tweak history: 8 → -4 (down 12) → -7 (down 3 more) — at
            // -7 a full 20-row gray foundation's top row sits 7 rows
            // below centre, keeping the gray band low so the play area
            // and spawn buffer get most of the upper screen.
            const GRAY_TOP_ANCHOR_ROWS_ABOVE_CENTER = -7;
            const targetWorldY = GRAY_TOP_ANCHOR_ROWS_ABOVE_CENTER * scale * CELL_SIZE;
            const grayTopLocalY = Y_BOTTOM + (ENDLESS_GRAY_CAP - 1) * CELL_SIZE;
            const baseOffset = targetWorldY - scale * grayTopLocalY;

            // Count current gray rows. `Math.min` clamps at cap so
            // the transient G=cap+1 state between convert-to-gray and
            // bottom-peel doesn't cause a one-frame jitter.
            const board = this.gameState?.state.board;
            let grayCount = 0;
            if (board) {
                for (let r = 0; r < board.length; r++) {
                    if (board[r].every(v => v === 'X')) grayCount++;
                }
            }
            const anchorGray = Math.min(grayCount, ENDLESS_GRAY_CAP);
            const pendingShift = (ENDLESS_GRAY_CAP - anchorGray) * scale * CELL_SIZE;
            return baseOffset + pendingShift;
        }

        // LEVEL / COLLECT: FIXED offset — never depends on tower
        // height, so the reserved-zone + task-rock "gray base" stays
        // pinned to screen bottom throughout the run. Was a tower-
        // following deadband; removed per UX request so the gray
        // section no longer slides down as the player builds up.
        //
        // Derivation: bottom row's local Y is `Y_BOTTOM`; setting its
        // world Y (= local*scale + offset) equal to `Y_BOTTOM` (screen
        // bottom edge) gives `offset = Y_BOTTOM * (1 - scale)`.
        return Y_BOTTOM * (1 - scale);
    }

    /** Top-down scan for the first row of the LOCKED board that holds
     *  any non-null cell (player blocks, X reserved, hail, anything).
     *  Returns `board.length` if the board is empty. The active falling
     *  piece is deliberately NOT included — the camera should track the
     *  stable stack, not jiggle with every gravity tick. */
    private findTowerTopRow(): number {
        if (!this.gameState) return Number.POSITIVE_INFINITY;
        const board = this.gameState.state.board;
        const H = board.length;
        for (let r = 0; r < H; r++) {
            for (let c = 0; c < COLS; c++) {
                if (board[r][c] !== null) return r;
            }
        }
        return H;
    }

    /** Y-offset accessor for the four world-space helpers (queuePrePulseRow,
     *  spawn helpers, etc). They all read the same smoothed value so the
     *  board, props and FX move together within a single frame. */
    private boardYOffset(_totalRows: number): number {
        return this.currentBoardYOffsetVal;
    }

    /** When a piece spawns on a tall board, GameState always picks row 0
     *  (or -1 for the I-piece). With the camera shifted down to follow
     *  the stack, that "row 0" can sit a dozen rows above the visible
     *  window, so the player sees nothing fall for several seconds.
     *  Shift the spawn row down to the top of the visible window — but
     *  never past the existing stack (collision is left to GameState's
     *  normal top-out path on the next tick). */
    /** Core hook invoked after every clearing operation. Each entry says
     *  "the cell now at toR fell from fromR". We QUEUE the moves instead
     *  of starting the tween immediately — the actual drop is deferred
     *  until the rainbow flash, ribbon detonation, shatter dust, etc.
     *  finish playing (see `drainPendingFallAnimations`). Without this
     *  the cube would visibly slide while the row-clear flash is still
     *  on screen, which reads as the FX overlapping the next state. */
    private registerFallAnimations(moves: ReadonlyArray<{ fromR: number; toR: number; c: number }>): void {
        for (const m of moves) {
            const key = `${m.toR}-${m.c}`;
            // Preserve the ORIGINAL fromR if a later clearing op moves the
            // same cell again before the queue drains — the visual fall
            // should still start from where the cell genuinely came from.
            const existing = this.pendingFallMoves.get(key);
            this.pendingFallMoves.set(key, { fromR: existing?.fromR ?? m.fromR });
        }
    }

    /** Promote `pendingFallMoves` into the active `fallAnimations` map
     *  once the clearing FX have finished. Each entry gets a fresh
     *  startTime so the drop starts NOW, not when the move was
     *  recorded. Called every frame from `update`. */
    private drainPendingFallAnimations(): void {
        if (this.pendingFallMoves.size === 0) return;
        if (this.fxNonFallStillPlaying()) return;
        const now = Date.now();
        for (const [key, entry] of this.pendingFallMoves) {
            const dash = key.indexOf('-');
            const toR = parseInt(key.substring(0, dash), 10);
            const dist = Math.max(1, toR - entry.fromR);
            this.fallAnimations.set(key, {
                fromR:    entry.fromR,
                startTime: now,
                duration:  this.FALL_ROW_DURATION_MS * dist,
            });
        }
        this.pendingFallMoves.clear();
    }

    /** Gate that decides when the queued fall animations are allowed to
     *  start. Intentionally a NARROWER set than `fxStillPlaying`: we only
     *  wait for the MAIN FX (row-clear rainbow flash + ribbon
     *  detonation) — not for tail effects like sparkle stars or
     *  pre-pulse, which can linger a long time after the dramatic part
     *  is over. Holding the fall for the tail particles made the blocks
     *  visibly hang in mid-air. */
    private fxNonFallStillPlaying(): boolean {
        if (this.flashingCells.length > 0) return true;
        if (this.pendingRibbonTriggers.length > 0) return true;
        if (Date.now() < this.ribbonDetonateEndsAt) return true;
        if (this.wreckerCommitAt && Date.now() < this.wreckerCommitAt) return true;
        return false;
    }

    /** Wrecker just fired in core.
     *
     *  Two flavours:
     *  - **Board-embedded prop** (srcR/srcC ≥ 0) — the wrecker cell on the
     *    tower launches a swarm of tiny colored-cube projectiles at each
     *    pick. Projectiles arrive over ~250ms with a small per-pick
     *    stagger; each arrival kicks off THAT cell's pulse (halo flash)
     *    and then the shatter runs after `wreckerPulseDuration`. Total
     *    latency = flight + pulse.
     *  - **Magic item** (srcR/srcC = -1) — legacy path: no source cell
     *    to launch from, just start every pulse immediately.
     *
     *  `wreckerCommitAt` is bumped to the LAST pulse's end so
     *  `drainWreckerPulse` doesn't commit the clear before every visual
     *  step has landed. */
    private queueWreckerPrePulse(
        srcR: number,
        srcC: number,
        picks: ReadonlyArray<{ r: number; c: number; color: import('../core/Constants').CellValue }>,
        comboBoomLevel: 0 | 1 | 2 | 3 = 0,
        comboBombAxis: 'row' | 'col' | null = null,
    ): void {
        if (!this.gameState || !picks.length) return;
        const now = Date.now();
        const pulseMs = this.wreckerPulseDuration * 1000;

        // Legacy path — no known source, spawn the marker prop right
        // away on every pick and commit at now + pulseMs.
        if (srcR < 0 || srcC < 0) {
            for (const { r, c } of picks) {
                this._spawnWreckerMarkerAt(r, c, pulseMs, comboBoomLevel, comboBombAxis);
            }
            const commitAt = now + pulseMs;
            if (commitAt > this.wreckerCommitAt) this.wreckerCommitAt = commitAt;
            return;
        }

        // Projectile path — launch one small colored cube from
        // (srcR, srcC) to each target, stagger arrivals so the pulses
        // read as a sweep instead of an all-at-once bloom.
        const FLIGHT_MS  = 250;
        const STAGGER_MS = 30;   // per-pick launch offset
        let maxArrivalMs = 0;
        picks.forEach(({ r, c }, i) => {
            const launchDelay = i * STAGGER_MS;
            const arrivalMs   = launchDelay + FLIGHT_MS;
            if (arrivalMs > maxArrivalMs) maxArrivalMs = arrivalMs;
            // Spawn a projectile after `launchDelay`. `setTimeout` is
            // fine here — these are one-shot side-effects, not a hot
            // per-frame loop. drainWreckerPulse already gates commit
            // on wreckerCommitAt so the shatter waits for us.
            const projectileTimeout = setTimeout(() => {
                this.spawnWreckerProjectile(srcR, srcC, r, c, FLIGHT_MS, () => {
                    // Arrival: stamp a temp prop on the target cell —
                    // wrecker cube for plain sweep, row/col-blast cube
                    // for directional combos, boom cube for range
                    // combos. Player reads the impending effect at a
                    // glance from the icon.
                    this._spawnWreckerMarkerAt(r, c, pulseMs, comboBoomLevel, comboBombAxis);
                });
            }, launchDelay);
            // Track so a level reset can cancel in-flight projectiles.
            this._wreckerProjectileTimeouts.push(projectileTimeout);
        });
        // Commit after the LAST projectile lands + its full pulse plays.
        const commitAt = now + maxArrivalMs + pulseMs;
        if (commitAt > this.wreckerCommitAt) this.wreckerCommitAt = commitAt;
    }

    /** In-flight wrecker "marker" prop nodes — the fake wrecker cubes
     *  stamped on target cells during the pre-pulse phase. Tracked so
     *  a level reset can nuke them before their auto-destroy timer
     *  fires. */
    private _wreckerMarkerNodes: Node[] = [];

    /** Instantiate a temp prop as a child of boardRoot3D at the target
     *  cell's local position, oriented like a normal tower brick.
     *  Prefab choice depends on the combo the wrecker is running in:
     *    - `comboBoomLevel > 0` → boom cube (level-matched prefab)
     *    - `comboBombAxis === 'row'` → row1-blast cube
     *    - `comboBombAxis === 'col'` → col1-blast cube
     *    - otherwise → plain wrecker cube
     *  Wrecker forces level-1 blasts per-pick regardless of the
     *  neighbour's authored tier (see Wrecker.ts docstring), so we
     *  ALWAYS use the tier-1 prefabs for directional combos.
     *  Falls back to the plain wrecker prefab when the combo-matched
     *  prefab isn't wired on CubeManager, and no-ops entirely when
     *  the wrecker prefab is also missing. */
    private _spawnWreckerMarkerAt(
        r: number, c: number, pulseMs: number,
        comboBoomLevel: 0 | 1 | 2 | 3 = 0,
        comboBombAxis: 'row' | 'col' | null = null,
    ): void {
        const cm = this.cubeManager;
        if (!cm || !this.boardRoot3D || !this.gameState) return;
        // Pick the prefab that matches the impending effect.
        let prefab: import('cc').Prefab | null = cm.wreckerPrefab;
        if (comboBoomLevel > 0) {
            prefab = (cm.boomCubePrefabs && cm.boomCubePrefabs[comboBoomLevel - 1])
                  || cm.wreckerPrefab;
        } else if (comboBombAxis === 'row') {
            prefab = cm.rowBlastPrefab || cm.wreckerPrefab;
        } else if (comboBombAxis === 'col') {
            prefab = cm.rowBlastPrefabCol1 || cm.wreckerPrefab;
        }
        if (!prefab) return;
        console.log(`[Wrecker marker] spawning at (r=${r}, c=${c}) — combo boom=${comboBoomLevel} bomb=${comboBombAxis} prefab=${prefab.name}`);
        const totalRows = this.gameState.state.board.length;
        const theta = c * ANGLE_PER_COL;
        const node = instantiate(prefab);
        // Also stash the target color on both the FX (in case
        // buildBody hasn't yet run) AND schedule a post-onLoad
        // override (in case buildBody already read the old color).
        // Belt-and-braces because Cocos 3.8 lifecycle timing for
        // instantiate → parent → onLoad varies across build modes.
        //
        // Colour matches the WreckerCubeFX default authored bodyColor
        // (#F86316 = 248,99,22) — the same orange the falling
        // refresh-piece's embedded prop shows, so a marker on the
        // tower reads as the same "wrecker" identity the player just
        // saw on their piece. Previous value (255,178,60) read as
        // yellow because the R–G ratio was too close to 1.
        const orange = new Color(248, 99, 22, 255);
        const wFxPre = node.getComponent(WreckerCubeFX);
        if (wFxPre) wFxPre.bodyColor = orange;
        const rFxPre = node.getComponent(RowBlastCubeFX);
        if (rFxPre) rFxPre.bodyColor = orange;
        const bFxPre = node.getComponent(BoomCubeFX);
        if (bFxPre) bFxPre.bodyColor = orange;
        node.parent = this.boardRoot3D;
        node.layer  = this.boardRoot3D.layer;
        // Scale slightly LARGER than a regular tower brick (1.06×) so
        // the marker's outer shell sits marginally in front of the
        // underlying colored cube at every pixel — that guarantees
        // the depth test picks the marker's orange body instead of
        // the original cell's color. Without this the two shells
        // co-exist at the same radius and z-fight, so the marker's
        // color-setting has no visible effect (the tower cube's
        // authored blue/green/etc. wins about half the pixels).
        const s = node.scale;
        const OVERLAY_BOOST = 1.06;
        node.setScale(
            s.x * GameController.TOWER_VIEW_SCALE_MATCH * OVERLAY_BOOST,
            s.y * GameController.TOWER_VIEW_SCALE_MATCH * OVERLAY_BOOST,
            s.z * GameController.TOWER_VIEW_SCALE_MATCH * OVERLAY_BOOST,
        );
        node.setPosition(
            RADIUS * Math.sin(theta),
            Y_BOTTOM + ((totalRows - 1) - r) * CELL_SIZE,
            RADIUS * Math.cos(theta),
        );
        // Rotation math must match CubeManager.setColumnTransform:
        // yaw × baseRot, where baseRot is the prefab's OWN authored
        // rotation (WreckerCubeFX authors -90° X so the hammer icon
        // sits upright on the brick face). Using the flat
        // setRotationFromEuler(90, θ+180, 0) that stones use would
        // wipe out the hammer's authored X rotation and the prop
        // ended up face-down. Multiplying yaw × node.rotation
        // preserves whatever the prefab set at instantiate time.
        const baseRot = new Quat(
            node.rotation.x, node.rotation.y, node.rotation.z, node.rotation.w,
        );
        const yawQ = new Quat();
        Quat.fromEuler(yawQ, 0, math.toDegree(theta), 0);
        const finalQ = new Quat();
        Quat.multiply(finalQ, yawQ, baseRot);
        node.setRotation(finalQ);
        // Force full-brightness tint on the marker so the body reads
        // as the orange body-color we set above (matches the embedded
        // prop that shows on the falling refresh piece — same
        // full-orange). Skipping the back-of-cylinder dimming makes
        // the markers pop out from the surrounding dimmed tower
        // bricks, which reinforces the "these cells are about to
        // explode" read.
        const wFx = node.getComponent(WreckerCubeFX);
        if (wFx) wFx.setTint(1.0);
        const rFx = node.getComponent(RowBlastCubeFX);
        if (rFx) rFx.setTint(1.0);
        const bFx = node.getComponent(BoomCubeFX);
        if (bFx) bFx.setTint(1.0);
        // Belt-and-braces override: some builds instantiate onLoad
        // BEFORE our bodyColor override lands, so setTint(1.0) above
        // ends up multiplying the OLD authored color by 1.0 (no
        // change). One-tick-later we reach into the FX component's
        // bodyMR (the ONE MeshRenderer that renders the body shell)
        // and force-write the orange mainColor directly to its
        // material. Only touching bodyMR means the icons (hammer,
        // row/col bands, boom lozenges) keep their authored contrast
        // colours and stay visible against the orange body — the
        // previous "paint every MeshRenderer that isn't a sparkle"
        // approach was recolouring the icon marks too and made the
        // row/col/boom markers look flat orange with no icon.
        this.scheduleOnce(() => {
            if (!node || !node.isValid) return;
            const paintBodyOf = (fx: any) => {
                if (!fx || !fx.bodyMR) return;
                const mat = fx.bodyMR.material;
                if (mat) mat.setProperty('mainColor', orange);
            };
            paintBodyOf(node.getComponent(WreckerCubeFX));
            paintBodyOf(node.getComponent(RowBlastCubeFX));
            paintBodyOf(node.getComponent(BoomCubeFX));
        }, 0);
        this._wreckerMarkerNodes.push(node);
        // NOTE: markers are NOT destroyed here via a per-marker
        // setTimeout. When two wreckers fire adjacent (or two combo
        // paths overlap), the SHARED wreckerCommitAt shifts later
        // than any single marker's pulseMs — so a fixed timeout
        // would reveal the underlying color-cube before the shatter
        // actually runs. Instead, `drainWreckerPulse` tears down
        // EVERY marker in `_wreckerMarkerNodes` at the exact moment
        // it hands control to `commitPendingWreckerPlans`, which is
        // the true "shatter starts now" beat.
    }

    /** Cube scale multiplier CubeManager applies to every pool prefab
     *  (see `populateCubePool`). Kept in sync manually because
     *  CubeManager doesn't expose CUBE_VISUAL publicly and this VFX
     *  path can't import it directly without pulling in half the
     *  module. If CubeManager.CUBE_VISUAL changes, mirror it here.  */
    private static readonly TOWER_VIEW_SCALE_MATCH = 1.0;

    /** In-flight setTimeout handles for wrecker projectiles. Tracked so
     *  a level reset (or a tear-down before landing) can cancel them
     *  before they push stale pulses / spawn zombie nodes. */
    private _wreckerProjectileTimeouts: ReturnType<typeof setTimeout>[] = [];

    /** Spawn a small colored cube at source (srcR, srcC), tween it to
     *  target (dstR, dstC) over `flightMs` ms, fire `onArrive` when it
     *  lands, and destroy the projectile node. Cube is parented to
     *  boardRoot3D so it rotates with the tower — a mid-flight yaw
     *  won't peel the projectile off its target arc. */
    private spawnWreckerProjectile(
        srcR: number, srcC: number,
        dstR: number, dstC: number,
        flightMs: number,
        onArrive: () => void,
    ): void {
        if (!this.boardRoot3D || !this.gameState) { onArrive(); return; }
        const totalRows = this.gameState.state.board.length;
        // Fly along the CYLINDER SURFACE (not through the interior) —
        // the projectile arcs around the tower's outer skin, staying
        // a fixed radius from the axis. OUTER_R is slightly larger
        // than the brick radius so the cube reads as "riding on the
        // outside" instead of clipping into the wall.
        const OUTER_R = RADIUS + CELL_SIZE * 0.15;
        // Shortest-arc column delta. Straight (dstC - srcC) would send
        // the projectile the long way around whenever the target is on
        // the far side; wrap to (-COLS/2, COLS/2] so we always take
        // the closer arc.
        let dC = dstC - srcC;
        if (dC >  COLS / 2) dC -= COLS;
        if (dC < -COLS / 2) dC += COLS;
        // Local starting position on the outer surface — used as the
        // initial node position before the arc tween takes over.
        const srcTheta = srcC * ANGLE_PER_COL;
        const srcPos = new Vec3(
            OUTER_R * Math.sin(srcTheta),
            Y_BOTTOM + ((totalRows - 1) - srcR) * CELL_SIZE,
            OUTER_R * Math.cos(srcTheta),
        );

        // Head sphere — higher segment count than the trail spheres
        // so the silhouette is smooth at close range (the black
        // outline traces this silhouette and low-poly geometry would
        // read as "jagged edges").
        const headMesh = utils.MeshUtils.createMesh(primitives.sphere(
            0.5, { segments: 16 },
        ));
        // Trail sphere — coarser (8 segments) since dozens overlap
        // and no individual one is looked at directly. Cuts vertex
        // count / draw cost roughly 4× vs. matching the head.
        const trailMesh = utils.MeshUtils.createMesh(primitives.sphere(
            0.5, { segments: 8 },
        ));
        // Palette rotates through the game's colors so the swarm reads
        // as "colored blocks flying out" (user's wording: "彩色方块儿").
        const palette: Color[] = [
            new Color(255, 210,  60, 255),  // gold
            new Color(255, 120,  50, 255),  // orange
            new Color(255,  95, 105, 255),  // salmon
            new Color(120, 210, 255, 255),  // sky
            new Color(140, 235, 130, 255),  // green
        ];
        const col = palette[(dstR * 7 + dstC) % palette.length];
        const mat = new Material();
        mat.initialize({ effectName: 'builtin-unlit' });
        mat.setProperty('mainColor', col);

        const node = new Node('WreckerProjectile');
        node.parent = this.boardRoot3D;
        node.layer  = this.boardRoot3D.layer;
        node.setPosition(srcPos);
        // ~35% of a cell — big enough to read at a glance, small enough
        // that 10 in flight don't cover the target cells.
        const size = CELL_SIZE * 0.35;
        node.setScale(size, size, size);
        const mr = node.addComponent(MeshRenderer);
        mr.mesh = headMesh;
        mr.material = mat;

        // ─── Ribbon trail ─────────────────────────────────────
        // A continuous strip mesh sampled from a rolling buffer of
        // the projectile's recent positions. Each pair of adjacent
        // samples becomes a quad, oriented so its width sits in the
        // horizontal plane perpendicular to the segment direction.
        // Width tapers linearly from ~full head-diameter at the
        // freshest sample down to zero at the oldest — the tail
        // trails off to a point instead of a hard cut.
        //
        // Rebuilds the mesh every ~20ms (about 50Hz). At 24-point
        // capacity the strip covers roughly ~500ms of flight; older
        // samples fall off the back as new ones push in.
        const RIBBON_MAX_POINTS   = 24;
        const RIBBON_UPDATE_MS    = 20;
        const RIBBON_MAX_WIDTH    = size * 1.4;
        const ribbonPositions: Vec3[] = [];

        const ribbonNode = new Node('WreckerProjRibbon');
        ribbonNode.parent = this.boardRoot3D;
        ribbonNode.layer  = this.boardRoot3D.layer;
        const ribbonMat = new Material();
        ribbonMat.initialize({ effectName: 'builtin-unlit', technique: 1 });
        ribbonMat.setProperty('mainColor', new Color(
            col.r, col.g, col.b, 220,
        ));
        const ribbonMR = ribbonNode.addComponent(MeshRenderer);
        ribbonMR.material = ribbonMat;
        let ribbonMesh: Mesh | null = null;

        // Reusable scratch vectors — allocated once per projectile,
        // not per rebuild, to keep the GC quiet.
        const WORLD_UP = new Vec3(0, 1, 0);
        const tmpT = new Vec3();
        const tmpB = new Vec3();

        let ribbonHandle: ReturnType<typeof setInterval> | null = setInterval(() => {
            if (!node || !node.isValid || !this.boardRoot3D) {
                if (ribbonHandle) { clearInterval(ribbonHandle); ribbonHandle = null; }
                if (ribbonMesh) { ribbonMesh.destroy(); ribbonMesh = null; }
                if (ribbonNode && ribbonNode.isValid) ribbonNode.destroy();
                return;
            }
            ribbonPositions.push(node.position.clone());
            if (ribbonPositions.length > RIBBON_MAX_POINTS) ribbonPositions.shift();
            if (ribbonPositions.length < 2) return;

            const N = ribbonPositions.length;
            const positions: number[] = [];
            const indices: number[] = [];
            for (let i = 0; i < N; i++) {
                const p = ribbonPositions[i];
                // Tangent = direction to the NEXT point (or from the
                // previous point on the last vertex, so we don't run
                // off the array end).
                if (i < N - 1) {
                    Vec3.subtract(tmpT, ribbonPositions[i + 1], p);
                } else {
                    Vec3.subtract(tmpT, p, ribbonPositions[i - 1]);
                }
                tmpT.normalize();
                // Binormal = tangent × world-up. Falls back to +X
                // when the tangent is (nearly) parallel to up, which
                // would otherwise yield a zero cross-product.
                Vec3.cross(tmpB, tmpT, WORLD_UP);
                if (tmpB.lengthSqr() < 1e-5) tmpB.set(1, 0, 0);
                else tmpB.normalize();
                // taper 0..1: freshest sample (i = N-1) → 1, oldest
                // (i = 0) → 0. Widths + colors could easily key off
                // this same value if we later add vertex colours.
                const taper = N > 1 ? (i / (N - 1)) : 0;
                const halfWidth = RIBBON_MAX_WIDTH * 0.5 * taper;
                positions.push(
                    p.x + tmpB.x * halfWidth,
                    p.y + tmpB.y * halfWidth,
                    p.z + tmpB.z * halfWidth,
                    p.x - tmpB.x * halfWidth,
                    p.y - tmpB.y * halfWidth,
                    p.z - tmpB.z * halfWidth,
                );
            }
            // Two triangles per segment. Vertex order:
            //   L_i (2i)   R_i (2i+1)   L_i+1 (2i+2)   R_i+1 (2i+3)
            for (let i = 0; i < N - 1; i++) {
                const a = i * 2;
                indices.push(a, a + 2, a + 1);
                indices.push(a + 1, a + 2, a + 3);
            }
            // Rebuild — allocate fresh mesh, then destroy the last one
            // AFTER the assignment so we don't dangle the renderer with
            // a null mesh between frames.
            const nextMesh = utils.MeshUtils.createMesh({
                positions,
                indices,
            });
            ribbonMR.mesh = nextMesh;
            if (ribbonMesh) ribbonMesh.destroy();
            ribbonMesh = nextMesh;
        }, RIBBON_UPDATE_MS);

        // ─── Arc tween along the cylinder surface ────────────
        // `tween` doesn't natively interpolate along a curve, so we
        // drive a scalar {t: 0 → 1} and paint the node's position each
        // frame from t via onUpdate. At t=0 we're at (srcR, srcC), at
        // t=1 we're at (dstR, dstC), and in between we ride OUTER_R,
        // walking the column along the shorter arc.
        // Arc bow-out: at mid-flight the projectile pushes further
        // OUT from the cylinder axis AND UP above the target's Y —
        // reads as a lobbed throw, not a flat surface-hugger. Uses
        // sin(π t) so the lift is 0 at both ends and peaks at t=0.5.
        //
        // Amounts scale with the flight's arc distance in columns so
        // a 1-col hop stays subtle while a half-cylinder shot really
        // arcs. |dC| is at most COLS/2 = 12 by the shortest-arc rule
        // above, so the scale caps naturally.
        const ARC_RAD_LIFT = CELL_SIZE * 0.35 * Math.abs(dC);
        const ARC_Y_LIFT   = CELL_SIZE * 0.20 * Math.abs(dC);
        const tweenTarget = { t: 0 };
        const tmpArc = new Vec3();
        tween(tweenTarget)
            .to(flightMs / 1000, { t: 1 }, {
                easing: 'quadIn',
                onUpdate: (_target?: any, ratio?: number) => {
                    if (!node || !node.isValid) return;
                    const t = ratio ?? tweenTarget.t;
                    const c = srcC + dC * t;
                    const r = srcR + (dstR - srcR) * t;
                    const theta = c * ANGLE_PER_COL;
                    // Bow the arc: radius pushes out at mid-flight,
                    // Y lifts up. Both fall to 0 at t=0 and t=1 so the
                    // endpoints still land exactly at the source and
                    // target cell centres on the outer surface.
                    const bowK  = Math.sin(Math.PI * t);
                    const rad   = OUTER_R + ARC_RAD_LIFT * bowK;
                    const yBase = Y_BOTTOM + ((totalRows - 1) - r) * CELL_SIZE;
                    tmpArc.set(
                        rad * Math.sin(theta),
                        yBase + ARC_Y_LIFT * bowK,
                        rad * Math.cos(theta),
                    );
                    node.setPosition(tmpArc);
                    // Full 720° tumble end-to-end, evenly distributed.
                    node.setRotationFromEuler(720 * t, 720 * t, 0);
                },
            })
            .call(() => {
                if (ribbonHandle) { clearInterval(ribbonHandle); ribbonHandle = null; }
                if (ribbonMesh) { ribbonMesh.destroy(); ribbonMesh = null; }
                if (ribbonNode && ribbonNode.isValid) ribbonNode.destroy();
                onArrive();
                if (node && node.isValid) node.destroy();
            })
            .start();
    }

    /** Per-cell shatter for a wrecker plain sweep — one flash + star
     *  burst (and a 3D chunk shatter under clearEffect 0) at each pick,
     *  NOT a horizontal row flash. Keeps the 10 cells reading as
     *  10 independent pops instead of "10 rows blasted across the
     *  whole cylinder". */
    private queueWreckerPicksShatter(picks: ReadonlyArray<{ r: number; c: number; color: import('../core/Constants').CellValue }>): void {
        if (!this.gameState || !picks.length) return;
        const totalRows = this.gameState.state.board.length;
        const centerCol = this.currentCenterCol();
        const yawDeg = -math.toDegree(centerCol * ANGLE_PER_COL);
        const now = Date.now();
        const tmpWorld = new Vec3();
        for (const { r, c, color } of picks) {
            if (r < 0 || r >= totalRows) continue;
            // `color` param retained for API compat with the wrecker path
            // that used to feed the 3D chunk burst — flash + stars don't
            // care about the source colour (hue cycles via colIndex).
            void color;
            // Flash cube: store (r, c). renderFlashingCells parents to
            // boardRoot3D and uses LOCAL coords each frame so the pop
            // stays on the destroyed brick regardless of tower scale /
            // yaw / camera-follow translate.
            this.flashingCells.push({
                r, c,
                // Vary hue per cell so the 10 picks pop in different
                // rainbow colours instead of all the same shade.
                colIndex: (r * 7 + c) & 31,
                startTime: now,
            });
            // Stars still integrate in WORLD frame with world-unit
            // velocities. Get the cell's true world position via
            // boardRoot3D.worldMatrix so gravity + outward direction
            // math starts from the right spot even with the 0.75 scale.
            this.cellWorldPos(r, c, tmpWorld);
            const cellTheta = c * ANGLE_PER_COL;
            this.spawnStarsAt(tmpWorld.x, tmpWorld.y, tmpWorld.z, cellTheta, yawDeg);
        }
    }

    /** Each frame, if the wrecker's pulse window has elapsed and the
     *  GameState still has plans queued, tell it to commit. */
    private drainWreckerPulse(): void {
        if (!this.wreckerCommitAt) return;
        if (!this.gameState) return;
        if (Date.now() < this.wreckerCommitAt) return;
        this.wreckerCommitAt = 0;
        // Tear down every temp orange marker RIGHT before the shatter
        // fires. Doing it here (rather than per-marker setTimeout in
        // _spawnWreckerMarkerAt) keeps the markers alive through
        // adjacent-wrecker firings, where the shared commit slips
        // past any single pulseMs deadline — previously the earlier-
        // spawned markers vanished (reverting to the underlying
        // colored cube) while the later ones were still pulsing.
        for (const n of this._wreckerMarkerNodes) {
            if (n && n.isValid) n.destroy();
        }
        this._wreckerMarkerNodes.length = 0;
        this.gameState.commitPendingWreckerPlans();
    }

    /** Return the FRACTIONAL row index the cube at logical (r, c) should
     *  render at this frame. Defaults to `r` when no animation is active
     *  for the cell. Used as the `displayRowFor` callback to
     *  `CubeManager.syncBoardCells`. */
    private displayRowForCell(r: number, c: number): number {
        const key = `${r}-${c}`;
        // Queued (FX still playing) — render where the cube CAME FROM so
        // it appears to hang in place during the rainbow flash / ribbon
        // / shatter dust, instead of teleporting to the empty zone.
        const pending = this.pendingFallMoves.get(key);
        if (pending) return pending.fromR;
        const trans = this.fallAnimations.get(key);
        if (!trans) return r;
        const t = (Date.now() - trans.startTime) / trans.duration;
        if (t >= 1) {
            this.fallAnimations.delete(key);
            return r;
        }
        // Ease-out cubic — feels like a natural fall with a soft landing.
        const eased = 1 - Math.pow(1 - t, 3);
        return trans.fromR + (r - trans.fromR) * eased;
    }

    private realignPieceSpawnRow(piece: import('../core/Types').Piece): void {
        if (!this.gameState) return;
        const totalRows = this.gameState.state.board.length;
        const scale = GameController.TOWER_VIEW_SCALE;
        // SNAP the board Y offset to its target BEFORE deriving the
        // visible top row. Without the snap, a fresh spawn that happens
        // right after `manageEndlessBoard` prepends rows would see a
        // stale (mid-lerp) offset — reading as "Row 0 is still where
        // it was before the board grew" — and shove the piece to the
        // wrong row. Snapping is fine visually because piece locks are
        // already a natural discontinuity (row clears, prop FX, board
        // growth); the camera catching up in the same frame reads as
        // part of that beat rather than a jarring jump.
        const target = this.targetBoardYOffset(totalRows);
        this.currentBoardYOffsetVal = target;
        // Row whose scaled WORLD Y sits at (or just below) the camera's
        // top edge (world Y = -Y_BOTTOM). Solve
        //   scale * (Y_BOTTOM + (totalRows-1-R)*CELL) + offset = -Y_BOTTOM
        // for R:
        //   R = totalRows - 1 - (-Y_BOTTOM - offset - scale*Y_BOTTOM) / (scale*CELL)
        // `Math.ceil` rather than floor: we want the first row that's
        // actually VISIBLE (its world Y at or below screen top), not
        // the last row still above the top edge.
        //
        // With the fixed endless offset, `visibleTopRow` for a mature
        // board (`totalRows` ≥ ~37) is 0 or slightly negative, so the
        // piece's natural spawn at y=0 already lands at (or just under)
        // screen top. For shorter boards the value goes very negative,
        // but we only ever push piece.y DOWN — never up — so early-game
        // spawns stay at row 0 rather than being teleported far above
        // the board (which would give a long "invisible fall" before
        // the piece enters view). Full camera stability is preserved:
        // no per-fill jumps, since the camera offset is constant.
        const topRowNumerator  = -Y_BOTTOM - this.currentBoardYOffsetVal - scale * Y_BOTTOM;
        const topRowDenominator = scale * CELL_SIZE;
        const visibleTopRow = Math.ceil(totalRows - 1 - topRowNumerator / topRowDenominator);
        // Spawn OFFSET: shifts the spawn row relative to the visible
        // top edge. POSITIVE = spawn ABOVE the edge (smaller `piece.y`
        // = higher on screen); NEGATIVE = spawn BELOW the edge, in
        // the visible play area. Tweak history: 8 → 3 → -2. At -2 the
        // piece materialises 2 rows BELOW the camera's top edge —
        // fully in view from the very first frame, no invisible fall.
        // CubeManager's piece renderer accepts negative rows, so cells
        // above row 0 still draw correctly.
        //
        // Set piece.y UNCONDITIONALLY (no `targetY > piece.y` guard)
        // so the shift can raise the piece above its initial row-0
        // spawn — with the fixed endless offset, `visibleTopRow` is
        // already at or near row 0 for a mature board, so the guard
        // would swallow the whole up-shift.
        const SPAWN_ROWS_ABOVE_VISIBLE_TOP = -1;
        piece.y = visibleTopRow - SPAWN_ROWS_ABOVE_VISIBLE_TOP;
        // Cache the just-computed spawn Y so other systems (gatling)
        // can spawn projectiles at the exact same on-screen height as a
        // freshly-spawned piece (e.g. a meteor DOT). Grabbing the live
        // `piece.y` later doesn't work because the piece may have
        // already fallen partway when the item activates.
        this.gameState.lastPieceSpawnY = piece.y;
        // Spawn-collision fail: if the freshly-positioned piece overlaps
        // any filled cell of the locked tower, the tower has "reached"
        // the spawn point and the run is over. Only applies to endless
        // and blind — level / collect fail via the level-specific
        // top-out check in GameState. `collides(dx=0, dy=0)` tests the
        // piece at its exact current position (no directional offset).
        const mode = this.gameState?.mode;
        if ((mode === 'endless' || mode === 'blind')
            && collides(this.gameState.state.board, piece, 0, 0, piece.shape)) {
            this.gameState.spawnCollisionFail();
        }
    }

    /** Advance the smoothed board Y offset toward its target. Split out
     *  of `rotateCylinder` so the main loop can call it BEFORE the piece
     *  realignment + cube sync, ensuring every consumer this frame
     *  reads the freshly-snapped/lerped value. */
    /** Last-seen `totalRows` — used to detect a bottom-peel (which
     *  drops totalRows by N and instantly lowers every row's world Y
     *  by N * scale * CELL). Compensating for that snap makes the
     *  post-cap "tower shifts down" animate smoothly. */
    private lastKnownTotalRows: number = -1;

    private updateBoardYOffset(): void {
        const totalRows = this.gameState?.state.board.length ?? VISIBLE_ROWS;
        const target = this.targetBoardYOffset(totalRows);

        // Peel-animation compensation.
        //
        // When `manageEndlessBoard` splices bottom-most gray rows
        // (grayCount > cap), `totalRows` drops. Every remaining row's
        // local Y = Y_BOTTOM + (totalRows-1-R)*CELL — a drop in
        // totalRows subtracts CELL from every row's local Y, which
        // translates to a `scale*CELL` (0.75 unit) drop in world Y for
        // the ENTIRE tower on the very next render.
        //
        // Left alone, that's an instantaneous teleport — no animation.
        // Compensating: bump `currentBoardYOffsetVal` UP by the same
        // amount right after the peel, so the tower appears to hold
        // its old position for a frame. The lerp below then eases the
        // offset back toward `target` (unchanged post-cap), which
        // visually plays as a smooth 0.75-unit slide-down of the whole
        // tower — matching the pre-cap `pendingShift` animation and
        // fixing the "no visible drop after 20 rows" report.
        if (this.lastKnownTotalRows > 0 && totalRows < this.lastKnownTotalRows) {
            const peeled = this.lastKnownTotalRows - totalRows;
            this.currentBoardYOffsetVal += peeled * GameController.TOWER_VIEW_SCALE * CELL_SIZE;
        }
        this.lastKnownTotalRows = totalRows;

        // Snap on first frame after a new board, ease toward the target
        // afterwards. `0.18` is a critically-damped feel: catches up to
        // a single-row delta in ~6 frames at 60fps, no overshoot, no
        // jitter when the target is stable.
        if (!this.boardYOffsetInitialised) {
            this.currentBoardYOffsetVal = target;
            this.boardYOffsetInitialised = true;
        } else {
            const lerpAlpha = 0.18;
            this.currentBoardYOffsetVal += (target - this.currentBoardYOffsetVal) * lerpAlpha;
        }
    }

    /** Rotate BoardRoot3D so the active piece's column always faces camera,
     *  AND apply the camera-tracking Y offset (computed earlier by
     *  `updateBoardYOffset`). Also re-positions the warning ring. */
    private rotateCylinder(): void {
        if (!this.boardRoot3D) return;
        const centerCol = this.currentCenterCol();
        const yawDeg = -math.toDegree(centerCol * ANGLE_PER_COL);
        this.boardRoot3D.setRotationFromEuler(0, yawDeg, 0);

        this.boardRoot3D.setPosition(0, this.currentBoardYOffsetVal, 0);

        const totalRows = this.gameState?.state.board.length ?? VISIBLE_ROWS;
        this.updateWarningRing(totalRows);
    }

    /** Place the warning ring `ENDLESS_HEIGHT_LIMIT` rows above the
     *  gray foundation. Same formula in every mode — level 73 previously
     *  broke when we tried to anchor level mode at row 0, which is far
     *  above the initial task zone on tall level boards (30+ rows) and
     *  therefore off-screen. Using the foundation-relative formula keeps
     *  the ring at a visible, meaningful height regardless of board
     *  size or level content.
     *
     *  In level mode `countBottomCompleteRows` picks up the reserved
     *  zone (all-'X' rows at the bottom); as the player clears task
     *  rows the foundation stays the same, so the warning stays put.
     *
     *  The ring counter-rotates so its 180° dashed half stays world-
     *  fixed (facing the camera). Blind mode shows it too so the
     *  player has a world-space cue for the cap even though tower
     *  cells are invisible. */
    private updateWarningRing(_totalRows: number): void {
        // Warning ring disabled globally — the game now fails at spawn
        // collision (see `realignPieceSpawnRow`) instead of at a fixed
        // height line, so the ring's cue is no longer meaningful. The
        // node and creation code are preserved so re-enabling later is
        // just a matter of restoring the positioning logic here.
        if (this.warningRing) this.warningRing.active = false;
    }

    private currentCenterCol(): number {
        const g = this.gameState;
        // During any storm, the camera follows `lastSpawnCenterCol`
        // (updated by `moveCylinder` while a storm is active). Without
        // this branch, an item-triggered gatling storm — where `current`
        // is still alive — would render bullets at the piece's centre,
        // but `gatling.tick` would aim them at `lastSpawnCenterCol`,
        // and the two would desync as soon as the player rotated.
        //
        // ROUND to the nearest integer: `lastSpawnCenterCol` can be
        // fractional (piece-center of a 3-wide piece like T/S/Z is
        // `piece.x + 1.5`). Gatling.tick's `liveCol =
        // Math.round(liveTargetCol)` snaps the destroyed-cell column
        // to an integer; the tower's yaw and the bullet's local X/Z
        // must snap to the SAME integer or the bullet visually lands
        // on screen centre while the destroyed cube ends up 0.5 col
        // off to one side.
        if (g.hail.mode || g.rocket.mode || g.gatling.mode) {
            return Math.round(g.lastSpawnCenterCol ?? 0);
        }
        const p = g.current;
        if (p) {
            let minX = p.shape[0].length, maxX = -1;
            for (let r = 0; r < p.shape.length; r++) {
                for (let c = 0; c < p.shape[r].length; c++) {
                    if (p.shape[r][c]) {
                        if (c < minX) minX = c;
                        if (c > maxX) maxX = c;
                    }
                }
            }
            if (maxX >= 0) return p.x + (minX + maxX + 1) / 2;
            return p.x;
        }
        return g.lastSpawnCenterCol ?? 0;
    }

    /** Convert a (row, col) board cell to its current WORLD position by
     *  running the placeCube LOCAL formula through `boardRoot3D`'s
     *  world matrix. Correctly accounts for the tower view scale
     *  (TOWER_VIEW_SCALE = 0.75), board yaw, and endless-mode camera
     *  Y-translation — all baked into `boardRoot3D.worldMatrix`.
     *  Star bursts spawned at cell positions use this so their world-
     *  frame integration starts at the true cell centre. */
    private static _tmpMat4 = new Mat4();
    private static _tmpLocal = new Vec3();
    private cellWorldPos(r: number, c: number, out?: Vec3): Vec3 {
        if (!out) out = new Vec3();
        if (!this.gameState || !this.boardRoot3D) { out.set(0, 0, 0); return out; }
        const totalRows = this.gameState.state.board.length;
        const theta = c * ANGLE_PER_COL;
        const localX = RADIUS * Math.sin(theta);
        const localZ = RADIUS * Math.cos(theta);
        const localY = Y_BOTTOM + ((totalRows - 1) - r) * CELL_SIZE;
        const mat = this.boardRoot3D.getWorldMatrix(GameController._tmpMat4);
        GameController._tmpLocal.set(localX, localY, localZ);
        Vec3.transformMat4(out, GameController._tmpLocal, mat);
        return out;
    }

    // ============================================================
    //  Input
    // ============================================================
    private onKeyDown(evt: EventKeyboard): void {
        this.lastCocosKeyAt = Date.now();
        if (!this.gameState) return;
        const now = Date.now();
        switch (evt.keyCode) {
            case KeyCode.ARROW_LEFT:
                this._tryRotateTower(-1);
                if (this.leftHeld === 0) { this.leftHeld = now; this.leftLastFire = now; }
                break;
            case KeyCode.ARROW_RIGHT:
                this._tryRotateTower(+1);
                if (this.rightHeld === 0) { this.rightHeld = now; this.rightLastFire = now; }
                break;
            case KeyCode.ARROW_UP:
                this.gameState.tryRotate(1);
                SoundManager.instance?.play('piece_rotate');
                break;
            case KeyCode.KEY_Z:
                this.gameState.tryRotate(-1);
                SoundManager.instance?.play('piece_rotate');
                break;
            case KeyCode.ARROW_DOWN:
                this.gameState.hardDrop();
                SoundManager.instance?.play('hard_drop');
                break;
            case KeyCode.SPACE:
                this.gameState.tryRotate(1);
                SoundManager.instance?.play('piece_rotate');
                break;
            case KeyCode.KEY_C:
            case KeyCode.SHIFT_LEFT:  this.gameState.hold();           break;
            case KeyCode.KEY_P:
            case KeyCode.ESCAPE:      this.gameState.togglePause();    break;
            // Debug: 1-9 → load level [idx]. 0 → return to endless mode.
            case KeyCode.DIGIT_0:     this.startEndless();             break;
            case KeyCode.DIGIT_1:     this.loadLevelByIndex(0);        break;
            case KeyCode.DIGIT_2:     this.loadLevelByIndex(1);        break;
            case KeyCode.DIGIT_3:     this.loadLevelByIndex(2);        break;
            case KeyCode.DIGIT_4:     this.loadLevelByIndex(3);        break;
            case KeyCode.DIGIT_5:     this.loadLevelByIndex(4);        break;
            case KeyCode.DIGIT_6:     this.loadLevelByIndex(5);        break;
            case KeyCode.DIGIT_7:     this.loadLevelByIndex(6);        break;
            case KeyCode.DIGIT_8:     this.loadLevelByIndex(7);        break;
            case KeyCode.DIGIT_9:     this.loadLevelByIndex(8);        break;
            default: break;
        }
    }

    private onKeyUp(evt: EventKeyboard): void {
        switch (evt.keyCode) {
            case KeyCode.ARROW_LEFT:  this.leftHeld  = 0; break;
            case KeyCode.ARROW_RIGHT: this.rightHeld = 0; break;
        }
    }

    /**
     * DOM-level keyboard fallback for the browser preview, where Cocos's
     * `input` event sometimes doesn't fire until the canvas has been clicked.
     * If a Cocos input event fired within the last 100 ms we skip — that
     * means both listeners are alive (editor preview) and we don't want to
     * double-handle the keystroke.
     */
    private onDomKeyDown = (e: KeyboardEvent): void => {
        if (Date.now() - this.lastCocosKeyAt < 100) return;
        if (!this.gameState) return;
        log('[TowerBlocks] keyDown(DOM) code=' + e.code + (e.repeat ? ' (repeat)' : ''));
        const now = Date.now();
        let handled = true;
        switch (e.code) {
            case 'ArrowLeft':
                this._tryRotateTower(-1);
                if (this.leftHeld === 0) { this.leftHeld = now; this.leftLastFire = now; }
                break;
            case 'ArrowRight':
                this._tryRotateTower(+1);
                if (this.rightHeld === 0) { this.rightHeld = now; this.rightLastFire = now; }
                break;
            // Single-shot keys — ignore browser auto-repeat by checking e.repeat.
            case 'ArrowUp':    if (!e.repeat) this.gameState.tryRotate(1);  break;
            case 'KeyZ':       if (!e.repeat) this.gameState.tryRotate(-1); break;
            case 'ArrowDown':  if (!e.repeat) this.gameState.hardDrop();    break;
            case 'Space':      if (!e.repeat) this.gameState.tryRotate(1);  break;
            case 'KeyC':
            case 'ShiftLeft':  if (!e.repeat) this.gameState.hold();        break;
            case 'KeyP':
            case 'Escape':     if (!e.repeat) this.gameState.togglePause(); break;
            // Level shortcuts (DOM path).
            case 'Digit0':     if (!e.repeat) this.startEndless();             break;
            case 'Digit1':     if (!e.repeat) this.loadLevelByIndex(0);        break;
            case 'Digit2':     if (!e.repeat) this.loadLevelByIndex(1);        break;
            case 'Digit3':     if (!e.repeat) this.loadLevelByIndex(2);        break;
            case 'Digit4':     if (!e.repeat) this.loadLevelByIndex(3);        break;
            case 'Digit5':     if (!e.repeat) this.loadLevelByIndex(4);        break;
            case 'Digit6':     if (!e.repeat) this.loadLevelByIndex(5);        break;
            case 'Digit7':     if (!e.repeat) this.loadLevelByIndex(6);        break;
            case 'Digit8':     if (!e.repeat) this.loadLevelByIndex(7);        break;
            case 'Digit9':     if (!e.repeat) this.loadLevelByIndex(8);        break;
            default: handled = false; break;
        }
        if (handled) e.preventDefault();
    };

    private onDomKeyUp = (e: KeyboardEvent): void => {
        switch (e.code) {
            case 'ArrowLeft':  this.leftHeld  = 0; break;
            case 'ArrowRight': this.rightHeld = 0; break;
        }
    };

    // ============================================================
    //  Level loading
    // ============================================================
    /** Load level at index `idx` from the flattened level list.
     *  Public so MenuController can call it from the level-select panel. */
    public loadLevelByIndex(idx: number): void {
        if (!this.gameState) return;
        if (idx < 0 || idx >= this.flatLevels.length) {
            log(`[TowerBlocks] level ${idx + 1} not found (have ${this.flatLevels.length} levels).`);
            return;
        }
        // Firebase predefined event — populates Progression report.
        AnalyticsApi.logLevelStart('level', idx + 1);
        try {
            const lvl = validateLevelData(this.flatLevels[idx]);
            this.clearPendingPopups();
            this.clearBlindHudArtifacts();
            // Remember which level is playing so `onLevelWin` can persist
            // the completion via LevelProgress.
            this._activeLevelIdx = idx;
            this.gameState.startLevel(lvl);
            // Snap the HUD level timer back to its top-strip rest
            // position + un-freeze its value. Otherwise the previous
            // level's tween-to-center parking would still be in effect
            // for this fresh run.
            this.hudController?.resetLevelTimerPosition?.();
            this.boardYOffsetInitialised = false;
            this.lastKnownTotalRows = -1;
            this.prevPieceRef = null;
            this.fallAnimations.clear();
            this.pendingFallMoves.clear();
            this.wreckerCommitAt = 0;
            log(`[TowerBlocks] loaded level ${idx + 1}: ${lvl.name ?? lvl.id ?? '(unnamed)'}`);
        } catch (err) {
            log(`[TowerBlocks] failed to load level ${idx + 1}: ${(err as Error).message}`);
        }
    }

    /** Level-entry transition — every board cube the level just loaded
     *  starts OUTSIDE the tower (world position offset radially outward
     *  by ~20 units, scale 0) and tweens back to its target position +
     *  full scale with a random stagger. The game loop is paused while
     *  this runs — `update()` short-circuits on `_assembling` so tick /
     *  syncCubes don't stomp the tweens. Calls `onDone` on completion.
     *
     *  Requires `loadLevelByIndex` to have already been called (so the
     *  board is populated and CubeManager has placed cubes at their
     *  target positions during whatever syncCubes call ran first). */
    public playLevelAssembly(dur: number, onDone: () => void): void {
        if (this._assembling) return;
        if (!this.boardRoot3D) {
            onDone();
            return;
        }

        // Force one syncCubes so every board cell + piece is placed at
        // its target position BEFORE we go read those positions off.
        this.syncCubes();

        // Snapshot every active cube — direct children of boardRoot3D
        // captures the brick pool, all item-cube pools, and the current
        // piece (which shares the brick pool). We don't need to iterate
        // per-pool because the parent-side view is sufficient.
        const cubes: Node[] = [];
        for (const child of this.boardRoot3D.children) {
            if (child && child.isValid && child.active) cubes.push(child);
        }
        const N = cubes.length;
        if (N === 0) {
            onDone();
            return;
        }

        this._assembling = true;

        // Random ordering so the assembly reads as a swarm rather than
        // a row-by-row sweep.
        const order: number[] = Array.from({ length: N }, (_, i) => i);
        for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }

        const staggerWindow = Math.max(0.05, dur * 0.5);
        const flyDur = Math.max(0.15, dur - staggerWindow);
        const startDistBase = 20;

        for (let k = 0; k < N; k++) {
            const node = cubes[order[k]];
            if (!node || !node.isValid) continue;

            const delay = (k / N) * staggerWindow;
            const wp = node.worldPosition.clone();
            const tgtX = wp.x, tgtY = wp.y, tgtZ = wp.z;
            const s = node.scale;
            const tgtSX = s.x, tgtSY = s.y, tgtSZ = s.z;

            // Radial-outward direction (from the tower axis). Cubes
            // dead-centre on the axis get a random angular pick so they
            // don't stack in the same starting spot.
            const rXZ = Math.sqrt(tgtX * tgtX + tgtZ * tgtZ);
            let dirX: number, dirZ: number;
            if (rXZ < 0.05) {
                const a = Math.random() * Math.PI * 2;
                dirX = Math.sin(a);
                dirZ = Math.cos(a);
            } else {
                const jitter = (Math.random() - 0.5) * 0.6;
                const angle = Math.atan2(tgtX, tgtZ) + jitter;
                dirX = Math.sin(angle);
                dirZ = Math.cos(angle);
            }
            const dirY = (Math.random() - 0.5) * 0.6;
            const dist = startDistBase * (0.75 + Math.random() * 0.5);

            const startX = tgtX + dirX * dist;
            const startY = tgtY + dirY * dist;
            const startZ = tgtZ + dirZ * dist;

            // Kick the cube out to its starting spot immediately (so
            // the FIRST frame after this method returns shows a blank
            // scene rather than the assembled level).
            node.setWorldPosition(startX, startY, startZ);
            node.setScale(0, 0, 0);

            const carrier = { t: 0 };
            tween(carrier as any)
                .delay(delay)
                .to(flyDur, { t: 1 }, {
                    easing: 'quadOut',
                    onUpdate: () => {
                        if (!node.isValid) return;
                        const t = carrier.t;
                        node.setWorldPosition(
                            startX + (tgtX - startX) * t,
                            startY + (tgtY - startY) * t,
                            startZ + (tgtZ - startZ) * t,
                        );
                        node.setScale(tgtSX * t, tgtSY * t, tgtSZ * t);
                    },
                })
                .start();
        }

        // Fire onDone once the last cube has settled, then hand
        // authority back to the update() loop.
        const totalDur = staggerWindow + flyDur;
        const doneTrigger = { _: 0 };
        tween(doneTrigger as any)
            .delay(totalDur)
            .call(() => {
                this._assembling = false;
                onDone();
            })
            .start();
    }

    /** Level-exit transition — mirror of `playLevelAssembly`. Every
     *  active board cube tweens outward from its current position with
     *  a random stagger and shrinks to 0. The game loop is paused
     *  while this runs (same `_assembling` flag) so tick + syncCubes
     *  don't overwrite the tweens. Calls `onDone` on completion. */
    public playLevelScatter(dur: number, onDone: () => void): void {
        if (this._assembling) return;
        if (!this.boardRoot3D) {
            onDone();
            return;
        }

        // Snapshot every active cube — same collection strategy as
        // playLevelAssembly. This includes any locked block, any
        // remaining task/reserved cells, and the currently-falling
        // piece if it hasn't locked yet.
        const cubes: Node[] = [];
        for (const child of this.boardRoot3D.children) {
            if (child && child.isValid && child.active) cubes.push(child);
        }
        const N = cubes.length;
        if (N === 0) {
            onDone();
            return;
        }

        this._assembling = true;

        // Random ordering so the scatter reads as a swarm rather than
        // a row-by-row sweep.
        const order: number[] = Array.from({ length: N }, (_, i) => i);
        for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }

        const staggerWindow = Math.max(0.05, dur * 0.5);
        const flyDur = Math.max(0.15, dur - staggerWindow);
        const flyDistBase = 18;

        for (let k = 0; k < N; k++) {
            const node = cubes[order[k]];
            if (!node || !node.isValid) continue;

            const delay = (k / N) * staggerWindow;
            const wp = node.worldPosition.clone();
            const initX = wp.x, initY = wp.y, initZ = wp.z;
            const s = node.scale;
            const initSX = s.x, initSY = s.y, initSZ = s.z;

            // Radial-outward direction (from the tower axis).
            const rXZ = Math.sqrt(initX * initX + initZ * initZ);
            let dirX: number, dirZ: number;
            if (rXZ < 0.05) {
                const a = Math.random() * Math.PI * 2;
                dirX = Math.sin(a);
                dirZ = Math.cos(a);
            } else {
                const jitter = (Math.random() - 0.5) * 0.6;
                const angle = Math.atan2(initX, initZ) + jitter;
                dirX = Math.sin(angle);
                dirZ = Math.cos(angle);
            }
            const dirY = (Math.random() - 0.3) * 0.6;   // slight up bias
            const speed = 0.7 + Math.random() * 0.6;

            const carrier = { t: 0 };
            tween(carrier as any)
                .delay(delay)
                .to(flyDur, { t: 1 }, {
                    easing: 'quadOut',
                    onUpdate: () => {
                        if (!node.isValid) return;
                        const t = carrier.t;
                        const d = flyDistBase * speed * t;
                        node.setWorldPosition(
                            initX + dirX * d,
                            initY + dirY * d,
                            initZ + dirZ * d,
                        );
                        const sc = Math.max(0, 1 - t);
                        node.setScale(initSX * sc, initSY * sc, initSZ * sc);
                    },
                })
                .call(() => {
                    if (node.isValid) node.active = false;
                })
                .start();
        }

        // Fire onDone once the last cube has finished.
        const totalDur = staggerWindow + flyDur;
        const doneTrigger = { _: 0 };
        tween(doneTrigger as any)
            .delay(totalDur)
            .call(() => {
                this._assembling = false;
                onDone();
            })
            .start();
    }

    /** Dispatch a row-clear visual based on `clearEffect`:
     *   1 → Rainbow flash on the cleared row.
     *  Anything else falls through silently (no visual). Chunk-burst
     *  mode (clearEffect=0) was removed with ShatterController. */
    private onShatter(r: number, content: ReadonlyArray<CellValue | null>): void {
        if (!this.gameState) return;
        if (this.clearEffect === 1) {
            this.queueFlash(r, content);
        }
    }

    /** Queue all 24 cells on row `r` for the pre-detonation pulse.
     *  Storage is (r, c) — render computes local coords per frame. */
    private queuePrePulseRow(r: number): void {
        if (!this.gameState) return;
        const now = Date.now();
        for (let c = 0; c < COLS; c++) {
            this.prePulseCells.push({ r, c, startTime: now });
        }
    }

    /** Build the reusable vertical-streak FX for column bomb detonations.
     *  Same pre-build pattern as the row-blast FX: build inactive, set
     *  autoPlay=false, then activate so onLoad runs (building meshes
     *  without playing). Runtime trigger costs are just yaw + position. */
    private buildColBlastDetonateFx(): void {
        if (!this.boardRoot3D) return;
        const n = new Node('ColBlastDetonate');
        n.active = false;
        n.parent = this.boardRoot3D;
        n.layer  = this.boardRoot3D.layer;
        const fx = n.addComponent(ColBlastDetonateEffect);
        fx.autoPlay = false;
        n.active = true;
        this.colBlastDetonateFx = fx;
        log('[TowerBlocks] col-blast detonate FX pre-built.');
    }

    /** Build the reusable ribbon detonation FX once. The 1440+ mesh
     *  nodes it creates would cause a frame hitch if built on every
     *  detonation — pre-building keeps the runtime trigger cost to a
     *  reposition + state reset. */
    private buildRowBlastDetonateFx(): void {
        if (!this.boardRoot3D) return;
        // Build the node INACTIVE so we can set `autoPlay = false` on the
        // component BEFORE its `onLoad` fires (which happens when the
        // node is first activated).
        const n = new Node('RowBlastDetonate');
        n.active = false;
        n.parent = this.boardRoot3D;
        n.layer  = this.boardRoot3D.layer;
        const fx = n.addComponent(RowBlastDetonateEffect);
        fx.autoPlay = false;
        // Activate to trigger onLoad → buildRibbon (the heavy mesh
        // allocation happens HERE at game start, not at detonation).
        n.active = true;
        this.rowBlastDetonateFx = fx;
        log('[TowerBlocks] row-blast detonate FX pre-built.');
    }

    /** Revive celebration: wait a short beat, then play the standard
     *  row-clear rainbow flash (`onShatter` → `queueFlash`) on every
     *  colored row bottom-up staggered, then actually wipe the board
     *  via `gameState.reviveEndless()`. The visual + audio match a
     *  real row-bomb detonation so it reads as "one giant chain
     *  detonation" the ad-watch / gem-spend paid for.
     *
     *  Sequence:
     *    1. 500 ms hold — lets the revive prompt fully fade so the
     *       player sees the tower again before things start blowing up.
     *    2. For each colored row (bottom-up), queue the row-clear
     *       flash + line_clear SFX + medium haptic — SAME wiring as
     *       the real onPartialShatter hook.
     *    3. Wait FLASH_LIFE_MS after the last row's flash queues,
     *       then call reviveEndless (nulls the cells + spawns fresh
     *       piece + un-freezes running).
     *    4. Fire onDone so the caller can dismiss any lingering UI.
     *
     *  onDone runs even when nothing to blast (empty board) so the
     *  caller's completion callback is unconditional. */
    public playReviveWipe(onDone: () => void): void {
        const gs = this.gameState;
        if (!gs) { onDone(); return; }
        // Clear the falling piece IMMEDIATELY — it's the one that
        // just spawn-collided (or was mid-fall when game-over
        // fired) and stays visible as a floating tetromino above
        // the tower otherwise. reviveEndless() spawns a fresh one
        // at the end; between now and then, the play field should
        // look like it belongs to the sweep animation, not carry
        // the "dead" piece into it.
        gs.current = null;
        // Collect colored rows (bottom-up so the wave visually reads
        // as sweeping the tower upward from the base). Snapshot the
        // row content NOW so the flash renderer paints the actual
        // colors the player sees at revive time — reviveEndless()
        // will null everything a few frames later.
        const H = gs.state.board.length;
        const rows: Array<{ r: number; content: (CellValue | null)[] }> = [];
        for (let r = H - 1; r >= 0; r--) {
            let hasColored = false;
            const content: (CellValue | null)[] = new Array(COLS).fill(null);
            for (let c = 0; c < COLS; c++) {
                const v = gs.state.board[r][c];
                if (isColoredCell(v)) { hasColored = true; content[c] = v; }
            }
            if (hasColored) rows.push({ r, content });
        }

        const STAGGER_MS   = 100;
        const PRE_HOLD_MS  = 500;
        // Flash lifetime — matches this.flashDuration (@property, default 0.5s).
        const FLASH_LIFE_MS = Math.max(300, this.flashDuration * 1000);

        const finish = () => {
            gs.reviveEndless();
            onDone();
        };

        if (rows.length === 0) {
            // Nothing to sweep — still honour the hold so the flow
            // feels consistent (revive prompt → brief hold → resume).
            setTimeout(finish, PRE_HOLD_MS);
            return;
        }

        setTimeout(() => {
            for (let i = 0; i < rows.length; i++) {
                const { r, content } = rows[i];
                setTimeout(() => {
                    // Same wiring as the onPartialShatter clearHook —
                    // rainbow flash + line_clear + medium haptic.
                    this.onShatter(r, content);
                    SoundManager.instance?.play('line_clear');
                    HapticsManager.impact('medium');
                    // Delete THIS row's colored cells (and parallel
                    // prop layers) right when its flash fires — the
                    // tower visibly "melts" bottom-up as the wave
                    // sweeps rather than snapping empty in one shot
                    // at the end. Flash uses the cached `content`
                    // snapshot so the visual still paints the proper
                    // colors. Leaves 'X' / 'H' foundation alone so
                    // blind mode's reserved zone stays.
                    const st = gs.state;
                    for (let c = 0; c < COLS; c++) {
                        if (!isColoredCell(st.board[r][c])) continue;
                        st.board[r][c] = null;
                        if (st.boardBombs     && st.boardBombs[r])     st.boardBombs[r][c]     = null;
                        if (st.boardBooms     && st.boardBooms[r])     st.boardBooms[r][c]     = null;
                        if (st.boardWreckers  && st.boardWreckers[r])  st.boardWreckers[r][c]  = null;
                        if (st.boardStones    && st.boardStones[r])    st.boardStones[r][c]    = null;
                        if (st.boardChests    && st.boardChests[r])    st.boardChests[r][c]    = null;
                        if (st.boardMeteors   && st.boardMeteors[r])   st.boardMeteors[r][c]   = null;
                        if (st.boardBlizzards && st.boardBlizzards[r]) st.boardBlizzards[r][c] = null;
                        if (st.boardHails     && st.boardHails[r])     st.boardHails[r][c]     = null;
                        if (st.boardRockets   && st.boardRockets[r])   st.boardRockets[r][c]   = null;
                        if (st.boardGatlings  && st.boardGatlings[r])  st.boardGatlings[r][c]  = null;
                    }
                }, i * STAGGER_MS);
            }
            const totalMs = (rows.length - 1) * STAGGER_MS + FLASH_LIFE_MS;
            setTimeout(finish, totalMs);
        }, PRE_HOLD_MS);
    }

    /** Trigger the pre-built ribbon detonation FX at row `r`'s height.
     *  No mesh allocation — just repositions the existing node and
     *  resets the effect's playback state. */
    private spawnRibbonDetonate(r: number): void {
        if (!this.rowBlastDetonateFx || !this.gameState) {
            log(`[TowerBlocks] spawnRibbonDetonate: skipped (fx=${!!this.rowBlastDetonateFx}, gameState=${!!this.gameState})`);
            return;
        }
        const totalRows = this.gameState.state.board.length;
        const rowY = Y_BOTTOM + ((totalRows - 1) - r) * CELL_SIZE;
        log(`[TowerBlocks] ★ trigger row-blast detonate row=${r}, rowY=${rowY.toFixed(2)}, totalRows=${totalRows}`);

        this.rowBlastDetonateFx.node.setPosition(0, rowY, 0);
        this.rowBlastDetonateFx.trigger();

        this.ribbonDetonateEndsAt = Math.max(
            this.ribbonDetonateEndsAt,
            Date.now() + this.rowBlastDetonateFx.duration * 1000,
        );
    }

    /** Layer celebration — halo + star sprinkle on every one of the
     *  24 cells of the newly-gray row. The halo is a brief rainbow
     *  flash cube on each cell (same pop the row-clear flash uses),
     *  the sparks fire at the exact cell centre so they burst OUT of
     *  the newly-gray brick rather than floating above it. */
    private playMilestoneShatter(): void {
        if (!this.gameState) return;
        const totalRows = this.gameState.state.board.length;
        const board = this.gameState.state.board;
        // Find the TOPMOST FULLY-GRAY row — every cell === 'X'. Using
        // "topmost non-empty" was wrong for L/T/S/Z pieces whose lock
        // leaves their upper cells sitting as COLORED bricks above the
        // newly-gray row; that would make the FX fire on the coloured
        // stub, not on the gray it just formed.
        let topR = totalRows;
        for (let r = 0; r < totalRows; r++) {
            let allGray = true;
            for (let c = 0; c < COLS; c++) {
                if (board[r][c] !== 'X') { allGray = false; break; }
            }
            if (allGray) { topR = r; break; }
        }
        if (topR >= totalRows) return;   // no gray row — nothing to celebrate

        const now = Date.now();
        const centerCol = this.currentCenterCol();
        const yawDeg = -math.toDegree(centerCol * ANGLE_PER_COL);
        const tmpWorld = new Vec3();
        for (let c = 0; c < COLS; c++) {
            // Halo: rainbow flash on every gray cell. `flashingCells`
            // stores (r, c) and the render pass computes local coords
            // per frame — the halo lands exactly on the brick.
            this.flashingCells.push({
                r: topR,
                c,
                colIndex: c & 31,
                startTime: now,
            });
            // Star burst — position sourced from the cell's true world
            // Y (center), so the sparks fire AT the newly-gray brick's
            // height, not offset above/below it.
            this.cellWorldPos(topR, c, tmpWorld);
            const cellTheta = c * ANGLE_PER_COL;
            this.spawnStarsAt(tmpWorld.x, tmpWorld.y, tmpWorld.z, cellTheta, yawDeg);
        }
    }

    /** Layer celebration — fired every time the endless-mode cumulative
     *  row counter advances. Spawns a ring of 12 spectrum-analyzer bars
     *  around the tower at the top of the filled portion. Each bar
     *  gets a random peak height (2..8 cells) and rises fast then
     *  falls slow, like a music-visualizer meter. Doesn't block
     *  gameplay. */
    private playMilestoneCelebration(layerNum: number, cumulative: number): void {
        if (!this.gameState) return;
        const totalRows = this.gameState.state.board.length;
        const board = this.gameState.state.board;
        // Topmost non-empty row — bars' bases sit on the top face of
        // this row.
        let topR = totalRows;
        for (let r = 0; r < totalRows; r++) {
            for (let c = 0; c < COLS; c++) {
                if (board[r][c] !== null) { topR = r; break; }
            }
            if (topR !== totalRows) break;
        }
        if (topR >= totalRows) topR = Math.max(0, totalRows - 1);

        // Ring is anchored at the ELEVATION of the newly-gray row:
        // its bottom edge sits on the top face of the topmost filled
        // row (topR), and it grows UPWARD from there. New fire
        // replaces any in-flight ring — no stacking.
        //
        // The mesh's top edge is FLAT — every segment reaches the same
        // peak height. (The placeholder mesh built in
        // `ensureSpectrumRingNode` is already flat, so we don't need
        // to rebuild here.)
        const bottomY = Y_BOTTOM + (totalRows - 1 - topR) * CELL_SIZE + CELL_SIZE / 2;
        const RING_PEAK_CELLS = 6;
        this.ensureSpectrumRingNode();
        this.spectrumRingState = {
            bottomY,
            peakHeightCells: RING_PEAK_CELLS,
            startTime: Date.now(),
        };
        // Sparkle burst that orbits with the ring — spawns fresh
        // particles positioned around the ring's initial silhouette.
        this.spawnSpectrumParticles(bottomY, RING_PEAK_CELLS);

        // Text pop + sound intentionally skipped — the spectrum bars
        // are the whole celebration for per-layer firing. `layerNum` /
        // `cumulative` retained on the hook for future "every 12th
        // layer = bigger celebration with text + sound" branching.
        void layerNum;
        void cumulative;
    }

    /** Queue every filled cell in the cleared row as a rainbow-flash sprite.
     *  Captures WORLD position at flash-start so the flash stays put even as
     *  BoardRoot3D yaws / translates around it. */
    private queueFlash(r: number, content: ReadonlyArray<CellValue | null>): void {
        if (!this.gameState) return;
        const totalRows = this.gameState.state.board.length;
        if (r < 0 || r >= totalRows) return;
        void content; // (see comment below — we intentionally flash all cols)
        const centerCol = this.currentCenterCol();
        const yawDeg    = -math.toDegree(centerCol * ANGLE_PER_COL);
        const now = Date.now();
        const tmpWorld = new Vec3();

        // Always flash + spawn stars across ALL 24 cells of the row, not
        // just the cells listed in `content`. A row-blast (rowN bomb)
        // splices the entire row regardless of fullness, so gaps in the
        // row used to leave dark spots in the rainbow sweep — the user
        // asked for the full effect to play across the whole ring.
        // Side effect: partial clears (excavator / wrecker) also flash
        // the surviving cells, which reads as "the blast lit the whole
        // ring even if it didn't pulverise every cube" — acceptable.
        for (let c = 0; c < COLS; c++) {
            this.flashingCells.push({
                r, c,
                colIndex: c,
                startTime: now,
            });
            this.cellWorldPos(r, c, tmpWorld);
            const cellTheta = c * ANGLE_PER_COL;
            this.spawnStarsAt(tmpWorld.x, tmpWorld.y, tmpWorld.z, cellTheta, yawDeg);
        }
    }

    /** Range-blast variant for boom items. `cleared` is the list of
     *  cells the engine just wiped (the Manhattan-diamond pattern
     *  centred on `centerR`,`centerC` with radius = `level`). Each cell
     *  gets a rainbow flash + star burst — staggered by Manhattan
     *  distance to the centre, so the wave radiates outward like a
     *  ripple.
     *
     *  Time stagger is `boomFlashStagger` seconds per Manhattan-unit
     *  away from the centre, and the centre cell is treated as a
     *  freshly-cleared cell with extra impact stars. Mirrors the look
     *  of `queueFlash` / `queueColFlash` so the player reads it as
     *  "same family of effect, different geometry".
     *
     *  The `level` parameter is currently unused but kept on the
     *  signature so future tuning (e.g. brighter pulse for L3) can plug
     *  in without changing the hook contract. */
    private queueBoomFlash(
        centerR: number,
        centerC: number,
        _level: 1 | 2 | 3,
        cleared: ReadonlyArray<{ r: number; c: number }>,
    ): void {
        if (!this.gameState) return;
        if (!cleared || cleared.length === 0) return;
        const totalRows = this.gameState.state.board.length;
        const centerCol = this.currentCenterCol();
        const yawDeg    = -math.toDegree(centerCol * ANGLE_PER_COL);
        const now = Date.now();
        const staggerMs = this.boomFlashStagger * 1000;
        const tmpWorld = new Vec3();

        for (const { r, c } of cleared) {
            if (r < 0 || r >= totalRows) continue;
            // Manhattan distance to centre — cylinder-wrap aware so the
            // boom at column 23 with radius 1 lights up column 0 at
            // distance 1, not distance 23.
            const drAbs = Math.abs(r - centerR);
            const rawDc = Math.abs(c - centerC);
            const dcAbs = Math.min(rawDc, COLS - rawDc);
            const manhattan = drAbs + dcAbs;
            const delay = manhattan * staggerMs;

            this.flashingCells.push({
                r, c,
                // Hue offset varies per-cell so the diamond reads as
                // multi-coloured (same trick as queueFlash using col
                // index, and queueColFlash using row index).
                colIndex: (r * 7 + c) & 31,
                startTime: now + delay,
            });
            this.cellWorldPos(r, c, tmpWorld);
            const cellTheta = c * ANGLE_PER_COL;
            this.scheduleStarBurstAt(tmpWorld.x, tmpWorld.y, tmpWorld.z, cellTheta, yawDeg, delay);
        }

        // Centre-of-impact extra burst — a louder star puff at the boom
        // origin, fired immediately (no stagger), so the player's eye
        // anchors on where the blast started before the diamond
        // ripples outward.
        if (centerR >= 0 && centerR < totalRows) {
            this.cellWorldPos(centerR, centerC, tmpWorld);
            const cellTheta = centerC * ANGLE_PER_COL;
            this.spawnStarsAt(tmpWorld.x, tmpWorld.y, tmpWorld.z, cellTheta, yawDeg);
        }
    }

    /** Column-blast variant of `queueFlash`: starting at the trigger row,
     *  light up cells UP and DOWN along the column in a staggered wave.
     *  Each cell goes through the same rainbow flash + star burst the
     *  row-clear flash uses; only the geometry (a column slice instead
     *  of a row slice) and the start-time stagger differ. */
    private queueColFlash(triggerR: number, c: number): void {
        if (!this.gameState) return;
        const totalRows = this.gameState.state.board.length;
        const centerCol = this.currentCenterCol();
        const yawDeg    = -math.toDegree(centerCol * ANGLE_PER_COL);
        const now = Date.now();
        const cellTheta = c * ANGLE_PER_COL;

        const ext        = Math.max(1, this.colFlashExtent | 0);
        const staggerMs  = this.colFlashStagger * 1000;
        const tmpWorld = new Vec3();

        for (let d = -ext; d <= ext; d++) {
            const r = triggerR + d;
            if (r < 0 || r >= totalRows) continue;
            const delay  = Math.abs(d) * staggerMs;
            // Re-use `colIndex` as the hue-offset key — using `r` here
            // gives adjacent rows distinct hues so the wave reads as
            // rainbow stripes along the column.
            this.flashingCells.push({
                r, c,
                colIndex: r,
                startTime: now + delay,
                // No pop-in growth — cell appears full size and shrinks
                // toward zero. With the staggered startTime the wave
                // ends up with a flat leading edge and a tapered tail.
                trailOnly: true,
            });
            // Stars also stagger so the sparkle wave follows the flash.
            this.cellWorldPos(r, c, tmpWorld);
            this.scheduleStarBurstAt(tmpWorld.x, tmpWorld.y, tmpWorld.z, cellTheta, yawDeg, delay);
        }
    }

    /** Like `spawnStarsAt` but delayed by `delayMs`. Implemented by
     *  scheduling via `setTimeout` — cheap and adequate for one-shot
     *  detonation sparkles. */
    private scheduleStarBurstAt(
        wx: number, wy: number, wz: number,
        cellTheta: number, boardYawDeg: number,
        delayMs: number,
    ): void {
        if (delayMs <= 0) {
            this.spawnStarsAt(wx, wy, wz, cellTheta, boardYawDeg);
            return;
        }
        setTimeout(() => {
            // Component might be destroyed mid-delay — bail safely.
            if (!this.node || !this.node.isValid) return;
            this.spawnStarsAt(wx, wy, wz, cellTheta, boardYawDeg);
        }, delayMs);
    }

    /** Spawn `flashStarsPerCell` glittery specks at a given cell. Direction
     *  is mostly OUTWARD (radially away from the cylinder centre) and
     *  UPWARD, with random jitter for natural variety.
     *
     *  `sizeMult` multiplies both the STAR SIZE and the LIFETIME so
     *  trail-mode callers can produce smaller, shorter-lived sparks
     *  than the full shatter-burst version — default 1.0 preserves the
     *  original elimination FX. Called with e.g. 0.45 for the rocket/
     *  gatling trail so the trail reads as "fine sparkles" instead of
     *  "another cube exploding". */
    private spawnStarsAt(
        wx: number, wy: number, wz: number,
        cellTheta: number, boardYawDeg: number,
        sizeMult: number = 1.0,
    ): void {
        const speedSpread = this.flashStarSpeedMax - this.flashStarSpeedMin;
        const lifeSpread  = this.flashStarLifetimeMax - this.flashStarLifetimeMin;
        // Board-frame outward direction is sin(theta), cos(theta) in (X, Z).
        // After board yaw, world outward is rotated by yawRad.
        const yawRad = math.toRadian(boardYawDeg);
        const cosY = Math.cos(yawRad), sinY = Math.sin(yawRad);
        const outBoardX = Math.sin(cellTheta);
        const outBoardZ = Math.cos(cellTheta);
        const outX = cosY * outBoardX + sinY * outBoardZ;
        const outZ = -sinY * outBoardX + cosY * outBoardZ;

        for (let i = 0; i < this.flashStarsPerCell; i++) {
            // Direction = outward + up, with jitter cone.
            const elev = Math.PI / 6 + Math.random() * (Math.PI / 3);   // 30°–90°
            const jitterAng = (Math.random() - 0.5) * 1.2;              // ±0.6 rad spread
            const cosE = Math.cos(elev), sinE = Math.sin(elev);
            const cosJ = Math.cos(jitterAng), sinJ = Math.sin(jitterAng);
            // Rotate the (outX, outZ) direction by jitterAng around Y axis.
            const dxFlat =  cosJ * outX + sinJ * outZ;
            const dzFlat = -sinJ * outX + cosJ * outZ;
            const dx = dxFlat * cosE;
            const dz = dzFlat * cosE;
            const dy = sinE;

            const speed = this.flashStarSpeedMin + Math.random() * speedSpread;
            const lifetime = (this.flashStarLifetimeMin + Math.random() * lifeSpread) * sizeMult;
            const size = this.flashStarSize * (0.6 + Math.random() * 0.8) * sizeMult;

            this.stars.push({
                px: wx + (Math.random() - 0.5) * 0.4,
                py: wy + 0.2 + (Math.random() - 0.5) * 0.4,
                pz: wz + (Math.random() - 0.5) * 0.4,
                vx: dx * speed,
                vy: dy * speed,
                vz: dz * speed,
                spinX: (Math.random() - 0.5) * 12,
                spinY: (Math.random() - 0.5) * 12,
                spinZ: (Math.random() - 0.5) * 12,
                rotX: 0, rotY: 0, rotZ: 0,
                age: 0,
                lifetime,
                hue: Math.random(),
                size,
            });
        }
    }

    /** Return to endless mode (resets the board).
     *  Public so MenuController can call it. `customPiece` is the player's
     *  picked fate piece from the 本命方块 modal; when present it gets
     *  injected into the bag so it's drawn alongside the standard 7
     *  tetrominoes for the whole endless run. */
    public startEndless(customPiece?: { baseType: import('../core/Constants').PieceType; shape: number[][] }): void {
        if (!this.gameState) return;
        this.clearPendingPopups();
        this._activeLevelIdx = -1;
        this.clearBlindHudArtifacts();
        // Endless mode has no "level" per se — log with level=0 so
        // level_end for endless (fired from submitEndlessHeight, if
        // we add it there) can match. Not counted in Progression
        // funnel since 'endless:0' won't match any level_start row.
        AnalyticsApi.logCustom('mode_start', { mode: 'endless' });
        // Reset the per-run auto-submit tracker so the first
        // ENDLESS_AUTO_SUBMIT_INTERVAL boundary of the NEW run fires
        // even if the previous run had already submitted at higher
        // cumulatives. Without this, retrying after a 200-layer run
        // wouldn't submit again until layer 250.
        this._lastEndlessAutoSubmit = 0;
        // Pass the fate piece (if any) straight through to newGame so it
        // gets registered with the bag BEFORE the initial refill — the
        // first piece can then draw the custom shape.
        this.gameState.newGame(customPiece);
        this.boardYOffsetInitialised = false;
        this.lastKnownTotalRows = -1;
        log('[TowerBlocks] endless mode started.');
    }

    /** Tear down blind-mode HUD leftovers (top "列 N" indicator + 3D beam)
     *  when entering any NON-blind mode. Fixes the case where a blind
     *  fail → mode switch to endless / level / tutorial left the column
     *  label visible up top because the HUD's own visibility sync ran
     *  before GameState.mode flipped. */
    private clearBlindHudArtifacts(): void {
        const hud: any = this.hudController;
        if (hud && typeof hud.setBlindIndicatorVisible === 'function') {
            hud.setBlindIndicatorVisible(false);
        }
        this.setBlindBeamVisible(false);
    }

    /** Boot the new-player operations tutorial. Loads the programmatic
     *  practice tower + sets `tutorialActive`. Sequel: TutorialController
     *  overlays the animated hand + waits for gestures; when it's done
     *  it calls `endTutorial()` which fires the scatter transition and
     *  the caller then loads level 1. */
    public startTutorial(): void {
        if (!this.gameState) return;
        this.clearPendingPopups();
        this._activeLevelIdx = -1;
        this.clearBlindHudArtifacts();
        this.gameState.tutorialActive = true;
        this.gameState.startLevel(buildTutorialLevel());
        this.boardYOffsetInitialised = false;
        this.lastKnownTotalRows = -1;
        // Enable gameplay UI + touch input for the tutorial tower so
        // player gestures actually reach onTouchStart / rotate the
        // tower. Without this, the touch handlers early-return on
        // `!this._gameplayVisible` and the tower never responds.
        // `_tutorialActive` (set by TutorialController) still keeps
        // the 4 action buttons hidden so the hand-demo isn't crowded.
        this._gameplayVisible = true;
        this._refreshControlModeUi();
        log('[TowerBlocks] tutorial started');
    }

    /** Turn tutorial mode off. Called by TutorialController after the
     *  scatter transition finishes and control hands to MenuController
     *  to load level 1. */
    public endTutorial(): void {
        if (this.gameState) this.gameState.tutorialActive = false;
        log('[TowerBlocks] tutorial ended');
    }

    /** True when the tutorial tower's locked board contains at least
     *  one COLORED (non-null, non-'X'/gray) cell — i.e. the player
     *  hasn't yet cleared every task-row block. Falling / in-flight
     *  piece cells are ignored (they aren't in `board` until lock).
     *  TutorialController polls this so clearing all colored blocks
     *  counts as a valid tutorial completion path — a safety net for
     *  players who happen to finish the practice level before running
     *  through all 4 gesture steps twice. */
    public hasTutorialColoredCellsLeft(): boolean {
        if (!this.gameState) return false;
        const b = this.gameState.state.board;
        for (let r = 0; r < b.length; r++) {
            const row = b[r];
            for (let c = 0; c < row.length; c++) {
                const v = row[c];
                if (v !== null && v !== 'X') return true;
            }
        }
        return false;
    }

    /** 闭眼模式 (blind mode) — endless mechanics minus the "spice":
     *  no fate piece modal, no embed-prop reward on next piece, tower
     *  cells hidden (unless `blindShowTowerDebug` is on). Same height
     *  cap and failure conditions as endless. */
    public startBlind(): void {
        if (!this.gameState) return;
        this.clearPendingPopups();
        this._activeLevelIdx = -1;
        AnalyticsApi.logCustom('mode_start', { mode: 'blind' });
        // Blind mode shares the endless auto-submit tracker (same
        // `submitEndlessHeightIfApplicable` code path via
        // onEndlessMilestone) — reset per run so the first 50-layer
        // crossing of a fresh blind attempt fires.
        this._lastEndlessAutoSubmit = 0;
        this.gameState.newBlindGame();
        this.boardYOffsetInitialised = false;
        this.lastKnownTotalRows = -1;
        // Flip the top column indicator on. setHudVisible also flips
        // this based on mode, but calling here handles direct start
        // paths (retry from result panel) without relying on a
        // subsequent visibility toggle.
        const hud = this.hudController;
        if (hud && typeof hud.setBlindIndicatorVisible === 'function') {
            hud.setBlindIndicatorVisible(true);
        }
        // Show the 3D world beam at the same time (visually paired with
        // the top label so the number sits above the beam column).
        this.setBlindBeamVisible(true);
        log('[TowerBlocks] blind mode started.');
    }

    // FX TEST MODE removed — was a dev-only panel exposed through the
    // mode-select page's "特效测试" button. Helper methods
    // (enterFxTestMode / exitFxTestMode / testFx) deleted along with it.

    /** Drop any popup that hadn't fired yet — used when the player restarts
     *  before the previous game's effects finished. */
    private clearPendingPopups(): void {
        this.pendingLevelWin = false;
        this.pendingGameOverReason = undefined;
        this.prePulseCells.length = 0;
        // Cancel any in-flight wrecker projectile spawns — otherwise a
        // level restart mid-projectile phase would push stale pulses
        // onto the fresh board.
        for (const h of this._wreckerProjectileTimeouts) clearTimeout(h);
        this._wreckerProjectileTimeouts.length = 0;
        // Nuke any temp wrecker marker props still hanging on target
        // cells — their per-marker auto-destroy timers will still fire
        // and no-op on already-destroyed nodes, so we're safe to drop
        // the tracking array without touching the timers.
        for (const n of this._wreckerMarkerNodes) {
            if (n && n.isValid) n.destroy();
        }
        this._wreckerMarkerNodes.length = 0;
        this.pendingRibbonTriggers.length = 0;
        this.ribbonDetonateEndsAt = 0;
        // Also tear down the post-fail reveal overlay if it was up —
        // a restart mid-reveal shouldn't leave the dim + prompt
        // floating over the fresh game.
        if (this.postFailRevealPending) {
            this.postFailRevealPending = false;
            const hud: any = this.hudController;
            if (hud && typeof hud.hideFailRevealPrompt === 'function') {
                hud.hideFailRevealPrompt();
            }
        }
        // Clear any lingering trapped-hole pulse so the fresh game
        // doesn't paint ghost red cells at old coords.
        this.clearTrappedHoleHighlights();
    }

    /** Submit the current endless/blind tower height to the leaderboard.
     *  Called on natural game-over and also when the player quits mid-run
     *  via the pause overlay's "Home" button so partial progress still
     *  counts. Server does best-of merging so re-submitting a lower
     *  height after a higher one is safe. No-op outside endless/blind
     *  or when height is 0 (nothing to report). Fire-and-forget. */
    public submitEndlessHeightIfApplicable(reason: 'game-over' | 'pause-quit'): void {
        const mode = this.gameState?.mode;
        if (mode !== 'endless' && mode !== 'blind') return;
        const score = this.gameState?.endlessProgress?.cumulative ?? 0;
        if (score <= 0) {
            log(`[TowerBlocks] skip ${mode} submit (${reason}) — height=0`);
            return;
        }
        log(`[TowerBlocks] submitting ${mode} score ${score} to leaderboard (${reason})`);
        submitScore(mode as 'endless' | 'blind', score).catch(err => {
            console.warn('[TowerBlocks] leaderboard submit failed:', err.message);
        });
        // Firebase mode-run summary event. Carries the final height +
        // exit reason so we can look at engagement (avg run height per
        // mode) and drop-off (quits vs deaths). Not the Firebase
        // predefined `post_score` because we want the mode filter
        // baked into a single event name.
        AnalyticsApi.logCustom('mode_end', {
            mode,
            score,
            reason,
        });
    }

    /** DEBUG-only cheat: instantly complete the currently-loaded level.
     *  Mirrors the `onLevelWin` hook flow so LevelProgress persists +
     *  the popup fires. No-op in endless mode. */
    public debugForceWin(): void {
        if (this._activeLevelIdx < 0) {
            log('[TowerBlocks] debugForceWin ignored (no active level)');
            return;
        }
        log(`[TowerBlocks] DEBUG FORCE WIN — level idx ${this._activeLevelIdx}`);
        LevelProgress.markCleared(this._activeLevelIdx);
        this.pendingLevelWin = true;
        // `level_win` SFX is played by MenuController.showLevelWin
        // when the scatter animation finishes — same flow as normal
        // win, so debug wins sound identical to real ones.
    }

    // ============================================================
    //  Touch / drag input
    // ============================================================
    private onTouchStart(evt: EventTouch): void {
        // Gate ALL gameplay touch handling on _gameplayVisible so
        // swipes on the main menu / level-select / other screens
        // don't sneak through to moveCylinder + play rotate_tower SFX.
        if (!this._gameplayVisible) return;
        // Any fresh touch immediately stops an in-flight fling — per
        // design "旋转过程中手指触碰屏幕，塔立即停止旋转".
        if (this._flingActive) {
            this._flingActive   = false;
            this._flingVelocity = 0;
            this._flingAccum    = 0;
        }
        const loc = evt.getLocation();
        this.touchStartX    = loc.x;
        this.touchStartY    = loc.y;
        this.touchLastX     = loc.x;
        this.touchLastY     = loc.y;
        this.touchStartTime = Date.now();
        this.touchActive    = true;
        this.touchLastDir   = 0;
        this.touchIsContinuous = false;
        // Reset drag-column accumulator + velocity sample buffer for
        // the new gesture.
        this._touchDragCumCol = 0;
        this._touchSamples.length = 0;
        this._touchSamples.push({ t: this.touchStartTime, x: loc.x });
        // Legacy hold-repeat timers reset — arm ONLY when the current
        // control mode is 'legacy' (Settings picker).
        this.clearTouchHoldTimers();
        if (getControlMode() === 'legacy') {
            this.touchHoldDelayHandle = setTimeout(
                () => this.tryEnterContinuous(),
                GameController.HOLD_DELAY_MS,
            );
        }
    }

    /** Legacy hold-repeat callback (HOLD_DELAY_MS after touch start).
     *  Only used when Settings.controlMode === 'legacy'. Checks the
     *  latest finger position: if it moved horizontally past the tap
     *  threshold, upgrade the gesture into continuous rotation.
     *  Otherwise (finger still, or motion was mostly vertical) do
     *  nothing — the release path decides (piece rotate / hard drop). */
    private tryEnterContinuous(): void {
        if (!this.touchActive || !this.gameState) return;
        if (this.touchIsContinuous) return;
        const dx = this.touchLastX - this.touchStartX;
        const dy = this.touchLastY - this.touchStartY;
        const absX = Math.abs(dx), absY = Math.abs(dy);
        if (absX < GameController.TAP_MAX_PX) return;
        if (absX < absY) return;
        this.touchIsContinuous = true;
        this.touchLastDir = dx > 0 ? -1 : 1;
        this._tryRotateTower(this.touchLastDir);
        const startedAt = Date.now();
        let bumped = false;
        const spin = (): void => {
            if (!this.touchActive || !this.gameState || this.touchLastDir === 0) {
                this.clearTouchHoldTimers();
                return;
            }
            this._tryRotateTower(this.touchLastDir as 1 | -1);
            if (!bumped && Date.now() - startedAt >= GameController.HOLD_FAST_AFTER_MS) {
                bumped = true;
                if (this.touchHoldRepeatHandle !== null) clearInterval(this.touchHoldRepeatHandle);
                this.touchHoldRepeatHandle = setInterval(spin, GameController.HOLD_REPEAT_FAST_MS);
            }
        };
        this.touchHoldRepeatHandle = setInterval(spin, GameController.HOLD_REPEAT_MS);
    }

    private onTouchMove(evt: EventTouch): void {
        if (!this.touchActive) return;
        const loc = evt.getLocation();
        this.touchLastX = loc.x;
        this.touchLastY = loc.y;
        const now = Date.now();
        // Push sample + trim to the rolling window.
        this._touchSamples.push({ t: now, x: loc.x });
        const cutoff = now - GameController.FLING_SAMPLE_WINDOW_MS;
        while (this._touchSamples.length > 1 && this._touchSamples[0].t < cutoff) {
            this._touchSamples.shift();
        }
        const mode = getControlMode();
        // Legacy mode: keep direction fresh so player can flip mid-hold.
        if (mode === 'legacy') {
            if (this.touchIsContinuous) {
                const dx = loc.x - this.touchStartX;
                if (Math.abs(dx) > GameController.TAP_MAX_PX) {
                    this.touchLastDir = dx > 0 ? -1 : 1;
                }
            }
            return;
        }
        // Buttons mode: swipe input is IGNORED for rotation (tap +
        // vertical swipe-down still work through onTouchEnd).
        if (mode === 'buttons') return;
        // ---- Drag+Fling mode (default) ----
        // Drag-to-column mapping: cumulative dx / PX_PER_COL_DRAG gives
        // the target column offset (signed). Direction inverted (drag
        // RIGHT → rotate -1) to match the "push tower away from finger"
        // mental model. Step the tower to catch up to the target.
        if (!this.gameState) return;
        const dx = loc.x - this.touchStartX;
        const targetCumCol = -Math.trunc(dx / GameController.PX_PER_COL_DRAG);
        while (this._touchDragCumCol < targetCumCol) {
            this._tryRotateTower(1);
            this._touchDragCumCol++;
            this.touchIsContinuous = true;
        }
        while (this._touchDragCumCol > targetCumCol) {
            this._tryRotateTower(-1);
            this._touchDragCumCol--;
            this.touchIsContinuous = true;
        }
    }

    private onTouchEnd(evt: EventTouch): void {
        this.clearTouchHoldTimers();
        if (!this.touchActive || !this.gameState) {
            this.touchActive = false;
            return;
        }
        const loc = evt.getLocation();
        const dx = loc.x - this.touchStartX;
        const dy = loc.y - this.touchStartY;
        const absX = Math.abs(dx), absY = Math.abs(dy);
        const dt = Date.now() - this.touchStartTime;
        const mode = getControlMode();

        // ---- Legacy mode: continuous rotation was firing → stop; else
        //      any horizontal swipe rotates ONE column (old behaviour).
        if (mode === 'legacy') {
            if (this.touchIsContinuous) {
                this.touchIsContinuous = false;
                this.touchActive = false;
                return;
            }
            const isTapLegacy = absX < GameController.TAP_MAX_PX
                             && absY < GameController.TAP_MAX_PX
                             && dt < GameController.TAP_MAX_MS;
            if (isTapLegacy) {
                this.gameState.tryRotate(1);
                SoundManager.instance?.play('piece_rotate');
                this.touchActive = false;
                return;
            }
            if (absX >= GameController.TAP_MAX_PX && absX >= absY) {
                const dir: 1 | -1 = dx > 0 ? -1 : 1;
                this._tryRotateTower(dir);
                this.touchActive = false;
                return;
            }
            if (dy < 0 && absY >= GameController.SWIPE_MIN_PX && absY > absX) {
                this.gameState.hardDrop();
                SoundManager.instance?.play('hard_drop');
            }
            this.touchActive = false;
            return;
        }

        // ---- Buttons mode: all touch input is ignored.
        //      Rotation / piece-rotate / hard-drop all live on dedicated
        //      on-screen Buttons (authoredRotateLeftButton /
        //      authoredRotateRightButton / authoredRotatePieceButton /
        //      authoredHardDropButton). Touch is a no-op so accidental
        //      swipes on the playfield don't trigger anything.
        if (mode === 'buttons') {
            this.touchActive = false;
            return;
        }

        // ---- Drag+Fling mode (default) ----
        // Case A: drag happened → maybe kick fling from release velocity.
        if (this.touchIsContinuous) {
            const samples = this._touchSamples;
            if (samples.length >= 2) {
                const first = samples[0];
                const last  = samples[samples.length - 1];
                const dts   = (last.t - first.t) / 1000;
                if (dts > 0) {
                    const pxPerSec = (last.x - first.x) / dts;
                    let cps = -pxPerSec / GameController.PX_PER_COL_DRAG;
                    const cap = GameController.FLING_MAX_VELOCITY_CPS;
                    if (cps >  cap) cps =  cap;
                    if (cps < -cap) cps = -cap;
                    if (Math.abs(cps) >= GameController.FLING_MIN_TRIGGER_CPS) {
                        this._flingVelocity = cps;
                        this._flingAccum    = 0;
                        this._flingActive   = true;
                    }
                }
            }
            this.touchIsContinuous = false;
            this.touchActive = false;
            return;
        }
        // Case B: pure tap → rotate the piece.
        const isTap = absX < GameController.TAP_MAX_PX
                   && absY < GameController.TAP_MAX_PX
                   && dt < GameController.TAP_MAX_MS;
        if (isTap) {
            this.gameState.tryRotate(1);
            SoundManager.instance?.play('piece_rotate');
            this.touchActive = false;
            return;
        }
        // Case C: downward vertical swipe → hard drop.
        if (dy < 0 && absY >= GameController.SWIPE_MIN_PX && absY > absX) {
            this.gameState.hardDrop();
            SoundManager.instance?.play('hard_drop');
        }
        this.touchActive = false;
    }

    /** Step the fling-spin state one frame. Called from update(dt).
     *  Applies velocity → accum → column steps, then linear friction
     *  decay, then stops when below the min-velocity threshold. */
    private stepTowerFling(dt: number): void {
        if (!this._flingActive || !this.gameState) return;
        // 1. Advance accum by velocity*dt (columns this frame).
        this._flingAccum += this._flingVelocity * dt;
        // 2. Emit as many full-column steps as accum permits. Haptic
        //    fires per-column but the 200 ms light throttle inside
        //    HapticsManager coalesces rapid fires into a sparse
        //    tap-tap-tap so the fling doesn't merge into a continuous
        //    buzz on iOS (fixed-duration system vibrate).
        while (this._flingAccum >= 1) {
            this._tryRotateTower(1);
            this._flingAccum -= 1;
        }
        while (this._flingAccum <= -1) {
            this._tryRotateTower(-1);
            this._flingAccum += 1;
        }
        // 3. Apply linear friction — magnitude decreases at
        //    FLING_FRICTION_CPS2 cols/sec² regardless of speed. Sign
        //    check catches the zero-crossing so the tower doesn't
        //    reverse direction due to over-shoot.
        const decel = GameController.FLING_FRICTION_CPS2 * dt;
        if (this._flingVelocity > 0) {
            this._flingVelocity = Math.max(0, this._flingVelocity - decel);
        } else if (this._flingVelocity < 0) {
            this._flingVelocity = Math.min(0, this._flingVelocity + decel);
        }
        // 4. Snap-stop when velocity magnitude falls below cutoff.
        if (Math.abs(this._flingVelocity) < GameController.FLING_MIN_VELOCITY_CPS) {
            this._flingActive   = false;
            this._flingVelocity = 0;
            this._flingAccum    = 0;
        }
    }

    /** Cancel any pending hold-to-repeat timers (called on drag-start,
     *  touch-end, or touch-cancel). */
    private clearTouchHoldTimers(): void {
        if (this.touchHoldDelayHandle !== null) {
            clearTimeout(this.touchHoldDelayHandle);
            this.touchHoldDelayHandle = null;
        }
        if (this.touchHoldRepeatHandle !== null) {
            clearInterval(this.touchHoldRepeatHandle);
            this.touchHoldRepeatHandle = null;
        }
    }
}

// ============================================================
//  Tiny helpers
// ============================================================
function hexToColor(s: string): Color {
    const out = new Color();
    Color.fromHEX(out, s);
    return out;
}

/** True iff `mat`'s first pass exposes a uniform / property named `name`.
 *  Returns false (without throwing) for any null / uninitialized material,
 *  which is what we want for the "skip tint" guard. */
function materialHasProperty(mat: Material | null | undefined, name: string): boolean {
    if (!mat || !mat.passes || mat.passes.length === 0) return false;
    try {
        // `getHandle` returns 0 (falsy) when the binding doesn't exist.
        const h = mat.passes[0].getHandle(name);
        return !!h;
    } catch {
        return false;
    }
}

/** Standard HSV → RGB. `h`, `s`, `v` all in [0, 1]. Returns a Cocos Color
 *  with alpha = 255. Used by the rainbow-flash clear effect. */
function hsvToColor(h: number, s: number, v: number): Color {
    h = ((h % 1) + 1) % 1;
    const i = Math.floor(h * 6);
    const f = h * 6 - i;
    const p = v * (1 - s);
    const q = v * (1 - f * s);
    const t = v * (1 - (1 - f) * s);
    let r = 0, g = 0, b = 0;
    switch (i % 6) {
        case 0: r = v; g = t; b = p; break;
        case 1: r = q; g = v; b = p; break;
        case 2: r = p; g = v; b = t; break;
        case 3: r = p; g = q; b = v; break;
        case 4: r = t; g = p; b = v; break;
        case 5: r = v; g = p; b = q; break;
    }
    return new Color(
        Math.floor(r * 255),
        Math.floor(g * 255),
        Math.floor(b * 255),
        255,
    );
}
