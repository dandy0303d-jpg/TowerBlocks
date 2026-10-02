import {
    _decorator, Component, Node, Label, Sprite, SpriteFrame, UIOpacity, UITransform, Vec3, Vec4, Color,
    tween, Tween, Graphics, EffectAsset, Material, NodeEventType,
} from 'cc';
const { ccclass, property } = _decorator;

/**
 * 获得徽章特效（Cocos Creator 3.8.x，2D UI）
 *
 * v2 流程（默认约 3 秒，传 from 时再加 0.45 秒）：
 *   起飞  （可选，传了 from）徽章从 from 的位置、按 from 的大小出现，边转一圈边放大，沿弧线飞到中央
 *   展开  遮罩淡入，光晕、放射光芒展开并持续旋转；徽章放大弹出，同时像硬币一样翻转两圈（先快后慢）
 *   爆发  翻转停下：白色闪光 + 两圈冲击波 + 星星和火花向四周炸开；标题砸下来，徽章名称随后弹出
 *   展示  徽章呼吸、扫光，周围随机闪星（holdTime 秒，或等玩家点击）
 *   飞入  标题、光芒淡出；徽章沿弧线缩小飞到目标栏位，一路拖着金色星光（目标位置每帧重新取）
 *   落位  闪光 + 光环 + 小星星迸发，调用 onArrive，然后目标格子放大回弹
 * 脚本不会改动 from / target 的显隐，格子什么时候出现由宿主在 onArrive 里决定。
 *
 * 节点结构（挂在一个全屏节点上，建议放在关卡界面最上层）：
 *   BadgeGetOverlay   ← 挂本脚本，UITransform 铺满屏幕
 *     ├ Mask          ← 半透明黑底（可空）
 *     ├ Glow          ← 圆形光晕图（可空，空则脚本自己画）
 *     ├ Rays          ← 放射光芒图（可空，空则脚本自己画）
 *     ├ Badge         ← 大徽章 Sprite（必填，摆在想展示的位置和大小）
 *     ├ Title         ← 标题（可空）
 *     └ BadgeName     ← 徽章名字（可空）
 * 所有元素在编辑器里按最终效果摆好即可，脚本只在这个基础上做动画，结束后恢复原样。
 *
 * 用法：
 *   await this.badgeFx.play({
 *       from: previewBadgeNode,                // 可空：起点，比如通关弹窗上的小徽章
 *       target: () => this.findSlot(idx),      // 格子节点，或返回格子节点的函数
 *       frame: newBadgeSpriteFrame,            // 可空：换大徽章的图
 *       name: 'T 形方块大师',                   // 可空：设置 BadgeName 文字
 *       onArrive: () => this.setBadgeCount(4),
 *   });
 */

export interface BadgeGetOptions {
    /**
     * 飞入起点（可空）。有值时徽章先从这个节点的位置、按它的大小出现，沿弧线旋转飞到中央，再展开翻转。
     * 不会改动 from 节点本身的显隐。为空则直接在中央展开（旧行为）。
     */
    from?: Node | null;
    /**
     * 飞入的目标节点（徽章栏里的格子），为空则展示后原地淡出。
     * 也可以传一个函数，脚本会在起飞时、飞行中每帧、落位时重新取一次，
     * 适合宿主会在播放期间重建格子节点的情况（例如 () => this.findBadgeSlot(idx)）。
     * 脚本不会隐藏/显示 target，只在落位时做一次放大回弹（节点失效则跳过）。
     */
    target?: Node | null | (() => Node | null);
    /** 替换大徽章的图片 */
    frame?: SpriteFrame | null;
    /** 徽章名字，写到 badgeName 的 Label 上 */
    name?: string;
    /** 展示停留时间（秒），默认用组件上的 holdTime */
    holdTime?: number;
    /** true：展示后等玩家点屏幕再飞走 */
    waitTap?: boolean;
    /** @deprecated v2 起不再使用：脚本不接管 target 显隐，请在 onArrive 里由宿主自己刷新 */
    hideTarget?: boolean;
    /** 到达时把 frame 设置到目标格子的 Sprite 上（自身没有 Sprite 时找子节点里的第一个），默认 true */
    applyFrameToTarget?: boolean;
    /** 落位时目标格子做放大回弹（默认 true） */
    punchTarget?: boolean;
    /** 徽章落到栏位的瞬间调用（target 为空时在淡出开始时调用） */
    onArrive?: () => void;
}

