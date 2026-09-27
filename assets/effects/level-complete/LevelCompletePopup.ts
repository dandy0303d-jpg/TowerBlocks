import {
    _decorator, Component, Node, Label, Sprite, UIOpacity, UITransform, Vec3, Vec4, Color,
    tween, Tween, Graphics, EffectAsset, Material, view,
} from 'cc';
const { ccclass, property } = _decorator;

/**
 * 通关胜利弹窗动画 + 特效（Cocos Creator 3.8.x，2D UI）
 *
 * 在编辑器里按设计图摆好每个元素的最终位置，把节点拖到对应属性上即可。
 * 所有属性都可以留空，留空的元素会被跳过。脚本只在「最终摆放状态」基础上做动画，结束后元素回到你摆的位置。
 *
 * 入场时间轴（约 1.6 秒）：
 *   0.00 遮罩淡入
 *   0.05 面板从小放大弹出
 *   0.30 标题「恭喜通关」从大到小砸下来 → 面板震动 + 标题周围闪星
 *   0.35 背后光晕、放射光芒展开，光芒持续旋转
 *   0.40 角色从上方落下 → 压扁回弹；两块石头从角色身上弹出
 *   0.60 两侧彩纸炮发射
 *   0.62 左右方块旋转飞入、星星旋转弹出、右下角方块弹跳落下、小装饰依次弹出
 *   0.75 「通关时间：」滑入
 *   0.85 时间数字从 00:00 滚动到实际用时，结束时弹一下 + 闪星
 *   1.30 按钮依次弹出
 *   1.20 起面板、标题周期性扫光
 * 之后进入待机：角色呼吸、石头上下浮动、方块和星星漂浮摆动、光晕呼吸、星星周围随机闪光。
 *
 * 用法：
 *   popup.node.active = true;
 *   await popup.show(192);   // 192 秒 → 03:12
 *   ...
 *   await popup.hide();
 */
@ccclass('LevelCompletePopup')
export class LevelCompletePopup extends Component {

    @property({ type: Node, tooltip: '半透明黑色遮罩（全屏）' }) mask: Node | null = null;
    @property({ type: Node, tooltip: '角色背后的圆形光晕' }) glow: Node | null = null;
    @property({ type: Node, tooltip: '放射光芒（会持续旋转）' }) rays: Node | null = null;
    @property({ type: Node, tooltip: '角色（方块小人）' }) character: Node | null = null;
    @property({ type: Node, tooltip: '角色左边的蓝色石头' }) stoneLeft: Node | null = null;
    @property({ type: Node, tooltip: '角色右边的粉色石头' }) stoneRight: Node | null = null;
    @property({ type: Node, tooltip: '面板（石框）' }) panel: Node | null = null;
    @property({ type: Node, tooltip: '标题「恭喜通关」' }) title: Node | null = null;
    @property({ type: Node, tooltip: '「通关时间：」文字' }) timeTitle: Node | null = null;
    @property({ type: Label, tooltip: '时间数字 Label（03:12）' }) timeValue: Label | null = null;
    @property({ type: Node, tooltip: '左侧星星' }) starLeft: Node | null = null;
    @property({ type: Node, tooltip: '右侧星星' }) starRight: Node | null = null;
    @property({ type: Node, tooltip: '左侧黄色方块' }) pieceLeft: Node | null = null;
    @property({ type: Node, tooltip: '右侧红色方块' }) pieceRight: Node | null = null;
    @property({ type: Node, tooltip: '右下角的小方块堆' }) pieceCorner: Node | null = null;
    @property({ type: [Node], tooltip: '其他小装饰（彩纸片等），依次弹出并漂浮' }) decorations: Node[] = [];
    @property({ type: [Node], tooltip: '按钮（继续、下一关等），最后依次弹出' }) buttons: Node[] = [];

    @property({ type: EffectAsset, tooltip: '拖入 ui-shine.effect（可空，空则没有扫光）' }) shineEffect: EffectAsset | null = null;
    @property({ type: [Sprite], tooltip: '要扫光的精灵，一般是面板和标题' }) shineSprites: Sprite[] = [];
    @property({ tooltip: '扫光间隔（秒）' }) shineInterval = 2.8;

    @property({ tooltip: '遮罩最终不透明度 0~255' }) maskOpacity = 180;
    @property({ tooltip: '光芒旋转速度（度/秒）' }) rayRotateSpeed = 18;
    @property({ tooltip: '彩纸数量' }) confettiCount = 90;
    @property({ type: [Color], tooltip: '彩纸颜色（空则用默认的黄、橙、红、绿、蓝、粉）' }) confettiColors: Color[] = [];

