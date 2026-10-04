import {
    _decorator, Component, Node, Label, Sprite, SpriteFrame, UIOpacity, UITransform, Vec3, Color,
    tween, Graphics,
} from 'cc';
const { ccclass, property } = _decorator;

/**
 * 魔法道具「沙漏」特效：使用沙漏 → 倒计时数字（如 +15s）飞向指定区域（Cocos Creator 3.8.x，2D UI）
 *
 * 流程（默认约 2.3 秒）：
 *   0.00  沙漏从道具按钮（from）弹出飞到屏幕中央，同时背后展开一圈旋转的魔法阵
 *   0.40  沙漏翻转 180°，沙子开始从上往下流，周围飘起金色光点和时间符文
 *   0.95  沙漏闪光，「+15s」从沙漏里爆出来、放大停顿一下
 *   1.20  数字沿弧线飞向目标区域（倒计时），拖着金色星尘，边飞边缩小
 *   1.75  到达：目标放大回弹 + 闪光 + 光环，计时数字滚动增加，调用 onArrive；沙漏和魔法阵缩小淡出
 *
 * 节点：建一个铺满屏幕的空节点，放在游戏 UI 最上层，挂本脚本即可（不需要子节点，不挡点击）。
 * 约定：脚本只动自己创建的节点；目标节点只做一次放大回弹（结束恢复原缩放）。加时间的数据逻辑由宿主自己做。
 *
 * 用法：
 *   await this.hourglassFx.play({
 *       from:    this.hourglassItemBtn,          // 可空：道具按钮
 *       target:  () => this.timerNode,           // 倒计时区域（节点或函数）
 *       seconds: 15,
 *       timerLabel: this.timerLabel,             // 可空：会从 fromSeconds 滚到 fromSeconds + seconds
 *       fromSeconds: this.remain,
 *       onArrive: () => this.addTime(15),
 *   });
 */

export interface MagicHourglassOptions {
    /** 道具按钮，沙漏从这里飞出（可空：直接在中央出现） */
    from?: Node | null;
    /** 倒计时区域，数字飞向这里。可传函数，每帧重新取 */
    target: Node | null | (() => Node | null);
    /** 增加的秒数，用于显示「+15s」和数字滚动 */
    seconds: number;
    /** 显示文字，默认「+{seconds}s」 */
    text?: string;
    /** 倒计时 Label（可空），到达时从 fromSeconds 滚动到 fromSeconds + seconds */
    timerLabel?: Label | null;
    fromSeconds?: number;
    /** 时间格式化，默认 mm:ss */
    format?: (sec: number) => string;
    /** 数字滚动方向：倒计时一般是加时间（默认 +1）；传 -1 时数字减少 */
    sign?: 1 | -1;
    /** 数字到达的瞬间调用 */
    onArrive?: () => void;
}

interface P { kind: 0 | 1 | 2; x: number; y: number; vx: number; vy: number; age: number; life: number; size: number; rot: number; vr: number; drag: number; grav: number; color: Color; ch?: number; }
interface Ring { x: number; y: number; age: number; life: number; r0: number; r1: number; w: number; color: Color; }
interface Flash { x: number; y: number; age: number; life: number; r: number; }

const WHITE = new Color(255, 255, 255, 255);
const GOLD = new Color(255, 214, 90, 255);
const SAND = new Color(255, 196, 80, 255);
const SAND_DARK = new Color(214, 140, 40, 255);
const GLASS = new Color(190, 235, 255, 255);
const WOOD = new Color(150, 86, 44, 255);
const WOOD_DARK = new Color(90, 48, 22, 255);

@ccclass('MagicHourglassEffect')
export class MagicHourglassEffect extends Component {

