import {
    _decorator, Component, Node, Label, Sprite, UIOpacity, UITransform, Vec3, Vec4, Color,
    tween, Tween, Graphics, EffectAsset, Material,
} from 'cc';
const { ccclass, property } = _decorator;

/**
 * 「本命方块 / 选择开场道具」页面动画 + 特效（Cocos Creator 3.8.x，2D UI）
 * 通关弹窗关闭后紧接着弹出。
 *
 * 在编辑器里按设计图把元素摆到最终位置，拖到对应属性上即可；任何属性都可以留空。
 *
 * 入场时间轴（约 1.8 秒）：
 *   0.00 面板从上方落下 → 落地压扁回弹，底部两侧扬起灰尘；趴在面板上的角色被颠一下
 *   0.40 标题「本命方块」砸下
 *   0.50 「第 N 层」先显示上一层，0.75 翻牌变成当前层 + 闪星
 *   0.75 本命方块逐个从上方落进格子，落地压扁 + 灰尘 + 小光环
 *   ≈1.4 全部落位后一起「点亮」：放大回弹 + 金色光环 + 闪星
 *   1.00 三张道具卡从下方依次弹出，数量从 x0 滚到实际数量
 *   1.30 「选择一个开场道具」淡入，之后一直呼吸闪烁
 *   1.40 「直接开始」按钮弹出，之后呼吸 + 周期扫光
 * 待机：角色睡觉呼吸 + 冒 Zzz，方块轻微脉动，道具卡轻微浮动，周围随机闪光。
 *
 * 用法：
 *   await levelComplete.hide();
 *   await destiny.show({ level: 51, counts: [83, 73, 91] });
 *   destiny.onCardSelected = (i) => { ... };     // i = -1 表示取消选择
 *   ...
 *   await destiny.hide();
 */
export interface DestinyShowOptions {
    /** 当前层数 */
    level: number;
    /** 每张道具卡的数量 */
    counts?: number[];
    /** 是否播放遮罩淡入（从通关弹窗接过来时遮罩已经是黑的，可以设为 false），默认 true */
    fadeMask?: boolean;
}

@ccclass('DestinyBlockPopup')
export class DestinyBlockPopup extends Component {

    @property({ type: Node, tooltip: '半透明黑色遮罩（全屏）' }) mask: Node | null = null;
    @property({ type: Node, tooltip: '面板（石框）' }) panel: Node | null = null;
    @property({ type: Node, tooltip: '趴在面板上的角色' }) character: Node | null = null;
    @property({ type: Node, tooltip: '标题「本命方块」' }) title: Node | null = null;
    @property({ type: Label, tooltip: '层数 Label（第 51 层）' }) layerLabel: Label | null = null;
    @property({ tooltip: '层数文字格式，{n} 会替换成层数' }) layerFormat = '第 {n} 层';
    @property({ type: [Node], tooltip: '本命方块（格子里的方块），按落下顺序排列' }) blocks: Node[] = [];
    @property({ type: [Node], tooltip: '道具卡' }) cards: Node[] = [];
    @property({ type: [Label], tooltip: '道具卡数量 Label（x83），和 cards 一一对应' }) cardCounts: Label[] = [];
    @property({ tooltip: '数量文字格式' }) countFormat = 'x{n}';
    @property({ tooltip: '点击道具卡时自动播放选中动画' }) autoBindCards = true;
    @property({ type: Node, tooltip: '「选择一个开场道具」提示文字' }) hint: Node | null = null;
    @property({ type: Node, tooltip: '「直接开始」按钮' }) startButton: Node | null = null;

    @property({ type: EffectAsset, tooltip: '拖入 ui-shine.effect（可空）' }) shineEffect: EffectAsset | null = null;
    @property({ type: [Sprite], tooltip: '要扫光的精灵，一般是按钮和标题' }) shineSprites: Sprite[] = [];
    @property({ tooltip: '扫光间隔（秒）' }) shineInterval = 2.6;
    @property({ tooltip: '遮罩最终不透明度 0~255' }) maskOpacity = 200;
    @property({ type: Color, tooltip: '方块点亮、选中框的颜色' }) glowColor: Color = new Color(255, 200, 90, 255);

    /** 选择道具回调，index = -1 表示取消选择 */
    onCardSelected: ((index: number) => void) | null = null;

