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
    // Outer halo — yellow (unchanged from the classic look).
    { samples: 64, widthMul: 0.65, radialOffset: 0.10, color: new Color(255, 210, 80,  180) },
    // Middle — amber, sits between the yellow halo and the red core.
    { samples: 44, widthMul: 0.42, radialOffset: 0.14, color: new Color(255, 140, 60,  220) },
    // Inner core — RED (per player spec, "光晕还是黄色，里面改成红色").
    { samples: 28, widthMul: 0.22, radialOffset: 0.18, color: new Color(255, 60,  50,  245) },
];
/** Length of the trail expressed as a fraction of the total flight
 *  parameter t. e.g. 0.35 = the ribbon covers 35% of the arc behind
 *  the orb. Combined with the analytical resampling in `_rebuildTrail`
 *  this gives a smooth curved ribbon regardless of frame rate. */
const TRAIL_WINDOW_T = 0.35;

/** Total flight time (start → arrival on cell). Longer than the
 *  single-loop version because the orb now takes an extra full lap
 *  around the tower before settling on the target cell. */
const FLY_DUR_MS   = 1600;
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
const CONVERGE_T   = 0.85;
/** Number of EXTRA full loops around the tower before the orb hits
 *  the target cell. 1 = "once around, then land". */
const EXTRA_LOOPS  = 1;

/** Rainbow palette for the trail sparkle particles — HSV around the
 *  hue wheel at full saturation + full value. Shared instances so we
 *  don't allocate a new Color per particle spawn. */
const PARTICLE_PALETTE: Color[] = [
    new Color(255,  80,  80, 255),   // red
    new Color(255, 165,  50, 255),   // orange
    new Color(255, 235,  70, 255),   // yellow
    new Color(120, 230, 100, 255),   // green
    new Color( 90, 200, 255, 255),   // cyan / sky
    new Color(110, 130, 255, 255),   // blue
    new Color(220, 130, 255, 255),   // violet
];

