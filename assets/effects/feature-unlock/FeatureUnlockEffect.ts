import {
    _decorator, Component, Node, Label, UIOpacity, UITransform, Vec3, Color,
    tween, Graphics,
} from 'cc';
const { ccclass, property } = _decorator;

/**
 * 主菜单功能解锁特效：无尽模式 / 闭眼模式 / 排行榜（Cocos Creator 3.8.x，2D UI）
 *
 * 流程（默认约 2.4 秒）：
 *   0.00  聚能：按钮周围亮起主题色光环，光点从四周向锁头汇聚，锁头越抖越厉害
 *   0.75  破锁：锁头碎成 8 块向外飞散（带重力和旋转），白色闪光 + 两圈冲击波，调用 onUnlocked
 *   0.80  按钮弹出：先压扁再放大回弹，同时播放主题特效
 *           endless     蓝色光带沿「∞」轨迹绕按钮画两圈，沿途洒星光
 *           blind       紫色眼睛：闭眼线 → 睁开 → 眨一下，四周升起紫雾和星星
 *           leaderboard 金色光芒放射 + 金星喷泉 + 彩带从上方飘落
 *   0.95  按钮上方弹出提示文字（如「无尽模式已解锁！」），停留后上飘淡出
 *   之后  按钮外圈呼吸光环脉冲两次，特效结束
 *
 * 节点：建一个铺满屏幕的空节点，放在主菜单按钮之上，挂本脚本即可（不需要子节点，不挡点击）。
 * 约定：脚本只用自己创建的节点画特效。锁头播放期间透明度会降为 0，在 onUnlocked 之后恢复原值，
 *       所以请在 onUnlocked 里把锁头隐藏 / 把按钮切到已解锁状态。按钮缩放动画结束后恢复原缩放。
 *
 * 用法：
 *   await this.unlockFx.play({
 *       button: this.endlessBtn,
 *       lock:   this.endlessLockIcon,          // 可空
 *       theme:  'endless',                      // 'endless' | 'blind' | 'leaderboard'
 *       title:  '无尽模式已解锁！',              // 可空，多语言文案由宿主传入
 *       onUnlocked: () => this.setEndlessUnlocked(true),
 *   });
 */

export type UnlockTheme = 'endless' | 'blind' | 'leaderboard';

export interface FeatureUnlockOptions {
    /** 被解锁的按钮 */
    button: Node;
    /** 按钮上的锁头图标（可空；为空时在按钮中心画一个锁的碎片效果） */
    lock?: Node | null;
    /** 主题 */
    theme: UnlockTheme;
    /** 提示文字（可空） */
    title?: string;
    /** 主题色，覆盖默认（endless 蓝 / blind 紫 / leaderboard 金） */
    color?: Color;
    /** 聚能时长，默认 0.75 秒 */
    chargeTime?: number;
    /** 锁破碎的瞬间调用：在这里隐藏锁头、切换按钮为已解锁 */
    onUnlocked?: () => void;
}

interface P { kind: 0 | 1 | 2; x: number; y: number; vx: number; vy: number; age: number; life: number; size: number; rot: number; vr: number; drag: number; grav: number; color: Color; tx?: number; ty?: number; }
interface Ring { x: number; y: number; age: number; life: number; r0: number; r1: number; w: number; color: Color; }
interface Flash { x: number; y: number; age: number; life: number; r: number; }
interface Shard { pts: number[]; x: number; y: number; vx: number; vy: number; rot: number; vr: number; age: number; life: number; color: Color; }
interface Ribbon { pts: { x: number; y: number; t: number }[]; }

const WHITE = new Color(255, 255, 255, 255);
const LOCK_GOLD = new Color(250, 196, 70, 255);
const LOCK_DARK = new Color(120, 80, 30, 255);
const THEME: Record<UnlockTheme, Color> = {
    endless: new Color(90, 190, 255, 255),
    blind: new Color(186, 120, 255, 255),
    leaderboard: new Color(255, 206, 70, 255),
};
const CONFETTI = [new Color(255, 90, 90), new Color(255, 206, 70), new Color(110, 220, 120), new Color(90, 190, 255), new Color(200, 120, 255)];

