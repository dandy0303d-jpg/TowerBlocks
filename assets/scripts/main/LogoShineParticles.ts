/**
 * LogoShineParticles — reusable 2D particle burst emitter, extracted
 * from LogoShine so the particles can live on a NODE OUTSIDE the logo
 * hierarchy. When the emitter node was a child of the logo, the logo's
 * pulse tween scaled the particles too — visually wrong (particles
 * should be a static-scale trail, not a bouncing set of dots).
 *
 * Attach this component to a UI node placed WHEREVER you want the
 * particle strip to appear (typically just below the logo). Give the
 * node whatever UITransform width/height matches the desired strip
 * dimensions — particles spawn along `-w/2 .. +w/2` in the node's own
 * local space, staggered over the emit duration, and drift downward
 * from y=0 (top-anchored strip is the natural layout).
 *
 * The controller (e.g. LogoShine) triggers emission by calling
 * `emit(durationSec)`. Each `emit` call spawns `particleCount` dots,
 * each with random size / jitter / drift; nodes destroy themselves at
 * lifetime end. All auxiliary state (generated white-dot SpriteFrame,
 * in-flight tweens) is torn down in `onDisable` so this can be safely
 * disabled and re-enabled.
 */

import {
    _decorator,
    Component,
    Node,
    Sprite,
    SpriteFrame,
    UITransform,
    Color,
    Texture2D,
    Vec3,
    tween,
    Tween,
} from 'cc';

const { ccclass, property } = _decorator;

@ccclass('LogoShineParticles')
export class LogoShineParticles extends Component {

    @property({ tooltip: '每次 emit 喷出的粒子总数（分批沿宽度播撒）' })
    particleCount: number = 14;

    @property({ tooltip: '粒子最大半径（像素）— 实际大小在 [2, max] 之间随机' })
    particleMaxSize: number = 7;

    @property({ tooltip: '粒子存活时间（秒）— 淡入到消失的总时长' })
    particleLifetime: number = 0.9;

    @property({ tooltip: '粒子向下方漂移的最大距离（像素）— 实际 0.6-1× 之间随机' })
    particleFallDistance: number = 32;

    @property({ tooltip: '粒子水平漂移的最大幅度（像素）— 各粒子在 ±half 内随机取一个值' })
    particleHorizontalDrift: number = 40;

    @property({ type: Color, tooltip: '粒子颜色（alpha 值会被淡入/淡出覆盖）' })
    particleColor: Color = new Color(255, 255, 255, 255);

    @property({ tooltip: 'spawn x 附近的水平抖动幅度（像素）— 让粒子不整齐排列' })
    spawnJitterX: number = 12;

    @property({ tooltip: 'spawn y 附近的向下抖动幅度（像素）— 起始位置在 [-jitter, 0] 之间' })
    spawnJitterY: number = 6;

    /** Cached radial-gradient white-dot texture. Built lazily on first
     *  `emit`, shared across ALL particles so Cocos can dynamic-batch
     *  them into one draw call. Released on disable. */
    private particleFrame: SpriteFrame | null = null;

    onDisable(): void {
        // Destroy any in-flight particle nodes still under this one.
        // Iterate a copy of children — `destroy()` mutates the live
        // array. Each destroy also cancels the child's tweens.
        const kids = this.node.children.slice();
        for (const k of kids) {
            if (k.name === 'LogoShine_P' && k.isValid) k.destroy();
        }
        this.particleFrame = null;
    }

    // ============================================================
    //  Public API
    // ============================================================