interface P {
    kind: 0 | 1 | 2;          // 0 星星 1 火花线 2 光点
    x: number; y: number; vx: number; vy: number;
    age: number; life: number; size: number;
    rot: number; vr: number; drag: number; grav: number;
    color: Color;
}
interface Ring { x: number; y: number; age: number; life: number; r0: number; r1: number; w: number; color: Color; }
interface Flash { x: number; y: number; age: number; life: number; r: number; }

const GOLD = new Color(255, 214, 74, 255);
const ORANGE = new Color(255, 150, 50, 255);
const WHITE = new Color(255, 255, 255, 255);
const CREAM = new Color(255, 244, 200, 255);
const SKY = new Color(140, 220, 255, 255);

@ccclass('BadgeGetEffect')
export class BadgeGetEffect extends Component {

    @property({ type: Node, tooltip: '大徽章（必填）' }) badge: Node | null = null;
    @property({ type: Node, tooltip: '半透明遮罩（可空）' }) mask: Node | null = null;
    @property({ type: Node, tooltip: '光晕图（可空，空则脚本画）' }) glow: Node | null = null;
    @property({ type: Node, tooltip: '放射光芒图（可空，空则脚本画）' }) rays: Node | null = null;
    @property({ type: Node, tooltip: '标题，如「获得新徽章！」（可空）' }) title: Node | null = null;
    @property({ type: Node, tooltip: '徽章名字（可空，带 Label）' }) badgeName: Node | null = null;

    @property({ type: EffectAsset, tooltip: '拖入 ui-shine.effect（可空，空则徽章没有扫光）' }) shineEffect: EffectAsset | null = null;

    @property({ tooltip: '遮罩不透明度 0~255' }) maskOpacity = 170;
    @property({ tooltip: '翻转圈数' }) flipTurns = 2;
    @property({ tooltip: '弹出+翻转时长（秒）' }) introTime = 0.7;
    @property({ tooltip: '展示停留时长（秒）' }) holdTime = 1.3;
    @property({ tooltip: '从 from 飞到中央的时长（秒）' }) fromTime = 0.45;
    @property({ tooltip: '飞到目标的时长（秒）' }) flyTime = 0.6;
    @property({ tooltip: '光芒旋转速度（度/秒）' }) raySpeed = 25;
    @property({ tooltip: '主色（光晕、光芒、星光）' }) mainColor = new Color(255, 214, 74, 255);
    @property({ tooltip: '播放结束后隐藏本节点' }) deactivateOnEnd = true;

    // -------------------------------------------------------------

    private _base = new Map<Node, { pos: Vec3; scale: Vec3; angle: number; opacity: number }>();
    private _back: Graphics | null = null;   // 徽章背后：光晕、光芒、冲击波
    private _front: Graphics | null = null;  // 最上层：星星、火花、闪光、拖尾
    private _ps: P[] = [];
    private _rings: Ring[] = [];
    private _flashes: Flash[] = [];
    private _shineMat: Material | null = null;
    private _shine = new Vec4(-1, 0.14, 0.7, 0.5);
    private _shineRect = new Vec4();
    private _shineT = -1;

    private _t = 0;
    private _raysAlpha = 0;      // 程序光芒/光晕的透明度 0~1
    private _raysScale = 0;
    private _rayAngle = 0;
    private _idle = false;
    private _flying = false;
    private _twinkle = 0;
    private _trailAcc = 0;
    private _flip = { p: 0 };
    private _flipOn = false;
    private _badgeScale = 1;     // 弹出缩放（乘在基础缩放上）
    private _running = false;    // 播放中，由 update 驱动徽章缩放

    onLoad() {
        this.ensureFx();
        if (this.shineEffect && this.badge) {
            const sp = this.badge.getComponent(Sprite);
            if (sp) {
                const mat = new Material();
                mat.initialize({ effectAsset: this.shineEffect, defines: { USE_TEXTURE: true } });
                sp.customMaterial = mat;
                this._shineMat = mat;
            }
        }
    }