@ccclass('FeatureUnlockEffect')
export class FeatureUnlockEffect extends Component {

    @property({ tooltip: '提示文字字号' }) titleFontSize = 46;
    @property({ tooltip: '提示文字颜色' }) titleColor = new Color(255, 240, 160, 255);
    @property({ tooltip: '提示文字描边颜色' }) titleOutline = new Color(60, 30, 80, 255);
    @property({ tooltip: '提示文字停留时间（秒）' }) titleHold = 1.2;
    @property({ tooltip: '整体特效大小倍数' }) fxScale = 1.0;

    // -------------------------------------------------------------
    private _back: Graphics | null = null;
    private _front: Graphics | null = null;
    private _ps: P[] = [];
    private _rings: Ring[] = [];
    private _flashes: Flash[] = [];
    private _shards: Shard[] = [];
    private _jobs: Job[] = [];

    onLoad() { this.ensureLayers(); }

    /** 播放一次解锁，特效全部结束后 resolve。可同时播放多个。 */
    async play(o: FeatureUnlockOptions): Promise<void> {
        const btn = o.button;
        if (!btn || !btn.isValid) return;
        this.node.active = true;
        this.ensureLayers();
        const col = o.color || THEME[o.theme] || THEME.endless;
        const k = this.fxScale;
        const lock = o.lock && o.lock.isValid ? o.lock : null;
        const job: Job = {
            theme: o.theme, color: col, btn, lock,
            center: () => this.toLocal(btn), lockPos: () => this.toLocal(lock && lock.isValid ? lock : btn),
            w: this.sizeOf(btn).x, h: this.sizeOf(btn).y, age: 0, phase: 0,
            charge: o.chargeTime ?? 0.75, shake: 0, glow: 0, ribbon: { pts: [] }, eye: -1, breathe: -1,
        };
        this._jobs.push(job);

        // ---------- 1. 聚能 ----------
        tween(job).to(0.25, { glow: 1 }).start();
        const lockBase = lock ? { angle: lock.angle, pos: lock.position.clone(), scale: lock.scale.clone() } : null;
        const lockOp = lock ? this.op(lock) : null;
        const lockOpBase = lockOp ? lockOp.opacity : 255;
        tween(job).to(job.charge, { shake: 1 }, { easing: 'quadIn' }).start();
        await this.wait(job.charge);

        // ---------- 2. 破锁 ----------
        const lp = job.lockPos();
        const lr = lock ? Math.max(this.sizeOf(lock).x, this.sizeOf(lock).y) * 0.5 : Math.min(job.w, job.h) * 0.3;
        job.shake = 0;
        if (lock && lockBase) { lock.setPosition(lockBase.pos); lock.angle = lockBase.angle; lock.setScale(lockBase.scale); }
        if (lockOp) lockOp.opacity = 0;
        this.breakLock(lp.x, lp.y, lr);
        this._flashes.push({ x: lp.x, y: lp.y, age: 0, life: 0.3, r: lr * 3 * k });
        this._rings.push({ x: lp.x, y: lp.y, age: 0, life: 0.45, r0: lr, r1: lr * 4 * k, w: 9, color: WHITE });
        this._rings.push({ x: lp.x, y: lp.y, age: -0.05, life: 0.6, r0: lr * 1.2, r1: lr * 5.5 * k, w: 6, color: col });
        try { o.onUnlocked?.(); } catch (e) { console.error(e); }
        if (lock && lock.isValid && lockOp && lockOp.isValid) lockOp.opacity = lockOpBase;

        // ---------- 3. 按钮弹出 + 主题特效 ----------
        this.punch(btn);
        this.themeBurst(job);
        if (o.title) this.scheduleOnce(() => this.floatTitle(job, o.title!), 0.15);

        await this.wait(1.0);
        // ---------- 4. 呼吸光环 ----------
        job.breathe = 0;
        await this.wait(0.9);
        tween(job).to(0.3, { glow: 0 }).start();
        await this.wait(0.35);
        this._jobs.splice(this._jobs.indexOf(job), 1);
    }

    // ================= 内部 =================

