/**
 * LevelSelectStage3D — procedural 99-level tower for the level select
 * screen. Uses simple box primitives, NOT the game's Cube prefab (avoids
 * outline shells + PBR cost). Camera is fixed; player can't scroll to
 * pick a level. The bottom-most segment above the foundation is the
 * currently-playable level. Beating it triggers a collapse animation:
 * bottom segment vanishes, everything above drops one segment.
 *
 * Layout (world Y = 0 at foundation base):
 *
 *   ┌───────────────┐   Level N separator (1 row gray 1.1× + "N" label)
 *   │  ─ Level N ─  │   Level N body       (5 rows coloured 1.0×)
 *   ├───────────────┤   Level N-1 separator ("N-1")
 *   │  ─ Level N-1 ─│   Level N-1 body
 *   ├───────────────┤
 *   │      ...      │
 *   ├───────────────┤
 *   │  Foundation   │   4 rows gray 1.1×  (immovable base)
 *   └───────────────┘
 *
 * Foundation:     rows 0..3
 * Level 1 body:   rows 4..8
 * Level 1 sep:    row  9
 * Level 2 body:   rows 10..14
 * Level 2 sep:    row  15
 * ...
 * Level K body row range: [4 + (K-1)*6 .. 8 + (K-1)*6]
 * Level K sep row:        9 + (K-1)*6
 *
 * Rendering scope: only `visibleLevels` levels are actually spawned to
 * keep cube count under ~1000. Camera focuses on the current level.
 *
 * Wiring:
 *   1. Attach to a Node in the level-select scene.
 *   2. (Optional) Drag Camera3D into `camera3D` — else the game's
 *      MainCamera3D is used.
 *   3. Wire `enterButton`, `levelNameLabel` from a Canvas overlay.
 *   4. Call `showForLevel(currentIdx, onEnter)` when opening the panel.
 */

import {
    _decorator,
    Component,
    Node,
    MeshRenderer,
    Material,
    Color,
    Vec3,
    Quat,
    Label,
    Button,
    Prefab,
    instantiate,
    UITransform,
    Texture2D,
    ImageAsset,
    math,
    tween,
    Tween,
} from 'cc';

import { COLORS } from '../core/Constants';
import { FATE_SHAPES as GAME_FATE_SHAPES } from '../core/FateShapes';
import { t, subscribe as subscribeI18n } from '../core/i18n/I18n';

const { ccclass, property } = _decorator;

// ============================================================
//  Tower geometry — matches the game's playing cylinder so the
//  level-select tower reads as "the same tower species".
// ============================================================

const COLS               = 24;
const CELL_SIZE          = 1.0;
const CUBE_VISUAL        = 1.0;
const FOUNDATION_SCALE   = 1.1;
const BODY_SCALE         = 1.0;
const SEPARATOR_SCALE    = 1.1;
const ANGLE_PER_COL      = (2 * Math.PI) / COLS;
const RADIUS             = CELL_SIZE / (2 * Math.sin(ANGLE_PER_COL / 2));

const FOUNDATION_ROWS    = 4;
const LEVEL_BODY_ROWS    = 6;
const LEVEL_SEP_ROWS     = 1;
const LEVEL_TOTAL_ROWS   = LEVEL_BODY_ROWS + LEVEL_SEP_ROWS;   // 7

// Level body cycles through the 7 tetromino colours.
const LEVEL_BODY_KEYS = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'] as const;

// Front-facing 6×6 fate-block display area. 6 physical columns wide
// (front-facing, cols 21..2 wrapping), 6 rows (= all body rows). Every
// cell is a real cube: gray for background, coloured for fate cells.
// DISPLAY_COLS lists the physical col indices in visual LEFT→RIGHT order,
// so display column 0 = leftmost = physical col 21, display col 5 =
// rightmost = physical col 2.
const DISPLAY_COLS: number[] = [21, 22, 23, 0, 1, 2];
const DISPLAY_COL_MAP: Record<number, number> = (() => {
    const m: Record<number, number> = {};
    DISPLAY_COLS.forEach((c, i) => { m[c] = i; });
    return m;
})();
const DISPLAY_W = DISPLAY_COLS.length;   // 6
const DISPLAY_H = LEVEL_BODY_ROWS;       // 6

// 5×3 pixel-font patterns for digits 0-9. Each row is a 3-char bitmask
// ('1' = lit pixel, '0' = empty). Rows are top → bottom.
const DIGIT_PIXELS: Record<string, string[]> = {
    '0': ['111', '101', '101', '101', '111'],
    '1': ['010', '110', '010', '010', '111'],
    '2': ['111', '001', '111', '100', '111'],
    '3': ['111', '001', '111', '001', '111'],
    '4': ['101', '101', '111', '001', '001'],
    '5': ['111', '100', '111', '001', '111'],
    '6': ['111', '100', '111', '101', '111'],
    '7': ['111', '001', '001', '001', '001'],
    '8': ['111', '101', '111', '101', '111'],
    '9': ['111', '101', '111', '001', '111'],
};

function hex(s: string): Color {
    const out = new Color();
    Color.fromHEX(out, s);
    return out;
}

@ccclass('LevelSelectStage3D')
export class LevelSelectStage3D extends Component {

    // ============================================================
    //  Inspector slots
    // ============================================================

    /** The game's regular Cube prefab (assets/prefabs/Cube.prefab).
     *  Every tower cube is instantiated from this — keeps the level
     *  select tower visually identical to the game's playing tower
     *  (same outline shell, same crystal PBR shader). */
    @property(Prefab)
    cubePrefab: Prefab | null = null;

    /** Camera3D to move / point at the current level. Leave blank to
     *  use the scene's main camera (component finds any active Camera).
     *  If you want a dedicated level-select camera, drag it here. */
    @property(Node)
    camera3D: Node | null = null;

    /** Parent Node for all spawned cubes. Defaults to `this.node`. */
    @property(Node)
    stackRoot: Node | null = null;

    /** Optional: UI Button that fires "play current level". */
    @property(Button)
    enterButton: Button | null = null;

    /** Optional: UI Button in the top-left that returns to mode select. */
    @property(Button)
    backButton: Button | null = null;

    /** Optional: UI Label showing "关卡 N". */
    @property(Label)
    levelNameLabel: Label | null = null;

    // ============================================================
    //  Tuning
    // ============================================================

    /** How many levels above the current one are visible in the stack.
     *  ~5 keeps cube count under 1000 (5×6×24 = 720 + foundation 96 = 816). */
    @property({ range: [1, 20, 1], slide: true })
    visibleLevels: number = 5;

    /** Total number of levels — spec says 99. */
    @property
    totalLevels: number = 99;

    /** Height of one "row" in world units. Matches CELL_SIZE by default. */
    @property
    rowHeight: number = CELL_SIZE;

    /** How far above the current-level's mid-body Y the camera sits. */
    @property
    cameraLookOffsetY: number = 3.0;

    /** Extra vertical shift of the camera position, in world units.
     *  Positive values move the camera UP, which frames the tower
     *  LOWER on screen — useful for reserving room at the top of the
     *  canvas for the back arrow / progress bar / badge row without
     *  changing the pitch or the perceived focus of the shot. Applied
     *  AFTER `cameraLookOffsetY` so the two knobs stay independent
     *  (offset = focus tuning; shift = layout tuning). */
    @property({ range: [-10, 20, 0.5], slide: true, tooltip: '塔在画面里的整体下移量（世界单位）。数值越大 → 相机越高 → 塔在屏幕上越靠下。用来给顶部 UI（back / 进度条 / 徽章）留出空间。' })
    frameShiftY: number = 9;

    /** Distance from tower axis for camera framing. */
    @property
    cameraDistance: number = 12;

    /** Camera pitch degrees (downward tilt when negative). Defaults to
     *  slight downward look at 15°. */
    @property
    cameraPitchDeg: number = -8;

    /** Debug: if true, auto-calls `showForLevel(startLevelIdx, noop)` in
     *  onLoad so the tower is visible without needing MenuController
     *  integration. Turn OFF once real wiring is in place. */
    @property
    autoPreview: boolean = true;

    /** With `autoPreview`, which level index to focus on. */
    @property({ range: [0, 98, 1], slide: true })
    startLevelIdx: number = 0;

    /** How dim the back-of-cylinder cubes render vs the front. 0 = fully
     *  black, 1 = no dimming. Same visual trick the game's playing tower
     *  uses to fake atmospheric fog on the far side. */
    @property({ range: [0, 1, 0.05], slide: true })
    backDim: number = 0.35;

    /** Tilt of the top "剩余关卡" counter around the X axis (degrees).
     *  Positive = far edge rises up (number faces the camera more). */
    @property({ range: [-89, 89, 1], slide: true })
    counterTiltDeg: number = 25;