    /** 播放完整流程，徽章落位且特效结束后 resolve */
    /** 播放完整流程，徽章落位且特效结束后 resolve */
    async play(opts: BadgeGetOptions = {}): Promise<void> {
        const badge = this.badge;
        if (!badge) { console.warn('[BadgeGetEffect] 没有设置 badge'); return; }
        this.node.active = true;
        this.ensureFx();
        this.stopAll();
        this.record();

        const getTarget = (): Node | null => {
            const t = typeof opts.target === 'function' ? opts.target() : opts.target;
            return t && t.isValid ? t : null;
        };
        if (opts.frame) { const sp = badge.getComponent(Sprite); if (sp) sp.spriteFrame = opts.frame; }
        if (opts.name !== undefined && this.badgeName) {
            const lb = this.badgeName.getComponent(Label) || this.badgeName.getComponentInChildren(Label);
            if (lb) lb.string = opts.name;
        }

        const b = this._base.get(badge)!;
        const center = b.pos.clone();

        // ---------- 初始状态 ----------
        for (const n of [this.mask, this.glow, this.rays, this.title, this.badgeName]) if (n) this.op(n).opacity = 0;
        this.op(badge).opacity = 255;
        this._badgeScale = 0;
        this.applyBadgeScale(0);
        this._raysAlpha = 0; this._raysScale = 0.3; this._t = 0;
        this._idle = false; this._flying = false; this._shineT = -1;
        this._running = true;

        if (this.mask) tween(this.op(this.mask)).to(0.25, { opacity: this.maskOpacity }).start();

        // ---------- 第一段：从 from 飞到中央（可选） ----------
        let popFrom = 0;
        const from = opts.from && opts.from.isValid ? opts.from : null;
        if (from) {
            const start = this.toLocal(from);
            const s0 = this.scaleToFit(from);
            popFrom = 0.6;
            badge.setPosition(start.x, start.y, b.pos.z);
            this._badgeScale = s0;
            this.applyBadgeScale(s0);
            await this.flyArc(start, () => center, s0, popFrom, this.fromTime, 'sineInOut', 360, 0.25);
            badge.setPosition(center);
            badge.angle = b.angle;
        }

        // ---------- 第二段：中央展开 + 翻转 ----------
        this.popIn(this.glow, 0.05, 0.45, 1.15);
        this.popIn(this.rays, 0.1, 0.5, 1.0);
        tween(this as any).delay(0.05).to(0.5, { _raysAlpha: 1, _raysScale: 1 }, { easing: 'backOut' }).start();

        this._badgeScale = popFrom;
        tween(this as any).delay(from ? 0 : 0.05)
            .to(this.introTime * 0.55, { _badgeScale: 1.25 }, { easing: 'quadOut' })
            .to(this.introTime * 0.45, { _badgeScale: 1.0 }, { easing: 'backOut' })
            .start();
        this._flip.p = 0; this._flipOn = true;
        tween(this._flip).delay(from ? 0 : 0.05).to(this.introTime, { p: 1 }, { easing: 'cubicOut' })
            .call(() => { this._flipOn = false; this.applyBadgeScale(this._badgeScale); })
            .start();
        this.schedule(this.introSparkle, 0.05, Math.floor(this.introTime / 0.05), 0.05);

        await this.wait((from ? 0 : 0.05) + this.introTime);

        // ---------- 落定爆发 ----------
        this.burst(center.x, center.y, this.badgeRadius(), 1);
        tween(this as any).to(0.08, { _badgeScale: 1.12 }).to(0.25, { _badgeScale: 1 }, { easing: 'backOut' }).start();

        if (this.title) {
            const tb = this._base.get(this.title)!;
            this.title.setScale(tb.scale.x * 2.2, tb.scale.y * 2.2, 1);
            tween(this.op(this.title)).delay(0.05).to(0.12, { opacity: tb.opacity }).start();
            tween(this.title).delay(0.05)
                .to(0.18, { scale: new Vec3(tb.scale.x * 0.92, tb.scale.y * 0.92, 1) }, { easing: 'quadIn' })
                .to(0.2, { scale: tb.scale.clone() }, { easing: 'backOut' })
                .call(() => this.sparkAround(this.title!, 6))
                .start();
        }
        if (this.badgeName) {
            const nb = this._base.get(this.badgeName)!;
            this.badgeName.setScale(0, 0, 1);
            tween(this.op(this.badgeName)).delay(0.25).to(0.15, { opacity: nb.opacity }).start();
            tween(this.badgeName).delay(0.25).to(0.3, { scale: nb.scale.clone() }, { easing: 'backOut' }).start();
        }
        this._idle = true;
        this._shineT = 0.3;

        // ---------- 展示 ----------
        if (opts.waitTap) {
            await this.wait(0.5);
            await new Promise<void>(res => this.node.once(NodeEventType.TOUCH_END, () => res()));
        } else {
            await this.wait(0.5 + (opts.holdTime ?? this.holdTime));
        }
        this._idle = false;
        this._shineT = -1;

        // ---------- 第三段：飞到目标 ----------
        for (const n of [this.title, this.badgeName, this.glow, this.rays]) {
            if (n) tween(this.op(n)).to(0.2, { opacity: 0 }).start();
        }
        tween(this as any).to(0.25, { _raysAlpha: 0 }).start();
        if (this.mask) tween(this.op(this.mask)).delay(0.1).to(this.flyTime + 0.1, { opacity: 0 }).start();

        let target = getTarget();
        if (!target) {
            tween(this.op(badge)).to(0.3, { opacity: 0 }).start();
            tween(this as any).to(0.3, { _badgeScale: 1.3 }).start();
            try { opts.onArrive?.(); } catch (e) { console.error(e); }
            await this.wait(0.6);
            this.finish();
            return;
        }

        let endScale = this.scaleToFit(target);
        let lastEnd = this.toLocal(target);
        // 飞行中每帧重新取目标位置（宿主重建格子、Layout 重排时也能跟上）
        const endFn = () => {
            const t = getTarget();
            if (t) { lastEnd = this.toLocal(t); }
            return lastEnd;
        };

        await new Promise<void>(res => tween(this as any).to(0.12, { _badgeScale: 1.15 }, { easing: 'quadOut' }).call(() => res()).start());
        await this.flyArc(center.clone(), endFn, 1.15, endScale, this.flyTime, 'quadIn', 0, 0.35);

        // ---------- 落位 ----------
        const end = lastEnd;
        badge.setPosition(end);
        this.op(badge).opacity = 0;
        target = getTarget();
        if (target) {
            if (opts.frame && opts.applyFrameToTarget !== false) {
                const tsp = target.getComponent(Sprite) || target.getComponentInChildren(Sprite);
                if (tsp) tsp.spriteFrame = opts.frame;
            }
        }
        const r = this.badgeRadius() * endScale;
        this.burst(end.x, end.y, Math.max(r, 20), 0.55);
        try { opts.onArrive?.(); } catch (e) { console.error(e); }

        // onArrive 里宿主可能已经重建了格子，这里重新取一次再回弹
        if (opts.punchTarget !== false) {
            const t2 = getTarget();
            if (t2) this.punch(t2);
        }

        await this.wait(0.8);
        this.finish();
    }

