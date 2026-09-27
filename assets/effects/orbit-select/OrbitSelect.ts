import {
    _decorator, Component, Node, MeshRenderer, Material, EffectAsset, Color, Vec3, Vec4, Mesh,
    Camera, director, utils, primitives,
} from 'cc';
const { ccclass } = _decorator;

/**
 * 长拖尾绕塔一圈后选中一个方块（Cocos Creator 3.8.x）
 *
 * 流程（默认约 1.6 秒）：
 *   光球从塔顶上方出发，拖着长长的光带沿螺旋线绕塔外围转一圈多（经过塔背面时会被塔挡住），
 *   一边绕一边下降到目标高度，最后收拢半径切入目标方块的外侧面。
 *   命中：闪光、火花向外溅、两圈光环、目标方块弹一下，调用 onSelect。
 *   之后目标方块保持选中高亮（棱边发光 + 扫光 + 上升光点），直到 clear()。
 *
 * 用法：
 *   const fx = OrbitSelect.play({
 *       tower: this.towerNode,          // 塔根节点，原点在塔的中轴线上
 *       target: block,                  // 要选中的方块
 *       effect: this.orbitEffect,       // orbit-select.effect
 *       onSelect: (b) => this.onBlockSelected(b),
 *   });
 *   await fx.arrived;
 *   ...
 *   fx.clear();                         // 取消选中高亮
 */
export interface OrbitSelectOptions {
    tower: Node;
    target: Node;
    effect: EffectAsset;
    /** 头部颜色，默认青色 */
    headColor?: Color;
    /** 尾部颜色，默认紫色 */
    tailColor?: Color;
    /** 飞行总时长（秒），默认 1.6 */
    duration?: number;
    /** 绕塔的圈数（在最后切入前），默认 1.25 */
    turns?: number;
    /** 1 = 从上往下看逆时针，-1 = 顺时针，默认 1 */
    direction?: number;
    /** 塔的高度（塔节点坐标系），光球从塔顶上方出发，默认 6 */
    towerHeight?: number;
    /** 塔底相对塔节点原点的 Y，默认 0 */
    towerBottomY?: number;
    /** 绕行半径比方块所在半径大多少（世界单位），默认 0.6 */
    orbitMargin?: number;
    /** 方块边长，默认 0.62 */
    blockSize?: number;
    /** 光带宽度，默认 0.5 */
    width?: number;
    /** 拖尾存在时间（秒），越大越长，默认 0.9 */
    trailLifetime?: number;
    /** 选中后是否保持高亮，默认 true；false 则命中后 0.8 秒自动淡出 */
    keepSelected?: boolean;
    /** 主摄像机节点，默认自动查找 */
    cameraNode?: Node;
    /** 命中瞬间回调 */
    onSelect?: (target: Node) => void;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const toLinear = (c: number) => Math.pow(c / 255, 2.2);
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);

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

interface TrailPoint { pos: Vec3; t: number; }
interface Spark { pos: Vec3; vel: Vec3; age: number; life: number; size: number; white: number; drag: boolean; }
interface Ring { start: number; life: number; from: number; to: number; alpha: number; pos: Vec3; }

const MAX_POINTS = 240;

@ccclass('OrbitSelect')
export class OrbitSelect extends Component {

    static play(opts: OrbitSelectOptions): OrbitSelect {
        const node = new Node('OrbitSelectFx');
        node.layer = opts.target.layer;
        director.getScene()!.addChild(node);
        const c = node.addComponent(OrbitSelect);
        c.setup(opts);
        return c;
    }

    /** 命中目标时 resolve */
    arrived: Promise<void> = Promise.resolve();

    private _o: OrbitSelectOptions & Required<Pick<OrbitSelectOptions,
        'duration' | 'turns' | 'direction' | 'towerHeight' | 'towerBottomY' | 'orbitMargin' | 'blockSize' | 'width' | 'trailLifetime' | 'keepSelected'>> = null!;
    private _resolve: (() => void) | null = null;
    private _cam: Node | null = null;
    private _t = 0;
    private _hit = false;
    private _hitT = 0;
    private _clearing = false;
    private _fade = 1;

    private _head = new Linear();
    private _tail = new Linear();

    // 路径参数（塔的世界坐标系，Y 轴为竖直轴）
    private _center = new Vec3();
    private _thetaT = 0;
    private _rT = 0;
    private _yT = 0;
    private _yStart = 0;
    private _rOrbit = 0;
    private _sweep = 0;
    private _headPos = new Vec3();
    private _normal = new Vec3();

