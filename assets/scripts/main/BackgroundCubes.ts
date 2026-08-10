import {
    _decorator,
    Component,
    Node,
    Mesh,
    MeshRenderer,
    Material,
    Color,
    Texture2D,
    Vec3,
    utils,
    log,
} from 'cc';

const { ccclass, property } = _decorator;

// ============================================================
//  Tetromino shapes — classic 7-bag, each as relative cell coords.
//  The cells are centred around the centroid in build() so the
//  piece tumbles around its own midpoint, not an off-centre origin.
// ============================================================
const TETROMINO_SHAPES: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
    [[0, 0], [1, 0], [2, 0], [3, 0]], // I
    [[0, 0], [1, 0], [0, 1], [1, 1]], // O
    [[0, 0], [1, 0], [2, 0], [1, 1]], // T
    [[1, 0], [2, 0], [0, 1], [1, 1]], // S
    [[0, 0], [1, 0], [1, 1], [2, 1]], // Z
    [[0, 0], [0, 1], [1, 0], [2, 0]], // L
    [[2, 0], [0, 1], [1, 1], [2, 1]], // J
];

/**
 * Ambient tetromino background layer.
 *
 * Spawns N classic 2-D tetromino pieces drifting downward behind the
 * tower. Each piece is dark-blue fill with a bright outline, and
 * leaves a fading trail of small square sparkles as it falls.
 *
 * Implementation
 * --------------
 * - Each piece = a parent Node with 4 child cell quads, all sharing
 *   a single procedurally-built "border+fill" texture.
 * - The piece's parent stays roughly camera-facing (XY world plane)
 *   and only spins around its local Z axis, so the cells always
 *   read as flat 2-D blocks regardless of rotation.
 * - Sparkles are a fixed pool of small square quads. Each piece
 *   spawns a sparkle every `sparkleInterval` seconds at its current
 *   position. Sparkles age out (scale + alpha → 0) then return to
 *   the pool.
 *
 * All rendering is `builtin-unlit` technique 1 (alpha-blended, no
 * depth write) so the layer composits cleanly between the background
 * quad (behind) and the tower cubes (in front).
 */
@ccclass('BackgroundCubes')
export class BackgroundCubes extends Component {

    // ---------- Piece configuration ----------

    /** Number of tetromino pieces alive simultaneously. Set to 0 to
     *  disable the background-piece effect entirely (saves ~24 background
     *  cells + their sparkles ≈ 100 draw calls per frame). */
    @property({ range: [0, 200, 1] })
    count: number = 0;

    /** Edge length of one cell in world units (BEFORE per-piece scale). */
    @property
    cellSize: number = 0.65;

    /** Inner cell colour. Dark navy by default — pairs with the
     *  deep-blue background. Rebuild the texture (restart preview)
     *  after changing this. */
    @property
    fillColor: Color = new Color(18, 32, 78, 255);

    /** Outline colour painted on the border ring of each cell.
     *  Cyan / bright blue reads as the classic neon-tetris look. */
    @property
    outlineColor: Color = new Color(120, 200, 255, 255);

    /** Outline thickness in TEXEL pixels (independent of cell world
     *  size). Cell texture is 64×64, so 2 = a 2-pixel border ring
     *  inside each cell. Increase for a chunkier neon-block look. */
    @property({ range: [1, 16, 1] })
    outlinePixels: number = 2;

    /** Per-piece random scale range. */
    @property
    minScale: number = 0.7;
    @property
    maxScale: number = 1.5;

    /** Per-piece opacity. Setting min = max produces uniform ghost
     *  pieces; widen the gap if you want some pieces to read more
     *  prominent than others. 5 % is barely-there ambient — outlines
     *  are still just visible against the dark-blue clear colour. */
    @property({ range: [0.0, 1.0, 0.01] })
    minOpacity: number = 0.05;
    @property({ range: [0.0, 1.0, 0.01] })
    maxOpacity: number = 0.05;

    /** Fall speed range (world units per second). */
    @property
    minFallSpeed: number = 0.5;
    @property
    maxFallSpeed: number = 1.4;

    // NOTE: spin functionality removed by request — tetrominoes
    // always fall in their canonical orientation, no rotation.
    // If you ever want it back, restore `maxSpinDegPerSec`, `p.spin`,
    // and the rotation branch in update().

    // ---------- Sparkle trail configuration ----------

    /** Edge length of a sparkle in world units (before per-sparkle
     *  scale). Sparkles fade and shrink as they age. */
    @property
    sparkleSize: number = 0.18;

    /** Sparkle lifetime in seconds. */
    @property
    sparkleLifetime: number = 1.6;

    /** Seconds between sparkles per piece. Smaller = denser trail
     *  + more draw calls. */
    @property
    sparkleInterval: number = 0.22;