    /**
     * 沿二次贝塞尔弧线飞行。
     * @param spinDeg 飞行途中额外自转的角度（0 = 只轻微摆动）
     * @param arc 弧度大小（相对距离）
     */
    private flyArc(start: Vec3, endFn: () => Vec3, s0: number, s1: number, dur: number, easing: string, spinDeg: number, arc: number): Promise<void> {
        const badge = this.badge!;
        const b = this._base.get(badge)!;
        const e0 = endFn();
        const side = e0.x - start.x >= 0 ? -1 : 1;
        this._flying = true;
        return new Promise<void>(res => {
            const prox = { t: 0 };
            tween(prox).to(dur, { t: 1 }, {
                easing: easing as any,
                onUpdate: () => {
                    const end = endFn();
                    const t = prox.t, u = 1 - t;
                    const dx = end.x - start.x, dy = end.y - start.y;
                    const len = Math.max(1, Math.hypot(dx, dy));
                    const cx = (start.x + end.x) / 2 + (-dy / len) * len * arc * side;
                    const cy = (start.y + end.y) / 2 + (dx / len) * len * arc * side + len * 0.15;
                    const x = u * u * start.x + 2 * u * t * cx + t * t * end.x;
                    const y = u * u * start.y + 2 * u * t * cy + t * t * end.y;
                    badge.setPosition(x, y, b.pos.z);
                    this._badgeScale = s0 + (s1 - s0) * t;
                    this.applyBadgeScale(this._badgeScale);
                    badge.angle = b.angle + (spinDeg ? spinDeg * t * side : Math.sin(t * Math.PI) * 18 * side);
                },
            }).call(() => { this._flying = false; res(); }).start();
        });
    }

    /** 目标格子放大回弹：用代理对象驱动，节点失效时自动跳过，不会报错 */
    private punch(target: Node) {
        const ts = target.scale.clone();
        const prox = { k: 1.6 };
        target.setScale(ts.x * 1.6, ts.y * 1.6, 1);
        const apply = () => { if (target.isValid) target.setScale(ts.x * prox.k, ts.y * prox.k, ts.z); };
        tween(prox)
            .to(0.12, { k: 0.85 }, { easing: 'quadIn', onUpdate: apply })
            .to(0.25, { k: 1 }, { easing: 'backOut', onUpdate: apply })
            .call(() => { if (target.isValid) target.setScale(ts); })
            .start();
    }