    /** Spawn `particleCount` dots along the emitter's own width over
     *  `durationSec` — controller calls this at the moment the sheen
     *  starts sweeping. Each particle's spawn time is staggered by
     *  index so the trail READS as "following the sheen" instead of
     *  bursting all at once. */
    public emit(durationSec: number): void {
        const parentUI = this.node.getComponent(UITransform);
        if (!parentUI) return;
        const w = parentUI.contentSize.width;
        // Match LogoShine's sweep endpoints (0.9× of half-width) so the
        // spawn line lines up with where the sheen visibly travels.
        const startX = -w * 0.45;
        const endX   =  w * 0.45;
        const frame = this.getOrBuildParticleFrame();
        const N = Math.max(1, Math.floor(this.particleCount));
        for (let i = 0; i < N; i++) {
            // Stagger by index across the emit duration.
            const t = i / Math.max(1, N - 1);
            const delayMs = t * Math.max(0, durationSec) * 1000;
            const jitterX = (Math.random() - 0.5) * this.spawnJitterX * 2;
            const jitterY = -Math.random() * this.spawnJitterY;
            const spawnX  = startX + (endX - startX) * t + jitterX;
            const spawnY  = jitterY;
            setTimeout(() => this.spawnOneParticle(frame, spawnX, spawnY), delayMs);
        }
    }

    // ============================================================
    //  Internals
    // ============================================================

    /** Build (once) a 32×32 white radial gradient — bright centre,
     *  transparent edge — for the shared particle SpriteFrame. */
    private getOrBuildParticleFrame(): SpriteFrame {
        if (this.particleFrame) return this.particleFrame;
        const size = 32;
        const data = new Uint8Array(size * size * 4);
        const cx = (size - 1) / 2;
        const cy = (size - 1) / 2;
        const maxR = size / 2;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const dx = x - cx;
                const dy = y - cy;
                const r  = Math.sqrt(dx * dx + dy * dy);
                let a = 1 - r / maxR;
                if (a < 0) a = 0;
                a = a * a;                          // steeper radial falloff
                const i = (y * size + x) * 4;
                data[i    ] = 255;
                data[i + 1] = 255;
                data[i + 2] = 255;
                data[i + 3] = Math.min(255, Math.floor(a * 255));
            }
        }
        const tex = new Texture2D();
        tex.reset({
            width:  size,
            height: size,
            format: Texture2D.PixelFormat.RGBA8888,
        });
        tex.uploadData(data);
        const frame = new SpriteFrame();
        frame.texture = tex;
        this.particleFrame = frame;
        return frame;
    }

    /** Create one particle Node under this emitter and start its
     *  fade-in / drift / fade-out tweens. Destroys the node on
     *  completion so we don't accumulate garbage. */
    private spawnOneParticle(frame: SpriteFrame, x: number, y: number): void {
        if (!this.node || !this.node.isValid) return;
        const p = new Node('LogoShine_P');
        p.parent = this.node;
        p.layer  = this.node.layer;
        const size = 2 + Math.random() * Math.max(2, this.particleMaxSize - 2);
        const ui = p.addComponent(UITransform);
        ui.setContentSize(size, size);
        ui.setAnchorPoint(0.5, 0.5);
        p.setPosition(x, y, 0);
        const s = p.addComponent(Sprite);
        s.type = Sprite.Type.SIMPLE;
        s.sizeMode = Sprite.SizeMode.CUSTOM;
        s.spriteFrame = frame;
        // Starting colour: whatever's set on the emitter, but alpha
        // forced to 0 so the fade-in tween takes it to full opacity.
        const c = this.particleColor;
        s.color = new Color(c.r, c.g, c.b, 0);
        const driftX = (Math.random() - 0.5) * this.particleHorizontalDrift;
        const fallY  = -this.particleFallDistance * (0.6 + Math.random() * 0.4);
        const life   = Math.max(0.1, this.particleLifetime);
        const fadeInSec = Math.min(0.12, life * 0.15);
        // Two parallel tweens: colour (fade in → fade out) + position (drift).
        tween(s)
            .to(fadeInSec,        { color: new Color(c.r, c.g, c.b, 255) }, { easing: 'quadOut' })
            .to(life - fadeInSec, { color: new Color(c.r, c.g, c.b, 0)   }, { easing: 'quadIn'  })
            .start();
        tween(p)
            .by(life, { position: new Vec3(driftX, fallY, 0) }, { easing: 'sineOut' })
            .call(() => { if (p.isValid) p.destroy(); })
            .start();
    }
}