    get selectedIndex() { return this._selected; }

    // ------------------------------------------------------------------

    private _base = new Map<Node, { pos: Vec3; scale: Vec3; angle: number; opacity: number }>();
    private _fx: Graphics | null = null;
    private _fxNode: Node | null = null;
    private _playing = false;
    private _idle = false;
    private _t = 0;
    private _shineT = -1;
    private _selected = -1;
    private _selT = 0;
    private _zzzAcc = 0;
    private _twinkleAcc = 0;
    private _sparkles: Sparkle[] = [];
    private _rings: Ring[] = [];
    private _dust: Dust[] = [];
    private _zzz: { node: Node; age: number; x: number; y: number; drift: number }[] = [];
    private _shineMats: { sp: Sprite; rect: Vec4; params: Vec4 }[] = [];
    private _showResolve: (() => void) | null = null;
    private _tmp = new Vec3();

    onLoad() {
        for (const n of this.allNodes()) {
            this._base.set(n, { pos: n.position.clone(), scale: n.scale.clone(), angle: n.angle, opacity: this.op(n).opacity });
        }
        const fxNode = new Node('DestinyFx');
        fxNode.layer = this.node.layer;
        this.node.addChild(fxNode);
        const ut = fxNode.addComponent(UITransform);
        const rootUt = this.node.getComponent(UITransform);
        if (rootUt) ut.setContentSize(rootUt.contentSize);
        this._fx = fxNode.addComponent(Graphics);
        this._fxNode = fxNode;

        if (this.shineEffect) {
            for (const sp of this.shineSprites) {
                if (!sp) continue;
                const mat = new Material();
                mat.initialize({ effectAsset: this.shineEffect, defines: { USE_TEXTURE: true } });
                sp.customMaterial = mat;
                this._shineMats.push({ sp, rect: new Vec4(), params: new Vec4(-1, 0.12, 0.6, 0.5) });
            }
        }

        if (this.autoBindCards) {
            this.cards.forEach((c, i) => c && c.on(Node.EventType.TOUCH_END, () => {
                if (this._idle) this.selectCard(this._selected === i ? -1 : i);
            }, this));
        }
    }