    /** 立即停止并恢复 */
    stop() {
        this.stopAll();
        this._running = false;
        this.restore();
        this._ps.length = 0; this._rings.length = 0; this._flashes.length = 0;
        this._back?.clear(); this._front?.clear();
        if (this.deactivateOnEnd) this.node.active = false;
    }

    // ================= 内部 =================

    private finish() {
        this._running = false;
        this.restore();
        if (!this.deactivateOnEnd) {
            for (const n of [this.badge, this.mask, this.glow, this.rays, this.title, this.badgeName]) if (n) this.op(n).opacity = 0;
        }
        this._raysAlpha = 0;
        if (this.deactivateOnEnd) {
            // 等粒子放完
            this.scheduleOnce(() => {
                if (!this._flying && !this._idle) { this._ps.length = 0; this._back?.clear(); this._front?.clear(); this.node.active = false; }
            }, 0.1);
        }
    }

    private ensureFx() {
        if (!this._back) {
            const n = new Node('BadgeFxBack');
            n.layer = this.node.layer;
            n.addComponent(UITransform);
            this._back = n.addComponent(Graphics);
            this.node.addChild(n);
        }
        if (!this._front) {
            const n = new Node('BadgeFxFront');
            n.layer = this.node.layer;
            n.addComponent(UITransform);
            this._front = n.addComponent(Graphics);
            this.node.addChild(n);
        }
        // 背景层放在徽章下面，前景层放最上面
        if (this.badge && this.badge.parent === this.node) {
            const bi = this.badge.getSiblingIndex();
            const back = this._back.node;
            if (back.getSiblingIndex() > bi) back.setSiblingIndex(bi);
        }
        this._front.node.setSiblingIndex(this.node.children.length - 1);
    }

    private record() {
        this._base.clear();
        for (const n of [this.badge, this.mask, this.glow, this.rays, this.title, this.badgeName]) {
            if (!n) continue;
            this._base.set(n, { pos: n.position.clone(), scale: n.scale.clone(), angle: n.angle, opacity: this.op(n).opacity || 255 });
        }
    }

    private restore() {
        this._base.forEach((b, n) => {
            Tween.stopAllByTarget(n);
            n.setPosition(b.pos); n.setScale(b.scale); n.angle = b.angle;
            this.op(n).opacity = b.opacity;
        });
    }

    private stopAll() {
        Tween.stopAllByTarget(this);
        Tween.stopAllByTarget(this._flip);
        this.unscheduleAllCallbacks();
        for (const n of [this.badge, this.mask, this.glow, this.rays, this.title, this.badgeName]) {
            if (n) { Tween.stopAllByTarget(n); Tween.stopAllByTarget(this.op(n)); }
        }
        this._idle = false; this._flying = false; this._flipOn = false;
    }

    private op(n: Node): UIOpacity {
        return n.getComponent(UIOpacity) || n.addComponent(UIOpacity);
    }

    private wait(s: number) {
        return new Promise<void>(res => this.scheduleOnce(() => res(), s));
    }

    private popIn(n: Node | null, delay: number, dur: number, over: number) {
        if (!n) return;
        const b = this._base.get(n)!;
        n.setScale(0, 0, 1);
        tween(this.op(n)).delay(delay).to(dur * 0.5, { opacity: b.opacity }).start();
        tween(n).delay(delay)
            .to(dur * 0.6, { scale: new Vec3(b.scale.x * over, b.scale.y * over, 1) }, { easing: 'quadOut' })
            .to(dur * 0.4, { scale: b.scale.clone() }, { easing: 'quadInOut' })
            .start();
    }

    /** 徽章缩放 = 基础缩放 × 弹出缩放 × 翻转（横向） */
    private applyBadgeScale(s: number) {
        const badge = this.badge; if (!badge) return;
        const b = this._base.get(badge); if (!b) return;
        let fx = 1;
        if (this._flipOn) {
            const ang = this._flip.p * this.flipTurns * Math.PI * 2;
            fx = Math.cos(ang);
            // 太窄时保留一点厚度，看起来像硬币侧面
            fx = Math.sign(fx || 1) * Math.max(Math.abs(fx), 0.06);
        }
        badge.setScale(b.scale.x * s * fx, b.scale.y * s, 1);
    }