    /** Sparkle tint (mainColor multiplied with the soft texture). */
    @property
    sparkleColor: Color = new Color(150, 210, 255, 255);

    /** Peak sparkle alpha at spawn time (1.0 = fully opaque sparkle
     *  when it first appears, then fades to 0 over its lifetime).
     *  Keep this in sync with `minOpacity`/`maxOpacity` so the trail
     *  doesn't read brighter than the piece that emitted it. */
    @property({ range: [0.0, 1.0, 0.01] })
    sparkleOpacity: number = 0.05;

    /** Hard cap on simultaneously-active sparkles. With 6 pieces ×
     *  ~7 sparkles each in flight at any time, 60 covers comfortably
     *  even after random bunching. Bump higher if you increase
     *  `count` or shorten `sparkleInterval`. */
    @property({ range: [10, 200, 1] })
    sparklePoolSize: number = 60;

    // ---------- Spawn region (world space) ----------

    /** Radius of the imaginary background cylinder pieces wrap
     *  around. The tower itself sits at radius ≈ 3.83, so 14 puts
     *  the background pieces well outside the tower's silhouette
     *  on every side. Bigger = the layer feels deeper / farther. */
    @property
    cylinderRadius: number = 14;

    /** Arc the pieces spawn across (in degrees), centred on the
     *  cylinder's back side (z = −radius). 180 = full back
     *  half-circle visible through the tower's gaps. Narrow to
     *  ~120 if you want pieces concentrated more behind the tower
     *  rather than spreading to the sides. */
    @property({ range: [30, 360, 1] })
    cylinderArcSpan: number = 180;

    @property
    spawnYTop: number = 14;
    @property
    spawnYBottom: number = -14;

    // ---------- Runtime ----------

    private root: Node | null = null;
    private cellMesh: Mesh | null = null;
    private cellTex:  Texture2D | null = null;
    private sparkleMesh: Mesh | null = null;
    private sparkleTex:  Texture2D | null = null;

    private pieces: Array<{
        parent: Node;
        cells: Node[];
        cellMats: Material[];
        pos: Vec3;
        fallSpeed: number;
        opacity: number;
        sparkleAccum: number;
    }> = [];

    private sparkles: Array<{
        node: Node;
        mat: Material;
        baseScale: number;
        age: number;
        alive: boolean;
    }> = [];

    onLoad(): void {
        this.build();
        if (this.root) this.root.active = false;
        log(`[BackgroundCubes] onLoad — pieces:${this.pieces.length} sparkles:${this.sparkles.length}`);
    }

    public setVisible(on: boolean): void {
        if (this.root) this.root.active = on;
    }

    update(dt: number): void {
        if (!this.root || !this.root.active) return;

        // ---------- Pieces ----------
        for (const p of this.pieces) {
            p.pos.y -= p.fallSpeed * dt;
            if (p.pos.y < this.spawnYBottom) {
                this.respawnPiece(p);
                continue;
            }
            p.parent.setPosition(p.pos);
            // Rotation removed — pieces always fall in canonical
            // orientation. No setRotationFromEuler in the hot loop.

            // Sparkle emission.
            p.sparkleAccum += dt;
            while (p.sparkleAccum >= this.sparkleInterval) {
                p.sparkleAccum -= this.sparkleInterval;
                this.spawnSparkle(p.pos);
            }
        }

        // ---------- Sparkles ----------
        for (const s of this.sparkles) {
            if (!s.alive) continue;
            s.age += dt;
            const t = s.age / this.sparkleLifetime;
            if (t >= 1) {
                s.alive = false;
                s.node.active = false;
                continue;
            }
            // Ease-out: shrink + fade more rapidly at the end. The
            // alpha is also capped to `sparkleOpacity` so the trail
            // stays in-line with the piece's overall transparency.
            const k = 1 - t;
            const scale = s.baseScale * (0.4 + k * 0.6);
            s.node.setScale(scale, scale, scale);
            const a = Math.round(k * k * this.sparkleOpacity * 255);
            s.mat.setProperty('mainColor', new Color(
                this.sparkleColor.r, this.sparkleColor.g, this.sparkleColor.b, a,
            ));
        }
    }

