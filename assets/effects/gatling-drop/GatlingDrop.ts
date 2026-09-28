import {
    _decorator, Component, Node, MeshRenderer, Material, EffectAsset, Color, Vec3, Vec4, Quat, Mesh,
    Camera, director, utils, primitives, screen,
} from 'cc';
const { ccclass } = _decorator;

function meshUtils(): any { const u: any = utils; return u.MeshUtils || u; }

/** 动态网格批次：光带和朝向摄像机的四边形都用它 */
class DynBatch {
    private mesh: Mesh;
    private mr: MeshRenderer;
    private pos: Float32Array; private uv: Float32Array; private col: Float32Array; private idx: Uint16Array;
    private nv = 0; private ni = 0;
    private min = new Vec3(); private max = new Vec3();

    constructor(parent: Node, name: string, private maxV: number, private maxI: number, mat: Material) {
        const node = new Node(name);
        node.layer = parent.layer;
        parent.addChild(node);
        this.pos = new Float32Array(maxV * 3);
        this.uv = new Float32Array(maxV * 2);
        this.col = new Float32Array(maxV * 4);
        this.idx = new Uint16Array(maxI);
        const geo: any = {
            positions: new Float32Array(12), uvs: new Float32Array(8), colors: new Float32Array(16),
            indices16: new Uint16Array([0, 1, 2, 0, 2, 3]),
            minPos: new Vec3(-1, -1, -1), maxPos: new Vec3(1, 1, 1),
        };
        this.mesh = meshUtils().createDynamicMesh(0, geo, undefined, {
            maxSubMeshes: 1, maxSubMeshVertices: maxV, maxSubMeshIndices: maxI,
        });
        this.mr = node.addComponent(MeshRenderer);
        this.mr.mesh = this.mesh;
        this.mr.setSharedMaterial(mat, 0);
    }

    get vertexCount() { return this.nv; }
    get indexCount() { return this.ni; }

    begin() {
        this.nv = 0; this.ni = 0;
        this.min.set(Infinity, Infinity, Infinity);
        this.max.set(-Infinity, -Infinity, -Infinity);
    }

    canAdd(v: number, i: number) { return this.nv + v <= this.maxV && this.ni + i <= this.maxI; }

    vtx(x: number, y: number, z: number, u: number, v: number, r: number, g: number, b: number, a: number): number {
        const n = this.nv++;
        this.pos[n * 3] = x; this.pos[n * 3 + 1] = y; this.pos[n * 3 + 2] = z;
        this.uv[n * 2] = u; this.uv[n * 2 + 1] = v;
        this.col[n * 4] = r; this.col[n * 4 + 1] = g; this.col[n * 4 + 2] = b; this.col[n * 4 + 3] = a;
        const mn = this.min, mx = this.max;
        if (x < mn.x) mn.x = x; if (y < mn.y) mn.y = y; if (z < mn.z) mn.z = z;
        if (x > mx.x) mx.x = x; if (y > mx.y) mx.y = y; if (z > mx.z) mx.z = z;
        return n;
    }

    tri(a: number, b: number, c: number) {
        this.idx[this.ni++] = a; this.idx[this.ni++] = b; this.idx[this.ni++] = c;
    }

    quad(p: Vec3, size: number, right: Vec3, up: Vec3, r: number, g: number, b: number, a: number) {
        if (a <= 0.001 || !this.canAdd(4, 6)) return;
        const base = this.nv;
        for (let c = 0; c < 4; c++) {
            const sx = (c === 1 || c === 2) ? 1 : -1;
            const sy = c >= 2 ? 1 : -1;
            this.vtx(
                p.x + (right.x * sx + up.x * sy) * size,
                p.y + (right.y * sx + up.y * sy) * size,
                p.z + (right.z * sx + up.z * sy) * size,
                sx * 0.5 + 0.5, sy * 0.5 + 0.5, r, g, b, a,
            );
        }
        this.tri(base, base + 1, base + 2);
        this.tri(base, base + 2, base + 3);
    }

    commit() {
        if (this.nv < 3 || this.ni < 3) {   // 空批次：提交一个看不见的三角形
            this.begin();
            this.vtx(0, 0, 0, 0, 0, 0, 0, 0, 0); this.vtx(0, 0, 0, 0, 0, 0, 0, 0, 0); this.vtx(0, 0, 0, 0, 0, 0, 0, 0, 0);
            this.tri(0, 1, 2);
            this.min.set(-1, -1, -1); this.max.set(1, 1, 1);
        }
        const geo: any = {
            positions: this.pos.subarray(0, this.nv * 3), uvs: this.uv.subarray(0, this.nv * 2),
            colors: this.col.subarray(0, this.nv * 4), indices16: this.idx.subarray(0, this.ni),
            minPos: this.min, maxPos: this.max,
        };
        (this.mesh as any).updateSubMesh(0, geo);
        const m: any = this.mr;
        if (m.onGeometryChanged) m.onGeometryChanged();
    }
}


