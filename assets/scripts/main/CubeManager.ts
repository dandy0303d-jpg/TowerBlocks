/**
 * CubeManager — owns every BOARD-CELL render pool and the per-frame cell-
 * placement routine. Pulled out of GameController so that controller can
 * focus on game-loop orchestration / input / HUD / falling-projectile
 * animation, while this component owns:
 *
 *   - the regular brick pool (`pool`)
 *   - the 6 row/col-blast prop pools (`rowBlastPools`)
 *   - the per-HP stone pools (`stonePools`)
 *   - the Wrecker / RocketCube / HailCube / MeteorCube / GatlingCube
 *     item-cube pools
 *   - the 3 BoomCube level pools (`boomCubePools`)
 *   - the standalone spinning rocket-prop pool + its sparkle children
 *
 * All the falling projectile pools (rocket storm, hail drop, gatling
 * bullet) and the rainbow-flash / pre-pulse overlay pools stay in
 * GameController — they're animation, not board cells.
 *
 * Entry point each frame: `syncBoardCells(state, current, centerCol,
 * totalRows)`. Call from `GameController.syncCubes()`, then layer the
 * falling-projectile and flash overlays on top.
 *
 * Wiring:
 *   1. Drop this component on the same node as `GameController`.
 *   2. Drag the same `BoardRoot3D` scene node into `boardRoot3D`.
 *   3. Drag every prop prefab into the matching slot (the slot names
 *      match GameController's old fields one-for-one).
 *   4. In `GameController` inspector, drag THIS component into the
 *      `cubeManager` slot.
 */

import {
    _decorator,
    Component,
    Node,
    Prefab,
    instantiate,
    MeshRenderer,
    Material,
    Color,
    Vec3,
    Quat,
    math,
    primitives,
    utils,
} from 'cc';

import { COLS, COLORS, CellValue } from '../core/Constants';
import { BoardState, Piece, BombKind, BoomLevel } from '../core/Types';

import { RowBlastCubeFX } from './RowBlastCubeFX';
import { WreckerCubeFX } from './WreckerCubeFX';
import { RocketCubeFX } from './RocketCubeFX';
import { HailCubeFX } from './HailCubeFX';
import { MeteorCubeFX } from './MeteorCubeFX';
import { GatlingCubeFX } from './GatlingCubeFX';
import { BoomCubeFX } from './BoomCubeFX';

const { ccclass, property } = _decorator;

// ============================================================
//  Layout constants — must match the ones in GameController so
//  cells line up with the falling-projectile / flash overlays
//  that still live there. Kept duplicated for now; extract to a
//  shared `RenderLayout.ts` later if more renderers spin off.
// ============================================================

/** World-space width of one board cell. */
const CELL_SIZE      = 1.0;
/** Per-cube scale multiplier so neighbours have a faint gap. */
const CUBE_VISUAL    = 1.0;
/** Full visual sweep around the cylinder, in radians. */
const VISUAL_SPAN    = 2 * Math.PI;
/** Angular distance between two adjacent columns. */
const ANGLE_PER_COL  = VISUAL_SPAN / COLS;
/** Cylinder radius so cell-width arcs are exactly CELL_SIZE wide. */
const RADIUS         = CELL_SIZE / (2 * Math.sin(ANGLE_PER_COL / 2));
/** Visible row window used to anchor the board's Y position. */
const VISIBLE_ROWS   = 20;
/** Y-coordinate of the LOGICAL BOTTOM row (row `rows - 1`). */
const Y_BOTTOM       = -(VISIBLE_ROWS / 2) * CELL_SIZE + CELL_SIZE / 2;

const BRICK_BACK_DIM = 0.45;

// ============================================================
//  Tiny shared helpers
// ============================================================

function hexToColor(s: string): Color {
    const out = new Color();
    Color.fromHEX(out, s);
    return out;
}


function materialHasProperty(mat: Material | null | undefined, name: string): boolean {
    if (!mat || !mat.passes || mat.passes.length === 0) return false;
    try {
        const h = mat.passes[0].getHandle(name);
        return !!h;
    } catch {
        return false;
    }
}

@ccclass('CubeManager')
export class CubeManager extends Component {

    // ============================================================
    //  Prefab slots
    // ============================================================

    /** Scene node every cube is parented under. Same node `GameController`
     *  rotates / translates each frame to keep the active piece centered. */
    @property(Node)
    boardRoot3D: Node | null = null;

    /** Regular brick prefab (the Meshy curved brick). Required. */
    @property(Prefab)
    cubePrefab: Prefab | null = null;

    /** Row / col blast prefab variants — one per bomb kind. Leave any
     *  blank to fall back to the regular brick for that kind. */
    @property(Prefab)
    rowBlastPrefab: Prefab | null = null;          // row1
    @property(Prefab)
    rowBlastPrefabRow2: Prefab | null = null;
    @property(Prefab)
    rowBlastPrefabRow3: Prefab | null = null;
    @property(Prefab)
    rowBlastPrefabCol1: Prefab | null = null;
    @property(Prefab)
    rowBlastPrefabCol2: Prefab | null = null;
    @property(Prefab)
    rowBlastPrefabCol3: Prefab | null = null;

    /** Stone prefabs indexed by `hpIdx = 4 − HP` (0 = pristine HP4, 3 = HP1). */
    @property([Prefab])
    stonePrefabs: Prefab[] = [];

    @property(Prefab)
    wreckerPrefab: Prefab | null = null;
    @property(Prefab)
    rocketCubePrefab: Prefab | null = null;
    @property(Prefab)
    hailCubePrefab: Prefab | null = null;
    @property(Prefab)
    meteorCubePrefab: Prefab | null = null;
    @property(Prefab)
    gatlingCubePrefab: Prefab | null = null;