    /** Emissive strength on the current level's fate-block cells.
     *  0 = no glow, 1 = full-strength colour glow. Only applies to
     *  cubes marked as "fate cells" on the currently-selected level. */
    @property({ range: [0, 3, 0.05], slide: true })
    fateGlow: number = 0.7;

    /** How fast the fate glow pulses (radians / second). 0 = static. */
    @property({ range: [0, 10, 0.1], slide: true })
    fateGlowPulseSpeed: number = 2.5;

    /** Amplitude of the pulse relative to the base glow (0 = static,
     *  0.5 = ±50% around base, 1 = 0..2× base). */
    @property({ range: [0, 1, 0.05], slide: true })
    fateGlowPulseAmp: number = 0.6;

    /** How fast the top counter breathes (radians/sec). 0 = static. */
    @property({ range: [0, 10, 0.1], slide: true })
    counterPulseSpeed: number = 2.0;

    /** Amplitude of the top counter's scale pulse. 0.1 = ±10% around 1×. */
    @property({ range: [0, 0.5, 0.01], slide: true })
    counterPulseAmp: number = 0.1;

    /** Duration (seconds) of the top-level shrink+fade played when the
     *  player returns after beating a level. */
    @property({ range: [0.05, 2, 0.05], slide: true })
    collapseFadeSec: number = 0.6;

    /** Per-separator-cube fly-out duration (seconds). */
    @property({ range: [0.05, 3, 0.05], slide: true })
    sepFlyDurSec: number = 0.2;

    /** Delay between successive separator cubes launching (seconds). */
    @property({ range: [0, 0.2, 0.001], slide: true })
    sepFlyStaggerSec: number = 0.0075;

    /** How far each separator cube travels in -Y (world units). Set
     *  large enough that the cube exits the camera frame BEFORE it
     *  gets destroyed in the rebuild. */
    @property({ range: [1, 60, 1], slide: true })
    sepFlyDist: number = 40;

    /** Short-distance "hover" position — each cube flies out to here
     *  first, pauses, then joins the ensemble launch to `sepFlyDist`. */
    @property({ range: [0.05, 15, 0.05], slide: true })
    sepFlyStopDist: number = 0.3;

    /** Pause after the LAST cube reaches the stop distance, before the
     *  ensemble launch fires. Gives the "held breath" beat. */
    @property({ range: [0, 2, 0.05], slide: true })
    sepFlyPauseSec: number = 0.3;

    /** Duration of the ensemble launch (stop → exit), in seconds. */
    @property({ range: [0.05, 2, 0.05], slide: true })
    sepFlyExitDurSec: number = 0.5;

    /** After the rebuild, the new stack starts this many world units
     *  BELOW its final position and tweens up. Default = one level's
     *  height (LEVEL_TOTAL_ROWS = 7) so the tower rises by exactly one
     *  segment — level N+1 starts at level N's OLD slot and pushes
     *  up into level N's spot. */
    @property({ range: [1, 150, 1], slide: true })
    pushUpDist: number = 7;

    /** How long the "push up from below" animation lasts (seconds). */
    @property({ range: [0.1, 3, 0.05], slide: true })
    pushUpDurSec: number = 1.5;

    // ============================================================
    //  Enter-level scatter (played when the player taps 进入关卡).
    // ============================================================

    /** Window (seconds) over which cubes get staggered start times.
     *  0 = all cubes fly at once (no "sequential" feel). Larger =
     *  a slower wave that ripples through the tower. */
    @property({ range: [0, 2, 0.05], slide: true })
    scatterStaggerSec: number = 0.6;

    /** Per-cube fly-out duration (seconds). */
    @property({ range: [0.05, 2, 0.05], slide: true })
    scatterFlyDurSec: number = 0.5;

    /** How far each cube flies outward before disappearing
     *  (world units, before per-cube speed variance). */
    @property({ range: [1, 60, 1], slide: true })
    scatterFlyDist: number = 15;

    /** Angular jitter (radians) applied to each cube's radial direction
     *  so the scatter doesn't look like a perfect starburst. */
    @property({ range: [0, 1.57, 0.05], slide: true })
    scatterAngleJitter: number = 0.35;

    /** Random Y-velocity multiplier — positive spread biases cubes up. */
    @property({ range: [0, 2, 0.05], slide: true })
    scatterYSpread: number = 0.6;

    // ============================================================
    //  Runtime state
    // ============================================================

    /** All currently-spawned cube nodes (foundation + visible levels).
     *  Rebuilt every time `showForLevel` is called. */
    private cubes: Node[] = [];

    /** Grouped by level index (foundation = -1). Used for collapse
     *  animation — bottom group destroyed, rest tweened down. */
    private levelGroups: Map<number, Node[]> = new Map();

    /** Separator cubes only, indexed by the level index the separator
     *  sits ABOVE. Populated alongside `levelGroups` during build; used
     *  by the collapse animation's phase 2 (fly-out). */
    private separatorGroups: Map<number, Node[]> = new Map();

    /** Current lowest visible level (the one player would play if they
     *  tap Enter). Persisted via LevelProgress.currentIdx externally. */
    private currentLevelIdx = 0;

    /** Material cache — retained but currently unused since prefab
     *  cubes clone their prefab material on-the-fly. */
    private matCache: Map<string, Material> = new Map();

    /** Materials of the current-level fate cells + their base emissive
     *  color. Populated during buildLevelSegment; animated in update()
     *  for the slow pulse effect. */
    private glowingMats: Array<{ mat: Material; base: Color }> = [];

    /** Accumulator for the pulse phase (seconds). */
    private glowPhase = 0;

    /** Parent Node of the top-counter cubes — animated in update() to
     *  pulse the number's scale. Cleared during teardown. */
    private topCounterRoot: Node | null = null;

    /** Independent pulse phase for the counter (seconds). */
    private counterPhase = 0;

    /** Rise factor: 0 during teardown, tweened 0 → 1 while the new
     *  tower pushes up from below. Multiplied into the pulse scale so
     *  the counter GROWS from small to full size during the reveal,
     *  then continues breathing at full size afterward. */
    private counterRiseFactor = 1;

    /** Enter-button click callback, injected by MenuController. */
    private onEnterCb: ((idx: number) => void) | null = null;

    /** Back-button click callback, injected by MenuController. */
    private onBackCb: (() => void) | null = null;

    /** Highest currentLevelIdx we've built a stack for. Used to detect
     *  "player just beat a level" transitions on re-entry: if the new
     *  index is higher, we play a collapse animation before rebuilding. */
    private lastShownIdx = -1;

    /** True while `playExitScatter` is running. Blocks the glow/counter
     *  update loop from overwriting scale changes the scatter tween
     *  is authoring on cube nodes. */
    private _scattering = false;

    /** Per-cube TARGET scale (as set at spawn time). Used to restore
     *  cubes to their intended visible size after collapse-time shrink
     *  or during the "grow from 0" push-up. Cleared in teardown. */
    private cubeBaseScales: Map<Node, Vec3> = new Map();

    /** Per-cube BODY material (the MR whose `mainColor` we tint). Cached
     *  at spawn so retint doesn't need to re-scan MRs every collapse. */
    private cubeBodyMats: Map<Node, Material> = new Map();

    /** Every cube that lives inside a display area (fate frame + fate
     *  cells + inner canvas). Tracked so we can RETINT them on collapse
     *  instead of destroying + respawning the whole tower. */
    private displayCubes: Array<{
        slotFromTop: number;    // 0 = top (current level), grows downward
        dispRow: number;        // 0..5 within display area (top→bottom)
        dispCol: number;        // 0..5 within display area (left→right)
        col: number;            // physical ring column (for frontDim)
        node: Node;
        mat: Material;
    }> = [];

    // ============================================================
    //  Lifecycle
    // ============================================================

    onLoad(): void {
        if (this.autoPreview) {
            // Delay one frame so any inspector-driven camera setup runs
            // before we position the camera.
            this.scheduleOnce(() => {
                this.showForLevel(this.startLevelIdx, (idx) => {
                    console.log(`[LevelSelectStage3D] auto-preview enter clicked: level ${idx + 1}`);
                });
            }, 0);
        }
        // Re-translate the "关卡 N" label on language change.
        this.i18nUnsub = subscribeI18n(() => this.updateUi());
    }

    onDestroy(): void {
        if (this.i18nUnsub) { this.i18nUnsub(); this.i18nUnsub = null; }
    }

    private i18nUnsub: (() => void) | null = null;

    // ============================================================
    //  Public API — MenuController calls these
    // ============================================================

