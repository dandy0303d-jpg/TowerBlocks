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
 * Meteor-shower (流星雨) item cube.
 *
 * Same orange brick silhouette as `RowBlastCubeFX` / `WreckerCubeFX` /
 * `RocketCubeFX` / `HailCubeFX`, but the centre icon is three slanted
 * golden streaks evoking meteor trails. White twinkle sparkles around
 * the cube, identical to the other item props.
 *
 * Setup:
 *   1. Empty Node + this component.
 *   2. Drag `Cube.prefab` into `bodyPrefab`.
 *   3. (Optional) Tweak streak colour / length / angle.
 *   4. Save as `MeteorCube.prefab`.
 *   5. Wire to `GameController.meteorCubePrefab` (separate step).
 */
@ccclass('MeteorCubeFX')
export class MeteorCubeFX extends Component {

    // ---------- Body ----------

    @property(Prefab)
    bodyPrefab: Prefab | null = null;

    @property
    bodyColor: Color = new Color(248, 99, 22, 255);

    @property
    bodySize: number = 1.0;

    // ---------- Meteor streaks ----------
    // Three slanted slabs spread across the cube face. All rotate by
    // the same Z-angle (default -45°) so they read as parallel falling
    // streaks; their (x,y) offsets stagger them along a diagonal so
    // they don't pile on top of each other.

    /** Angle each streak is rotated around Z (degrees). −45 reads as
     *  "falling from upper-right to lower-left". */
    @property
    meteorAngleDeg: number = -45;

    /** Streak thickness (perpendicular to the streak's long axis). */
    @property
    meteorThickness: number = 0.07;

    /** Streak length (along the streak's long axis). */
    @property
    meteorLength: number = 0.42;

    /** Depth (radial extent into the brick body). */
    @property
    meteorDepth: number = 0.70;

    /** Spread between adjacent streaks along the cube face. The three
     *  streaks sit at offsets (−spread, +spread), (0, 0), (+spread,
     *  −spread) so they cascade across the diagonal. */
    @property
    meteorSpread: number = 0.20;

    /** Streak colour. Default warm golden-yellow reads as fire trail
     *  against the orange body. */
    @property
    meteorColor: Color = new Color(255, 210, 90, 255);

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
        this.buildMeteors();
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

    /** Build three slanted meteor streaks. All share rotation; only the
     *  centre offset varies so they stagger diagonally across the face. */
    private buildMeteors(): void {
        const mesh: Mesh = utils.MeshUtils.createMesh(primitives.box({
            width: 1, height: 1, length: 1,
        }));
        const k = this.scaleK;
        const sp = this.meteorSpread;
        // Three offsets along a diagonal line. Slightly varied lengths
        // for a more natural shower (centre streak biggest).
        const meteors = [
            { x: -sp,         y: +sp,         lenK: 0.95 },
            { x:  sp * 0.05,  y:  sp * -0.05, lenK: 1.10 },
            { x: +sp,         y: -sp,         lenK: 0.90 },
        ];
        for (let i = 0; i < meteors.length; i++) {
            const m = meteors[i];
            const mat = new Material();
            mat.initialize({ effectName: 'builtin-unlit' });
            mat.setProperty('mainColor', this.meteorColor);
            const n = new Node(`MeteorStreak_${i}`);
            n.parent = this.node;
            n.layer  = this.node.layer;
            const mr = n.addComponent(MeshRenderer);
            mr.mesh = mesh;
            mr.material = mat;
            n.setScale(
                this.meteorThickness            * k,
                this.meteorLength * m.lenK      * k,
                this.meteorDepth                * k,
            );
            n.setPosition(m.x * k, m.y * k, 0);
            n.setRotationFromEuler(0, 0, this.meteorAngleDeg);
            this.iconMRs.push(mr);
        }
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
        for (const mr of this.iconMRs) {
            const mat = mr.material;
            if (mat) {
                mat.setProperty('mainColor', new Color(
                    Math.floor(this.meteorColor.r * f),
                    Math.floor(this.meteorColor.g * f),
                    Math.floor(this.meteorColor.b * f),
                    Math.round(this.meteorColor.a),
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
