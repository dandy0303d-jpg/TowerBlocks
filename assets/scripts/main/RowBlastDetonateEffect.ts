import {
    _decorator,
    Component,
    Node,
    MeshRenderer,
    Material,
    Color,
    Mesh,
    math,
    primitives,
    utils,
} from 'cc';

const { ccclass, property } = _decorator;

/**
 * "Rainbow ribbon" row-blast detonation visual.
 *
 *   A ribbon around the cylinder's outside whose VERTICAL extent is
 *   striped with rainbow colours (red on top → violet on bottom),
 *   and whose VISIBLE PORTION sweeps once around the tower at the
 *   level this node is positioned at.
 *
 * Geometry:
 *   • `numStripes` × `segmentCount` short bar segments arranged in
 *     a grid: stripes stacked vertically, each stripe a chain of
 *     segments around the circumference.
 *   • Each stripe has a FIXED hue based on its vertical position
 *     — the rainbow is in Y, not in time.
 *
 * Animation:
 *   • Each frame, every segment's brightness comes from its angular
 *     distance behind the moving comet-head. Segments outside the
 *     `cometLength` arc are invisible; segments inside fade from
 *     full brightness at the head to zero at the tail.
 *
 * Lifecycle:
 *   • Plays once in `duration` seconds, then destroys itself.
 *   • `loop` flag holds it spinning forever — for editor inspection.
 *
 * Spawn pattern (game code or test):
 *     const fx = new Node('RowBlastFX');
 *     fx.parent = boardRoot3D;
 *     fx.setPosition(0, rowY, 0);
 *     fx.addComponent(RowBlastDetonateEffect);
 */
@ccclass('RowBlastDetonateEffect')
export class RowBlastDetonateEffect extends Component {

    // ---------- Geometry ----------

    /** Bars per stripe (around the circumference). 36 = ~10°/segment,
     *  corners visible; 48 = ~7.5°/segment, smooth and cheaper than 72. */
    @property
    segmentCount: number = 48;

    /** Number of PARALLEL ribbons stacked RADIALLY (one closer to the
     *  cylinder, others farther out). All travel in sync at the same Y. */
    @property({ range: [1, 6, 1] })
    ribbonCount: number = 3;

    /** Radial gap between adjacent ribbons (world units). 0.15 ≈ a
     *  finger's width between the two rings. Only used when
     *  `ribbonCount` > 1. */
    @property
    ribbonRadialGap: number = 0.20;

    /** Number of horizontal rainbow stripes stacked vertically inside
     *  EACH ribbon. 5–9 reads as clear distinct bands. */
    @property({ range: [2, 24, 1] })
    numStripes: number = 5;

    /** Innermost ring radius (world units). The cylinder cells sit at
     *  ~3.83; ~4.2–4.5 puts the closest ribbon just outside the wall.
     *  Subsequent ribbons are offset outward by `ribbonRadialGap`. */
    @property
    radius: number = 4.30;

    /** Vertical height of the rainbow ribbon. All `numStripes` colour
     *  bands divide this height equally. */
    @property
    height: number = 0.60;

    /** Radial thickness of each ribbon — keep small so the rings hug
     *  the cylinder. */
    @property
    thickness: number = 0.05;

    // ---------- Animation ----------

    /** Fraction of the full circumference visible at any moment behind
     *  the comet head. 0.3 = ~108° arc. */
    @property({ range: [0.05, 1, 0.05] })
    cometLength: number = 0.35;

    /** Total seconds for the comet to make one full lap. */
    @property
    duration: number = 0.8;

    /** Brightness falloff from head (1) to tail (0). Higher = sharper. */
    @property
    falloff: number = 1.6;

    /** Peak alpha (0–255) at the comet head. Default 153 ≈ 60% opacity. */
    @property({ range: [0, 255, 1] })
    baseAlpha: number = 153;

    /** Extra comet heads on each ribbon (rare — use `ribbonCount` for
     *  the standard "parallel ribbons" look). 1 = classic single comet
     *  per ribbon. */
    @property({ range: [1, 8, 1] })
    headCount: number = 1;

