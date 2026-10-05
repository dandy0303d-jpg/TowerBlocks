import {
    _decorator, Component, Node, Label, UIOpacity, UITransform, Vec3, Color,
    tween, Graphics,
} from 'cc';
const { ccclass, property } = _decorator;

/**
 * 魔法道具「加特林」特效：弹药数量在屏幕中央计数，再飞向弹药区域（Cocos Creator 3.8.x，2D UI）
 *
 * 流程（默认约 2.3 秒）：
 *   0.00  中央展开橙红色魔法阵（可关），6 颗红色子弹方块排成一圈开始旋转，越转越快
 *   0.45  数字「×0」弹出并快速计数到「×20」，每跳一下数字跟着抖一下、甩出一颗子弹火花
 *   1.15  计数完成：闪光 + 冲击波 + 火星四溅，数字放大停顿
 *   1.40  数字沿弧线飞向弹药区域，拖着火焰尾迹；子弹方块排成一串紧随其后
 *   1.95  数字到达：目标放大回弹 + 闪光，弹药 Label 设为新数量，调用 onArrive；随后的子弹依次撞进目标，每颗闪一下
 *
 * 用法：
 *   await this.gatlingFx.play({
 *       count: 20,
 *       from: this.gatlingItemBtn,          // 可空
 *       target: () => this.ammoNode,         // 弹药区域（节点或函数）
 *       counterLabel: this.ammoLabel,        // 可空：到达时设为 fromCount + count
 *       fromCount: 0,
 *       onArrive: () => this.addAmmo(20),
 *   });
 */

export interface MagicGatlingOptions {
    /** 弹药数量 */
    count: number;
    /** 道具按钮（可空）：开场时一道火光从这里飞到中央 */
    from?: Node | null;
    /** 弹药区域，可传函数（每帧重新取）。为空则展示后原地淡出 */
    target?: Node | null | (() => Node | null);
    /** 弹药数量 Label（可空），到达时滚动到 fromCount + count */
    counterLabel?: Label | null;
    fromCount?: number;
    /** 数字格式，默认「×N」 */
    format?: (n: number) => string;
    /** Label 上的数字格式，默认直接 String(n) */
    labelFormat?: (n: number) => string;
    /** 子弹颜色，默认红色（和游戏里的加特林子弹一致） */
    bulletColor?: Color;
    /** 数字到达瞬间调用 */
    onArrive?: () => void;
    /** 计数阶段每跳一下调用（i = 1..steps，含边界）。可用来按节奏播音效。
     *  steps = min(count, 20)，不是 count 本身——避免 count 很大时狂刷。 */
    onTick?: (i: number, steps: number) => void;
}

interface P { kind: 0 | 2; x: number; y: number; vx: number; vy: number; age: number; life: number; size: number; rot: number; vr: number; drag: number; grav: number; color: Color; }
interface Ring { x: number; y: number; age: number; life: number; r0: number; r1: number; w: number; color: Color; }
interface Flash { x: number; y: number; age: number; life: number; r: number; }
interface Bullet { x: number; y: number; delay: number; t: number; sx: number; sy: number; s: number; rot: number; done: boolean; side: number; }

const WHITE = new Color(255, 255, 255, 255);
const FIRE: Color[] = [new Color(255, 230, 120), new Color(255, 170, 60), new Color(255, 100, 50), new Color(255, 60, 60)];

@ccclass('MagicGatlingEffect')
export class MagicGatlingEffect extends Component {

    @property({ tooltip: '中央枪管圈半径（像素）' }) barrelRadius = 90;
    @property({ tooltip: '子弹方块大小（像素）' }) bulletSize = 44;
    @property({ tooltip: '展示位置 Y 偏移（相对本节点中心）' }) centerOffsetY = 60;
    @property({ tooltip: '计数时长（秒）' }) countTime = 0.7;
    @property({ tooltip: '飞行时长（秒）' }) flyTime = 0.55;
    @property({ tooltip: '跟飞的子弹最多几颗' }) maxBullets = 8;
    @property({ tooltip: '数字字号' }) numberFontSize = 104;
    @property({ tooltip: '数字颜色' }) numberColor = new Color(255, 240, 150, 255);
    @property({ tooltip: '数字描边颜色' }) numberOutline = new Color(140, 30, 10, 255);
    @property({ tooltip: '显示背后的魔法阵圆圈' }) showMagicCircle = true;
    @property({ tooltip: '魔法阵颜色' }) magicColor = new Color(255, 130, 60, 255);

    private _fx: Graphics | null = null;
    private _top: Graphics | null = null;
    private _ps: P[] = [];
    private _rings: Ring[] = [];
    private _flashes: Flash[] = [];
    private _barrel = { on: false, x: 0, y: 0, a: 0, rot: 0, speed: 0, r: 0 };
    private _circle = { a: 0, r: 0, rot: 0 };
    private _bullets: Bullet[] = [];
    private _bulletColor = new Color(235, 70, 60, 255);