    @property({ type: SpriteFrame, tooltip: '沙漏图片（可空，空则脚本自己画，画出来的沙子会流动）' }) hourglassFrame: SpriteFrame | null = null;
    @property({ tooltip: '沙漏高度（像素）' }) hourglassSize = 220;
    @property({ tooltip: '沙漏在中央停留时的位置偏移 Y（相对本节点中心）' }) centerOffsetY = 80;
    @property({ tooltip: '数字字号' }) numberFontSize = 96;
    @property({ tooltip: '数字颜色' }) numberColor = new Color(255, 236, 120, 255);
    @property({ tooltip: '数字描边颜色' }) numberOutline = new Color(120, 60, 10, 255);
    @property({ tooltip: '数字飞行时长（秒）' }) flyTime = 0.55;
    @property({ tooltip: '魔法阵 / 星尘主色' }) magicColor = new Color(150, 200, 255, 255);

    // -------------------------------------------------------------
    private _fx: Graphics | null = null;        // 魔法阵 + 粒子（最下层）
    private _top: Graphics | null = null;       // 闪光、光环（最上层）
    private _ps: P[] = [];
    private _rings: Ring[] = [];
    private _flashes: Flash[] = [];
    private _circles: { x: number; y: number; r: number; a: number; rot: number }[] = [];

    onLoad() { this.ensureLayers(); }