    /** Angular spacing between consecutive heads on the SAME ribbon, in
     *  fractions of a full lap. Used only when `headCount > 1`. */
    @property({ range: [0, 0.5, 0.01] })
    headSpacing: number = 0.18;

    /** Colour saturation passed to HSV → RGB. 1.0 = full neon; 0.6 = soft
     *  pastel. */
    @property({ range: [0, 1, 0.05] })
    hueSaturation: number = 0.9;

    /** HSV hue range covered top → bottom. 0.83 = red→violet (full visible
     *  rainbow). Lower = a tighter colour wedge; higher (>1) cycles past. */
    @property
    rainbowSpread: number = 0.83;

    /** 1 = comet sweeps CCW (head moves toward +X first); -1 = CW. */
    @property
    rotationDirection: number = 1;

    /** Debug — when ON the ribbon REPLAYS instead of going idle. */
    @property
    loop: boolean = false;

    /** When true, the ribbon plays once automatically at `onLoad`. Set
     *  false when GameController pre-builds + manually `trigger()`s the
     *  effect (no spawn hitch — meshes are pre-allocated). */
    @property
    autoPlay: boolean = true;

    // ---------- Glow halo overlay ----------

    /** Build a soft GLOW HALO copy of each ribbon segment, sitting at
     *  the same position but larger + more transparent. Turn off to
     *  drop the segment count in half (perf savings). */
    @property
    glowEnabled: boolean = true;

    /** How much larger the glow segment is than its core, multiplier.
     *  0 = same size (no halo); 1 = 2× height + 2× thickness. */
    @property
    glowSizeExpand: number = 1.5;

    /** Multiplier on alpha for glow segments. 0.3 = 30% as bright as
     *  the core, reads as a soft outer haze. */
    @property({ range: [0, 1, 0.05] })
    glowAlphaMul: number = 0.35;

    // ---------- Head-burst sparks ("crackling breakthrough") ----------

    /** Max number of head-burst particles alive at any moment. Set to 0
     *  to disable the burst sparks entirely. */
    @property({ range: [0, 500, 1] })
    burstPoolSize: number = 200;

    /** Particles spawned per second PER HEAD. */
    @property
    burstSpawnRate: number = 120;

    /** Edge size of each spark particle (world units). */
    @property
    burstSize: number = 0.10;

    /** Particle lifetime range (seconds). Short = strobing sparks; long
     *  = trailing streaks. */
    @property
    burstLifetimeMin: number = 0.15;
    @property
    burstLifetimeMax: number = 0.35;

    /** Initial speed (world units/sec) for spark velocity. */
    @property
    burstSpeed: number = 4.0;

    /** Forward-bias of spark velocity: 1 = mostly along motion direction
     *  ("breaking through"); 0 = mostly radial outward. */
    @property({ range: [0, 1, 0.05] })
    burstForwardBias: number = 0.70;

    // ---------- Internal ----------

    private elapsed: number = 0;
    /** When true, `update` is a no-op (the effect is "parked" waiting
     *  for `trigger()`). Set true on construction so pre-built pool
     *  instances don't start playing immediately. */
    private isIdle: boolean = true;
    private segments: Array<{
        mat: Material;
        hue: number;       // fixed hue for this stripe (0..1)
        posParam: number;  // angular position around the ring (0..1)
        alphaMul: number;  // 1.0 for core, <1 for glow halo copies
        wasVisible: boolean;   // tracks if segment was rendered last frame
    }> = [];

    /** Pool of spark particles — preallocated nodes reused as bursts
     *  spawn and expire. Holds both free and active. */
    private burstFree: Array<{ node: Node; mat: Material }> = [];
    private burstActive: Array<{
        node: Node;
        mat: Material;
        px: number; py: number; pz: number;
        vx: number; vy: number; vz: number;
        age: number;
        lifetime: number;
        r: number; g: number; b: number;
    }> = [];
    /** Fractional spawn accumulator — emits a burst whenever it reaches 1. */
    private burstAccum: number = 0;
    /** Pre-computed head world positions for the current frame. Filled
     *  in `update`, consumed by the burst spawner. */
    private currentHeads: Array<{
        x: number; y: number; z: number;
        ribIdx: number;
        angle: number;       // radians around Y
    }> = [];