    onLoad() { this.ensureLayers(); }

    async play(o: MagicGatlingOptions): Promise<void> {
        this.node.active = true;
        this.ensureLayers();
        const getTarget = (): Node | null => {
            const t = typeof o.target === 'function' ? o.target() : o.target;
            return t && t.isValid ? t : null;
        };
        const fmt = o.format || ((n: number) => `×${n}`);
        this._bulletColor = o.bulletColor || new Color(235, 70, 60, 255);
        const center = new Vec3(0, this.centerOffsetY, 0);
        const R = this.barrelRadius;

        // 1. 魔法阵 + 枪管圈加速旋转
        const b = this._barrel; b.on = true; b.x = center.x; b.y = center.y; b.a = 0; b.speed = 1; b.r = 0;
        const c = this._circle; c.a = 0; c.r = 0;
        tween(c).to(0.35, { a: 1, r: R * 2.1 }, { easing: 'backOut' }).start();
        tween(b).to(0.35, { a: 1, r: R }, { easing: 'backOut' }).start();
        tween(b).to(0.9, { speed: 22 }, { easing: 'quadIn' }).start();
        if (o.from && o.from.isValid) this.beam(this.toLocal(o.from), center);
        await this.wait(0.45);

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
            this.muzzle(center, R);
            try { o.onTick?.(i, steps); } catch (e) { console.warn('[MagicGatling] onTick threw:', e); }
            await this.wait(this.countTime / steps);
        }

        // 3. 计数完成
        this._flashes.push({ x: center.x, y: center.y, age: 0, life: 0.35, r: R * 2 });
        this._rings.push({ x: center.x, y: center.y, age: 0, life: 0.5, r0: R * 0.6, r1: R * 3, w: 9, color: WHITE });
        this._rings.push({ x: center.x, y: center.y, age: -0.05, life: 0.65, r0: R * 0.8, r1: R * 3.6, w: 6, color: this.magicColor });
        this.burst(center.x, center.y, R * 0.6, 1);
        await new Promise<void>(res => tween(num).to(0.08, { scale: new Vec3(1.45, 1.45, 1) }).to(0.22, { scale: new Vec3(1.15, 1.15, 1) }, { easing: 'backOut' }).delay(0.15).call(() => res()).start());

        // 4. 飞向目标，子弹跟随
        tween(c).to(0.35, { a: 0, r: R * 2.6 }).start();
        let tgt = getTarget();
        const start = center.clone();
        let end = tgt ? this.toLocal(tgt) : new Vec3(center.x, center.y + R * 2, 0);
        const side = end.x >= start.x ? 1 : -1;
        const nb = Math.min(this.maxBullets, Math.max(1, o.count));
        // 枪管上的子弹依次脱离，跟着数字飞
        for (let i = 0; i < nb; i++) {
            const a = b.rot + i / 6 * Math.PI * 2;
            this._bullets.push({ x: b.x + Math.cos(a) * R, y: b.y + Math.sin(a) * R, delay: 0.12 + i * 0.06, t: 0, sx: 0, sy: 0, s: 1, rot: 0, done: false, side });
        }
        tween(b).to(0.25, { a: 0 }).call(() => { b.on = false; }).start();
        if (!tgt) {
            tween(num.getComponent(UIOpacity) || num.addComponent(UIOpacity)).to(0.3, { opacity: 0 }).start();
            this._bullets.length = 0;
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
        // 等跟飞子弹全部到达
        await this.wait(0.15 + nb * 0.06 + 0.3);
        this._bullets.length = 0;
        this._endFn = null;
    }

    // ================= 内部 =================
    private _endFn: (() => Vec3) | null = null;