    /** 自定义时间格式，默认 mm:ss */
    formatTime: (sec: number) => string = (sec: number) => {
        const s = Math.max(0, Math.floor(sec));
        const m = Math.floor(s / 60);
        return `${m < 10 ? '0' : ''}${m}:${s % 60 < 10 ? '0' : ''}${s % 60}`;
    };

    // ------------------------------------------------------------------

    private _base = new Map<Node, { pos: Vec3; scale: Vec3; angle: number; opacity: number }>();
    private _fx: Graphics | null = null;
    private _t = 0;
    private _playing = false;
    private _idle = false;
    private _raysOn = false;
    private _shineT = -1;
    private _twinkleAcc = 0;
    private _confetti: Confetti[] = [];
    private _sparkles: Sparkle[] = [];
    private _shineMats: { sp: Sprite; rect: Vec4; params: Vec4 }[] = [];
    private _tmp = new Vec3();
    private _showResolve: (() => void) | null = null;

    onLoad() {
        for (const n of this.allNodes()) {
            this._base.set(n, {
                pos: n.position.clone(),
                scale: n.scale.clone(),
                angle: n.angle,
                opacity: this.op(n).opacity,
            });
        }
        // 特效层：放在最上层
        const fxNode = new Node('PopupFx');
        fxNode.layer = this.node.layer;
        this.node.addChild(fxNode);
        const ut = fxNode.addComponent(UITransform);
        const rootUt = this.node.getComponent(UITransform);
        if (rootUt) ut.setContentSize(rootUt.contentSize);
        this._fx = fxNode.addComponent(Graphics);

        // 扫光材质
        if (this.shineEffect) {
            for (const sp of this.shineSprites) {
                if (!sp) continue;
                const mat = new Material();
                mat.initialize({ effectAsset: this.shineEffect, defines: { USE_TEXTURE: true } });
                sp.customMaterial = mat;
                this._shineMats.push({ sp, rect: new Vec4(), params: new Vec4(-1, 0.12, 0.6, 0.5) });
            }
        }
    }