    // ============================================================
    //  Build — runs once in onLoad.
    // ============================================================
    private build(): void {
        if (this.pieces.length > 0) return;

        const root = new Node('BackgroundCubesRoot');
        root.parent = this.node.scene ?? this.node;
        root.layer  = this.node.layer;
        this.root = root;

        this.cellTex     = this.makeCellTexture(64);
        this.cellMesh    = this.makeQuadMesh(1, 1);
        this.sparkleTex  = this.makeSparkleTexture(32);
        this.sparkleMesh = this.makeQuadMesh(1, 1);

        for (let i = 0; i < this.count; i++) {
            const parent = new Node(`BgPiece_${i}`);
            parent.parent = root;
            parent.layer  = root.layer;

            const cells: Node[] = [];
            const cellMats: Material[] = [];
            for (let j = 0; j < 4; j++) {
                const cell = new Node(`Cell_${j}`);
                cell.parent = parent;
                cell.layer  = parent.layer;
                const mr = cell.addComponent(MeshRenderer);
                mr.mesh = this.cellMesh;
                const mat = new Material();
                mat.initialize({
                    effectName: 'builtin-unlit',
                    technique: 1,
                    defines: { USE_TEXTURE: true },
                });
                mat.setProperty('mainTexture', this.cellTex);
                mr.material = mat;
                cells.push(cell);
                cellMats.push(mat);
            }

            const piece = {
                parent,
                cells,
                cellMats,
                pos: new Vec3(),
                zRot: 0,
                spin: 0,
                fallSpeed: 0,
                opacity: 0,
                sparkleAccum: 0,
            };
            this.pieces.push(piece);
            this.respawnPiece(piece);
            // Stagger initial Y so the scene starts populated rather
            // than all pieces marching down from the top in lockstep.
            piece.pos.y = this.spawnYBottom + Math.random() * (this.spawnYTop - this.spawnYBottom);
            piece.parent.setPosition(piece.pos);
        }

        for (let i = 0; i < this.sparklePoolSize; i++) {
            const node = new Node(`Sparkle_${i}`);
            node.parent = root;
            node.layer  = root.layer;
            node.active = false;
            const mr = node.addComponent(MeshRenderer);
            mr.mesh = this.sparkleMesh;
            const mat = new Material();
            mat.initialize({
                effectName: 'builtin-unlit',
                technique: 1,
                defines: { USE_TEXTURE: true },
            });
            mat.setProperty('mainTexture', this.sparkleTex);
            mr.material = mat;
            this.sparkles.push({
                node,
                mat,
                baseScale: this.sparkleSize,
                age: 0,
                alive: false,
            });
        }
    }

    /** Reset a piece with a freshly-randomised tetromino, position,
     *  scale, fall speed, spin, and opacity. */
    private respawnPiece(p: BackgroundCubes['pieces'][0]): void {
        const rawShape = TETROMINO_SHAPES[Math.floor(Math.random() * TETROMINO_SHAPES.length)];
        // Pick one of the four canonical rotation states (0°, 90°,
        // 180°, 270° clockwise around the shape's local origin) —
        // simulates "the player tapped rotate a random number of
        // times before the piece dropped". The shape is then frozen
        // in this rotation for the rest of the piece's fall.
        const rotState = Math.floor(Math.random() * 4);
        const shape: ReadonlyArray<readonly [number, number]> = rawShape.map(
            ([x, y]) => rotateCell(x, y, rotState),
        );
        // Centroid → shift cells so the piece sits centred on the
        // parent node (parent transform is the piece's "anchor").
        let cx = 0, cy = 0;
        for (const [x, y] of shape) { cx += x; cy += y; }
        cx /= shape.length;
        cy /= shape.length;

        const scale = lerp(this.minScale, this.maxScale, Math.random());
        const opacity = lerp(this.minOpacity, this.maxOpacity, Math.random());
        const mainCol = new Color(255, 255, 255, Math.round(opacity * 255));
        p.opacity = opacity;

        for (let j = 0; j < 4; j++) {
            const [x, y] = shape[j];
            const cell = p.cells[j];
            cell.setPosition(
                (x - cx) * this.cellSize,
                (y - cy) * this.cellSize,
                0,
            );
            cell.setScale(this.cellSize, this.cellSize, 1);
            p.cellMats[j].setProperty('mainColor', mainCol);
        }

        p.parent.setScale(scale, scale, scale);

        // Cylinder layout. Pick a random angle in the configured arc,
        // measured from the cylinder's back centre (z = −radius).
        // Position on the cylinder surface; rotate the piece around
        // its Y axis so its face points INWARD (toward the cylinder
        // axis). With the camera at +Z looking at origin, inward-
        // facing back-arc pieces present themselves to the viewer;
        // side-arc pieces appear progressively edge-on, which is the
        // "wrapping around a cylinder" visual cue.
        const angleDeg = (Math.random() * 2 - 1) * this.cylinderArcSpan / 2;
        const a = angleDeg * Math.PI / 180;
        p.pos.x = Math.sin(a) * this.cylinderRadius;
        p.pos.y = this.spawnYTop + Math.random() * 2;
        p.pos.z = -Math.cos(a) * this.cylinderRadius;
        p.parent.setPosition(p.pos);

        // Y-axis orientation only — NO spinning. Pieces never change
        // orientation once placed; the Y rotation here freezes them
        // tangent to the background cylinder for the rest of their
        // life. Falls happen purely in Y.
        p.parent.setRotationFromEuler(0, -angleDeg, 0);
        p.fallSpeed = lerp(this.minFallSpeed, this.maxFallSpeed, Math.random());
        p.sparkleAccum = Math.random() * this.sparkleInterval;  // de-sync starts
    }