    show(opts: DestinyShowOptions): Promise<void> {
        this.node.active = true;
        this.stopAll();
        this.resetHidden();
        this._t = 0;
        this._playing = true;
        this._idle = false;
        this._shineT = -1;
        this._selected = -1;
        this._sparkles.length = this._rings.length = this._dust.length = 0;
        this.clearZzz();

        const level = opts.level;
        const counts = opts.counts || [];

        // 遮罩
        if (this.mask) {
            const mo = this.op(this.mask);
            if (opts.fadeMask === false) mo.opacity = this.maskOpacity;
            else tween(mo).to(0.2, { opacity: this.maskOpacity }, { easing: 'quadOut' }).start();
        }

        // 0.00 面板落下
        const panelDrop = 700;
        if (this.panel) {
            const n = this.panel, b = this.base(n);
            n.setPosition(b.pos.x, b.pos.y + panelDrop, b.pos.z);
            this.op(n).opacity = b.opacity;
            tween(n)
                .to(0.35, { position: b.pos.clone() }, { easing: 'quadIn' })
                .call(() => this.landDust(n))
                .to(0.08, { scale: new Vec3(b.scale.x * 1.04, b.scale.y * 0.95, b.scale.z) }, { easing: 'quadOut' })
                .to(0.15, { scale: b.scale.clone() }, { easing: 'quadOut' })
                .start();
        }
        // 角色跟着面板落下，落地时被颠一下
        if (this.character) {
            const n = this.character, b = this.base(n);
            const inPanel = this.panel && this.isDescendant(n, this.panel);
            const startY = inPanel ? b.pos.y : b.pos.y + panelDrop;
            n.setPosition(b.pos.x, startY, b.pos.z);
            this.op(n).opacity = b.opacity;
            let tw = tween(n);
            if (!inPanel) tw = tw.to(0.35, { position: b.pos.clone() }, { easing: 'quadIn' });
            else tw = tw.delay(0.35);
            tw.to(0.12, { position: new Vec3(b.pos.x, b.pos.y + 22, b.pos.z), angle: b.angle + 6 }, { easing: 'quadOut' })
                .to(0.2, { position: b.pos.clone(), angle: b.angle }, { easing: 'bounceOut' })
                .start();
        }

        // 0.40 标题
        if (this.title) {
            const n = this.title, b = this.base(n);
            n.setScale(Vec3.multiplyScalar(this._tmp, b.scale, 1.8));
            tween(this.op(n)).delay(0.4).to(0.1, { opacity: b.opacity }).start();
            tween(n).delay(0.4).to(0.2, { scale: b.scale.clone() }, { easing: 'quadIn' })
                .call(() => this.sparkBurst(n, 6, 1.0)).start();
        }

        // 0.50 层数：先显示上一层，0.75 翻牌
        if (this.layerLabel) {
            const n = this.layerLabel.node, b = this.base(n);
            this.layerLabel.string = this.layerFormat.replace('{n}', String(Math.max(0, level - 1)));
            tween(this.op(n)).delay(0.5).to(0.15, { opacity: b.opacity }).start();
            tween(n).delay(0.75)
                .to(0.09, { scale: new Vec3(b.scale.x, 0, b.scale.z) }, { easing: 'quadIn' })
                .call(() => { if (this.layerLabel) this.layerLabel.string = this.layerFormat.replace('{n}', String(level)); })
                .to(0.12, { scale: new Vec3(b.scale.x * 1.15, b.scale.y * 1.25, b.scale.z) }, { easing: 'quadOut' })
                .to(0.12, { scale: b.scale.clone() }, { easing: 'quadInOut' })
                .call(() => { this.sparkBurst(n, 6, 1.1); this.ring(n, 0.9, 1.8, 0.4, 0.8); })
                .start();
        }

        // 0.75 本命方块逐个落下
        this.blocks.forEach((blk, i) => {
            if (!blk) return;
            const b = this.base(blk), d = 0.75 + i * 0.12;
            blk.setPosition(b.pos.x, b.pos.y + 90, b.pos.z);
            tween(this.op(blk)).delay(d).to(0.08, { opacity: b.opacity }).start();
            tween(blk).delay(d)
                .to(0.22, { position: b.pos.clone() }, { easing: 'quadIn' })
                .call(() => { this.landDust(blk, 0.6); this.ring(blk, 0.8, 1.6, 0.3, 0.6); })
                .to(0.06, { scale: new Vec3(b.scale.x * 1.15, b.scale.y * 0.85, b.scale.z) }, { easing: 'quadOut' })
                .to(0.15, { scale: b.scale.clone() }, { easing: 'backOut' })
                .start();
        });
        // 全部落位后一起点亮
        const revealT = 0.75 + Math.max(0, this.blocks.length - 1) * 0.12 + 0.22 + 0.2;
        this.scheduleOnce(() => {
            this.blocks.forEach((blk, i) => {
                if (!blk) return;
                const b = this.base(blk);
                tween(blk).delay(i * 0.04)
                    .to(0.08, { scale: Vec3.multiplyScalar(new Vec3(), b.scale, 1.18) }, { easing: 'quadOut' })
                    .to(0.25, { scale: b.scale.clone() }, { easing: 'backOut' })
                    .start();
                this.ring(blk, 0.9, 2.4, 0.5, 1);
                this.sparkBurst(blk, 4, 1.3);
            });
        }, this.blocks.length ? revealT : 0);

        // 0.40 道具卡（加快节奏：delay 1.0→0.4，间隔 0.08→0.04，位移时间 0.25→0.15）
        this.cards.forEach((c, i) => {
            if (!c) return;
            const b = this.base(c), d = 0.4 + i * 0.04;
            c.setPosition(b.pos.x, b.pos.y - 60, b.pos.z);
            c.setScale(Vec3.multiplyScalar(new Vec3(), b.scale, 0.6));
            tween(this.op(c)).delay(d).to(0.08, { opacity: b.opacity }).start();
            tween(c).delay(d)
                .to(0.15, { position: b.pos.clone(), scale: Vec3.multiplyScalar(new Vec3(), b.scale, 1.08) }, { easing: 'quadOut' })
                .to(0.08, { scale: b.scale.clone() }, { easing: 'quadInOut' })
                .start();
            const lbl = this.cardCounts[i];
            const target = counts[i];
            if (lbl && target !== undefined) {
                lbl.string = this.countFormat.replace('{n}', '0');
                const counter = { v: 0 };
                tween(counter).delay(d + 0.05).to(0.35, { v: target }, {
                    easing: 'quadOut',
                    onUpdate: () => { lbl.string = this.countFormat.replace('{n}', String(Math.round(counter.v))); },
                }).call(() => { lbl.string = this.countFormat.replace('{n}', String(target)); }).start();
            }
        });

        // 0.60 提示文字（跟着道具卡节奏）
        if (this.hint) {
            const b = this.base(this.hint);
            tween(this.op(this.hint)).delay(0.6).to(0.15, { opacity: b.opacity }).start();
        }
        // 0.65 开始按钮
        if (this.startButton) {
            const n = this.startButton, b = this.base(n);
            n.setScale(0, 0, 1);
            tween(this.op(n)).delay(0.65).to(0.08, { opacity: b.opacity }).start();
            tween(n).delay(0.65)
                .to(0.18, { scale: Vec3.multiplyScalar(new Vec3(), b.scale, 1.1) }, { easing: 'backOut' })
                .to(0.08, { scale: b.scale.clone() })
                .start();
        }

        this.scheduleOnce(() => { this._shineT = 0; }, 1.0);
        return new Promise<void>(res => {
            this._showResolve = res;
            this.scheduleOnce(() => {
                this._idle = true; this._t = 0;
                const r = this._showResolve; this._showResolve = null; r && r();
            }, 1.0);
        });
    }