    /** Open the level-select stage focused on `currentIdx`. Builds the
     *  tower fresh. Wires the Enter button to call `onEnter(currentIdx)`.
     *
     *  If `currentIdx` advanced from the last shown value (i.e. the
     *  player just beat a level), we first play a collapse animation
     *  on the OLD top segment, then rebuild in place. */
    public showForLevel(
        currentIdx: number,
        onEnter: (idx: number) => void,
        onBack?: () => void,
    ): void {
        const clamped = Math.max(0, Math.min(this.totalLevels - 1, currentIdx));
        // Store the back callback up front so both the collapse-path
        // and fresh-rebuild-path wire the same button.
        this.onBackCb = onBack ?? null;

        // "Just beat a level" path — need to fade the old top BEFORE
        // rebuilding. We fade in place using the CURRENT stack, then
        // teardown + rebuild once the fade completes.
        const advanced = this.lastShownIdx >= 0
                      && clamped > this.lastShownIdx
                      && this.levelGroups.size > 0;
        if (advanced) {
            this.lastShownIdx = clamped;
            this.playCollapseThenRebuild(clamped, onEnter);
            // wireEnterButton fires inside playCollapseThenRebuild's
            // rebuild-lite step — the back button is wired there too
            // via the shared helper.
            return;
        }

        // Fresh entry (or same level re-entered) — REUSE the cached
        // tower if it's already built and pointing at the same current
        // level. Rebuilding costs ~2000 node instantiations + material
        // setups and stalls real-device frames for hundreds of ms.
        // MenuController.showModeSelect() no longer tears the tower
        // down, so on 99% of re-entries the cubes are already sitting
        // at their target positions and just need to be revealed.
        this.lastShownIdx = clamped;
        this.onEnterCb = onEnter;

        const cached = this.cubes.length > 0;
        const sameLevel = cached && this.currentLevelIdx === clamped;
        if (sameLevel) {
            // Cached path — no rebuild, just re-wire the click handlers
            // and play the same reveal animation the fresh build uses.
            this.wireEnterButton();
            this.playFreshEntryReveal();
            return;
        }

        // Level changed (backwards nav or first entry) — do the full
        // build. Rare enough that the stall is acceptable.
        this.teardown();
        this.currentLevelIdx = clamped;
        this.ensureMeshes();
        this.buildFoundation();
        this.buildVisibleLevels();
        this.positionCamera();
        this.updateUi();
        this.wireEnterButton();
        // Reveal shot — freshly-built tower slides up from below and
        // the "剩余关卡" counter number grows from 0 to full size in
        // step. Same push-up + counterRiseFactor tween used at the tail
        // of playCollapseThenRebuild (return-from-win path).
        this.playFreshEntryReveal();
    }

    /** Pre-build the tower during the LoadingController warmup phase
     *  so the FIRST user-triggered `showForLevel()` skips the expensive
     *  ~2000-cube instantiation and just plays the reveal animation
     *  (via the cached-tower path in `showForLevel`). Caller must have
     *  set `node.active = true` briefly before calling this so the
     *  GPU actually gets to render the newly-built cubes at least once
     *  (that's the point of running it during warmup — shader compile +
     *  texture upload). After the warmup wait, caller should
     *  `setActive(false)` on the stage node again. */
    public prebuild(currentIdx: number): void {
        const clamped = Math.max(0, Math.min(this.totalLevels - 1, currentIdx));
        // Skip if the tower is already there and matches — showForLevel
        // would take the cached-tower path anyway.
        if (this.cubes.length > 0 && this.currentLevelIdx === clamped) {
            return;
        }
        this.teardown();
        this.currentLevelIdx = clamped;
        this.ensureMeshes();
        this.buildFoundation();
        this.buildVisibleLevels();
        this.positionCamera();
        this.updateUi();
        // Deliberately DO NOT call wireEnterButton() or
        // playFreshEntryReveal() — those belong to the real user-facing
        // show flow, which will run through showForLevel()'s cached
        // path when the player actually opens the level-select panel.
    }

    /** Reveal animation played after a FRESH tower build (first entry
     *  to level-select, or re-entry when there was no advance to trigger
     *  a collapse). All spawned cubes get pushed DOWN by pushUpDist and
     *  tween back to their target Y over `pushUpDurSec`; the top-counter
     *  number grows from scale 0 to 1 in lockstep.
     *
     *  NOTE: an earlier optimisation collapsed this into a single tween
     *  on `stackRoot.position.y` — cheaper but the animation didn't
     *  visibly play (root's Y didn't propagate to cube world positions
     *  in some scene configs). Reverted to per-cube since the tower is
     *  prebuilt during loading, so this reveal has no instantiation
     *  cost to compound with. */
    private playFreshEntryReveal(): void {
        const drop = this.pushUpDist;
        const risingCubes = this.cubes.slice();
        // Snapshot each cube's TARGET position BEFORE we mutate any —
        // Cocos's node.position is a live Vec3 reference, so reads
        // inside onUpdate would pick up the mutated value.
        const targets: Array<{ x: number; y: number; z: number }> = [];
        for (const n of risingCubes) {
            if (!n || !n.isValid) { targets.push({ x: 0, y: 0, z: 0 }); continue; }
            const p = n.position;
            targets.push({ x: p.x, y: p.y, z: p.z });
        }
        // Push all cubes down so the tower starts off-screen below.
        for (let i = 0; i < risingCubes.length; i++) {
            const n = risingCubes[i];
            if (!n || !n.isValid) continue;
            const tg = targets[i];
            n.setPosition(tg.x, tg.y - drop, tg.z);
        }
        // Rise: interp Y from (targetY - drop) → targetY.
        const carrier = { t: 0 };
        tween(carrier as any)
            .to(this.pushUpDurSec, { t: 1 }, {
                easing: 'quadOut',
                onUpdate: () => {
                    const k = carrier.t;
                    for (let i = 0; i < risingCubes.length; i++) {
                        const n = risingCubes[i];
                        if (!n || !n.isValid) continue;
                        const tg = targets[i];
                        n.setPosition(tg.x, (tg.y - drop) + drop * k, tg.z);
                    }
                },
            })
            .start();
        // Top counter grows 0 → 1 in step so the number "swells into
        // being" as the tower reveals.
        this.counterRiseFactor = 0;
        const riseCarrier = { r: 0 };
        tween(riseCarrier as any)
            .to(this.pushUpDurSec, { r: 1 }, {
                easing: 'quadOut',
                onUpdate: () => { this.counterRiseFactor = riseCarrier.r; },
            })
            .start();
    }

    /** Collapse animation:
     *   Phase 1 — shrink every cube in the OLD top level's group over
     *     `collapseFadeSec`.
     *   Phase 2 — the separator RIGHT BELOW the old top (belonging to
     *     level `oldTopIdx + 1`) explodes one cube at a time, each
     *     cube tweening in -Y (down) + shrinking away. Column stagger
     *     `sepFlyStaggerSec` seconds apart, each cube flies for
     *     `sepFlyDurSec` seconds.
     *   Phase 3 — teardown + rebuild with `newIdx` at top. */
    private playCollapseThenRebuild(newIdx: number, onEnter: (idx: number) => void): void {
        const oldTopIdx = this.currentLevelIdx;
        // Instant state advance (no shrink / no fly-out) then a radial
        // converge-from-outside reveal, mirroring the game-side
        // playLevelAssembly. Replaces the older 4-phase melt + push-up
        // animation on player request.
        this.advanceLevelStateAndConverge(oldTopIdx, newIdx, onEnter);
    }