    async play(o: MagicHourglassOptions): Promise<void> {
        this.node.active = true;
        this.ensureLayers();
        const getTarget = (): Node | null => {
            const t = typeof o.target === 'function' ? o.target() : o.target;
            return t && t.isValid ? t : null;
        };
        const H = this.hourglassSize;
        const center = new Vec3(0, this.centerOffsetY, 0);
        const from = o.from && o.from.isValid ? this.toLocal(o.from) : center.clone();

        // ---------- 沙漏节点 ----------
        const hg = new Node('Hourglass'); hg.layer = this.node.layer;
        const hut = hg.addComponent(UITransform); hut.setContentSize(H * 0.62, H);
        this.node.addChild(hg);
        hg.setSiblingIndex(1);
        const st = { top: 0, flow: 0, glow: 0 };   // 上半沙量（初始沙子都在下面）、下落流量、发光
        let g: Graphics | null = null;
        if (this.hourglassFrame) {
            const sp = hg.addComponent(Sprite); sp.sizeMode = Sprite.SizeMode.CUSTOM; sp.spriteFrame = this.hourglassFrame;
        } else {
            g = hg.addComponent(Graphics);
        }
        const hop = hg.addComponent(UIOpacity);
        hg.setPosition(from); hg.setScale(0.3, 0.3, 1);

        // 魔法阵
        const circle = { x: center.x, y: center.y, r: 0, a: 0, rot: 0 };
        this._circles.push(circle);
        tween(circle).delay(0.1).to(0.4, { r: H * 0.85, a: 1 }, { easing: 'backOut' }).start();

        // 1. 弹出飞到中央
        const prox = { t: 0 };
        await new Promise<void>(res => tween(prox).to(0.4, { t: 1 }, {
            easing: 'quadOut',
            onUpdate: () => {
                const t = prox.t, u = 1 - t;
                const cx = (from.x + center.x) / 2, cy = Math.max(from.y, center.y) + H * 0.6;
                hg.setPosition(u * u * from.x + 2 * u * t * cx + t * t * center.x, u * u * from.y + 2 * u * t * cy + t * t * center.y, 0);
                const s = 0.3 + 0.8 * t; hg.setScale(s, s, 1);
                hg.angle = (1 - t) * 25;
                if (g) this.drawHourglass(g, H, st);
            },
        }).call(() => res()).start());
        tween(hg).to(0.15, { scale: new Vec3(1, 1, 1) }, { easing: 'backOut' }).start();

        // 2. 翻转 + 流沙
        const updater = () => { if (g && g.isValid) this.drawHourglass(g, H, st); };
        this.schedule(updater, 0);
        tween(hg).to(0.35, { angle: 180 }, { easing: 'backInOut' }).call(() => { hg.angle = 0; st.top = 1 - st.top; }).start();
        // 翻转时沙子在下半，转 180° 后正好到上面；转完把角度归零并换成「上满下空」再开始流
        await this.wait(0.35);
        st.top = 1; st.flow = 1;
        tween(st).to(0.55, { top: 0.55 }).start();
        this.schedule(() => this.emitRunes(center, H), 0.06, 8, 0);
        await this.wait(0.55);

        // 3. 闪光，数字爆出
        st.flow = 0; st.glow = 1;
        tween(st).to(0.5, { glow: 0 }).start();
        this._flashes.push({ x: center.x, y: center.y, age: 0, life: 0.3, r: H * 0.9 });
        this._rings.push({ x: center.x, y: center.y, age: 0, life: 0.5, r0: H * 0.3, r1: H * 1.3, w: 9, color: WHITE });
        this.burst(center.x, center.y, H * 0.3, 1);

        const num = this.makeNumber(o.text ?? `${(o.sign ?? 1) < 0 ? '-' : '+'}${o.seconds}s`);
        num.setPosition(center.x, center.y, 0); num.setScale(0, 0, 1);
        await new Promise<void>(res => tween(num)
            .to(0.16, { position: new Vec3(center.x, center.y + H * 0.15, 0), scale: new Vec3(1.35, 1.35, 1) }, { easing: 'backOut' })
            .to(0.1, { scale: new Vec3(1.1, 1.1, 1) })
            .delay(0.1)
            .call(() => res()).start());

        // 沙漏和魔法阵退场
        tween(hg).to(0.35, { scale: new Vec3(0.2, 0.2, 1) }, { easing: 'backIn' }).start();
        tween(hop).delay(0.15).to(0.2, { opacity: 0 }).start();
        tween(circle).to(0.4, { a: 0, r: H * 1.2 }).start();

        // 4. 数字飞向目标
        const start = num.position.clone();
        let tgt = getTarget();
        let end = tgt ? this.toLocal(tgt) : new Vec3(center.x, center.y + H, 0);
        const side = end.x >= start.x ? 1 : -1;
        const fly = { t: 0 };
        await new Promise<void>(res => tween(fly).to(this.flyTime, { t: 1 }, {
            easing: 'quadIn',
            onUpdate: () => {
                const t2 = getTarget(); if (t2) end = this.toLocal(t2);
                const t = fly.t, u = 1 - t;
                const dx = end.x - start.x, dy = end.y - start.y, len = Math.max(1, Math.hypot(dx, dy));
                const cx = (start.x + end.x) / 2 - dy / len * len * 0.3 * side;
                const cy = (start.y + end.y) / 2 + dx / len * len * 0.3 * side;
                const x = u * u * start.x + 2 * u * t * cx + t * t * end.x, y = u * u * start.y + 2 * u * t * cy + t * t * end.y;
                if (num.isValid) { num.setPosition(x, y, 0); const s = 1.1 - 0.6 * t; num.setScale(s, s, 1); num.angle = Math.sin(t * Math.PI) * -12 * side; }
                for (let i = 0; i < 2; i++) this.add(2, x + rand(-14, 14), y + rand(-14, 14), rand(-30, 30), rand(-30, 30), rand(0.3, 0.55), rand(5, 10), Math.random() < 0.3 ? WHITE : GOLD, 2, 0);
                if (Math.random() < 0.5) this.add(0, x + rand(-20, 20), y + rand(-20, 20), 0, 0, rand(0.3, 0.5), rand(8, 14), Math.random() < 0.5 ? WHITE : this.magicColor, 0, 0);
            },
        }).call(() => res()).start());

        // 5. 到达
        if (num.isValid) num.destroy();
        this.unschedule(updater);
        hg.destroy();
        this._circles.splice(this._circles.indexOf(circle), 1);
        tgt = getTarget();
        this._flashes.push({ x: end.x, y: end.y, age: 0, life: 0.25, r: 70 });
        this._rings.push({ x: end.x, y: end.y, age: 0, life: 0.45, r0: 20, r1: 110, w: 7, color: GOLD });
        this.burst(end.x, end.y, 20, 0.5);
        if (tgt) this.punch(tgt);
        if (o.timerLabel && o.timerLabel.isValid) this.rollTimer(o);
        try { o.onArrive?.(); } catch (e) { console.error(e); }
        await this.wait(0.5);
    }