    private _points: TrailPoint[] = [];
    private _sparks: Spark[] = [];
    private _rings: Ring[] = [];
    private _sparkAcc = 0;
    private _auraAcc = 0;

    private _ribbon: DynBatch | null = null;
    private _dots: DynBatch | null = null;
    private _ringBatch: DynBatch | null = null;
    private _shellNode: Node | null = null;
    private _shellMat: Material | null = null;

    private _baseScale = new Vec3();
    private _right = new Vec3(1, 0, 0);
    private _up = new Vec3(0, 1, 0);
    private _camPos = new Vec3();
    private _side = new Vec3(1, 0, 0);
    private _a = new Vec3();
    private _b = new Vec3();
    private _v4 = new Vec4();

    /** 取消选中高亮（淡出后自动销毁） */
    clear() { this._clearing = true; }

    // ------------------------------------------------------------------

    private setup(opts: OrbitSelectOptions) {
        this._o = {
            duration: 1.6, turns: 1.25, direction: 1, towerHeight: 6, towerBottomY: 0, orbitMargin: 0.6,
            blockSize: 0.62, width: 0.5, trailLifetime: 0.9, keepSelected: true,
            ...opts,
        } as any;
        const o = this._o;
        this._head.set(o.headColor || new Color(90, 220, 255, 255));
        this._tail.set(o.tailColor || new Color(120, 60, 255, 255));
        this._cam = o.cameraNode || director.getScene()?.getComponentInChildren(Camera)?.node || null;
        this._baseScale.set(o.target.scale);

        // 路径：以塔节点为圆心
        const tw = o.tower;
        this._center.set(tw.worldPosition);
        const tp = o.target.worldPosition;
        const dx = tp.x - this._center.x, dz = tp.z - this._center.z;
        this._thetaT = Math.atan2(dz, dx);
        this._rT = Math.sqrt(dx * dx + dz * dz) + o.blockSize * 0.5;     // 目标外侧面
        this._yT = tp.y;
        const sy = Math.abs(tw.worldScale.y) || 1;
        this._yStart = this._center.y + (o.towerBottomY + o.towerHeight) * sy + o.blockSize * 1.5;
        this._rOrbit = this._rT + o.orbitMargin;
        this._sweep = Math.PI * 2 * o.turns;
        this._normal.set(Math.cos(this._thetaT), 0, Math.sin(this._thetaT));
        this.pathAt(0, this._headPos);

        const mat = (defines: Record<string, boolean>) => {
            const m = new Material();
            m.initialize({ effectAsset: o.effect, technique: 0, defines });
            m.setProperty('headColor', this._head.v);
            m.setProperty('tailColor', this._tail.v);
            m.setProperty('params', new Vec4(14, 30, 1, 0));
            return m;
        };
        this._ribbon = new DynBatch(this.node, 'Ribbon', (MAX_POINTS + 1) * 2, MAX_POINTS * 6, mat({ RIBBON: true }));
        this._dots = new DynBatch(this.node, 'Dots', 200 * 4, 200 * 6, mat({}));
        this._ringBatch = new DynBatch(this.node, 'Rings', 6 * 4, 6 * 6, mat({ RING: true }));

        const shell = new Node('SelectShell');
        shell.layer = this.node.layer;
        this.node.addChild(shell);
        const mr = shell.addComponent(MeshRenderer);
        mr.mesh = meshUtils().createMesh(primitives.box({ width: 1, height: 1, length: 1 }));
        this._shellMat = mat({ SHELL: true });
        mr.setSharedMaterial(this._shellMat, 0);
        shell.active = false;
        this._shellNode = shell;

        this.arrived = new Promise<void>(res => { this._resolve = res; });
    }

    /** 路径上 u(0~1) 处的位置 */
    private pathAt(u: number, out: Vec3) {
        const o = this._o;
        const dir = o.direction >= 0 ? 1 : -1;
        const a = 0.35 * u + 0.65 * u * u;                                // 先稳后快，最后冲进去
        const theta = this._thetaT - dir * this._sweep * (1 - a);
        const r = lerp(this._rOrbit, this._rT, smooth(0.72, 1, u));
        const y = lerp(this._yStart, this._yT, smooth(0, 0.92, u)) + Math.sin(u * Math.PI * 3) * 0.25 * (1 - u);
        out.set(this._center.x + Math.cos(theta) * r, y, this._center.z + Math.sin(theta) * r);
        return out;
    }

