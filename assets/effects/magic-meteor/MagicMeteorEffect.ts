import {
    _decorator, Component, Node, Label, UIOpacity, UITransform, Vec3, Color,
    tween, Graphics,
} from 'cc';
const { ccclass, property } = _decorator;

/**
 * 魔法道具「陨石」特效：陨石数量在屏幕中央计数，再飞向指定区域（Cocos Creator 3.8.x，2D UI）
 *
 * 流程（默认约 2.4 秒）：
 *   0.00  一颗燃烧的大陨石拖着火焰从右上方砸进屏幕中央 → 落地冲击波 + 火星四溅，背后展开橙红魔法阵
 *   0.45  小陨石围着大陨石公转（带火焰尾），数字「×0」弹出并快速计数到「×N」；每跳一下，一颗流星从天上斜着划进中心
 *   1.20  计数完成：闪光 + 冲击波 + 碎石火星，数字放大停顿
 *   1.45  大陨石缩小消失；数字沿弧线飞向目标区域，拖着火焰；小陨石排成一串跟在后面
 *   2.00  数字到达：目标放大回弹 + 闪光，计数 Label 滚动到新数量，调用 onArrive；后面的小陨石依次撞进目标，每颗闪一下
 *
 * 用法：
 *   await this.meteorFx.play({
 *       count: 5,
 *       from: this.meteorItemBtn,            // 可空
 *       target: () => this.meteorCountNode,   // 指定区域（节点或函数）
 *       counterLabel: this.meteorLabel,       // 可空：到达时滚动到 fromCount + count
 *       fromCount: 0,
 *       onArrive: () => this.addMeteors(5),
 *   });
 */

export interface MagicMeteorOptions {
    /** 陨石数量 */
    count: number;
    /** 道具按钮（可空）：开场时一道火光从这里飞到中央 */
    from?: Node | null;
    /** 指定区域，可传函数（每帧重新取）。为空则展示后原地淡出 */
    target?: Node | null | (() => Node | null);
    /** 数量 Label（可空），到达时滚动到 fromCount + count */
    counterLabel?: Label | null;
    fromCount?: number;
    /** 数字格式，默认「×N」 */
    format?: (n: number) => string;
    /** Label 上的数字格式，默认直接 String(n) */
    labelFormat?: (n: number) => string;
    /** 数字到达瞬间调用 */
    onArrive?: () => void;
}

interface P { kind: 0 | 2; x: number; y: number; vx: number; vy: number; age: number; life: number; size: number; rot: number; vr: number; drag: number; grav: number; color: Color; }
interface Ring { x: number; y: number; age: number; life: number; r0: number; r1: number; w: number; color: Color; }
interface Flash { x: number; y: number; age: number; life: number; r: number; }
interface Follower { x: number; y: number; delay: number; t: number; sx: number; sy: number; s: number; rot: number; done: boolean; side: number; }

const WHITE = new Color(255, 255, 255, 255);
/** 大陨石从右上方砸下来的运动方向 */
const BIG_DIR = Math.atan2(-9, -6);
const FIRE: Color[] = [new Color(255, 230, 120), new Color(255, 170, 60), new Color(255, 100, 50), new Color(255, 60, 60)];

@ccclass('MagicMeteorEffect')
export class MagicMeteorEffect extends Component {

    @property({ tooltip: '中央大陨石半径（像素）' }) meteorRadius = 80;
    @property({ tooltip: '小陨石大小（像素）' }) smallSize = 40;
    @property({ tooltip: '展示位置 Y 偏移（相对本节点中心）' }) centerOffsetY = 60;
    @property({ tooltip: '计数时长（秒）' }) countTime = 0.7;
    @property({ tooltip: '飞行时长（秒）' }) flyTime = 0.55;
    @property({ tooltip: '跟飞的小陨石最多几颗' }) maxFollowers = 6;
    @property({ tooltip: '数字字号' }) numberFontSize = 104;
    @property({ tooltip: '数字颜色' }) numberColor = new Color(255, 240, 150, 255);
    @property({ tooltip: '数字描边颜色' }) numberOutline = new Color(140, 30, 10, 255);
    @property({ tooltip: '魔法阵颜色' }) magicColor = new Color(255, 130, 60, 255);