    /** Pick a free sparkle from the pool and activate it at `pos`. */
    private spawnSparkle(pos: Vec3): void {
        let s: BackgroundCubes['sparkles'][0] | null = null;
        for (const cand of this.sparkles) {
            if (!cand.alive) { s = cand; break; }
        }
        if (!s) return;  // pool exhausted; drop this sparkle
        s.alive = true;
        s.age = 0;
        // Spread sparkles in a small radius around the piece centre
        // so they don't all overlap on the centroid pixel.
        const jitter = 0.6;
        s.node.setPosition(
            pos.x + (Math.random() * 2 - 1) * jitter,
            pos.y + (Math.random() * 2 - 1) * jitter * 0.4,
            pos.z + (Math.random() * 2 - 1) * 0.3,
        );
        s.node.setScale(this.sparkleSize, this.sparkleSize, this.sparkleSize);
        s.node.active = true;
        // Spawn at peak alpha — update() will fade from here.
        s.mat.setProperty('mainColor', new Color(
            this.sparkleColor.r,
            this.sparkleColor.g,
            this.sparkleColor.b,
            Math.round(this.sparkleOpacity * 255),
        ));
    }

    // ============================================================
    //  Texture & mesh helpers
    // ============================================================

    /** Procedurally bake a "filled square with bright outline" cell
     *  texture. RGBA values are written in the loop so we can vary
     *  fill vs outline colour at the pixel level — Cocos's unlit
     *  shader just samples this and multiplies by `mainColor`,
     *  which we use to control overall alpha per piece. */
    private makeCellTexture(size: number): Texture2D {
        const buf = new Uint8Array(size * size * 4);
        const border = Math.max(1, Math.min(Math.floor(size / 2), this.outlinePixels));
        const fc = this.fillColor;
        const oc = this.outlineColor;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const onBorder = x < border || x >= size - border
                              || y < border || y >= size - border;
                const c = onBorder ? oc : fc;
                const i = (y * size + x) * 4;
                buf[i]     = c.r;
                buf[i + 1] = c.g;
                buf[i + 2] = c.b;
                buf[i + 3] = 255;
            }
        }
        const tex = new Texture2D();
        tex.reset({ width: size, height: size, format: Texture2D.PixelFormat.RGBA8888 });
        tex.uploadData(buf);
        return tex;
    }

    /** Sparkle texture: soft-edged solid white square. Chebyshev
     *  distance keeps the silhouette square (vs. Euclidean which
     *  would give a circular sparkle). Edge fades over the last
     *  ~30 % of the radius so the square reads soft, not pixelated. */
    private makeSparkleTexture(size: number): Texture2D {
        const buf = new Uint8Array(size * size * 4);
        const cx = size / 2;
        const cy = size / 2;
        const maxR = size / 2;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const r = Math.max(Math.abs(x - cx), Math.abs(y - cy)) / maxR;
                let alpha = 1;
                if (r > 0.65) alpha = Math.max(0, (1 - r) / 0.35);
                const i = (y * size + x) * 4;
                buf[i]     = 255;
                buf[i + 1] = 255;
                buf[i + 2] = 255;
                buf[i + 3] = Math.round(alpha * 255);
            }
        }
        const tex = new Texture2D();
        tex.reset({ width: size, height: size, format: Texture2D.PixelFormat.RGBA8888 });
        tex.uploadData(buf);
        return tex;
    }

    private makeQuadMesh(w: number, h: number): Mesh {
        const hw = w / 2;
        const hh = h / 2;
        return utils.MeshUtils.createMesh({
            positions: [
                -hw, -hh, 0,
                 hw, -hh, 0,
                 hw,  hh, 0,
                -hw,  hh, 0,
            ],
            normals: [0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1],
            uvs: [0, 1,  1, 1,  1, 0,  0, 0],
            indices: [0, 1, 2, 0, 2, 3],
        });
    }

    onDestroy(): void {
        if (this.root && this.root.isValid) this.root.destroy();
        this.root = null;
        this.pieces.length = 0;
        this.sparkles.length = 0;
    }
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

/** Rotate one [x, y] cell coord by N × 90° clockwise (N in 0..3).
 *  Used to spawn each tetromino in a random orientation. */
function rotateCell(x: number, y: number, n: number): [number, number] {
    switch (((n % 4) + 4) % 4) {
        case 1:  return [ y, -x];
        case 2:  return [-x, -y];
        case 3:  return [-y,  x];
        default: return [ x,  y];
    }
}
