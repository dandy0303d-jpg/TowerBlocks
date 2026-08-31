/**
 * SettingsBackdropParticles — colorful 2D dots that continuously drift
 * around behind the settings panel. Each particle spawns at a random
 * position inside the container's bounds, picks a random tint from a
 * rainbow palette, tweens through a curved drift path (mixing linear
 * offset + rotation around a wandering center so trajectories read as
 * "orbit / spiral" rather than straight lines), fades in-out over its
 * lifetime, then respawns.
 *
 * Attach the component to any UI Node with a UITransform (the
 * container defines the spawn bounds). Particles are UI children so
 * they render behind whatever sibling nodes the panel has on top.
 * Toggle the whole effect by setting node.active — onDisable stops
 * further spawns + destroys in-flight particles.
 *
 * Zero @property configuration in the scene is required beyond
 * dragging the component onto a node; every parameter has a sensible
 * default and is exposed for tuning.
 */

import {
    _decorator,
    Component,
    Node,
    Sprite,
    SpriteFrame,
    Texture2D,
    UITransform,
    UIOpacity,
    Color,
    Vec3,
    tween,
} from 'cc';

const { ccclass, property } = _decorator;

@ccclass('SettingsBackdropParticles')
export class SettingsBackdropParticles extends Component {

    @property({ tooltip: '同时在屏幕上的粒子数量（越多越密）' })
    particleCount: number = 24;

    @property({ tooltip: '单个粒子最大尺寸（像素），实际每个粒子在 60%-100% 之间随机' })
    particleMaxSize: number = 28;

    @property({ tooltip: '单个粒子生命周期（秒）— 时长越长漂得越远' })
    particleLifetime: number = 5;

    @property({ tooltip: '粒子淡入时长占生命周期的比例（0-0.5 之间）' })
    fadeInFraction: number = 0.2;

    @property({ tooltip: '粒子淡出时长占生命周期的比例（0-0.5 之间）' })
    fadeOutFraction: number = 0.3;

    @property({ tooltip: '粒子最大 alpha（0-255）— 太高会盖住 UI；120-180 之间视觉最舒服' })
    peakAlpha: number = 160;

    @property({ tooltip: '图 8 轨迹在 X 方向的半宽（像素）— 越大摆动越远' })
    fig8HalfWidth: number = 100;

    @property({ tooltip: '图 8 轨迹在 Y 方向的半高（像素）' })
    fig8HalfHeight: number = 60;

    @property({ tooltip: '完成一次 8 字循环需要的秒数（越小转得越快）' })
    fig8PeriodSec: number = 4;

    @property({ tooltip: '每个粒子的自旋速度（度/秒）— 加在图 8 轨迹上的额外自转' })
    spinDegPerSec: number = 45;

    // ---- Trail ----
    @property({ tooltip: '拖尾开关 — 关闭则粒子无拖尾' })
    trailEnabled: boolean = true;

    @property({ tooltip: '拖尾间隔（毫秒）— 越小拖尾越密（越贵）' })
    trailSpawnIntervalMs: number = 55;

    @property({ tooltip: '单个拖尾点的生命周期（秒）— 越长拖尾越拉' })
    trailLifetimeSec: number = 0.55;

    @property({ tooltip: '拖尾点相对主粒子的尺寸倍数（0-1）' })
    trailSizeScale: number = 0.7;

    @property({ tooltip: '拖尾点起始 alpha（0-255）— 会淡出到 0' })
    trailStartAlpha: number = 140;

    @property({ tooltip: '拖尾彩虹模式 — 打开则拖尾点按调色板依次换色（主粒子仍是单色）；关闭则拖尾跟主粒子同色' })
    trailRainbow: boolean = true;

    // ---- Runtime ----
    private _particleFrame: SpriteFrame | null = null;
    private _running: boolean = false;
    private _timeoutHandles: Array<ReturnType<typeof setTimeout>> = [];

    /** Rainbow palette — 8 vivid tints (same one LogoShineParticles uses). */
    private static readonly RAINBOW_PALETTE: readonly Color[] = [
        new Color(255, 100, 120, 255),   // pink
        new Color(255, 160,  90, 255),   // orange
        new Color(255, 220, 100, 255),   // yellow
        new Color(140, 230, 130, 255),   // green
        new Color(100, 220, 230, 255),   // cyan
        new Color(120, 160, 255, 255),   // blue
        new Color(200, 130, 255, 255),   // purple
        new Color(255, 130, 220, 255),   // magenta
    ];

    onEnable(): void {
        this._running = true;
        // Kick off `particleCount` staggered spawns; each one loops via
        // setTimeout so we don't need an update() heartbeat.
        for (let i = 0; i < this.particleCount; i++) {
            const staggerMs = Math.floor((i / this.particleCount) * this.particleLifetime * 1000);
            this._schedule(() => this._loopSpawn(), staggerMs);
        }
    }