    private badgeRadius(): number {
        const badge = this.badge; if (!badge) return 80;
        const ut = badge.getComponent(UITransform);
        const b = this._base.get(badge);
        const sc = b ? Math.abs(b.scale.x) : 1;
        return ut ? Math.max(ut.width, ut.height) * 0.5 * sc : 80;
    }

    private toLocal(n: Node): Vec3 {
        const ut = this.node.getComponent(UITransform);
        const wp = n.worldPosition;
        return ut ? ut.convertToNodeSpaceAR(wp) : wp.clone();
    }

    /** 让徽章飞到目标时和目标一样大 */
    private scaleToFit(target: Node): number {
        const badge = this.badge!;
        const but = badge.getComponent(UITransform);
        const tut = target.getComponent(UITransform);
        const b = this._base.get(badge)!;
        if (!but || !tut) return 0.3;
        const targetW = Math.max(tut.width, tut.height) * Math.abs(target.worldScale.x);
        const badgeW = Math.max(but.width, but.height) * Math.abs(b.scale.x) * Math.abs(this.node.worldScale.x);
        return badgeW > 0 ? targetW / badgeW : 0.3;
    }

    // ---------------- 粒子 ----------------

    private introSparkle = () => {
        const badge = this.badge; if (!badge) return;
        const r = this.badgeRadius() * this._badgeScale;
        const p = badge.position;
        for (let i = 0; i < 2; i++) {
            const a = Math.random() * Math.PI * 2;
            this.add(2, p.x + Math.cos(a) * r * 0.9, p.y + Math.sin(a) * r * 0.9,
                Math.cos(a) * rand(40, 120), Math.sin(a) * rand(40, 120), rand(0.3, 0.5), rand(5, 10), this.mainColor, 2, 0);
        }
    };

    /** 落定爆发：闪光 + 冲击波 + 星星 + 火花 */
    private burst(x: number, y: number, r: number, k: number) {
        this._flashes.push({ x, y, age: 0, life: 0.35, r: r * 1.6 });
        this._rings.push({ x, y, age: 0, life: 0.55, r0: r * 0.6, r1: r * 2.6, w: 10 * k + 4, color: WHITE });
        this._rings.push({ x, y, age: -0.08, life: 0.7, r0: r * 0.8, r1: r * 3.4, w: 6 * k + 3, color: this.mainColor });
        const nStar = Math.round(22 * k), nSpark = Math.round(26 * k), nDot = Math.round(30 * k);
        for (let i = 0; i < nStar; i++) {
            const a = Math.random() * Math.PI * 2, sp = rand(250, 620) * (0.5 + k * 0.5);
            this.add(0, x + Math.cos(a) * r * 0.5, y + Math.sin(a) * r * 0.5, Math.cos(a) * sp, Math.sin(a) * sp,
                rand(0.6, 1.1), rand(10, 22) * (0.6 + 0.4 * k), [GOLD, WHITE, CREAM, ORANGE][i % 4], 3.2, -500);
        }
        for (let i = 0; i < nSpark; i++) {
            const a = Math.random() * Math.PI * 2, sp = rand(500, 1100) * (0.5 + k * 0.5);
            this.add(1, x + Math.cos(a) * r * 0.4, y + Math.sin(a) * r * 0.4, Math.cos(a) * sp, Math.sin(a) * sp,
                rand(0.3, 0.55), rand(3, 5), i % 3 ? GOLD : WHITE, 4, 0);
        }
        for (let i = 0; i < nDot; i++) {
            const a = Math.random() * Math.PI * 2, sp = rand(80, 360) * (0.5 + k * 0.5);
            this.add(2, x, y, Math.cos(a) * sp, Math.sin(a) * sp + 60, rand(0.6, 1.2), rand(4, 9),
                [GOLD, CREAM, SKY][i % 3], 1.8, -80);
        }
    }

    private sparkAround(n: Node, count: number) {
        const ut = n.getComponent(UITransform);
        const c = this.toLocal(n);
        const w = (ut ? ut.width * Math.abs(n.worldScale.x) : 200) * 0.5;
        const h = (ut ? ut.height * Math.abs(n.worldScale.y) : 60) * 0.5;
        for (let i = 0; i < count; i++) {
            this.add(0, c.x + rand(-w, w), c.y + rand(-h, h), 0, 0, rand(0.4, 0.7), rand(10, 18), i % 2 ? WHITE : GOLD, 0, 0);
        }
    }