    /** 选中某张道具卡（-1 取消选择） */
    selectCard(index: number) {
        this._selected = index;
        this._selT = 0;
        this.cards.forEach((c, i) => {
            if (!c) return;
            const b = this.base(c);
            Tween.stopAllByTarget(c);
            Tween.stopAllByTarget(this.op(c));
            const sel = i === index, dim = index >= 0 && !sel;
            tween(c).to(0.2, { scale: Vec3.multiplyScalar(new Vec3(), b.scale, sel ? 1.1 : dim ? 0.94 : 1), position: b.pos.clone() },
                { easing: sel ? 'backOut' : 'quadOut' }).start();
            tween(this.op(c)).to(0.2, { opacity: dim ? b.opacity * 0.65 : b.opacity }).start();
            if (sel) { this.sparkBurst(c, 6, 1.1); this.ring(c, 0.9, 1.6, 0.35, 0.8); }
        });
        if (this.onCardSelected) this.onCardSelected(index);
    }

    hide(): Promise<void> {
        this.stopAll();
        this._idle = false;
        return new Promise<void>(res => {
            for (const n of this.allNodes()) {
                if (n === this.mask) continue;
                tween(this.op(n)).to(0.2, { opacity: 0 }).start();
            }
            if (this.panel) {
                const b = this.base(this.panel);
                tween(this.panel).to(0.25, { position: new Vec3(b.pos.x, b.pos.y + 80, b.pos.z), scale: Vec3.multiplyScalar(new Vec3(), b.scale, 0.9) },
                    { easing: 'quadIn' }).start();
            }
            if (this.mask) tween(this.op(this.mask)).delay(0.1).to(0.2, { opacity: 0 }).start();
            this.scheduleOnce(() => {
                this._playing = false;
                this._sparkles.length = this._rings.length = this._dust.length = 0;
                this.clearZzz();
                this._fx?.clear();
                this.restoreAll();
                this.node.active = false;
                res();
            }, 0.32);
        });
    }

    // ------------------------------------------------------------------

