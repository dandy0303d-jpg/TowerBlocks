/**
 * TutorialHandFX — animates the tutorial's demo hand.
 *
 * Wraps ONE Node (the hand sprite / emoji label — up to the scene
 * author). Public methods drive the 4 gesture demonstrations. Each
 * demo returns a Promise that resolves when the animation finishes,
 * so TutorialController can chain "demo → wait for player → advance".
 *
 * Positioning uses FRACTIONAL screen coordinates (0..1) which are
 * multiplied by the canvas size to get pixels. This keeps the demo
 * looking right across aspect ratios and doesn't need to know
 * anything about the game's 3D scene.
 */

import {
    _decorator,
    Component,
    Node,
    UITransform,
    UIOpacity,
    Vec3,
    tween,
    Tween,
    Canvas,
    director,
} from 'cc';

const { ccclass, property } = _decorator;

@ccclass('TutorialHandFX')
export class TutorialHandFX extends Component {

    @property({ type: Node, tooltip: '手指节点（Sprite 或者 Label emoji "👆"）' })
    handNode: Node | null = null;

    /** Cached canvas size for fraction → pixel conversion. Recomputed
     *  on every `place()` call so window resize / rotation reflects. */
    private canvasSize: { w: number; h: number } = { w: 750, h: 1334 };

    onLoad(): void {
        // Ensure UIOpacity exists — animations tween its `opacity`.
        if (this.handNode && !this.handNode.getComponent(UIOpacity)) {
            this.handNode.addComponent(UIOpacity);
        }
        this.hide();
    }

    /** Immediate hide (no fade). Used at demo teardown and boot. */
    public hide(): void {
        if (!this.handNode) return;
        const op = this.handNode.getComponent(UIOpacity);
        if (op) op.opacity = 0;
        this.handNode.active = false;
    }

    /** Cancel any in-progress tweens on the hand. Call before starting
     *  a new demo so old animations don't overlap. */
    public interrupt(): void {
        if (!this.handNode) return;
        Tween.stopAllByTarget(this.handNode);
        const op = this.handNode.getComponent(UIOpacity);
        if (op) Tween.stopAllByTarget(op);
    }

    // ============================================================
    //  Public demo methods — one per gesture type
    // ============================================================

    /** Tap gesture: hand appears at `pos`, quick press-release. */
    public demoTap(fracX: number, fracY: number): Promise<void> {
        return new Promise<void>((resolve) => {
            const node = this.handNode;
            if (!node) return resolve();
            this.interrupt();
            const px = this.fracToPixel(fracX, fracY);
            node.setPosition(px.x, px.y, 0);
            node.setScale(1, 1, 1);
            node.active = true;
            // handNode is required to have UIOpacity (onLoad adds it
            // if the editor didn't). If it's still missing for some
            // reason (component-order weirdness, hot-reload), add
            // one lazily instead of crashing on !.opacity.
            // handNode is required to have UIOpacity (onLoad adds it
            // if the editor didn't). If it's still missing for some
            // reason (component-order weirdness, hot-reload), add
            // one lazily instead of crashing on !.opacity.
            const op = node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
            op.opacity = 0;

            tween<UIOpacity>(op).to(0.20, { opacity: 255 }).start();
            tween(node)
                .delay(0.20)
                // Quick press (shrink) + release (bounce back), twice.
                .to(0.10, { scale: new Vec3(0.75, 0.75, 1) })
                .to(0.10, { scale: new Vec3(1.0,  1.0,  1) })
                .delay(0.15)
                .to(0.10, { scale: new Vec3(0.75, 0.75, 1) })
                .to(0.10, { scale: new Vec3(1.0,  1.0,  1) })
                .delay(0.20)
                .call(() => {
                    tween<UIOpacity>(op)
                        .to(0.25, { opacity: 0 })
                        .call(() => { node.active = false; resolve(); })
                        .start();
                })
                .start();
        });
    }