    /** Advance the tower state (retint, new separator, new counter)
     *  with a two-part animation:
     *    • UPPER PART (old current-level cubes + separator + counter)
     *      scatters outward + up and shrinks to nothing
     *    • LOWER PART (foundation stays put; slots 1-4 + new slot-0
     *      cubes + new separator) rise up from below by pushUpDist
     *    • NEW COUNTER also rises from below AND scales 0→1
     *
     *  Replaces the previous "converge from outside" reveal per player
     *  request. */
    private advanceLevelStateAndConverge(
        oldTopIdx: number,
        newIdx: number,
        onEnter: (idx: number) => void,
    ): void {
        // ============================================================
        //  Phase 1 — SCATTER (old top cubes + old separator + old counter)
        // ============================================================

        // Grab the old top-slot level cubes, the separator between slot 0
        // and slot 1, and the old counter — these are the "upper tower"
        // parts that need to fly outward and destroy themselves.
        const oldTopCubes = (this.levelGroups.get(oldTopIdx) ?? []).slice();
        const oldSepKey  = oldTopIdx + 1;
        const oldSepCubes = (this.separatorGroups.get(oldSepKey) ?? []).slice();
        const oldCounterRoot = this.topCounterRoot;
        this.topCounterRoot = null;
        // Remove scatter targets from live state so retint / push-up
        // don't touch them (they're going away).
        this.levelGroups.delete(oldTopIdx);
        this.separatorGroups.delete(oldSepKey);
        const scatterSet = new Set<Node>([...oldTopCubes, ...oldSepCubes]);
        this.displayCubes = this.displayCubes.filter(e => !scatterSet.has(e.node));
        this.cubes = this.cubes.filter(n => n && n.isValid && !scatterSet.has(n));

        // Play the scatter animation on each (destroys on completion).
        // Slow enough that the player can read the "the old top is
        // leaving" beat before the tower pushes up.
        const scatterDur = 0.9;
        for (const n of oldTopCubes) this.playScatterOnCube(n, scatterDur);
        for (const n of oldSepCubes) this.playScatterOnCube(n, scatterDur);
        if (oldCounterRoot && oldCounterRoot.isValid) {
            this.playScatterOnCube(oldCounterRoot, scatterDur);
        }

        // ============================================================
        //  Phase 2 — Advance state (idx, group shifts, retint)
        // ============================================================
        this.currentLevelIdx = newIdx;
        this.onEnterCb = onEnter;
        this.wireEnterButton();

        // Shift level / separator group keys up by 1. Physical cubes
        // that were in slot K > 0 now represent level (newIdx + K).
        // (Slot 0's cubes were scattered above, so nothing to shift for
        // the deleted key.)
        const shiftedLvl = new Map<number, Node[]>();
        for (const [k, v] of this.levelGroups) {
            if (k === -1) { shiftedLvl.set(-1, v); continue; }
            shiftedLvl.set(k + 1, v);
        }
        this.levelGroups = shiftedLvl;
        const shiftedSep = new Map<number, Node[]>();
        for (const [k, v] of this.separatorGroups) {
            shiftedSep.set(k + 1, v);
        }
        this.separatorGroups = shiftedSep;

        // Retint every remaining display-area cube for the new mapping
        // (slot K now shows newIdx + K, so slot 1's colours advance
        // from "N+1" to "N+2" etc.).
        this.retintDisplayCubes();

        // ============================================================
        //  Phase 3 — Spawn NEW top slot cubes (fills the empty slot 0
        //  left by the scatter) + new separator + new counter. All
        //  positioned at their FINAL Y, then displaced down for the
        //  push-up tween below.
        // ============================================================
        // New slot 0 = fresh cubes for the new current level (newIdx).
        // isTopVisible=true → skip the auto-separator; we spawn ours
        // explicitly below at the slot 0/1 boundary.
        this.buildLevelSegment(newIdx, true);

        // New separator between new slot 0 and slot 1.
        const newSepLevelIdx = newIdx + 1;
        const sepSlotFromBottom = this.visibleLevels - 2;
        const sepBodyStartRow = FOUNDATION_ROWS + sepSlotFromBottom * LEVEL_TOTAL_ROWS;
        const newSepY = (sepBodyStartRow + LEVEL_BODY_ROWS) * this.rowHeight;
        if (newSepLevelIdx < this.totalLevels) {
            const newSepGroup: Node[] = [];
            for (let c = 0; c < COLS; c++) {
                const n = this.spawnCubeAbsolute(
                    c, newSepY, '#8a8a90',
                    new Vec3(48, 100, 20),
                    'separator',
                );
                newSepGroup.push(n);
                const g = this.levelGroups.get(newSepLevelIdx) ?? [];
                g.push(n);
                this.levelGroups.set(newSepLevelIdx, g);
            }
            this.separatorGroups.set(newSepLevelIdx, newSepGroup);
        }

        // New top counter. counterRiseFactor 0 → 1 tween happens below
        // in the push-up phase so the digits swell in as they rise.
        this.counterRiseFactor = 0;
        this.spawnTopCounter(newIdx);
        this.updateUi();

        // ============================================================
        //  Phase 4 — PUSH UP the lower tower (foundation stays put).
        //  Everything NOT foundation gets displaced down by pushUpDist
        //  and tweens back up to its target Y. The counter also rises
        //  AND scales 0 → 1.
        // ============================================================
        const drop = this.pushUpDist;
        const dur  = this.pushUpDurSec;
        // Foundation cubes occupy Y < FOUNDATION_ROWS * rowHeight —
        // don't push those up (they stay grounded).
        const foundationTopY = FOUNDATION_ROWS * this.rowHeight;
        const rising: Node[] = [];
        const targets: Array<{ x: number; y: number; z: number }> = [];
        for (const n of this.cubes) {
            if (!n || !n.isValid) continue;
            // The top-counter root is in `this.cubes` too but gets its
            // OWN tween below (position + counterRiseFactor together).
            // Skip it here so it doesn't get double-displaced.
            if (n === this.topCounterRoot) continue;
            const p = n.position;
            if (p.y < foundationTopY - 0.001) continue;   // skip foundation
            rising.push(n);
            targets.push({ x: p.x, y: p.y, z: p.z });
            n.setPosition(p.x, p.y - drop, p.z);
        }

        if (rising.length > 0) {
            const carrier = { t: 0 };
            tween(carrier as any)
                .to(dur, { t: 1 }, {
                    easing: 'quadOut',
                    onUpdate: () => {
                        const k = carrier.t;
                        for (let i = 0; i < rising.length; i++) {
                            const n = rising[i];
                            if (!n || !n.isValid) continue;
                            const tg = targets[i];
                            n.setPosition(tg.x, (tg.y - drop) + drop * k, tg.z);
                        }
                    },
                })
                .start();
        }

        // Top counter: rise from below AND scale in 0 → 1.
        if (this.topCounterRoot && this.topCounterRoot.isValid) {
            const cn = this.topCounterRoot;
            const cy = cn.position.y;
            const cx = cn.position.x, cz = cn.position.z;
            cn.setPosition(cx, cy - drop, cz);
            const rc = { t: 0 };
            tween(rc as any)
                .to(dur, { t: 1 }, {
                    easing: 'quadOut',
                    onUpdate: () => {
                        if (!cn.isValid) return;
                        const k = rc.t;
                        cn.setPosition(cx, (cy - drop) + drop * k, cz);
                        this.counterRiseFactor = k;
                    },
                })
                .start();
        }
    }

    /** Scatter one cube (or sub-tree root like `topCounterRoot`) — fly
     *  it outward from the tower axis + upward while shrinking to 0.
     *  Destroys the node at the end. Reused for the "upper tower" parts
     *  during the post-clear transition. */
    private playScatterOnCube(node: Node, dur: number): void {
        if (!node || !node.isValid) return;
        const wp = node.worldPosition.clone();
        const sBase = node.scale.clone();
        const rXZ = Math.sqrt(wp.x * wp.x + wp.z * wp.z);
        let dirX: number, dirZ: number;
        if (rXZ < 0.05) {
            // Cubes on the tower axis (counter pixels near origin) —
            // pick a random outward direction so they don't stack.
            const a = Math.random() * Math.PI * 2;
            dirX = Math.sin(a); dirZ = Math.cos(a);
        } else {
            const jitter = (Math.random() - 0.5) * 0.4;
            const angle = Math.atan2(wp.x, wp.z) + jitter;
            dirX = Math.sin(angle); dirZ = Math.cos(angle);
        }
        const flyDist = 10 + Math.random() * 8;
        const upDist  = 4 + Math.random() * 4;
        const targetWX = wp.x + dirX * flyDist;
        const targetWY = wp.y + upDist;
        const targetWZ = wp.z + dirZ * flyDist;
        const carrier = { t: 0 };
        tween(carrier as any)
            .to(dur, { t: 1 }, {
                easing: 'quadIn',
                onUpdate: () => {
                    if (!node.isValid) return;
                    const k = carrier.t;
                    const nx = wp.x + (targetWX - wp.x) * k;
                    const ny = wp.y + (targetWY - wp.y) * k;
                    const nz = wp.z + (targetWZ - wp.z) * k;
                    node.setWorldPosition(nx, ny, nz);
                    const sk = Math.max(0, 1 - k);
                    node.setScale(sBase.x * sk, sBase.y * sk, sBase.z * sk);
                },
            })
            .call(() => {
                this.cubeBaseScales.delete(node);
                this.cubeBodyMats.delete(node);
                if (node.isValid) node.destroy();
            })
            .start();
    }

