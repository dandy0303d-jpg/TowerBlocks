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
 * Wrecker (拆迁队) item cube.
 *
 * Same body silhouette as `RowBlastCubeFX` — instantiates the regular
 * brick prefab as the body so the cube reads as a "normal cell with
 * a special twist," only the colour changes and a small HAMMER icon
 * sits in the middle (head + handle, two procedural box meshes) to
 * mark it as the wrecker prop. Sparkle stars hover around the prop
 * for the "magic item" feel.
 *
 * Drop on an empty Node (scale 1, default), then:
 *   1. Drag the regular `Cube.prefab` into `bodyPrefab`.
 *   2. (Optional) Tweak `bodyColor`, hammer dimensions / colours.
 *   3. Save the node into Assets as `WreckerCube.prefab`.
 *   4. Hook the new prefab up to `GameController.wreckerPrefab`
 *      (wiring is a separate step).
 */
@ccclass('WreckerCubeFX')
export class WreckerCubeFX extends Component {

    // ---------- Body ----------

    /** Drag the regular `Cube.prefab` here. Mirrors the regular brick's
     *  Meshy mesh so the silhouette is identical to a normal cell;
     *  only the colour differs. Leave blank for a procedural box. */
    @property(Prefab)
    bodyPrefab: Prefab | null = null;

    /** Tint applied to the body's material (orange #F86316 by default,
     *  matches RowBlastCubeFX so all item cubes share a colour family). */
    @property
    bodyColor: Color = new Color(248, 99, 22, 255);

    /** Used only when `bodyPrefab` is null — edge length of the
     *  procedural fallback box (world units). */
    @property
    bodySize: number = 1.0;

    // ---------- Hammer icon ----------
    // Built from two thin box meshes that overlap the body the same
    // way RowBlastCubeFX's bands do (sits inside the cube body, visible
    // through the curved brick face because the Meshy brick mesh is a
    // thin shell rather than a solid cube).

    /** Hammer head: a wide stubby rectangle near the top of the face. */
    @property
    hammerHeadWidth:  number = 0.55;
    @property
    hammerHeadHeight: number = 0.20;
    @property
    hammerHeadOffsetY: number = 0.18;
    @property
    hammerHeadColor:  Color  = new Color(190, 195, 205, 255);   // gray steel

    /** Hammer handle: a thin vertical rectangle below the head. */
    @property
    hammerHandleWidth:  number = 0.12;
    @property
    hammerHandleHeight: number = 0.42;
    @property
    hammerHandleOffsetY: number = -0.13;
    @property
    hammerHandleColor:  Color  = new Color(125, 80, 45, 255);    // warm wood brown

    /** Depth (radial extent) of the hammer slabs — matches band depth
     *  in RowBlastCubeFX. Keep ≤ body Z depth so the icon doesn't poke
     *  out the inner face. */
    @property
    iconDepth: number = 0.70;

    // ---------- Sparkle stars (twinkle particles around the cube) ----------

    /** Number of twinkle stars hovering around the cube. 10–16 reads
     *  as lively without being noisy. Set 0 to disable. */
    @property
    starCount: number = 12;

    /** Edge length of each star sprite (world units). */
    @property
    starSize: number = 0.05;

    /** Star lifetime range (seconds). Short = strobing, long = floaty. */
    @property
    starLifetimeMin: number = 0.05;
    @property
    starLifetimeMax: number = 0.20;

    /** Distance from cube centre where stars spawn (world units). */
    @property
    starRadius: number = 0.65;

    /** Star colour — pure bright white by default for max pop. */
    @property
    starColor: Color = new Color(255, 255, 255, 255);

    // ---------- Internal ----------

    private scaleK = 1;