    update(dt: number) {
        if (!this._playing) return;
        this._t += dt;
        const t = this._t;

        if (this._idle) {
            // 角色睡觉呼吸
            this.idle(this.character, (n, b) => {
                const k = Math.sin(t * 1.6);
                n.setScale(b.scale.x * (1 + 0.012 * k), b.scale.y * (1 + 0.03 * k), b.scale.z);
            });
            // 方块脉动、道具卡浮动、提示文字呼吸、按钮呼吸 —— 按需求全部移除

            // Zzz
            this._zzzAcc += dt;
            if (this._zzzAcc > 1.1 && this.character) { this._zzzAcc = 0; this.spawnZzz(); }
            // 随机闪光
            this._twinkleAcc += dt;
            if (this._twinkleAcc > 0.4) {
                this._twinkleAcc = 0;
                // 置灰的道具卡不应该闪 —— 只让未选中前的所有卡、或选中的那张、以及方块/标题参与
                const cardPool = this._selected >= 0
                    ? (this.cards[this._selected] ? [this.cards[this._selected]] : [])
                    : this.cards;
                const pool = [...this.blocks, ...cardPool, this.title].filter(n => !!n) as Node[];
                if (pool.length) this.sparkBurst(pool[(Math.random() * pool.length) | 0], 1, 1.2);
            }
        }
        this.updateZzz(dt);

        // 扫光
        if (this._shineT >= 0 && this._shineMats.length) {
            this._shineT += dt;
            const cyc = this._shineT % this.shineInterval;
            const prog = cyc < 0.6 ? -0.3 + 1.6 * (cyc / 0.6) : -1;
            for (const s of this._shineMats) {
                const ut = s.sp.node.getComponent(UITransform);
                if (!ut) continue;
                const r = ut.getBoundingBoxToWorld();
                s.rect.set(r.x, r.y, r.width, r.height);
                s.params.x = prog;
                const mi = s.sp.getMaterialInstance(0);
                if (mi) { mi.setProperty('shineRect', s.rect); mi.setProperty('shineParams', s.params); }
            }
        }

        this.drawFx(dt);
    }

    // ---------------- 特效 ----------------

    private drawFx(dt: number) {
        const g = this._fx;
        if (!g) return;
        g.clear();
        const gc = this.glowColor;

        // 灰尘
        for (let i = this._dust.length - 1; i >= 0; i--) {
            const d = this._dust[i];
            d.age += dt;
            if (d.age >= d.life) { this._dust.splice(i, 1); continue; }
            const k = d.age / d.life;
            d.x += d.vx * dt; d.y += d.vy * dt; d.vx *= 0.92; d.vy *= 0.92;
            g.fillColor = tmpColor.set(200, 190, 210, 150 * (1 - k));
            g.circle(d.x, d.y, d.r * (0.6 + 0.8 * k));
            g.fill();
        }
        // 光环
        for (let i = this._rings.length - 1; i >= 0; i--) {
            const r = this._rings[i];
            r.age += dt;
            if (r.age >= r.life) { this._rings.splice(i, 1); continue; }
            const k = r.age / r.life, e = 1 - Math.pow(1 - k, 3);
            g.lineWidth = 4 * (1 - k) + 1;
            g.strokeColor = tmpColor.set(gc.r, gc.g, gc.b, 255 * r.alpha * (1 - k) * (1 - k));
            g.circle(r.x, r.y, r.r0 + (r.r1 - r.r0) * e);
            g.stroke();
        }
        // 选中框
        if (this._selected >= 0 && this.cards[this._selected]) {
            this._selT += dt;
            const c = this.cards[this._selected];
            const ut = c.getComponent(UITransform);
            if (ut) {
                const p = this.toLocal(c, new Vec3());
                const w = ut.width * Math.abs(c.scale.x) + 10, h = ut.height * Math.abs(c.scale.y) + 10;
                const pulse = 0.6 + 0.4 * Math.sin(this._selT * 5);
                for (let k = 0; k < 3; k++) {
                    g.lineWidth = 6 - k * 2;
                    g.strokeColor = tmpColor.set(gc.r, gc.g, gc.b, (60 + k * 70) * pulse);
                    g.roundRect(p.x - w / 2 - (2 - k) * 3, p.y - h / 2 - (2 - k) * 3, w + (2 - k) * 6, h + (2 - k) * 6, 16);
                    g.stroke();
                }
            }
        }
        // 闪星
        for (let i = this._sparkles.length - 1; i >= 0; i--) {
            const s = this._sparkles[i];
            s.age += dt;
            if (s.age >= s.life) { this._sparkles.splice(i, 1); continue; }
            const k = s.age / s.life, sc = Math.sin(Math.PI * k);
            s.rot += s.vr * dt;
            const R = s.size * sc, r = R * 0.28;
            g.fillColor = tmpColor.set(255, 248, 215, 255 * sc);
            for (let j = 0; j < 8; j++) {
                const a = s.rot + j * Math.PI / 4, rr = j % 2 === 0 ? R : r;
                const x = s.x + Math.cos(a) * rr, y = s.y + Math.sin(a) * rr;
                if (j === 0) g.moveTo(x, y); else g.lineTo(x, y);
            }
            g.close();
            g.fill();
        }
    }

