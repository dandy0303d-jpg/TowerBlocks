/**
 * SunburstBG.ts — programmatic yellow/orange radial-ray background for
 * the level-clear celebration.
 *
 * Draws N wedge triangles from the node center outward, alternating
 * between colorA and colorB, using a single Graphics component. Pop-in
 * scale on `play()` + endless slow rotation. `stop()` fades out and
 * hides the node.
 *
 * Wiring:
 *   1. In the scene, add a plain Node under the HUD canvas (position it
 *      at whatever "level-clear center" position you want — usually
 *      (0,0) so it lines up with the centered clear-time label).
 *   2. Attach this component to that Node.
 *   3. Tune rayCount / radius / colors / spinDurationSec in Inspector.
 *   4. Assign the Node to HudController.authoredSunburstNode. Hud will
 *      call `.play()` at level-clear start and `.stop()` at hide.
 *
 * Node hierarchy the component adds to itself at runtime:
 *   - Graphics component (auto-added in onLoad)
 *   - No child nodes — the ray fan is drawn directly by Graphics.
 *
 * The rays fill a full 360° with no gaps, so a rotation of `2π/N` looks
 * identical to no rotation at all. That's fine — we spin slowly, mostly
 * for the "the panel is *alive*" feel, not for a discrete beat.
 */

import {
    _decorator,
    Component,
    Graphics,
    Color,
    Node,
    Vec3,
    tween,
    Tween,
    UITransform,
} from 'cc';
import { EDITOR } from 'cc/env';

const { ccclass, property, executeInEditMode } = _decorator;

@ccclass('SunburstBG')
@executeInEditMode(true)   // Draw in editor so artists can preview.
export class SunburstBG extends Component {

    // ─── Inspector properties ────────────────────────────────────
    @property({ tooltip: 'Number of rays. Even numbers give clean A/B alternation.' })
    rayCount: number = 24;

    @property({ tooltip: 'Ray length in local px. Should exceed the panel behind it — the rays get clipped by the panel visually.' })
    radius: number = 800;

    @property({ tooltip: 'Ray color A (default warm gold). Wedges at even indices use this.' })
    colorA: Color = new Color(255, 215, 90, 255);

    @property({ tooltip: 'Ray color B (default light orange). Wedges at odd indices use this.' })
    colorB: Color = new Color(255, 170, 40, 220);

    @property({ tooltip: 'Seconds for one full rotation. Negative reverses the direction.' })
    spinDurationSec: number = 30;

    @property({ tooltip: 'Pop-in duration in ms (scale 0.1 → 1).' })
    popInMs: number = 300;

    @property({ tooltip: 'Fade-out duration in ms (scale 1 → 0.5 + hide).' })
    fadeOutMs: number = 200;

    // NOTE: at runtime the node is ALWAYS forced hidden in onLoad
    // regardless of its scene-authored `active` state — the sunburst
    // should only appear when HudController.showLevelClearTime calls
    // play(). This property is a NO-OP at runtime; it exists so
    // artists can preview the sunburst in the editor by leaving the
    // node active. If you find the sunburst showing during gameplay,
    // it's NEVER because startHidden is wrong — check whether
    // something is calling play() prematurely, or whether the node is
    // being reactivated by a parent's layout / show logic.
    @property({ tooltip: '[已废弃 / editor-only]。运行时永远从隐藏开始，只有 play() 才显示。留在这里只是不动老场景引用。' })
    startHidden: boolean = true;

    // ─── Radial gradient ────────────────────────────────────────
    // Each ray gets sliced into N concentric ring segments; alpha
    // lerps between innerAlpha (at r=0) and outerAlpha (at r=radius).
    // Default = opaque at the base, fading out at the tip — reads as
    // "burst originating from the panel center".
    //
    // To invert (fade AT the base, solid tips — spike look), swap the
    // two alpha values in the Inspector. Set radialSegments to 1 to
    // disable the gradient entirely (falls back to flat fills).
    @property({ tooltip: '径向渐变层数。每条射线切成 N 层同心楔形做 alpha 渐变。1 = 关闭渐变（纯色填充）；越大越平滑，性能更贵。' })
    radialSegments: number = 12;

