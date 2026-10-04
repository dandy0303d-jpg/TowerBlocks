import {
    _decorator, Component, Node, UIOpacity, UITransform, Vec3, Color, Sprite, SpriteFrame,
    tween, Graphics,
} from 'cc';
const { ccclass, property } = _decorator;

/**
 * 魔法道具「变形」特效：玩家选好方块后，方块在屏幕中央变形成型，再飞向指定区域（Cocos Creator 3.8.x，2D UI）
 *
 * 流程（默认约 2.0 秒）：
 *   0.00  中央展开旋转魔法阵 + 彩虹漩涡，光点向中心汇聚
 *   0.25  「变形」：方块形状快速轮换（越转越慢，每次切换闪一下），最后锁定成玩家选的形状
 *   0.95  锁定：白光 + 冲击波 + 彩色星星炸开，方块放大回弹，停顿展示
 *   1.30  方块边转边缩小，沿弧线飞向目标区域，拖着彩虹星尘
 *   1.85  到达：目标放大回弹 + 闪光 + 光环，调用 onArrive（在这里真正替换方块）
 *
 * 方块默认由脚本画（带高光和描边的立体格子，和游戏方块风格一致）；也可以传 frame 用图片。
 *
 * 用法：
 *   await this.transformFx.play({
 *       shape: 'T',                          // 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L'，或自定义格子 [[0,0],[1,0],...]
 *       color: new Color(255, 200, 60),      // 方块颜色
 *       from: this.transformItemBtn,         // 可空：道具按钮，魔法从这里飞出
 *       target: () => this.nextPieceSlot,    // 方块飞去的区域（节点或函数）
 *       onArrive: () => this.applyTransform('T'),
 *   });
 */

export type PieceShape = 'I' | 'O' | 'T' | 'S' | 'Z' | 'J' | 'L';

export interface MagicTransformOptions {
    /** 目标形状：预设名或自定义格子坐标（x 向右，y 向上） */
    shape: PieceShape | number[][];
    /** 方块颜色（脚本绘制时使用） */
    color?: Color;
    /** 用图片代替脚本绘制（可空） */
    frame?: SpriteFrame | null;
    /** 道具按钮（可空）：开场时一道光从这里飞到中央 */
    from?: Node | null;
    /** 方块飞向的区域，可传函数（每帧重新取）。为空则展示后原地淡出 */
    target?: Node | null | (() => Node | null);
    /** 变形轮换次数，默认 9 */
    shuffles?: number;
    /** 到达瞬间调用 */
    onArrive?: () => void;
}

const SHAPES: Record<PieceShape, number[][]> = {
    I: [[0, 0], [1, 0], [2, 0], [3, 0]],
    O: [[0, 0], [1, 0], [0, 1], [1, 1]],
    T: [[0, 0], [1, 0], [2, 0], [1, 1]],
    S: [[0, 0], [1, 0], [1, 1], [2, 1]],
    Z: [[0, 1], [1, 1], [1, 0], [2, 0]],
    J: [[0, 0], [1, 0], [2, 0], [0, 1]],
    L: [[0, 0], [1, 0], [2, 0], [2, 1]],
};
const SHAPE_COLORS: Color[] = [new Color(90, 200, 255), new Color(255, 214, 70), new Color(190, 110, 255), new Color(110, 220, 110), new Color(255, 90, 90), new Color(80, 130, 255), new Color(255, 150, 50)];
const RAINBOW: Color[] = [new Color(255, 90, 90), new Color(255, 170, 60), new Color(255, 230, 80), new Color(110, 230, 120), new Color(90, 200, 255), new Color(170, 120, 255)];
const WHITE = new Color(255, 255, 255, 255);

interface P { kind: 0 | 2; x: number; y: number; vx: number; vy: number; age: number; life: number; size: number; rot: number; vr: number; drag: number; grav: number; color: Color; }
interface Ring { x: number; y: number; age: number; life: number; r0: number; r1: number; w: number; color: Color; }
interface Flash { x: number; y: number; age: number; life: number; r: number; }

@ccclass('MagicTransformEffect')
export class MagicTransformEffect extends Component {

    @property({ tooltip: '中央展示时单个格子的大小（像素）' }) cellSize = 64;
    @property({ tooltip: '展示位置 Y 偏移（相对本节点中心）' }) centerOffsetY = 60;
    @property({ tooltip: '飞行时长（秒）' }) flyTime = 0.55;
    @property({ tooltip: '魔法阵颜色' }) magicColor = new Color(220, 140, 255, 255);

    private _fx: Graphics | null = null;
    private _top: Graphics | null = null;
    private _ps: P[] = [];
    private _rings: Ring[] = [];
    private _flashes: Flash[] = [];
    private _circles: { x: number; y: number; r: number; a: number; rot: number; swirl: number }[] = [];