    onDisable(): void {
        this._running = false;
        for (const h of this._timeoutHandles) clearTimeout(h);
        this._timeoutHandles.length = 0;
        // Destroy any in-flight particles + trails so alpha tweens
        // don't leak past disable.
        const kids = this.node.children.slice();
        for (const k of kids) {
            if (!k || !k.isValid) continue;
            if (k.name === 'SBP_particle' || k.name === 'SBP_trail') k.destroy();
        }
    }

    private _schedule(fn: () => void, delayMs: number): void {
        const h = setTimeout(() => {
            this._timeoutHandles = this._timeoutHandles.filter(x => x !== h);
            if (this._running && this.node && this.node.isValid) fn();
        }, delayMs);
        this._timeoutHandles.push(h);
    }

    /** Spawn one particle, then queue the next spawn after its lifetime. */
    private _loopSpawn(): void {
        this._spawnOne();
        // Re-queue after the same lifetime so the total on-screen count
        // stays roughly `particleCount`.
        const nextMs = Math.floor(this.particleLifetime * 1000);
        this._schedule(() => this._loopSpawn(), nextMs);
    }

    /** Per-particle motion state — attached via node.userData so the
     *  update() loop can walk children and compute figure-8 offsets
     *  without needing a parallel Map. */
    private static readonly _MOTION_KEY = '__sbpMotion';

    private _spawnOne(): void {
        const parentUI = this.node.getComponent(UITransform);
        if (!parentUI) return;
        const w = parentUI.contentSize.width;
        const h = parentUI.contentSize.height;
        // Random figure-8 anchor inside container bounds (this is the
        // CENTER of the ∞ that the particle traces).
        const anchorX = (Math.random() - 0.5) * w * 0.7;
        const anchorY = (Math.random() - 0.5) * h * 0.7;
        // Random size + colour.
        const size = this.particleMaxSize * (0.6 + Math.random() * 0.4);
        const color = SettingsBackdropParticles.RAINBOW_PALETTE[
            Math.floor(Math.random() * SettingsBackdropParticles.RAINBOW_PALETTE.length)
        ];
        const life = Math.max(0.5, this.particleLifetime);
        const fadeInSec  = life * Math.max(0, Math.min(0.5, this.fadeInFraction));
        const fadeOutSec = life * Math.max(0, Math.min(0.5, this.fadeOutFraction));
        const holdSec    = Math.max(0.1, life - fadeInSec - fadeOutSec);
        // Random figure-8 tuning per particle so a bunch of them don't
        // trace identical ∞ shapes on top of each other.
        const wAmp = this.fig8HalfWidth  * (0.7 + Math.random() * 0.6);
        const hAmp = this.fig8HalfHeight * (0.7 + Math.random() * 0.6);
        const period = this.fig8PeriodSec * (0.7 + Math.random() * 0.6);
        const phase  = Math.random() * Math.PI * 2;     // where on the ∞ to start
        const dirSign = Math.random() < 0.5 ? -1 : 1;   // half CW, half CCW
        // Optional rotation of the whole figure-8 so ∞ is not always horizontal.
        const orient = Math.random() * Math.PI;

        const p = new Node('SBP_particle');
        p.parent = this.node;
        p.layer  = this.node.layer;
        const ui = p.addComponent(UITransform);
        ui.setAnchorPoint(0.5, 0.5);
        ui.setContentSize(size, size);
        p.setPosition(anchorX, anchorY, 0);
        const spr = p.addComponent(Sprite);
        spr.type = Sprite.Type.SIMPLE;
        spr.sizeMode = Sprite.SizeMode.CUSTOM;
        spr.spriteFrame = this._getOrBuildFrame();
        // Sprite tint fully opaque; fade lives on UIOpacity.
        spr.color = new Color(color.r, color.g, color.b, 255);
        ui.setContentSize(size, size);
        const op = p.addComponent(UIOpacity);
        op.opacity = 0;

        // Alpha lifecycle via UIOpacity tween.
        tween(op)
            .to(fadeInSec,  { opacity: this.peakAlpha })
            .delay(holdSec)
            .to(fadeOutSec, { opacity: 0 })
            .call(() => { if (p.isValid) p.destroy(); })
            .start();

        // Stash motion params on the node — update() reads them each
        // frame. Cast around Cocos' Node typing.
        (p as any)[SettingsBackdropParticles._MOTION_KEY] = {
            anchorX, anchorY,
            wAmp, hAmp, period, phase, dirSign, orient,
            spinRate: this.spinDegPerSec * dirSign,
            elapsed: 0,
            // Trail bookkeeping
            color, size,
            trailAccumMs: 0,
        };
    }