    private sparkBurst(n: Node, count: number, spread: number) {
        const ut = n.getComponent(UITransform);
        const c = this.toLocal(n, new Vec3());
        const w = (ut ? ut.width * Math.abs(n.scale.x) : 100) * 0.5 * spread;
        const h = (ut ? ut.height * Math.abs(n.scale.y) : 100) * 0.5 * spread;
        for (let i = 0; i < count; i++) {
            this._sparkles.push({ x: c.x + rand(-w, w), y: c.y + rand(-h, h), size: rand(10, 20), age: 0, life: rand(0.45, 0.8), rot: rand(0, Math.PI), vr: rand(-2, 2) });
        }
    }

    /** 以节点为中心的扩散光环，半径按节点尺寸的倍数 */
    private ring(n: Node, fromMul: number, toMul: number, life: number, alpha: number) {
        const ut = n.getComponent(UITransform);
        const c = this.toLocal(n, new Vec3());
        const base = ut ? Math.max(ut.width, ut.height) * 0.5 : 40;
        this._rings.push({ x: c.x, y: c.y, r0: base * fromMul, r1: base * toMul, age: 0, life, alpha });
    }

    /** 节点底部两侧扬起灰尘 */
    private landDust(n: Node, scale = 1) {
        const ut = n.getComponent(UITransform);
        const w = (ut ? ut.width : 200) * 0.5, h = (ut ? ut.height : 200) * 0.5;
        for (const side of [-1, 1]) {
            const p = this.toLocal(n, new Vec3(side * w * 0.9, -h, 0));
            for (let i = 0; i < 6; i++) {
                this._dust.push({
                    x: p.x, y: p.y, vx: side * rand(60, 220) * scale, vy: rand(10, 90) * scale,
                    r: rand(6, 14) * scale, age: 0, life: rand(0.35, 0.6),
                });
            }
        }
    }

    private spawnZzz() {
        const ch = this.character!;
        const ut = ch.getComponent(UITransform);
        const p = this.toLocal(ch, new Vec3((ut ? ut.width : 100) * 0.3, (ut ? ut.height : 60) * 0.3, 0));
        const node = new Node('Zzz');
        node.layer = this.node.layer;
        node.addComponent(UITransform);
        const lbl = node.addComponent(Label);
        lbl.string = 'Z';
        lbl.fontSize = 22;
        lbl.lineHeight = 24;
        lbl.isBold = true;
        lbl.color = new Color(220, 225, 255, 255);
        node.addComponent(UIOpacity).opacity = 0;
        this.node.insertChild(node, this._fxNode ? this._fxNode.getSiblingIndex() : this.node.children.length);
        node.setPosition(p);
        this._zzz.push({ node, age: 0, x: p.x, y: p.y, drift: rand(0.8, 1.2) });
    }

    private updateZzz(dt: number) {
        for (let i = this._zzz.length - 1; i >= 0; i--) {
            const z = this._zzz[i];
            z.age += dt;
            const life = 2.0, k = z.age / life;
            if (k >= 1 || !z.node.isValid) { if (z.node.isValid) z.node.destroy(); this._zzz.splice(i, 1); continue; }
            z.node.setPosition(z.x + k * 40 * z.drift + Math.sin(z.age * 3) * 5, z.y + k * 70, 0);
            const s = 0.5 + 0.7 * k;
            z.node.setScale(s, s, 1);
            z.node.angle = 12 - 20 * k;
            const op = z.node.getComponent(UIOpacity)!;
            op.opacity = 255 * Math.min(1, k * 5) * (1 - k);
        }
    }

    private clearZzz() {
        for (const z of this._zzz) if (z.node.isValid) z.node.destroy();
        this._zzz.length = 0;
    }

    // ---------------- 工具 ----------------

    private allNodes(): Node[] {
        const list: (Node | null)[] = [
            this.mask, this.panel, this.character, this.title, this.layerLabel ? this.layerLabel.node : null,
            ...this.blocks, ...this.cards, this.hint, this.startButton,
        ];
        return list.filter(n => !!n) as Node[];
    }

    private base(n: Node) { return this._base.get(n)!; }
    private op(n: Node): UIOpacity { return n.getComponent(UIOpacity) || n.addComponent(UIOpacity); }

    private isDescendant(n: Node, ancestor: Node) {
        let p = n.parent;
        while (p) { if (p === ancestor) return true; p = p.parent; }
        return false;
    }