    onLoad() { this.ensureLayers(); }

    async play(o: MagicTransformOptions): Promise<void> {
        this.node.active = true;
        this.ensureLayers();
        const getTarget = (): Node | null => {
            const t = typeof o.target === 'function' ? o.target() : o.target;
            return t && t.isValid ? t : null;
        };
        const cells = Array.isArray(o.shape) ? o.shape : SHAPES[o.shape] || SHAPES.T;
        const color = o.color || new Color(255, 214, 70, 255);
        const C = this.cellSize;
        const center = new Vec3(0, this.centerOffsetY, 0);

        // 方块节点
        const pn = new Node('TransformPiece'); pn.layer = this.node.layer;
        const put = pn.addComponent(UITransform);
        this.node.addChild(pn);
        this._top!.node.setSiblingIndex(this.node.children.length - 1);
        const pop = pn.addComponent(UIOpacity);
        let pg: Graphics | null = null;
        if (o.frame) {
            const sp = pn.addComponent(Sprite); sp.sizeMode = Sprite.SizeMode.CUSTOM; sp.spriteFrame = o.frame;
            const b = bounds(cells); put.setContentSize(b.w * C, b.h * C);
        } else {
            pg = pn.addComponent(Graphics);
        }
        pn.setPosition(center); pn.setScale(0, 0, 1);

        // 1. 魔法阵 + 漩涡
        const circle = { x: center.x, y: center.y, r: 0, a: 0, rot: 0, swirl: 1 };
        this._circles.push(circle);
        tween(circle).to(0.35, { r: C * 2.6, a: 1 }, { easing: 'backOut' }).start();
        if (o.from && o.from.isValid) this.beam(this.toLocal(o.from), center);
        this.schedule(() => this.converge(center, C * 3), 0.03, 12, 0);

        // 2. 形状轮换
        const n = Math.max(1, o.shuffles ?? 9);
        const names = Object.keys(SHAPES) as PieceShape[];
        let last = -1;
        tween(pn).to(0.2, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();
        await this.wait(0.2);
        for (let i = 0; i < n; i++) {
            let k = Math.floor(Math.random() * names.length); if (k === last) k = (k + 1) % names.length; last = k;
            if (pg) this.drawPiece(pg, SHAPES[names[k]], SHAPE_COLORS[k], C, 0.55);
            pn.angle = (Math.random() - 0.5) * 20;
            this._flashes.push({ x: center.x, y: center.y, age: 0, life: 0.12, r: C * 1.4 });
            for (let j = 0; j < 3; j++) this.spark(center, C * 1.5);
            await this.wait(0.04 + 0.06 * (i / n) * (i / n) * 3);
        }

        // 3. 锁定
        if (pg) this.drawPiece(pg, cells, color, C, 1);
        pn.angle = 0;
        circle.swirl = 0;
        this._flashes.push({ x: center.x, y: center.y, age: 0, life: 0.35, r: C * 3 });
        this._rings.push({ x: center.x, y: center.y, age: 0, life: 0.5, r0: C, r1: C * 4, w: 9, color: WHITE });
        this._rings.push({ x: center.x, y: center.y, age: -0.05, life: 0.65, r0: C * 1.2, r1: C * 5, w: 6, color: color });
        this.burst(center.x, center.y, C, 1);
        await new Promise<void>(res => tween(pn).to(0.08, { scale: new Vec3(1.3, 1.3, 1) }).to(0.25, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).delay(0.25).call(() => res()).start());

        // 4. 飞向目标
        tween(circle).to(0.35, { a: 0, r: C * 3.4 }).start();
        let tgt = getTarget();
        if (!tgt) {
            tween(pop).to(0.3, { opacity: 0 }).start();
            tween(pn).to(0.3, { scale: new Vec3(1.3, 1.3, 1) }).start();
            try { o.onArrive?.(); } catch (e) { console.error(e); }
            await this.wait(0.4);
            pn.destroy(); this._circles.splice(this._circles.indexOf(circle), 1);
            return;
        }
        const pieceW = bounds(cells).w * C, pieceH = bounds(cells).h * C;
        const tsize = this.sizeOf(tgt);
        const endScale = Math.max(0.15, Math.min(1, Math.min(tsize.x / pieceW, tsize.y / pieceH) * 0.9));
        const start = center.clone();
        let end = this.toLocal(tgt);
        const side = end.x >= start.x ? 1 : -1;
        const fly = { t: 0 };
        await new Promise<void>(res => tween(fly).to(this.flyTime, { t: 1 }, {
            easing: 'quadIn',
            onUpdate: () => {
                const t2 = getTarget(); if (t2) end = this.toLocal(t2);
                const t = fly.t, u = 1 - t;
                const dx = end.x - start.x, dy = end.y - start.y, len = Math.max(1, Math.hypot(dx, dy));
                const cx = (start.x + end.x) / 2 - dy / len * len * 0.3 * side, cy = (start.y + end.y) / 2 + dx / len * len * 0.3 * side;
                const x = u * u * start.x + 2 * u * t * cx + t * t * end.x, y = u * u * start.y + 2 * u * t * cy + t * t * end.y;
                if (pn.isValid) { pn.setPosition(x, y, 0); const s = 1 + (endScale - 1) * t; pn.setScale(s, s, 1); pn.angle = -360 * t * side; }
                for (let i = 0; i < 2; i++) this.add(2, x + rand(-16, 16), y + rand(-16, 16), rand(-30, 30), rand(-30, 30), rand(0.3, 0.55), rand(5, 10), RAINBOW[(Math.random() * RAINBOW.length) | 0], 2, 0);
                if (Math.random() < 0.5) this.add(0, x + rand(-20, 20), y + rand(-20, 20), 0, 0, rand(0.3, 0.5), rand(8, 14), WHITE, 0, 0);
            },
        }).call(() => res()).start());

        // 5. 到达
        pn.destroy();
        this._circles.splice(this._circles.indexOf(circle), 1);
        tgt = getTarget();
        this._flashes.push({ x: end.x, y: end.y, age: 0, life: 0.25, r: Math.max(tsize.x, tsize.y) * 0.8 });
        this._rings.push({ x: end.x, y: end.y, age: 0, life: 0.45, r0: 20, r1: Math.max(tsize.x, tsize.y) * 1.1 + 40, w: 7, color: color });
        this.burst(end.x, end.y, 20, 0.5);
        if (tgt) punch(tgt);
        try { o.onArrive?.(); } catch (e) { console.error(e); }
        await this.wait(0.5);
    }

    // ================= 内部 =================
    private ensureLayers() {
        if (!this._fx) this._fx = makeLayer(this.node, 'TransformFxBack');
        if (!this._top) this._top = makeLayer(this.node, 'TransformFxTop');
        this._fx.node.setSiblingIndex(0);
        this._top.node.setSiblingIndex(this.node.children.length - 1);
    }
    private wait(s: number) { return new Promise<void>(r => this.scheduleOnce(() => r(), s)); }
    private toLocal(n: Node): Vec3 {
        const ut = this.node.getComponent(UITransform);
        return ut ? ut.convertToNodeSpaceAR(n.worldPosition) : n.worldPosition.clone();
    }
    private sizeOf(n: Node): Vec3 {
        const ut = n.getComponent(UITransform);
        const s = Math.abs(n.worldScale.x) / Math.max(1e-4, Math.abs(this.node.worldScale.x));
        return ut ? new Vec3(ut.width * s, ut.height * s, 0) : new Vec3(120, 120, 0);
    }

    /** 画方块（居中），每个格子带高光、暗边和描边 */
    private drawPiece(g: Graphics, cells: number[][], col: Color, C: number, glow: number) {
        g.clear();
        const b = bounds(cells), ox = -b.w * C / 2 - b.minX * C, oy = -b.h * C / 2 - b.minY * C;
        if (glow > 0) {
            for (const [cx, cy] of cells) { g.fillColor = alpha(col, 0.25 * glow); g.roundRect(ox + cx * C - 10, oy + cy * C - 10, C + 20, C + 20, C * 0.3); g.fill(); }
        }
        const pad = C * 0.04, r = C * 0.2;
        for (const [cx, cy] of cells) {
            const x = ox + cx * C + pad, y = oy + cy * C + pad, s = C - pad * 2;
            g.fillColor = shade(col, 0.65); g.roundRect(x, y, s, s, r); g.fill();
            g.fillColor = col; g.roundRect(x, y + s * 0.1, s, s * 0.9, r); g.fill();
            g.fillColor = shade(col, 1.25); g.roundRect(x + s * 0.12, y + s * 0.55, s * 0.76, s * 0.3, r * 0.6); g.fill();
            g.lineWidth = Math.max(2, C * 0.05); g.strokeColor = new Color(30, 20, 40, 255); g.roundRect(x, y, s, s, r); g.stroke();
        }
    }

    private beam(a: Vec3, b: Vec3) {
        for (let i = 0; i < 16; i++) {
            const t = i / 16;
            const x = a.x + (b.x - a.x) * t, y = a.y + (b.y - a.y) * t + Math.sin(t * Math.PI) * 80;
            this._ps.push({ kind: 2, x, y, vx: 0, vy: 0, age: -t * 0.25, life: 0.45, size: rand(6, 10), rot: 0, vr: 0, drag: 0, grav: 0, color: this.magicColor });
        }
    }
    private converge(c: Vec3, R: number) {
        for (let i = 0; i < 2; i++) {
            const a = Math.random() * Math.PI * 2, d = R * rand(0.8, 1.2), t = rand(0.3, 0.45);
            const x = c.x + Math.cos(a) * d, y = c.y + Math.sin(a) * d;
            // 带切向速度，形成漩涡
            const vx = (c.x - x) / t - Math.sin(a) * d * 2, vy = (c.y - y) / t + Math.cos(a) * d * 2;
            this._ps.push({ kind: 2, x, y, vx, vy, age: 0, life: t, size: rand(5, 9), rot: 0, vr: 0, drag: 4, grav: 0, color: RAINBOW[(Math.random() * RAINBOW.length) | 0] });
        }
    }
    private spark(c: Vec3, R: number) {
        const a = Math.random() * Math.PI * 2, d = R * rand(0.4, 1);
        this.add(0, c.x + Math.cos(a) * d, c.y + Math.sin(a) * d, 0, 0, rand(0.2, 0.35), rand(8, 14), RAINBOW[(Math.random() * RAINBOW.length) | 0], 0, 0);
    }
    private burst(x: number, y: number, r: number, k: number) {
        for (let i = 0; i < Math.round(24 * k); i++) {
            const a = Math.random() * Math.PI * 2, sp = rand(240, 560) * (0.5 + k * 0.5);
            this.add(0, x + Math.cos(a) * r * 0.4, y + Math.sin(a) * r * 0.4, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.45, 0.8), rand(9, 18), RAINBOW[i % RAINBOW.length], 3.5, 0);
        }
        for (let i = 0; i < Math.round(16 * k); i++) {
            const a = Math.random() * Math.PI * 2, sp = rand(60, 240);
            this.add(2, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.5, 0.9), rand(4, 8), WHITE, 2, -80);
        }
    }
    private add(kind: 0 | 2, x: number, y: number, vx: number, vy: number, life: number, size: number, color: Color, drag: number, grav: number) {
        this._ps.push({ kind, x, y, vx, vy, age: 0, life, size, rot: rand(0, Math.PI), vr: rand(-5, 5), drag, grav, color });
    }

    update(dt: number) {
        const g = this._fx!, gt = this._top!;
        g.clear(); gt.clear();
        for (const c of this._circles) {
            if (c.a <= 0.01) continue;
            c.rot += dt * (0.9 + c.swirl * 2);
            drawMagicCircle(g, c.x, c.y, c.r, c.rot, this.magicColor, c.a);
            // 彩虹漩涡臂
            if (c.swirl > 0) {
                for (let arm = 0; arm < 6; arm++) {
                    g.lineWidth = 5; g.strokeColor = alpha(RAINBOW[arm], 0.55 * c.a);
                    for (let i = 0; i <= 14; i++) {
                        const t = i / 14, a = c.rot * 1.5 + arm * Math.PI / 3 + t * 2.4, rr = c.r * (0.15 + 0.7 * t);
                        const x = c.x + Math.cos(a) * rr, y = c.y + Math.sin(a) * rr;
                        if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
                    }
                    g.stroke();
                }
            }
        }
        tickParticles(g, gt, this._ps, dt);
        tickRings(gt, this._rings, dt);
        tickFlashes(gt, this._flashes, dt);
    }
}

