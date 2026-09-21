/**
 * EmbedRevealFX3D — the 3D-scene version of the Lvl 16+ embed-picker
 * reveal effect. Spawned by GameController after the tower assembly
 * animation completes.
 *
 * Design (spawn → arrive → glow → dispose):
 *   1. A golden sphere ("orb") tweens along a 3D arc that starts at
 *      the front of the tower (θ=0, radius = towerR × 1.5), spirals
 *      around the outside of the cylinder to the target cell's
 *      angular position, then converges inward to land on the cell.
 *   2. A three-layer triangle-strip trail (outer / mid / core, golden
 *      tints) follows the orb every frame. Same strip-mesh recipe
 *      RocketTrailFX uses, minus the rocket-specific tuning.
 *   3. On arrival, `onArrive` fires (caller commits the prop into
 *      GameState so `syncCubes` next frame paints the overlay).
 *      A pulse cube — an unlit-additive box scaled up + down around
 *      the cell — plays the reveal beat.
 *   4. Everything self-destructs when `onDone` returns.
 *
 * Because the orb + trail + pulse are real 3D nodes parented to
 * `boardRoot3D`, they occlude / are occluded by tower cubes correctly
 * — the trail goes behind the tower when the orb rounds the back side,
 * which is exactly what the "围着塔外围" spec calls for.
 *
 * Static API — GameController calls `EmbedRevealFX3D.spawn(...)` and
 * doesn't hold a reference. Cleanup is internal.
 */

import {
    _decorator,
    Component,
    Node,
    MeshRenderer,
    Material,
    Color,
    Mesh,
    Vec3,
    primitives,
    utils,
} from 'cc';

const { ccclass } = _decorator;

interface TrailLayer {
    samples:  number;
    widthMul: number;
    radialOffset: number;
    color:    Color;
}

const TRAIL_LAYERS: TrailLayer[] = [
    { samples: 14, widthMul: 0.60, radialOffset: 0.10, color: new Color(255, 210, 80,  170) },
    { samples: 10, widthMul: 0.40, radialOffset: 0.14, color: new Color(255, 230, 130, 210) },
    { samples: 6,  widthMul: 0.22, radialOffset: 0.18, color: new Color(255, 250, 210, 250) },
];

/** Total flight time (start → arrival on cell). */
const FLY_DUR_MS   = 900;
/** Pulse expand + shrink duration after arrival. */
const PULSE_DUR_MS = 500;
/** Unit size baseline — 1 = one cell edge. Trail widths scale off this. */
const UNIT_SIZE    = 1.0;
/** How high above the target cell the arc peaks (in cells). */
const PEAK_H       = 2.0;
/** Radius multiplier for the outbound orbit. */
const ORBIT_R_MUL  = 1.5;
/** Fraction of the flight over which the orbit radius contracts from
 *  `orbitR` down to `targetR` (converges into the tower). */
const CONVERGE_T   = 0.8;

@ccclass('EmbedRevealFX3D')
export class EmbedRevealFX3D extends Component {

    /**
     * Spawn a fresh instance under `boardRoot`. `targetLocal` is the
     * cell's boardRoot-local position (use CubeManager.cellToWorldPosition
     * — it returns local coords). `onArrive` fires the frame the orb
     * lands on the cell; `onDone` fires after the pulse finishes.
     */
    public static spawn(
        boardRoot: Node,
        targetLocal: Vec3,
        onArrive: () => void,
        onDone: () => void,
    ): void {
        const holder = new Node('EmbedRevealFX3D');
        holder.parent = boardRoot;
        holder.layer  = boardRoot.layer;
        const c = holder.addComponent(EmbedRevealFX3D);
        c._init(targetLocal, onArrive, onDone);
    }

    // ---- Instance state ----
    private _targetLocal: Vec3 = new Vec3();
    private _targetR: number = 1;
    private _orbitR: number  = 1.5;
    private _targetTheta: number = 0;
    private _startY: number = 0;
    private _startTime: number = 0;
    private _arrived: boolean = false;
    private _arrivedAt: number = 0;
    private _onArrive: (() => void) | null = null;
    private _onDone:   (() => void) | null = null;

    private _orb: Node | null = null;
    private _orbMat: Material | null = null;
    private _pulse: Node | null = null;
    private _pulseMat: Material | null = null;

    private _trailNodes:  Node[] = [];
    private _trailMRs:    MeshRenderer[] = [];
    private _trailMeshes: (Mesh | null)[] = [];
    private _history: Vec3[] = [];