    private bodyMR: MeshRenderer | null = null;
    /** Head + handle MeshRenderers — dimmed together with the body via
     *  `setTint`. */
    private iconMRs: MeshRenderer[] = [];
    /** Parallel array of authored colours for each `iconMRs` entry, so
     *  `setTint` can dim each part proportionally. */
    private iconBaseColors: Color[] = [];

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
        this.buildHammer();
        this.buildSparkles();
    }

    /** Build the cube body — same as RowBlastCubeFX. PBR-standard
     *  material to keep the Meshy bevel / lighting; flat colour
     *  fallback when no prefab is wired. */
    private buildBody(): void {
        if (this.bodyPrefab) {
            const body = instantiate(this.bodyPrefab);
            body.parent = this.node;
            body.layer  = this.node.layer;
            body.setPosition(0, 0, 0);
            // Same brick-orientation correction as RowBlastCubeFX.
            body.setRotationFromEuler(90, 180, 0);

            const mr = body.getComponent(MeshRenderer)
                ?? body.getComponentInChildren(MeshRenderer);
            if (mr) {
                const mat = new Material();
                mat.initialize({ effectName: 'builtin-standard' });
                mat.setProperty('mainColor', this.bodyColor);
                mat.setProperty('roughness', 0.55);
                mat.setProperty('metallic', 0.05);
                mr.material = mat;
                this.bodyMR = mr;
            }
            return;
        }

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

    /** Build the hammer icon — two flat slabs:
     *    HEAD   : wide horizontal bar near the top of the face.
     *    HANDLE : thin vertical bar going down from below the head.
     *  Same positioning convention as RowBlastCubeFX's bands. */
    private buildHammer(): void {
        const mesh: Mesh = utils.MeshUtils.createMesh(primitives.box({
            width: 1, height: 1, length: 1,
        }));
        const k = this.scaleK;

        // ---- HEAD ----
        {
            const mat = new Material();
            mat.initialize({ effectName: 'builtin-unlit' });
            mat.setProperty('mainColor', this.hammerHeadColor);
            const n = new Node('HammerHead');
            n.parent = this.node;
            n.layer  = this.node.layer;
            const mr = n.addComponent(MeshRenderer);
            mr.mesh = mesh;
            mr.material = mat;
            n.setScale(
                this.hammerHeadWidth  * k,
                this.hammerHeadHeight * k,
                this.iconDepth        * k,
            );
            n.setPosition(0, this.hammerHeadOffsetY * k, 0);
            this.iconMRs.push(mr);
            this.iconBaseColors.push(this.hammerHeadColor);
        }

        // ---- HANDLE ----
        {
            const mat = new Material();
            mat.initialize({ effectName: 'builtin-unlit' });
            mat.setProperty('mainColor', this.hammerHandleColor);
            const n = new Node('HammerHandle');
            n.parent = this.node;
            n.layer  = this.node.layer;
            const mr = n.addComponent(MeshRenderer);
            mr.mesh = mesh;
            mr.material = mat;
            n.setScale(
                this.hammerHandleWidth  * k,
                this.hammerHandleHeight * k,
                this.iconDepth          * k,
            );
            n.setPosition(0, this.hammerHandleOffsetY * k, 0);
            this.iconMRs.push(mr);
            this.iconBaseColors.push(this.hammerHandleColor);
        }
    }

    /** Multiplicatively dim/lighten body + hammer parts by `factor`.
     *  GameController calls this per frame for the back-of-cylinder
     *  darkening so the prop fades to dim together as it rotates away
     *  from the camera. */
    public setTint(factor: number): void {
        const f = Math.max(0, Math.min(1, factor));
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
        for (let i = 0; i < this.iconMRs.length; i++) {
            const mr  = this.iconMRs[i];
            const src = this.iconBaseColors[i];
            const mat = mr.material;
            if (mat) {
                mat.setProperty('mainColor', new Color(
                    Math.floor(src.r * f),
                    Math.floor(src.g * f),
                    Math.floor(src.b * f),
                    Math.round(src.a),
                ));
            }
        }
    }

    // ============================================================
    //  SPARKLES — twinkle stars around the prop (same as RowBlastCubeFX)
    // ============================================================
    private buildSparkles(): void {
        if (this.starCount <= 0) return;
        const mesh: Mesh = utils.MeshUtils.createMesh(primitives.box({
            width: 1, height: 1, length: 1,
        }));
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
        const az = Math.random() * Math.PI * 2;
        const el = (Math.random() - 0.3) * Math.PI;
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
        const size = this.starSize * k * (0.6 + Math.random() * 0.8);
        s.node.setScale(size, size, size);
        if (!s.node.active) s.node.active = true;
    }

    update(dt: number): void {
        for (const s of this.stars) {
            s.ttl -= dt;
            if (s.ttl <= 0) {
                this.respawnStar(s);
                continue;
            }
            const t     = 1 - s.ttl / s.lifetime;
            const popK  = t < 0.25 ? (t / 0.25) : 1.0;
            const sizeK = Math.max(0.05, popK * (1 - Math.max(0, (t - 0.25) / 0.75)));
            const base  = this.starSize * this.scaleK;
            s.node.setScale(base * sizeK, base * sizeK, base * sizeK);
        }
    }
}