    private ensureLayers() {
        if (!this._back) this._back = this.makeLayer('UnlockFxBack');
        if (!this._front) this._front = this.makeLayer('UnlockFxFront');
        this._back.node.setSiblingIndex(0);
        this._front.node.setSiblingIndex(this.node.children.length - 1);
    }
    private makeLayer(name: string): Graphics {
        const n = new Node(name); n.layer = this.node.layer; n.addComponent(UITransform);
        this.node.addChild(n); return n.addComponent(Graphics);
    }
    private op(n: Node): UIOpacity { return n.getComponent(UIOpacity) || n.addComponent(UIOpacity); }
    private wait(s: number) { return new Promise<void>(r => this.scheduleOnce(() => r(), s)); }
    private toLocal(n: Node): Vec3 {
        const ut = this.node.getComponent(UITransform);
        return ut ? ut.convertToNodeSpaceAR(n.worldPosition) : n.worldPosition.clone();
    }
    private sizeOf(n: Node): Vec3 {
        const ut = n.getComponent(UITransform);
        const s = Math.abs(n.worldScale.x) / Math.max(1e-4, Math.abs(this.node.worldScale.x));
        return ut ? new Vec3(ut.width * s, ut.height * s, 0) : new Vec3(200 * s, 80 * s, 0);
    }

    /** 按钮先压扁再放大回弹（代理驱动，节点失效自动跳过，结束恢复原缩放） */
    private punch(n: Node) {
        const st = n as any;
        if (st.__fuTw) st.__fuTw.stop();
        const base: Vec3 = st.__fuBase || n.scale.clone(); st.__fuBase = base;
        const p = { x: 1, y: 1 };
        const apply = () => { if (n.isValid) n.setScale(base.x * p.x, base.y * p.y, base.z); };
        st.__fuTw = tween(p)
            .to(0.08, { x: 1.18, y: 0.82 }, { easing: 'quadOut', onUpdate: apply })
            .to(0.14, { x: 0.9, y: 1.22 }, { easing: 'quadOut', onUpdate: apply })
            .to(0.35, { x: 1, y: 1 }, { easing: 'elasticOut', onUpdate: apply })
            .call(() => { if (n.isValid) n.setScale(base); st.__fuBase = undefined; st.__fuTw = null; })
            .start();
    }