    /** 播放入场动画。seconds 为通关用时（秒）。入场动画结束时 resolve。 */
    show(seconds: number): Promise<void> {
        this.node.active = true;
        this.stopAll();
        this.resetHidden();
        this._t = 0;
        this._playing = true;
        this._idle = false;
        this._raysOn = false;
        this._shineT = -1;
        this._confetti.length = 0;
        this._sparkles.length = 0;
        if (this.timeValue) this.timeValue.string = this.formatTime(0);

        // 0.00 遮罩
        if (this.mask) tween(this.op(this.mask)).to(0.2, { opacity: this.maskOpacity }, { easing: 'quadOut' }).start();

        // 0.05 面板弹出
        this.popIn(this.panel, 0.05, 0.3, 1.08, 0.25, 0.15);

        // 0.30 标题砸下
        if (this.title) {
            const b = this.base(this.title);
            this.title.setScale(Vec3.multiplyScalar(this._tmp, b.scale, 2.4));
            tween(this.op(this.title)).delay(0.3).to(0.12, { opacity: b.opacity }).start();
            tween(this.title).delay(0.3)
                .to(0.22, { scale: b.scale.clone() }, { easing: 'quadIn' })
                .call(() => {
                    this.shake(this.panel, 7, 0.25);
                    this.sparkBurst(this.title!, 12, 1.0);
                })
                .start();
        }

        // 0.35 光晕、光芒
        this.popIn(this.glow, 0.35, 0, 1, 0.4, 0, 'backOut');
        if (this.rays) {
            this.popIn(this.rays, 0.35, 0, 1, 0.5, 0, 'backOut');
            this.scheduleOnce(() => { this._raysOn = true; }, 0.35);
        }

        // 0.40 角色落下
        if (this.character) {
            const c = this.character, b = this.base(c);
            c.setPosition(b.pos.x, b.pos.y + 420, b.pos.z);
            this.op(c).opacity = b.opacity;
            tween(c).delay(0.4)
                .to(0.25, { position: b.pos.clone() }, { easing: 'quadIn' })
                .to(0.08, { scale: new Vec3(b.scale.x * 1.2, b.scale.y * 0.8, b.scale.z) }, { easing: 'quadOut' })
                .to(0.1, { scale: new Vec3(b.scale.x * 0.95, b.scale.y * 1.08, b.scale.z) }, { easing: 'quadOut' })
                .to(0.1, { scale: b.scale.clone() }, { easing: 'quadInOut' })
                .start();
            // 0.62 石头从角色身上弹出
            for (const [stone, dir] of [[this.stoneLeft, -1], [this.stoneRight, 1]] as [Node | null, number][]) {
                if (!stone) continue;
                const sb = this.base(stone);
                const from = stone.parent === c ? new Vec3(0, 0, 0) : b.pos.clone();
                stone.setPosition(from);
                stone.setScale(Vec3.multiplyScalar(new Vec3(), sb.scale, 0.3));
                stone.angle = sb.angle - 40 * dir;
                tween(this.op(stone)).delay(0.62).to(0.1, { opacity: sb.opacity }).start();
                tween(stone).delay(0.62)
                    .to(0.35, { position: sb.pos.clone(), scale: sb.scale.clone(), angle: sb.angle }, { easing: 'backOut' })
                    .start();
            }
        }

        // 0.60 彩纸炮
        this.scheduleOnce(() => this.fireConfetti(), 0.6);

        // 0.62 方块飞入
        this.flyIn(this.pieceLeft, 0.62, -260, 0, -200);
        this.flyIn(this.pieceRight, 0.66, 260, 0, 200);
        // 星星旋转弹出
        this.starPop(this.starRight, 0.68);
        this.starPop(this.starLeft, 0.74);
        // 右下角方块弹跳落下
        if (this.pieceCorner) {
            const n = this.pieceCorner, b = this.base(n);
            n.setPosition(b.pos.x, b.pos.y + 140, b.pos.z);
            n.setScale(b.scale);
            tween(this.op(n)).delay(0.75).to(0.1, { opacity: b.opacity }).start();
            tween(n).delay(0.75).to(0.45, { position: b.pos.clone() }, { easing: 'bounceOut' }).start();
        }
        // 小装饰
        this.decorations.forEach((d, i) => this.popIn(d, 0.7 + i * 0.05, 0, 1, 0.3, 0, 'backOut'));

        // 0.75 通关时间
        if (this.timeTitle) {
            const n = this.timeTitle, b = this.base(n);
            n.setPosition(b.pos.x - 40, b.pos.y, b.pos.z);
            n.setScale(b.scale);
            tween(this.op(n)).delay(0.75).to(0.2, { opacity: b.opacity }).start();
            tween(n).delay(0.75).to(0.25, { position: b.pos.clone() }, { easing: 'quadOut' }).start();
        }
        // 0.85 时间数字滚动
        if (this.timeValue) {
            const n = this.timeValue.node, b = this.base(n);
            n.setScale(b.scale);
            tween(this.op(n)).delay(0.85).to(0.15, { opacity: b.opacity }).start();
            const counter = { v: 0 };
            tween(counter).delay(0.85)
                .to(0.7, { v: seconds }, {
                    easing: 'quadOut',
                    onUpdate: () => { if (this.timeValue) this.timeValue.string = this.formatTime(counter.v); },
                })
                .call(() => {
                    if (!this.timeValue) return;
                    this.timeValue.string = this.formatTime(seconds);
                    tween(n).to(0.08, { scale: Vec3.multiplyScalar(new Vec3(), b.scale, 1.3) })
                        .to(0.18, { scale: b.scale.clone() }, { easing: 'backOut' }).start();
                    this.sparkBurst(n, 8, 0.7);
                })
                .start();
        }

        // 1.30 按钮
        this.buttons.forEach((btn, i) => this.popIn(btn, 1.3 + i * 0.08, 0, 1, 0.3, 0, 'backOut'));

        // 1.20 扫光；1.60 进入待机
        this.scheduleOnce(() => { this._shineT = 0; }, 1.2);
        return new Promise<void>(res => {
            this._showResolve = res;
            this.scheduleOnce(() => {
                this._idle = true; this._t = 0;
                const r = this._showResolve; this._showResolve = null; r && r();
            }, 1.6);
        });
    }

