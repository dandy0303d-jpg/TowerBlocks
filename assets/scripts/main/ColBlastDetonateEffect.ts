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
    director,
    Camera,
    Vec3,
} from 'cc';

const { ccclass, property } = _decorator;

/**
 * One-shot "column-blast detonation" visual — vertical sibling of the
 * row-clear rainbow ribbon.  Two RAINBOW STREAKS shoot vertically out
 * of the trigger point — one going UP, one going DOWN — at a single
 * angular position around the cylinder.
 *
 * Features (mirrored from the horizontal RowBlastDetonateEffect):
 *   • `numStripes` rainbow stripes spread horizontally across each
 *     streak's width (red on one side → violet on the other).
 *   • `glowEnabled` overlay: each core segment carries a larger, more
 *     transparent glow halo child that inflates the visual bloom.
 *   • Per-head "crackling breakthrough" burst sparks shoot in the
 *     streak's forward direction at each head as it advances.
 *   • Comet brightness fall-off behind the head.
 *
 * Plus billboarding: every core segment's face yaws each frame to keep
 * its face pointing at the camera, so the streak reads as a clean flat
 * ribbon regardless of which column on the cylinder is being blasted.
 *
 * Spawn:
 *     const fx = new Node('ColBlastFX');
 *     fx.parent = boardRoot3D;
 *     fx.setPosition(0, triggerRowY, 0);
 *     const c = fx.addComponent(ColBlastDetonateEffect);
 *     c.angularDeg = colDeg;
 *     c.trigger();
 */
@ccclass('ColBlastDetonateEffect')
export class ColBlastDetonateEffect extends Component {

    // ---------- Streak geometry ----------

    /** Segments per streak in the sweep direction. 10–18 reads well. */
    @property
    segmentCount: number = 14;

    /** Number of horizontal rainbow stripes across the streak width. */
    @property({ range: [1, 12, 1] })
    numStripes: number = 5;

    /** Horizontal spacing between adjacent stripe centres (world units). */
    @property
    stripeSpacing: number = 0.18;

    /** Height of each segment in world units. 1.0 = one cell tall. */
    @property
    segmentHeight: number = 1.0;

    /** Width of a single stripe (world units). Together with stripeSpacing
     *  these define the streak's total horizontal extent. */
    @property
    stripeWidth: number = 0.20;

    /** Radial thickness of each segment (world units). Keep small so
     *  combined with billboarding the panel reads as a flat ribbon. */
    @property
    thickness: number = 0.05;

    /** Radius from cylinder centre out to where the streak sits. */
    @property
    radius: number = 4.30;

    // ---------- Glow halo ----------

    /** Build a soft GLOW halo copy of each core segment, slightly larger
     *  and more transparent.  Doubles segment count when on. */
    @property
    glowEnabled: boolean = true;

    /** How much larger the glow segment is than its core (multiplier).
     *  0 = same size; 1 = 2× in every axis. */
    @property
    glowSizeExpand: number = 1.5;

    /** Alpha multiplier for glow segments. 0.3 reads as soft outer haze. */
    @property({ range: [0, 1, 0.05] })
    glowAlphaMul: number = 0.35;

    // ---------- Animation ----------

    /** Total seconds for the comet head to travel from trigger origin
     *  to the streak's far end. */
    @property
    duration: number = 0.4;

    /** Fraction of the streak length visible behind the head at any
     *  moment.  0.5 = trailing half visible (rest invisible). */
    @property({ range: [0.05, 1, 0.05] })
    cometLength: number = 0.55;

    /** Brightness fall-off from head to tail. Higher = sharper head. */
    @property
    falloff: number = 1.5;

    /** Peak alpha (0–255) at the comet head. */
    @property({ range: [0, 255, 1] })
    baseAlpha: number = 230;

    /** HSV hue range covered across the stripes. 0.83 = red→violet. */
    @property
    rainbowSpread: number = 0.83;