export interface GatlingDropOptions {
    /** 要打的目标方块，按顺序一颗一颗打；同一个方块可以出现多次 */
    targets: Node[];
    /** gatling-drop.effect */
    effect: EffectAsset;
    /** 方块边长（世界单位），默认 0.62 */
    blockSize?: number;
    /** 子弹大小（相对方块边长），默认 0.45 */
    bulletScale?: number;
    /** 两发之间的间隔（秒），默认 0.07 */
    interval?: number;
    /** 每颗子弹飞行时间（秒），默认 0.26 */
    flightTime?: number;
    /** 子弹从多远的地方射来（世界单位），默认 8 */
    distance?: number;
    /** 子弹来向：从正上方偏向镜头多少（0 = 垂直落下，1 = 45°），默认 0.35 */
    towardCamera?: number;
    /** 取目标方块颜色；不传时尝试读取目标材质的 mainColor / albedo */
    colorOf?: (target: Node, index: number) => Color;
    /** 每发命中时的回调 */
    onHit?: (target: Node, index: number) => void;
    /** 主摄像机（光带朝向、震屏用），默认自动查找能看到目标的透视摄像机 */
    cameraNode?: Node;
    /** 每发命中的震屏幅度（世界单位），0 关闭，默认 0.03 */
    shake?: number;
    /** 光带在屏幕上最少多少像素宽，默认 6 */
    minTrailPixels?: number;
}

interface TrailPoint { pos: Vec3; t: number; }
interface Bullet {
    index: number; target: Node; start: Vec3; end: Vec3; dir: Vec3; t0: number; hit: boolean;
    color: Color; lin: number[]; node: Node; unlit: Material; shellNode: Node; shellMat: Material;
    spinAxis: Vec3; spin: number; trail: TrailPoint[]; pos: Vec3;
}
interface Spark { pos: Vec3; vel: Vec3; age: number; life: number; size: number; r: number; g: number; b: number; white: number; gravity: number; }
interface Ring { pos: Vec3; start: number; life: number; from: number; to: number; alpha: number; r: number; g: number; b: number; }
interface Punch { node: Node; start: number; dir: Vec3; }

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const toLinear = (c: number) => Math.pow(c / 255, 2.2);
const TRAIL_LIFE = 0.12;

/** 读取方块颜色：mainColor / albedo / baseColor，读不到返回白色 */
function guessColor(n: Node): Color {
    const mr = n.getComponent(MeshRenderer) || n.getComponentInChildren(MeshRenderer);
    const m: any = mr ? mr.sharedMaterial : null;
    if (m) {
        for (const k of ['mainColor', 'albedo', 'baseColor', 'color']) {
            try {
                const v: any = m.getProperty(k);
                if (v instanceof Color) return v.clone();
                if (v && typeof v.x === 'number') {
                    const s = v.x > 1.001 || v.y > 1.001 || v.z > 1.001 ? 1 : 255;
                    return new Color(v.x * s, v.y * s, v.z * s, 255);
                }
            } catch (e) { /* 没有这个属性 */ }
        }
    }
    return new Color(255, 255, 255, 255);
}

/**
 * 加特林方块连发（Cocos Creator 3.8.x）
 *
 * v5 起有两种用法：
 *   - GatlingDrop.attach(node, effect, opts)：给游戏里已经在下落的子弹节点挂发光外壳 + 拖尾（推荐，见文件末尾 GatlingTrail）
 *   - GatlingDrop.play(opts)：自带发射 + 命中特效的完整版（旧用法，保留）
 *
 * 一串「子弹方块」从屏幕外（上方偏镜头一侧）像机枪一样快速连发，依次砸中目标方块。
 * 每颗子弹：和目标同色的小方块 + 发光外壳 + 同色拖尾光带，翻滚着加速飞向目标；
 * 命中：白色闪光 + 同色光环 + 火花向外溅 + 同色碎屑落下 + 目标方块被砸得一缩一弹 + 轻微震屏，调用 onHit。
 *
 * 用法：
 *   await GatlingDrop.play({
 *       targets: blocks,                         // 按命中顺序
 *       effect: this.gatlingEffect,
 *       blockSize: 0.75,
 *       colorOf: (b) => this.colorOfBlock(b),    // 可选
 *       onHit: (b, i) => this.board.damage(b),
 *   }).done;
 */
@ccclass('GatlingDrop')
export class GatlingDrop extends Component {

    /**
     * 给一个已经在动的节点（例如游戏里池化的加特林子弹方块）挂上发光外壳 + 拖尾，跟着它走。
     * 节点被销毁、active=false、或者被瞬移（池复用）时，拖尾自动淡出并自我销毁。
     * 不负责移动节点，也不做命中特效。
     */
    static attach(target: Node, effect: EffectAsset, opts: GatlingTrailOptions = {}): GatlingTrail {
        const node = new Node('GatlingTrailFx');
        node.layer = target.layer;
        director.getScene()!.addChild(node);
        const c = node.addComponent(GatlingTrail);
        c.setup(target, effect, opts);
        return c;
    }

