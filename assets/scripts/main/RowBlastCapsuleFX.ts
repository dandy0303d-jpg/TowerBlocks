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

const { ccclass, property } = _decorator;

/**
 * Crackling-lightning aura + sparkle stars for the row-blast capsule prop.
 *
 * Two effects layered together:
 *
 *  1. **Jagged bolts** — each bolt is a polyline of `segmentsPerBolt` short
 *     thin boxes stacked along a random axis through space, with small
 *     perpendicular jitter at each joint so the bolt reads as a zig-zag
 *     not a straight stick.  Bolts respawn at fresh poses every time their
 *     lifetime expires (≤ 0.22 s by default), giving a continuous crackle.
 *
 *  2. **Twinkle stars** — small bright unlit dots that pop in/out at
 *     random points around the capsule, each living 0.04–0.18 s, so the
 *     overall effect reads as electric sparkle on top of the bolts.
 *
 * Both effects auto-correct for the capsule prefab's root scale (Meshy
 * FBX models are usually authored at scale 100), so all `radius` /
 * `boltLength` / `starRadius` inspector values stay in WORLD units.
 *
 * Attach to the root of the row-blast capsule prefab.
 */
@ccclass('RowBlastCapsuleFX')
export class RowBlastCapsuleFX extends Component {

    // ---------- BOLT (jagged lightning) settings ----------

    /** How many lightning streaks crackle at once.  6–8 reads as lively. */
    @property
    boltCount: number = 8;

    /** How many short segments per bolt.  1 = straight stick (boring);
     *  3–5 = readable zig-zag.  More = subtler curve, costs draw calls. */
    @property
    segmentsPerBolt: number = 4;

    /** Perpendicular jitter (world units) at each segment joint — bigger
     *  values make the bolt visibly zig-zag, smaller keeps it close to a
     *  straight line. */
    @property
    jaggedness: number = 0.08;

    /** Shortest streak lifetime in seconds — flicker speed. */
    @property
    boltLifetimeMin: number = 0.07;
    /** Longest streak lifetime in seconds. */
    @property
    boltLifetimeMax: number = 0.22;

    /** Total length of each bolt in world units (sum of all segments). */
    @property
    boltLength: number = 0.55;

    /** Cross-section thickness of each bolt segment. Keep small for thin
     *  electric look. */
    @property
    boltThickness: number = 0.035;

    /** Radial distance (world units) bolts spawn from the capsule's main
     *  axis.  Capsule diameter ~0.5 → `radius` ≈ 0.45 hugs the surface. */
    @property
    radius: number = 0.45;

    /** Half-length (world units) along the capsule's long axis that bolts
     *  can spawn at.  Capsule length ~1 → 0.55 covers body + a small tail. */
    @property
    axisHalfLength: number = 0.55;

    /** Tint applied to every bolt segment.  Default = pale cyan-white. */
    @property
    boltColor: Color = new Color(160, 220, 255, 255);

    // ---------- STAR (sparkle) settings ----------

    /** How many bright twinkle dots pop on/off around the capsule. */
    @property
    starCount: number = 14;

    /** Edge length of each star (world units). */
    @property
    starSize: number = 0.07;

    /** Shortest / longest star lifetime in seconds — affects "snappiness".
     *  Very short = strobing sparkle; longer = floating dots. */
    @property
    starLifetimeMin: number = 0.05;
    @property
    starLifetimeMax: number = 0.18;

    /** Star spawn radius (world units) from the capsule axis. */
    @property
    starRadius: number = 0.50;

    /** Star tint — defaults to pure bright white for max sparkle pop. */
    @property
    starColor: Color = new Color(255, 255, 255, 255);

    // ---------- Layout / orientation ----------

    /** Translate the entire bolt + star field by this much in local space. */
    @property
    centerOffset: Vec3 = new Vec3(0, 0, 0);

    /** Which axis the cylindrical shell of bolts/stars wraps around:
     *    0 = X, 1 = Y, 2 = Z. */
    @property({ range: [0, 2, 1] })
    mainAxis: number = 0;

    // ---------- Internal state ----------