    /** 关闭动画，结束后隐藏节点 */
    hide(): Promise<void> {
        this.stopAll();
        this._idle = false;
        return new Promise<void>(res => {
            for (const n of this.allNodes()) {
                if (n === this.mask) continue;
                tween(this.op(n)).to(0.18, { opacity: 0 }).start();
            }
            if (this.panel) {
                const b = this.base(this.panel);
                tween(this.panel).to(0.2, { scale: Vec3.multiplyScalar(new Vec3(), b.scale, 0.7) }, { easing: 'backIn' }).start();
            }
            if (this.mask) tween(this.op(this.mask)).delay(0.1).to(0.18, { opacity: 0 }).start();
            this.scheduleOnce(() => {
                this._playing = false;
                this._confetti.length = 0;
                this._sparkles.length = 0;
                this._fx?.clear();
                this.restoreAll();
                this.node.active = false;
                res();
            }, 0.3);
        });
    }

    // ------------------------------------------------------------------

    update(dt: number) {
        if (!this._playing) return;
        this._t += dt;
        const t = this._t;

        // 光芒旋转
        if (this._raysOn && this.rays) this.rays.angle -= this.rayRotateSpeed * dt;

        // 待机动画
        if (this._idle) {
            this.idle(this.character, (n, b) => {
                const k = Math.sin(t * 2.2);
                n.setScale(b.scale.x * (1 - 0.012 * k), b.scale.y * (1 + 0.025 * k), b.scale.z);
            });
            this.idle(this.stoneLeft, (n, b) => n.setPosition(b.pos.x, b.pos.y + Math.sin(t * 2.2 + 0.8) * 3, b.pos.z));
            this.idle(this.stoneRight, (n, b) => n.setPosition(b.pos.x, b.pos.y + Math.sin(t * 2.2 + 2.0) * 3, b.pos.z));
            this.float(this.pieceLeft, t, 0, 6, 4);
            this.float(this.pieceRight, t, 1.3, 6, 4);
            this.float(this.pieceCorner, t, 2.1, 3, 0);
            this.decorations.forEach((d, i) => this.float(d, t, i * 0.9, 5, 12));
            for (const [s, ph] of [[this.starLeft, 0], [this.starRight, 1.7]] as [Node | null, number][]) {
                this.idle(s, (n, b) => {
                    const k = 1 + 0.08 * Math.sin(t * 3 + ph);
                    n.setScale(b.scale.x * k, b.scale.y * k, b.scale.z);
                    n.angle = b.angle + Math.sin(t * 1.6 + ph) * 8;
                });
            }
            this.idle(this.glow, (n, b) => { this.op(n).opacity = b.opacity * (0.8 + 0.2 * Math.sin(t * 2)); });

            // 星星周围随机闪光
            this._twinkleAcc += dt;
            if (this._twinkleAcc > 0.35) {
                this._twinkleAcc = 0;
                const pick = [this.starLeft, this.starRight, this.title, this.character].filter(n => !!n) as Node[];
                if (pick.length) this.sparkBurst(pick[(Math.random() * pick.length) | 0], 1, 1.2);
            }
        }

        // 扫光
        if (this._shineT >= 0 && this._shineMats.length) {
            this._shineT += dt;
            const cyc = this._shineT % this.shineInterval;
            const prog = cyc < 0.7 ? -0.3 + 1.6 * (cyc / 0.7) : -1;
            for (const s of this._shineMats) {
                const ut = s.sp.node.getComponent(UITransform);
                if (!ut) continue;
                const r = ut.getBoundingBoxToWorld();
                s.rect.set(r.x, r.y, r.width, r.height);
                s.params.x = prog;
                const mi = s.sp.getMaterialInstance(0);
                if (mi) {
                    mi.setProperty('shineRect', s.rect);
                    mi.setProperty('shineParams', s.params);
                }
            }
        }

        this.drawFx(dt);
    }

    // ---------------- 彩纸 & 闪星 ----------------

    private fireConfetti() {
        const colors = this.confettiColors.length ? this.confettiColors : DEFAULT_COLORS;
        let left = new Vec3(-200, 0, 0), right = new Vec3(200, 0, 0);
        if (this.panel) {
            const ut = this.panel.getComponent(UITransform);
            const w = (ut ? ut.width : 400) * 0.5, h = (ut ? ut.height : 200) * 0.5;
            left = this.toLocal(this.panel, new Vec3(-w, h, 0));
            right = this.toLocal(this.panel, new Vec3(w, h, 0));
        }
        const half = Math.floor(this.confettiCount / 2);
        for (let i = 0; i < this.confettiCount; i++) {
            const fromLeft = i < half;
            const o = fromLeft ? left : right;
            const ang = (fromLeft ? rand(55, 95) : rand(85, 125)) * Math.PI / 180;
            const sp = rand(700, 1300);
            this._confetti.push({
                x: o.x, y: o.y, vx: Math.cos(ang) * sp, vy: Math.sin(ang) * sp,
                rot: rand(0, Math.PI * 2), vr: rand(-8, 8), flip: rand(0, Math.PI * 2), vf: rand(6, 14),
                w: rand(9, 15), h: rand(5, 8), color: colors[(Math.random() * colors.length) | 0], age: 0, life: rand(2.6, 3.6),
                sway: rand(0, Math.PI * 2),
            });
        }
    }

