/**
 * EventButtonSparkles — small glowing 2D sparkle particles that
 * continuously twinkle around a UI node (built for the newbie-14-day
 * event button but works on any UI node with a UITransform).
 *
 * Design borrows from SettingsBackdropParticles:
 *   - No art asset — builds a shared radial-gradient particle texture
 *     once via a Uint8Array (32×32 white circle with soft alpha).
 *   - Each particle is a plain Node + Sprite + UIOpacity, spawned at
 *     a random ring position, tinted gold, fades in → holds → fades
 *     out → destroys itself.
 *   - Particles auto-suspend / resume with the host node — attaching
 *     as CHILDREN of the host means Cocos's action manager pauses
 *     tweens when the host goes inactive.
 *
 * Attach: add the component to the event button node — no @property
 * wiring required, defaults look fine for the ~110×110 icon. If you
 * want to attach to a bigger anchor (say a card or badge), tweak
 * ringRadius in the inspector.
 *
 * Runtime cost: ~particleCount live Sprites + one radial texture
 * shared across all instances. At the default 8 particles this is
 * essentially free.
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

@ccclass('EventButtonSparkles')
export class EventButtonSparkles extends Component {

    @property({ tooltip: '同时在屏幕上的粒子数量' })
    particleCount: number = 8;

    @property({ tooltip: '粒子最大尺寸（像素），实际每颗在 60%-100% 之间随机' })
    particleMaxSize: number = 40;

    @property({ tooltip: '粒子生命周期（秒）' })
    particleLifetime: number = 1.4;

    @property({ tooltip: '粒子淡入时长占生命周期的比例（0-0.5）' })
    fadeInFraction: number = 0.25;

    @property({ tooltip: '粒子淡出时长占生命周期的比例（0-0.5）' })
    fadeOutFraction: number = 0.35;

    @property({ tooltip: '粒子峰值 alpha（0-255）' })
    peakAlpha: number = 235;

    @property({ tooltip: '环形分布半径（像素）— 粒子生成在以按钮中心为圆心、该半径的圆环上' })
    ringRadius: number = 90;

    @property({ tooltip: '环形宽度（像素）— 粒子在 (radius ± width/2) 范围内随机' })
    ringWidth: number = 30;

    @property({ tooltip: '粒子生成后向外漂移的距离（像素）— 0 关闭漂移' })
    driftOutward: number = 12;

    @property({ tooltip: '粒子自转最大速度（度/秒）— 加点旋转让 sparkle 有生气' })
    spinDegPerSec: number = 90;

    // ---- Runtime ----
    private static _sharedFrame: SpriteFrame | null = null;
    private _running: boolean = false;
    private _timeoutHandles: Array<ReturnType<typeof setTimeout>> = [];
    /** Pool of sparkle Nodes — created once in onEnable, reused for
     *  every cycle. Skips the per-cycle Node/Sprite/UIOpacity allocation
     *  cost and prevents UI batcher rebuilds that were causing the
     *  button's pulse tween to feel janky on lower-end devices. */
    private _pool: Node[] = [];

    /** Gold palette — 4 shades so successive particles don't look
     *  identical. All warm to match the "reward / celebration" tone. */
    private static readonly PALETTE: readonly Color[] = [
        new Color(255, 235, 130, 255),   // pale gold
        new Color(255, 210,  80, 255),   // bright gold
        new Color(255, 180,  60, 255),   // orange gold
        new Color(255, 255, 200, 255),   // near-white
    ];

    onEnable(): void {
        this._running = true;
        // Build the pool once. Each sparkle starts hidden (opacity 0)
        // and gets picked up by the loop below on first "spawn".
        for (let i = 0; i < this.particleCount; i++) {
            this._pool.push(this._buildPooledSparkle(i));
        }
        // Stagger initial cycles across one lifetime so the ring
        // instantly has a full population instead of an empty → full
        // ramp on first show.
        for (let i = 0; i < this.particleCount; i++) {
            const staggerMs = Math.floor((i / this.particleCount) * this.particleLifetime * 1000);
            const idx = i;
            this._schedule(() => this._loopCycle(idx), staggerMs);
        }
    }

    onDisable(): void {
        this._running = false;
        for (const h of this._timeoutHandles) clearTimeout(h);
        this._timeoutHandles.length = 0;
        // Stop tweens on every pooled sparkle + hide via opacity so a
        // re-enable finds them clean. Don't destroy — the pool survives
        // enable/disable cycles and re-populating it every time was
        // itself a source of the jank.
        for (const p of this._pool) {
            if (!p || !p.isValid) continue;
            tween(p).stop();
            const op = p.getComponent(UIOpacity);
            if (op) { tween(op).stop(); op.opacity = 0; }
        }
    }

    onDestroy(): void {
        // Real teardown — component being removed / node destroyed.
        // Pool nodes are children of this.node so Cocos will destroy
        // them automatically; just null out our refs.
        this._pool.length = 0;
    }

    private _schedule(fn: () => void, delayMs: number): void {
        const h = setTimeout(() => {
            this._timeoutHandles = this._timeoutHandles.filter(x => x !== h);
            if (this._running && this.node && this.node.isValid) fn();
        }, delayMs);
        this._timeoutHandles.push(h);
    }

    /** Build a single pooled sparkle Node with all components in
     *  place. Called exactly `particleCount` times per enable cycle;
     *  after this the runtime never allocates a Node or Component. */
    private _buildPooledSparkle(idx: number): Node {
        const p = new Node(`EBS_sparkle_${idx}`);
        p.parent = this.node;
        p.layer  = this.node.layer;
        const ui = p.addComponent(UITransform);
        ui.setAnchorPoint(0.5, 0.5);
        const spr = p.addComponent(Sprite);
        spr.type = Sprite.Type.SIMPLE;
        spr.sizeMode = Sprite.SizeMode.CUSTOM;
        spr.spriteFrame = EventButtonSparkles._getOrBuildFrame();
        const op = p.addComponent(UIOpacity);
        op.opacity = 0;
        return p;
    }

    /** Reset a pooled sparkle to fresh random state and run one
     *  fade-in / hold / fade-out cycle. On completion, re-queues
     *  itself — no `.destroy()` and no Node allocation. */
    private _loopCycle(poolIdx: number): void {
        const p = this._pool[poolIdx];
        if (!p || !p.isValid || !this._running) return;

        // Ring position — angle uniformly distributed, radius jittered
        // within ringWidth so it's a fuzzy annulus not a hard circle.
        const angle  = Math.random() * Math.PI * 2;
        const radius = this.ringRadius + (Math.random() - 0.5) * this.ringWidth;
        const sx = Math.cos(angle) * radius;
        const sy = Math.sin(angle) * radius;
        const drift = this.driftOutward;
        const ex = sx + Math.cos(angle) * drift;
        const ey = sy + Math.sin(angle) * drift;

        const size = this.particleMaxSize * (0.6 + Math.random() * 0.4);
        const color = EventButtonSparkles.PALETTE[
            Math.floor(Math.random() * EventButtonSparkles.PALETTE.length)
        ];
        const life = Math.max(0.4, this.particleLifetime);
        const fadeInSec  = life * Math.max(0, Math.min(0.5, this.fadeInFraction));
        const fadeOutSec = life * Math.max(0, Math.min(0.5, this.fadeOutFraction));
        const holdSec    = Math.max(0.05, life - fadeInSec - fadeOutSec);
        const dir = Math.random() < 0.5 ? -1 : 1;
        const totalDeg = this.spinDegPerSec * life * dir;

        // Reset — cheap property writes, no allocations.
        const ui = p.getComponent(UITransform)!;
        ui.setContentSize(size, size);
        p.setPosition(sx, sy, 0);
        p.setRotationFromEuler(0, 0, 0);
        const spr = p.getComponent(Sprite)!;
        spr.color = new Color(color.r, color.g, color.b, 255);
        const op = p.getComponent(UIOpacity)!;
        op.opacity = 0;

        // Kill any lingering tween on the node/opacity from a
        // previous cycle (paranoia — the previous cycle's tween chain
        // should have ended before the schedule fired, but a stop()
        // is O(1) and guards against a re-enable overlap).
        tween(p).stop();
        tween(op).stop();

        // Alpha lifecycle — on completion re-queue same pool slot.
        tween(op)
            .to(fadeInSec,  { opacity: this.peakAlpha }, { easing: 'quadOut' })
            .delay(holdSec)
            .to(fadeOutSec, { opacity: 0 }, { easing: 'quadIn' })
            .call(() => {
                if (this._running) this._loopCycle(poolIdx);
            })
            .start();

        // Drift outward + rotation over the full lifetime.
        if (drift !== 0) {
            tween(p)
                .to(life, { position: new Vec3(ex, ey, 0) }, { easing: 'quadOut' })
                .start();
        }
        tween(p)
            .by(life, { eulerAngles: new Vec3(0, 0, totalDeg) })
            .start();
    }

    /** Shared radial-gradient sprite frame (built once, reused across
     *  every EventButtonSparkles instance on the scene). Same trick as
     *  SettingsBackdropParticles — a 32×32 RGBA texture with alpha
     *  falling off as (1 - r/R)². Feels like a soft glow, not a hard
     *  disc. */
    private static _getOrBuildFrame(): SpriteFrame {
        if (EventButtonSparkles._sharedFrame) return EventButtonSparkles._sharedFrame;
        const size = 32;
        const data = new Uint8Array(size * size * 4);
        const cx = (size - 1) / 2, cy = (size - 1) / 2, maxR = size / 2;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                const dx = x - cx, dy = y - cy;
                const r = Math.sqrt(dx * dx + dy * dy);
                let a = 1 - r / maxR;
                if (a < 0) a = 0;
                a = a * a;   // soft edge
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
        EventButtonSparkles._sharedFrame = frame;
        return frame;
    }
}