    update(dt: number) {
        if (!this._o) return;
        this._t += dt;
        const o = this._o, t = this._t, S = o.blockSize;
        const H = this._head, T = this._tail;

        if (this._cam && this._cam.isValid) {
            this._camPos.set(this._cam.worldPosition);
            Vec3.transformQuat(this._right, Vec3.RIGHT, this._cam.worldRotation);
            Vec3.transformQuat(this._up, Vec3.UP, this._cam.worldRotation);
        }

        // ---- 1. 飞行 ----
        const u = clamp01(t / o.duration);
        if (!this._hit) {
            this.pathAt(u, this._headPos);
            const last = this._points[this._points.length - 1];
            if (!last || Vec3.distance(last.pos, this._headPos) >= 0.06) {
                if (this._points.length >= MAX_POINTS) this._points.shift();
                this._points.push({ pos: this._headPos.clone(), t });
            }
            // 沿途散落的小光点
            this._sparkAcc += dt * 45;
            while (this._sparkAcc >= 1) {
                this._sparkAcc -= 1;
                this.addSpark(this._headPos.clone(),
                    new Vec3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(0.6),
                    rand(0.3, 0.6), S * rand(0.06, 0.12), 0.5, true);
            }
            if (u >= 1) this.doHit();
        }
        while (this._points.length && t - this._points[0].t > o.trailLifetime) this._points.shift();

        // ---- 2. 选中高亮 ----
        const target = o.target;
        const targetOk = target && target.isValid && target.activeInHierarchy;
        if (this._hit && !targetOk) this._clearing = true;
        if (this._hit && !o.keepSelected && t - this._hitT > 0.8) this._clearing = true;
        if (this._clearing) this._fade = Math.max(0, this._fade - dt / 0.3);

        if (this._hit && targetOk) {
            const d = t - this._hitT;
            // 目标弹一下
            if (d < 0.6) {
                const f = 1 + 0.25 * Math.exp(-8 * d) * Math.sin(18 * d);
                target.setScale(this._baseScale.x * f, this._baseScale.y * f, this._baseScale.z * f);
            } else if (d - dt < 0.6) {
                target.setScale(this._baseScale);
            }
            const shell = this._shellNode!;
            shell.setWorldPosition(target.worldPosition);
            shell.setWorldRotation(target.worldRotation);
            const bs = this._baseScale, cs = target.scale, k = S * 1.08;
            shell.setWorldScale(k * (bs.x ? cs.x / bs.x : 1), k * (bs.y ? cs.y / bs.y : 1), k * (bs.z ? cs.z / bs.z : 1));
            const flash = Math.exp(-d * 10);
            const inten = lerp(1.2, 0.85 + 0.2 * Math.sin(t * 5), clamp01(d / 0.4));
            this._shellMat!.setProperty('params', this._v4.set(inten * this._fade, t * 0.8, flash * this._fade, 0));

            if (!this._clearing) {
                this._auraAcc += dt * 12;
                const c = target.worldPosition;
                while (this._auraAcc >= 1) {
                    this._auraAcc -= 1;
                    this.addSpark(new Vec3(c.x + rand(-0.5, 0.5) * S, c.y + rand(-0.4, 0.2) * S, c.z + rand(-0.5, 0.5) * S),
                        new Vec3(0, rand(1, 2) * S, 0), rand(0.7, 1.1), S * rand(0.06, 0.1), 0, false);
                }
                // 每 1.2 秒一圈淡淡的脉冲环
                if (d > 0.6 && Math.floor((d - dt) / 1.2) !== Math.floor(d / 1.2)) {
                    this._rings.push({ start: t, life: 0.7, from: S * 1.1, to: S * 2.4, alpha: 0.45, pos: c.clone() });
                }
            }
        }

        // ---- 3. 光带 ----
        this.buildRibbon();

        // ---- 4. 光点 / 火花 ----
        const dots = this._dots!;
        dots.begin();
        if (!this._hit) {
            const f = 0.9 + 0.1 * Math.sin(t * 40);
            dots.quad(this._headPos, S * 0.75 * f, this._right, this._up, H.x, H.y, H.z, 1);
            dots.quad(this._headPos, S * 0.3, this._right, this._up, 1, 1, 1, 0.9);
        }
        for (let i = this._sparks.length - 1; i >= 0; i--) {
            const p = this._sparks[i];
            p.age += dt;
            if (p.age >= p.life) { this._sparks.splice(i, 1); continue; }
            Vec3.scaleAndAdd(p.pos, p.pos, p.vel, dt);
            if (p.drag) p.vel.multiplyScalar(Math.max(0, 1 - 3.5 * dt));
            const k = p.age / p.life, w = p.white * (1 - k);
            const r = lerp(lerp(H.x, T.x, k), 1, w), g = lerp(lerp(H.y, T.y, k), 1, w), b = lerp(lerp(H.z, T.z, k), 1, w);
            dots.quad(p.pos, p.size * (1 - 0.5 * k), this._right, this._up, r, g, b, (1 - k) * this.sparkFade(p));
        }
        dots.commit();

        // ---- 5. 光环 ----
        const rb = this._ringBatch!;
        rb.begin();
        for (let i = this._rings.length - 1; i >= 0; i--) {
            const r = this._rings[i];
            const k = (t - r.start) / r.life;
            if (k >= 1) { this._rings.splice(i, 1); continue; }
            if (k < 0) continue;
            rb.quad(r.pos, lerp(r.from, r.to, easeOutCubic(k)) * 0.5, this._right, this._up, H.x, H.y, H.z, r.alpha * (1 - k) * (1 - k) * this._fade);
        }
        rb.commit();

        // ---- 6. 结束 ----
        if (this._clearing && this._fade <= 0 && this._sparks.length === 0 && this._points.length === 0) {
            this.node.destroy();
        }
    }