    /** Horizontal swipe with release — hand drifts from start to end. */
    public demoSwipeRelease(
        fracStartX: number, fracStartY: number,
        fracEndX:   number, fracEndY:   number,
    ): Promise<void> {
        return new Promise<void>((resolve) => {
            const node = this.handNode;
            if (!node) return resolve();
            this.interrupt();
            const s = this.fracToPixel(fracStartX, fracStartY);
            const e = this.fracToPixel(fracEndX,   fracEndY);
            node.setPosition(s.x, s.y, 0);
            node.setScale(1, 1, 1);
            node.active = true;
            // handNode is required to have UIOpacity (onLoad adds it
            // if the editor didn't). If it's still missing for some
            // reason (component-order weirdness, hot-reload), add
            // one lazily instead of crashing on !.opacity.
            // handNode is required to have UIOpacity (onLoad adds it
            // if the editor didn't). If it's still missing for some
            // reason (component-order weirdness, hot-reload), add
            // one lazily instead of crashing on !.opacity.
            const op = node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
            op.opacity = 0;
            tween<UIOpacity>(op).to(0.20, { opacity: 255 }).start();
            tween(node)
                .delay(0.20)
                // Small "press" to signal touch begin
                .to(0.10, { scale: new Vec3(0.85, 0.85, 1) })
                // Drift across
                .to(0.55, { position: new Vec3(e.x, e.y, 0) }, { easing: 'sineOut' })
                // Release (pop back)
                .to(0.10, { scale: new Vec3(1.0,  1.0,  1) })
                .delay(0.15)
                .call(() => {
                    tween<UIOpacity>(op)
                        .to(0.25, { opacity: 0 })
                        .call(() => { node.active = false; resolve(); })
                        .start();
                })
                .start();
        });
    }

    /** Horizontal swipe + hold — hand drifts to end, then jitters
     *  in place for `holdMs` to signal continuous rotation. */
    public demoSwipeHold(
        fracStartX: number, fracStartY: number,
        fracEndX:   number, fracEndY:   number,
        holdMs:     number,
    ): Promise<void> {
        return new Promise<void>((resolve) => {
            const node = this.handNode;
            if (!node) return resolve();
            this.interrupt();
            const s = this.fracToPixel(fracStartX, fracStartY);
            const e = this.fracToPixel(fracEndX,   fracEndY);
            node.setPosition(s.x, s.y, 0);
            node.setScale(1, 1, 1);
            node.active = true;
            // handNode is required to have UIOpacity (onLoad adds it
            // if the editor didn't). If it's still missing for some
            // reason (component-order weirdness, hot-reload), add
            // one lazily instead of crashing on !.opacity.
            // handNode is required to have UIOpacity (onLoad adds it
            // if the editor didn't). If it's still missing for some
            // reason (component-order weirdness, hot-reload), add
            // one lazily instead of crashing on !.opacity.
            const op = node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
            op.opacity = 0;
            const holdSec = holdMs / 1000;

            tween<UIOpacity>(op).to(0.20, { opacity: 255 }).start();
            tween(node)
                .delay(0.20)
                .to(0.10, { scale: new Vec3(0.85, 0.85, 1) })
                .to(0.45, { position: new Vec3(e.x, e.y, 0) }, { easing: 'sineOut' })
                // Hold in place, jitter scale to signal "still pressing"
                .to(holdSec / 4, { scale: new Vec3(0.78, 0.78, 1) })
                .to(holdSec / 4, { scale: new Vec3(0.90, 0.90, 1) })
                .to(holdSec / 4, { scale: new Vec3(0.78, 0.78, 1) })
                .to(holdSec / 4, { scale: new Vec3(0.90, 0.90, 1) })
                // Release
                .to(0.10, { scale: new Vec3(1.0, 1.0, 1) })
                .delay(0.15)
                .call(() => {
                    tween<UIOpacity>(op)
                        .to(0.25, { opacity: 0 })
                        .call(() => { node.active = false; resolve(); })
                        .start();
                })
                .start();
        });
    }

    /** Vertical swipe down — hand travels from start (higher) to end (lower). */
    public demoSwipeDown(
        fracStartX: number, fracStartY: number,
        fracEndX:   number, fracEndY:   number,
    ): Promise<void> {
        // Same shape as swipe-release, but the vertical direction is
        // implicit in the (fracStart → fracEnd) delta. Reuse the code.
        return this.demoSwipeRelease(fracStartX, fracStartY, fracEndX, fracEndY);
    }

    // ============================================================
    //  Helpers
    // ============================================================

    /** Convert a (0..1, 0..1) fraction to canvas-local pixel position.
     *  UI space: origin at canvas center, +Y up. Fraction (0.5, 0.5)
     *  maps to (0, 0). */
    private fracToPixel(fracX: number, fracY: number): { x: number; y: number } {
        this.refreshCanvasSize();
        const { w, h } = this.canvasSize;
        return {
            x: (fracX - 0.5) * w,
            y: (fracY - 0.5) * h,
        };
    }

    private refreshCanvasSize(): void {
        const scene = director.getScene();
        if (!scene) return;
        const canvas = scene.getComponentInChildren(Canvas);
        if (!canvas) return;
        const tx = canvas.node.getComponent(UITransform);
        if (!tx) return;
        this.canvasSize = { w: tx.contentSize.width, h: tx.contentSize.height };
    }
}