    private sparkBurst(n: Node, count: number, spread: number) {
        const ut = n.getComponent(UITransform);
        const c = this.toLocal(n, new Vec3());
        const w = (ut ? ut.width * Math.abs(n.scale.x) : 100) * 0.5 * spread;
        const h = (ut ? ut.height * Math.abs(n.scale.y) : 100) * 0.5 * spread;
        for (let i = 0; i < count; i++) {
            this._sparkles.push({
                x: c.x + rand(-w, w), y: c.y + rand(-h, h), size: rand(10, 22), age: 0, life: rand(0.45, 0.8),
                rot: rand(0, Math.PI), vr: rand(-2, 2),
            });
        }
    }

    private drawFx(dt: number) {
        const g = this._fx;
        if (!g) return;
        g.clear();
        const bottom = -view.getVisibleSize().height * 0.5 - 60;

        for (let i = this._confetti.length - 1; i >= 0; i--) {
            const p = this._confetti[i];
            p.age += dt;
            const drag = Math.max(0, 1 - 1.6 * dt);
            p.vx *= drag;
            p.vy = p.vy * drag - 1500 * dt;
            if (p.vy < -380) p.vy = -380;                                   // 飘落限速
            p.x += (p.vx + Math.sin(p.age * 5 + p.sway) * 60) * dt;
            p.y += p.vy * dt;
            p.rot += p.vr * dt;
            p.flip += p.vf * dt;
            if (p.age >= p.life || p.y < bottom) { this._confetti.splice(i, 1); continue; }
            const alpha = Math.min(1, (p.life - p.age) / 0.5);
            const cf = Math.cos(p.flip);
            const hw = p.w * 0.5 * Math.max(0.15, Math.abs(cf)), hh = p.h * 0.5;
            const shade = cf < 0 ? 0.7 : 1;
            g.fillColor = tmpColor.set(p.color.r * shade, p.color.g * shade, p.color.b * shade, 255 * alpha);
            const cs = Math.cos(p.rot), sn = Math.sin(p.rot);
            g.moveTo(p.x + (-hw * cs - -hh * sn), p.y + (-hw * sn + -hh * cs));
            g.lineTo(p.x + (hw * cs - -hh * sn), p.y + (hw * sn + -hh * cs));
            g.lineTo(p.x + (hw * cs - hh * sn), p.y + (hw * sn + hh * cs));
            g.lineTo(p.x + (-hw * cs - hh * sn), p.y + (-hw * sn + hh * cs));
            g.close();
            g.fill();
        }

        for (let i = this._sparkles.length - 1; i >= 0; i--) {
            const s = this._sparkles[i];
            s.age += dt;
            if (s.age >= s.life) { this._sparkles.splice(i, 1); continue; }
            const k = s.age / s.life;
            const sc = Math.sin(Math.PI * k);
            s.rot += s.vr * dt;
            const R = s.size * sc, r = R * 0.28;
            g.fillColor = tmpColor.set(255, 250, 215, 255 * sc);
            for (let j = 0; j < 8; j++) {
                const a = s.rot + j * Math.PI / 4;
                const rr = j % 2 === 0 ? R : r;
                const x = s.x + Math.cos(a) * rr, y = s.y + Math.sin(a) * rr;
                if (j === 0) g.moveTo(x, y); else g.lineTo(x, y);
            }
            g.close();
            g.fill();
        }
    }

    // ---------------- 工具 ----------------

    private allNodes(): Node[] {
        const list = [
            this.mask, this.glow, this.rays, this.character, this.stoneLeft, this.stoneRight, this.panel, this.title,
            this.timeTitle, this.timeValue ? this.timeValue.node : null, this.starLeft, this.starRight,
            this.pieceLeft, this.pieceRight, this.pieceCorner, ...this.decorations, ...this.buttons,
        ];
        return list.filter(n => !!n) as Node[];
    }

    private base(n: Node) { return this._base.get(n)!; }

    private op(n: Node): UIOpacity {
        return n.getComponent(UIOpacity) || n.addComponent(UIOpacity);
    }

