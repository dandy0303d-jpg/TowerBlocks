import {
    _decorator, Component, Node, Label, Sprite, SpriteFrame, UIOpacity, UITransform, Vec3, Color,
    tween, Graphics,
} from 'cc';
const { ccclass, property } = _decorator;

/**
 * 点击徽章领取钻石特效（Cocos Creator 3.8.x，2D UI）
 *
 * 流程（默认约 1.6 秒）：
 *   0.00  徽章按下回弹，白色闪光 + 光环扩散 + 星星迸发
 *   0.03  一把钻石从徽章里喷出，四散旋转、减速悬停；「+N」数字从徽章上方弹出后上飘淡出
 *   0.40  钻石一颗接一颗沿弧线飞向钻石栏（带粉色星光拖尾），边飞边缩到和钻石图标一样大
 *   每颗到达：钻石图标放大回弹 + 小闪光，数字滚动增加，调用 onEachArrive
 *   全部到达：调用 onComplete，特效结束
 *
 * 特点：
 *   - 脚本只用自己创建的节点做动画，不修改徽章、徽章上的小钻石角标、钻石栏的显示隐藏。
 *     角标什么时候去掉、数据什么时候写入，都由宿主在 onStart / onComplete 里决定。
 *   - 目标（钻石栏图标）可以传函数，每帧重新取，面板被重建也能跟上；节点失效时回弹自动跳过。
 *   - 不给钻石图片也能用：脚本会自己画粉色宝石。
 *
 * 节点：建一个铺满屏幕的空节点（UITransform 全屏），放在徽章弹窗和钻石栏之上，挂本脚本即可。
 *   不需要 BlockInputEvents（特效不挡点击）；想在领取期间防连点，由宿主自己处理。
 *
 * 用法：
 *   await this.diamondFx.play({
 *       from: badgeNode,                     // 被点的徽章格子
 *       amount: 20,                          // 奖励钻石数
 *       target: () => this.gemIconNode,      // 钻石栏图标（可空：钻石喷出后原地上飘消失）
 *       counter: this.gemLabel,              // 可空：钻石数字 Label，会从 fromValue 滚到 fromValue + amount
 *       fromValue: 1305,
 *       onStart: () => this.hideBadgeGemTag(badgeNode),
 *       onComplete: () => this.saveGems(),
 *   });
 */

export interface DiamondClaimOptions {
    /** 被点击的徽章节点（钻石从这里喷出） */
    from: Node;
    /** 奖励数量，用于「+N」和数字滚动 */
    amount: number;
    /** 钻石栏图标。可传函数，每帧重新取。为空则钻石喷出后原地上飘淡出 */
    target?: Node | null | (() => Node | null);
    /** 钻石数字 Label（可空）。每颗钻石到达时滚动增加 */
    counter?: Label | null;
    /** 数字起始值（传了 counter 时需要） */
    fromValue?: number;
    /** 数字格式化，默认直接转字符串 */
    format?: (v: number) => string;
    /** 飞出的钻石颗数，默认按数量自动（5~12 颗） */
    gems?: number;
    /** 是否显示「+N」，默认 true */
    showAmount?: boolean;
    /** 特效开始的瞬间调用（适合在这里去掉徽章上的钻石角标） */
    onStart?: () => void;
    /** 每颗钻石到达时调用，index 从 0 开始 */
    onEachArrive?: (index: number, total: number) => void;
    /** 全部到达后调用 */
    onComplete?: () => void;
}

interface Gem {
    node: Node;
    x: number; y: number; vx: number; vy: number;
    rot: number; vr: number;
    s: number;            // 当前缩放
    s0: number;           // 喷出后大小
    delay: number;        // 开始飞向目标的时间
    t: number;            // 飞行进度 0~1
    sx: number; sy: number;   // 起飞点
    side: number;
    phase: 0 | 1 | 2;     // 0 喷出 1 飞行 2 结束
    arc: number;
}
interface P { kind: 0 | 2; x: number; y: number; vx: number; vy: number; age: number; life: number; size: number; rot: number; vr: number; drag: number; grav: number; color: Color; }
interface Ring { x: number; y: number; age: number; life: number; r0: number; r1: number; w: number; color: Color; }
interface Flash { x: number; y: number; age: number; life: number; r: number; }

const WHITE = new Color(255, 255, 255, 255);
const PINK_LIGHT = new Color(255, 190, 220, 255);
const GOLD = new Color(255, 214, 74, 255);

@ccclass('DiamondClaimEffect')
export class DiamondClaimEffect extends Component {