    static play(opts: GatlingDropOptions): GatlingDrop {
        const node = new Node('GatlingDropFx');
        node.layer = opts.targets.length ? opts.targets[0].layer : 1 << 30;
        director.getScene()!.addChild(node);
        const c = node.addComponent(GatlingDrop);
        c.setup(opts);
        return c;
    }

    /** 最后一发命中、所有特效播完后 resolve */
    done: Promise<void> = Promise.resolve();

    private _o: GatlingDropOptions & Required<Pick<GatlingDropOptions,
        'blockSize' | 'bulletScale' | 'interval' | 'flightTime' | 'distance' | 'towardCamera' | 'shake' | 'minTrailPixels'>> = null!;
    private _resolve: (() => void) | null = null;
    private _t = 0;
    private _cam: Node | null = null;
    private _camComp: Camera | null = null;
    private _camBase = new Vec3();
    private _shakeAmp = 0;

    private _bullets: Bullet[] = [];
    private _sparks: Spark[] = [];
    private _rings: Ring[] = [];
    private _punches: Punch[] = [];
    private _base = new Map<Node, { pos: Vec3; scale: Vec3 }>();
    private _hits = 0;

    private _ribbon: DynBatch | null = null;
    private _dots: DynBatch | null = null;
    private _ringBatch: DynBatch | null = null;
    private _box: Mesh | null = null;

    private _right = new Vec3(1, 0, 0);
    private _up = new Vec3(0, 1, 0);
    private _camPos = new Vec3();
    private _a = new Vec3();
    private _b = new Vec3();
    private _side = new Vec3(1, 0, 0);
    private _q = new Quat();
    private _v4 = new Vec4();

    private setup(opts: GatlingDropOptions) {
        this._o = {
            blockSize: 0.62, bulletScale: 0.45, interval: 0.07, flightTime: 0.26, distance: 8,
            towardCamera: 0.35, shake: 0.03, minTrailPixels: 6, ...opts,
        } as any;
        const o = this._o;
        const layer = this.node.layer;
        this._camComp = o.cameraNode ? o.cameraNode.getComponent(Camera) : this.findCamera(layer);
        this._cam = o.cameraNode || (this._camComp ? this._camComp.node : null);
        if (this._cam) this._camBase.set(this._cam.position);

        const mat = (defines: Record<string, boolean>, onTop = false) => {
            const m = new Material();
            const info: any = { effectAsset: o.effect, technique: 0, defines };
            if (onTop) info.states = { depthStencilState: { depthTest: false, depthWrite: false } };
            m.initialize(info);
            m.setProperty('params', new Vec4(20, 30, 1, 0));
            return m;
        };
        this._ribbon = new DynBatch(this.node, 'Trails', 64 * 2 * 12, 64 * 6 * 12, mat({ RIBBON: true }));
        this._dots = new DynBatch(this.node, 'Dots', 400 * 4, 400 * 6, mat({}, true));
        this._ringBatch = new DynBatch(this.node, 'Rings', 24 * 4, 24 * 6, mat({ RING: true }, true));
        this._box = meshUtils().createMesh(primitives.box({ width: 1, height: 1, length: 1 }));

        // 为每一发准备子弹
        const S = o.blockSize;
        o.targets.forEach((target, i) => {
            if (!target || !target.isValid) return;
            if (!this._base.has(target)) this._base.set(target, { pos: target.position.clone(), scale: target.scale.clone() });
            const color = o.colorOf ? o.colorOf(target, i) : guessColor(target);
            const end = target.worldPosition.clone();
            // 来向：从上方，偏向镜头一侧，再加一点随机横向散布，像机枪扫射
            const dir = new Vec3(0, -1, 0);
            if (this._cam) {
                const toCam = new Vec3();
                Vec3.subtract(toCam, this._cam.worldPosition, end);
                toCam.y = 0;
                if (toCam.lengthSqr() > 1e-6) {
                    toCam.normalize();
                    Vec3.scaleAndAdd(dir, dir, toCam, -o.towardCamera);
                }
            }
            dir.x += rand(-0.08, 0.08); dir.z += rand(-0.08, 0.08);
            dir.normalize();
            // 命中点：目标表面（沿来向后退半个方块）
            Vec3.scaleAndAdd(end, end, dir, -S * 0.5);
            const start = new Vec3();
            Vec3.scaleAndAdd(start, end, dir, -o.distance);

            const node = new Node('Bullet' + i);
            node.layer = layer;
            this.node.addChild(node);
            const mr = node.addComponent(MeshRenderer);
            mr.mesh = this._box;
            const unlit = new Material();
            unlit.initialize({ effectName: 'builtin-unlit' });
            unlit.setProperty('mainColor', color);
            mr.setSharedMaterial(unlit, 0);
            node.active = false;

            const shellNode = new Node('BulletGlow' + i);
            shellNode.layer = layer;
            this.node.addChild(shellNode);
            const smr = shellNode.addComponent(MeshRenderer);
            smr.mesh = this._box;
            const shellMat = mat({ SHELL: true });
            shellMat.setProperty('headColor', new Vec4(toLinear(color.r), toLinear(color.g), toLinear(color.b), 1));
            smr.setSharedMaterial(shellMat, 0);
            shellNode.active = false;

            this._bullets.push({
                index: i, target, start, end, dir, t0: i * o.interval, hit: false,
                color, lin: [toLinear(color.r), toLinear(color.g), toLinear(color.b)],
                node, unlit, shellNode, shellMat,
                spinAxis: new Vec3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize(), spin: rand(720, 1080),
                trail: [], pos: start.clone(),
            });
        });

        this.done = new Promise<void>(res => { this._resolve = res; });
        if (!this._bullets.length) this.finish();
    }

