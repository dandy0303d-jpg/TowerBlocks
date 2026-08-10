/**
 * LogoShine — periodic diagonal "specular sweep" over a Sprite (the
 * game logo, typically). Simulates a mirror-like sheen flashing across
 * the image every few seconds, plus an optional logo pulse (scale up
 * during the sweep, ease back after) and a 2D particle trail.
 *
 * Attach the component to any UI Sprite node. On enable it programmatically
 * builds:
 *
 *   <target Sprite node>
 *     └── LogoShine_Mask   (SPRITE_STENCIL, same SpriteFrame as target)
 *          └── LogoShine_Bar  (white gradient rectangle, rotated)
 *
 * The Mask clips the sheen bar to the exact silhouette of the target
 * sprite's alpha channel, so the sweep only shows over the visible
 * text / shape and never leaks into surrounding transparent pixels.
 * The bar then tweens horizontally from off-screen-left to off-screen-
 * right in `sweepDuration` seconds, waits `interval` seconds, repeats.
 *
 * Particles are handled by a SEPARATE `LogoShineParticles` component
 * on a DIFFERENT node — kept off the logo hierarchy on purpose so the
 * logo's pulse tween doesn't propagate scale to the particles. Drag
 * that component into the `particles` @property below to wire them up.
 *
 * All auxiliary nodes / textures are destroyed on disable, so the
 * component can be flipped off cleanly (e.g. hiding the main menu).
 */

import {
    _decorator,
    Component,
    Node,
    Sprite,
    SpriteFrame,
    UITransform,
    Mask,
    Color,
    Texture2D,
    Vec3,
    tween,
    Tween,
} from 'cc';
import { LogoShineParticles } from './LogoShineParticles';

const { ccclass, property } = _decorator;

@ccclass('LogoShine')
export class LogoShine extends Component {

    @property({ tooltip: '两次闪光之间的间隔（秒）— 数值越大越安静' })
    interval: number = 3.5;

    @property({ tooltip: '一次闪光扫过的时长（秒）' })
    sweepDuration: number = 0.55;

    @property({ tooltip: '光带宽度占 logo 宽度的比例（0-1）— 0.15-0.25 之间视觉最舒服' })
    barWidthRatio: number = 0.2;

    @property({ tooltip: '光带倾斜角度（度）— 负值向左倾斜，正值向右' })
    tiltDegrees: number = -20;

    @property({ tooltip: '光带最大不透明度（0-255）' })
    peakAlpha: number = 220;

    @property({ tooltip: '首次闪光的延迟（秒）— 让页面刚加载时安静一小段' })
    initialDelay: number = 1.0;

    // ---- particles (external component — attach LogoShineParticles to a
    //       node OUTSIDE the logo hierarchy so the logo's pulse tween
    //       doesn't scale the particles too) ----
    @property({ type: LogoShineParticles, tooltip: '粒子发射器（LogoShineParticles 组件）— 挂到 logo 外的独立节点上，粒子就不会跟着 logo 缩放；不拖也可以，只是没粒子' })
    particles: LogoShineParticles | null = null;

    // ---- pulse (scale the whole logo up briefly during each sweep) ----
    @property({ tooltip: '光带扫过时 logo 放大的倍数（相对于原尺寸）— 1.0 = 不缩放，1.05 = 放大 5%' })
    pulseScale: number = 1.06;

    @property({ tooltip: 'logo 缩放到峰值的时长（秒）— 短一点会更"弹"' })
    pulseUpDuration: number = 0.18;

    @property({ tooltip: 'logo 从峰值恢复到原尺寸的时长（秒）— 稍长一点更自然' })
    pulseDownDuration: number = 0.35;

    // ---- runtime state ----
    private maskNode: Node | null = null;
    private shineBar: Node | null = null;
    private sweepTimer: any = null;
    private generatedFrame: SpriteFrame | null = null;
    /** Captured on `onEnable` so pulse-back never leaves the logo at
     *  the wrong resting scale — even if the designer changed the
     *  logo's base scale in the editor away from 1. */
    private baseScale: Vec3 = new Vec3(1, 1, 1);

    onEnable(): void {
        // Snapshot the logo's resting scale so the pulse-back tween
        // always returns to exactly this value (not to a hardcoded 1).
        const s = this.node.scale;
        this.baseScale.set(s.x, s.y, s.z);
        this.setupOverlay();
        this.scheduleNext(this.initialDelay);
    }