    @property({ type: SpriteFrame, tooltip: '钻石图片（可空，空则脚本画粉色宝石）' }) diamondFrame: SpriteFrame | null = null;
    @property({ tooltip: '喷出时钻石的大小（像素）' }) gemSize = 56;
    @property({ tooltip: '喷出阶段时长（秒）' }) burstTime = 0.38;
    @property({ tooltip: '每颗钻石之间的起飞间隔（秒）' }) gemInterval = 0.05;
    @property({ tooltip: '单颗飞行时长（秒）' }) flyTime = 0.55;
    @property({ tooltip: '主色（光环、拖尾）' }) mainColor = new Color(255, 110, 170, 255);
    @property({ tooltip: '「+N」字号' }) amountFontSize = 54;
    @property({ tooltip: '「+N」颜色' }) amountColor = new Color(255, 236, 120, 255);

    // -------------------------------------------------------------

    private _fx: Graphics | null = null;
    private _gemLayer: Node | null = null;
    private _pool: Node[] = [];
    private _ps: P[] = [];
    private _rings: Ring[] = [];
    private _flashes: Flash[] = [];

    onLoad() { this.ensureLayers(); }

    /** 播放一次领取，全部钻石到达（或淡出）后 resolve。可以同时播多次。 */
    play(opts: DiamondClaimOptions): Promise<void> {
        this.node.active = true;
        this.ensureLayers();
        const from = opts.from;
        if (!from || !from.isValid) return Promise.resolve();

        const getTarget = (): Node | null => {
            const t = typeof opts.target === 'function' ? opts.target() : opts.target;
            return t && t.isValid ? t : null;
        };
        const c = this.toLocal(from);
        const fr = this.nodeRadius(from);
        const count = Math.max(1, Math.round(opts.gems ?? Math.min(12, Math.max(5, Math.round(Math.sqrt(opts.amount) * 2)))));

        try { opts.onStart?.(); } catch (e) { console.error(e); }

        // 1. 徽章按下回弹 + 闪光
        this.punch(from, 0.88, 1.18);
        this._flashes.push({ x: c.x, y: c.y, age: 0, life: 0.3, r: fr * 1.5 });
        this._rings.push({ x: c.x, y: c.y, age: 0, life: 0.45, r0: fr * 0.6, r1: fr * 2.2, w: 8, color: WHITE });
        this._rings.push({ x: c.x, y: c.y, age: -0.06, life: 0.6, r0: fr * 0.8, r1: fr * 2.8, w: 5, color: this.mainColor });
        for (let i = 0; i < 14; i++) {
            const a = Math.random() * Math.PI * 2, sp = rand(180, 420);
            this.add(0, c.x, c.y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.4, 0.7), rand(8, 16), [WHITE, GOLD, PINK_LIGHT][i % 3], 3.5, 0);
        }
        if (opts.showAmount !== false) this.floatAmount(c.x, c.y + fr * 0.9, opts.amount);

        // 2. 喷出钻石
        const target0 = getTarget();
        const hasTarget = !!target0;
        const endScale = target0 ? this.scaleForTarget(target0) : 1;
        const gems: Gem[] = [];
        for (let i = 0; i < count; i++) {
            const a = (i / count) * Math.PI * 2 + rand(-0.3, 0.3) + Math.PI / 2;
            const sp = rand(260, 480);
            const node = this.takeGemNode();
            const g: Gem = {
                node, x: c.x, y: c.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp + 120,
                rot: rand(-20, 20), vr: rand(-360, 360), s: 0.2, s0: rand(0.8, 1.05),
                delay: this.burstTime + i * this.gemInterval, t: 0, sx: 0, sy: 0,
                side: Math.random() < 0.5 ? -1 : 1, phase: 0, arc: rand(0.15, 0.35),
            };
            node.setPosition(c.x, c.y, 0);
            node.setScale(0.2, 0.2, 1);
            this.opOf(node).opacity = 255;
            gems.push(g);
        }