    /** BoomCube prefabs indexed by level − 1 (1/2/3). */
    @property({ type: [Prefab] })
    boomCubePrefabs: (Prefab | null)[] = [null, null, null];

    /** Standalone rocket model used for the rocket-prop CELL renderer
     *  (the spinning launchpad-rocket appearance). GameController also
     *  reads this slot via `getRocketPrefab()` for its in-flight pools. */
    @property(Prefab)
    rocketPrefab: Prefab | null = null;

    // ============================================================
    //  Tuning fields
    // ============================================================

    /** How dim the back of the cylinder looks compared to the front.
     *  0 = fully black, 1 = no dimming. Same value GameController used. */
    @property
    rowBlastBackDim: number = 0.35;

    /** Tilt of the spinning rocket prop, in degrees. */
    // @property
    rocketPropTiltDeg: number = 45;

    /** Degrees-per-second rocket-prop yaw spin. */
    // @property
    rocketPropSpinSpeed: number = 60;

    /** Sparkle count attached to each rocket-prop instance. */
    // @property
    rocketPropStarCount: number = 10;
    // @property
    rocketPropStarSize: number = 0.07;
    // @property
    rocketPropStarLifetimeMin: number = 0.06;
    // @property
    rocketPropStarLifetimeMax: number = 0.22;
    // @property
    rocketPropStarRadius: number = 0.55;
    // @property
    rocketPropStarColor: Color = new Color(255, 255, 255, 255);

    // ============================================================
    //  Pool storage
    // ============================================================

    /** Pool of brick instances — pre-allocated, reused each frame. */
    private pool: Node[] = [];
    private poolMeshes: MeshRenderer[] = [];
    private poolBaseScale: Vec3[] = [];
    private poolCursor = 0;

    /** Ghost-piece pool — same brick prefab but with translucent
     *  materials, used to preview the hard-drop landing spot. Kept
     *  small (a piece has ≤5 cells; 8 gives slack for custom shapes). */
    private ghostPool: Node[] = [];
    private ghostPoolMeshes: MeshRenderer[] = [];
    private ghostPoolBaseScale: Vec3[] = [];
    private ghostPoolCursor = 0;

    /** Row/col-blast prop pools keyed by `BombKind`. */
    private rowBlastPools = new Map<string, {
        nodes: Node[];
        baseScales: Vec3[];
        baseRots: Quat[];
        cursor: number;
    }>();

    /** Stone pools per damage level (0 = pristine, length − 1 = critical). */
    private stonePools: Array<{
        nodes: Node[];
        baseScales: Vec3[];
        cursor: number;
    }> = [];

    private wreckerPool = newCubePool();
    private rocketCubePool = newCubePool();
    private hailCubePool = newCubePool();
    private meteorCubePool = newCubePool();
    private gatlingCubePool = newCubePool();
    private boomCubePools: ReturnType<typeof newCubePool>[] = [
        newCubePool(), newCubePool(), newCubePool(),
    ];

    /** Standalone rocket-prop pool (spinning launchpad-rocket cell appearance). */
    private rocketPropPool: Node[] = [];
    private rocketPropCursor = 0;
    /** Sparkle children attached to each rocket-prop pool entry. */
    private rocketPropSparkles: Array<Array<{
        node: Node;
        lifetime: number;
        ttl: number;
    }>> = [];
    private rocketPropSpinPhase = 0;

    /** Whether the brick material supports `mainColor` — probed once at
     *  build time. Drives the per-cube tint path in `placeCube`. */
    private canTintBricks = false;

    /** Has at least one row-blast cell been placed yet this run? Used
     *  for a single diagnostic log so we know the dispatch path fires. */
    private rowBlastLogged = false;

    // ============================================================
    //  Public API
    // ============================================================

    /** Build every pool. Call this from `GameController.start()` AFTER the
     *  brick prefab pool is set up but BEFORE the first sync. */
    public buildPools(): void {
        if (!this.boardRoot3D) {
            console.warn('[CubeManager] boardRoot3D unset — pools not built.');
            return;
        }
        if (!this.cubePrefab) {
            console.warn('[CubeManager] cubePrefab unset — pools not built.');
            return;
        }
        // Each pool is wrapped so one missing/broken prefab can't take the
        // whole game down — without this, the splash screen waits forever
        // for the scene to report "ready". Specific failures are logged so
        // we can fix them later.
        const safe = (label: string, fn: () => void): void => {
            try {
                console.log(`[CubeManager] build ${label} …`);
                fn();
                console.log(`[CubeManager] build ${label} OK`);
            } catch (err) {
                console.warn(`[CubeManager] build ${label} FAILED:`, err);
            }
        };
        safe('brick',     () => this.buildBrickPool());
        safe('ghost',     () => this.buildGhostPool());
        safe('rowBlast',  () => this.buildRowBlastPool());
        safe('stones',    () => this.buildStonePools());
        safe('wrecker',   () => this.buildWreckerPool());
        safe('rocketCub', () => this.buildRocketCubePool());
        safe('hailCube',  () => this.buildHailCubePool());
        safe('meteorCub', () => this.buildMeteorCubePool());
        safe('gatlingC',  () => this.buildGatlingCubePool());
        safe('boomCube',  () => this.buildBoomCubePools());
        safe('rocketPrp', () => this.buildRocketPropPool());

        this.canTintBricks = this.poolMeshes.length > 0
            && materialHasProperty(this.poolMeshes[0].material, 'mainColor');
        console.log(`[CubeManager] buildPools done. canTintBricks=${this.canTintBricks}`);
    }