    @property({ tooltip: '射线根部（靠近中心）的 alpha，0..1。默认 1（不透明）。想要"根部渐变"就调小。' })
    innerAlpha: number = 1.0;

    @property({ tooltip: '射线尖端（外边缘）的 alpha，0..1。默认 0（完全透明），做出"从中心炸出去"的感觉。' })
    outerAlpha: number = 0.0;

    // ─── Runtime state ──────────────────────────────────────────
    private _drawn: boolean = false;
    /** Set of tweens we started, tracked so a re-play() can cancel
     *  cleanly without stepping on user tweens on the same node. */
    private _tweens: Tween<any>[] = [];

    protected onLoad(): void {
        // UITransform is required so Graphics has a coordinate frame —
        // add one if the user forgot. Sized to 2*radius so hit-test /
        // culling stay sane.
        let ui = this.node.getComponent(UITransform);
        if (!ui) ui = this.node.addComponent(UITransform);
        ui.setContentSize(this.radius * 2, this.radius * 2);

        this._draw();
        // NOTE: no more forced active=false at runtime. This Node is
        // designed to sit as a child of the celebration panel, so its
        // visibility follows the parent — HudController shows/hides
        // the parent, and Cocos propagates the active state down. If
        // the artist wants the sunburst hidden at boot, they should
        // just set the PANEL active=false in the scene.
    }

    /** Component became active (parent activated, or scene entered).
     *  Kick off the endless spin tween so the sunburst spins any time
     *  it's on screen. No pop-in here — the parent panel handles that
     *  via its own scale tween. */
    protected onEnable(): void {
        if (!this._drawn) this._draw();
        // Cancel any previous spin tween — a component re-enable
        // (e.g. Cocos hot-reload in the editor) should start fresh.
        Tween.stopAllByTarget(this.node);
        const dur = Math.max(0.05, Math.abs(this.spinDurationSec));
        const target = this.spinDurationSec < 0 ? -360 : 360;
        tween(this.node)
            .by(dur, { eulerAngles: new Vec3(0, 0, target) })
            .repeatForever()
            .start();
    }

    // ─── Draw ────────────────────────────────────────────────
    /**
     * Redraw the sunburst. Each ray is either:
     *   - a single wedge triangle (radialSegments = 1, flat fill), or
     *   - K concentric ring segments (radialSegments = K > 1) with alpha
     *     lerped from innerAlpha at the base to outerAlpha at the tip.
     *
     * Ring segments are trapezoids in polar coordinates:
     *
     *     r1  p4─────p3
     *         │  ↑  │
     *     r0  p1─────p2       (a1 ─── a2)
     *
     * For the innermost segment r0 == 0 so p1 == p2 == origin and the
     * shape degenerates into a triangle — draw code handles both.
     */
    private _draw(): void {
        const g = this.node.getComponent(Graphics)
               ?? this.node.addComponent(Graphics);
        g.clear();
        const N = Math.max(4, Math.floor(this.rayCount));
        const R = this.radius;
        const K = Math.max(1, Math.floor(this.radialSegments));
        const step = (Math.PI * 2) / N;
        const innerA = Math.max(0, Math.min(1, this.innerAlpha));
        const outerA = Math.max(0, Math.min(1, this.outerAlpha));

        for (let i = 0; i < N; i++) {
            const a1 = i * step;
            const a2 = (i + 1) * step;
            const col = (i % 2 === 0) ? this.colorA : this.colorB;
            // Precompute the cos/sin at the two edge angles — same
            // values reused across every ring segment of this ray.
            const c1 = Math.cos(a1), s1 = Math.sin(a1);
            const c2 = Math.cos(a2), s2 = Math.sin(a2);

            if (K === 1) {
                // Flat fill fast path — same as the original impl.
                const a = col.a * innerA;
                g.fillColor.set(col.r, col.g, col.b, a);
                g.moveTo(0, 0);
                g.lineTo(c1 * R, s1 * R);
                g.lineTo(c2 * R, s2 * R);
                g.close();
                g.fill();
                continue;
            }

            for (let j = 0; j < K; j++) {
                const r0 = (j / K) * R;
                const r1 = ((j + 1) / K) * R;
                // Alpha sampled at the segment's midpoint so the
                // gradient looks continuous across segment seams
                // (Cocos Graphics has no vertex color; each fill is
                // uniform, so we discretize per-ring). smoothstep-ish
                // curve — a plain lerp is fine visually here.
                const tMid = (j + 0.5) / K;
                const alpha01 = innerA + (outerA - innerA) * tMid;
                const a = Math.max(0, Math.min(255, Math.round(col.a * alpha01)));
                // Zero-alpha segments are transparent — skip the fill
                // to save GPU / draw calls, especially for the "fade
                // to nothing" outer rings.
                if (a === 0) continue;
                g.fillColor.set(col.r, col.g, col.b, a);
                if (j === 0) {
                    // Inner-most ring degenerates to a triangle:
                    // origin → r1@a1 → r1@a2.
                    g.moveTo(0, 0);
                    g.lineTo(c1 * r1, s1 * r1);
                    g.lineTo(c2 * r1, s2 * r1);
                } else {
                    // Full trapezoid: r0@a1 → r0@a2 → r1@a2 → r1@a1.
                    g.moveTo(c1 * r0, s1 * r0);
                    g.lineTo(c2 * r0, s2 * r0);
                    g.lineTo(c2 * r1, s2 * r1);
                    g.lineTo(c1 * r1, s1 * r1);
                }
                g.close();
                g.fill();
            }
        }
        this._drawn = true;
    }

