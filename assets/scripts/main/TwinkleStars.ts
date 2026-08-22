/**
 * TwinkleStars — ambient background layer that spawns colorful star
 * dots at random 3D positions behind the tower and independently
 * twinkles each one's brightness. Zero interaction, purely decorative.
 *
 * Design
 * ------
 * - N (default 80) quads scattered inside a bounding box far behind
 *   the tower + camera arc, so they never overlap gameplay cubes.
 * - Each star gets a random color from a candy palette (pink, cyan,
 *   gold, mint, purple, orange, white). Shared soft-edged square
 *   texture; per-star material carries its own tint via mainColor.
 * - Twinkle: per-star sinusoidal alpha oscillation. Different phase
 *   and frequency per star so the cloud doesn't pulse in sync.
 *
 * Wiring (Cocos editor)
 * ---------------------
 * Attach this component to any scene node (e.g. Canvas or the same
 * parent as BackgroundCubes). No @property wiring required — everything
 * is procedural. Tunable params exposed as @property for editor tweaks.
 */

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

// Candy palette — punchy saturated colors that read well against a
// dark sky. Order doesn't matter; each star picks uniformly random.
const STAR_PALETTE: ReadonlyArray<readonly [number, number, number]> = [
    [255, 210, 220],   // pale pink
    [255, 160, 200],   // hot pink
    [255, 220, 120],   // warm gold
    [255, 180,  90],   // orange
    [140, 220, 255],   // sky cyan
    [160, 255, 220],   // mint
    [200, 170, 255],   // lavender
    [255, 130, 255],   // magenta
    [255, 255, 220],   // near-white cream
    [180, 255, 180],   // spring green
];

@ccclass('TwinkleStars')
export class TwinkleStars extends Component {

    @property({ range: [0, 400, 1], slide: true, tooltip: '星星数量（越多越密，性能开销线性）' })
    count: number = 80;

    @property({ range: [0.05, 2.0, 0.01], slide: true, tooltip: '单颗星星最小尺寸（世界单位）' })
    minSize: number = 0.15;

    @property({ range: [0.05, 2.0, 0.01], slide: true, tooltip: '单颗星星最大尺寸（世界单位）' })
    maxSize: number = 0.45;

    @property({ tooltip: '星星散布球心（相对场景原点）' })
    center: Vec3 = new Vec3(0, 15, -35);

    @property({ tooltip: '散布范围半宽（X 轴左右延伸）' })
    halfExtentX: number = 45;

    @property({ tooltip: '散布范围半高（Y 轴上下延伸）' })
    halfExtentY: number = 40;

    @property({ tooltip: '散布范围深度（Z 轴前后延伸，值越大越远离摄像机）' })
    halfExtentZ: number = 10;

    @property({ range: [0.0, 1.0, 0.01], slide: true, tooltip: '亮度基线（0=看不到, 1=常亮）' })
    baseAlpha: number = 0.55;

    @property({ range: [0.0, 1.0, 0.01], slide: true, tooltip: '闪烁振幅（叠加到基线上，>0 才会闪）' })
    twinkleAmplitude: number = 0.45;

    @property({ range: [0.1, 6.0, 0.05], slide: true, tooltip: '闪烁频率最小值（Hz）' })
    minTwinkleHz: number = 0.4;

    @property({ range: [0.1, 6.0, 0.05], slide: true, tooltip: '闪烁频率最大值（Hz）' })
    maxTwinkleHz: number = 1.8;

    @property({ range: [0.5, 20, 0.1], slide: true, tooltip: '每颗星星刷新位置的平均生命周期（秒），实际值有 ±jitter 抖动' })
    respawnLifetime: number = 3.0;

    @property({ range: [0.0, 1.0, 0.05], slide: true, tooltip: '生命周期抖动系数（0=所有星星齐步刷新，0.5=±50% 抖动）' })
    lifetimeJitter: number = 0.4;