    private _fx: Graphics | null = null;
    private _top: Graphics | null = null;
    private _ps: P[] = [];
    private _rings: Ring[] = [];
    private _flashes: Flash[] = [];
    private _orbit = { on: false, x: 0, y: 0, a: 0, rot: 0, speed: 0, r: 0 };
    private _circle = { a: 0, r: 0, rot: 0 };
    private _followers: Follower[] = [];
    private _t = 0;
    private _orbitN = 6;

    onLoad() { this.ensureLayers(); }

    async play(o: MagicMeteorOptions): Promise<void> {
        this.node.active = true;
        this.ensureLayers();
        const getTarget = (): Node | null => {
            const t = typeof o.target === 'function' ? o.target() : o.target;
            return t && t.isValid ? t : null;
        };
        const fmt = o.format || ((n: number) => `×${n}`);
        const center = new Vec3(0, this.centerOffsetY, 0);
        const R = this.meteorRadius;

        // 1. 大陨石从右上方砸进中央
        this._orbitN = Math.max(1, Math.min(6, this.maxFollowers, o.count));
        const b = this._orbit; b.on = true; b.x = center.x; b.y = center.y; b.a = 1; b.speed = 0; b.r = 0;
        const c = this._circle; c.a = 0; c.r = 0;
        if (o.from && o.from.isValid) this.beam(this.toLocal(o.from), center);
        const drop = { t: 0 };
        const sx = center.x + R * 6, sy = center.y + R * 9;
        this._big = { x: sx, y: sy, s: 0.6 };
        await new Promise<void>(res => tween(drop).to(0.35, { t: 1 }, {
            easing: 'quadIn',
            onUpdate: () => { const t = drop.t; this._big!.x = sx + (center.x - sx) * t; this._big!.y = sy + (center.y - sy) * t; this._big!.s = 0.6 + 0.4 * t; },
        }).call(() => res()).start());
        this._flashes.push({ x: center.x, y: center.y, age: 0, life: 0.3, r: R * 2.2 });
        this._rings.push({ x: center.x, y: center.y, age: 0, life: 0.5, r0: R, r1: R * 3.5, w: 10, color: FIRE[1] });
        this.burst(center.x, center.y, R * 0.8, 1);
        tween(c).to(0.35, { a: 1, r: R * 2.3 }, { easing: 'backOut' }).start();
        tween(b).to(0.35, { r: R * 1.55 }, { easing: 'backOut' }).start();
        tween(b).to(0.9, { speed: 6 }, { easing: 'quadIn' }).start();
        await this.wait(0.1);

        // 2. 数字计数
        const num = this.makeNumber(fmt(0));
        num.setPosition(center.x, center.y, 0); num.setScale(0, 0, 1);
        const lb = num.getComponent(Label)!;
        tween(num).to(0.15, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
        const steps = Math.min(o.count, 20);
        for (let i = 1; i <= steps; i++) {
            const v = Math.round(o.count * i / steps);
            lb.string = fmt(v);
            num.setScale(1.12, 1.12, 1);
            tween(num).to(0.05, { scale: new Vec3(1, 1, 1) }).start();
            this.streak(center, R);
            await this.wait(this.countTime / steps);
        }

        // 3. 计数完成
        this._flashes.push({ x: center.x, y: center.y, age: 0, life: 0.35, r: R * 2 });
        this._rings.push({ x: center.x, y: center.y, age: 0, life: 0.5, r0: R * 0.6, r1: R * 3, w: 9, color: WHITE });
        this._rings.push({ x: center.x, y: center.y, age: -0.05, life: 0.65, r0: R * 0.8, r1: R * 3.6, w: 6, color: this.magicColor });
        this.burst(center.x, center.y, R * 0.6, 1);
        await new Promise<void>(res => tween(num).to(0.08, { scale: new Vec3(1.45, 1.45, 1) }).to(0.22, { scale: new Vec3(1.15, 1.15, 1) }, { easing: 'backOut' }).delay(0.15).call(() => res()).start());

        // 4. 飞向目标，小陨石跟随
        tween(c).to(0.35, { a: 0, r: R * 2.6 }).start();
        let tgt = getTarget();
        const start = center.clone();
        let end = tgt ? this.toLocal(tgt) : new Vec3(center.x, center.y + R * 2, 0);
        const side = end.x >= start.x ? 1 : -1;
        const nb = this._orbitN;
        // 公转的小陨石依次脱离轨道，跟着数字飞
        for (let i = 0; i < nb; i++) {
            const a = b.rot + i / this._orbitN * Math.PI * 2;
            this._followers.push({ x: b.x + Math.cos(a) * R, y: b.y + Math.sin(a) * R, delay: 0.12 + i * 0.06, t: 0, sx: 0, sy: 0, s: 1, rot: 0, done: false, side });
        }
        tween(b).to(0.25, { a: 0 }).call(() => { b.on = false; }).start();
        if (this._big) tween(this._big).to(0.3, { s: 0 }, { easing: 'backIn' }).call(() => { this._big = null; }).start();
        if (!tgt) {
            tween(num.getComponent(UIOpacity) || num.addComponent(UIOpacity)).to(0.3, { opacity: 0 }).start();
            this._followers.length = 0;
            try { o.onArrive?.(); } catch (e) { console.error(e); }
            await this.wait(0.4); num.destroy(); return;
        }
        const fly = { t: 0 };
        this._endFn = () => { const t2 = getTarget(); if (t2) end = this.toLocal(t2); return end; };
        await new Promise<void>(res => tween(fly).to(this.flyTime, { t: 1 }, {
            easing: 'quadIn',
            onUpdate: () => {
                this._endFn!();
                const t = fly.t, u = 1 - t;
                const dx = end.x - start.x, dy = end.y - start.y, len = Math.max(1, Math.hypot(dx, dy));
                const cx = (start.x + end.x) / 2 - dy / len * len * 0.3 * side, cy = (start.y + end.y) / 2 + dx / len * len * 0.3 * side;
                const x = u * u * start.x + 2 * u * t * cx + t * t * end.x, y = u * u * start.y + 2 * u * t * cy + t * t * end.y;
                if (num.isValid) { num.setPosition(x, y, 0); const s = 1.15 - 0.7 * t; num.setScale(s, s, 1); num.angle = Math.sin(t * Math.PI) * -10 * side; }
                for (let i = 0; i < 3; i++) this.add(2, x + rand(-14, 14), y + rand(-14, 14), rand(-40, 40), rand(-40, 40), rand(0.25, 0.5), rand(6, 12), FIRE[(Math.random() * FIRE.length) | 0], 2, 60);
            },
        }).call(() => res()).start());

        // 5. 数字到达
        num.destroy();
        tgt = getTarget();
        this._flashes.push({ x: end.x, y: end.y, age: 0, life: 0.25, r: 80 });
        this._rings.push({ x: end.x, y: end.y, age: 0, life: 0.45, r0: 20, r1: 120, w: 7, color: this.magicColor });
        this.burst(end.x, end.y, 20, 0.5);
        if (tgt) punch(tgt);
        if (o.counterLabel && o.counterLabel.isValid) {
            const lbl = o.counterLabel, f2 = o.labelFormat || ((n: number) => String(n));
            const v0 = o.fromCount ?? 0, v1 = v0 + o.count, p = { v: v0 };
            tween(p).to(0.4, { v: v1 }, { easing: 'quadOut', onUpdate: () => { if (lbl.isValid) lbl.string = f2(Math.round(p.v)); } })
                .call(() => { if (lbl.isValid) lbl.string = f2(v1); }).start();
        }
        try { o.onArrive?.(); } catch (e) { console.error(e); }
        // 等跟飞的小陨石全部到达
        await this.wait(0.15 + nb * 0.06 + 0.3);
        this._followers.length = 0;
        this._endFn = null;
    }

    // ================= 内部 =================
    private _endFn: (() => Vec3) | null = null;

    private ensureLayers() {
        if (!this._fx) this._fx = makeLayer(this.node, 'MeteorFxBack');
        if (!this._top) this._top = makeLayer(this.node, 'MeteorFxTop');
        this._fx.node.setSiblingIndex(0);
        this._top.node.setSiblingIndex(this.node.children.length - 1);
    }
    private wait(s: number) { return new Promise<void>(r => this.scheduleOnce(() => r(), s)); }
    private toLocal(n: Node): Vec3 {
        const ut = this.node.getComponent(UITransform);
        return ut ? ut.convertToNodeSpaceAR(n.worldPosition) : n.worldPosition.clone();
    }
    private makeNumber(text: string): Node {
        const n = new Node('MeteorNumber'); n.layer = this.node.layer; n.addComponent(UITransform);
        const lb = n.addComponent(Label);
        lb.string = text; lb.fontSize = this.numberFontSize; lb.lineHeight = this.numberFontSize * 1.1; lb.isBold = true; lb.color = this.numberColor;
        const a = lb as any;
        if ('enableOutline' in a) { a.enableOutline = true; a.outlineColor = this.numberOutline; a.outlineWidth = Math.round(this.numberFontSize * 0.07); }
        if ('enableShadow' in a) { a.enableShadow = true; a.shadowColor = new Color(0, 0, 0, 160); a.shadowOffset = { x: 0, y: -4 }; }
        this.node.addChild(n);
        this._top!.node.setSiblingIndex(this.node.children.length - 1);
        return n;
    }
    private beam(a: Vec3, b: Vec3) {
        for (let i = 0; i < 16; i++) {
            const t = i / 16;
            this._ps.push({ kind: 2, x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t + Math.sin(t * Math.PI) * 80, vx: 0, vy: 0, age: -t * 0.25, life: 0.45, size: rand(6, 10), rot: 0, vr: 0, drag: 0, grav: 0, color: FIRE[i % FIRE.length] });
        }
    }
    /** 一颗流星从右上方斜着划进中心 */
    private streak(c: Vec3, R: number) {
        const ox = rand(-R, R) + R * 4, oy = R * 5 + rand(0, R);
        this._streaks.push({ x: c.x + ox, y: c.y + oy, tx: c.x + rand(-R * 0.4, R * 0.4), ty: c.y + rand(-R * 0.4, R * 0.4), t: 0 });
    }
    private _streaks: { x: number; y: number; tx: number; ty: number; t: number }[] = [];
    private _big: { x: number; y: number; s: number } | null = null;

    private burst(x: number, y: number, r: number, k: number) {
        for (let i = 0; i < Math.round(24 * k); i++) {
            const a = Math.random() * Math.PI * 2, sp = rand(260, 620) * (0.5 + k * 0.5);
            this.add(0, x + Math.cos(a) * r * 0.4, y + Math.sin(a) * r * 0.4, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.4, 0.75), rand(9, 18), i % 3 ? FIRE[i % FIRE.length] : WHITE, 3.5, -300);
        }
        for (let i = 0; i < Math.round(16 * k); i++) {
            const a = Math.random() * Math.PI * 2, sp = rand(60, 260);
            this.add(2, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.5, 0.9), rand(4, 8), FIRE[i % FIRE.length], 2, -120);
        }
    }
    private add(kind: 0 | 2, x: number, y: number, vx: number, vy: number, life: number, size: number, color: Color, drag: number, grav: number) {
        this._ps.push({ kind, x, y, vx, vy, age: 0, life, size, rot: rand(0, Math.PI), vr: rand(-5, 5), drag, grav, color });
    }

    update(dt: number) {
        const g = this._fx!, gt = this._top!;
        g.clear(); gt.clear();
        this._t += dt;
        const c = this._circle, b = this._orbit;
        if (c.a > 0.01) { c.rot += dt * 1.2; drawMagicCircle(g, b.x, b.y, c.r, c.rot, this.magicColor, c.a); }
        // 大陨石
        if (this._big && this._big.s > 0.01) drawMeteor(gt, this._big.x, this._big.y, this.meteorRadius * 2 * this._big.s, this._t * 0.6, BIG_DIR, this._t);
        // 小陨石公转
        if (b.on && b.a > 0.01) {
            b.rot += b.speed * dt;
            const n = this._orbitN;
            for (let i = 0; i < n; i++) {
                const a = b.rot + i / n * Math.PI * 2;
                const x = b.x + Math.cos(a) * b.r, y = b.y + Math.sin(a) * b.r * 0.55;   // 椭圆轨道，有立体感
                drawMeteor(gt, x, y, this.smallSize * b.a * (0.8 + 0.2 * Math.sin(a)), this._t + i, a + Math.PI / 2 + Math.PI, this._t);
            }
        }
        // 流星
        for (let i = this._streaks.length - 1; i >= 0; i--) {
            const st = this._streaks[i];
            st.t += dt / 0.22;
            const x = st.x + (st.tx - st.x) * Math.min(1, st.t), y = st.y + (st.ty - st.y) * Math.min(1, st.t);
            if (st.t >= 1) {
                this._streaks.splice(i, 1);
                this._flashes.push({ x: st.tx, y: st.ty, age: 0, life: 0.12, r: 50 });
                for (let k = 0; k < 4; k++) { const a = Math.random() * Math.PI * 2, sp = rand(150, 350); this.add(0, st.tx, st.ty, Math.cos(a) * sp, Math.sin(a) * sp, 0.3, rand(7, 12), FIRE[k % 4], 4, -300); }
                continue;
            }
            const dir = Math.atan2(st.ty - st.y, st.tx - st.x);
            drawMeteor(gt, x, y, this.smallSize * 0.6, this._t * 3, dir, this._t);
        }
        // 跟飞的小陨石
        if (this._followers.length && this._endFn) {
            const end = this._endFn();
            for (const bl of this._followers) {
                if (bl.done) continue;
                if (bl.delay > 0) { bl.delay -= dt; if (bl.delay <= 0) { bl.sx = bl.x; bl.sy = bl.y; } else { drawMeteor(gt, bl.x, bl.y, this.smallSize, bl.rot, Math.PI * 1.25, this._t); continue; } }
                bl.t = Math.min(1, bl.t + dt / (this.flyTime * 0.8));
                const t = bl.t * bl.t, u = 1 - t;
                const dx = end.x - bl.sx, dy = end.y - bl.sy, len = Math.max(1, Math.hypot(dx, dy));
                const cx = (bl.sx + end.x) / 2 - dy / len * len * 0.25 * bl.side, cy = (bl.sy + end.y) / 2 + dx / len * len * 0.25 * bl.side;
                const px = bl.x, py = bl.y;
                bl.x = u * u * bl.sx + 2 * u * t * cx + t * t * end.x; bl.y = u * u * bl.sy + 2 * u * t * cy + t * t * end.y;
                bl.rot += dt * 12; bl.s = 1 - 0.6 * t;
                drawMeteor(gt, bl.x, bl.y, this.smallSize * bl.s, bl.rot, Math.atan2(bl.y - py, bl.x - px), this._t);
                this.add(2, bl.x, bl.y, rand(-20, 20), rand(-20, 20), 0.25, rand(4, 7), FIRE[(Math.random() * 4) | 0], 2, 0);
                if (bl.t >= 1) {
                    bl.done = true;
                    this._flashes.push({ x: end.x, y: end.y, age: 0, life: 0.12, r: 40 });
                    for (let k = 0; k < 3; k++) { const a = Math.random() * Math.PI * 2; this.add(0, end.x, end.y, Math.cos(a) * 200, Math.sin(a) * 200, 0.3, 9, FIRE[k], 4, 0); }
                }
            }
        }
        tickParticles(g, gt, this._ps, dt);
        tickRings(gt, this._rings, dt);
        tickFlashes(gt, this._flashes, dt);
    }
}