    private _init(targetLocal: Vec3, onArrive: () => void, onDone: () => void): void {
        this._targetLocal.set(targetLocal);
        this._targetR = Math.max(0.1, Math.sqrt(targetLocal.x * targetLocal.x + targetLocal.z * targetLocal.z));
        this._orbitR  = this._targetR * ORBIT_R_MUL;
        this._targetTheta = Math.atan2(targetLocal.x, targetLocal.z);
        this._startY = targetLocal.y + 3;
        this._onArrive = onArrive;
        this._onDone   = onDone;

        // --- Orb node: unlit-additive sphere, golden ---
        const orb = new Node('Orb');
        orb.parent = this.node;
        orb.layer  = this.node.layer;
        const orbMR = orb.addComponent(MeshRenderer);
        orbMR.mesh = utils.MeshUtils.createMesh(primitives.sphere(0.35, { segments: 16 }));
        const orbMat = new Material();
        orbMat.initialize({ effectName: 'builtin-unlit', technique: 1 });
        orbMat.setProperty('mainColor', new Color(255, 245, 180, 255));
        orbMR.material = orbMat;
        this._orb = orb;
        this._orbMat = orbMat;

        // --- Trail: one child node per layer, unlit-additive ---
        for (let i = 0; i < TRAIL_LAYERS.length; i++) {
            const layer = TRAIL_LAYERS[i];
            const n = new Node(`Trail_L${i}`);
            n.parent = this.node;
            n.layer  = this.node.layer;
            n.active = false;
            const mr = n.addComponent(MeshRenderer);
            const mat = new Material();
            mat.initialize({ effectName: 'builtin-unlit', technique: 1 });
            mat.setProperty('mainColor', layer.color);
            mr.material = mat;
            this._trailNodes.push(n);
            this._trailMRs.push(mr);
            this._trailMeshes.push(null);
        }

        // Position orb at spawn (t=0 point) so frame 1 doesn't flash
        // from origin.
        const p = this._samplePath(0);
        orb.setPosition(p);
        // Pre-seed a few history samples so the trail has visible
        // width from the very first frame instead of ramping over
        // ~4 frames.
        for (let k = 3; k >= 1; k--) {
            const q = this._samplePath(-k * 0.02);
            this._history.push(q);
        }

        this._startTime = Date.now();
    }

    /** 3D-space arc sample at parameter `t` ∈ [0..1].
     *  θ sweeps 0 → targetTheta (shortest signed direction).
     *  r stays at orbitR for the first `CONVERGE_T` of the flight,
     *  then contracts to `targetR` in the final segment.
     *  y linearly glides from startY down to targetY, plus a
     *  `sin(π·t)` bump for the arc peak. */
    private _samplePath(t: number): Vec3 {
        // Clamp so pre-seed values (negative t) don't overshoot.
        const tc = Math.max(0, Math.min(1, t));
        const ease = 1 - (1 - tc) * (1 - tc);   // quadOut
        const theta = this._targetTheta * ease;
        let r: number;
        if (tc < CONVERGE_T) r = this._orbitR;
        else r = this._orbitR + (this._targetR - this._orbitR) * ((tc - CONVERGE_T) / (1 - CONVERGE_T));
        const y = this._startY + (this._targetLocal.y - this._startY) * tc
                + PEAK_H * Math.sin(Math.PI * tc);
        return new Vec3(r * Math.sin(theta), y, r * Math.cos(theta));
    }