    /** Force a redraw (Inspector tweak or after mutating rayCount /
     *  radius / colors at runtime). Cheap — just a single Graphics
     *  batch. */
    public redraw(): void {
        this._drawn = false;
        this._draw();
    }

    // ─── Play / stop ─────────────────────────────────────────
    /** Pop the node in and start the endless slow spin. Idempotent —
     *  a second call restarts the pop but keeps the spin phase. */
    public play(): void {
        if (!this._drawn) this._draw();
        this.node.active = true;
        this._killTweens();

        // Pop-in from a tiny scale so it reads as "burst appears" not
        // "burst has always been there". backOut gives it a tiny
        // overshoot for a snappier feel.
        this.node.setScale(0.15, 0.15, 1);
        const popTw = tween(this.node)
            .to(this.popInMs / 1000, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' });
        popTw.start();
        this._tweens.push(popTw);

        // Endless spin — by() so we don't fight a static setter each
        // loop. Negative spinDurationSec reverses direction.
        const dur = Math.max(0.5, Math.abs(this.spinDurationSec));
        const target = this.spinDurationSec < 0 ? -360 : 360;
        const spinTw = tween(this.node)
            .by(dur, { eulerAngles: new Vec3(0, 0, target) })
            .repeatForever();
        spinTw.start();
        this._tweens.push(spinTw);
    }

    /** Fade out and hide. Safe to call while not playing (no-op). */
    public stop(): void {
        if (!this.node.active) return;
        this._killTweens();
        const outTw = tween(this.node)
            .to(this.fadeOutMs / 1000, { scale: new Vec3(0.5, 0.5, 1) }, { easing: 'quadIn' })
            .call(() => { if (this.node && this.node.isValid) this.node.active = false; });
        outTw.start();
        this._tweens.push(outTw);
    }

    private _killTweens(): void {
        // Kill everything on the node — the spin, pop, and any fade-out
        // in progress. We don't try to preserve rotation because a
        // fresh play() intentionally resets the pop scale.
        Tween.stopAllByTarget(this.node);
        this._tweens.length = 0;
    }

    protected onDisable(): void {
        // Auto-cleanup if the node gets deactivated by external code
        // (e.g. HUD tear-down between scenes). Prevents zombie tweens.
        this._killTweens();
    }
}