    onLoad(): void {
        this.buildRibbon();
        this.buildBurstPool();
        if (this.autoPlay) this.trigger();
    }

    /** (Re)start the effect from frame zero — used by pooled instances.
     *  Activates the host node so segment children render again. */
    public trigger(): void {
        this.elapsed = 0;
        this.isIdle = false;
        if (!this.node.active) this.node.active = true;
    }

    private buildBurstPool(): void {
        if (this.burstPoolSize <= 0) return;
        const mesh: Mesh = utils.MeshUtils.createMesh(primitives.box({
            width: 1, height: 1, length: 1,
        }));
        for (let i = 0; i < this.burstPoolSize; i++) {
            const n = new Node(`Burst_${i}`);
            n.parent = this.node;
            n.layer  = this.node.layer;
            n.active = false;
            const mr = n.addComponent(MeshRenderer);
            mr.mesh = mesh;
            const mat = new Material();
            mat.initialize({ effectName: 'builtin-unlit', technique: 1 });
            mat.setProperty('mainColor', new Color(255, 255, 255, 0));
            mr.material = mat;
            const s = this.burstSize;
            n.setScale(s, s, s);
            this.burstFree.push({ node: n, mat });
        }
    }

    private buildRibbon(): void {
        const N = Math.max(4, this.segmentCount | 0);
        const S = Math.max(2, this.numStripes  | 0);
        const R = Math.max(1, this.ribbonCount | 0);
        const stripeH = this.height / S;

        const mesh: Mesh = utils.MeshUtils.createMesh(primitives.box({
            width: 1, height: 1, length: 1,
        }));

        // Radially-stacked ribbons — each is its own ring at a larger
        // radius than the previous. All share the same vertical stripe
        // layout and sweep in sync.
        for (let rib = 0; rib < R; rib++) {
            const ribRadius = this.radius + rib * (this.thickness + this.ribbonRadialGap);
            // Arc length scales with radius so each ribbon has the same
            // angular segment density.
            const arcLen = (2 * Math.PI * ribRadius / N) * 1.10;

            for (let s = 0; s < S; s++) {
                const stripeY = this.height / 2 - (s + 0.5) * stripeH;
                const hue = (s / Math.max(1, S - 1)) * this.rainbowSpread;

                for (let i = 0; i < N; i++) {
                    const angle = (i / N) * Math.PI * 2;
                    const x = ribRadius * Math.sin(angle);
                    const z = ribRadius * Math.cos(angle);
                    const yawDeg = math.toDegree(angle);

                    // -- Core (bright, normal-sized) --
                    {
                        const mat = new Material();
                        mat.initialize({ effectName: 'builtin-unlit', technique: 1 });
                        mat.setProperty('mainColor', new Color(255, 255, 255, 0));

                        const n = new Node(`Rib_r${rib}_s${s}_i${i}`);
                        n.parent = this.node;
                        n.layer  = this.node.layer;
                        const mr = n.addComponent(MeshRenderer);
                        mr.mesh = mesh;
                        mr.material = mat;
                        n.setPosition(x, stripeY, z);
                        n.setRotationFromEuler(0, yawDeg, 0);
                        n.setScale(arcLen, stripeH, this.thickness);
                        this.segments.push({ mat, hue, posParam: i / N, alphaMul: 1.0, wasVisible: false });
                    }

                    // -- Glow halo (larger, more transparent overlay) --
                    if (this.glowEnabled && this.glowAlphaMul > 0) {
                        const mat = new Material();
                        mat.initialize({ effectName: 'builtin-unlit', technique: 1 });
                        mat.setProperty('mainColor', new Color(255, 255, 255, 0));

                        const n = new Node(`Rib_g_r${rib}_s${s}_i${i}`);
                        n.parent = this.node;
                        n.layer  = this.node.layer;
                        const mr = n.addComponent(MeshRenderer);
                        mr.mesh = mesh;
                        mr.material = mat;
                        n.setPosition(x, stripeY, z);
                        n.setRotationFromEuler(0, yawDeg, 0);
                        // Inflate height + radial thickness, keep arc length
                        // unchanged so glow stays angularly aligned.
                        const grow = 1 + this.glowSizeExpand;
                        n.setScale(arcLen, stripeH * grow, this.thickness * grow);
                        this.segments.push({
                            mat, hue, posParam: i / N,
                            alphaMul: this.glowAlphaMul,
                            wasVisible: false,
                        });
                    }
                }
            }
        }
    }

