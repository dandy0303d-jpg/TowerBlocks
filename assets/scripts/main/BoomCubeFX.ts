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
 * Diamond-blast item cube — orange brick body + 1 / 2 / 3 small lozenge icons
 * (rotated squares) up front to show the blast tier:
 *
 *   level 1 → one  lozenge   ◇         (radius-1 plus, 5 cells)
 *   level 2 → two  lozenges  ◇◇        (radius-2 diamond, 13 cells)
 *   level 3 → three lozenges ◇◇◇        (radius-3 diamond, 25 cells)
 *
 * Setup:
 *   1. Empty Node + this component.
 *   2. Drag `Cube.prefab` into `bodyPrefab`.
 *   3. Set `level` to 1, 2, or 3.
 *   4. (Optional) Tweak lozenge size / colour.
 *   5. Save as `BoomCube1.prefab` / `BoomCube2.prefab` / `BoomCube3.prefab`.
 *   6. Wire to `GameController.boomCubePrefabs` (size 3, indexed by level - 1).
 */
@ccclass('BoomCubeFX')
export class BoomCubeFX extends Component {

    // ---------- Body ----------

    @property(Prefab)
    bodyPrefab: Prefab | null = null;

    @property
    bodyColor: Color = new Color(248, 99, 22, 255);

    @property
    bodySize: number = 1.0;

    // ---------- Lozenge icon ----------
    //
    // Each lozenge is a thin box rotated 45° around the depth axis so it
    // reads as a rotated square (棱形 / diamond outline). `level` controls
    // how many lozenges are drawn side-by-side.

    /** 1 = one lozenge, 2 = two, 3 = three. Clamped on build. */
    @property({ tooltip: 'Boom tier: 1, 2, or 3 lozenges shown on the cube face' })
    level: number = 1;

    /** Half-width of each lozenge BEFORE the 45° rotation. After rotation
     *  the visible diagonal is roughly `lozengeSize × √2`. */
    @property
    lozengeSize: number = 0.20;

    /** Thickness of each lozenge — keep below `lozengeSize` for a hollow-
     *  diamond reading (we draw an outer + inner box layered). */
    @property
    lozengeThickness: number = 0.20;

    /** Radial extent into the brick body (Z scale). 0.70+ puts them clearly
     *  in front of the body. */
    @property
    lozengeDepth: number = 0.74;

    /** Outer (filled) lozenge colour. Default bright cyan to contrast with
     *  the orange body. */
    @property
    lozengeColor: Color = new Color(120, 220, 255, 255);

    /** Inner cut-out colour — drawn slightly in front of the outer slab to
     *  give a "hollow diamond" silhouette. Set alpha 0 to skip the cutout. */
    @property
    lozengeInnerColor: Color = new Color(20, 30, 60, 255);

    /** Horizontal spacing between lozenges, as a multiple of `lozengeSize`. */
    @property
    lozengeSpacing: number = 1.6;

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
        this.buildLozenges();
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

    /** Build 1 / 2 / 3 lozenges side-by-side on the cube's front face. Each
     *  lozenge is a thin slab rotated 45° around Z — reads as a diamond
     *  outline. An optional inner slab (slightly forward) gives a hollow
     *  appearance. */
    private buildLozenges(): void {
        const mesh: Mesh = utils.MeshUtils.createMesh(primitives.box({
            width: 1, height: 1, length: 1,
        }));
        const k = this.scaleK;
        const n = Math.max(1, Math.min(3, this.level | 0));

        const spacing = this.lozengeSize * this.lozengeSpacing;
        const startX = -spacing * (n - 1) / 2;

        const makeSlab = (
            name: string,
            color: Color,
            x: number,
            sx: number, sy: number, sz: number,
        ): void => {
            const mat = new Material();
            mat.initialize({ effectName: 'builtin-unlit' });
            mat.setProperty('mainColor', color);
            const node = new Node(name);
            node.parent = this.node;
            node.layer  = this.node.layer;
            const mr = node.addComponent(MeshRenderer);
            mr.mesh = mesh;
            mr.material = mat;
            node.setPosition(x, 0, 0);
            node.setScale(sx * k, sy * k, sz * k);
            // 45° around Z turns the square box into a lozenge (rotated square).
            node.setRotationFromEuler(0, 0, 45);
            this.iconMRs.push(mr);
        };

        for (let i = 0; i < n; i++) {
            const x = startX + i * spacing;

            // Outer lozenge (filled).
            const outer = this.lozengeSize;
            makeSlab(`LozengeOuter_${i}`, this.lozengeColor,
                x, outer, outer, this.lozengeDepth);

            // Inner cut-out lozenge — slightly forward so it sits on top
            // of the outer slab without z-fighting. Smaller by the ratio
            // `lozengeThickness / lozengeSize`.
            if (this.lozengeInnerColor.a > 0) {
                const inner = Math.max(0.02, outer - this.lozengeThickness * 2);
                makeSlab(`LozengeInner_${i}`, this.lozengeInnerColor,
                    x, inner, inner, this.lozengeDepth + 0.02);
            }
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
        // iconMRs are laid out outer/inner, outer/inner, ... per lozenge.
        for (let i = 0; i < this.iconMRs.length; i++) {
            const src = (i % 2 === 0) ? this.lozengeColor : this.lozengeInnerColor;
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