    onDisable(): void {
        if (this.sweepTimer !== null) {
            clearTimeout(this.sweepTimer);
            this.sweepTimer = null;
        }
        if (this.shineBar) {
            Tween.stopAllByTarget(this.shineBar);
        }
        // Cancel any in-flight pulse tween and snap the logo back to
        // its resting scale so a mid-pulse teardown doesn't freeze it
        // at 1.06× (or whatever the peak was).
        Tween.stopAllByTarget(this.node);
        this.node.setScale(this.baseScale);
        if (this.maskNode) {
            this.maskNode.destroy();
            this.maskNode = null;
            this.shineBar = null;
        }
        if (this.generatedFrame) {
            this.generatedFrame = null;   // let GC pick up the SpriteFrame + Texture2D
        }
    }

    // ============================================================
    //  Setup
    // ============================================================

    private setupOverlay(): void {
        const parentUI     = this.node.getComponent(UITransform);
        const parentSprite = this.node.getComponent(Sprite);
        if (!parentUI || !parentSprite || !parentSprite.spriteFrame) {
            // Target isn't a Sprite (or SpriteFrame not set yet). Bail
            // — nothing to shine over.
            return;
        }
        const w = parentUI.contentSize.width;
        const h = parentUI.contentSize.height;

        // ---- Mask node (child of target) ----
        // Same size + SpriteFrame as the target so its alpha silhouette
        // matches the visible logo pixels exactly. Cocos 3.x Mask draws
        // its stencil directly from the `spriteFrame` property — DO NOT
        // add a separate Sprite component; on Android that combo can
        // leave the shape unstencilled (the extra Sprite renders visibly
        // AND the mask's own stencil pass gets skipped, so the child
        // ShineBar shows unclipped).
        const mask = new Node('LogoShine_Mask');
        mask.parent = this.node;
        mask.layer  = this.node.layer;   // inherit UI_2D layer
        const maskUI = mask.addComponent(UITransform);
        maskUI.setContentSize(w, h);
        maskUI.setAnchorPoint(0.5, 0.5);
        mask.setPosition(0, 0, 0);
        const maskComp = mask.addComponent(Mask);
        // Enum name drift across Cocos versions:
        //   3.8+ : SPRITE_STENCIL
        //   ≤3.7 : IMAGE_STENCIL
        // Pick whichever the runtime exposes so the same source works
        // for editor / iOS / Android without version-specific tweaks.
        const stencilType =
            (Mask.Type as any).SPRITE_STENCIL
            ?? (Mask.Type as any).IMAGE_STENCIL;
        maskComp.type = stencilType;
        // `spriteFrame` is the actual stencil source for Mask —
        // typed as `any` because the setter's presence varies by
        // Cocos version, but every SPRITE / IMAGE STENCIL build has it.
        (maskComp as any).spriteFrame = parentSprite.spriteFrame;
        // Higher threshold (0.1) instead of 0.05 — some Android GPU
        // drivers have precision issues near 0 that let too many
        // borderline-alpha pixels through, letting the shine bar leak
        // outside the logo silhouette. 0.1 is well above the noise
        // floor without visibly biting into antialiased text edges.
        (maskComp as any).alphaThreshold = 0.1;

        // ---- Shine bar (grand-child of target) ----
        // A tall, narrow, tilted white gradient. Tween its X across
        // the parent's width and let the mask clip it to the logo shape.
        const bar = new Node('LogoShine_Bar');
        bar.parent = mask;
        bar.layer  = this.node.layer;
        const barUI = bar.addComponent(UITransform);
        const barW  = Math.max(8, w * this.barWidthRatio);
        // Extra height so tilt + diagonal sweep never leaves a triangular
        // gap at the top / bottom of the logo.
        const barH  = Math.max(w, h) * 2;
        barUI.setContentSize(barW, barH);
        barUI.setAnchorPoint(0.5, 0.5);
        bar.setRotationFromEuler(0, 0, this.tiltDegrees);
        // Start off-screen to the LEFT so the very first sweep starts
        // cleanly outside the logo.
        bar.setPosition(-w, 0, 0);

        const barSprite = bar.addComponent(Sprite);
        barSprite.type = Sprite.Type.SIMPLE;
        barSprite.sizeMode = Sprite.SizeMode.CUSTOM;
        barSprite.spriteFrame = this.getOrBuildShineFrame();
        barSprite.color = new Color(255, 255, 255, this.peakAlpha);

        this.maskNode = mask;
        this.shineBar = bar;
        // Particles are handled by an EXTERNAL LogoShineParticles
        // component (see `this.particles` @property). Nothing to build
        // under the logo — that's the whole point of the split: keeping
        // particles off the logo hierarchy means the pulse tween's
        // scale doesn't propagate to them.
    }