    private breakLock(x: number, y: number, r: number) {
        const n = 8;
        for (let i = 0; i < n; i++) {
            const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
            const rr = r * rand(0.8, 1.1);
            const pts = [0, 0, Math.cos(a0) * rr, Math.sin(a0) * rr, Math.cos((a0 + a1) / 2) * rr * 1.1, Math.sin((a0 + a1) / 2) * rr * 1.1, Math.cos(a1) * rr, Math.sin(a1) * rr];
            const am = (a0 + a1) / 2, sp = rand(350, 650) * this.fxScale;
            this._shards.push({ pts, x, y, vx: Math.cos(am) * sp, vy: Math.sin(am) * sp + 250, rot: 0, vr: rand(-10, 10), age: 0, life: rand(0.7, 1.0), color: i % 3 === 0 ? LOCK_DARK : LOCK_GOLD });
        }
        for (let i = 0; i < 16; i++) {
            const a = Math.random() * Math.PI * 2, sp = rand(200, 520);
            this.add(0, x, y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.4, 0.75), rand(9, 18), i % 2 ? WHITE : LOCK_GOLD, 3.5, -200);
        }
    }

    private themeBurst(j: Job) {
        const c = j.center(), col = j.color, k = this.fxScale;
        if (j.theme === 'endless') {
            j.ribbon.pts.length = 0; j.ribbonT = 0;
            tween(j).to(0.9, { ribbonT: 2 }, { easing: 'sineInOut' }).start();
        } else if (j.theme === 'blind') {
            j.eye = 0;
            tween(j).to(1.1, { eye: 1 }).call(() => { j.eye = -1; }).start();
            for (let i = 0; i < 18; i++) {
                const x = c.x + rand(-j.w * 0.55, j.w * 0.55);
                this.add(2, x, c.y - j.h * 0.3, rand(-20, 20), rand(60, 150) * k, rand(0.8, 1.4), rand(14, 28) * k, col, 1, 0);
            }
            for (let i = 0; i < 10; i++) {
                const a = Math.random() * Math.PI * 2, sp = rand(150, 380) * k;
                this.add(0, c.x, c.y, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.5, 0.9), rand(9, 16), i % 2 ? WHITE : col, 3, 0);
            }
        } else {
            j.rays = 0;
            tween(j).to(0.25, { rays: 1 }, { easing: 'backOut' }).delay(0.6).to(0.35, { rays: 0 }).start();
            for (let i = 0; i < 22; i++) {
                const a = Math.PI / 2 + rand(-0.75, 0.75), sp = rand(450, 800) * k;
                this.add(0, c.x + rand(-20, 20), c.y + j.h * 0.2, Math.cos(a) * sp, Math.sin(a) * sp, rand(0.8, 1.2), rand(10, 20), i % 3 ? col : WHITE, 1.2, -900 * k);
            }
            for (let i = 0; i < 40; i++) {
                const x = c.x + rand(-j.w * 1.2, j.w * 1.2);
                this.add(1, x, c.y + j.h * rand(1.5, 3.5), rand(-40, 40), rand(-120, -60), rand(1.2, 1.9), rand(8, 13), CONFETTI[i % CONFETTI.length], 0.8, -160);
            }
        }
    }

    private floatTitle(j: Job, text: string) {
        const c = j.center();
        const n = new Node('UnlockTitle'); n.layer = this.node.layer; n.addComponent(UITransform);
        const lb = n.addComponent(Label);
        lb.string = text; lb.fontSize = this.titleFontSize; lb.lineHeight = this.titleFontSize * 1.15; lb.isBold = true; lb.color = this.titleColor;
        const a = lb as any;
        if ('enableOutline' in a) { a.enableOutline = true; a.outlineColor = this.titleOutline; a.outlineWidth = 4; }
        if ('enableShadow' in a) { a.enableShadow = true; a.shadowColor = new Color(0, 0, 0, 150); a.shadowOffset = { x: 0, y: -3 }; }
        this.node.addChild(n);
        this._front!.node.setSiblingIndex(this.node.children.length - 1);
        const y0 = c.y + j.h * 0.5 + this.titleFontSize * 0.9;
        n.setPosition(c.x, y0, 0); n.setScale(0, 0, 1);
        const op = this.op(n);
        tween(n).to(0.18, { scale: new Vec3(1.25, 1.25, 1) }, { easing: 'backOut' }).to(0.12, { scale: new Vec3(1, 1, 1) })
            .delay(this.titleHold).by(0.45, { position: new Vec3(0, 50, 0) }, { easing: 'sineIn' }).start();
        tween(op).delay(0.3 + this.titleHold).to(0.45, { opacity: 0 }).call(() => n.destroy()).start();
        for (let i = 0; i < 6; i++) this.add(0, c.x + rand(-140, 140), y0 + rand(-25, 25), 0, 0, rand(0.4, 0.7), rand(9, 15), i % 2 ? WHITE : this.titleColor, 0, 0);
    }

    private add(kind: 0 | 1 | 2, x: number, y: number, vx: number, vy: number, life: number, size: number, color: Color, drag: number, grav: number) {
        this._ps.push({ kind, x, y, vx, vy, age: 0, life, size, rot: rand(0, Math.PI), vr: rand(-6, 6), drag, grav, color });
    }

    update(dt: number) {
        for (const j of this._jobs) this.tickJob(j, dt);
        this.draw(dt);
    }

    private tickJob(j: Job, dt: number) {
        j.age += dt;
        const c = j.center();
        // 聚能：锁头抖动 + 光点汇聚
        if (j.shake > 0 && j.lock && j.lock.isValid) {
            const s = j.shake;
            const st = j.lock as any;
            if (!st.__fuLock) st.__fuLock = { pos: j.lock.position.clone(), angle: j.lock.angle };
            const b = st.__fuLock;
            j.lock.setPosition(b.pos.x + rand(-1, 1) * 6 * s, b.pos.y + rand(-1, 1) * 4 * s, b.pos.z);
            j.lock.angle = b.angle + Math.sin(j.age * 60) * 14 * s;
        } else if (j.lock && j.lock.isValid && (j.lock as any).__fuLock) {
            const b = (j.lock as any).__fuLock; j.lock.setPosition(b.pos); j.lock.angle = b.angle; (j.lock as any).__fuLock = undefined;
        }
        if (j.shake > 0 && j.shake < 1) {
            const lp = j.lockPos();
            const n = Math.random() < dt * 50 ? 1 : 0;
            for (let i = 0; i < n; i++) {
                const a = Math.random() * Math.PI * 2, d = Math.max(j.w, j.h) * rand(0.8, 1.3);
                const x = lp.x + Math.cos(a) * d, y = lp.y + Math.sin(a) * d;
                const t = rand(0.3, 0.45);
                this._ps.push({ kind: 2, x, y, vx: (lp.x - x) / t, vy: (lp.y - y) / t, age: 0, life: t, size: rand(5, 10), rot: 0, vr: 0, drag: 0, grav: 0, color: Math.random() < 0.3 ? WHITE : j.color });
            }
        }
        // ∞ 光带
        if (j.theme === 'endless' && j.ribbonT !== undefined && j.ribbonT > 0 && j.ribbonT < 2.001) {
            const ax = j.w * 0.62 * this.fxScale, ay = j.h * 0.85 * this.fxScale;
            const t = j.ribbonT * Math.PI * 2;
            const den = 1 + Math.sin(t) ** 2;
            const x = c.x + ax * Math.cos(t) / den, y = c.y + ay * Math.sin(t) * Math.cos(t) / den * 1.4;
            j.ribbon.pts.push({ x, y, t: j.age });
            if (Math.random() < 0.6) this.add(0, x, y, rand(-40, 40), rand(-40, 40), rand(0.35, 0.6), rand(7, 13), Math.random() < 0.4 ? WHITE : j.color, 2, 0);
            if (j.ribbonT >= 1.999) j.ribbonT = 3;
        }
        while (j.ribbon.pts.length && j.age - j.ribbon.pts[0].t > 0.35) j.ribbon.pts.shift();
        // 呼吸光环
        if (j.breathe >= 0) {
            j.breathe += dt;
            if (j.breathe > 0 && Math.floor((j.breathe - dt) / 0.45) !== Math.floor(j.breathe / 0.45) && j.breathe < 0.95) {
                const r = Math.max(j.w, j.h) * 0.55;
                this._rings.push({ x: c.x, y: c.y, age: 0, life: 0.6, r0: r, r1: r * 1.6, w: 6, color: j.color });
            }
        }
    }

    private draw(dt: number) {
        const gb = this._back!, gf = this._front!;
        gb.clear(); gf.clear();

        for (const j of this._jobs) {
            const c = j.center();
            // 按钮外圈光晕（圆角矩形逐层扩散）
            if (j.glow > 0.01) {
                const pulse = 0.75 + 0.25 * Math.sin(j.age * 6) + j.shake * 0.4;
                for (let i = 4; i >= 1; i--) {
                    const pad = i * 9 * this.fxScale;
                    gb.fillColor = alpha(j.color, 0.09 * j.glow * pulse);
                    gb.roundRect(c.x - j.w / 2 - pad, c.y - j.h / 2 - pad, j.w + pad * 2, j.h + pad * 2, j.h * 0.3 + pad);
                    gb.fill();
                }
            }
            // 排行榜：背后金色光芒
            if (j.theme === 'leaderboard' && j.rays && j.rays > 0.01) {
                const R = Math.max(j.w, j.h) * 1.6 * j.rays * this.fxScale, n = 16, rot = j.age * 0.8;
                for (let i = 0; i < n; i++) {
                    const a = rot + i / n * Math.PI * 2, w = Math.PI / n * 0.5, L = R * (i % 2 ? 0.7 : 1);
                    gb.fillColor = alpha(j.color, (i % 2 ? 0.16 : 0.26) * Math.min(1, j.rays));
                    gb.moveTo(c.x, c.y); gb.lineTo(c.x + Math.cos(a - w) * L, c.y + Math.sin(a - w) * L); gb.lineTo(c.x + Math.cos(a + w) * L, c.y + Math.sin(a + w) * L); gb.close(); gb.fill();
                }
            }
            // ∞ 光带（尾部渐细渐淡）
            const pts = j.ribbon.pts;
            for (let i = 1; i < pts.length; i++) {
                const f = i / pts.length;
                gf.lineWidth = 2 + 12 * f * this.fxScale;
                gf.strokeColor = alpha(j.color, 0.25 + 0.6 * f);
                gf.moveTo(pts[i - 1].x, pts[i - 1].y); gf.lineTo(pts[i].x, pts[i].y); gf.stroke();
                if (f > 0.6) {
                    gf.lineWidth = (2 + 12 * f) * 0.35 * this.fxScale; gf.strokeColor = alpha(WHITE, 0.8 * f);
                    gf.moveTo(pts[i - 1].x, pts[i - 1].y); gf.lineTo(pts[i].x, pts[i].y); gf.stroke();
                }
            }
            // 闭眼 → 睁眼 → 眨眼
            if (j.theme === 'blind' && j.eye >= 0) this.drawEye(gf, j, c);
        }

        // 冲击波
        for (let i = this._rings.length - 1; i >= 0; i--) {
            const r = this._rings[i]; r.age += dt; if (r.age < 0) continue;
            const t = r.age / r.life; if (t >= 1) { this._rings.splice(i, 1); continue; }
            const e = 1 - Math.pow(1 - t, 3);
            gf.lineWidth = Math.max(1, r.w * (1 - t)); gf.strokeColor = alpha(r.color, 0.9 * (1 - t));
            gf.circle(r.x, r.y, r.r0 + (r.r1 - r.r0) * e); gf.stroke();
        }
        // 闪光
        for (let i = this._flashes.length - 1; i >= 0; i--) {
            const f = this._flashes[i]; f.age += dt; const t = f.age / f.life;
            if (t >= 1) { this._flashes.splice(i, 1); continue; }
            const a = (1 - t) * (1 - t);
            for (let k = 3; k >= 1; k--) { gf.fillColor = new Color(255, 252, 240, Math.round(255 * a * (0.12 + 0.2 * k / 3))); gf.circle(f.x, f.y, f.r * (0.4 + 0.6 * t) * k / 3); gf.fill(); }
        }
        // 锁碎片
        for (let i = this._shards.length - 1; i >= 0; i--) {
            const s = this._shards[i]; s.age += dt; const t = s.age / s.life;
            if (t >= 1) { this._shards.splice(i, 1); continue; }
            s.vx *= Math.exp(-1.5 * dt); s.vy = s.vy * Math.exp(-1.5 * dt) - 1400 * dt;
            s.x += s.vx * dt; s.y += s.vy * dt; s.rot += s.vr * dt;
            const cs = Math.cos(s.rot), sn = Math.sin(s.rot), sc = 1 - t * 0.4;
            gf.fillColor = alpha(s.color, 1 - t * t);
            for (let k = 0; k < s.pts.length; k += 2) {
                const px = s.pts[k] * sc, py = s.pts[k + 1] * sc;
                const x = s.x + px * cs - py * sn, y = s.y + px * sn + py * cs;
                if (k === 0) gf.moveTo(x, y); else gf.lineTo(x, y);
            }
            gf.close(); gf.fill();
            gf.lineWidth = 2; gf.strokeColor = alpha(LOCK_DARK, 1 - t); gf.stroke();
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
                gf.fillColor = alpha(p.color, al); star4(gf, p.x, p.y, s, p.rot); gf.fill();
            } else if (p.kind === 1) {
                // 彩带：翻转的小长方形
                const w = p.size, h = p.size * 0.5 * Math.abs(Math.cos(p.age * 9 + p.rot));
                const cs = Math.cos(p.rot), sn = Math.sin(p.rot);
                gf.fillColor = alpha(p.color, Math.min(1, al * 1.5));
                const q = [[-w, -h], [w, -h], [w, h], [-w, h]];
                q.forEach(([x, y], k) => { const X = p.x + (x * cs - y * sn) * 0.5, Y = p.y + (x * sn + y * cs) * 0.5; if (k) gf.lineTo(X, Y); else gf.moveTo(X, Y); });
                gf.close(); gf.fill();
            } else {
                const s = p.size * (1 - t * 0.5);
                gf.fillColor = alpha(p.color, 0.35 * al); gf.circle(p.x, p.y, s * 1.8); gf.fill();
                gf.fillColor = alpha(WHITE, 0.85 * al); gf.circle(p.x, p.y, s * 0.5); gf.fill();
            }
        }
    }

    /** 眼睛：0~0.35 闭眼线变成睁开的眼；0.55~0.75 眨一下；之后淡出 */
    private drawEye(g: Graphics, j: Job, c: Vec3) {
        const t = j.eye;
        let open: number;
        if (t < 0.35) open = easeOut(t / 0.35);
        else if (t < 0.55) open = 1;
        else if (t < 0.65) open = 1 - (t - 0.55) / 0.1;
        else if (t < 0.75) open = (t - 0.65) / 0.1;
        else open = 1;
        const fade = t > 0.8 ? 1 - (t - 0.8) / 0.2 : Math.min(1, t / 0.1);
        const W = Math.min(j.w, j.h * 2.2) * 0.75 * this.fxScale, H = W * 0.42 * open;
        const cy = c.y + j.h * 0.5 + W * 0.45;   // 眼睛画在按钮上方
        const col = j.color;
        // 眼白
        g.fillColor = alpha(WHITE, 0.92 * fade);
        eyeShape(g, c.x, cy, W, H); g.fill();
        // 瞳孔（随睁眼出现）
        if (open > 0.3) {
            const pr = Math.min(H * 0.85, W * 0.2);
            g.fillColor = alpha(col, fade); g.circle(c.x, cy, pr); g.fill();
            g.fillColor = alpha(new Color(40, 20, 70), fade); g.circle(c.x, cy, pr * 0.5); g.fill();
            g.fillColor = alpha(WHITE, fade); g.circle(c.x + pr * 0.35, cy + pr * 0.35, pr * 0.22); g.fill();
        }
        // 轮廓 / 闭眼线
        g.lineWidth = 6 * this.fxScale; g.strokeColor = alpha(col, fade);
        eyeShape(g, c.x, cy, W, Math.max(H, 1)); g.stroke();
        // 睫毛
        g.lineWidth = 4 * this.fxScale;
        for (let i = -2; i <= 2; i++) {
            const x = c.x + i * W * 0.17, y = cy + (open < 0.15 ? -H : H) * 0.9 * (1 - (i * i) / 8);
            const dir = open < 0.15 ? -1 : 1;
            g.moveTo(x, y); g.lineTo(x + i * 4, y + dir * 14 * this.fxScale); g.stroke();
        }
    }
}