    /** Warmup — briefly activate ONE node from each pool so the GPU
     *  driver compiles every material's shader variant and uploads
     *  every texture NOW instead of the first time that FX plays in
     *  gameplay. Called during the LoadingController's boot phase.
     *  Nodes are placed off-screen so the player never sees them.
     *  Caller is responsible for calling `warmupCleanup()` a few
     *  frames later to deactivate them. */
    public warmupActivate(): void {
        // Origin (not off-screen) so nodes actually enter the render
        // pipeline — culled nodes never compile their shaders.
        const warmupPos = new Vec3(0, 0, 0);
        const activate = (n: Node | undefined | null): void => {
            if (!n) return;
            n.setPosition(warmupPos);
            n.active = true;
        };
        if (this.pool[0]) activate(this.pool[0]);
        if (this.ghostPool[0]) activate(this.ghostPool[0]);
        for (const p of this.rowBlastPools.values()) activate(p.nodes[0]);
        for (const p of this.stonePools) activate(p.nodes[0]);
        activate(this.wreckerPool.nodes[0]);
        activate(this.rocketCubePool.nodes[0]);
        activate(this.hailCubePool.nodes[0]);
        activate(this.meteorCubePool.nodes[0]);
        activate(this.gatlingCubePool.nodes[0]);
        for (const p of this.boomCubePools) activate(p.nodes[0]);
        activate(this.rocketPropPool[0]);
    }

    /** Warmup cleanup — deactivate everything warmupActivate() turned
     *  on. Call one or two frames after warmupActivate() so GPU has
     *  time to actually render and compile. */
    public warmupCleanup(): void {
        const deactivate = (n: Node | undefined | null): void => {
            if (n) n.active = false;
        };
        if (this.pool[0]) deactivate(this.pool[0]);
        if (this.ghostPool[0]) deactivate(this.ghostPool[0]);
        for (const p of this.rowBlastPools.values()) deactivate(p.nodes[0]);
        for (const p of this.stonePools) deactivate(p.nodes[0]);
        deactivate(this.wreckerPool.nodes[0]);
        deactivate(this.rocketCubePool.nodes[0]);
        deactivate(this.hailCubePool.nodes[0]);
        deactivate(this.meteorCubePool.nodes[0]);
        deactivate(this.gatlingCubePool.nodes[0]);
        for (const p of this.boomCubePools) deactivate(p.nodes[0]);
        deactivate(this.rocketPropPool[0]);
    }