    /** Tear down all spawned cubes + reset caches. Optionally accepts
     *  a set of nodes to PRESERVE (skip destroying) — used during the
     *  collapse animation so still-flying separator cubes survive the
     *  teardown that happens before the new tower rebuild. Caller is
     *  responsible for destroying the preserved nodes later. */
    public teardown(preserved: Set<Node> = new Set()): void {
        const survivors: Node[] = [];
        for (const c of this.cubes) {
            if (!c || !c.isValid) continue;
            if (preserved.has(c)) {
                survivors.push(c);
                continue;
            }
            c.destroy();
        }
        this.cubes = survivors;
        this.levelGroups.clear();
        this.separatorGroups.clear();
        this.glowingMats.length = 0;
        this.glowPhase = 0;
        this.topCounterRoot = null;
        this.counterPhase = 0;
        this.counterRiseFactor = 1;
        // Drop scale + material tracking for any cube that just got
        // destroyed. We use a fresh Map instead of walking `survivors`
        // because the common teardown path preserves nothing.
        if (survivors.length === 0) {
            this.cubeBaseScales.clear();
            this.cubeBodyMats.clear();
        } else {
            const keep = new Set(survivors);
            for (const k of Array.from(this.cubeBaseScales.keys())) {
                if (!keep.has(k)) this.cubeBaseScales.delete(k);
            }
            for (const k of Array.from(this.cubeBodyMats.keys())) {
                if (!keep.has(k)) this.cubeBodyMats.delete(k);
            }
        }
        // The display-cube list only makes sense against the current
        // stack — always wipe it. The retint-on-collapse path does NOT
        // call teardown, so this branch is only for full rebuilds.
        this.displayCubes.length = 0;
        this.unwireEnterButton();
    }

    /** Full reset — called when leaving level-select entirely (back to
     *  mode select). Prevents the collapse animation from firing when
     *  the player re-enters level-select later on a fresh session. */
    public resetShownState(): void {
        this.lastShownIdx = -1;
    }