    update(dt: number) {
        if (!this._o) return;
        this._t += dt;
        const o = this._o, t = this._t, S = o.blockSize;

        if (this._cam && this._cam.isValid) {
            this._camPos.set(this._cam.worldPosition);
            Vec3.transformQuat(this._right, Vec3.RIGHT, this._cam.worldRotation);
            Vec3.transformQuat(this._up, Vec3.UP, this._cam.worldRotation);
        }

        // ---- 1. 子弹飞行 ----
        const bs = S * o.bulletScale;
        for (const b of this._bullets) {
            const k = (t - b.t0) / o.flightTime;
            if (k < 0) continue;
            if (!b.hit) {
                const e = k * (0.55 + 0.45 * k);                        // 轻微加速
                Vec3.lerp(b.pos, b.start, b.end, clamp01(e));
                b.node.active = b.shellNode.active = true;
                b.node.setWorldPosition(b.pos);
                Quat.fromAxisAngle(this._q, b.spinAxis, (t - b.t0) * b.spin * Math.PI / 180);
                b.node.setWorldRotation(this._q);
                b.node.setWorldScale(bs, bs, bs);
                b.shellNode.setWorldPosition(b.pos);
                b.shellNode.setWorldRotation(this._q);
                const g = bs * 1.25;
                b.shellNode.setWorldScale(g, g, g);
                b.shellMat.setProperty('params', this._v4.set(0.9, t * 3, 0.15, 0));
                b.trail.push({ pos: b.pos.clone(), t });
                if (e >= 1) this.hit(b);
            }
            while (b.trail.length && t - b.trail[0].t > TRAIL_LIFE) b.trail.shift();
        }

        // ---- 2. 目标被砸：一缩一弹 + 被推一下 ----
        for (let i = this._punches.length - 1; i >= 0; i--) {
            const p = this._punches[i];
            const base = this._base.get(p.node);
            if (!base || !p.node.isValid) { this._punches.splice(i, 1); continue; }
            const d = t - p.start;
            if (d > 0.35) {
                p.node.setPosition(base.pos); p.node.setScale(base.scale);
                this._punches.splice(i, 1); continue;
            }
            const s = 1 - 0.18 * Math.exp(-12 * d) * Math.cos(22 * d);
            p.node.setScale(base.scale.x * s, base.scale.y * s, base.scale.z * s);
            // 推动方向换算到父节点坐标
            const push = S * 0.12 * Math.exp(-14 * d) * Math.sin(Math.PI * Math.min(1, d / 0.05) * 0.5);
            const parent = p.node.parent;
            const ps = parent ? parent.worldScale : Vec3.ONE;
            p.node.setPosition(
                base.pos.x + p.dir.x * push / (ps.x || 1),
                base.pos.y + p.dir.y * push / (ps.y || 1),
                base.pos.z + p.dir.z * push / (ps.z || 1),
            );
        }

        // ---- 3. 震屏 ----
        if (this._cam && o.shake > 0) {
            this._shakeAmp = Math.max(0, this._shakeAmp - dt * o.shake * 12);
            const a = this._shakeAmp;
            this._cam.setPosition(this._camBase.x + rand(-a, a), this._camBase.y + rand(-a, a), this._camBase.z);
        }

        // ---- 4. 拖尾 ----
        this.buildTrails();

        // ---- 5. 光点 / 火花 / 碎屑 ----
        const dots = this._dots!;
        dots.begin();
        for (const b of this._bullets) {
            if (b.hit || t < b.t0) continue;
            dots.quad(b.pos, bs * 1.1, this._right, this._up, b.lin[0], b.lin[1], b.lin[2], 0.8);
        }
        for (let i = this._sparks.length - 1; i >= 0; i--) {
            const p = this._sparks[i];
            p.age += dt;
            if (p.age >= p.life) { this._sparks.splice(i, 1); continue; }
            p.vel.y -= p.gravity * dt;
            Vec3.scaleAndAdd(p.pos, p.pos, p.vel, dt);
            p.vel.multiplyScalar(Math.max(0, 1 - 2.5 * dt));
            const k = p.age / p.life, w = p.white * (1 - k);
            dots.quad(p.pos, p.size * (1 - 0.4 * k), this._right, this._up, lerp(p.r, 1, w), lerp(p.g, 1, w), lerp(p.b, 1, w), 1 - k);
        }
        dots.commit();

        // ---- 6. 光环 ----
        const rb = this._ringBatch!;
        rb.begin();
        for (let i = this._rings.length - 1; i >= 0; i--) {
            const r = this._rings[i];
            const k = (t - r.start) / r.life;
            if (k >= 1) { this._rings.splice(i, 1); continue; }
            rb.quad(r.pos, lerp(r.from, r.to, easeOutCubic(k)) * 0.5, this._right, this._up, r.r, r.g, r.b, r.alpha * (1 - k) * (1 - k));
        }
        rb.commit();

        // ---- 7. 结束 ----
        if (this._hits >= this._bullets.length && !this._sparks.length && !this._rings.length && !this._punches.length
            && this._bullets.every(b => !b.trail.length) && this._shakeAmp <= 0) {
            this.finish();
        }
    }