    @property({ range: [0.05, 2.0, 0.05], slide: true, tooltip: '每次刷新时的淡入/淡出持续时间（秒）' })
    fadeDuration: number = 0.4;

    private root: Node | null = null;
    private texture: Texture2D | null = null;
    private sharedMesh: Mesh | null = null;

    private stars: Array<{
        node: Node;
        mat: Material;
        color: [number, number, number];
        phase: number;    // radians offset for sin()
        omega: number;    // radians/sec (2π × Hz)
        age: number;      // seconds since last respawn
        lifetime: number; // seconds — triggers respawn at age >= lifetime
    }> = [];

    private elapsed: number = 0;

    onLoad(): void {
        this.build();
        log(`[TwinkleStars] onLoad — spawned ${this.stars.length} stars`);
    }

    update(dt: number): void {
        if (this.stars.length === 0) return;
        this.elapsed += dt;
        for (const s of this.stars) {
            s.age += dt;
            // Respawn: relocate + reset when this star's lifetime ends.
            // Jittered per star so respawns aren't synchronized across
            // the whole cloud (would look like a strobe).
            if (s.age >= s.lifetime) {
                this.respawnStar(s);
            }
            // Per-star alpha = twinkle oscillation × fade envelope.
            // Envelope: fade in over `fadeDuration` seconds at birth,
            // fade out over `fadeDuration` seconds before death → no
            // popping at respawn boundaries.
            const wave = 0.5 + 0.5 * Math.sin(this.elapsed * s.omega + s.phase);
            let a = this.baseAlpha + this.twinkleAmplitude * (wave - 0.5) * 2;
            const fadeIn  = Math.min(1, s.age / this.fadeDuration);
            const fadeOut = Math.min(1, (s.lifetime - s.age) / this.fadeDuration);
            a *= Math.min(fadeIn, fadeOut);
            if (a < 0) a = 0;
            else if (a > 1) a = 1;
            s.mat.setProperty('mainColor', new Color(s.color[0], s.color[1], s.color[2], Math.round(a * 255)));
        }
    }

    /** Reset one star: pick a new random position, color, size, twinkle
     *  frequency/phase, and lifetime. Called on respawn (age >= lifetime)
     *  and on initial build (via a fake first respawn). */
    private respawnStar(s: TwinkleStars['stars'][number]): void {
        s.node.setPosition(
            this.center.x + (Math.random() * 2 - 1) * this.halfExtentX,
            this.center.y + (Math.random() * 2 - 1) * this.halfExtentY,
            this.center.z + (Math.random() * 2 - 1) * this.halfExtentZ,
        );
        const size = lerp(this.minSize, this.maxSize, Math.random());
        s.node.setScale(size, size, size);
        const c = STAR_PALETTE[Math.floor(Math.random() * STAR_PALETTE.length)];
        s.color[0] = c[0];
        s.color[1] = c[1];
        s.color[2] = c[2];
        const hz = lerp(this.minTwinkleHz, this.maxTwinkleHz, Math.random());
        s.omega = Math.PI * 2 * hz;
        s.phase = Math.random() * Math.PI * 2;
        s.age = 0;
        // Jittered lifetime so the cloud reshuffles gradually instead of
        // all stars flipping on the same frame.
        const jitter = (Math.random() * 2 - 1) * this.lifetimeJitter;
        s.lifetime = Math.max(0.5, this.respawnLifetime * (1 + jitter));
    }