        return new Promise<void>(resolve => {
            let arrived = 0;
            let value = opts.fromValue ?? 0;
            const total = opts.amount;
            const fmt = opts.format || ((v: number) => String(v));
            const per = count > 0 ? total / count : total;
            const job = {
                gems, getTarget, endScale, hasTarget, lastEnd: target0 ? this.toLocal(target0) : new Vec3(c.x, c.y + 200, 0),
                age: 0,
                arrive: (i: number) => {
                    arrived++;
                    const tgt = getTarget();
                    if (tgt) {
                        this.punch(tgt, 1.35, 1.0);
                        const p = job.lastEnd;
                        this._flashes.push({ x: p.x, y: p.y, age: 0, life: 0.2, r: 40 });
                        for (let k = 0; k < 4; k++) {
                            const a = Math.random() * Math.PI * 2, sp = rand(120, 260);
                            this.add(0, p.x, p.y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.3, 0.5), rand(7, 12), k % 2 ? WHITE : PINK_LIGHT, 4, 0);
                        }
                    }
                    if (opts.counter && opts.counter.isValid) {
                        value = arrived >= count ? (opts.fromValue ?? 0) + total : Math.round((opts.fromValue ?? 0) + per * arrived);
                        opts.counter.string = fmt(value);
                    }
                    try { opts.onEachArrive?.(i, count); } catch (e) { console.error(e); }
                    if (arrived >= count) {
                        try { opts.onComplete?.(); } catch (e) { console.error(e); }
                        this._jobs.splice(this._jobs.indexOf(job), 1);
                        this.scheduleOnce(() => resolve(), 0.35);
                    }
                },
            };
            this._jobs.push(job);
        });
    }

    // ================= 内部 =================

    private _jobs: {
        gems: Gem[]; getTarget: () => Node | null; endScale: number; hasTarget: boolean; lastEnd: Vec3; age: number;
        arrive: (i: number) => void;
    }[] = [];

    private ensureLayers() {
        if (!this._gemLayer) {
            const n = new Node('DiamondGems');
            n.layer = this.node.layer;
            n.addComponent(UITransform);
            this.node.addChild(n);
            this._gemLayer = n;
        }
        if (!this._fx) {
            const n = new Node('DiamondFx');
            n.layer = this.node.layer;
            n.addComponent(UITransform);
            this._fx = n.addComponent(Graphics);
            this.node.addChild(n);
        }
        // 星光在钻石下面，闪光画在同一层（Graphics 一层就够）
        this._fx.node.setSiblingIndex(0);
        this._gemLayer.setSiblingIndex(this.node.children.length - 1);
    }

    private takeGemNode(): Node {
        let n = this._pool.pop();
        if (!n || !n.isValid) {
            n = new Node('Gem');
            n.layer = this.node.layer;
            const ut = n.addComponent(UITransform);
            ut.setContentSize(this.gemSize, this.gemSize);
            if (this.diamondFrame) {
                const sp = n.addComponent(Sprite);
                sp.sizeMode = Sprite.SizeMode.CUSTOM;
                sp.spriteFrame = this.diamondFrame;
            } else {
                drawGem(n.addComponent(Graphics), this.gemSize);
            }
        }
        n.active = true;
        this._gemLayer!.addChild(n);
        return n;
    }

    private releaseGem(n: Node) {
        n.active = false;
        this._pool.push(n);
    }

    private opOf(n: Node): UIOpacity { return n.getComponent(UIOpacity) || n.addComponent(UIOpacity); }

    private toLocal(n: Node): Vec3 {
        const ut = this.node.getComponent(UITransform);
        return ut ? ut.convertToNodeSpaceAR(n.worldPosition) : n.worldPosition.clone();
    }

    private nodeRadius(n: Node): number {
        const ut = n.getComponent(UITransform);
        const s = Math.abs(n.worldScale.x) / Math.max(0.0001, Math.abs(this.node.worldScale.x));
        return ut ? Math.max(ut.width, ut.height) * 0.5 * s : 50;
    }

    /** 飞到目标时的缩放：和目标图标一样大 */
    private scaleForTarget(t: Node): number {
        const r = this.nodeRadius(t) * 2;
        return Math.max(0.2, Math.min(1.5, r / this.gemSize));
    }

    /** 放大/缩小回弹（代理对象驱动，节点失效自动跳过，结束恢复原缩放；连续触发不会越弹越大） */
    private punch(n: Node, k0: number, k1: number) {
        const st = n as any;
        if (st.__dcTw) { st.__dcTw.stop(); st.__dcTw = null; }
        const base: Vec3 = st.__dcBase || n.scale.clone();
        st.__dcBase = base;
        const prox = { k: k0 };
        const apply = () => { if (n.isValid) n.setScale(base.x * prox.k, base.y * prox.k, base.z); };
        apply();
        const tw = k1 !== 1.0
            ? tween(prox).to(0.08, { k: k1 }, { easing: 'quadOut', onUpdate: apply }).to(0.22, { k: 1 }, { easing: 'backOut', onUpdate: apply })
            : tween(prox).to(0.25, { k: 1 }, { easing: 'backOut', onUpdate: apply });
        st.__dcTw = tw.call(() => { if (n.isValid) n.setScale(base); st.__dcBase = undefined; st.__dcTw = null; }).start();
    }

    private floatAmount(x: number, y: number, amount: number) {
        const n = new Node('PlusAmount');
        n.layer = this.node.layer;
        n.addComponent(UITransform);
        const lb = n.addComponent(Label);
        lb.string = `+${amount}`;
        lb.fontSize = this.amountFontSize;
        lb.lineHeight = this.amountFontSize * 1.1;
        lb.isBold = true;
        lb.color = this.amountColor;
        const anyLb = lb as any;
        if ('enableOutline' in anyLb) { anyLb.enableOutline = true; anyLb.outlineColor = new Color(90, 20, 60, 255); anyLb.outlineWidth = 4; }
        if ('enableShadow' in anyLb) { anyLb.enableShadow = true; anyLb.shadowColor = new Color(0, 0, 0, 160); anyLb.shadowOffset = { x: 0, y: -3 }; }
        this.node.addChild(n);
        n.setPosition(x, y, 0);
        n.setScale(0, 0, 1);
        const op = this.opOf(n);
        tween(n)
            .to(0.18, { scale: new Vec3(1.3, 1.3, 1) }, { easing: 'backOut' })
            .to(0.12, { scale: new Vec3(1, 1, 1) })
            .by(0.7, { position: new Vec3(0, 70, 0) }, { easing: 'sineOut' })
            .start();
        tween(op).delay(0.65).to(0.35, { opacity: 0 }).call(() => n.destroy()).start();
    }

    private add(kind: 0 | 2, x: number, y: number, vx: number, vy: number, life: number, size: number, color: Color, drag: number, grav: number) {
        this._ps.push({ kind, x, y, vx, vy, age: 0, life, size, rot: rand(0, Math.PI), vr: rand(-4, 4), drag, grav, color });
    }

    update(dt: number) {
        for (let j = this._jobs.length - 1; j >= 0; j--) {
            const job = this._jobs[j];
            if (!job) continue;
            job.age += dt;
            const tgt = job.getTarget();
            if (tgt) job.lastEnd = this.toLocal(tgt);
            const end = job.lastEnd;

            for (let i = 0; i < job.gems.length; i++) {
                const g = job.gems[i];
                if (g.phase === 2) continue;
                if (g.phase === 0) {
                    // 喷出：减速、轻微下坠、从小变大
                    const d = Math.exp(-5.5 * dt);
                    g.vx *= d; g.vy = g.vy * d - 260 * dt;
                    g.x += g.vx * dt; g.y += g.vy * dt;
                    g.vr *= Math.exp(-3 * dt);
                    g.rot += g.vr * dt;
                    g.s += (g.s0 - g.s) * Math.min(1, dt * 14);
                    if (job.age >= g.delay) {
                        g.phase = 1; g.sx = g.x; g.sy = g.y; g.t = 0;
                        if (!job.hasTarget) { this.fadeUp(g); continue; }
                    }
                } else {
                    // 飞向目标：二次贝塞尔，先慢后快
                    g.t = Math.min(1, g.t + dt / this.flyTime);
                    const e = g.t * g.t;
                    const u = 1 - e;
                    const dx = end.x - g.sx, dy = end.y - g.sy;
                    const len = Math.max(1, Math.hypot(dx, dy));
                    const cx = (g.sx + end.x) / 2 + (-dy / len) * len * g.arc * g.side;
                    const cy = (g.sy + end.y) / 2 + (dx / len) * len * g.arc * g.side;
                    g.x = u * u * g.sx + 2 * u * e * cx + e * e * end.x;
                    g.y = u * u * g.sy + 2 * u * e * cy + e * e * end.y;
                    g.rot += (0 - g.rot) * Math.min(1, dt * 8);
                    g.s = g.s0 + (job.endScale - g.s0) * e;
                    // 拖尾
                    if (Math.random() < 0.8) this.add(2, g.x + rand(-6, 6), g.y + rand(-6, 6), rand(-20, 20), rand(-20, 20),
                        rand(0.25, 0.45), rand(4, 8) * Math.max(0.5, g.s), Math.random() < 0.3 ? WHITE : this.mainColor, 2, 0);
                    if (g.t >= 1) {
                        g.phase = 2;
                        this.releaseGem(g.node);
                        job.arrive(i);
                        continue;
                    }
                }
                g.node.setPosition(g.x, g.y, 0);
                g.node.setScale(g.s, g.s, 1);
                g.node.angle = g.rot;
                // 喷出阶段偶尔闪一下
                if (g.phase === 0 && Math.random() < dt * 3) this.add(0, g.x, g.y, 0, 0, 0.3, 10 * g.s, WHITE, 0, 0);
            }
        }

        this.drawFx(dt);
    }

    /** 没有目标时：钻石上飘淡出 */
    private fadeUp(g: Gem) {
        const job = this._jobs.find(j => j.gems.includes(g));
        g.phase = 2;
        const n = g.node;
        const op = this.opOf(n);
        tween(n).by(0.5, { position: new Vec3(0, 80, 0) }, { easing: 'sineOut' }).start();
        tween(op).to(0.5, { opacity: 0 }).call(() => {
            op.opacity = 255;
            this.releaseGem(n);
            if (job) job.arrive(job.gems.indexOf(g));
        }).start();
    }

    private drawFx(dt: number) {
        const g = this._fx; if (!g) return;
        g.clear();
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
        for (let i = this._flashes.length - 1; i >= 0; i--) {
            const f = this._flashes[i];
            f.age += dt;
            const t = f.age / f.life;
            if (t >= 1) { this._flashes.splice(i, 1); continue; }
            const a = (1 - t) * (1 - t);
            for (let k = 3; k >= 1; k--) {
                g.fillColor = new Color(255, 250, 250, Math.round(255 * a * (0.12 + 0.2 * k / 3)));
                g.circle(f.x, f.y, f.r * (0.4 + 0.6 * t) * k / 3);
                g.fill();
            }
        }
        for (let i = this._ps.length - 1; i >= 0; i--) {
            const p = this._ps[i];
            p.age += dt;
            const t = p.age / p.life;
            if (t >= 1) { this._ps.splice(i, 1); continue; }
            const d = Math.exp(-p.drag * dt);
            p.vx *= d; p.vy = p.vy * d + p.grav * dt;
            p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
            const alpha = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
            const c = p.color;
            if (p.kind === 0) {
                const s = p.size * (t < 0.2 ? 0.5 + 2.5 * t : 1 - (t - 0.2) * 0.6);
                g.fillColor = new Color(c.r, c.g, c.b, Math.round(255 * alpha));
                star4(g, p.x, p.y, s, p.rot);
                g.fill();
            } else {
                const s = p.size * (1 - t * 0.6);
                g.fillColor = new Color(c.r, c.g, c.b, Math.round(90 * alpha));
                g.circle(p.x, p.y, s * 1.8); g.fill();
                g.fillColor = new Color(255, 255, 255, Math.round(220 * alpha));
                g.circle(p.x, p.y, s * 0.55); g.fill();
            }
        }
    }
}

