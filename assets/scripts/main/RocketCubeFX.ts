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
 * Rocket (火箭弹) item cube.
 *
 * Same body silhouette as `RowBlastCubeFX` / `WreckerCubeFX` — orange
 * Meshy brick mesh — but the icon in the middle is a small stylized
 * rocket built from four box slabs: white vertical body, red nose
 * cap on top, two white tail fins flaring out at the bottom. Sparkle
 * stars hover around the cube for the "magic prop" look.
 *
 * Drop on an empty Node (scale 1, default), then:
 *   1. Drag the regular `Cube.prefab` into `bodyPrefab`.
 *   2. (Optional) tweak the rocket icon dimensions / colours.
 *   3. Save as `RocketCube.prefab`.
 *   4. Wire it up to `GameController.rocketCubePrefab` (one more
 *      pool + render branch — separate step).
 */
@ccclass('RocketCubeFX')
export class RocketCubeFX extends Component {

    // ---------- Body ----------

    /** Drag the regular `Cube.prefab` here. */
    @property(Prefab)
    bodyPrefab: Prefab | null = null;

    /** Tint applied to the body's material (orange #F86316 — same
     *  colour family as RowBlast / Wrecker cubes). */
    @property
    bodyColor: Color = new Color(248, 99, 22, 255);

    @property
    bodySize: number = 1.0;

    // ---------- Rocket icon ----------
    // 4 slabs assembled into a classic toy-rocket silhouette:
    //   nose (red)   ─── top
    //   body (white) ─── middle
    //   left + right fins (white) ── bottom corners
    // Same icon-depth convention as bands / hammers — sits inside the
    // brick body, visible through the curved shell.

    /** Rocket body — tall white rectangle in the centre. */
    @property
    rocketBodyWidth:  number = 0.20;
    @property
    rocketBodyHeight: number = 0.40;
    @property
    rocketBodyOffsetY: number = 0.02;
    @property
    rocketBodyColor:  Color  = new Color(248, 244, 230, 255);   // cream white

    /** Rocket nose — short red cap above the body. */
    @property
    rocketNoseWidth:  number = 0.14;
    @property
    rocketNoseHeight: number = 0.14;
    @property
    rocketNoseOffsetY: number = 0.29;
    @property
    rocketNoseColor:  Color  = new Color(220, 70, 60, 255);     // bright red

    /** Rocket fins — two slabs flaring out at the bottom. */
    @property
    rocketFinWidth:   number = 0.12;
    @property
    rocketFinHeight:  number = 0.16;
    @property
    rocketFinOffsetX: number = 0.15;
    @property
    rocketFinOffsetY: number = -0.22;
    @property
    rocketFinColor:   Color  = new Color(248, 244, 230, 255);   // matches body

    /** Depth (radial extent) of every icon slab. */
    @property
    iconDepth: number = 0.70;

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
        this.buildRocketIcon();
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

    /** Build the four-slab rocket icon: body, nose, left fin, right fin. */
    private buildRocketIcon(): void {
        const mesh: Mesh = utils.MeshUtils.createMesh(primitives.box({
            width: 1, height: 1, length: 1,
        }));
        const k = this.scaleK;

        const makeSlab = (
            name: string,
            color: Color,
            w: number, h: number,
            x: number, y: number,
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
            n.setScale(w * k, h * k, this.iconDepth * k);
            n.setPosition(x * k, y * k, 0);
            this.iconMRs.push(mr);
            this.iconBaseColors.push(color);
        };

        // Body (centre).
        makeSlab(
            'RocketBody', this.rocketBodyColor,
            this.rocketBodyWidth, this.rocketBodyHeight,
            0, this.rocketBodyOffsetY,
        );
        // Nose cap (above body).
        makeSlab(
            'RocketNose', this.rocketNoseColor,
            this.rocketNoseWidth, this.rocketNoseHeight,
            0, this.rocketNoseOffsetY,
        );
        // Left fin (bottom-left).
        makeSlab(
            'RocketFinL', this.rocketFinColor,
            this.rocketFinWidth, this.rocketFinHeight,
            -this.rocketFinOffsetX, this.rocketFinOffsetY,
        );
        // Right fin (bottom-right).
        makeSlab(
            'RocketFinR', this.rocketFinColor,
            this.rocketFinWidth, this.rocketFinHeight,
            +this.rocketFinOffsetX, this.rocketFinOffsetY,
        );
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
        for (let i = 0; i < this.iconMRs.length; i++) {
            const src = this.iconBaseColors[i];
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