    /** Spawn one short-lived trail dot at (x,y) with the given colour
     *  + smaller size. Fades from `trailStartAlpha` → 0 over
     *  `trailLifetimeSec` then destroys itself. Cheap: one Node + one
     *  Sprite + one UIOpacity tween each. */
    private _spawnTrailDot(x: number, y: number, color: Color, baseSize: number): void {
        const size = baseSize * this.trailSizeScale;
        const t = new Node('SBP_trail');
        t.parent = this.node;
        t.layer  = this.node.layer;
        const ui = t.addComponent(UITransform);
        ui.setAnchorPoint(0.5, 0.5);
        ui.setContentSize(size, size);
        t.setPosition(x, y, 0);
        const spr = t.addComponent(Sprite);
        spr.type = Sprite.Type.SIMPLE;
        spr.sizeMode = Sprite.SizeMode.CUSTOM;
        spr.spriteFrame = this._getOrBuildFrame();
        spr.color = new Color(color.r, color.g, color.b, 255);
        ui.setContentSize(size, size);
        const op = t.addComponent(UIOpacity);
        op.opacity = this.trailStartAlpha;
        tween(op)
            .to(this.trailLifetimeSec, { opacity: 0 }, { easing: 'quadOut' })
            .call(() => { if (t.isValid) t.destroy(); })
            .start();
    }

    /** Per-frame walk over all particle children — compute the ∞
     *  position from parametric equations and write it in-place.
     *  Rotation is elapsed × spin rate (independent of the ∞ orbit). */
    update(dt: number): void {
        if (!this._running) return;
        const kids = this.node.children;
        for (let i = 0; i < kids.length; i++) {
            const p = kids[i];
            if (!p || !p.isValid || p.name !== 'SBP_particle') continue;
            const m = (p as any)[SettingsBackdropParticles._MOTION_KEY];
            if (!m) continue;
            m.elapsed += dt;
            // Lemniscate (figure-8) parametric — Gerono form:
            //   x(t) = A * sin(t)
            //   y(t) = B * sin(t) * cos(t) = (B/2) * sin(2t)
            const t = m.phase + m.dirSign * (m.elapsed / m.period) * Math.PI * 2;
            const lx = m.wAmp * Math.sin(t);
            const ly = m.hAmp * Math.sin(t) * Math.cos(t);
            // Rotate ∞ around its anchor by `orient` so not every
            // figure-8 lies flat horizontally.
            const co = Math.cos(m.orient), so = Math.sin(m.orient);
            const rx =  lx * co - ly * so;
            const ry =  lx * so + ly * co;
            const finalX = m.anchorX + rx;
            const finalY = m.anchorY + ry;
            p.setPosition(finalX, finalY, 0);
            p.setRotationFromEuler(0, 0, m.elapsed * m.spinRate);
            // Trail: drop a fading dot every `trailSpawnIntervalMs`.
            // In rainbow mode, each successive dot picks the NEXT
            // colour from the palette — the wisp behind the main
            // particle reads as a smoothly shifting rainbow tail
            // instead of a monochrome smear. The main particle keeps
            // its own single hue for identity.
            if (this.trailEnabled) {
                m.trailAccumMs = (m.trailAccumMs || 0) + dt * 1000;
                while (m.trailAccumMs >= this.trailSpawnIntervalMs) {
                    m.trailAccumMs -= this.trailSpawnIntervalMs;
                    let trailColor = m.color;
                    if (this.trailRainbow) {
                        m.trailColorIdx = ((m.trailColorIdx ?? 0) + 1)
                            % SettingsBackdropParticles.RAINBOW_PALETTE.length;
                        trailColor = SettingsBackdropParticles.RAINBOW_PALETTE[m.trailColorIdx];
                    }
                    this._spawnTrailDot(finalX, finalY, trailColor, m.size);
                }
            }
        }
    }

    /** Build the shared radial-gradient particle texture once. */
    private _getOrBuildFrame(): SpriteFrame {
        if (this._particleFrame) return this._particleFrame;
        const size = 32;
        const data = new Uint8Array(size * size * 4);
        const cx = (size - 1) / 2, cy = (size - 1) / 2, maxR = size / 2;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const dx = x - cx, dy = y - cy;
                const r = Math.sqrt(dx * dx + dy * dy);
                let a = 1 - r / maxR;
                if (a < 0) a = 0;
                a = a * a;
                const i = (y * size + x) * 4;
                data[i    ] = 255;
                data[i + 1] = 255;
                data[i + 2] = 255;
                data[i + 3] = Math.round(a * 255);
            }
        }
        const tex = new Texture2D();
        tex.reset({ width: size, height: size, format: Texture2D.PixelFormat.RGBA8888 });
        tex.uploadData(data);
        const frame = new SpriteFrame();
        frame.texture = tex;
        this._particleFrame = frame;
        return frame;
    }
}