    update(_dt: number): void {
        const now = Date.now();

        if (!this._arrived) {
            const t = Math.min(1, (now - this._startTime) / FLY_DUR_MS);
            const p = this._samplePath(t);
            this._orb?.setPosition(p);
            this._history.push(p.clone());
            // Cap at longest layer's window so the strip doesn't grow
            // unbounded.
            const cap = TRAIL_LAYERS[0].samples;
            while (this._history.length > cap) this._history.shift();
            this._rebuildTrail();

            if (t >= 1) {
                this._arrived = true;
                this._arrivedAt = now;
                // Impact — commit the prop so `syncCubes` paints the
                // overlay under the pulse.
                try { this._onArrive?.(); } catch (e) { console.warn('[EmbedRevealFX3D] onArrive threw', e); }
                this._onArrive = null;
                // Hide the orb; the pulse takes over.
                if (this._orb && this._orb.isValid) this._orb.active = false;
                // Spawn the pulse cube at the target cell.
                this._spawnPulse();
            }
        } else {
            // Post-arrival: fade the trail out over ~200ms while the
            // pulse plays; then dispose.
            const t = Math.min(1, (now - this._arrivedAt) / PULSE_DUR_MS);
            const trailFadeT = Math.min(1, t / 0.4);   // fully faded by 40% of pulse
            for (let i = 0; i < this._trailMRs.length; i++) {
                const mat = this._trailMRs[i].material;
                if (!mat) continue;
                const base = TRAIL_LAYERS[i].color;
                mat.setProperty('mainColor', new Color(base.r, base.g, base.b, Math.floor(base.a * (1 - trailFadeT))));
            }
            // Pulse cube — scale from 1 → 1.9 → 0 with a sin bump; opacity fades.
            if (this._pulse && this._pulseMat) {
                const s = 1 + 1.2 * Math.sin(Math.PI * Math.min(1, t));
                this._pulse.setScale(s, s, s);
                const alpha = Math.floor(255 * (1 - t));
                this._pulseMat.setProperty('mainColor', new Color(255, 235, 150, alpha));
            }
            if (t >= 1) {
                const done = this._onDone;
                this._onDone = null;
                if (this.node && this.node.isValid) this.node.destroy();
                if (done) done();
            }
        }
    }

    private _spawnPulse(): void {
        const p = new Node('Pulse');
        p.parent = this.node;
        p.layer  = this.node.layer;
        p.setPosition(this._targetLocal);
        const mr = p.addComponent(MeshRenderer);
        // Reuse a box primitive — small cube at cell size, semi-
        // transparent so the underlying cell + newly-committed prop
        // show through the pulse.
        mr.mesh = utils.MeshUtils.createMesh(primitives.box({
            width:  UNIT_SIZE * 1.05,
            height: UNIT_SIZE * 1.05,
            length: UNIT_SIZE * 1.05,
        }));
        const mat = new Material();
        mat.initialize({ effectName: 'builtin-unlit', technique: 1 });
        mat.setProperty('mainColor', new Color(255, 235, 150, 200));
        mr.material = mat;
        this._pulse    = p;
        this._pulseMat = mat;
    }

    private _rebuildTrail(): void {
        const tmpB = new Vec3();
        for (let li = 0; li < TRAIL_LAYERS.length; li++) {
            const layer = TRAIL_LAYERS[li];
            const node  = this._trailNodes[li];
            const mr    = this._trailMRs[li];
            if (!node || !mr) continue;
            const takeFrom = Math.max(0, this._history.length - layer.samples);
            const slice = this._history.slice(takeFrom);
            const N = slice.length;
            if (N < 2) {
                if (node.active) node.active = false;
                continue;
            }
            if (!node.active) node.active = true;

            const positions: number[] = [];
            const indices:   number[] = [];
            const halfWidthBase = UNIT_SIZE * layer.widthMul * 0.5;
            for (let i = 0; i < N; i++) {
                const q = slice[i];
                // Tangent to the cylinder wall at this sample: theta =
                // atan2(x, z) — width lays along the horizontal tangent.
                const theta = Math.atan2(q.x, q.z);
                tmpB.set(Math.cos(theta), 0, -Math.sin(theta));
                const nX = Math.sin(theta);
                const nZ = Math.cos(theta);
                const qx = q.x + nX * layer.radialOffset;
                const qz = q.z + nZ * layer.radialOffset;
                const taper = i / (N - 1);   // 0 oldest → 1 newest
                const halfWidth = halfWidthBase * taper;
                positions.push(
                    qx + tmpB.x * halfWidth,
                    q.y + tmpB.y * halfWidth,
                    qz + tmpB.z * halfWidth,
                    qx - tmpB.x * halfWidth,
                    q.y - tmpB.y * halfWidth,
                    qz - tmpB.z * halfWidth,
                );
            }
            for (let i = 0; i < N - 1; i++) {
                const a = i * 2;
                indices.push(a, a + 2, a + 1);
                indices.push(a + 1, a + 2, a + 3);
            }
            const next: Mesh = utils.MeshUtils.createMesh({ positions, indices });
            mr.mesh = next;
            const prev = this._trailMeshes[li];
            if (prev) prev.destroy();
            this._trailMeshes[li] = next;
        }
    }

    onDestroy(): void {
        for (const m of this._trailMeshes) if (m) m.destroy();
        this._trailMeshes = [];
        this._orbMat   = null;
        this._pulseMat = null;
    }
}