    /** Per-frame: reset all cursors, render every board cell from
     *  `state` + active piece, then deactivate the unused tails. */
    public syncBoardCells(
        state: BoardState,
        current: Piece | null,
        centerCol: number,
        totalRows: number,
        /** Optional callback that returns a fractional ROW index for the cell
         *  at logical `(r, c)`. Used by the fall-animation system in
         *  GameController: when a cell is mid-fall, `displayRowFor` returns
         *  a value between `fromR` and `toR`, so its world Y is interpolated
         *  smoothly instead of teleporting. Defaults to identity. */
        displayRowFor?: (r: number, c: number) => number,
        /** Optional fractional Y offset (0..1) added to every cell of the
         *  ACTIVE PIECE. Used to smooth-scroll the meteor DOT piece
         *  between grid steps so it doesn't teleport row by row. Zero
         *  means "render at logical y". */
        pieceYOffset: number = 0,
        /** Optional Y (integer row index) where the current piece would
         *  land if hard-dropped now. When set, we render translucent
         *  ghost cubes at that row using the piece's shape/type. Pass
         *  `null` (or omit) to disable the ghost. */
        ghostY: number | null = null,
        /** Blind-mode toggle: skip rendering the settled board cells
         *  entirely (game state stays intact — we just don't paint any
         *  cube for stored cells). Active piece + ghost still render so
         *  the player can see what they're placing. Set true by
         *  GameController when `mode === 'blind'` and the debug
         *  "show tower" switch is off. */
        hideBoardCells: boolean = false,
    ): void {
        // ---- reset cursors ----
        this.poolCursor = 0;
        this.ghostPoolCursor = 0;
        this.rocketPropCursor = 0;
        this.wreckerPool.cursor = 0;
        this.rocketCubePool.cursor = 0;
        this.hailCubePool.cursor = 0;
        this.meteorCubePool.cursor = 0;
        this.gatlingCubePool.cursor = 0;
        for (const p of this.boomCubePools) p.cursor = 0;
        for (const pool of this.rowBlastPools.values()) pool.cursor = 0;
        for (const sp of this.stonePools) sp.cursor = 0;

        const bombsGrid    = state.boardBombs;
        const stonesGrid   = state.boardStones;
        const rocketsGrid  = state.boardRockets;
        const wreckersGrid = state.boardWreckers;
        const hailsGrid    = state.boardHails;
        const meteorsGrid  = state.boardMeteors;
        const gatlingsGrid = state.boardGatlings;
        const boomsGrid    = state.boardBooms;

        // ---- board cells ----
        // Blind mode skips this whole loop — all pool cursors stay at 0
        // and the tail-hide code below will deactivate every previously
        // active cube on the first frame after the mode kicks in.
        if (!hideBoardCells) for (let r = 0; r < totalRows; r++) {
            for (let c = 0; c < COLS; c++) {
                const v    = state.board[r][c];
                const bomb = bombsGrid && bombsGrid[r] ? bombsGrid[r][c] : null;
                // Cells mid-fall report a FRACTIONAL row from displayRowFor —
                // everything downstream (placeCube, placeStone, the prop
                // helpers) just multiplies row by CELL_SIZE to get Y, so the
                // fractional value gives smooth motion at no extra cost.
                const dispR = displayRowFor ? displayRowFor(r, c) : r;
                if (bomb && this.rowBlastPools.has(bomb)) {
                    this.placeRowBlast(c, dispR, totalRows, bomb, centerCol);
                } else if (v) {
                    const isWreckerProp = wreckersGrid && wreckersGrid[r] && wreckersGrid[r][c];
                    const isRocketProp  = rocketsGrid  && rocketsGrid[r]  && rocketsGrid[r][c];
                    const hp            = stonesGrid   && stonesGrid[r]   ? stonesGrid[r][c] : null;
                    const isHailProp    = hailsGrid    && hailsGrid[r]    && hailsGrid[r][c];
                    const isMeteorProp  = meteorsGrid  && meteorsGrid[r]  && meteorsGrid[r][c];
                    const isGatlingProp = gatlingsGrid && gatlingsGrid[r] && gatlingsGrid[r][c];
                    const boomLvl       = boomsGrid    && boomsGrid[r]    ? boomsGrid[r][c] : null;
                    if (isHailProp && this.hailCubePool.nodes.length > 0) {
                        this.placeHailCube(c, dispR, totalRows, centerCol);
                    } else if (isMeteorProp && this.meteorCubePool.nodes.length > 0) {
                        this.placeMeteorCube(c, dispR, totalRows, centerCol);
                    } else if (isGatlingProp && this.gatlingCubePool.nodes.length > 0) {
                        this.placeGatlingCube(c, dispR, totalRows, centerCol);
                    } else if (boomLvl && this.boomCubePools[boomLvl - 1].nodes.length > 0) {
                        this.placeBoomCube(c, dispR, totalRows, boomLvl as BoomLevel, centerCol);
                    } else if (isWreckerProp && this.wreckerPool.nodes.length > 0) {
                        this.placeWrecker(c, dispR, totalRows, centerCol);
                    } else if (isRocketProp && this.rocketCubePool.nodes.length > 0) {
                        this.placeRocketCube(c, dispR, totalRows, centerCol);
                    } else if (isRocketProp && this.rocketPropPool.length > 0) {
                        this.placeRocketProp(c, dispR, totalRows);
                    } else if (hp !== null && hp !== undefined && hp > 0 && this.stonePools.length > 0) {
                        this.placeStone(c, dispR, totalRows, 4 - hp);
                    } else {
                        this.placeCube(c, dispR, totalRows, v, centerCol);
                    }
                }
            }
        }

        // ---- active piece ----
        if (current) {
            const pieceBombs    = current.bombs;
            const pieceBooms    = current.booms;
            const pieceWreckers = current.wreckers;
            for (let pr = 0; pr < current.shape.length; pr++) {
                for (let pc = 0; pc < current.shape[pr].length; pc++) {
                    if (!current.shape[pr][pc]) continue;
                    const col = ((current.x + pc) % COLS + COLS) % COLS;
                    // pieceYOffset is a sub-row fractional advance so
                    // meteor DOTs slide smoothly between grid steps.
                    // Regular pieces pass 0 and stay stepped.
                    const row = current.y + pr + pieceYOffset;
                    // Bounds check uses the LOGICAL integer row so a
                    // half-visible fractional bottom cell still renders.
                    // Negative rows are ALLOWED — the endless-mode fixed
                    // camera can place a fresh piece at `piece.y < 0`
                    // (above the board's row 0) to keep the spawn at
                    // the same on-screen position as the board grows.
                    // `placeCube` derives world Y directly from `row`
                    // via the local-Y formula and never indexes the
                    // board array, so negative rows are safe here.
                    if (Math.floor(row) >= totalRows) continue;
                    const bomb    = pieceBombs && pieceBombs[pr] ? pieceBombs[pr][pc] : null;
                    const boomLvl = pieceBooms && pieceBooms[pr] ? pieceBooms[pr][pc] : null;
                    const wrecker = pieceWreckers && pieceWreckers[pr] ? pieceWreckers[pr][pc] : null;
                    if (bomb && this.rowBlastPools.has(bomb)) {
                        this.placeRowBlast(col, row, totalRows, bomb, centerCol);
                    } else if (boomLvl && this.boomCubePools[boomLvl - 1].nodes.length > 0) {
                        this.placeBoomCube(col, row, totalRows, boomLvl as BoomLevel, centerCol);
                    } else if (wrecker && this.wreckerPool.nodes.length > 0) {
                        // Piece-embed wrecker — reuse the level-prop visual.
                        this.placeWrecker(col, row, totalRows, centerCol);
                    } else {
                        this.placeCube(col, row, totalRows, current.type as CellValue, centerCol);
                    }
                }
            }
        }

        // ---- ghost piece (hard-drop preview) ----
        // Renders translucent copies of the piece at the ghost row so
        // players can see where a hard-drop would land. Skip when the
        // piece is already grounded (ghostY === current.y).
        if (current && ghostY !== null && ghostY !== current.y
            && this.ghostPool.length > 0) {
            for (let pr = 0; pr < current.shape.length; pr++) {
                for (let pc = 0; pc < current.shape[pr].length; pc++) {
                    if (!current.shape[pr][pc]) continue;
                    const col = ((current.x + pc) % COLS + COLS) % COLS;
                    const row = ghostY + pr;
                    if (row < 0 || row >= totalRows) continue;
                    this.placeGhostCube(col, row, totalRows, current.type as CellValue, centerCol);
                }
            }
        }

        // ---- hide tails ----
        for (let i = this.ghostPoolCursor; i < this.ghostPool.length; i++) {
            if (this.ghostPool[i].active) this.ghostPool[i].active = false;
        }
        for (let i = this.poolCursor; i < this.pool.length; i++) {
            if (this.pool[i].active) this.pool[i].active = false;
        }
        for (const sp of this.stonePools) {
            for (let i = sp.cursor; i < sp.nodes.length; i++) {
                if (sp.nodes[i].active) sp.nodes[i].active = false;
            }
        }
        for (let i = this.rocketPropCursor; i < this.rocketPropPool.length; i++) {
            if (this.rocketPropPool[i].active) this.rocketPropPool[i].active = false;
        }
        hideTail(this.wreckerPool);
        hideTail(this.rocketCubePool);
        hideTail(this.hailCubePool);
        hideTail(this.meteorCubePool);
        hideTail(this.gatlingCubePool);
        for (const p of this.boomCubePools) hideTail(p);
        for (const pool of this.rowBlastPools.values()) {
            for (let i = pool.cursor; i < pool.nodes.length; i++) {
                if (pool.nodes[i].active) pool.nodes[i].active = false;
            }
        }
    }