/**
 * 燃烧的陨石：dir 为运动方向（弧度），火焰尾巴朝反方向；S 为直径
 */
function drawMeteor(g: Graphics, x: number, y: number, S: number, rot: number, dir: number, time: number) {
    if (S < 2) return;
    const r = S / 2, bx = -Math.cos(dir), by = -Math.sin(dir);   // 尾巴方向
    const nx = -by, ny = bx;
    // 火焰尾：几层从外到内、从红到黄的三角形，长度带抖动
    const layers: [Color, number, number][] = [[FIRE[3], 3.2, 1.05], [FIRE[2], 2.5, 0.85], [FIRE[1], 1.8, 0.62], [FIRE[0], 1.1, 0.4]];
    for (const [col, len, w] of layers) {
        const L = r * len * (0.9 + 0.1 * Math.sin(time * 30 + rot)), W = r * w;
        g.fillColor = alpha(col, 0.85);
        g.moveTo(x + nx * W, y + ny * W);
        g.quadraticCurveTo(x + bx * L * 0.5 + nx * W * 0.8, y + by * L * 0.5 + ny * W * 0.8, x + bx * L, y + by * L);
        g.quadraticCurveTo(x + bx * L * 0.5 - nx * W * 0.8, y + by * L * 0.5 - ny * W * 0.8, x - nx * W, y - ny * W);
        g.close(); g.fill();
    }
    // 外发光
    g.fillColor = alpha(FIRE[1], 0.35); g.circle(x, y, r * 1.3); g.fill();
    // 岩石（不规则多边形）
    const n = 9;
    g.fillColor = new Color(110, 60, 45, 255);
    for (let i = 0; i < n; i++) {
        const a = rot + i / n * Math.PI * 2, rr = r * (0.86 + 0.14 * Math.sin(i * 2.7));
        const px = x + Math.cos(a) * rr, py = y + Math.sin(a) * rr;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.close(); g.fill();
    g.lineWidth = Math.max(2, S * 0.06); g.strokeColor = new Color(50, 20, 15, 255); g.stroke();
    // 迎火面的熔岩亮边
    g.fillColor = alpha(FIRE[1], 0.9);
    g.circle(x - bx * r * 0.35, y - by * r * 0.35, r * 0.45); g.fill();
    g.fillColor = alpha(FIRE[0], 0.9);
    g.circle(x - bx * r * 0.45, y - by * r * 0.45, r * 0.22); g.fill();
    // 陨石坑
    g.fillColor = new Color(70, 35, 28, 255);
    g.circle(x + Math.cos(rot + 1) * r * 0.35, y + Math.sin(rot + 1) * r * 0.35, r * 0.18); g.fill();
    g.circle(x + Math.cos(rot + 3.5) * r * 0.4, y + Math.sin(rot + 3.5) * r * 0.4, r * 0.12); g.fill();
}

// ---------------- 工具函数 ----------------
function rand(a: number, b: number) { return a + Math.random() * (b - a); }
function alpha(c: Color, a: number) { return new Color(c.r, c.g, c.b, Math.max(0, Math.min(255, Math.round(255 * a)))); }
function makeLayer(parent: Node, name: string): Graphics {
    const n = new Node(name); n.layer = parent.layer; n.addComponent(UITransform);
    parent.addChild(n); return n.addComponent(Graphics);
}
function punch(n: Node) {
    const st = n as any;
    if (st.__mmTw) st.__mmTw.stop();
    const base: Vec3 = st.__mmBase || n.scale.clone(); st.__mmBase = base;
    const p = { k: 1.45 };
    const apply = () => { if (n.isValid) n.setScale(base.x * p.k, base.y * p.k, base.z); };
    apply();
    st.__mmTw = tween(p).to(0.35, { k: 1 }, { easing: 'elasticOut', onUpdate: apply })
        .call(() => { if (n.isValid) n.setScale(base); st.__mmBase = undefined; st.__mmTw = null; }).start();
}
function star4(g: Graphics, x: number, y: number, s: number, rot: number) {
    for (let i = 0; i < 8; i++) {
        const a = rot + i * Math.PI / 4, r = i % 2 === 0 ? s : s * 0.3;
        const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.close();
}
function drawMagicCircle(g: Graphics, x: number, y: number, r: number, rot: number, col: Color, a: number) {
    g.lineWidth = 4; g.strokeColor = alpha(col, 0.7 * a); g.circle(x, y, r); g.stroke();
    g.lineWidth = 2; g.strokeColor = alpha(col, 0.5 * a); g.circle(x, y, r * 0.86); g.stroke();
    for (let i = 0; i < 24; i++) {
        const ang = rot + i / 24 * Math.PI * 2, r0 = r * 0.88, r1 = r * (i % 2 ? 0.95 : 0.98);
        g.moveTo(x + Math.cos(ang) * r0, y + Math.sin(ang) * r0); g.lineTo(x + Math.cos(ang) * r1, y + Math.sin(ang) * r1);
    }
    g.stroke();
    const rr = r * 0.78;
    for (const off of [0, Math.PI / 3]) {
        for (let i = 0; i <= 3; i++) {
            const ang = -rot * 0.7 + off + i * Math.PI * 2 / 3;
            const px = x + Math.cos(ang) * rr, py = y + Math.sin(ang) * rr;
            if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
        }
        g.stroke();
    }
    g.fillColor = alpha(col, 0.08 * a); g.circle(x, y, r); g.fill();
}
function tickParticles(g: Graphics, gt: Graphics, ps: P[], dt: number) {
    for (let i = ps.length - 1; i >= 0; i--) {
        const p = ps[i]; p.age += dt;
        if (p.age < 0) continue;
        const t = p.age / p.life;
        if (t >= 1) { ps.splice(i, 1); continue; }
        const d = Math.exp(-p.drag * dt);
        p.vx *= d; p.vy = p.vy * d + p.grav * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
        const al = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
        if (p.kind === 0) {
            const s = p.size * (t < 0.2 ? 0.5 + 2.5 * t : 1 - (t - 0.2) * 0.6);
            gt.fillColor = alpha(p.color, al); star4(gt, p.x, p.y, s, p.rot); gt.fill();
        } else {
            const s = p.size * (1 - t * 0.5);
            g.fillColor = alpha(p.color, 0.35 * al); g.circle(p.x, p.y, s * 1.8); g.fill();
            g.fillColor = alpha(WHITE, 0.85 * al); g.circle(p.x, p.y, s * 0.5); g.fill();
        }
    }
}
function tickRings(g: Graphics, rings: Ring[], dt: number) {
    for (let i = rings.length - 1; i >= 0; i--) {
        const r = rings[i]; r.age += dt; if (r.age < 0) continue;
        const t = r.age / r.life; if (t >= 1) { rings.splice(i, 1); continue; }
        const e = 1 - Math.pow(1 - t, 3);
        g.lineWidth = Math.max(1, r.w * (1 - t)); g.strokeColor = alpha(r.color, 0.9 * (1 - t));
        g.circle(r.x, r.y, r.r0 + (r.r1 - r.r0) * e); g.stroke();
    }
}
function tickFlashes(g: Graphics, fl: Flash[], dt: number) {
    for (let i = fl.length - 1; i >= 0; i--) {
        const f = fl[i]; f.age += dt; const t = f.age / f.life;
        if (t >= 1) { fl.splice(i, 1); continue; }
        const a = (1 - t) * (1 - t);
        for (let k = 3; k >= 1; k--) { g.fillColor = new Color(255, 250, 240, Math.round(255 * a * (0.12 + 0.2 * k / 3))); g.circle(f.x, f.y, f.r * (0.4 + 0.6 * t) * k / 3); g.fill(); }
    }
}