    private ensureLayers() {
        if (!this._fx) this._fx = makeLayer(this.node, 'GatlingFxBack');
        if (!this._top) this._top = makeLayer(this.node, 'GatlingFxTop');
        this._fx.node.setSiblingIndex(0);
        this._top.node.setSiblingIndex(this.node.children.length - 1);
    }
    private wait(s: number) { return new Promise<void>(r => this.scheduleOnce(() => r(), s)); }
    private toLocal(n: Node): Vec3 {
        const ut = this.node.getComponent(UITransform);
        return ut ? ut.convertToNodeSpaceAR(n.worldPosition) : n.worldPosition.clone();
    }
    private makeNumber(text: string): Node {
        const n = new Node('GatlingNumber'); n.layer = this.node.layer; n.addComponent(UITransform);
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
    /** 枪口火花：从枪管圈最上方的子弹位置甩出 */
    private muzzle(c: Vec3, R: number) {
        const b = this._barrel;
        for (let k = 0; k < 2; k++) {
            const a = b.rot + Math.random() * Math.PI * 2;
            const x = c.x + Math.cos(a) * R, y = c.y + Math.sin(a) * R;
            const sp = rand(300, 600);
            this.add(0, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.25, 0.45), rand(8, 14), FIRE[k % 2], 4, 0);
        }
        this._flashes.push({ x: c.x, y: c.y, age: 0, life: 0.08, r: R * 0.6 });
    }
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
        const c = this._circle, b = this._barrel;
        if (this.showMagicCircle && c.a > 0.01) { c.rot += dt * 1.2; drawMagicCircle(g, b.x, b.y, c.r, c.rot, this.magicColor, c.a); }
        // 枪管圈：6 颗子弹绕中心旋转，带运动残影
        if (b.on && b.a > 0.01) {
            b.rot += b.speed * dt;
            const S = this.bulletSize;
            for (let i = 0; i < 6; i++) {
                const a = b.rot + i / 6 * Math.PI * 2;
                for (let gh = 3; gh >= 1; gh--) {
                    const ag = a - gh * Math.min(0.25, b.speed * 0.012);
                    g.fillColor = alpha(this._bulletColor, 0.15 * b.a);
                    g.roundRect(b.x + Math.cos(ag) * b.r - S / 2, b.y + Math.sin(ag) * b.r - S / 2, S, S, S * 0.2); g.fill();
                }
                drawBullet(g, b.x + Math.cos(a) * b.r, b.y + Math.sin(a) * b.r, S * b.a, a, this._bulletColor);
            }
        }
        // 跟飞子弹
        if (this._bullets.length && this._endFn) {
            const end = this._endFn();
            for (const bl of this._bullets) {
                if (bl.done) continue;
                if (bl.delay > 0) { bl.delay -= dt; if (bl.delay <= 0) { bl.sx = bl.x; bl.sy = bl.y; } else { drawBullet(g, bl.x, bl.y, this.bulletSize, bl.rot, this._bulletColor); continue; } }
                bl.t = Math.min(1, bl.t + dt / (this.flyTime * 0.8));
                const t = bl.t * bl.t, u = 1 - t;
                const dx = end.x - bl.sx, dy = end.y - bl.sy, len = Math.max(1, Math.hypot(dx, dy));
                const cx = (bl.sx + end.x) / 2 - dy / len * len * 0.25 * bl.side, cy = (bl.sy + end.y) / 2 + dx / len * len * 0.25 * bl.side;
                bl.x = u * u * bl.sx + 2 * u * t * cx + t * t * end.x; bl.y = u * u * bl.sy + 2 * u * t * cy + t * t * end.y;
                bl.rot += dt * 12; bl.s = 1 - 0.6 * t;
                drawBullet(gt, bl.x, bl.y, this.bulletSize * bl.s, bl.rot, this._bulletColor);
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

/** 红色子弹方块（立体格子） */
function drawBullet(g: Graphics, x: number, y: number, S: number, rot: number, col: Color) {
    if (S < 2) return;
    const h = S / 2, cs = Math.cos(rot * 0.3) , sn = Math.sin(rot * 0.3);
    const quad = (a: number, b: number, w: number, hh: number) => {
        const pts = [[a - w, b - hh], [a + w, b - hh], [a + w, b + hh], [a - w, b + hh]];
        pts.forEach(([px, py], i) => { const X = x + px * cs - py * sn, Y = y + px * sn + py * cs; if (i) g.lineTo(X, Y); else g.moveTo(X, Y); });
        g.close();
    };
    g.fillColor = shade(col, 0.6); quad(0, 0, h, h); g.fill();
    g.fillColor = col; quad(0, h * 0.1, h, h * 0.9); g.fill();
    g.fillColor = shade(col, 1.35); quad(0, h * 0.5, h * 0.75, h * 0.25); g.fill();
    g.lineWidth = Math.max(2, S * 0.06); g.strokeColor = new Color(40, 10, 10, 255); quad(0, 0, h, h); g.stroke();
}

// ---------------- 工具函数 ----------------
function rand(a: number, b: number) { return a + Math.random() * (b - a); }
function alpha(c: Color, a: number) { return new Color(c.r, c.g, c.b, Math.max(0, Math.min(255, Math.round(255 * a)))); }
function shade(c: Color, k: number) { return new Color(Math.min(255, c.r * k), Math.min(255, c.g * k), Math.min(255, c.b * k), 255); }
function makeLayer(parent: Node, name: string): Graphics {
    const n = new Node(name); n.layer = parent.layer; n.addComponent(UITransform);
    parent.addChild(n); return n.addComponent(Graphics);
}
function punch(n: Node) {
    const st = n as any;
    if (st.__mgTw) st.__mgTw.stop();
    const base: Vec3 = st.__mgBase || n.scale.clone(); st.__mgBase = base;
    const p = { k: 1.45 };
    const apply = () => { if (n.isValid) n.setScale(base.x * p.k, base.y * p.k, base.z); };
    apply();
    st.__mgTw = tween(p).to(0.35, { k: 1 }, { easing: 'elasticOut', onUpdate: apply })
        .call(() => { if (n.isValid) n.setScale(base); st.__mgBase = undefined; st.__mgTw = null; }).start();
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