    private hit(b: Bullet) {
        b.hit = true;
        this._hits++;
        b.node.active = false;
        b.shellNode.active = false;
        const S = this._o.blockSize, t = this._t;
        const p = b.end;
        const [r, g, bl] = b.lin;
        // 白色闪光 + 同色光环
        this._sparks.push({ pos: p.clone(), vel: new Vec3(), age: 0, life: 0.12, size: S * 0.9, r: 1, g: 1, b: 1, white: 1, gravity: 0 });
        this._rings.push({ pos: p.clone(), start: t, life: 0.3, from: S * 0.6, to: S * 2.2, alpha: 1, r, g, b: bl });
        // 火花：背向来向的半球
        const back = new Vec3(-b.dir.x, -b.dir.y, -b.dir.z);
        for (let i = 0; i < 14; i++) {
            const v = new Vec3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
            const dn = Vec3.dot(v, back);
            if (dn < 0) Vec3.scaleAndAdd(v, v, back, -2 * dn);
            v.multiplyScalar(S * rand(3, 7));
            this._sparks.push({ pos: p.clone(), vel: v, age: 0, life: rand(0.2, 0.4), size: S * rand(0.06, 0.12), r, g, b: bl, white: 0.8, gravity: 0 });
        }
        // 同色碎屑：往外崩再掉下去
        for (let i = 0; i < 6; i++) {
            const v = new Vec3(rand(-1, 1), rand(0.3, 1.2), rand(-1, 1));
            Vec3.scaleAndAdd(v, v, back, 1.2);
            v.multiplyScalar(S * rand(1.5, 3));
            this._sparks.push({ pos: p.clone(), vel: v, age: 0, life: rand(0.4, 0.7), size: S * rand(0.08, 0.14), r: r * 0.8, g: g * 0.8, b: bl * 0.8, white: 0, gravity: S * 14 });
        }
        // 目标一缩一弹
        if (b.target.isValid && this._base.has(b.target)) {
            this._punches = this._punches.filter(x => x.node !== b.target);
            this._punches.push({ node: b.target, start: t, dir: b.dir.clone() });
        }
        this._shakeAmp = Math.max(this._shakeAmp, this._o.shake);
        if (this._o.onHit) { try { this._o.onHit(b.target, b.index); } catch (e) { console.error(e); } }
    }

    private buildTrails() {
        const rb = this._ribbon!;
        rb.begin();
        const o = this._o;
        let W = o.blockSize * o.bulletScale * 0.9;
        const cc = this._camComp;
        for (const b of this._bullets) {
            const pts = b.trail;
            const live = !b.hit && this._t >= b.t0;
            const n = pts.length;
            if (n < 2) continue;
            if (cc && this._cam) {
                const dist = Vec3.distance(this._camPos, pts[n - 1].pos);
                const hPx = screen.windowSize.height || 1334;
                const wpp = cc.projection === Camera.ProjectionType.PERSPECTIVE
                    ? 2 * dist * Math.tan(cc.fov * Math.PI / 360) / hPx : cc.orthoHeight * 2 / hPx;
                W = Math.max(o.blockSize * o.bulletScale * 0.9, o.minTrailPixels * wpp);
            }
            if (!rb.canAdd(n * 2, (n - 1) * 6)) break;
            const base = rb.vertexCount;
            for (let i = 0; i < n; i++) {
                const k = n - 1 - i;                                 // i = 0 为头部
                const pos = pts[k].pos;
                Vec3.subtract(this._a, pts[Math.min(n - 1, k + 1)].pos, pts[Math.max(0, k - 1)].pos);
                Vec3.subtract(this._b, this._camPos, pos);
                Vec3.cross(this._a, this._a, this._b);
                const len = this._a.length();
                if (len > 1e-6) this._side.set(this._a).multiplyScalar(1 / len);
                const uu = Math.min(1, (this._t - pts[k].t) / TRAIL_LIFE);
                const hw = W * 0.5 * (1 - 0.7 * uu);
                const a = live ? 1 : 0.7;
                rb.vtx(pos.x - this._side.x * hw, pos.y - this._side.y * hw, pos.z - this._side.z * hw, uu, 0, b.lin[0], b.lin[1], b.lin[2], a);
                rb.vtx(pos.x + this._side.x * hw, pos.y + this._side.y * hw, pos.z + this._side.z * hw, uu, 1, b.lin[0], b.lin[1], b.lin[2], a);
            }
            for (let i = 0; i < n - 1; i++) {
                const a = base + i * 2;
                rb.tri(a, a + 1, a + 2);
                rb.tri(a + 1, a + 3, a + 2);
            }
        }
        rb.commit();
    }