    /** Enter-level transition — every cube in the tower flies OUTWARD
     *  along its radial direction (from the tower axis), with a
     *  staggered start time and per-cube speed variance so the burst
     *  reads as a wave rather than a synchronized starburst. Scale
     *  fades to 0 over the fly so the cube "melts" as it leaves.
     *
     *  Calls `onDone` after the last cube's fly completes. The stage
     *  cubes are left inactive + scattered; caller is responsible for
     *  hiding the stage node and calling `teardown()` / `resetShownState()`
     *  before the next `showForLevel` — this method does NOT clean up
     *  its own residue. */
    public playExitScatter(onDone: () => void): void {
        if (this._scattering) return;
        this._scattering = true;

        const cubes = this.cubes.slice();
        const N = cubes.length;
        if (N === 0) {
            this._scattering = false;
            onDone();
            return;
        }

        // Snapshot pre-scatter state so we can restore each cube AFTER
        // the animation completes. The stage node is hidden the moment
        // this callback fires, so the restored state stays invisible to
        // the player. It only exists so `showForLevel` on RETURN can
        // still detect the "advanced" collapse path: it needs valid
        // levelGroups + cubes at their original board positions.
        //
        // We snapshot LOCAL position (not world) because restoring
        // world position is fragile when a parent-child pair are both
        // in the cubes list — Cocos's setWorldPosition needs to invert
        // the parent's world matrix to compute local, but the parent
        // matrix might be dirty/stale in the same call chain, giving
        // wrong local positions. LOCAL restore is robust: each node's
        // local pos is independent of any other node's transform.
        const snapshots: Array<{
            node: Node;
            lpx: number; lpy: number; lpz: number;
            sx: number; sy: number; sz: number;
            active: boolean;
        }> = [];
        for (const node of cubes) {
            if (!node || !node.isValid) continue;
            const lp = node.position;   // LOCAL position
            const s = node.scale;
            snapshots.push({
                node,
                lpx: lp.x, lpy: lp.y, lpz: lp.z,
                sx: s.x, sy: s.y, sz: s.z,
                active: node.active,
            });
        }

        // Randomise the stagger ordering so no visible pattern
        // (bottom-to-top, spiral, etc.) leaks through.
        const order: number[] = Array.from({ length: N }, (_, i) => i);
        for (let i = order.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [order[i], order[j]] = [order[j], order[i]];
        }

        const staggerWindow = this.scatterStaggerSec;
        const flyDur        = this.scatterFlyDurSec;
        const flyDist       = this.scatterFlyDist;
        const angleJitter   = this.scatterAngleJitter;
        const yBias         = this.scatterYSpread;

        for (let k = 0; k < N; k++) {
            const node = cubes[order[k]];
            if (!node || !node.isValid) continue;

            const delay = (k / N) * staggerWindow;

            // World-space snapshots — most cubes are children of
            // `stackRoot` (at origin) but the top-counter pixels live
            // under `topCounterRoot`, which has non-identity
            // scale/rotation. Using world coordinates keeps the fly
            // direction consistent across the two.
            const wp = node.worldPosition.clone();
            const initX = wp.x, initY = wp.y, initZ = wp.z;
            const s = node.scale;
            const initSX = s.x, initSY = s.y, initSZ = s.z;

            // Radial-outward from the tower axis (Y). Cubes very close
            // to the axis (top counter pixels) get a random angular
            // pick so they don't stack in place.
            const rXZ = Math.sqrt(initX * initX + initZ * initZ);
            let dirX: number, dirZ: number;
            if (rXZ < 0.05) {
                const a = Math.random() * Math.PI * 2;
                dirX = Math.sin(a);
                dirZ = Math.cos(a);
            } else {
                const jitter = (Math.random() - 0.5) * angleJitter * 2;
                const angle = Math.atan2(initX, initZ) + jitter;
                dirX = Math.sin(angle);
                dirZ = Math.cos(angle);
            }
            // Slight upward bias — cubes at bottom rise a bit, cubes
            // at top rise more, giving the swarm some verticality.
            const dirY = (Math.random() * 0.6 + 0.2) * yBias;
            // Speed variance: 65% – 135% of the base distance.
            const speed = 0.65 + Math.random() * 0.7;

            const carrier = { t: 0 };
            tween(carrier as any)
                .delay(delay)
                .to(flyDur, { t: 1 }, {
                    easing: 'quadOut',
                    onUpdate: () => {
                        if (!node.isValid) return;
                        const t = carrier.t;
                        const d = flyDist * speed * t;
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

        // Fire onDone once the LAST cube finishes flying.
        const totalDur = staggerWindow + flyDur;
        const doneTrigger = { _: 0 };
        tween(doneTrigger as any)
            .delay(totalDur)
            .call(() => {
                // Restore each cube's pre-scatter transform + active
                // state so the internal levelGroups / displayCubes /
                // cubeBaseScales bookkeeping stays consistent. The
                // stage node is inactive at this point (MenuController
                // hides it before this fires), so none of this restore
                // work is visible to the player — it exists purely so
                // the RETURN-to-select collapse animation can find
                // valid cubes to shrink + fly.
                //
                // Restore LOCAL transforms. Since we snapshotted LOCAL
                // positions (not world), each node is fully independent
                // — no parent-child ordering concerns, no world-matrix
                // recompute races. One straight loop does the job.
                for (const snap of snapshots) {
                    if (!snap.node.isValid) continue;
                    snap.node.setPosition(snap.lpx, snap.lpy, snap.lpz);
                    snap.node.setScale(snap.sx, snap.sy, snap.sz);
                    snap.node.active = snap.active;
                }
                this._scattering = false;
                onDone();
            })
            .start();
    }

    /** Per-frame: pulse the current-level fate cells' emissive scale
     *  AND the top counter's uniform scale by independent sine waves. */
    update(dt: number): void {
        // Exit scatter authoring cube positions + scales; skip the
        // pulse loop so it doesn't stomp on those writes.
        if (this._scattering) return;

        // ---- Fate cell glow pulse ----
        if (this.glowingMats.length > 0 && this.fateGlowPulseSpeed > 0) {
            this.glowPhase += dt * this.fateGlowPulseSpeed;
            const wave = Math.sin(this.glowPhase);
            const factor = 1 + this.fateGlowPulseAmp * wave;
            const s = Math.max(0, this.fateGlow * factor);
            const v = new Vec3(s, s, s);
            for (const { mat } of this.glowingMats) {
                mat.setProperty('emissiveScale', v);
            }
        }

        // ---- Top counter scale pulse + rise ----
        // Final scale = counterRiseFactor (0..1 during push-up) times
        // the pulse factor (1 ± amp). Both are always applied, so the
        // number grows during the reveal AND breathes forever after.
        if (this.topCounterRoot && this.topCounterRoot.isValid) {
            this.counterPhase += dt * this.counterPulseSpeed;
            const pulse = 1 + this.counterPulseAmp * Math.sin(this.counterPhase);
            const k = this.counterRiseFactor * pulse;
            this.topCounterRoot.setScale(k, k, k);
        }
    }

    // ============================================================
    //  Build helpers
    // ============================================================

    private ensureMeshes(): void {
        // No-op — we instantiate cubePrefab per cube now. Kept as a
        // stub so existing call sites don't break.
    }

    private buildFoundation(): void {
        const group: Node[] = [];
        for (let r = 0; r < FOUNDATION_ROWS; r++) {
            const y = r * this.rowHeight;
            for (let c = 0; c < COLS; c++) {
                const node = this.spawnCube(c, y, '#8a8a90', FOUNDATION_SCALE, 'foundation');
                group.push(node);
            }
        }
        this.levelGroups.set(-1, group);
    }

    private buildVisibleLevels(): void {
        // TOP-DOWN ordering: currentLevel (idx 0 = level 1) sits at the
        // TOP of the visible stack; each higher-index level slots BELOW
        // it, marching down toward the foundation. The "topmost" slot
        // is therefore the CURRENT level, not the highest-index one.
        for (let k = 0; k < this.visibleLevels; k++) {
            const levelIdx = this.currentLevelIdx + k;
            if (levelIdx >= this.totalLevels) break;
            const isTop = (k === 0);   // current level always at top
            this.buildLevelSegment(levelIdx, isTop);
        }
        // Counter above the current level (visual top of the stack).
        this.spawnTopCounter(this.currentLevelIdx);
    }

    private buildLevelSegment(levelIdx: number, isTopVisible: boolean = false): void {
        const group: Node[] = [];
        // Reversed layout — level 1 (currentLevel) is at the TOP,
        // levels farther in the future march downward toward the base.
        const slotFromTop    = levelIdx - this.currentLevelIdx;
        const slotFromBottom = (this.visibleLevels - 1) - slotFromTop;
        const bodyStartRow   = FOUNDATION_ROWS + slotFromBottom * LEVEL_TOTAL_ROWS;

        // Precompute which display-grid cells are "lit" by the fate
        // shape so per-cube colour lookup is a single Set.has() call.
        const fateCells = this.computeFateDisplayCells(levelIdx);
        const fateColorHex = this.fateColorForLevel(levelIdx);

        // Only the OUTER 1-cell perimeter of the 6×6 display area gets
        // recoloured for the current level (like an item-cube frame).
        // The inner 4×4 stays gray — it's the fate block's canvas.
        const isCurrent = (levelIdx === this.currentLevelIdx);
        const perimeterHex = isCurrent ? '#2196F3' : '#8a8a90';
        const innerHex     = '#8a8a90';

        // Body: 6 rows of random tetromino colours (mosaic look) EXCEPT
        // the 6×6 front-facing display area. Perimeter cubes read as
        // the "frame" (orange for current, gray for others), inner
        // 4×4 is the gray fate-canvas + coloured fate cells. Current
        // level's fate cells ALSO get an emissive glow.
        for (let br = 0; br < LEVEL_BODY_ROWS; br++) {
            const y = (bodyStartRow + br) * this.rowHeight;
            for (let c = 0; c < COLS; c++) {
                let bodyColor: string;
                let emissiveColor: string | undefined;
                const dispCol = DISPLAY_COL_MAP[c];
                let dispRow = -1;
                if (dispCol !== undefined) {
                    dispRow = LEVEL_BODY_ROWS - 1 - br;
                    const key = `${dispRow},${dispCol}`;
                    if (fateCells.has(key)) {
                        bodyColor = fateColorHex;
                        if (isCurrent) emissiveColor = fateColorHex;
                    } else {
                        const isPerimeter = (dispRow === 0 || dispRow === DISPLAY_H - 1
                            || dispCol === 0 || dispCol === DISPLAY_W - 1);
                        bodyColor = isPerimeter ? perimeterHex : innerHex;
                    }
                } else {
                    bodyColor = this.randomBodyColor(levelIdx, br, c);
                }
                const cube = this.spawnCube(c, y, bodyColor, BODY_SCALE, 'body', emissiveColor);
                group.push(cube);
                // Register display-area cubes so retint (on collapse)
                // can rewrite their color without touching non-display
                // mosaic cubes. Skip anything not in the display window.
                if (dispCol !== undefined) {
                    const mat = this.cubeBodyMats.get(cube);
                    if (mat) {
                        this.displayCubes.push({
                            slotFromTop, dispRow, dispCol, col: c,
                            node: cube, mat,
                        });
                    }
                }
            }
        }

        // Separator: 1 gray row on top with the level number.
        // Non-uniform scale — Y=100 makes the belt taller (a chunky
        // ring around the tower), Z=20 makes it recessed. X stays 1.1×
        // to keep the ring hugging the tower circumference.
        // The top-most visible level SKIPS its separator so the
        // floating cleared-count counter (spawnTopCounter) can hover
        // in its place instead.
        const sepRow = bodyStartRow + LEVEL_BODY_ROWS;
        const sepY   = sepRow * this.rowHeight;
        if (!isTopVisible) {
            const seps: Node[] = [];
            for (let c = 0; c < COLS; c++) {
                const n = this.spawnCubeAbsolute(
                    c, sepY, '#8a8a90',
                    new Vec3(48, 100, 20),   // scale overrides
                    'separator',
                );
                group.push(n);
                seps.push(n);
            }
            this.separatorGroups.set(levelIdx, seps);
        }
        // Fate block is now baked into the body cubes (colored cells
        // inside the 6×6 display area). No separate spawn needed.
        this.levelGroups.set(levelIdx, group);
    }

    /** Retint every tracked display-area cube for the CURRENT
     *  `currentLevelIdx`. Slot 0 shows currentLevelIdx, slot 1 shows
     *  currentLevelIdx+1, etc — so the same physical cube now paints a
     *  different fate shape after the level advances. This is the fast
     *  path used by the collapse animation to avoid tearing down + re-
     *  instantiating ~800 cubes on every level clear. */
    private retintDisplayCubes(): void {
        // The list of currently-glowing fate cells changes with the new
        // current-level's fate shape; wipe + re-register.
        this.glowingMats.length = 0;

        // Cache per-level lookups so we don't recompute fateCells /
        // fateColor / perimeterHex for every one of the ~180 cubes.
        const perLevel = new Map<number, {
            fateCells: Set<string>;
            fateColorHex: string;
            perimeterHex: string;
            innerHex: string;
            isCurrent: boolean;
        }>();

        for (const entry of this.displayCubes) {
            const levelIdx = this.currentLevelIdx + entry.slotFromTop;
            if (levelIdx >= this.totalLevels) continue;
            let info = perLevel.get(levelIdx);
            if (!info) {
                const isCurrent = (entry.slotFromTop === 0);
                info = {
                    fateCells:    this.computeFateDisplayCells(levelIdx),
                    fateColorHex: this.fateColorForLevel(levelIdx),
                    perimeterHex: isCurrent ? '#2196F3' : '#8a8a90',
                    innerHex:     '#8a8a90',
                    isCurrent,
                };
                perLevel.set(levelIdx, info);
            }

            const key = `${entry.dispRow},${entry.dispCol}`;
            const isFate = info.fateCells.has(key);
            const isPerimeter = (entry.dispRow === 0 || entry.dispRow === DISPLAY_H - 1
                || entry.dispCol === 0 || entry.dispCol === DISPLAY_W - 1);
            let bodyColor: string;
            let emissiveColor: string | undefined;
            if (isFate) {
                bodyColor = info.fateColorHex;
                if (info.isCurrent) emissiveColor = info.fateColorHex;
            } else {
                bodyColor = isPerimeter ? info.perimeterHex : info.innerHex;
            }

            const k = this.frontDim(entry.col);
            const base = hex(bodyColor);
            entry.mat.setProperty('mainColor', new Color(
                Math.floor(base.r * k),
                Math.floor(base.g * k),
                Math.floor(base.b * k),
                255,
            ));
            if (emissiveColor) {
                const em = hex(emissiveColor);
                entry.mat.setProperty('emissive', new Color(em.r, em.g, em.b, 255));
                const s = this.fateGlow;
                entry.mat.setProperty('emissiveScale', new Vec3(s, s, s));
                this.glowingMats.push({ mat: entry.mat, base: new Color(em.r, em.g, em.b, 255) });
            } else {
                // Clear any leftover glow so cells that WERE fate cells
                // on the previous level don't keep glowing after retint.
                entry.mat.setProperty('emissive', new Color(0, 0, 0, 255));
                entry.mat.setProperty('emissiveScale', new Vec3(0, 0, 0));
            }
        }
    }

    /** Per-level custom-piece shapes injected by MenuController before
     *  showForLevel. Indexed by levelIdx. When set, computeFateDisplayCells
     *  uses the level's actual customPiece.shape instead of falling back
     *  to the built-in 99-shape pool. Length may be shorter than
     *  totalLevels — indexes past the end fall back to the pool. */
    private levelShapes: Array<number[][] | null> = [];
    public setLevelShapes(shapes: Array<number[][] | null | undefined>): void {
        this.levelShapes = shapes.map(s => (s && s.length ? (s as number[][]) : null));
    }

    /** Pick a fate shape for `levelIdx` — prefer the actual level's
     *  customPiece.shape (set via setLevelShapes) so the tower matches
     *  what the player sees in the fate modal + gameplay. Falls back to
     *  the built-in 99-shape pool for stub / endless entries.
     *  Returns the set of `${dispRow},${dispCol}` display-grid keys
     *  where its filled cells land (centered in the 6×6 area). */
    private computeFateDisplayCells(levelIdx: number): Set<string> {
        const set = new Set<string>();
        let shape: number[][] | undefined | null = this.levelShapes[levelIdx];
        if (!shape || !shape.length) {
            const idx = levelIdx % GAME_FATE_SHAPES.length;
            shape = GAME_FATE_SHAPES[idx];
        }
        if (!shape || !shape.length) return set;

        // Bbox of the shape.
        // Bbox the shape to its filled cells so a small piece centers
        // properly in the 6×6 display area. customPiece.shape is often
        // a padded 4×4 grid — bboxing collapses the padding so a 2×3
        // T-piece renders as 2×3, not 4×4.
        let minR = shape.length, maxR = -1, minC = Infinity, maxC = -1;
        for (let r = 0; r < shape.length; r++) {
            const row = shape[r];
            if (!row) continue;
            for (let c = 0; c < row.length; c++) {
                if (!row[c]) continue;
                if (r < minR) minR = r; if (r > maxR) maxR = r;
                if (c < minC) minC = c; if (c > maxC) maxC = c;
            }
        }
        if (maxR < 0) return set;
        const rowsN = maxR - minR + 1;
        const colsN = maxC - minC + 1;
        // Center in 6×6 (integer offsets — floor bias goes to top-left).
        const rowOff = Math.floor((DISPLAY_H - rowsN) / 2);
        const colOff = Math.floor((DISPLAY_W - colsN) / 2);
        for (let r = 0; r < shape.length; r++) {
            const row = shape[r];
            if (!row) continue;
            for (let c = 0; c < row.length; c++) {
                if (!row[c]) continue;
                const dispRow = rowOff + (r - minR);
                const dispCol = colOff + (c - minC);
                if (dispRow < 0 || dispRow >= DISPLAY_H) continue;
                if (dispCol < 0 || dispCol >= DISPLAY_W) continue;
                set.add(`${dispRow},${dispCol}`);
            }
        }
        return set;
    }

    /** Colour hex used for the fate-block cells of `levelIdx`. Cycles
     *  through the 7 tetromino colours by level index. */
    private fateColorForLevel(levelIdx: number): string {
        const key = LEVEL_BODY_KEYS[levelIdx % LEVEL_BODY_KEYS.length];
        return COLORS[key as keyof typeof COLORS] ?? '#ffffff';
    }

    /** Deterministic pseudo-random colour pick from LEVEL_BODY_KEYS. The
     *  hash mixes levelIdx / row / col so each cube gets a stable colour
     *  that stays the same across rebuilds — no re-roll flicker. */
    private randomBodyColor(levelIdx: number, row: number, col: number): string {
        // Simple integer mix — enough entropy for 7-way pick.
        let h = (levelIdx * 73856093) ^ (row * 19349663) ^ (col * 83492791);
        h = (h ^ (h >>> 13)) * 1274126177;
        h = (h ^ (h >>> 16)) >>> 0;
        const key = LEVEL_BODY_KEYS[h % LEVEL_BODY_KEYS.length];
        return COLORS[key as keyof typeof COLORS] ?? '#ffffff';
    }

    private spawnCube(
        col: number,
        y: number,
        colorHex: string,
        scale: number,
        kind: 'body' | 'foundation' | 'separator',
        emissiveHex?: string,
    ): Node {
        if (!this.cubePrefab) {
            // No prefab wired — nothing to spawn. Warn once.
            if (!this._warnedPrefabMissing) {
                console.warn('[LevelSelectStage3D] cubePrefab not set — nothing rendered.');
                this._warnedPrefabMissing = true;
            }
            return new Node();
        }

        const theta = col * ANGLE_PER_COL;
        const x = RADIUS * Math.sin(theta);
        const z = RADIUS * Math.cos(theta);

        const node = instantiate(this.cubePrefab);
        node.name = `Cube_${kind}_${col}_${y.toFixed(2)}`;
        node.parent = this.stackRoot ?? this.node;
        node.setPosition(x, y, z);
        // Same yaw pattern as the game's playing tower: face the ring
        // center, +180° so the crystal facet reads outward.
        node.setRotationFromEuler(90, math.toDegree(theta) + 180, 0);
        // Uniform scale for foundation / separator (1.1×) vs body (1.0×).
        const s = node.scale;
        const targetSx = s.x * scale;
        const targetSy = s.y * scale;
        const targetSz = s.z * scale;
        node.setScale(targetSx, targetSy, targetSz);
        this.cubeBaseScales.set(node, new Vec3(targetSx, targetSy, targetSz));

        // Tint the body MR (the one that has `mainColor`). `mr.material`
        // getter auto-instances the material so this cube's tint doesn't
        // leak into other cubes. Colour is DIMMED for back-facing cubes
        // via `frontness`, so the tower back fades into fog.
        const k = this.frontDim(col);
        const allMrs = node.getComponentsInChildren(MeshRenderer);
        for (const mr of allMrs) {
            const mat = mr.material;
            if (!mat || !mat.passes || mat.passes.length === 0) continue;
            let handle: any = null;
            try { handle = mat.passes[0].getHandle('mainColor'); } catch { /* ignore */ }
            if (!handle) continue;
            const base = hex(colorHex);
            mat.setProperty('mainColor', new Color(
                Math.floor(base.r * k),
                Math.floor(base.g * k),
                Math.floor(base.b * k),
                255,
            ));
            // Optional glow — used by current-level fate cells. Also
            // registered for the pulse animation in update().
            if (emissiveHex) {
                const em = hex(emissiveHex);
                mat.setProperty('emissive', new Color(em.r, em.g, em.b, 255));
                const s = this.fateGlow;
                mat.setProperty('emissiveScale', new Vec3(s, s, s));
                this.glowingMats.push({ mat, base: new Color(em.r, em.g, em.b, 255) });
            }
            // Cache the body material so retint can find it in O(1).
            this.cubeBodyMats.set(node, mat);
            break;
        }

        this.cubes.push(node);
        return node;
    }

    /** Frontness-based dim factor: 1.0 for front-most column (col 0),
     *  falls off to `backDim` at the far side (col ≈ COLS/2). Matches
     *  the game's playing-tower atmospheric fog trick. */
    private frontDim(col: number): number {
        // col wraps 0..COLS-1; normalize angle to -π..π so cos gives
        // +1 at front (col 0) and -1 at back (col COLS/2).
        let rel = col * ANGLE_PER_COL;
        if (rel > Math.PI) rel -= 2 * Math.PI;
        const frontness = (Math.cos(rel) + 1) / 2;   // 0..1
        return this.backDim + (1 - this.backDim) * frontness;
    }

    private _warnedPrefabMissing = false;

    /** Same as `spawnCube` but sets an ABSOLUTE scale vector on the
     *  spawned node instead of multiplying the prefab's base scale by a
     *  scalar. Used for the separator ring where each axis wants a
     *  different value (Y=100 for a chunky belt, Z=20 for a recessed
     *  look). */
    private spawnCubeAbsolute(
        col: number,
        y: number,
        colorHex: string,
        absScale: Vec3,
        kind: 'body' | 'foundation' | 'separator',
    ): Node {
        if (!this.cubePrefab) return new Node();

        const theta = col * ANGLE_PER_COL;
        const x = RADIUS * Math.sin(theta);
        const z = RADIUS * Math.cos(theta);

        const node = instantiate(this.cubePrefab);
        node.name = `Cube_${kind}_${col}_${y.toFixed(2)}`;
        node.parent = this.stackRoot ?? this.node;
        node.setPosition(x, y, z);
        node.setRotationFromEuler(90, math.toDegree(theta) + 180, 0);
        node.setScale(absScale.x, absScale.y, absScale.z);
        this.cubeBaseScales.set(node, new Vec3(absScale.x, absScale.y, absScale.z));

        // Same back-dim as spawnCube for atmospheric consistency.
        const k = this.frontDim(col);
        const allMrs = node.getComponentsInChildren(MeshRenderer);
        for (const mr of allMrs) {
            const mat = mr.material;
            if (!mat || !mat.passes || mat.passes.length === 0) continue;
            let handle: any = null;
            try { handle = mat.passes[0].getHandle('mainColor'); } catch { /* ignore */ }
            if (!handle) continue;
            const base = hex(colorHex);
            mat.setProperty('mainColor', new Color(
                Math.floor(base.r * k),
                Math.floor(base.g * k),
                Math.floor(base.b * k),
                255,
            ));
            break;
        }

        this.cubes.push(node);
        return node;
    }

    /** Spawn a big number at the top of the visible stack, in place
     *  of the top separator ring. The value shown is the 1-based stage
     *  number of the TOP-VISIBLE cube (`currentLevelIdx + 1`) — i.e.
     *  the stage the player is about to play. Matches the leaderboard's
     *  1-based stage numbering so both surfaces agree on which stage
     *  is "current". Example: a player who just beat Stage 12 has
     *  currentLevelIdx = 12 (next to play), so the plaque reads "13".
     *  Fresh player (currentLevelIdx = 0) → plaque reads "1". */
    private spawnTopCounter(topLevelIdx: number): void {
        const nextStage = this.currentLevelIdx + 1;
        if (nextStage <= 0) return;   // defensive — should never trip

        // Position: LAY the number FLAT on top of the tower like a lid.
        // Digit rows now extend along Z (near→far from camera) instead
        // of Y (up→down), and Y becomes a fixed low profile (the lid's
        // thickness). Top of the tower = topY.
        const slotFromTop    = topLevelIdx - this.currentLevelIdx;
        const slotFromBottom = (this.visibleLevels - 1) - slotFromTop;
        const bodyStartRow   = FOUNDATION_ROWS + slotFromBottom * LEVEL_TOTAL_ROWS;
        const topY = (bodyStartRow + LEVEL_BODY_ROWS) * this.rowHeight;

        const digits = String(nextStage).split('');
        const px = 0.6;                 // pixel edge length (world units)
        const gap = px;                  // 1-pixel gap between digits
        const digitW = 3 * px;
        const totalW = digits.length * digitW + Math.max(0, digits.length - 1) * gap;
        const startX = -totalW / 2 + px / 2;
        const counterColor = '#fff4c8';   // warm cream — reads as "summary" tint

        const group = this.levelGroups.get(topLevelIdx) ?? [];

        // Parent Node — carries the assembly's world position + tilt.
        // Individual cube.prefab pixels sit in the parent's LOCAL frame
        // flat on Y; the parent's X-axis rotation tips the whole plaque
        // up toward the camera by `counterTiltDeg`.
        const parent = new Node(`TopCounter_Root`);
        parent.parent = this.stackRoot ?? this.node;
        parent.layer  = (this.stackRoot ?? this.node).layer;
        parent.setPosition(0, topY + px * 0.5, 0);
        parent.setRotationFromEuler(this.counterTiltDeg, 0, 0);
        // Match the current rise factor so we don't render one frame
        // at default scale (1,1,1) before update() applies the pulse.
        const initK = this.counterRiseFactor;
        parent.setScale(initK, initK, initK);
        // Track parent's scale as "base = initial" so the collapse
        // push-up loop's `current ≠ target` scale check treats it as a
        // no-op. update() manages the parent's real scale via
        // counterRiseFactor * pulse, so we don't want the push-up tween
        // fighting it.
        this.cubeBaseScales.set(parent, new Vec3(initK, initK, initK));
        this.topCounterRoot = parent;
        this.counterPhase = 0;

        for (let d = 0; d < digits.length; d++) {
            const pattern = DIGIT_PIXELS[digits[d]];
            if (!pattern) continue;
            const digitXOffset = startX + d * (digitW + gap);
            for (let row = 0; row < pattern.length; row++) {
                const bits = pattern[row];
                for (let col = 0; col < bits.length; col++) {
                    if (bits.charAt(col) !== '1') continue;
                    const localX = digitXOffset + col * px;
                    // Top of digit (row=0) at far side (-Z from tower
                    // center) so a top-down camera reads the number
                    // right-side-up.
                    const localZ = (row - 2) * px;

                    this.spawnPixelCube(parent, localX, 0, localZ, px, counterColor, `TopCounter_r${row}_c${col}`);
                }
            }
        }
        group.push(parent);
        this.cubes.push(parent);
        this.levelGroups.set(topLevelIdx, group);
    }

    /** Spawn one cube.prefab instance as a "pixel" at (x, y, z) under
     *  `parent`, uniformly scaled so the visible size ≈ `sizeWorld`
     *  units per axis, and tinted with `colorHex`. Uses the same
     *  material-clone-and-set-mainColor path as `spawnCube`. */
    private spawnPixelCube(
        parent: Node,
        x: number, y: number, z: number,
        sizeWorld: number,
        colorHex: string,
        name: string,
    ): void {
        if (!this.cubePrefab) return;
        const node = instantiate(this.cubePrefab);
        node.name = name;
        node.parent = parent;
        node.setPosition(x, y, z);

        // cube.prefab's root has inherent scale (50,50,50) baked in;
        // multiplying by `sizeWorld` gives an actual pixel of that size.
        const s = node.scale;
        const tsx = s.x * sizeWorld, tsy = s.y * sizeWorld, tsz = s.z * sizeWorld;
        node.setScale(tsx, tsy, tsz);
        this.cubeBaseScales.set(node, new Vec3(tsx, tsy, tsz));

        // Tint the body MR only.
        const allMrs = node.getComponentsInChildren(MeshRenderer);
        for (const mr of allMrs) {
            const mat = mr.material;
            if (!mat || !mat.passes || mat.passes.length === 0) continue;
            let handle: any = null;
            try { handle = mat.passes[0].getHandle('mainColor'); } catch { /* ignore */ }
            if (!handle) continue;
            const base = hex(colorHex);
            mat.setProperty('mainColor', new Color(base.r, base.g, base.b, 255));
            break;
        }

        this.cubes.push(node);
    }

    // ============================================================
    //  Camera
    // ============================================================

    private positionCamera(): void {
        if (!this.camera3D) return;
        // Focus on the same world-Y as before the top-down reversal —
        // roughly the base of the level stack — so the camera view is
        // stable regardless of ordering. The current level now sits at
        // the visual TOP of the frame; older levels sit lower.
        const bodyStartRow = FOUNDATION_ROWS;
        const focusY = (bodyStartRow + LEVEL_BODY_ROWS / 2) * this.rowHeight;
        // `frameShiftY` moves the camera up (tower renders lower) to
        // reserve headroom for the 2D overlay (back arrow, progress
        // bar, badges). Independent of the focus offset so tuning one
        // doesn't fight the other.
        this.camera3D.setPosition(0, focusY + this.cameraLookOffsetY + this.frameShiftY, this.cameraDistance);
        // Aim down-forward by pitch degrees.
        this.camera3D.setRotationFromEuler(this.cameraPitchDeg, 0, 0);
    }

    // ============================================================
    //  UI
    // ============================================================

    private updateUi(): void {
        if (this.levelNameLabel) {
            this.levelNameLabel.string = t('level.name', { n: this.currentLevelIdx + 1 });
        }
        if (this.enterButton) {
            this.enterButton.interactable = this.currentLevelIdx < this.totalLevels;
            // Inner label ("进入关卡" default in scene) — overwrite each
            // time we refresh so language changes propagate.
            const enterLab = this.enterButton.getComponentInChildren(Label);
            if (enterLab) enterLab.string = t('level.enter');
        }
    }

    private wireEnterButton(): void {
        // Off-then-on guarantees idempotence — the cached-tower path
        // in showForLevel() may call this multiple times across shows
        // without an intervening teardown/unwire, so registering the
        // handler without first clearing would stack duplicate calls.
        if (this.enterButton) {
            this.enterButton.node.off('click', this.onEnterClick, this);
            this.enterButton.node.on('click', this.onEnterClick, this);
            // The button lives under the main Canvas (so it renders via
            // the UI camera) — we can't just toggle Stage3D's active flag
            // to hide it. Show it here, hide it in unwire (called from
            // teardown() when the stage closes).
            this.enterButton.node.active = true;
        }
        if (this.backButton) {
            this.backButton.node.off('click', this.onBackClick, this);
            this.backButton.node.on('click', this.onBackClick, this);
            this.backButton.node.active = true;
        }
    }
    private unwireEnterButton(): void {
        if (this.enterButton) {
            this.enterButton.node.off('click', this.onEnterClick, this);
            this.enterButton.node.active = false;
        }
        if (this.backButton) {
            this.backButton.node.off('click', this.onBackClick, this);
            this.backButton.node.active = false;
        }
    }

    /** Public shim so MenuController can hide the overlay buttons
     *  (Enter / Back) without also tearing down the whole tower's
     *  cube state — the enter-level path preserves cubes so the
     *  return-from-win collapse animation still has something to
     *  collapse on. */
    public hideOverlayButtons(): void {
        this.unwireEnterButton();
    }

    private onEnterClick(): void {
        if (this.onEnterCb) this.onEnterCb(this.currentLevelIdx);
    }

    private onBackClick(): void {
        if (this.onBackCb) this.onBackCb();
    }
}