function rand(a: number, b: number) { return a + Math.random() * (b - a); }

function star4(g: Graphics, x: number, y: number, s: number, rot: number) {
    for (let i = 0; i < 8; i++) {
        const a = rot + i * Math.PI / 4;
        const r = i % 2 === 0 ? s : s * 0.3;
        const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.close();
}

/** 没有钻石图时画一颗粉色宝石（和截图里的钻石角标同风格） */
function drawGem(g: Graphics, size: number) {
    const w = size * 0.5, h = size * 0.46;
    const top = h * 0.55, mid = h * 0.15, bot = -h;
    const tw = w * 0.55;
    // 外形
    const outline: [number, number][] = [[-tw, top], [tw, top], [w, mid], [0, bot], [-w, mid]];
    const poly = (pts: [number, number][], col: Color) => {
        g.fillColor = col;
        pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
        g.close(); g.fill();
    };
    poly(outline, new Color(214, 40, 110, 255));
    // 上面的冠部
    poly([[-tw, top], [tw, top], [w, mid], [-w, mid]], new Color(255, 120, 175, 255));
    poly([[-tw * 0.35, top], [tw * 0.35, top], [tw * 0.55, mid], [-tw * 0.55, mid]], new Color(255, 185, 215, 255));
    // 下面的亭部分面
    poly([[-w, mid], [-tw * 0.55, mid], [0, bot]], new Color(235, 70, 140, 255));
    poly([[tw * 0.55, mid], [w, mid], [0, bot]], new Color(180, 25, 90, 255));
    // 高光
    poly([[-tw * 0.8, top * 0.9], [-tw * 0.45, top * 0.9], [-w * 0.55, mid * 1.2]], new Color(255, 240, 248, 220));
    // 描边
    g.lineWidth = Math.max(2, size * 0.05);
    g.strokeColor = new Color(110, 15, 55, 255);
    outline.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
    g.close(); g.stroke();
}