    /** 找渲染目标的 3D 摄像机：能看到该 layer、优先透视投影（避开 UI 正交摄像机） */
    private findCamera(layer: number): Camera | null {
        const cams = director.getScene()?.getComponentsInChildren(Camera) || [];
        let best: Camera | null = null;
        for (const c of cams) {
            if (!c.enabledInHierarchy || (c.visibility & layer) === 0) continue;
            if (!best || (c.projection === Camera.ProjectionType.PERSPECTIVE && best.projection !== Camera.ProjectionType.PERSPECTIVE)) best = c;
        }
        return best || cams[0] || null;
    }

    private finish() {
        if (this._cam && this._cam.isValid && this._o && this._o.shake > 0) this._cam.setPosition(this._camBase);
        this._base.forEach((b, n) => { if (n.isValid) { n.setPosition(b.pos); n.setScale(b.scale); } });
        const r = this._resolve; this._resolve = null;
        r && r();
        if (this.node.isValid) this.node.destroy();
    }

    onDestroy() {
        if (this._resolve) {
            this._base.forEach((b, n) => { if (n.isValid) { n.setPosition(b.pos); n.setScale(b.scale); } });
            if (this._cam && this._cam.isValid && this._o && this._o.shake > 0) this._cam.setPosition(this._camBase);
            const r = this._resolve; this._resolve = null; r();
        }
    }
}


// ======================================================================
// v5：GatlingDrop.attach —— 跟随现有下落子弹的发光外壳 + 拖尾
// ======================================================================

export interface GatlingTrailOptions {
    /** 拖尾 / 外壳颜色；不传时读取目标材质的 mainColor / albedo */
    color?: Color;
    /** 参考尺寸：子弹方块边长（世界单位），默认 0.62 */
    blockSize?: number;
    /** 拖尾在屏幕上最少多少像素宽，默认 6 */
    minTrailPixels?: number;
    /** 主摄像机，默认自动查找能看到目标 layer 的透视摄像机 */
    cameraNode?: Node;
    /** 拖尾长度（秒），默认 0.18 */
    trailLife?: number;
    /** 拖尾宽度（相对 blockSize），默认 0.75 */
    trailWidth?: number;
    /** 发光外壳强度，0 关闭外壳，默认 1 */
    glow?: number;
    /** 每秒从子弹尾部洒出的火花数，0 关闭，默认 40 */
    sparkRate?: number;
}

/**
 * 由 GatlingDrop.attach() 创建，挂在场景根，跟随目标节点。
 * 结束条件（任意一个）：target 被销毁 / target.activeInHierarchy 变 false / 一帧内位移超过 blockSize×4（池复用瞬移）/ 调用 stop()。
 * 结束后：外壳 0.08 秒淡出，拖尾按长度自然收尾，火花播完，节点自动销毁。
 */
// 注：不加 `@ccclass('GatlingTrail')` —— Cocos 3.x 规定一个 TypeScript
// 文件只能有一个 @ccclass Component（否则整个模块编译失败，所有 @ccclass
// 都注册不上）。GatlingTrail 只通过 `node.addComponent(GatlingTrail)` 动
// 态挂载，从不写进场景，也不需要注册到 CCClass 系统。
export class GatlingTrail extends Component {

    private _target: Node | null = null;
    private _o: Required<Omit<GatlingTrailOptions, 'color' | 'cameraNode'>> & GatlingTrailOptions = null!;
    private _following = true;
    private _t = 0;
    private _stopT = 0;
    private _lin = [1, 1, 1];
    private _cam: Node | null = null;
    private _camComp: Camera | null = null;

    private _trail: TrailPoint[] = [];
    private _sparks: Spark[] = [];
    private _sparkAcc = 0;
    private _last = new Vec3();
    private _hasLast = false;
    private _headPos = new Vec3();