    // ============================================================
    //  Build — spawns all stars once, at random positions.
    // ============================================================
    private build(): void {
        if (this.stars.length > 0) return;

        const root = new Node('TwinkleStarsRoot');
        root.parent = this.node.scene ?? this.node;
        root.layer  = this.node.layer;
        this.root = root;

        // Bumped from 32 → 64: 4-point sparkle needs the extra
        // resolution to render clean tapered spikes without aliasing.
        this.texture   = this.makeStarTexture(64);
        this.sharedMesh = this.makeQuadMesh(1, 1);

        for (let i = 0; i < this.count; i++) {
            const node = new Node(`Star_${i}`);
            node.parent = root;
            node.layer  = root.layer;

            const mr = node.addComponent(MeshRenderer);
            mr.mesh = this.sharedMesh;
            // Each star gets its own material instance so mainColor
            // can be animated independently. `builtin-unlit` technique
            // 1 = transparent additive-friendly blending.
            const mat = new Material();
            mat.initialize({
                effectName: 'builtin-unlit',
                technique:  1,
                defines:    { USE_TEXTURE: true },
            });
            mat.setProperty('mainTexture', this.texture);
            mr.material = mat;

            const star = {
                node, mat,
                color: [0, 0, 0] as [number, number, number],
                phase: 0,
                omega: 0,
                age: 0,
                lifetime: 1,
            };
            // Randomize everything via respawnStar (position, color,
            // size, twinkle, lifetime).
            this.respawnStar(star);
            // Stagger initial age so stars don't all hit end-of-life
            // on the same frame — pre-age each star by a random slice
            // of its lifetime so respawns spread evenly across the
            // first cycle.
            star.age = Math.random() * star.lifetime;

            this.stars.push(star);
        }
    }

    // ============================================================
    //  Procedural texture + mesh.
    // ============================================================

    /** Four-pointed sparkle star (spikes at 0°, 90°, 180°, 270° +
     *  bright core). Built from TWO overlapping triangular spikes
     *  (horizontal + vertical), each tapering from full thickness
     *  at the center to a sharp point at the axis tip. The previous
     *  `cos(4θ) × (1-r)` approach produced rounded lobes because
     *  the radial falloff smeared the tip pixels; the L1-triangle
     *  formulation below has actual pointed vertices at (±1, 0)
     *  and (0, ±1). Bright core dot fills the center. */
    private makeStarTexture(size: number): Texture2D {
        const buf   = new Uint8Array(size * size * 4);
        const cx    = (size - 1) / 2;
        const cy    = (size - 1) / 2;
        const rMax  = size / 2;
        // How thick the spikes are at the center (0..1 of radius).
        // Smaller = thinner arms, sharper look.
        const spikeThickness = 0.18;
        // Core dot radius (0..1). Fully-opaque bright center.
        const coreRadius = 0.14;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const nx = (x - cx) / rMax;   // [-1, 1] approx
                const ny = (y - cy) / rMax;
                const ax = Math.abs(nx);
                const ay = Math.abs(ny);
                let a = 0;

                // Horizontal spike: triangle with tips at (±1, 0),
                // base thickness = spikeThickness at nx=0, tapers to
                // 0 at |nx|=1 → sharp point.
                if (ax < 1) {
                    const halfH = spikeThickness * (1 - ax);
                    if (halfH > 0 && ay < halfH) {
                        // Soft edge across the vertical thickness.
                        a = 1 - ay / halfH;
                    }
                }
                // Vertical spike: same idea, tips at (0, ±1).
                if (ay < 1) {
                    const halfV = spikeThickness * (1 - ay);
                    if (halfV > 0 && ax < halfV) {
                        const v = 1 - ax / halfV;
                        if (v > a) a = v;
                    }
                }
                // Bright core dot in the middle so the intersection
                // of the two spikes reads solid.
                const r = Math.sqrt(nx * nx + ny * ny);
                if (r < coreRadius) {
                    const core = 1 - r / coreRadius;
                    if (core > a) a = core;
                }
                const i = (y * size + x) * 4;
                buf[i]     = 255;
                buf[i + 1] = 255;
                buf[i + 2] = 255;
                buf[i + 3] = Math.round(Math.min(1, a) * 255);
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
            normals:   [0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1],
            uvs:       [0, 1,  1, 1,  1, 0,  0, 0],
            indices:   [0, 1, 2, 0, 2, 3],
        });
    }

    onDestroy(): void {
        if (this.root && this.root.isValid) this.root.destroy();
        this.root = null;
        this.stars.length = 0;
    }
}

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}