/** One rainbow sparkle riding along in the trail — see `_spawnParticle`. */
interface Particle {
    node: Node;
    mat:  Material;
    /** Base color at t=0; alpha fades over the particle's lifetime. */
    base: Color;
    velocity: Vec3;
    /** ms lived so far. */
    age:  number;
    /** Total lifetime in ms. */
    life: number;
}
/** Max particles alive concurrently — bounds allocation pressure. */
const MAX_PARTICLES = 60;
/** New particles spawned per frame while the orb is in flight. */
const PARTICLES_PER_FRAME = 2;
/** Per-particle lifetime — long enough to trail visibly behind the orb. */
const PARTICLE_LIFE_MS = 550;
/** Base scale of each particle sphere (relative to cell size). */
const PARTICLE_SIZE = 0.14;

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
    /** Current flight parameter (0..1). Advanced each frame while
     *  `_arrived` is false; the trail resamples the analytical
     *  `_samplePath` between `_currentT - TRAIL_WINDOW_T` and
     *  `_currentT` every frame so the ribbon is smooth regardless of
     *  frame rate (no visible segment corners). */
    private _currentT: number = 0;
    /** Rainbow sparkle particles trailing behind the orb. Alive
     *  particles get ticked in `update` (age + fade + drift), dead
     *  ones are removed and their Node destroyed. */
    private _particles: Particle[] = [];
    /** Total angular sweep from θ=0 to landing. Includes any extra
     *  full loops (see `EXTRA_LOOPS`). Cached on `_init` so the path
     *  sampler doesn't recompute it every frame. */
    private _totalTheta: number = 0;
    /** Shared unit sphere mesh for the rainbow particles — one build
     *  at init, reused by every particle so we don't recreate the
     *  primitive on every spawn. */
    private _particleMesh: Mesh | null = null;

    private _init(targetLocal: Vec3, onArrive: () => void, onDone: () => void): void {
        this._targetLocal.set(targetLocal);
        this._targetR = Math.max(0.1, Math.sqrt(targetLocal.x * targetLocal.x + targetLocal.z * targetLocal.z));
        this._orbitR  = this._targetR * ORBIT_R_MUL;
        this._targetTheta = Math.atan2(targetLocal.x, targetLocal.z);
        // Total angular sweep = target angle + EXTRA_LOOPS full circles
        // in the same rotational direction. Sign matches the shorter
        // signed atan2 result so the "extra lap" wraps consistently;
        // when targetTheta is exactly 0 (front-facing cell), default
        // to positive so we still see a loop rather than nothing.
        const dir = Math.sign(this._targetTheta) || 1;
        this._totalTheta = this._targetTheta + EXTRA_LOOPS * 2 * Math.PI * dir;
        this._startY = targetLocal.y + 3;
        this._onArrive = onArrive;
        this._onDone   = onDone;
        // Prebuild the particle sphere mesh once; every particle
        // MeshRenderer reuses it.
        this._particleMesh = utils.MeshUtils.createMesh(primitives.sphere(PARTICLE_SIZE, { segments: 8 }));

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
        // from origin. No need to pre-seed a history buffer any more —
        // the trail rebuild resamples the analytical path each frame,
        // so it's smooth from frame 1 regardless.
        const p = this._samplePath(0);
        orb.setPosition(p);

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
        // Angular easing: use a smoothstep-ish curve so the orb has a
        // more constant angular speed during the extra loop and only
        // decelerates at the very end. Pure quadOut with a large total
        // sweep read as "too fast at the start, glacial at the end".
        const ease = tc * tc * (3 - 2 * tc);   // smoothstep
        const theta = this._totalTheta * ease;
        let r: number;
        if (tc < CONVERGE_T) r = this._orbitR;
        else r = this._orbitR + (this._targetR - this._orbitR) * ((tc - CONVERGE_T) / (1 - CONVERGE_T));
        const y = this._startY + (this._targetLocal.y - this._startY) * tc
                + PEAK_H * Math.sin(Math.PI * tc);
        return new Vec3(r * Math.sin(theta), y, r * Math.cos(theta));
    }

    update(dt: number): void {
        const now = Date.now();
        const dtMs = dt * 1000;

        if (!this._arrived) {
            const t = Math.min(1, (now - this._startTime) / FLY_DUR_MS);
            this._currentT = t;
            const p = this._samplePath(t);
            this._orb?.setPosition(p);
            this._rebuildTrail();
            // Spawn a couple of rainbow sparkles at the orb's current
            // position each frame. Cheap: reuses a shared sphere mesh
            // and preallocated palette colors.
            for (let i = 0; i < PARTICLES_PER_FRAME; i++) {
                if (this._particles.length >= MAX_PARTICLES) break;
                this._spawnParticle(p);
            }

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
                // No further work — the destroy above already tore
                // down every particle child.
                return;
            }
        }

        // Tick + fade + prune the rainbow sparkle trail. Runs in BOTH
        // the flight and pulse phases so leftover particles from the
        // final frames still fade out naturally over the pulse.
        this._tickParticles(dtMs);
    }

    /** Spawn one rainbow sparkle at world-position `at` (in the FX
     *  holder's local space — same space the orb tweens through).
     *  Adds a tiny outward + slightly-downward random velocity so the
     *  particles read as bursting off the orb rather than sticking to
     *  its path. */
    private _spawnParticle(at: Vec3): void {
        if (!this._particleMesh) return;
        const n = new Node('Sparkle');
        n.parent = this.node;
        n.layer  = this.node.layer;
        n.setPosition(at);
        const mr = n.addComponent(MeshRenderer);
        mr.mesh = this._particleMesh;
        const mat = new Material();
        mat.initialize({ effectName: 'builtin-unlit', technique: 1 });
        const base = PARTICLE_PALETTE[Math.floor(Math.random() * PARTICLE_PALETTE.length)];
        mat.setProperty('mainColor', new Color(base.r, base.g, base.b, base.a));
        mr.material = mat;
        // Random-direction velocity — outward from the tower axis
        // with a tiny vertical wobble so the trail spreads a bit.
        const outX = at.x;
        const outZ = at.z;
        const outMag = Math.max(0.001, Math.sqrt(outX * outX + outZ * outZ));
        const vx = (outX / outMag) * (0.5 + Math.random() * 0.4) + (Math.random() - 0.5) * 0.4;
        const vz = (outZ / outMag) * (0.5 + Math.random() * 0.4) + (Math.random() - 0.5) * 0.4;
        const vy = (Math.random() - 0.3) * 0.7;
        this._particles.push({
            node: n,
            mat,
            base,
            velocity: new Vec3(vx, vy, vz),
            age:  0,
            life: PARTICLE_LIFE_MS * (0.7 + Math.random() * 0.6),
        });
    }

    /** Age every particle by `dtMs`; move by velocity; fade alpha;
     *  destroy expired ones. */
    private _tickParticles(dtMs: number): void {
        const tmp = new Vec3();
        for (let i = this._particles.length - 1; i >= 0; i--) {
            const p = this._particles[i];
            p.age += dtMs;
            if (p.age >= p.life || !p.node.isValid) {
                if (p.node.isValid) p.node.destroy();
                this._particles.splice(i, 1);
                continue;
            }
            // Position: previous + velocity * dt (seconds).
            const dtSec = dtMs / 1000;
            p.node.getPosition(tmp);
            tmp.x += p.velocity.x * dtSec;
            tmp.y += p.velocity.y * dtSec;
            tmp.z += p.velocity.z * dtSec;
            p.node.setPosition(tmp);
            // Slight scale down + alpha fade over lifetime.
            const lifeT = p.age / p.life;
            const scale = PARTICLE_SIZE * (1 - 0.5 * lifeT);
            p.node.setScale(scale / PARTICLE_SIZE, scale / PARTICLE_SIZE, scale / PARTICLE_SIZE);
            const alpha = Math.floor(p.base.a * (1 - lifeT));
            p.mat.setProperty('mainColor', new Color(p.base.r, p.base.g, p.base.b, alpha));
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
        // Resample the analytical path each frame from
        // `tail..currentT` at HIGH density so the ribbon reads as a
        // smooth curve — no visible corners between per-frame
        // history samples like the RocketTrailFX approach has.
        const tHead = this._currentT;
        const tTail = Math.max(0, tHead - TRAIL_WINDOW_T);
        if (tHead <= tTail) return;   // t=0 case, nothing to draw yet

        const tmpB = new Vec3();
        const tmpQ = new Vec3();
        for (let li = 0; li < TRAIL_LAYERS.length; li++) {
            const layer = TRAIL_LAYERS[li];
            const node  = this._trailNodes[li];
            const mr    = this._trailMRs[li];
            if (!node || !mr) continue;
            const N = layer.samples;
            if (N < 2) continue;
            if (!node.active) node.active = true;

            const positions: number[] = [];
            const indices:   number[] = [];
            const halfWidthBase = UNIT_SIZE * layer.widthMul * 0.5;
            for (let i = 0; i < N; i++) {
                // Even distribution across [tTail..tHead], i=0 oldest.
                const u = i / (N - 1);
                const tt = tTail + (tHead - tTail) * u;
                const p = this._samplePath(tt);
                tmpQ.set(p.x, p.y, p.z);
                // Tangent to the cylinder wall at this sample: theta =
                // atan2(x, z) — width lays along the horizontal tangent.
                const theta = Math.atan2(tmpQ.x, tmpQ.z);
                tmpB.set(Math.cos(theta), 0, -Math.sin(theta));
                const nX = Math.sin(theta);
                const nZ = Math.cos(theta);
                const qx = tmpQ.x + nX * layer.radialOffset;
                const qz = tmpQ.z + nZ * layer.radialOffset;
                // Taper: oldest = 0, newest = 1. Also add a mild
                // easeIn so the width ramps up smoothly rather than
                // linearly (avoids the "flat tail" look).
                const taper = u * u * (3 - 2 * u);
                const halfWidth = halfWidthBase * taper;
                positions.push(
                    qx + tmpB.x * halfWidth,
                    tmpQ.y + tmpB.y * halfWidth,
                    qz + tmpB.z * halfWidth,
                    qx - tmpB.x * halfWidth,
                    tmpQ.y - tmpB.y * halfWidth,
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
        if (this._particleMesh) this._particleMesh.destroy();
        this._particleMesh = null;
        // Particles are child nodes of `this.node`; they get destroyed
        // by Cocos's own tree teardown when the holder dies. Clear the
        // JS-side list so callers see an empty array.
        this._particles.length = 0;
        this._orbMat   = null;
        this._pulseMat = null;
    }
}