    private bolts: Array<{
        /** Root node carrying the bolt's pose; segments are its children. */
        root: Node;
        segments: Node[];
        lifetime: number;
        ttl: number;
    }> = [];

    private stars: Array<{
        node: Node;
        lifetime: number;
        ttl: number;
    }> = [];

    /** Reciprocal of the parent's effective world scale. Meshy-exported
     *  prefab roots are usually authored at scale 100 (FBX cm units), so
     *  any local coords on children get multiplied by 100 in world space.
     *  We divide our user-facing world-unit params by this factor before
     *  writing them as local coords. */
    private scaleK = 1;

    onLoad(): void {
        const ws = new Vec3();
        this.node.getWorldScale(ws);
        this.scaleK = 1 / Math.max(ws.x, 1e-6);
        this.buildBolts();
        this.buildStars();
    }

    // ============================================================
    //  BOLT (jagged lightning) construction & lifecycle
    // ============================================================
    private buildBolts(): void {
        const segMesh: Mesh = utils.MeshUtils.createMesh(primitives.box({
            width: 1, height: 1, length: 1,
        }));
        const mat = new Material();
        mat.initialize({ effectName: 'builtin-unlit', technique: 1 });
        mat.setProperty('mainColor', this.boltColor);

        const N = Math.max(1, this.segmentsPerBolt | 0);

        for (let i = 0; i < this.boltCount; i++) {
            const root = new Node(`Bolt_${i}`);
            root.parent = this.node;
            root.layer  = this.node.layer;

            const segments: Node[] = [];
            for (let s = 0; s < N; s++) {
                const seg = new Node(`Seg_${s}`);
                seg.parent = root;
                seg.layer  = root.layer;
                const mr = seg.addComponent(MeshRenderer);
                mr.mesh = segMesh;
                mr.material = mat;
                segments.push(seg);
            }

            const slot = { root, segments, lifetime: 0, ttl: 0 };
            this.respawnBolt(slot);
            this.bolts.push(slot);
        }
    }

    private respawnBolt(b: {
        root: Node; segments: Node[]; lifetime: number; ttl: number;
    }): void {
        b.lifetime = this.boltLifetimeMin
                   + Math.random() * (this.boltLifetimeMax - this.boltLifetimeMin);
        b.ttl = b.lifetime;

        const k = this.scaleK;

        // ---- Pose the bolt root around the capsule's cylindrical shell.
        const ang = Math.random() * Math.PI * 2;
        const r   = this.radius * (0.7 + Math.random() * 0.5) * k;
        const a   = (Math.random() - 0.5) * 2 * this.axisHalfLength * k;
        const s   = Math.sin(ang) * r;
        const c   = Math.cos(ang) * r;
        let px: number, py: number, pz: number;
        switch (this.mainAxis | 0) {
            case 1:  px = s; py = a; pz = c; break;
            case 2:  px = s; py = c; pz = a; break;
            default: px = a; py = s; pz = c; break;
        }
        b.root.setPosition(
            px + this.centerOffset.x * k,
            py + this.centerOffset.y * k,
            pz + this.centerOffset.z * k,
        );
        b.root.setRotationFromEuler(
            Math.random() * 360,
            Math.random() * 360,
            Math.random() * 360,
        );

        // ---- Build a jagged polyline along the root's local X axis.
        //  Each segment sits at i*segLen along X, with a small perpendicular
        //  jitter (Y,Z) so consecutive segments read as a zig-zag.
        const N = b.segments.length;
        const segLen    = (this.boltLength * k) / N;
        const thickness =  this.boltThickness * k;
        const jit       =  this.jaggedness    * k;
        const xStart    = -(this.boltLength * k) / 2 + segLen / 2;

        for (let i = 0; i < N; i++) {
            const seg = b.segments[i];
            seg.setPosition(
                xStart + i * segLen,
                (Math.random() - 0.5) * 2 * jit,
                (Math.random() - 0.5) * 2 * jit,
            );
            // Small per-segment rotation so the edges of consecutive
            // segments don't perfectly align — adds extra jagginess.
            seg.setRotationFromEuler(
                (Math.random() - 0.5) * 40,
                (Math.random() - 0.5) * 40,
                (Math.random() - 0.5) * 40,
            );
            seg.setScale(segLen * 1.15, thickness, thickness);
            if (!seg.active) seg.active = true;
        }
        if (!b.root.active) b.root.active = true;
    }