    /** Per-frame: advance the rocket-prop spin phase and tick each
     *  active prop's child sparkles. Call from `GameController.update`. */
    public stepRocketPropFX(dt: number): void {
        if (this.rocketPropPool.length === 0) return;

        this.rocketPropSpinPhase = (this.rocketPropSpinPhase + dt * this.rocketPropSpinSpeed) % 360;

        for (let i = 0; i < this.rocketPropPool.length; i++) {
            const propNode = this.rocketPropPool[i];
            const stars    = this.rocketPropSparkles[i];
            if (!stars) continue;
            if (!propNode.active) {
                for (const s of stars) {
                    if (s.node.active) s.node.active = false;
                }
                continue;
            }
            const parentScale = propNode.scale.x || 1;
            const k = 1 / parentScale;
            for (const s of stars) {
                s.ttl -= dt;
                if (s.ttl <= 0) {
                    this.respawnRocketPropStar(s, propNode);
                    continue;
                }
                const t     = 1 - s.ttl / s.lifetime;
                const popK  = t < 0.25 ? (t / 0.25) : 1.0;
                const sizeK = Math.max(0.05, popK * (1 - Math.max(0, (t - 0.25) / 0.75)));
                const base  = this.rocketPropStarSize * k;
                s.node.setScale(base * sizeK, base * sizeK, base * sizeK);
            }
        }
    }

    // ============================================================
    //  Build methods
    // ============================================================

    private buildBrickPool(): void {
        const POOL_SIZE = COLS * 32;
        for (let i = 0; i < POOL_SIZE; i++) {
            const n = instantiate(this.cubePrefab!);
            n.parent = this.boardRoot3D!;
            n.active = false;
            const s = n.scale;
            n.setScale(s.x * CUBE_VISUAL, s.y * CUBE_VISUAL, s.z * CUBE_VISUAL);
            const mr = n.getComponent(MeshRenderer) ?? n.getComponentInChildren(MeshRenderer);
            this.pool.push(n);
            this.poolMeshes.push(mr!);
            const sc = n.scale;
            this.poolBaseScale.push(new Vec3(sc.x, sc.y, sc.z));
        }
    }

    /** Ghost-piece pool — clones the brick prefab but gives each node
     *  its own material instance so we can tint it (per-cell colour,
     *  low alpha) without touching the shared brick material. Pool is
     *  small: a piece has ≤ 4 cells (max 5 for custom fate shapes). */
    private buildGhostPool(): void {
        const POOL_SIZE = 8;
        for (let i = 0; i < POOL_SIZE; i++) {
            const n = instantiate(this.cubePrefab!);
            n.parent = this.boardRoot3D!;
            n.active = false;
            const s = n.scale;
            n.setScale(s.x * CUBE_VISUAL, s.y * CUBE_VISUAL, s.z * CUBE_VISUAL);
            const mr = n.getComponent(MeshRenderer) ?? n.getComponentInChildren(MeshRenderer);
            if (mr) {
                // Own material — swap in a translucent builtin-standard
                // so mainColor.a can dial ghost visibility per frame
                // without touching the shared brick pool's material.
                const mat = new Material();
                mat.initialize({ effectName: 'builtin-standard', technique: 1 });
                mat.setProperty('mainColor', new Color(255, 255, 255, 90));
                mat.setProperty('roughness', 0.6);
                mat.setProperty('metallic', 0.0);
                mr.material = mat;
            }
            this.ghostPool.push(n);
            this.ghostPoolMeshes.push(mr!);
            const sc = n.scale;
            this.ghostPoolBaseScale.push(new Vec3(sc.x, sc.y, sc.z));
        }
    }

    private buildRowBlastPool(): void {
        const SIZE = 16;
        // row4 / col4 are tier-4 bombs reachable only via the bomb × boom
        // adjacency amplification (tier + level, cap 4). They reuse the
        // row3 / col3 prefabs visually — a dedicated tier-4 model isn't
        // built yet, and the row3/col3 look reads as "biggest blast" well
        // enough to communicate the cell carries a heavy charge.
        const kinds: Array<[string, Prefab | null]> = [
            ['row1', this.rowBlastPrefab],
            ['row2', this.rowBlastPrefabRow2],
            ['row3', this.rowBlastPrefabRow3],
            ['row4', this.rowBlastPrefabRow3],
            ['col1', this.rowBlastPrefabCol1],
            ['col2', this.rowBlastPrefabCol2],
            ['col3', this.rowBlastPrefabCol3],
            ['col4', this.rowBlastPrefabCol3],
        ];
        for (const [kind, prefab] of kinds) {
            if (!prefab) continue;
            const nodes: Node[] = [];
            const baseScales: Vec3[] = [];
            const baseRots: Quat[] = [];
            for (let i = 0; i < SIZE; i++) {
                const n = instantiate(prefab);
                n.parent = this.boardRoot3D!;
                n.active = false;
                const sc = n.scale;
                nodes.push(n);
                baseScales.push(new Vec3(sc.x, sc.y, sc.z));
                const q = new Quat();
                Quat.copy(q, n.rotation);
                baseRots.push(q);
            }
            this.rowBlastPools.set(kind, { nodes, baseScales, baseRots, cursor: 0 });
        }
    }

