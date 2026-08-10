import {
    _decorator,
    Component,
    Node,
    Prefab,
    instantiate,
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
 * Row-blast item cube.
 *
 * Reuses the SAME mesh as the regular game brick (by instantiating the
 * brick prefab as the body), so the silhouette is identical to a normal
 * cell — only the material colour changes and a white band sits across
 * the equator to mark it as a row-blast prop.
 *
 * Drop on an empty Node (scale 1, default), then:
 *   1. Drag the regular `Cube.prefab` into the `bodyPrefab` field.
 *   2. (Optional) Tweak `bodyColor`, `bandColor`, `bandThickness`.
 *   3. Save the node into Assets as `RowBlastCube.prefab`.
 *   4. Hook the new prefab up to `GameController.rowBlastPrefab`.
 *
 * If `bodyPrefab` is left blank the component falls back to a procedural
 * box body so the prefab still renders something useful for testing.
 */
@ccclass('RowBlastCubeFX')
export class RowBlastCubeFX extends Component {

    // ---------- Body ----------

    /** Drag the regular `Cube.prefab` here. The component will
     *  instantiate it under this node and override its material to use
     *  `bodyColor`, giving you a cube with the SAME silhouette as the
     *  rest of the bricks. Leave blank for a procedural box fallback. */
    @property(Prefab)
    bodyPrefab: Prefab | null = null;

    /** Tint applied to the body's material (orange #F86316 by default).
     *  Uses `builtin-unlit`, so no per-cube lighting — the colour you
     *  pick is exactly what renders. */
    @property
    bodyColor: Color = new Color(248, 99, 22, 255);

    /** Used only when `bodyPrefab` is null — edge length of the
     *  procedural fallback box (world units). */
    @property
    bodySize: number = 1.0;

    // ---------- Band ----------
    // The band is a slab with three INDEPENDENT dimensions, each given
    // directly in world units. The brick mesh isn't a uniform cube —
    // its radial depth is usually smaller than its width — so split
    // controls let you fit the band cleanly inside the silhouette.

    /** Band X size (across the brick's outward face — i.e. horizontal
     *  along the cylinder's tangent). 0.9 hugs the rounded brick edge. */
    @property
    bandWidth: number = 0.90;

    /** Band Y size (vertical thickness — how tall the stripe is). */
    @property
    bandHeight: number = 0.12;

    /** Band Z size (depth into the brick — perpendicular to its outward
     *  face). Meshy bricks are typically ~0.7 deep, so set ≤ that to
     *  stop the band poking out radially. */
    @property
    bandDepth: number = 0.70;

    /** Band colour. Default = milky white (slightly warm cream). */
    @property
    bandColor: Color = new Color(252, 248, 235, 255);

    /** How many bands to draw (1 / 2 / 3). Row1 + Col1 use 1; row2/col2
     *  use 2; row3/col3 use 3. Bands are spaced evenly around the
     *  cube's centre on the orientation axis. */
    @property({ range: [1, 3, 1] })
    bandCount: number = 1;

    /** Centre-to-centre spacing between adjacent bands (world units),
     *  used when `bandCount > 1`. */
    @property
    bandSpacing: number = 0.25;

    /** Band orientation around the cube face:
     *   0 = HORIZONTAL (row-blast look — bands run along the cylinder
     *       tangent and stack vertically as `bandCount` grows).
     *   1 = VERTICAL (col-blast look — bands stand upright and stack
     *       sideways as `bandCount` grows). */
    @property({ range: [0, 1, 1] })
    bandOrientation: number = 0;

    // ---------- Sparkle stars (twinkle particles around the cube) ----------

    /** Number of twinkle stars hovering around the cube at any one time.
     *  10–16 reads as lively without being noisy. Set 0 to disable. */
    @property
    starCount: number = 12;

    /** Edge length of each star sprite (world units). */
    @property
    starSize: number = 0.05;

    /** Star lifetime range (seconds). Short lifetimes = strobing sparkle,
     *  long = floating dots. */
    @property
    starLifetimeMin: number = 0.05;
    @property
    starLifetimeMax: number = 0.20;

    /** Distance from cube centre where stars spawn (world units). 0.65 ≈
     *  just outside the brick body's outline. */
    @property
    starRadius: number = 0.65;

    /** Star colour — defaults to pure bright white for max sparkle pop. */
    @property
    starColor: Color = new Color(255, 255, 255, 255);


    // ---------- Internal ----------

    private scaleK = 1;

    /** Body MeshRenderer captured at buildBody time — kept so the
     *  outside world (GameController) can call `setTint` to apply
     *  the same back-of-cylinder darkening regular bricks get. */
    private bodyMR: MeshRenderer | null = null;
    /** Band MeshRenderers — all dimmed together with the body via setTint. */
    private bandMRs: MeshRenderer[] = [];

    /** Active sparkle stars. Each respawns at a new random pose every
     *  time its lifetime expires, so the duty cycle is 100% and the
     *  visual reads as continuous twinkling. */
    private stars: Array<{
        node: Node;
        lifetime: number;
        ttl: number;
    }> = [];

    onLoad(): void {
        const ws = new Vec3();
        this.node.getWorldScale(ws);
        this.scaleK = 1 / Math.max(ws.x, 1e-6);
        this.buildBody();
        this.buildBand();
        this.buildSparkles();
    }

    /** Build the cube body. Two paths:
     *   • If `bodyPrefab` is assigned, instantiate it as a child of this
     *     node and override its MeshRenderer's material with a NEW
     *     `builtin-standard` PBR material tinted to `bodyColor`. PBR keeps
     *     the bevel / rounded-corner light-shading of the Meshy mesh
     *     while letting us recolour it.
     *   • Otherwise, fall back to a procedural box mesh sized via
     *     `bodySize` + flat colour. */
    private buildBody(): void {
        if (this.bodyPrefab) {
            const body = instantiate(this.bodyPrefab);
            body.parent = this.node;
            body.layer  = this.node.layer;
            body.setPosition(0, 0, 0);
            // Pre-rotate the brick child to match how regular bricks are
            // placed by `GameController.placeCube`: (X=90, Y=180, 0). The
            // brick's mesh is authored lying on its side, so without the
            // X=90 it'd render flat; Y=180 flips the convex face outward
            // (toward the camera) instead of inward.  This way the row-blast
            // prefab root stays at rotation (0,0,0) and we only need to add
            // a Y yaw at place-time to match cylinder placement.
            body.setRotationFromEuler(90, 180, 0);
            // Inherit the brick prefab's authored scale; the brick prefab
            // itself carries scale 100, which means YOUR ROW-BLAST PREFAB
            // ROOT MUST BE LEFT AT SCALE 1, otherwise the scales multiply
            // and the brick blows up out of view.

            // Override the body material with PBR-standard at the chosen
            // colour. builtin-standard keeps lighting / shading on, so the
            // bevel / rounded details still read; builtin-unlit would
            // flatten them.
            const mr = body.getComponent(MeshRenderer)
                ?? body.getComponentInChildren(MeshRenderer);
            if (mr) {
                const mat = new Material();
                mat.initialize({ effectName: 'builtin-standard' });
                mat.setProperty('mainColor', this.bodyColor);
                // Match the original brick's roughness/metallic so the
                // tinted body has the same plastic-toy feel.
                mat.setProperty('roughness', 0.55);
                mat.setProperty('metallic', 0.05);
                mr.material = mat;
                this.bodyMR = mr;
            }
            return;
        }

        // Fallback: procedural box body (only used if no bodyPrefab assigned).
        const mesh: Mesh = utils.MeshUtils.createMesh(primitives.box({
            width: 1, height: 1, length: 1,
        }));
        const mat = new Material();
        mat.initialize({ effectName: 'builtin-standard' });
        mat.setProperty('mainColor', this.bodyColor);
        mat.setProperty('roughness', 0.55);
        mat.setProperty('metallic', 0.05);

        const n = new Node('Body');
        n.parent = this.node;
        n.layer  = this.node.layer;
        const mr = n.addComponent(MeshRenderer);
        mr.mesh = mesh;
        mr.material = mat;
        const s = this.bodySize * this.scaleK;
        n.setScale(s, s, s);
        this.bodyMR = mr;
    }

    /** Multiplicatively dim/lighten BOTH the body colour and the band
     *  colour by `factor` ∈ [0, 1]. GameController calls this each frame
     *  for the back-of-cylinder darkening, so the whole row-blast prop
     *  (orange body + white band) fades to dim together as it rotates
     *  away from the camera. `factor=1` → original colours; smaller
     *  values dim toward black. */
    public setTint(factor: number): void {
        const f = Math.max(0, Math.min(1, factor));
        // ---- Body (PBR builtin-standard) ----
        if (this.bodyMR) {
            const mat = this.bodyMR.material;
            if (mat) {
                mat.setProperty('mainColor', new Color(
                    Math.floor(this.bodyColor.r * f),
                    Math.floor(this.bodyColor.g * f),
                    Math.floor(this.bodyColor.b * f),
                    255,
                ));
            }
        }
        // ---- Bands (flat unlit) — all bands dim together. ----
        for (const mr of this.bandMRs) {
            const mat = mr.material;
            if (mat) {
                mat.setProperty('mainColor', new Color(
                    Math.floor(this.bandColor.r * f),
                    Math.floor(this.bandColor.g * f),
                    Math.floor(this.bandColor.b * f),
                    Math.round(this.bandColor.a),
                ));
            }
        }
    }

    // ============================================================
    //  SPARKLES — twinkle stars around the prop
    // ============================================================
    private buildSparkles(): void {
        if (this.starCount <= 0) return;
        const mesh: Mesh = utils.MeshUtils.createMesh(primitives.box({
            width: 1, height: 1, length: 1,
        }));
        // Single shared transparent unlit material — one tint, all stars use it.
        const mat = new Material();
        mat.initialize({ effectName: 'builtin-unlit', technique: 1 });
        mat.setProperty('mainColor', this.starColor);

        for (let i = 0; i < this.starCount; i++) {
            const n = new Node(`Sparkle_${i}`);
            n.parent = this.node;
            n.layer  = this.node.layer;
            const mr = n.addComponent(MeshRenderer);
            mr.mesh = mesh;
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
        // Random point on a small sphere shell around the cube — bias
        // toward the front face (positive Z) so the user actually sees
        // the sparkles when the cube is camera-facing.
        const az = Math.random() * Math.PI * 2;             // 0..2π
        const el = (Math.random() - 0.3) * Math.PI;         // skew toward +
        const r  = this.starRadius * (0.85 + Math.random() * 0.3) * k;
        const cx = Math.cos(el) * Math.sin(az) * r;
        const cy = Math.sin(el)              * r;
        const cz = Math.cos(el) * Math.cos(az) * r;
        s.node.setPosition(cx, cy, cz);
        s.node.setRotationFromEuler(
            Math.random() * 360,
            Math.random() * 360,
            Math.random() * 360,
        );
        // Initial scale — `update` will animate this each frame.
        const size = this.starSize * k * (0.6 + Math.random() * 0.8);
        s.node.setScale(size, size, size);
        if (!s.node.active) s.node.active = true;
    }

    update(dt: number): void {
        // ---- Sparkle stars ----
        for (const s of this.stars) {
            s.ttl -= dt;
            if (s.ttl <= 0) {
                this.respawnStar(s);
                continue;
            }
            const t = 1 - s.ttl / s.lifetime;
            const popK = t < 0.25 ? (t / 0.25) : 1.0;
            const sizeK = Math.max(0.05, popK * (1 - Math.max(0, (t - 0.25) / 0.75)));
            const base = this.starSize * this.scaleK;
            s.node.setScale(base * sizeK, base * sizeK, base * sizeK);
        }

    }



    /** Build `bandCount` bands across the brick face. Each band uses
     *  bandWidth (long axis), bandHeight (thin axis), bandDepth (radial).
     *  Orientation 0 stacks bands along Y (horizontal stripes); 1 stacks
     *  them along X (vertical stripes for the column-blast variants). */
    private buildBand(): void {
        const mesh: Mesh = utils.MeshUtils.createMesh(primitives.box({
            width: 1, height: 1, length: 1,
        }));
        const N = Math.max(1, Math.min(3, this.bandCount | 0));
        const horizontal = (this.bandOrientation | 0) === 0;
        const k = this.scaleK;
        // Centre the stack: indices 0..N-1 → offsets symmetric around 0.
        // For N=1: [0]. For N=2: [-spacing/2, +spacing/2]. For N=3: [-spacing, 0, +spacing].
        for (let i = 0; i < N; i++) {
            const offset = (i - (N - 1) / 2) * this.bandSpacing;

            const mat = new Material();
            mat.initialize({ effectName: 'builtin-unlit' });
            mat.setProperty('mainColor', this.bandColor);

            const n = new Node(`Band_${i}`);
            n.parent = this.node;
            n.layer  = this.node.layer;
            const mr = n.addComponent(MeshRenderer);
            mr.mesh = mesh;
            mr.material = mat;

            if (horizontal) {
                // Long axis = X (tangent), thin = Y (vertical), depth = Z.
                n.setScale(this.bandWidth * k, this.bandHeight * k, this.bandDepth * k);
                n.setPosition(0, offset * k, 0);
            } else {
                // Long axis = Y (vertical), thin = X (horizontal), depth = Z.
                n.setScale(this.bandHeight * k, this.bandWidth * k, this.bandDepth * k);
                n.setPosition(offset * k, 0, 0);
            }
            this.bandMRs.push(mr);
        }
    }
}