    /** HSV saturation. */
    @property({ range: [0, 1, 0.05] })
    hueSaturation: number = 0.9;

    // ---------- Bursts ----------

    /** Max number of head-burst sparks alive at any moment. 0 = disabled. */
    @property({ range: [0, 400, 1] })
    burstPoolSize: number = 120;

    /** Particles per second per head. Both heads spawn concurrently. */
    @property
    burstSpawnRate: number = 100;

    /** Edge size of each burst particle (world units). */
    @property
    burstSize: number = 0.10;

    /** Burst lifetime range (seconds). */
    @property
    burstLifetimeMin: number = 0.15;
    @property
    burstLifetimeMax: number = 0.35;

    /** Initial particle speed (world units/sec). */
    @property
    burstSpeed: number = 4.0;

    /** Forward-bias: 1 = burst travels with the head (up for up-streak,
     *  down for down-streak); 0 = pure radial outward. */
    @property({ range: [0, 1, 0.05] })
    burstForwardBias: number = 0.70;

    // ---------- Placement / control ----------

    /** Angular position around the cylinder, in degrees. */
    @property
    angularDeg: number = 0;

    /** Optional camera reference for billboarding. Auto-detected if null. */
    @property(Node)
    cameraNode: Node | null = null;

    /** Auto-play on `onLoad`. Set false for pre-built pool instances. */
    @property
    autoPlay: boolean = true;

    /** Debug-only: replay forever instead of going idle. */
    @property
    loop: boolean = false;

    // ---- Internal state ----

    private elapsed: number = 0;
    private isIdle: boolean = true;
    /** Core + glow segments. `alphaMul = 1` are cores (also get
     *  billboarded each frame); `alphaMul < 1` are glow children
     *  (rotation inherited from core parent automatically). */
    private upSegments:   Array<SegmentEntry> = [];
    private downSegments: Array<SegmentEntry> = [];

    /** Burst particle pool. */
    private burstFree:   Array<{ node: Node; mat: Material }> = [];
    private burstActive: Array<BurstEntry> = [];
    private burstAccum:  number = 0;

    private static _tmpCam = new Vec3();
    private static _tmpSeg = new Vec3();

    onLoad(): void {
        this.buildStreaks();
        this.buildBurstPool();
        // Auto-find a camera for billboarding if not assigned.
        if (!this.cameraNode) {
            const scene = director.getScene();
            if (scene) {
                const cams = scene.getComponentsInChildren(Camera);
                for (const cam of cams) {
                    if (cam.projection === Camera.ProjectionType.PERSPECTIVE) {
                        this.cameraNode = cam.node;
                        break;
                    }
                }
                if (!this.cameraNode && cams.length > 0) {
                    this.cameraNode = cams[0].node;
                }
            }
        }
        if (this.autoPlay) this.trigger();
    }

    public trigger(): void {
        this.elapsed = 0;
        this.isIdle = false;
        if (!this.node.active) this.node.active = true;
    }

    public setAngular(deg: number): void {
        this.angularDeg = deg;
        this.node.setRotationFromEuler(0, deg, 0);
    }