    update(dt: number): void {
        if (this.isIdle) return;
        this.elapsed += dt;
        const t = this.elapsed / this.duration;

        if (t >= 1) {
            if (this.loop) {
                this.elapsed = 0;
                return;
            }
            // Park the node — DON'T destroy. Pre-built pool instances
            // get re-triggered. Deactivating the parent stops all child
            // meshes from rendering, saving every-frame cost.
            this.isIdle = true;
            this.node.active = false;
            return;
        }

        // Comet head positions: `headCount` heads, each offset behind the
        // previous by `headSpacing` (in lap fractions). With headCount=1
        // there's a single comet on each ribbon.
        const heads: number[] = [];
        const baseHead = ((t * this.rotationDirection) % 1 + 1) % 1;
        const H = Math.max(1, this.headCount | 0);
        for (let h = 0; h < H; h++) {
            heads.push((baseHead - h * this.headSpacing + 1) % 1);
        }

        // Cache the live world positions of every (ribbon × head) pair —
        // burst spawning samples from this array.
        const R = Math.max(1, this.ribbonCount | 0);
        this.currentHeads.length = 0;
        for (let rib = 0; rib < R; rib++) {
            const ribRadius = this.radius + rib * (this.thickness + this.ribbonRadialGap);
            for (let h = 0; h < H; h++) {
                const ang = heads[h] * Math.PI * 2;
                this.currentHeads.push({
                    x: ribRadius * Math.sin(ang),
                    y: 0,
                    z: ribRadius * Math.cos(ang),
                    ribIdx: rib,
                    angle: ang,
                });
            }
        }

        for (const seg of this.segments) {
            // Find the smallest distance from this segment to ANY head
            // (segments belong to the nearest comet trail behind them).
            let minD = Infinity;
            for (const head of heads) {
                let d = head - seg.posParam;
                if (d < 0) d += 1;
                if (d < minD) minD = d;
            }

            // Outside every comet body? Hide.
            if (minD > this.cometLength) {
                // Skip the setProperty entirely if we were already invisible
                // — this is the big perf win, since ~65% of segments at any
                // moment are outside the comet trail.
                if (seg.wasVisible) {
                    seg.mat.setProperty('mainColor', new Color(0, 0, 0, 0));
                    seg.wasVisible = false;
                }
                continue;
            }

            const r = minD / this.cometLength;                      // 0..1 head→tail
            const brightness = Math.pow(1 - r, this.falloff);
            const alpha = Math.max(0, Math.min(255,
                Math.floor(this.baseAlpha * brightness * seg.alphaMul),
            ));
            const c = RowBlastDetonateEffect.hsvToRgb(seg.hue, this.hueSaturation, 1);
            c.a = alpha;
            seg.mat.setProperty('mainColor', c);
            seg.wasVisible = true;
        }

        // ---- Head-burst sparks ----
        this.tickBursts(dt);
    }