    // ================= 内部 =================

    private ensureLayers() {
        if (!this._fx) this._fx = this.makeLayer('HourglassFxBack');
        if (!this._top) this._top = this.makeLayer('HourglassFxTop');
        this._fx.node.setSiblingIndex(0);
        this._top.node.setSiblingIndex(this.node.children.length - 1);
    }
    private makeLayer(name: string): Graphics {
        const n = new Node(name); n.layer = this.node.layer; n.addComponent(UITransform);
        this.node.addChild(n); return n.addComponent(Graphics);
    }
    private wait(s: number) { return new Promise<void>(r => this.scheduleOnce(() => r(), s)); }
    private toLocal(n: Node): Vec3 {
        const ut = this.node.getComponent(UITransform);
        return ut ? ut.convertToNodeSpaceAR(n.worldPosition) : n.worldPosition.clone();
    }

    private makeNumber(text: string): Node {
        const n = new Node('HourglassNumber'); n.layer = this.node.layer; n.addComponent(UITransform);
        const lb = n.addComponent(Label);
        lb.string = text; lb.fontSize = this.numberFontSize; lb.lineHeight = this.numberFontSize * 1.1; lb.isBold = true; lb.color = this.numberColor;
        const a = lb as any;
        if ('enableOutline' in a) { a.enableOutline = true; a.outlineColor = this.numberOutline; a.outlineWidth = Math.round(this.numberFontSize * 0.07); }
        if ('enableShadow' in a) { a.enableShadow = true; a.shadowColor = new Color(0, 0, 0, 160); a.shadowOffset = { x: 0, y: -4 }; }
        this.node.addChild(n);
        this._top!.node.setSiblingIndex(this.node.children.length - 1);
        return n;
    }

    /** 目标放大回弹（代理驱动，节点失效自动跳过，结束恢复原缩放） */
    private punch(n: Node) {
        const st = n as any;
        if (st.__hgTw) st.__hgTw.stop();
        const base: Vec3 = st.__hgBase || n.scale.clone(); st.__hgBase = base;
        const p = { k: 1.45 };
        const apply = () => { if (n.isValid) n.setScale(base.x * p.k, base.y * p.k, base.z); };
        apply();
        st.__hgTw = tween(p).to(0.35, { k: 1 }, { easing: 'elasticOut', onUpdate: apply })
            .call(() => { if (n.isValid) n.setScale(base); st.__hgBase = undefined; st.__hgTw = null; }).start();
    }

    private rollTimer(o: MagicHourglassOptions) {
        const lb = o.timerLabel!;
        const fmt = o.format || ((sec: number) => {
            const s = Math.max(0, Math.round(sec)), m = Math.floor(s / 60), r = s % 60;
            return `${m < 10 ? '0' : ''}${m}:${r < 10 ? '0' : ''}${r}`;
        });
        const v0 = o.fromSeconds ?? 0, v1 = v0 + o.seconds * (o.sign ?? 1);
        const p = { v: v0 };
        const col = lb.color.clone();
        lb.color = this.numberColor;
        tween(p).to(0.45, { v: v1 }, { easing: 'quadOut', onUpdate: () => { if (lb.isValid) lb.string = fmt(p.v); } })
            .call(() => { if (lb.isValid) { lb.string = fmt(v1); lb.color = col; } }).start();
    }