    // ============================================================
    //  Build — streaks + glow + burst pool
    // ============================================================
    private buildStreaks(): void {
        const N = Math.max(2, this.segmentCount | 0);
        const S = Math.max(1, this.numStripes  | 0);
        const stripeCenterOffset = (S - 1) * this.stripeSpacing / 2;
        const mesh: Mesh = utils.MeshUtils.createMesh(primitives.box({
            width: 1, height: 1, length: 1,
        }));

        for (const dir of [+1, -1]) {
            const list = dir > 0 ? this.upSegments : this.downSegments;
            for (let s = 0; s < S; s++) {
                const stripeX = -stripeCenterOffset + s * this.stripeSpacing;
                const hue = (s / Math.max(1, S - 1)) * this.rainbowSpread;

                for (let i = 0; i < N; i++) {
                    const segY = dir * ((i + 0.5) * this.segmentHeight);

                    // -- Core segment --
                    const coreMat = new Material();
                    coreMat.initialize({ effectName: 'builtin-unlit', technique: 1 });
                    coreMat.setProperty('mainColor', new Color(255, 255, 255, 0));
                    const coreNode = new Node(`Streak_${dir > 0 ? 'up' : 'dn'}_s${s}_i${i}`);
                    coreNode.parent = this.node;
                    coreNode.layer  = this.node.layer;
                    const coreMr = coreNode.addComponent(MeshRenderer);
                    coreMr.mesh = mesh;
                    coreMr.material = coreMat;
                    coreNode.setPosition(stripeX, segY, this.radius);
                    coreNode.setScale(this.stripeWidth, this.segmentHeight, this.thickness);
                    list.push({ node: coreNode, mat: coreMat, hue, alphaMul: 1.0 });

                    // -- Glow child (transparent, larger, follows core) --
                    if (this.glowEnabled && this.glowAlphaMul > 0) {
                        const gMat = new Material();
                        gMat.initialize({ effectName: 'builtin-unlit', technique: 1 });
                        gMat.setProperty('mainColor', new Color(255, 255, 255, 0));
                        const gNode = new Node('glow');
                        gNode.parent = coreNode;
                        gNode.layer  = coreNode.layer;
                        const gMr = gNode.addComponent(MeshRenderer);
                        gMr.mesh = mesh;
                        gMr.material = gMat;
                        const grow = 1 + this.glowSizeExpand;
                        gNode.setPosition(0, 0, 0);
                        gNode.setScale(grow, grow, grow);
                        list.push({ node: gNode, mat: gMat, hue, alphaMul: this.glowAlphaMul });
                    }
                }
            }
        }

        this.node.setRotationFromEuler(0, this.angularDeg, 0);
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

    // ============================================================
    //  Update — segments, bursts, billboarding
    // ============================================================
    update(dt: number): void {
        if (this.isIdle) return;
        this.elapsed += dt;
        const t = this.elapsed / this.duration;

        if (t >= 1) {
            if (this.loop) {
                this.elapsed = 0;
                return;
            }
            this.isIdle = true;
            this.node.active = false;
            // Recycle any in-flight bursts.
            for (const p of this.burstActive) {
                p.node.active = false;
                this.burstFree.push({ node: p.node, mat: p.mat });
            }
            this.burstActive.length = 0;
            return;
        }

        const head = t;          // 0..1 origin → streak tip
        const N    = this.segmentCount;
        const S    = this.numStripes;
        const perStripe = N;
        const perStripeWithGlow = this.glowEnabled && this.glowAlphaMul > 0
                                   ? perStripe * 2
                                   : perStripe;

        for (const list of [this.upSegments, this.downSegments]) {
            for (let idx = 0; idx < list.length; idx++) {
                const seg = list[idx];
                // For unified array (core + glow interleaved), pull the
                // logical segment index along the streak — segments are
                // ordered by stripe then by `i`. With glow interleaved
                // (core, glow, core, glow,...), the streak-index is
                // floor((idx within stripe block) / 2).
                const localStripe = Math.floor(idx / perStripeWithGlow);
                const inStripe    = idx - localStripe * perStripeWithGlow;
                const i = this.glowEnabled && this.glowAlphaMul > 0
                          ? Math.floor(inStripe / 2)
                          : inStripe;
                const segPos = (i + 0.5) / N;       // 0..1 origin → tip
                const d = head - segPos;
                let alpha = 0;
                if (d >= 0 && d <= this.cometLength) {
                    const r = d / this.cometLength;
                    const brightness = Math.pow(1 - r, this.falloff);
                    alpha = Math.max(0, Math.min(255,
                        Math.floor(this.baseAlpha * brightness * seg.alphaMul),
                    ));
                }
                const c = ColBlastDetonateEffect.hsvToRgb(
                    seg.hue, this.hueSaturation, 1,
                );
                c.a = alpha;
                seg.mat.setProperty('mainColor', c);
            }
        }

        // ---- Bursts: spawn at the two heads + integrate ----
        this.tickBursts(dt, head);

        // ---- Billboarding: rotate each CORE segment to face camera ----
        if (this.cameraNode) {
            this.cameraNode.getWorldPosition(ColBlastDetonateEffect._tmpCam);
            const cam = ColBlastDetonateEffect._tmpCam;
            const tmp = ColBlastDetonateEffect._tmpSeg;
            for (const list of [this.upSegments, this.downSegments]) {
                for (const seg of list) {
                    if (seg.alphaMul !== 1) continue;        // skip glow (child of core)
                    seg.node.getWorldPosition(tmp);
                    const dx = cam.x - tmp.x;
                    const dz = cam.z - tmp.z;
                    const yawDeg = math.toDegree(Math.atan2(dx, dz));
                    seg.node.setWorldRotationFromEuler(0, yawDeg, 0);
                }
            }
        }
    }

    // ============================================================
    //  Bursts
    // ============================================================
    private tickBursts(dt: number, head: number): void {
        if (this.burstPoolSize <= 0) return;

        // Spawn — both heads emit simultaneously.
        const rate = this.burstSpawnRate * 2;            // 2 heads
        this.burstAccum += dt * rate;
        while (this.burstAccum >= 1) {
            this.burstAccum -= 1;
            if (this.burstFree.length === 0) break;
            // Alternate up vs down for each spawn.
            const direction = (this.burstActive.length & 1) === 0 ? +1 : -1;
            this.spawnBurst(head, direction);
        }

        // Integrate / cull.
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
            const k = 1 - p.age / p.lifetime;
            const alpha = Math.max(0, Math.min(255, Math.floor(255 * k)));
            p.mat.setProperty('mainColor', new Color(p.r, p.g, p.b, alpha));
        }
    }