    private sparkFade(p: Spark) { return p.drag ? 1 : this._fade; }

    private addSpark(pos: Vec3, vel: Vec3, life: number, size: number, white: number, drag: boolean) {
        if (this._sparks.length >= 200) return;
        this._sparks.push({ pos, vel, age: 0, life, size, white, drag });
    }

    private doHit() {
        this._hit = true;
        this._hitT = this._t;
        const o = this._o, S = o.blockSize;
        const p = this._headPos.clone();
        // 火花：从目标外侧面向外半球溅开
        for (let i = 0; i < 45; i++) {
            const v = new Vec3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
            const dn = Vec3.dot(v, this._normal);
            if (dn < 0) Vec3.scaleAndAdd(v, v, this._normal, -2 * dn);
            v.multiplyScalar(S * rand(4, 9));
            this.addSpark(p.clone(), v, rand(0.35, 0.7), S * rand(0.1, 0.2), 1, true);
        }
        this._rings.push({ start: this._t, life: 0.45, from: S * 1.0, to: S * 4.5, alpha: 1, pos: p.clone() });
        this._rings.push({ start: this._t + 0.08, life: 0.5, from: S * 0.8, to: S * 3.2, alpha: 0.7, pos: p.clone() });

        this._shellNode!.active = true;
        if (o.onSelect) {
            try { o.onSelect(o.target); } catch (e) { console.error(e); }
        }
        const r = this._resolve; this._resolve = null;
        r && r();
    }

    private buildRibbon() {
        const rb = this._ribbon!;
        rb.begin();
        const pts = this._points;
        const live = !this._hit;
        const n = pts.length + (live ? 1 : 0);
        if (n >= 2) {
            const gp = (k: number) => (k < pts.length ? pts[k].pos : this._headPos);
            const gt = (k: number) => (k < pts.length ? pts[k].t : this._t);
            const o = this._o;
            for (let i = 0; i < n; i++) {
                const k = n - 1 - i;                     // i = 0 为头部
                const pos = gp(k);
                Vec3.subtract(this._a, gp(Math.min(n - 1, k + 1)), gp(Math.max(0, k - 1)));
                Vec3.subtract(this._b, this._camPos, pos);
                Vec3.cross(this._a, this._a, this._b);
                const len = this._a.length();
                if (len > 1e-5) this._side.set(this._a).multiplyScalar(1 / len);
                const uu = Math.min(1, (this._t - gt(k)) / o.trailLifetime);
                const hw = o.width * 0.5 * (0.25 + 0.75 * (1 - uu));
                rb.vtx(pos.x - this._side.x * hw, pos.y - this._side.y * hw, pos.z - this._side.z * hw, uu, 0, 1, 1, 1, 1);
                rb.vtx(pos.x + this._side.x * hw, pos.y + this._side.y * hw, pos.z + this._side.z * hw, uu, 1, 1, 1, 1, 1);
            }
            for (let i = 0; i < n - 1; i++) {
                const a = i * 2;
                rb.tri(a, a + 1, a + 2);
                rb.tri(a + 1, a + 3, a + 2);
            }
        }
        rb.commit();
    }

    onDestroy() {
        const o = this._o;
        if (o && o.target && o.target.isValid) o.target.setScale(this._baseScale);
        const r = this._resolve; this._resolve = null;
        r && r();
    }
}

/** 线性空间颜色 */
class Linear {
    v = new Vec4(1, 1, 1, 1);
    get x() { return this.v.x; } get y() { return this.v.y; } get z() { return this.v.z; }
    set(c: Color) { this.v.set(toLinear(c.r), toLinear(c.g), toLinear(c.b), 1); }
}