    private emitRunes(c: Vec3, H: number) {
        // 时间符文（小圆 + 指针的钟面）和光点从沙漏周围升起
        const a = Math.random() * Math.PI * 2, d = H * rand(0.45, 0.8);
        const x = c.x + Math.cos(a) * d, y = c.y + Math.sin(a) * d * 0.8;
        this._ps.push({ kind: 1, x, y, vx: rand(-15, 15), vy: rand(40, 90), age: 0, life: rand(0.7, 1.0), size: rand(10, 16), rot: rand(0, 6), vr: rand(-4, 4), drag: 0.5, grav: 0, color: this.magicColor });
        for (let i = 0; i < 2; i++) this.add(2, c.x + rand(-H * 0.5, H * 0.5), c.y - H * 0.4 + rand(-20, 20), rand(-10, 10), rand(60, 140), rand(0.6, 1.0), rand(4, 8), i ? GOLD : this.magicColor, 0.5, 0);
    }

    private burst(x: number, y: number, r: number, k: number) {
        for (let i = 0; i < Math.round(18 * k); i++) {
            const a = Math.random() * Math.PI * 2, sp = rand(220, 520) * (0.5 + k * 0.5);
            this.add(0, x + Math.cos(a) * r * 0.4, y + Math.sin(a) * r * 0.4, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.45, 0.8), rand(9, 18), [GOLD, WHITE, this.magicColor][i % 3], 3.5, 0);
        }
        for (let i = 0; i < Math.round(20 * k); i++) {
            const a = Math.random() * Math.PI * 2, sp = rand(60, 260);
            this.add(2, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.5, 0.9), rand(4, 8), i % 2 ? SAND : WHITE, 2, -100);
        }
    }

    private add(kind: 0 | 1 | 2, x: number, y: number, vx: number, vy: number, life: number, size: number, color: Color, drag: number, grav: number) {
        this._ps.push({ kind, x, y, vx, vy, age: 0, life, size, rot: rand(0, Math.PI), vr: rand(-5, 5), drag, grav, color });
    }

    /** 画沙漏（本地坐标，中心为原点） */
    private drawHourglass(g: Graphics, H: number, st: { top: number; flow: number; glow: number }) {
        g.clear();
        const hw = H * 0.3, hh = H * 0.5, cap = H * 0.08, neck = H * 0.035, bulbW = hw * 0.82, bulbH = hh - cap;
        // 发光
        if (st.glow > 0.01) {
            for (let i = 3; i >= 1; i--) { g.fillColor = alpha(GOLD, 0.18 * st.glow); g.circle(0, 0, H * 0.35 * i * 0.6); g.fill(); }
        }
        // 玻璃（两个梯形泡）
        const bulb = (dir: number) => {
            g.moveTo(-bulbW, dir * bulbH); g.lineTo(bulbW, dir * bulbH);
            g.bezierCurveTo(bulbW, dir * bulbH * 0.35, neck * 1.5, dir * bulbH * 0.15, neck, 0);
            g.lineTo(-neck, 0);
            g.bezierCurveTo(-neck * 1.5, dir * bulbH * 0.15, -bulbW, dir * bulbH * 0.35, -bulbW, dir * bulbH);
            g.close();
        };
        g.fillColor = alpha(GLASS, 0.28); bulb(1); g.fill(); bulb(-1); g.fill();
        // 上半沙（从下往上填 top 比例，按宽度近似成梯形）
        const topH = bulbH * 0.85 * st.top;
        if (topH > 1) {
            const y0 = bulbH * 0.12, y1 = y0 + topH;
            const wAt = (y: number) => neck + (bulbW - neck) * Math.min(1, Math.pow(y / bulbH, 0.6)) * 0.92;
            g.fillColor = SAND; g.moveTo(-wAt(y0), y0); g.lineTo(wAt(y0), y0); g.lineTo(wAt(y1), y1); g.lineTo(-wAt(y1), y1); g.close(); g.fill();
            g.fillColor = alpha(SAND, 1); g.moveTo(-neck, 0); g.lineTo(neck, 0); g.lineTo(wAt(y0), y0); g.lineTo(-wAt(y0), y0); g.close(); g.fill();
        }
        // 下半沙堆（1 - top）
        const bot = 1 - st.top;
        if (bot > 0.01) {
            const ph = bulbH * 0.8 * bot, base = -bulbH + 2;
            g.fillColor = SAND_DARK;
            g.moveTo(-bulbW * 0.95, base); g.lineTo(bulbW * 0.95, base);
            g.quadraticCurveTo(bulbW * 0.5, base + ph * 0.6, 0, base + ph);
            g.quadraticCurveTo(-bulbW * 0.5, base + ph * 0.6, -bulbW * 0.95, base);
            g.close(); g.fill();
        }
        // 流沙
        if (st.flow > 0.01) {
            g.lineWidth = Math.max(2, neck * 0.9); g.strokeColor = SAND;
            g.moveTo(0, 0); g.lineTo(0, -bulbH + 2 + bulbH * 0.8 * bot); g.stroke();
            const t = Date.now() / 1000;
            for (let i = 0; i < 4; i++) {
                const yy = -((t * 3 + i / 4) % 1) * (bulbH * 0.8);
                g.fillColor = alpha(WHITE, 0.8); g.circle(rand(-1.5, 1.5), yy, neck * 0.5); g.fill();
            }
        }
        // 玻璃高光 + 描边
        g.lineWidth = 3; g.strokeColor = alpha(WHITE, 0.85); bulb(1); g.stroke(); bulb(-1); g.stroke();
        g.lineWidth = 4; g.strokeColor = alpha(WHITE, 0.55);
        g.moveTo(-bulbW * 0.65, bulbH * 0.85); g.quadraticCurveTo(-bulbW * 0.75, bulbH * 0.45, -bulbW * 0.35, bulbH * 0.22); g.stroke();
        g.moveTo(-bulbW * 0.65, -bulbH * 0.85); g.quadraticCurveTo(-bulbW * 0.75, -bulbH * 0.45, -bulbW * 0.35, -bulbH * 0.22); g.stroke();
        // 木框：上下盖 + 两根柱
        for (const dir of [1, -1]) {
            g.fillColor = WOOD; g.roundRect(-hw - 6, dir > 0 ? hh - cap : -hh, (hw + 6) * 2, cap, cap * 0.35); g.fill();
            g.lineWidth = 3; g.strokeColor = WOOD_DARK; g.roundRect(-hw - 6, dir > 0 ? hh - cap : -hh, (hw + 6) * 2, cap, cap * 0.35); g.stroke();
        }
        for (const sx of [-1, 1]) {
            g.fillColor = WOOD; g.roundRect(sx * hw - 5, -hh + cap, 10, (hh - cap) * 2, 4); g.fill();
            g.lineWidth = 2; g.strokeColor = WOOD_DARK; g.roundRect(sx * hw - 5, -hh + cap, 10, (hh - cap) * 2, 4); g.stroke();
        }
    }

    update(dt: number) {
        const g = this._fx!, gt = this._top!;
        g.clear(); gt.clear();
        // 魔法阵
        for (const c of this._circles) {
            if (c.a <= 0.01) continue;
            c.rot += dt * 0.9;
            const col = this.magicColor;
            g.lineWidth = 4; g.strokeColor = alpha(col, 0.7 * c.a); g.circle(c.x, c.y, c.r); g.stroke();
            g.lineWidth = 2; g.strokeColor = alpha(col, 0.5 * c.a); g.circle(c.x, c.y, c.r * 0.86); g.stroke();
            // 刻度符文
            for (let i = 0; i < 24; i++) {
                const a = c.rot + i / 24 * Math.PI * 2, r0 = c.r * 0.88, r1 = c.r * (i % 2 ? 0.95 : 0.98);
                g.moveTo(c.x + Math.cos(a) * r0, c.y + Math.sin(a) * r0); g.lineTo(c.x + Math.cos(a) * r1, c.y + Math.sin(a) * r1);
            }
            g.stroke();
            // 内部六芒星（反向旋转）
            const rr = c.r * 0.78;
            for (const off of [0, Math.PI / 3]) {
                for (let i = 0; i <= 3; i++) {
                    const a = -c.rot * 0.7 + off + i * Math.PI * 2 / 3;
                    const x = c.x + Math.cos(a) * rr, y = c.y + Math.sin(a) * rr;
                    if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
                }
                g.stroke();
            }
            g.fillColor = alpha(col, 0.08 * c.a); g.circle(c.x, c.y, c.r); g.fill();
        }
        // 粒子
        for (let i = this._ps.length - 1; i >= 0; i--) {
            const p = this._ps[i]; p.age += dt; const t = p.age / p.life;
            if (t >= 1) { this._ps.splice(i, 1); continue; }
            const d = Math.exp(-p.drag * dt);
            p.vx *= d; p.vy = p.vy * d + p.grav * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
            const al = t < 0.15 ? t / 0.15 : 1 - (t - 0.15) / 0.85;
            if (p.kind === 0) {
                const s = p.size * (t < 0.2 ? 0.5 + 2.5 * t : 1 - (t - 0.2) * 0.6);
                gt.fillColor = alpha(p.color, al); star4(gt, p.x, p.y, s, p.rot); gt.fill();
            } else if (p.kind === 1) {
                // 时间符文：小钟面
                g.lineWidth = 2; g.strokeColor = alpha(p.color, al);
                g.circle(p.x, p.y, p.size); g.stroke();
                g.moveTo(p.x, p.y); g.lineTo(p.x + Math.cos(p.rot) * p.size * 0.75, p.y + Math.sin(p.rot) * p.size * 0.75); g.stroke();
                g.moveTo(p.x, p.y); g.lineTo(p.x + Math.cos(p.rot * 0.2) * p.size * 0.5, p.y + Math.sin(p.rot * 0.2) * p.size * 0.5); g.stroke();
            } else {
                const s = p.size * (1 - t * 0.5);
                g.fillColor = alpha(p.color, 0.35 * al); g.circle(p.x, p.y, s * 1.8); g.fill();
                g.fillColor = alpha(WHITE, 0.85 * al); g.circle(p.x, p.y, s * 0.5); g.fill();
            }
        }
        // 光环
        for (let i = this._rings.length - 1; i >= 0; i--) {
            const r = this._rings[i]; r.age += dt; if (r.age < 0) continue;
            const t = r.age / r.life; if (t >= 1) { this._rings.splice(i, 1); continue; }
            const e = 1 - Math.pow(1 - t, 3);
            gt.lineWidth = Math.max(1, r.w * (1 - t)); gt.strokeColor = alpha(r.color, 0.9 * (1 - t));
            gt.circle(r.x, r.y, r.r0 + (r.r1 - r.r0) * e); gt.stroke();
        }
        // 闪光
        for (let i = this._flashes.length - 1; i >= 0; i--) {
            const f = this._flashes[i]; f.age += dt; const t = f.age / f.life;
            if (t >= 1) { this._flashes.splice(i, 1); continue; }
            const a = (1 - t) * (1 - t);
            for (let k = 3; k >= 1; k--) { gt.fillColor = new Color(255, 250, 230, Math.round(255 * a * (0.12 + 0.2 * k / 3))); gt.circle(f.x, f.y, f.r * (0.4 + 0.6 * t) * k / 3); gt.fill(); }
        }
    }
}

function rand(a: number, b: number) { return a + Math.random() * (b - a); }
function alpha(c: Color, a: number) { return new Color(c.r, c.g, c.b, Math.max(0, Math.min(255, Math.round(255 * a)))); }
function star4(g: Graphics, x: number, y: number, s: number, rot: number) {
    for (let i = 0; i < 8; i++) {
        const a = rot + i * Math.PI / 4, r = i % 2 === 0 ? s : s * 0.3;
        const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.close();
}