    private buildStonePools(): void {
        if (this.stonePrefabs.length === 0) return;
        const POOL_SIZE_PER_LEVEL = 32;
        for (let lvl = 0; lvl < this.stonePrefabs.length; lvl++) {
            const prefab = this.stonePrefabs[lvl];
            if (!prefab) {
                this.stonePools.push({ nodes: [], baseScales: [], cursor: 0 });
                continue;
            }
            const pool: { nodes: Node[]; baseScales: Vec3[]; cursor: number } = {
                nodes: [], baseScales: [], cursor: 0,
            };
            for (let i = 0; i < POOL_SIZE_PER_LEVEL; i++) {
                const n = instantiate(prefab);
                n.parent = this.boardRoot3D!;
                n.active = false;
                const s = n.scale;
                n.setScale(s.x * CUBE_VISUAL, s.y * CUBE_VISUAL, s.z * CUBE_VISUAL);
                pool.nodes.push(n);
                const sc = n.scale;
                pool.baseScales.push(new Vec3(sc.x, sc.y, sc.z));
            }
            this.stonePools.push(pool);
        }
    }

    private buildWreckerPool(): void {
        if (!this.wreckerPrefab) return;
        this.populateCubePool(this.wreckerPool, this.wreckerPrefab, 16);
    }
    private buildRocketCubePool(): void {
        if (!this.rocketCubePrefab) return;
        this.populateCubePool(this.rocketCubePool, this.rocketCubePrefab, 16);
    }
    private buildHailCubePool(): void {
        if (!this.hailCubePrefab) return;
        this.populateCubePool(this.hailCubePool, this.hailCubePrefab, 16);
    }
    private buildMeteorCubePool(): void {
        if (!this.meteorCubePrefab) return;
        this.populateCubePool(this.meteorCubePool, this.meteorCubePrefab, 16);
    }
    private buildGatlingCubePool(): void {
        if (!this.gatlingCubePrefab) return;
        this.populateCubePool(this.gatlingCubePool, this.gatlingCubePrefab, 16);
    }
    private buildBoomCubePools(): void {
        const POOL_SIZE = 8;
        for (let lvl = 1; lvl <= 3; lvl++) {
            const prefab = this.boomCubePrefabs && this.boomCubePrefabs[lvl - 1];
            if (!prefab) continue;
            this.populateCubePool(this.boomCubePools[lvl - 1], prefab, POOL_SIZE);
        }
    }

    /** Shared CubePool factory body — instantiate N copies of `prefab`,
     *  capture authored scale + rotation, hide. */
    private populateCubePool(
        pool: { nodes: Node[]; baseScales: Vec3[]; baseRots: Quat[]; cursor: number },
        prefab: Prefab,
        size: number,
    ): void {
        for (let i = 0; i < size; i++) {
            const n = instantiate(prefab);
            n.parent = this.boardRoot3D!;
            n.active = false;
            const s = n.scale;
            n.setScale(s.x * CUBE_VISUAL, s.y * CUBE_VISUAL, s.z * CUBE_VISUAL);
            pool.nodes.push(n);
            const sc = n.scale;
            pool.baseScales.push(new Vec3(sc.x, sc.y, sc.z));
            const r = n.rotation;
            pool.baseRots.push(new Quat(r.x, r.y, r.z, r.w));
        }
    }

    private buildRocketPropPool(): void {
        if (!this.rocketPrefab) return;
        const POOL_SIZE = 16;
        // Shared sparkle mesh + material across every star (one tint to all).
        const sparkleMesh = utils.MeshUtils.createMesh(primitives.box({
            width: 1, height: 1, length: 1,
        }));
        const sparkleMat = new Material();
        sparkleMat.initialize({ effectName: 'builtin-unlit', technique: 1 });
        sparkleMat.setProperty('mainColor', this.rocketPropStarColor);

        for (let i = 0; i < POOL_SIZE; i++) {
            const n = instantiate(this.rocketPrefab);
            n.parent = this.boardRoot3D!;
            n.active = false;
            const s = n.scale;
            n.setScale(s.x * CUBE_VISUAL, s.y * CUBE_VISUAL, s.z * CUBE_VISUAL);
            this.rocketPropPool.push(n);

            const stars: Array<{ node: Node; lifetime: number; ttl: number }> = [];
            for (let k = 0; k < this.rocketPropStarCount; k++) {
                const sn = new Node(`Sparkle_${k}`);
                sn.parent = n;
                sn.layer  = n.layer;
                sn.active = false;
                const smr = sn.addComponent(MeshRenderer);
                smr.mesh = sparkleMesh;
                smr.material = sparkleMat;
                const slot = { node: sn, lifetime: 0, ttl: 0 };
                this.respawnRocketPropStar(slot, n);
                stars.push(slot);
            }
            this.rocketPropSparkles.push(stars);
        }
    }

    private respawnRocketPropStar(
        s: { node: Node; lifetime: number; ttl: number },
        parent: Node,
    ): void {
        s.lifetime = this.rocketPropStarLifetimeMin
                   + Math.random() * (this.rocketPropStarLifetimeMax - this.rocketPropStarLifetimeMin);
        s.ttl = s.lifetime;

        const parentScale = parent.scale.x || 1;
        const k = 1 / parentScale;
        const az = Math.random() * Math.PI * 2;
        const el = (Math.random() - 0.3) * Math.PI;
        const r  = this.rocketPropStarRadius * (0.85 + Math.random() * 0.3) * k;
        const cx = Math.cos(el) * Math.sin(az) * r;
        const cy = Math.sin(el)              * r;
        const cz = Math.cos(el) * Math.cos(az) * r;
        s.node.setPosition(cx, cy, cz);
        s.node.setRotationFromEuler(
            Math.random() * 360,
            Math.random() * 360,
            Math.random() * 360,
        );
        const size = this.rocketPropStarSize * k * (0.6 + Math.random() * 0.8);
        s.node.setScale(size, size, size);
        if (!s.node.active) s.node.active = true;
    }