    /** Build a 128x1 horizontal gradient texture (transparent → white
     *  → transparent) once, and cache it as a SpriteFrame. Reused
     *  across enable / disable cycles as long as this component
     *  instance lives. */
    private getOrBuildShineFrame(): SpriteFrame {
        if (this.generatedFrame) return this.generatedFrame;
        const w = 128, h = 1;
        const data = new Uint8Array(w * h * 4);
        for (let x = 0; x < w; x++) {
            const t = x / (w - 1);
            // Sine bump: 0 at edges, ~255 in the middle. Squared to
            // narrow the bright band — makes the sheen read as a
            // crisp streak rather than a wide fade.
            const s = Math.sin(t * Math.PI);
            const alpha = Math.min(255, Math.floor(s * s * 255));
            const i = x * 4;
            data[i    ] = 255;
            data[i + 1] = 255;
            data[i + 2] = 255;
            data[i + 3] = alpha;
        }
        const tex = new Texture2D();
        tex.reset({
            width:  w,
            height: h,
            format: Texture2D.PixelFormat.RGBA8888,
        });
        tex.uploadData(data);
        const frame = new SpriteFrame();
        frame.texture = tex;
        this.generatedFrame = frame;
        return frame;
    }

    // ============================================================
    //  Sweep scheduling
    // ============================================================

    private scheduleNext(delaySec: number): void {
        if (this.sweepTimer !== null) clearTimeout(this.sweepTimer);
        this.sweepTimer = setTimeout(
            () => this.playSweep(),
            Math.max(0, delaySec) * 1000,
        );
    }

    private playSweep(): void {
        if (!this.shineBar) return;
        const parentUI = this.node.getComponent(UITransform);
        if (!parentUI) return;
        const w = parentUI.contentSize.width;
        // Sweep from just off the left edge to just off the right.
        // 0.9× keeps the bar visible within the logo for the whole
        // sweep instead of spending time off-screen.
        const startX = -w * 0.9;
        const endX   =  w * 0.9;
        this.shineBar.setPosition(startX, 0, 0);
        Tween.stopAllByTarget(this.shineBar);
        tween(this.shineBar)
            .to(this.sweepDuration, { position: new Vec3(endX, 0, 0) }, { easing: 'quadInOut' })
            .call(() => this.scheduleNext(this.interval))
            .start();

        // Fire the external particle trail in sync with the sweep.
        // LogoShineParticles handles its own spawn positions across
        // ITS OWN node width, staggered over `sweepDuration` so the
        // trail visually chases the sheen.
        if (this.particles && this.particles.isValid) {
            this.particles.emit(this.sweepDuration);
        }

        // Pulse the logo: quick punch up to `pulseScale`, HOLD at peak
        // while the sheen sweeps across, THEN ease back to resting
        // once the sweep has fully exited. Sequence:
        //   0 → pulseUpDuration            :  scale ↑ to peak
        //   ↑ → sweepDuration               :  hold at peak (sheen still
        //                                       traversing the logo)
        //   ↑ → sweepDuration + pulseDown   :  scale ↓ back to rest
        // Total pulse life = sweepDuration + pulseDownDuration. This
        // guarantees the shrink-back never starts before the sweep is
        // done, matching the "划过去以后再恢复" spec.
        if (this.pulseScale > 1.0001 || this.pulseScale < 0.9999) {
            const peak = new Vec3(
                this.baseScale.x * this.pulseScale,
                this.baseScale.y * this.pulseScale,
                this.baseScale.z,
            );
            const rest = new Vec3(this.baseScale.x, this.baseScale.y, this.baseScale.z);
            // Time to hold at peak = whatever's left of the sweep after
            // the up-tween finishes. `Math.max(0, ...)` guards against
            // a rare config where pulseUpDuration > sweepDuration.
            const holdSec = Math.max(0, this.sweepDuration - this.pulseUpDuration);
            Tween.stopAllByTarget(this.node);
            tween(this.node)
                .to(this.pulseUpDuration,   { scale: peak }, { easing: 'quadOut' })
                .delay(holdSec)
                .to(this.pulseDownDuration, { scale: rest }, { easing: 'quadIn'  })
                .start();
        }
    }

    // Particle-trail code lives in LogoShineParticles.ts. Attach that
    // component to a NODE OUTSIDE the logo (typically a sibling under
    // Canvas positioned wherever you want the strip) and drag it into
    // the `particles` @property above.
}