    private spawnBurst(headT: number, direction: number): void {
        const slot = this.burstFree.pop();
        if (!slot) return;

        // Head position in FX-local coords. Up streak head is at
        // (0, +headT * N * H, radius); down streak at (0, -headT * N * H, radius).
        const headY = direction * headT * this.segmentCount * this.segmentHeight;
        const px = 0 + (Math.random() - 0.5) * 0.1;
        const py = headY + (Math.random() - 0.5) * 0.2;
        const pz = this.radius + (Math.random() - 0.5) * 0.1;

        // Velocity: forward bias along the streak direction, plus
        // radial-outward + lateral spread.
        const fb     = this.burstForwardBias;
        const speed  = this.burstSpeed * (0.7 + Math.random() * 0.6);
        const vy     = direction * fb * speed
                     + (Math.random() - 0.5) * 0.3 * speed;
        // Radial outward (along +Z in local space, before angularDeg yaw).
        const radialOut = (1 - fb) * speed * (0.6 + Math.random() * 0.5);
        const vx     = (Math.random() - 0.5) * 0.6 * speed;   // lateral
        const vz     = radialOut + (Math.random() - 0.5) * 0.2 * speed;

        const col = ColBlastDetonateEffect.hsvToRgb(
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
        slot.mat.setProperty('mainColor', new Color(col.r, col.g, col.b, 255));

        const lifetime = this.burstLifetimeMin
                       + Math.random() * (this.burstLifetimeMax - this.burstLifetimeMin);

        this.burstActive.push({
            node: slot.node, mat: slot.mat,
            px, py, pz, vx, vy, vz,
            age: 0, lifetime,
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

interface SegmentEntry {
    node: Node;
    mat:  Material;
    hue:  number;
    alphaMul: number;   // 1.0 for core (billboarded), <1 for glow child
}

interface BurstEntry {
    node: Node;
    mat:  Material;
    px: number; py: number; pz: number;
    vx: number; vy: number; vz: number;
    age: number;
    lifetime: number;
    r: number; g: number; b: number;
}