    private _ribbon: DynBatch | null = null;
    private _dots: DynBatch | null = null;
    private _shell: Node | null = null;
    private _shellMat: Material | null = null;
    private _baseScale = new Vec3(1, 1, 1);

    private _right = new Vec3(1, 0, 0);
    private _up = new Vec3(0, 1, 0);
    private _camPos = new Vec3();
    private _a = new Vec3();
    private _b = new Vec3();
    private _side = new Vec3(1, 0, 0);
    private _v4 = new Vec4();

    /** 当前是否还在跟随目标 */
    get following() { return this._following; }

    /** 手动停止跟随（拖尾照常淡出后自动销毁） */
    stop() {
        if (!this._following) return;
        this._following = false;
        this._stopT = this._t;
    }

    setup(target: Node, effect: EffectAsset, opts: GatlingTrailOptions) {
        this._o = { blockSize: 0.62, minTrailPixels: 6, trailLife: 0.18, trailWidth: 0.75, glow: 1, sparkRate: 40, ...opts } as any;
        const o = this._o;
        this._target = target;
        const col = o.color || guessColor(target);
        this._lin = [toLinear(col.r), toLinear(col.g), toLinear(col.b)];
        this._baseScale.set(target.worldScale);

        this._camComp = o.cameraNode ? o.cameraNode.getComponent(Camera) : findCamera3D(target.layer);
        this._cam = o.cameraNode || (this._camComp ? this._camComp.node : null);

        const mat = (defines: Record<string, boolean>, onTop = false) => {
            const m = new Material();
            const info: any = { effectAsset: effect, technique: 0, defines };
            if (onTop) info.states = { depthStencilState: { depthTest: false, depthWrite: false } };
            m.initialize(info);
            m.setProperty('params', new Vec4(20, 30, 1, 0));
            return m;
        };
        this._ribbon = new DynBatch(this.node, 'Trail', 48 * 2, 48 * 6, mat({ RIBBON: true }));
        this._dots = new DynBatch(this.node, 'Sparks', 64 * 4, 64 * 6, mat({}, true));

        if (o.glow > 0) {
            const shell = new Node('Glow');
            shell.layer = this.node.layer;
            this.node.addChild(shell);
            const mr = shell.addComponent(MeshRenderer);
            mr.mesh = sharedBox();
            this._shellMat = mat({ SHELL: true });
            this._shellMat.setProperty('headColor', new Vec4(this._lin[0], this._lin[1], this._lin[2], 1));
            mr.setSharedMaterial(this._shellMat, 0);
            this._shell = shell;
        }
        this.update(0);
    }

    update(dt: number) {
        if (!this._o) return;
        this._t += dt;
        const o = this._o, t = this._t, S = o.blockSize;
        const L = this._lin;

        if (this._cam && this._cam.isValid) {
            this._camPos.set(this._cam.worldPosition);
            Vec3.transformQuat(this._right, Vec3.RIGHT, this._cam.worldRotation);
            Vec3.transformQuat(this._up, Vec3.UP, this._cam.worldRotation);
        }

        // ---- 1. 跟随 / 判断结束 ----
        const tg = this._target;
        if (this._following) {
            if (!tg || !tg.isValid || !tg.activeInHierarchy) {
                this.stop();
            } else {
                const p = tg.worldPosition;
                if (this._hasLast && Vec3.distance(p, this._last) > S * 4) {
                    this.stop();                                   // 池复用瞬移：不要把拖尾拉成一条长线
                } else {
                    this._headPos.set(p);
                    this._last.set(p);
                    this._hasLast = true;
                    const lastPt = this._trail[this._trail.length - 1];
                    if (!lastPt || Vec3.distance(lastPt.pos, p) > S * 0.05) this._trail.push({ pos: p.clone(), t });
                    // 尾部火花
                    if (o.sparkRate > 0 && dt > 0) {
                        this._sparkAcc += o.sparkRate * dt;
                        while (this._sparkAcc >= 1) {
                            this._sparkAcc -= 1;
                            const v = new Vec3(rand(-1, 1), rand(-0.2, 1), rand(-1, 1)).multiplyScalar(S * rand(0.6, 1.6));
                            this._sparks.push({
                                pos: new Vec3(p.x + rand(-0.3, 0.3) * S, p.y + rand(0, 0.4) * S, p.z + rand(-0.3, 0.3) * S),
                                vel: v, age: 0, life: rand(0.2, 0.4), size: S * rand(0.05, 0.1),
                                r: L[0], g: L[1], b: L[2], white: 0.6, gravity: 0,
                            });
                        }
                    }
                }
            }
        }
        while (this._trail.length && t - this._trail[0].t > o.trailLife) this._trail.shift();

        // ---- 2. 发光外壳 ----
        if (this._shell) {
            const fade = this._following ? 1 : Math.max(0, 1 - (t - this._stopT) / 0.08);
            this._shell.active = fade > 0 && !!tg && tg.isValid;
            if (this._shell.active && tg) {
                this._shell.setWorldPosition(this._following ? tg.worldPosition : this._headPos);
                this._shell.setWorldRotation(tg.worldRotation);
                const ws = tg.worldScale, bs = this._baseScale;
                const k = S * 1.15;
                this._shell.setWorldScale(k * (bs.x ? ws.x / bs.x : 1), k * (bs.y ? ws.y / bs.y : 1), k * (bs.z ? ws.z / bs.z : 1));
                this._shellMat!.setProperty('params', this._v4.set(o.glow * fade * (0.85 + 0.15 * Math.sin(t * 30)), t * 3, 0.15 * fade, 0));
            }
        }

        // ---- 3. 拖尾 ----
        this.buildTrail();

        // ---- 4. 火花 + 头部光晕 ----
        const dots = this._dots!;
        dots.begin();
        if (this._following) dots.quad(this._headPos, S * 0.9, this._right, this._up, L[0], L[1], L[2], 0.55);
        for (let i = this._sparks.length - 1; i >= 0; i--) {
            const p = this._sparks[i];
            p.age += dt;
            if (p.age >= p.life) { this._sparks.splice(i, 1); continue; }
            Vec3.scaleAndAdd(p.pos, p.pos, p.vel, dt);
            p.vel.multiplyScalar(Math.max(0, 1 - 3 * dt));
            const k = p.age / p.life, w = p.white * (1 - k);
            dots.quad(p.pos, p.size * (1 - 0.4 * k), this._right, this._up, lerp(p.r, 1, w), lerp(p.g, 1, w), lerp(p.b, 1, w), 1 - k);
        }
        dots.commit();

        // ---- 5. 结束 ----
        if (!this._following && !this._trail.length && !this._sparks.length && t - this._stopT > 0.1) this.node.destroy();
    }