    // ============================================================
    //  STAR (sparkle) construction & lifecycle
    // ============================================================
    private buildStars(): void {
        // Small low-poly sphere reads as a sparkle dot from any angle.
        const starMesh: Mesh = utils.MeshUtils.createMesh(
            primitives.sphere(0.5, { segments: 6 }),
        );
        const mat = new Material();
        mat.initialize({ effectName: 'builtin-unlit', technique: 1 });
        mat.setProperty('mainColor', this.starColor);

        for (let i = 0; i < this.starCount; i++) {
            const n = new Node(`Star_${i}`);
            n.parent = this.node;
            n.layer  = this.node.layer;
            const mr = n.addComponent(MeshRenderer);
            mr.mesh = starMesh;
            mr.material = mat;
            const slot = { node: n, lifetime: 0, ttl: 0 };
            this.respawnStar(slot);
            this.stars.push(slot);
        }
    }

    private respawnStar(s: { node: Node; lifetime: number; ttl: number }): void {
        s.lifetime = this.starLifetimeMin
                   + Math.random() * (this.starLifetimeMax - this.starLifetimeMin);
        s.ttl = s.lifetime;

        const k = this.scaleK;

        // Slightly different distribution from bolts — stars use a wider
        // randomness for visual variety.
        const ang = Math.random() * Math.PI * 2;
        const r   = this.starRadius * (0.4 + Math.random() * 0.8) * k;
        const a   = (Math.random() - 0.5) * 2 * this.axisHalfLength * k;
        const sn  = Math.sin(ang) * r;
        const cs  = Math.cos(ang) * r;
        let px: number, py: number, pz: number;
        switch (this.mainAxis | 0) {
            case 1:  px = sn; py = a; pz = cs; break;
            case 2:  px = sn; py = cs; pz = a; break;
            default: px = a;  py = sn; pz = cs; break;
        }
        s.node.setPosition(
            px + this.centerOffset.x * k,
            py + this.centerOffset.y * k,
            pz + this.centerOffset.z * k,
        );
        const size = this.starSize * k * (0.6 + Math.random() * 0.8);
        s.node.setScale(size, size, size);
        if (!s.node.active) s.node.active = true;
    }

    // ============================================================
    //  Per-frame tick
    // ============================================================
    update(dt: number): void {
        // ---- Bolts: tick + flicker shrink + respawn ----
        for (const b of this.bolts) {
            b.ttl -= dt;
            if (b.ttl <= 0) {
                this.respawnBolt(b);
                continue;
            }
            // Flicker shrink (1 → 0.65 over lifetime) for thickness only,
            // so the bolt visually "thins" as it dies rather than shortens.
            const t  = 1 - b.ttl / b.lifetime;
            const fk = 1 - t * 0.35;
            const k  = this.scaleK;
            const segLen    = (this.boltLength * k) / b.segments.length;
            const thickness =  this.boltThickness * k * fk;
            for (const seg of b.segments) {
                seg.setScale(segLen * 1.15, thickness, thickness);
            }
        }

        // ---- Stars: tick + pop-shrink + respawn ----
        for (const s of this.stars) {
            s.ttl -= dt;
            if (s.ttl <= 0) {
                this.respawnStar(s);
                continue;
            }
            // Twinkle: pop big at start, shrink to nothing — but cap so the
            // very-end frame still has positive size to avoid division weirdness.
            const t = 1 - s.ttl / s.lifetime;
            const popK = t < 0.25 ? (t / 0.25) : 1.0;
            const sizeK = Math.max(0.05, popK * (1 - Math.max(0, (t - 0.25) / 0.75)));
            const base = this.starSize * this.scaleK;
            s.node.setScale(base * sizeK, base * sizeK, base * sizeK);
        }
    }
}