    // ============================================================
    //  Place methods — one per cell renderer
    // ============================================================

    /** Place one translucent ghost cube at (col, row) tinted by `color`.
     *  Uses the private ghostPool + its own material instances so we
     *  can freely set alpha per-frame without touching the shared brick
     *  pool. Alpha stays low (~95/255) so ghosts read as "preview". */
    private placeGhostCube(col: number, row: number, totalRows: number, color: CellValue, centerCol: number): void {
        if (this.ghostPoolCursor >= this.ghostPool.length) return;
        const cube = this.ghostPool[this.ghostPoolCursor];
        const mr   = this.ghostPoolMeshes[this.ghostPoolCursor];
        const baseScale = this.ghostPoolBaseScale[this.ghostPoolCursor];
        this.ghostPoolCursor++;

        if (!cube.active) cube.active = true;
        cube.setScale(baseScale.x, baseScale.y, baseScale.z);

        const theta = col * ANGLE_PER_COL;
        const x = RADIUS * Math.sin(theta);
        const z = RADIUS * Math.cos(theta);
        const y = Y_BOTTOM + ((totalRows - 1) - row) * CELL_SIZE;
        cube.setPosition(x, y, z);
        cube.setRotationFromEuler(90, math.toDegree(theta) + 180, 0);

        if (mr) {
            const mat = mr.material;
            if (mat) {
                const base = hexToColor(COLORS[color as keyof typeof COLORS] ?? '#ffffff');
                // Dim by front-facing angle so back-side ghosts don't
                // scream through the tower — matches the brick tint
                // logic but at low alpha.
                const relAngle = (col - centerCol) * ANGLE_PER_COL;
                const frontness = (Math.cos(relAngle) + 1) / 2;
                const k = BRICK_BACK_DIM + (1 - BRICK_BACK_DIM) * frontness;
                mat.setProperty('mainColor', new Color(
                    Math.floor(base.r * k),
                    Math.floor(base.g * k),
                    Math.floor(base.b * k),
                    95,
                ));
            }
        }
    }

    private placeCube(col: number, row: number, totalRows: number, color: CellValue, centerCol: number): void {
        if (this.poolCursor >= this.pool.length) return;
        const cube = this.pool[this.poolCursor];
        const mr   = this.poolMeshes[this.poolCursor];
        const baseScale = this.poolBaseScale[this.poolCursor];
        this.poolCursor++;

        if (!cube.active) cube.active = true;
        cube.setScale(baseScale.x, baseScale.y, baseScale.z);

        const theta = col * ANGLE_PER_COL;
        const x = RADIUS * Math.sin(theta);
        const z = RADIUS * Math.cos(theta);
        const y = Y_BOTTOM + ((totalRows - 1) - row) * CELL_SIZE;
        cube.setPosition(x, y, z);
        cube.setRotationFromEuler(90, math.toDegree(theta) + 180, 0);

        // Per-cube tint. Two paths, chosen by `disableBrickFogForBatching`:
        //
        //   FAST (default, disableBrickFogForBatching=true):
        //     Each cube gets one of ~9 SHARED per-colour materials
        //     built once by `getSharedBrickMat(color)`. Same colour →
        //     same material instance → Cocos dynamic-batches. Costs
        //     us the front/back fog dimming.
        //
        //   RICH (disableBrickFogForBatching=false):
        //     Each cube has its OWN material instance (Cocos's lazy
        //     `mr.material` copy). We setProperty(mainColor) with a
        //     fog-dimmed value based on the cube's angular offset
        //     from the camera-facing centre column. 1 DC per cube.
        if (mr && this.canTintBricks) {
            const mat = mr.material;
            if (mat) {
                const base = hexToColor(COLORS[color as keyof typeof COLORS] ?? '#ffffff');
                const relAngle = (col - centerCol) * ANGLE_PER_COL;
                const frontness = (Math.cos(relAngle) + 1) / 2;
                const k = BRICK_BACK_DIM + (1 - BRICK_BACK_DIM) * frontness;
                mat.setProperty('mainColor', new Color(
                    Math.floor(base.r * k),
                    Math.floor(base.g * k),
                    Math.floor(base.b * k),
                    255,
                ));
            }
        }
    }

    private placeRowBlast(col: number, row: number, totalRows: number, kind: BombKind, centerCol: number): void {
        const pool = this.rowBlastPools.get(kind);
        if (!pool || pool.cursor >= pool.nodes.length) return;
        const idx       = pool.cursor;
        const n         = pool.nodes[idx];
        const baseScale = pool.baseScales[idx];
        const baseRot   = pool.baseRots[idx];
        pool.cursor++;

        if (!n.active) n.active = true;
        n.setScale(baseScale.x, baseScale.y, baseScale.z);
        this.setColumnTransform(n, col, row, totalRows, baseRot);

        const fx = n.getComponent(RowBlastCubeFX);
        if (fx) fx.setTint(this.frontTint(col, centerCol));

        if (!this.rowBlastLogged) {
            console.log(`[CubeManager] first row-blast cell @ row=${row} col=${col} kind=${kind}`);
            this.rowBlastLogged = true;
        }
    }

