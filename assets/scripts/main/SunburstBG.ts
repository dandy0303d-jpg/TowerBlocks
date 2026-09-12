/**
 * SunburstBG.ts — a plain "slowly rotate this node" component.
 *
 * Named for the celebration panel's sunburst backdrop, but has no
 * knowledge of what it's rotating — attach to any Node (sprite, group,
 * whatever) to make it spin. The artist authors the actual sunburst
 * artwork as a Sprite child under the celebration panel; this component
 * just handles the animation.
 *
 * Lifecycle:
 *   - onEnable  → start endless spin tween. Fires whenever the Node
 *                 becomes active in hierarchy (parent panel activates,
 *                 scene loads with node active, etc.), so no
 *                 programmatic trigger is needed.
 *   - onDisable → kill the tween. Fires when the parent panel hides
 *                 or the node is destroyed; leaves no zombie tweens.
 *
 * If the tween seems not to run in editor Play/Preview mode, save the
 * scene, restart Cocos to force a full script reload, then hit ▶ again.
 */

import { _decorator, Component, Node, Vec3, tween, Tween } from 'cc';

const { ccclass, property } = _decorator;

@ccclass('SunburstBG')
export class SunburstBG extends Component {

    // ─── Rotation ────────────────────────────────────────────────
    @property({ tooltip: '转一圈需要的秒数。数字越大越慢；负数反向。例：2 = 2秒一圈（快），30 = 30秒一圈（慢），-10 = 逆时针10秒一圈。' })
    spinDurationSec: number = 5;

    // ─── Breathing (scale pulse) ─────────────────────────────────
    // The breath tween runs independently of the spin tween. Both
    // start together on enable and stop together on disable; they act
    // on different transform properties (scale vs. eulerAngles) so
    // they don't fight each other.
    @property({ tooltip: '呼吸幅度：最大 scale 相对基准的比例（0 = 关闭呼吸）。例：0.08 = 最大放大到 1.08x，然后回到 1.0x。' })
    breathAmount: number = 0.08;

    @property({ tooltip: '一次完整呼吸（放大→缩回）的秒数。例：1.5 = 1.5 秒一次。' })
    breathDurationSec: number = 1.5;

    /** Component activated (parent + this node active-in-hierarchy).
     *  Kick off endless spin + breath. repeatForever + by()/to() keeps
     *  the animation loop clean across enable/disable cycles. */
    protected onEnable(): void {
        Tween.stopAllByTarget(this.node);

        // --- spin -------------------------------------------------
        const spinDur = Math.max(0.05, Math.abs(this.spinDurationSec));
        const spinTarget = this.spinDurationSec < 0 ? -360 : 360;
        tween(this.node)
            .by(spinDur, { eulerAngles: new Vec3(0, 0, spinTarget) })
            .repeatForever()
            .start();

        // --- breath (scale pulse) ---------------------------------
        // Skip entirely when breathAmount is ~0 so a static sunburst
        // doesn't burn a tween slot on nothing.
        if (this.breathAmount > 0.001 && this.breathDurationSec > 0.01) {
            // Read the authored scale as the baseline. Multiply by
            // (1 + breathAmount) at peak, then back. Preserves any
            // non-1 baseline the artist set in the Inspector.
            const base = this.node.scale.clone();
            const peak = new Vec3(
                base.x * (1 + this.breathAmount),
                base.y * (1 + this.breathAmount),
                base.z,
            );
            const half = this.breathDurationSec / 2;
            tween(this.node)
                .to(half, { scale: peak }, { easing: 'sineInOut' })
                .to(half, { scale: base }, { easing: 'sineInOut' })
                .union()
                .repeatForever()
                .start();
        }
    }

    /** Component deactivated (parent hid, scene torn down, etc.). Kill
     *  every tween — rotation AND breath — so no ghost animation
     *  ticks against a hidden node. */
    protected onDisable(): void {
        Tween.stopAllByTarget(this.node);
    }
}