    private buildTrail() {
        const rb = this._ribbon!;
        rb.begin();
        const o = this._o, pts = this._trail, L = this._lin;
        const n = pts.length + (this._following ? 1 : 0);
        if (n >= 2) {
            let W = o.blockSize * o.trailWidth;
            const cc = this._camComp;
            if (cc && this._cam) {
                const dist = Vec3.distance(this._camPos, this._headPos);
                const hPx = screen.windowSize.height || 1334;
                const wpp = cc.projection === Camera.ProjectionType.PERSPECTIVE
                    ? 2 * dist * Math.tan(cc.fov * Math.PI / 360) / hPx : cc.orthoHeight * 2 / hPx;
                W = Math.max(W, o.minTrailPixels * wpp);
            }
            const gp = (k: number) => (k < pts.length ? pts[k].pos : this._headPos);
            const gt = (k: number) => (k < pts.length ? pts[k].t : this._t);
            const count = Math.min(n, 48);
            for (let i = 0; i < count; i++) {
                const k = n - 1 - i;                                  // i = 0 为头部
                const pos = gp(k);
                Vec3.subtract(this._a, gp(Math.min(n - 1, k + 1)), gp(Math.max(0, k - 1)));
                Vec3.subtract(this._b, this._camPos, pos);
                Vec3.cross(this._a, this._a, this._b);
                const len = this._a.length();
                if (len > 1e-6) this._side.set(this._a).multiplyScalar(1 / len);
                const uu = Math.min(1, (this._t - gt(k)) / o.trailLife);
                const hw = W * 0.5 * (1 - 0.6 * uu);
                const a = this._following ? 1 : 0.8;
                rb.vtx(pos.x - this._side.x * hw, pos.y - this._side.y * hw, pos.z - this._side.z * hw, uu, 0, L[0], L[1], L[2], a);
                rb.vtx(pos.x + this._side.x * hw, pos.y + this._side.y * hw, pos.z + this._side.z * hw, uu, 1, L[0], L[1], L[2], a);
            }
            for (let i = 0; i < count - 1; i++) {
                const a = i * 2;
                rb.tri(a, a + 1, a + 2);
                rb.tri(a + 1, a + 3, a + 2);
            }
        }
        rb.commit();
    }
}

let _sharedBox: Mesh | null = null;
function sharedBox(): Mesh {
    if (!_sharedBox) _sharedBox = meshUtils().createMesh(primitives.box({ width: 1, height: 1, length: 1 }));
    return _sharedBox!;
}

/** 找渲染该 layer 的 3D 摄像机：优先透视投影（避开 UI 正交摄像机） */
function findCamera3D(layer: number): Camera | null {
    const cams = director.getScene()?.getComponentsInChildren(Camera) || [];
    let best: Camera | null = null;
    for (const c of cams) {
        if (!c.enabledInHierarchy || (c.visibility & layer) === 0) continue;
        if (!best || (c.projection === Camera.ProjectionType.PERSPECTIVE && best.projection !== Camera.ProjectionType.PERSPECTIVE)) best = c;
    }
    return best || cams[0] || null;
}
