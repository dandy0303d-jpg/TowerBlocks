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
 * Gatling (加特林) item cube.
 *
 * Same orange brick silhouette as the other CubeFX props. The icon is
 * a stack of short horizontal "bullet stripes" — reads as a quick
 * three-shot machine-gun burst.
 *
 * Setup:
 *   1. Empty Node + this component.
 *   2. Drag `Cube.prefab` into `bodyPrefab`.
 *   3. (Optional) Tweak stripe colour / dimensions.
 *   4. Save as `GatlingCube.prefab`.
 *   5. Wire to `GameController.gatlingCubePrefab`.
 */
@ccclass('GatlingCubeFX')
export class GatlingCubeFX extends Component {

    // ---------- Body ----------

    @property(Prefab)
    bodyPrefab: Prefab | null = null;

    @property
    bodyColor: Color = new Color(248, 99, 22, 255);

    @property
    bodySize: number = 1.0;

    // ---------- Crosshair + center-dot icon ----------
    // A "scope reticle" made of one horizontal slab + one vertical slab
    // crossing at the centre, with a small red dot in the middle. Reads
    // as a gun sight / targeting reticle — distinct from row/col-blast
    // (which are 1/2/3 parallel bands) and meteor (diagonal streaks).

    /** Length of the crosshair arms (both horizontal and vertical). */
    @property
    crosshairLength: number = 0.55;

    /** Thickness of the crosshair arms (perpendicular to their length). */
    @property
    crosshairThickness: number = 0.10;

    /** Depth (radial extent) into the brick body. */
    @property
    crosshairDepth: number = 0.70;

    /** Crosshair colour. Default warm gold reads as a glowing reticle. */
    @property
    crosshairColor: Color = new Color(255, 230, 130, 255);

    /** Centre-dot edge length — the red "target locked" marker. */
    @property
    centerDotSize: number = 0.16;

    /** Centre dot's depth (sits slightly forward of the arms to layer
     *  on top without z-fighting). */
    @property
    centerDotDepth: number = 0.74;

    /** Centre-dot colour. Default bright red for max contrast. */
    @property
    centerDotColor: Color = new Color(220, 60, 60, 255);

    // ---------- Sparkle stars ----------

    @property
    starCount: number = 12;
    @property
    starSize: number = 0.05;
    @property
    starLifetimeMin: number = 0.05;
    @property
    starLifetimeMax: number = 0.20;
    @property
    starRadius: number = 0.65;
    @property
    starColor: Color = new Color(255, 255, 255, 255);

    // ---------- Internal ----------

    private scaleK = 1;
    private bodyMR: MeshRenderer | null = null;
    private iconMRs: MeshRenderer[] = [];
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
        this.buildCrosshair();
        this.buildSparkles();
    }

    private buildBody(): void {
        if (this.bodyPrefab) {
            const body = instantiate(this.bodyPrefab);
            body.parent = this.node;
            body.layer  = this.node.layer;
            body.setPosition(0, 0, 0);
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

    /** Crosshair: horizontal slab + vertical slab + central red dot.
     *  Reads as a scope reticle — distinct from row/col blast (parallel
     *  bands) and meteor (diagonal streaks). */
    private buildCrosshair(): void {
        const mesh: Mesh = utils.MeshUtils.createMesh(primitives.box({
            width: 1, height: 1, length: 1,
        }));
        const k = this.scaleK;

        const makeSlab = (
            name: string,
            color: Color,
            sx: number, sy: number, sz: number,
        ) => {
            const mat = new Material();
            mat.initialize({ effectName: 'builtin-unlit' });
            mat.setProperty('mainColor', color);
            const n = new Node(name);
            n.parent = this.node;
            n.layer  = this.node.layer;
            const mr = n.addComponent(MeshRenderer);
            mr.mesh = mesh;
            mr.material = mat;
            n.setScale(sx * k, sy * k, sz * k);
            n.setPosition(0, 0, 0);
            this.iconMRs.push(mr);
        };

        // Horizontal arm.
        makeSlab('CrosshairH', this.crosshairColor,
            this.crosshairLength, this.crosshairThickness, this.crosshairDepth);

        // Vertical arm.
        makeSlab('CrosshairV', this.crosshairColor,
            this.crosshairThickness, this.crosshairLength, this.crosshairDepth);

        // Centre dot — slightly forward so it visually sits on top
        // of the crossed arms instead of merging into them.
        makeSlab('CenterDot', this.centerDotColor,
            this.centerDotSize, this.centerDotSize, this.centerDotDepth);
    }

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
        // iconMRs layout: [0]=CrosshairH (gold), [1]=CrosshairV (gold), [2]=CenterDot (red).
        // Dim by each slab's own base colour so the contrast holds at low light.
        for (let i = 0; i < this.iconMRs.length; i++) {
            const src = (i < 2) ? this.crosshairColor : this.centerDotColor;
            const mat = this.iconMRs[i].material;
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
    //  SPARKLES — twinkle stars around the prop
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
