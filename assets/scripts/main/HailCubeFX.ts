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
    math,
} from 'cc';

const { ccclass, property } = _decorator;

/**
 * Hail (冰雹) item cube.
 *
 * Same orange brick silhouette as `RowBlastCubeFX` / `WreckerCubeFX` /
 * `RocketCubeFX`, but the centre icon is a 6-armed snowflake built
 * from three crossed slabs rotated 60° apart. White twinkle sparkles
 * orbit the cube as with the other item props.
 *
 * Setup (mirror of the other CubeFX props):
 *   1. Empty Node + this component.
 *   2. Drag `Cube.prefab` into `bodyPrefab`.
 *   3. (Optional) Tweak snowflake colour / size.
 *   4. Save as `HailCube.prefab`.
 *   5. Wire to `GameController.hailCubePrefab` (separate step).
 */
@ccclass('HailCubeFX')
export class HailCubeFX extends Component {

    // ---------- Body ----------

    @property(Prefab)
    bodyPrefab: Prefab | null = null;

    @property
    bodyColor: Color = new Color(248, 99, 22, 255);

    @property
    bodySize: number = 1.0;

    // ---------- Snowflake icon ----------
    // Three slabs crossed at 60° intervals, each centred at (0,0) on
    // the brick face → reads as a stylised 6-armed snowflake.

    /** Length of each snowflake arm (world units). */
    @property
    snowflakeArmLength: number = 0.55;

    /** Thickness of each arm (world units). Keep thin so the icon
     *  reads as crystalline lines rather than crossed bricks. */
    @property
    snowflakeArmThickness: number = 0.09;

    /** Depth (radial extent) of each arm — matches `iconDepth` pattern
     *  used by the other item cubes. Keep ≤ body Z depth. */
    @property
    snowflakeArmDepth: number = 0.70;

    /** Snowflake colour. Pale icy cyan reads clearly against the
     *  orange body. */
    @property
    snowflakeColor: Color = new Color(210, 240, 255, 255);

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
        this.buildSnowflake();
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

    /** Build the 6-armed snowflake from three crossed slabs. */
    private buildSnowflake(): void {
        const mesh: Mesh = utils.MeshUtils.createMesh(primitives.box({
            width: 1, height: 1, length: 1,
        }));
        const k = this.scaleK;
        // Three arms at 0°, 60°, 120° around Z. Each slab is long along
        // its local Y axis and thin along X; we rotate around Z to
        // splay them out. Together they form 6 visible spokes
        // (positive + negative ends of each arm).
        const armAngles = [0, 60, 120];
        for (let i = 0; i < armAngles.length; i++) {
            const ang = armAngles[i];
            const mat = new Material();
            mat.initialize({ effectName: 'builtin-unlit' });
            mat.setProperty('mainColor', this.snowflakeColor);
            const n = new Node(`SnowflakeArm_${i}`);
            n.parent = this.node;
            n.layer  = this.node.layer;
            const mr = n.addComponent(MeshRenderer);
            mr.mesh = mesh;
            mr.material = mat;
            n.setScale(
                this.snowflakeArmThickness * k,
                this.snowflakeArmLength    * k,
                this.snowflakeArmDepth     * k,
            );
            n.setPosition(0, 0, 0);
            n.setRotationFromEuler(0, 0, ang);
            this.iconMRs.push(mr);
        }
    }

    /** Dim body + snowflake arms together for back-of-cylinder fade. */
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
        for (const mr of this.iconMRs) {
            const mat = mr.material;
            if (mat) {
                mat.setProperty('mainColor', new Color(
                    Math.floor(this.snowflakeColor.r * f),
                    Math.floor(this.snowflakeColor.g * f),
                    Math.floor(this.snowflakeColor.b * f),
                    Math.round(this.snowflakeColor.a),
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