    // ============================================================
    //  HEAD BURSTS — "breaking through" crackle sparks at the front
    // ============================================================
    private tickBursts(dt: number): void {
        if (this.burstPoolSize <= 0) return;

        // Spawn new sparks based on rate × time × #heads.
        const headsAlive = this.currentHeads.length;
        if (headsAlive > 0) {
            this.burstAccum += dt * this.burstSpawnRate * headsAlive;
            while (this.burstAccum >= 1) {
                this.burstAccum -= 1;
                if (this.burstFree.length === 0) break;
                this.spawnBurst();
            }
        }

        // Integrate / age out existing sparks.
        for (let i = this.burstActive.length - 1; i >= 0; i--) {
            const p = this.burstActive[i];
            p.age += dt;
            if (p.age >= p.lifetime) {
                p.node.active = false;
                this.burstFree.push({ node: p.node, mat: p.mat });
                this.burstActive.splice(i, 1);
                continue;
            }
            p.px += p.vx * dt;
            p.py += p.vy * dt;
            p.pz += p.vz * dt;
            p.node.setPosition(p.px, p.py, p.pz);
            // Alpha fade: bright on spawn, falls to 0 at lifetime end.
            const k = 1 - p.age / p.lifetime;
            const alpha = Math.max(0, Math.min(255, Math.floor(255 * k)));
            p.mat.setProperty('mainColor', new Color(p.r, p.g, p.b, alpha));
        }
    }

    private spawnBurst(): void {
        const slot = this.burstFree.pop();
        if (!slot) return;
        // Pick a random head.
        const head = this.currentHeads[
            Math.floor(Math.random() * this.currentHeads.length)
        ];
        if (!head) {
            // Couldn't get a head — return slot to the free list.
            this.burstFree.push(slot);
            return;
        }

        // Outward radial direction at this angle.
        const ox = Math.sin(head.angle);
        const oz = Math.cos(head.angle);
        // Forward tangent (direction of motion). For CCW (rotationDir=+1),
        // tangent at angle θ is (cosθ, 0, -sinθ).
        const tx =  Math.cos(head.angle) * this.rotationDirection;
        const tz = -Math.sin(head.angle) * this.rotationDirection;

        // Velocity = forwardBias * tangent + (1 - forwardBias) * outward,
        // both modulated by some randomness.
        const fb     = this.burstForwardBias;
        const speed  = this.burstSpeed * (0.7 + Math.random() * 0.6);
        const jitter = (Math.random() - 0.5) * 0.5;          // ±0.25 lateral
        const dx     = fb * tx + (1 - fb) * ox + jitter * ox;
        const dz     = fb * tz + (1 - fb) * oz + jitter * oz;
        const vy     = (Math.random() - 0.5) * 0.6 * speed;  // ±vertical
        const vx     = dx * speed;
        const vz     = dz * speed;

        // Slight start-jitter so sparks don't all emit from the same point.
        const startJ = 0.05;
        const px = head.x + (Math.random() - 0.5) * startJ;
        const py = head.y + (Math.random() - 0.5) * startJ;
        const pz = head.z + (Math.random() - 0.5) * startJ;

        // Random rainbow colour for this spark.
        const col = RowBlastDetonateEffect.hsvToRgb(
            Math.random(), 0.9, 1,
        );

        slot.node.setPosition(px, py, pz);
        slot.node.setRotationFromEuler(
            Math.random() * 360,
            Math.random() * 360,
            Math.random() * 360,
        );
        const s = this.burstSize * (0.6 + Math.random() * 0.8);
        slot.node.setScale(s, s, s);
        slot.node.active = true;

        const lifetime = this.burstLifetimeMin
                       + Math.random() * (this.burstLifetimeMax - this.burstLifetimeMin);
        slot.mat.setProperty('mainColor', new Color(col.r, col.g, col.b, 255));

        this.burstActive.push({
            node: slot.node,
            mat: slot.mat,
            px, py, pz, vx, vy, vz,
            age: 0,
            lifetime,
            r: col.r, g: col.g, b: col.b,
        });
    }

    /** Standard HSV → RGB. h, s, v all in [0, 1]. Returns alpha = 255. */
    private static hsvToRgb(h: number, s: number, v: number): Color {
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
}