    private toLocal(n: Node, local: Vec3): Vec3 {
        const ut = n.getComponent(UITransform);
        const world = ut ? ut.convertToWorldSpaceAR(local) : n.worldPosition.clone();
        const rootUt = this.node.getComponent(UITransform);
        return rootUt ? rootUt.convertToNodeSpaceAR(world) : world;
    }

    private stopAll() {
        Tween.stopAllByTarget(this.node);
        for (const n of this.allNodes()) { Tween.stopAllByTarget(n); Tween.stopAllByTarget(this.op(n)); }
        this.unscheduleAllCallbacks();
        const r = this._showResolve; this._showResolve = null; r && r();
    }

    private resetHidden() {
        for (const n of this.allNodes()) {
            const b = this.base(n);
            n.setPosition(b.pos); n.setScale(b.scale); n.angle = b.angle;
            this.op(n).opacity = 0;
        }
    }

    private restoreAll() {
        for (const n of this.allNodes()) {
            const b = this.base(n);
            n.setPosition(b.pos); n.setScale(b.scale); n.angle = b.angle;
            this.op(n).opacity = b.opacity;
        }
    }

    private idle(n: Node | null, fn: (n: Node, b: { pos: Vec3; scale: Vec3; angle: number; opacity: number }) => void) {
        if (n && n.isValid) fn(n, this.base(n));
    }

    /**
     * 对外接口：为动态生成的本命方块格子播放落下动画。
     * 用于 HudController.drawFateShape() 每次重建 FateCell_r_c 之后调用。
     * @param cells 动态生成的方块节点数组（顺序即落下顺序）
     * @param startDelay 首个方块开始下落的延时（秒），默认 0（立即开始，配合弹窗时序请传 0.75）
     */
    animateBlocks(cells: Node[], startDelay = 0) {
        if (!cells || cells.length === 0) return;
        for (const blk of cells) {
            if (!blk || !blk.isValid) continue;
            // 每次动态生成时都要重新记录 base（覆盖之前的记录）
            this._base.set(blk, {
                pos: blk.position.clone(),
                scale: blk.scale.clone(),
                angle: blk.angle,
                opacity: this.op(blk).opacity || 255,
            });
        }
        cells.forEach((blk, i) => {
            if (!blk || !blk.isValid) return;
            const b = this._base.get(blk)!;
            const d = startDelay + i * 0.12;
            Tween.stopAllByTarget(blk);
            Tween.stopAllByTarget(this.op(blk));
            blk.setPosition(b.pos.x, b.pos.y + 90, b.pos.z);
            this.op(blk).opacity = 0;
            tween(this.op(blk)).delay(d).to(0.08, { opacity: b.opacity }).start();
            tween(blk).delay(d)
                .to(0.22, { position: b.pos.clone() }, { easing: 'quadIn' })
                .call(() => { this.landDust(blk, 0.6); this.ring(blk, 0.8, 1.6, 0.3, 0.6); })
                .to(0.06, { scale: new Vec3(b.scale.x * 1.15, b.scale.y * 0.85, b.scale.z) }, { easing: 'quadOut' })
                .to(0.15, { scale: b.scale.clone() }, { easing: 'backOut' })
                .start();
        });
        const revealT = startDelay + (cells.length - 1) * 0.12 + 0.22 + 0.2;
        this.scheduleOnce(() => {
            cells.forEach((blk, i) => {
                if (!blk || !blk.isValid) return;
                const b = this._base.get(blk); if (!b) return;
                tween(blk).delay(i * 0.04)
                    .to(0.08, { scale: Vec3.multiplyScalar(new Vec3(), b.scale, 1.18) }, { easing: 'quadOut' })
                    .to(0.25, { scale: b.scale.clone() }, { easing: 'backOut' })
                    .start();
                this.ring(blk, 0.9, 2.4, 0.5, 1);
                this.sparkBurst(blk, 4, 1.3);
            });
        }, revealT);
    }
}

interface Sparkle { x: number; y: number; size: number; age: number; life: number; rot: number; vr: number; }
interface Ring { x: number; y: number; r0: number; r1: number; age: number; life: number; alpha: number; }
interface Dust { x: number; y: number; vx: number; vy: number; r: number; age: number; life: number; }

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const tmpColor = new Color();