    private add(kind: 0 | 1 | 2, x: number, y: number, vx: number, vy: number, life: number, size: number, color: Color, drag: number, grav: number) {
        this._ps.push({ kind, x, y, vx, vy, age: 0, life, size, rot: rand(0, Math.PI), vr: rand(-4, 4), drag, grav, color });
    }

    update(dt: number) {
        this._t += dt;
        const badge = this.badge;

        // 翻转/弹出缩放
        if (badge && this._running && !this._flying) {
            if (this._idle) {
                const breath = 1 + 0.035 * Math.sin(this._t * 3);
                this.applyBadgeScale(this._badgeScale * breath);
            } else if (!this._flying) {
                this.applyBadgeScale(this._badgeScale);
            }
        }

        // 光芒旋转
        this._rayAngle += this.raySpeed * dt;
        if (this.rays && this._raysAlpha > 0) this.rays.angle = (this._base.get(this.rays)?.angle || 0) - this._rayAngle;
        if (this.glow && this._idle) {
            const gb = this._base.get(this.glow);
            if (gb) this.op(this.glow).opacity = gb.opacity * (0.8 + 0.2 * Math.sin(this._t * 2.4));
        }

        // 展示期间随机闪星
        if (this._idle && badge) {
            this._twinkle += dt;
            if (this._twinkle > 0.18) {
                this._twinkle = 0;
                const r = this.badgeRadius() * 1.25;
                const a = Math.random() * Math.PI * 2, d = rand(0.6, 1.1) * r;
                this.add(0, badge.position.x + Math.cos(a) * d, badge.position.y + Math.sin(a) * d, 0, rand(10, 30),
                    rand(0.5, 0.8), rand(8, 16), Math.random() < 0.5 ? WHITE : this.mainColor, 0, 0);
            }
        }

        // 飞行拖尾
        if (this._flying && badge) {
            this._trailAcc += dt;
            const r = this.badgeRadius() * Math.abs(this._badgeScale);
            while (this._trailAcc > 0.012) {
                this._trailAcc -= 0.012;
                const p = badge.position;
                this.add(2, p.x + rand(-r, r) * 0.4, p.y + rand(-r, r) * 0.4, rand(-30, 30), rand(-30, 30),
                    rand(0.35, 0.6), rand(6, 12), Math.random() < 0.3 ? WHITE : this.mainColor, 1, 0);
                if (Math.random() < 0.35) this.add(0, p.x + rand(-r, r) * 0.6, p.y + rand(-r, r) * 0.6, 0, 0,
                    rand(0.4, 0.6), rand(8, 14), Math.random() < 0.5 ? WHITE : GOLD, 0, 0);
            }
        }

        // 扫光
        if (this._shineMat && this._shineT >= 0 && badge) {
            this._shineT += dt;
            const cyc = this._shineT % 1.6;
            this._shine.x = cyc < 0.6 ? -0.3 + 1.6 * (cyc / 0.6) : -1;
            const ut = badge.getComponent(UITransform);
            const sp = badge.getComponent(Sprite);
            if (ut && sp) {
                const r = ut.getBoundingBoxToWorld();
                this._shineRect.set(r.x, r.y, r.width, r.height);
                const mi = sp.getMaterialInstance(0);
                if (mi) { mi.setProperty('shineRect', this._shineRect); mi.setProperty('shineParams', this._shine); }
            }
        } else if (this._shineMat && badge) {
            const sp = badge.getComponent(Sprite);
            const mi = sp?.getMaterialInstance(0);
            if (mi && this._shine.x !== -1) { this._shine.x = -1; mi.setProperty('shineParams', this._shine); }
        }

        this.drawBack(dt);
        this.drawFront(dt);
    }