    private toLocal(n: Node, local: Vec3): Vec3 {
        const ut = n.getComponent(UITransform);
        const world = ut ? ut.convertToWorldSpaceAR(local) : n.worldPosition.clone();
        const rootUt = this.node.getComponent(UITransform);
        return rootUt ? rootUt.convertToNodeSpaceAR(world) : world;
    }

    private stopAll() {
        Tween.stopAllByTarget(this.node);
        for (const n of this.allNodes()) {
            Tween.stopAllByTarget(n);
            Tween.stopAllByTarget(this.op(n));
        }
        this.unscheduleAllCallbacks();
        const r = this._showResolve; this._showResolve = null; r && r();
    }

    private resetHidden() {
        for (const n of this.allNodes()) {
            const b = this.base(n);
            n.setPosition(b.pos);
            n.setScale(b.scale);
            n.angle = b.angle;
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

    /** 从 fromScale 弹到 peak 再回到原大小 */
    private popIn(n: Node | null, delay: number, fromScale: number, peak: number, t1: number, t2: number, ease: any = 'quadOut') {
        if (!n) return;
        const b = this.base(n);
        n.setScale(Vec3.multiplyScalar(this._tmp, b.scale, fromScale));
        tween(this.op(n)).delay(delay).to(Math.min(0.15, t1), { opacity: b.opacity }).start();
        let tw = tween(n).delay(delay).to(t1, { scale: Vec3.multiplyScalar(new Vec3(), b.scale, peak) }, { easing: ease });
        if (t2 > 0) tw = tw.to(t2, { scale: b.scale.clone() }, { easing: 'quadInOut' });
        tw.start();
    }

    private flyIn(n: Node | null, delay: number, dx: number, dy: number, spin: number) {
        if (!n) return;
        const b = this.base(n);
        n.setPosition(b.pos.x + dx, b.pos.y + dy, b.pos.z);
        n.setScale(b.scale);
        n.angle = b.angle + spin;
        tween(this.op(n)).delay(delay).to(0.12, { opacity: b.opacity }).start();
        tween(n).delay(delay).to(0.45, { position: b.pos.clone(), angle: b.angle }, { easing: 'backOut' }).start();
    }

    private starPop(n: Node | null, delay: number) {
        if (!n) return;
        const b = this.base(n);
        n.setScale(0, 0, 1);
        n.angle = b.angle - 180;
        tween(this.op(n)).delay(delay).to(0.1, { opacity: b.opacity }).start();
        tween(n).delay(delay)
            .to(0.3, { scale: Vec3.multiplyScalar(new Vec3(), b.scale, 1.3), angle: b.angle }, { easing: 'quadOut' })
            .to(0.15, { scale: b.scale.clone() }, { easing: 'quadInOut' })
            .call(() => this.sparkBurst(n, 4, 1.4))
            .start();
    }

    private shake(n: Node | null, amp: number, dur: number) {
        if (!n) return;
        const b = this.base(n);
        const steps = 6;
        let tw = tween(n);
        for (let i = 0; i < steps; i++) {
            const f = 1 - i / steps;
            tw = tw.to(dur / steps, { position: new Vec3(b.pos.x + rand(-amp, amp) * f, b.pos.y + rand(-amp, amp) * f, b.pos.z) });
        }
        tw.to(0.03, { position: b.pos.clone() }).start();
    }

    private idle(n: Node | null, fn: (n: Node, b: { pos: Vec3; scale: Vec3; angle: number; opacity: number }) => void) {
        if (n && n.isValid) fn(n, this.base(n));
    }

    private float(n: Node | null, t: number, phase: number, amp: number, rotAmp: number) {
        this.idle(n, (node, b) => {
            node.setPosition(b.pos.x, b.pos.y + Math.sin(t * 1.8 + phase) * amp, b.pos.z);
            node.angle = b.angle + Math.sin(t * 1.3 + phase) * rotAmp;
        });
    }
}

interface Confetti {
    x: number; y: number; vx: number; vy: number; rot: number; vr: number; flip: number; vf: number;
    w: number; h: number; color: Color; age: number; life: number; sway: number;
}
interface Sparkle { x: number; y: number; size: number; age: number; life: number; rot: number; vr: number; }

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const tmpColor = new Color();
const DEFAULT_COLORS = [
    new Color(255, 205, 60), new Color(255, 140, 50), new Color(235, 70, 70),
    new Color(90, 200, 100), new Color(70, 160, 255), new Color(255, 130, 190),
];