// ---------------- 工具函数 ----------------
function rand(a: number, b: number) { return a + Math.random() * (b - a); }
function alpha(c: Color, a: number) { return new Color(c.r, c.g, c.b, Math.max(0, Math.min(255, Math.round(255 * a)))); }
function shade(c: Color, k: number) { return new Color(Math.min(255, c.r * k), Math.min(255, c.g * k), Math.min(255, c.b * k), 255); }
function bounds(cells: number[][]) {
    let minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    for (const [x, y] of cells) { minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); }
    return { minX, minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}
function makeLayer(parent: Node, name: string): Graphics {
    const n = new Node(name); n.layer = parent.layer; n.addComponent(UITransform);
    parent.addChild(n); return n.addComponent(Graphics);
}
function punch(n: Node) {
    const st = n as any;
    if (st.__mtTw) st.__mtTw.stop();
    const base: Vec3 = st.__mtBase || n.scale.clone(); st.__mtBase = base;
    const p = { k: 1.45 };
    const apply = () => { if (n.isValid) n.setScale(base.x * p.k, base.y * p.k, base.z); };
    apply();
    st.__mtTw = tween(p).to(0.35, { k: 1 }, { easing: 'elasticOut', onUpdate: apply })
        .call(() => { if (n.isValid) n.setScale(base); st.__mtBase = undefined; st.__mtTw = null; }).start();
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
