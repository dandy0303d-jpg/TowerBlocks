/**
 * FloatingBob — tiny helper component that makes a node bob up and
 * down forever, giving the "floating in mid-air" feel.
 *
 * Attach to any node (typically a UI Sprite / decorative element).
 * On start it captures the node's current Y as the resting position
 * and drives an infinite Y tween of ±`amplitude` around it. Tunable
 * amplitude, period, and phase offset via inspector properties so a
 * cluster of floating things can be desynced to feel organic instead
 * of marching in lockstep.
 *
 * Uses `Tween.stopAllByTarget(this.node)` on disable so the tween
 * doesn't keep firing on a hidden node.
 */

import { _decorator, Component, Vec3, tween, Tween } from 'cc';

const { ccclass, property } = _decorator;

@ccclass('FloatingBob')
export class FloatingBob extends Component {

    @property({ tooltip: '上下浮动幅度（像素/世界单位）— 从静止位置各偏移这么多' })
    amplitude: number = 8;

    @property({ tooltip: '一整个来回的时长（秒）。默认 1.6s 慢慢飘' })
    period: number = 1.6;

    @property({ tooltip: '起始相位（秒）。多个 FloatingBob 用不同的相位可以避免整齐划一' })
    phase: number = 0;

    /** Captured Y at enable — the tween oscillates around this. */
    private baseY: number = 0;

    onEnable(): void {
        const pos = this.node.position;
        this.baseY = pos.y;
        this.startBob();
    }

    onDisable(): void {
        Tween.stopAllByTarget(this.node);
        // Snap back to resting Y so a disabled node doesn't freeze at
        // the peak/trough of the tween.
        const pos = this.node.position;
        this.node.setPosition(pos.x, this.baseY, pos.z);
    }

    private startBob(): void {
        Tween.stopAllByTarget(this.node);
        const halfPeriod = Math.max(0.05, this.period / 2);
        const up   = new Vec3(this.node.position.x, this.baseY + this.amplitude, this.node.position.z);
        const down = new Vec3(this.node.position.x, this.baseY - this.amplitude, this.node.position.z);
        // Optional phase offset — delay before the first cycle so a
        // group of bobs can be scattered instead of moving as one.
        const phaseSec = Math.max(0, this.phase);
        tween(this.node)
            .delay(phaseSec)
            // Ease sinusoidally so the top / bottom pause naturally —
            // constant-velocity linear feels mechanical.
            .to(halfPeriod, { position: up   }, { easing: 'sineInOut' })
            .to(halfPeriod, { position: down }, { easing: 'sineInOut' })
            .union()
            .repeatForever()
            .start();
    }
}