    private placeWrecker(col: number, row: number, totalRows: number, centerCol: number): void {
        this.placeOnePool(this.wreckerPool, col, row, totalRows, n => {
            const fx = n.getComponent(WreckerCubeFX);
            if (fx) fx.setTint(this.frontTint(col, centerCol));
        });
    }
    private placeRocketCube(col: number, row: number, totalRows: number, centerCol: number): void {
        this.placeOnePool(this.rocketCubePool, col, row, totalRows, n => {
            const fx = n.getComponent(RocketCubeFX);
            if (fx) fx.setTint(this.frontTint(col, centerCol));
        });
    }
    private placeHailCube(col: number, row: number, totalRows: number, centerCol: number): void {
        this.placeOnePool(this.hailCubePool, col, row, totalRows, n => {
            const fx = n.getComponent(HailCubeFX);
            if (fx) fx.setTint(this.frontTint(col, centerCol));
        });
    }
    private placeMeteorCube(col: number, row: number, totalRows: number, centerCol: number): void {
        this.placeOnePool(this.meteorCubePool, col, row, totalRows, n => {
            const fx = n.getComponent(MeteorCubeFX);
            if (fx) fx.setTint(this.frontTint(col, centerCol));
        });
    }
    private placeGatlingCube(col: number, row: number, totalRows: number, centerCol: number): void {
        this.placeOnePool(this.gatlingCubePool, col, row, totalRows, n => {
            const fx = n.getComponent(GatlingCubeFX);
            if (fx) fx.setTint(this.frontTint(col, centerCol));
        });
    }
    private placeBoomCube(col: number, row: number, totalRows: number, level: BoomLevel, centerCol: number): void {
        const pool = this.boomCubePools[level - 1];
        this.placeOnePool(pool, col, row, totalRows, n => {
            const fx = n.getComponent(BoomCubeFX);
            if (fx) fx.setTint(this.frontTint(col, centerCol));
        });
    }

    /** Generic place-into-pool: position + rotate + tint hook. */
    private placeOnePool(
        pool: { nodes: Node[]; baseScales: Vec3[]; baseRots: Quat[]; cursor: number },
        col: number,
        row: number,
        totalRows: number,
        afterPlace: (n: Node) => void,
    ): void {
        if (pool.cursor >= pool.nodes.length) return;
        const idx       = pool.cursor;
        const n         = pool.nodes[idx];
        const baseScale = pool.baseScales[idx];
        const baseRot   = pool.baseRots[idx];
        pool.cursor++;
        if (!n.active) n.active = true;
        n.setScale(baseScale.x, baseScale.y, baseScale.z);
        this.setColumnTransform(n, col, row, totalRows, baseRot);
        afterPlace(n);
    }

    private placeStone(col: number, row: number, totalRows: number, hpIdx: number): void {
        if (this.stonePools.length === 0) return;
        const idx = Math.min(hpIdx, this.stonePools.length - 1);
        const pool = this.stonePools[idx];
        if (!pool || pool.nodes.length === 0) return;
        if (pool.cursor >= pool.nodes.length) return;

        const node      = pool.nodes[pool.cursor];
        const baseScale = pool.baseScales[pool.cursor];
        pool.cursor++;

        if (!node.active) node.active = true;
        node.setScale(baseScale.x, baseScale.y, baseScale.z);

        const theta = col * ANGLE_PER_COL;
        const x = RADIUS * Math.sin(theta);
        const z = RADIUS * Math.cos(theta);
        const y = Y_BOTTOM + ((totalRows - 1) - row) * CELL_SIZE;
        node.setPosition(x, y, z);
        node.setRotationFromEuler(90, math.toDegree(theta) + 180, 0);
    }

    private placeRocketProp(col: number, row: number, totalRows: number): void {
        if (this.rocketPropCursor >= this.rocketPropPool.length) return;
        const node = this.rocketPropPool[this.rocketPropCursor];
        this.rocketPropCursor++;
        if (!node.active) node.active = true;

        const theta = col * ANGLE_PER_COL;
        const x = RADIUS * Math.sin(theta);
        const z = RADIUS * Math.cos(theta);
        const y = Y_BOTTOM + ((totalRows - 1) - row) * CELL_SIZE;
        node.setPosition(x, y, z);
        node.setRotationFromEuler(
            this.rocketPropTiltDeg,
            math.toDegree(theta) + this.rocketPropSpinPhase,
            0,
        );
    }

    // ============================================================
    //  Small helpers
    // ============================================================

    /** Cylinder column transform: position on the radius circle + yaw
     *  composed after the prefab's authored rotation. */
    private setColumnTransform(n: Node, col: number, row: number, totalRows: number, baseRot: Quat): void {
        const theta = col * ANGLE_PER_COL;
        const x = RADIUS * Math.sin(theta);
        const z = RADIUS * Math.cos(theta);
        const y = Y_BOTTOM + ((totalRows - 1) - row) * CELL_SIZE;
        n.setPosition(x, y, z);
        const yawQ = new Quat();
        Quat.fromEuler(yawQ, 0, math.toDegree(theta), 0);
        const finalQ = new Quat();
        Quat.multiply(finalQ, yawQ, baseRot);
        n.setRotation(finalQ);
    }

    /** Map a column's angular distance from `centerCol` to a [backDim, 1]
     *  tint factor — used for the "front bright, back dim" depth-cue
     *  by every CubeFX prop. */
    private frontTint(col: number, centerCol: number): number {
        const relAngle  = (col - centerCol) * ANGLE_PER_COL;
        const dim       = this.rowBlastBackDim;
        const frontness = (Math.cos(relAngle) + 1) / 2;
        return dim + (1 - dim) * frontness;
    }
}

// ============================================================
//  Module-local helpers (not on the class)
// ============================================================

function newCubePool(): {
    nodes: Node[];
    baseScales: Vec3[];
    baseRots: Quat[];
    cursor: number;
} {
    return { nodes: [], baseScales: [], baseRots: [], cursor: 0 };
}

function hideTail(pool: { nodes: Node[]; cursor: number }): void {
    for (let i = pool.cursor; i < pool.nodes.length; i++) {
        if (pool.nodes[i].active) pool.nodes[i].active = false;
    }
}