    private drawBack(dt: number) {
        const g = this._back; if (!g) return;
        g.clear();
        const badge = this.badge;
        if (badge && this._raysAlpha > 0.01) {
            const c = this._base.get(badge)?.pos || badge.position;
            const R = this.badgeRadius() * 3.2 * this._raysScale;
            const a0 = this._raysAlpha;
            const col = this.mainColor;
            // 程序光晕（没有给 glow 图时）
            if (!this.glow) {
                for (let i = 6; i >= 1; i--) {
                    g.fillColor = new Color(col.r, col.g, col.b, Math.round(255 * a0 * 0.07));
                    g.circle(c.x, c.y, R * 0.28 * i / 2.2);
                    g.fill();
                }
            }
            // 程序光芒（没有给 rays 图时）
            if (!this.rays) {
                const n = 14;
                const rot = this._rayAngle * Math.PI / 180;
                for (let i = 0; i < n; i++) {
                    const a = rot + i / n * Math.PI * 2;
                    const L = R * (i % 2 ? 0.75 : 1.0);
                    const w = Math.PI / n * 0.55;
                    g.fillColor = new Color(col.r, col.g, col.b, Math.round(255 * a0 * (i % 2 ? 0.14 : 0.22)));
                    g.moveTo(c.x, c.y);
                    g.lineTo(c.x + Math.cos(a - w) * L, c.y + Math.sin(a - w) * L);
                    g.lineTo(c.x + Math.cos(a + w) * L, c.y + Math.sin(a + w) * L);
                    g.close();
                    g.fill();
                }
            }
        }
        // 冲击波
        for (let i = this._rings.length - 1; i >= 0; i--) {
            const r = this._rings[i];
            r.age += dt;
            if (r.age < 0) continue;
            const t = r.age / r.life;
            if (t >= 1) { this._rings.splice(i, 1); continue; }
            const e = 1 - Math.pow(1 - t, 3);
            g.lineWidth = Math.max(1, r.w * (1 - t));
            g.strokeColor = new Color(r.color.r, r.color.g, r.color.b, Math.round(255 * (1 - t) * 0.9));
            g.circle(r.x, r.y, r.r0 + (r.r1 - r.r0) * e);
            g.stroke();
        }
    }

    private drawFront(dt: number) {
        const g = this._front; if (!g) return;
        g.clear();
        // 闪光
        for (let i = this._flashes.length - 1; i >= 0; i--) {
            const f = this._flashes[i];
            f.age += dt;
            const t = f.age / f.life;
            if (t >= 1) { this._flashes.splice(i, 1); continue; }
            const a = (1 - t) * (1 - t);
            for (let k = 3; k >= 1; k--) {
                g.fillColor = new Color(255, 255, 240, Math.round(255 * a * 0.22 * k / 3 + 255 * a * 0.1));
                g.circle(f.x, f.y, f.r * (0.4 + 0.6 * t) * k / 3);
                g.fill();
            }
        }
        // 粒子
        for (let i = this._ps.length - 1; i >= 0; i--) {
            const p = this._ps[i];
            p.age += dt;
            const t = p.age / p.life;
            if (t >= 1) { this._ps.splice(i, 1); continue; }
            const d = Math.exp(-p.drag * dt);
            p.vx *= d; p.vy = p.vy * d + p.grav * dt;
            p.x += p.vx * dt; p.y += p.vy * dt;
            p.rot += p.vr * dt;
            const alpha = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
            const c = p.color;
            if (p.kind === 0) {
                const s = p.size * (t < 0.2 ? 0.5 + 2.5 * t : 1 - (t - 0.2) * 0.6);
                g.fillColor = new Color(c.r, c.g, c.b, Math.round(255 * alpha));
                star4(g, p.x, p.y, s, p.rot);
                g.fill();
            } else if (p.kind === 1) {
                const sp = Math.hypot(p.vx, p.vy);
                const L = Math.min(60, sp * 0.05 + 6);
                const nx = p.vx / (sp || 1), ny = p.vy / (sp || 1);
                g.lineWidth = p.size * (1 - t * 0.5);
                g.strokeColor = new Color(c.r, c.g, c.b, Math.round(255 * alpha));
                g.moveTo(p.x, p.y);
                g.lineTo(p.x - nx * L, p.y - ny * L);
                g.stroke();
            } else {
                const s = p.size * (1 - t * 0.6);
                g.fillColor = new Color(c.r, c.g, c.b, Math.round(90 * alpha));
                g.circle(p.x, p.y, s * 1.8); g.fill();
                g.fillColor = new Color(255, 255, 255, Math.round(230 * alpha));
                g.circle(p.x, p.y, s * 0.55); g.fill();
            }
        }
    }
}

function rand(a: number, b: number) { return a + Math.random() * (b - a); }

/** 四角星 */
function star4(g: Graphics, x: number, y: number, s: number, rot: number) {
    for (let i = 0; i < 8; i++) {
        const a = rot + i * Math.PI / 4;
        const r = i % 2 === 0 ? s : s * 0.3;
        const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.close();
}