interface Job {
    theme: UnlockTheme; color: Color; btn: Node; lock: Node | null;
    center: () => Vec3; lockPos: () => Vec3; w: number; h: number;
    age: number; phase: number; charge: number; shake: number; glow: number;
    ribbon: Ribbon; ribbonT?: number; eye: number; rays?: number; breathe: number;
}

function rand(a: number, b: number) { return a + Math.random() * (b - a); }
function easeOut(t: number) { return 1 - (1 - t) * (1 - t); }
function alpha(c: Color, a: number) { return new Color(c.r, c.g, c.b, Math.max(0, Math.min(255, Math.round(255 * a)))); }
function star4(g: Graphics, x: number, y: number, s: number, rot: number) {
    for (let i = 0; i < 8; i++) {
        const a = rot + i * Math.PI / 4, r = i % 2 === 0 ? s : s * 0.3;
        const px = x + Math.cos(a) * r, py = y + Math.sin(a) * r;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
    }
    g.close();
}
function eyeShape(g: Graphics, x: number, y: number, w: number, h: number) {
    g.moveTo(x - w / 2, y);
    g.quadraticCurveTo(x, y + h * 2, x + w / 2, y);
    g.quadraticCurveTo(x, y - h * 2, x - w / 2, y);
    g.close();
}
