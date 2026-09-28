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


interface TrailPoint { pos: Vec3; t: number; }
interface Comet { hue: number; a: Vec3; b: Vec3; r: number; theta: number; speedMul: number; hist: { theta: number; t: number }[]; head: Vec3; }
interface Ghost { node: Node; mat: Material; age: number; life: number; }
interface Spark { pos: Vec3; vel: Vec3; age: number; life: number; size: number; white: number; hue: number; }
interface Ring { start: number; life: number; from: number; to: number; alpha: number; pos: Vec3; shrink: boolean; hue: number; }

export interface BlockSpinOptions {
    /** 要旋转的方块 */
    block: Node;
    /** block-spin.effect */
    effect: EffectAsset;
    /** 塔根节点（原点在中轴线上），用来算「向外」方向；为空时朝摄像机方向弹出 */
    tower?: Node;
    /** 旋转轴：vertical = 绕竖直轴转（默认），radial = 绕朝外的轴转（像硬币正面对着镜头转） */
    axis?: 'vertical' | 'radial';
    /** 转几圈，默认 2 */
    turns?: number;
    /** 总时长（秒），默认 1.0 */
    duration?: number;
    /** 方块边长（世界单位），默认 0.62 */
    blockSize?: number;
    /** 旋转时向外弹出的距离（方块边长的倍数），默认 0（缩小后旋转不会和旁边方块穿插） */
    popOut?: number;
    /** 旋转时缩小到原大小的多少，默认 0.6 */
    shrinkTo?: number;
    /** 主色（外壳、光带头部），默认金色 */
    headColor?: Color;
    /** 光带尾部颜色，默认粉紫 */
    tailColor?: Color;
    /** 主摄像机节点，默认自动查找 */
    cameraNode?: Node;
    /** 光带宽度（世界单位），默认 blockSize × 0.5 */
    trailWidth?: number;
    /** 光带在屏幕上的最小宽度（像素），离镜头远时自动加粗，默认 8 */
    minTrailPixels?: number;
    /** 光带轨道半径倍数（相对 blockSize），默认 1.0，轨道半径 = blockSize × (1.0~1.35) × orbitScale */
    orbitScale?: number;
    /** 调试：光带强制画成纯红色，并在控制台每 0.25 秒打印光带顶点/三角形数、使用的摄像机、光带宽度 */
    debug?: boolean;
    /** 转到一半（速度最快、看不清的时候）调用，适合在这里换颜色/换材质/换成道具 */
    onFlip?: (block: Node) => void;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const smooth = (a: number, b: number, x: number) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const easeInOutCubic = (t: number) => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const toLinear = (c: number) => Math.pow(c / 255, 2.2);

const GHOSTS = 8;
const COMETS = 6;            // 彩色光带条数
const TRAIL_LIFE = 0.32;     // 光带长度（秒）
const MAX_TRAIL = 130;       // 每条光带最多顶点对数

/** HSV → 线性空间 RGB（h 0~1 循环） */
function hsvLinear(h: number, s: number, v: number, out: number[]) {
    h = ((h % 1) + 1) % 1;
    const i = Math.floor(h * 6), f = h * 6 - i;
    const p = v * (1 - s), q = v * (1 - f * s), t = v * (1 - (1 - f) * s);
    let r = v, g = t, b = p;
    switch (i % 6) {
        case 1: r = q; g = v; b = p; break;
        case 2: r = p; g = v; b = t; break;
        case 3: r = p; g = q; b = v; break;
        case 4: r = t; g = p; b = v; break;
        case 5: r = v; g = p; b = q; break;
    }
    out[0] = Math.pow(r, 2.2); out[1] = Math.pow(g, 2.2); out[2] = Math.pow(b, 2.2);
    return out;
}
const tmpRGB = [0, 0, 0];

/**
 * 塔上单个方块华丽自转（Cocos Creator 3.8.x）
 *
 * 时间轴（默认 1 秒）：
 *   0.00~0.15 蓄力：方块缩小到 0.6 倍，外壳发光渐强，一圈光环向方块收缩
 *   0.15~0.80 旋转：方块保持缩小状态高速转 2 圈（先加速后减速）；
 *             六条彩虹色光带在不同倾角的轨道上高速环绕（与方块转速无关，3~6 圈/秒），
 *             沿途洒彩色闪光，方块转得快时留下发光残影；
 *             转到一半时闪白并调用 onFlip（在这里换外观）
 *   0.80      落定：弹回原大小（带过冲），闪光 + 两圈光环 + 火花爆散 + 轻微回摆
 *   之后外壳和光带淡出，特效节点自动销毁
 *
 * 用法：
 *   await BlockSpin.play({
 *       block, effect: this.spinEffect, tower: this.tower,
 *       onFlip: (b) => this.setBlockColor(b, newColor),
 *   }).done;
 */
@ccclass('BlockSpin')
export class BlockSpin extends Component {

    static play(opts: BlockSpinOptions): BlockSpin {
        const node = new Node('BlockSpinFx');
        node.layer = opts.block.layer;
        director.getScene()!.addChild(node);
        const c = node.addComponent(BlockSpin);
        c.setup(opts);
        return c;
    }

    /** 方块回到原位（旋转动画结束）时 resolve */
    done: Promise<void> = Promise.resolve();

    private _o: Required<Omit<BlockSpinOptions, 'tower' | 'cameraNode' | 'onFlip' | 'headColor' | 'tailColor'>> & BlockSpinOptions = null!;
    private _resolve: (() => void) | null = null;
    private _cam: Node | null = null;
    private _camComp: Camera | null = null;
    private _debugAcc = 0;
    private _trailW = 0;
    private _t = 0;
    private _flipped = false;
    private _landed = false;
    private _finished = false;
    private _lastAngle = 0;
    private _ghostAcc = 0;
    private _sparkAcc = 0;

    private _head = new Linear();
    private _tail = new Linear();

    private _basePos = new Vec3();        // 世界坐标
    private _baseRot = new Quat();        // 世界旋转
    private _baseScale = new Vec3();      // 本地缩放
    private _axis = new Vec3(0, 1, 0);
    private _outward = new Vec3(0, 0, 1);
    private _u = new Vec3();
    private _v = new Vec3();
    private _center = new Vec3();

    private _comets: Comet[] = [];
    private _ghosts: Ghost[] = [];
    private _sparks: Spark[] = [];
    private _rings: Ring[] = [];

    private _ribbon: DynBatch | null = null;
    private _dots: DynBatch | null = null;
    private _ringBatch: DynBatch | null = null;
    private _shellNode: Node | null = null;
    private _shellMat: Material | null = null;

    private _right = new Vec3(1, 0, 0);
    private _up = new Vec3(0, 1, 0);
    private _camPos = new Vec3();
    private _q = new Quat();
    private _q2 = new Quat();
    private _a = new Vec3();
    private _b = new Vec3();
    private _side = new Vec3();
    private _v4 = new Vec4();

    // ------------------------------------------------------------------

    private setup(opts: BlockSpinOptions) {
        this._o = { axis: 'vertical', turns: 2, duration: 1.0, blockSize: 0.62, popOut: 0, shrinkTo: 0.6, minTrailPixels: 8, orbitScale: 1, debug: false, ...opts } as any;
        const o = this._o;
        this._head.set(o.headColor || new Color(255, 215, 110, 255));
        this._tail.set(o.tailColor || new Color(255, 90, 170, 255));
        this._camComp = o.cameraNode ? o.cameraNode.getComponent(Camera) : this.findCamera(o.block.layer);
        this._cam = o.cameraNode || (this._camComp ? this._camComp.node : null);
        if (o.debug) console.log('[BlockSpin] camera =', this._cam ? this._cam.name : 'NONE', ' layer =', o.block.layer);

        const b = o.block;
        this._basePos.set(b.worldPosition);
        this._baseRot.set(b.worldRotation);
        this._baseScale.set(b.scale);

        // 向外方向：塔中心 → 方块（水平），没有塔就朝摄像机
        if (o.tower) {
            Vec3.subtract(this._outward, this._basePos, o.tower.worldPosition);
        } else if (this._cam) {
            Vec3.subtract(this._outward, this._cam.worldPosition, this._basePos);
        }
        this._outward.y = 0;
        if (this._outward.lengthSqr() < 1e-6) this._outward.set(0, 0, 1);
        this._outward.normalize();

        // 旋转轴和旋转平面
        if (o.axis === 'radial') this._axis.set(this._outward);
        else this._axis.set(0, 1, 0);
        const ref = Math.abs(this._axis.y) > 0.9 ? this._outward : Vec3.UNIT_Y;
        Vec3.cross(this._u, this._axis, ref).normalize();
        Vec3.cross(this._v, this._axis, this._u).normalize();

        const mat = (defines: Record<string, boolean>, onTop = false) => {
            const m = new Material();
            // 彩带、光点、光环画在最上层，不被旁边的方块挡住（背面的部分脚本会调暗）
            const info: any = { effectAsset: o.effect, technique: 0, defines };
            if (onTop) info.states = { depthStencilState: { depthTest: false, depthWrite: false } };
            m.initialize(info);
            m.setProperty('headColor', this._head.v);
            m.setProperty('tailColor', this._tail.v);
            m.setProperty('params', new Vec4(16, 26, 1, 0));
            return m;
        };
        this._ribbon = new DynBatch(this.node, 'Ribbons', (MAX_TRAIL + 1) * 2 * COMETS, MAX_TRAIL * 6 * COMETS, mat(o.debug ? { RIBBON: true, DEBUG_SOLID: true } : { RIBBON: true }, true));
        this._dots = new DynBatch(this.node, 'Dots', 220 * 4, 220 * 6, mat({}, true));
        this._ringBatch = new DynBatch(this.node, 'Rings', 6 * 4, 6 * 6, mat({ RING: true }, true));

        const box = meshUtils().createMesh(primitives.box({ width: 1, height: 1, length: 1 }));
        const makeShell = (name: string) => {
            const n = new Node(name);
            n.layer = this.node.layer;
            this.node.addChild(n);
            const mr = n.addComponent(MeshRenderer);
            mr.mesh = box;
            const m = mat({ SHELL: true });
            mr.setSharedMaterial(m, 0);
            return { n, m };
        };
        const sh = makeShell('Shell');
        this._shellNode = sh.n; this._shellMat = sh.m;
        for (let i = 0; i < GHOSTS; i++) {
            const g = makeShell('Ghost' + i);
            g.n.active = false;
            this._ghosts.push({ node: g.n, mat: g.m, age: 1, life: 0.22 });
        }

        const S = o.blockSize;
        // 彩色光带：每条在不同倾角的轨道上绕方块转（像原子轨道），颜色沿彩虹均匀分布
        const tilts = [0, 38, -38, 68, -68, 90];
        for (let i = 0; i < COMETS; i++) {
            const tilt = tilts[i % tilts.length] * Math.PI / 180, phi = i * Math.PI * 2 / COMETS;
            const nrm = new Vec3();
            Vec3.scaleAndAdd(nrm, nrm, this._axis, Math.cos(tilt));
            Vec3.scaleAndAdd(nrm, nrm, this._u, Math.cos(phi) * Math.sin(tilt));
            Vec3.scaleAndAdd(nrm, nrm, this._v, Math.sin(phi) * Math.sin(tilt));
            nrm.normalize();
            const ref2 = Math.abs(Vec3.dot(nrm, this._u)) < 0.9 ? this._u : this._v;
            const a = new Vec3(); Vec3.cross(a, nrm, ref2).normalize();
            const b = new Vec3(); Vec3.cross(b, nrm, a).normalize();
            this._comets.push({
                hue: i / COMETS, a, b, r: S * (1.0 + 0.07 * i) * o.orbitScale, theta: i * 1.3,
                speedMul: 1 + 0.12 * ((i % 3) - 1), hist: [], head: new Vec3(),
            });
        }
        this._rings.push({ start: 0, life: 0.15 * o.duration + 0.05, from: S * 2.6, to: S * 1.1, alpha: 0.9, pos: this._basePos.clone(), shrink: true, hue: 0.12 });

        this.done = new Promise<void>(res => { this._resolve = res; });
    }

    update(dt: number) {
        if (!this._o) return;
        this._t += dt;
        const o = this._o, S = o.blockSize, T = o.duration, t = this._t;
        const H = this._head, TL = this._tail;
        const block = o.block;
        const alive = block && block.isValid;

        if (this._cam && this._cam.isValid) {
            this._camPos.set(this._cam.worldPosition);
            Vec3.transformQuat(this._right, Vec3.RIGHT, this._cam.worldRotation);
            Vec3.transformQuat(this._up, Vec3.UP, this._cam.worldRotation);
        }

        // ---- 1. 方块运动 ----
        const t0 = 0.15 * T, t1 = 0.8 * T;
        let angle = 0, scale = 1, pop = 0, shellI = 0, flash = 0;
        if (t < t0) {
            const k = t / t0;
            scale = 1 - (1 - o.shrinkTo) * (k * k);                        // 先缩小
            shellI = 0.9 * k;
        } else if (t < t1) {
            const u = (t - t0) / (t1 - t0);
            angle = o.turns * 360 * easeInOutCubic(u);
            pop = o.popOut * S * smooth(0, 0.25, u) * (1 - smooth(0.8, 1, u));
            scale = o.shrinkTo * (1 + 0.06 * Math.sin(u * Math.PI));          // 缩小状态下旋转
            shellI = 0.55;
            if (!this._flipped && u >= 0.5) {
                this._flipped = true;
                if (alive && o.onFlip) { try { o.onFlip(block); } catch (e) { console.error(e); } }
            }
            if (this._flipped) flash = 0.6 * Math.exp(-(u - 0.5) * (t1 - t0) * 12);
        } else {
            const d = t - t1;
            angle = o.turns * 360 + 10 * Math.exp(-10 * d) * Math.sin(25 * d);
            scale = 1 - (1 - o.shrinkTo) * Math.exp(-9 * d) * Math.cos(14 * d);   // 弹回原大小（带过冲）
            flash = 0.6 * Math.exp(-d * 10);
            shellI = 0.55 * Math.max(0, 1 - d / 0.35);
            if (!this._landed) this.land();
            if (d > 0.45 && !this._finished) this.finish();
        }
        const speed = Math.abs(angle - this._lastAngle) / Math.max(dt, 1e-4);   // 度/秒
        this._lastAngle = angle;
        const fast = clamp01((speed - 300) / 900);

        Vec3.scaleAndAdd(this._center, this._basePos, this._outward, pop);
        if (alive && !this._finished) {
            Quat.fromAxisAngle(this._q, this._axis, angle * Math.PI / 180);
            Quat.multiply(this._q2, this._q, this._baseRot);
            block.setWorldPosition(this._center);
            block.setWorldRotation(this._q2);
            block.setScale(this._baseScale.x * scale, this._baseScale.y * scale, this._baseScale.z * scale);
        }

        // ---- 2. 外壳 ----
        const shell = this._shellNode!;
        shell.active = shellI > 0.001 || flash > 0.01;
        if (shell.active) {
            shell.setWorldPosition(this._center);
            shell.setWorldRotation(alive ? block.worldRotation : this._q2);
            const k = S * 1.08 * scale;
            shell.setWorldScale(k, k, k);
            this._shellMat!.setProperty('params', this._v4.set(shellI, t * 1.5, flash, 0));
        }

        // ---- 3. 残影 ----
        if (fast > 0 && t < t1) {
            this._ghostAcc += dt;
            if (this._ghostAcc >= 0.035) {
                this._ghostAcc = 0;
                const g = this._ghosts.find(x => x.age >= x.life);
                if (g) {
                    g.age = 0;
                    g.node.active = true;
                    g.node.setWorldPosition(this._center);
                    g.node.setWorldRotation(this._q2);
                    const k = S * 1.03 * scale;
                    g.node.setWorldScale(k, k, k);
                }
            }
        }
        for (const g of this._ghosts) {
            if (g.age >= g.life) { g.node.active = false; continue; }
            g.age += dt;
            const k = 1 - g.age / g.life;
            g.mat.setProperty('params', this._v4.set(0.5 * k * k, 0, 0.1 * k, 0));
        }

        // ---- 4. 彩色环绕光带（转速和方块无关，始终很快） ----
        const cometOn = t >= t0 * 0.6 && t < t1 + 0.05;
        const env = smooth(t0 * 0.6, t0, t) * (1 - smooth(t1 - 0.1, t1 + 0.05, t));
        for (const c of this._comets) {
            if (cometOn) {
                c.theta += Math.PI * 2 * (3 + 3 * env) * c.speedMul * dt;      // 3~6 圈/秒
                c.hist.push({ theta: c.theta, t });
            }
            while (c.hist.length && t - c.hist[0].t > TRAIL_LIFE) c.hist.shift();
            this.cometPos(c, c.theta, c.head);
        }
        // 沿途彩色闪光
        if (cometOn) {
            this._sparkAcc += dt * 110 * env;
            while (this._sparkAcc >= 1) {
                this._sparkAcc -= 1;
                const c = this._comets[(Math.random() * COMETS) | 0];
                this._sparks.push({
                    pos: c.head.clone(), vel: new Vec3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).multiplyScalar(S * 1.5),
                    age: 0, life: rand(0.25, 0.55), size: S * rand(0.05, 0.11), white: 0.5, hue: c.hue + rand(-0.05, 0.05),
                });
            }
        }
        this.buildRibbons(cometOn);

        // ---- 5. 光点 ----
        const dots = this._dots!;
        dots.begin();
        if (cometOn) {
            for (const c of this._comets) {
                const col = hsvLinear(c.hue + t * 0.3, 1, 1, tmpRGB);
                const fa = env * this.frontFactor(c.head, c.r);
                const hs = Math.max(S * 0.3, this._trailW * 0.9);
                dots.quad(c.head, hs, this._right, this._up, col[0], col[1], col[2], fa);
                dots.quad(c.head, hs * 0.35, this._right, this._up, 1, 1, 1, fa);
            }
        }
        for (let i = this._sparks.length - 1; i >= 0; i--) {
            const p = this._sparks[i];
            p.age += dt;
            if (p.age >= p.life) { this._sparks.splice(i, 1); continue; }
            Vec3.scaleAndAdd(p.pos, p.pos, p.vel, dt);
            p.vel.multiplyScalar(Math.max(0, 1 - 3.5 * dt));
            const k = p.age / p.life, w = p.white * (1 - k);
            const col = hsvLinear(p.hue, 0.8, 1, tmpRGB);
            // 闪烁
            const tw = 0.6 + 0.4 * Math.sin((p.age + p.hue) * 40);
            dots.quad(p.pos, p.size * (1 - 0.5 * k), this._right, this._up,
                lerp(col[0], 1, w), lerp(col[1], 1, w), lerp(col[2], 1, w), (1 - k) * tw);
        }
        dots.commit();

        // ---- 6. 光环 ----
        const rb = this._ringBatch!;
        rb.begin();
        for (let i = this._rings.length - 1; i >= 0; i--) {
            const r = this._rings[i];
            const k = (t - r.start) / r.life;
            if (k >= 1) { this._rings.splice(i, 1); continue; }
            if (k < 0) continue;
            const size = r.shrink ? lerp(r.from, r.to, k * k) : lerp(r.from, r.to, easeOutCubic(k));
            const a = r.shrink ? r.alpha * k : r.alpha * (1 - k) * (1 - k);
            const col = hsvLinear(r.hue, 0.7, 1, tmpRGB);
            rb.quad(r.pos, size * 0.5, this._right, this._up, col[0], col[1], col[2], a);
        }
        rb.commit();

        // ---- 7. 结束 ----
        const busy = this._sparks.length || this._rings.length || this._comets.some(c => c.hist.length) || this._ghosts.some(g => g.age < g.life);
        if (this._finished && !busy && t > t1 + 0.4) this.node.destroy();
    }

    private land() {
        this._landed = true;
        const S = this._o.blockSize, t = this._t;
        this._rings.push({ start: t, life: 0.45, from: S * 1.1, to: S * 4.2, alpha: 1, pos: this._basePos.clone(), shrink: false, hue: 0.12 });
        this._rings.push({ start: t + 0.07, life: 0.5, from: S * 0.9, to: S * 3.0, alpha: 0.8, pos: this._basePos.clone(), shrink: false, hue: 0.55 });
        this._rings.push({ start: t + 0.14, life: 0.5, from: S * 0.8, to: S * 2.2, alpha: 0.6, pos: this._basePos.clone(), shrink: false, hue: 0.85 });
        for (let i = 0; i < 48; i++) {
            const v = new Vec3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize();
            if (Vec3.dot(v, this._outward) < 0) Vec3.scaleAndAdd(v, v, this._outward, -2 * Vec3.dot(v, this._outward));
            this._sparks.push({ pos: this._basePos.clone(), vel: v.multiplyScalar(S * rand(4, 9)), age: 0, life: rand(0.35, 0.7), size: S * rand(0.1, 0.2), white: 0.5, hue: Math.random() });
        }
    }

    private finish() {
        this._finished = true;
        const b = this._o.block;
        if (b && b.isValid) {
            b.setWorldPosition(this._basePos);
            b.setWorldRotation(this._baseRot);
            b.setScale(this._baseScale);
        }
        if (this._shellNode) this._shellNode.active = false;
        const r = this._resolve; this._resolve = null;
        r && r();
    }

    /** 在方块背面（远离摄像机一侧）的点调暗，保留前后层次 */
    private frontFactor(p: Vec3, r: number) {
        const dx = p.x - this._center.x, dy = p.y - this._center.y, dz = p.z - this._center.z;
        const cx = this._camPos.x - this._center.x, cy = this._camPos.y - this._center.y, cz = this._camPos.z - this._center.z;
        const cl = Math.sqrt(cx * cx + cy * cy + cz * cz) || 1;
        const d = (dx * cx + dy * cy + dz * cz) / cl / Math.max(r, 1e-4);
        return lerp(0.25, 1, smooth(-0.6, 0.3, d));
    }

    private cometPos(c: Comet, theta: number, out: Vec3) {
        out.set(this._center);
        Vec3.scaleAndAdd(out, out, c.a, Math.cos(theta) * c.r);
        Vec3.scaleAndAdd(out, out, c.b, Math.sin(theta) * c.r);
        return out;
    }

    /** 光带：按历史角度插值细分，转得再快也是圆滑的弧线；颜色沿光带走一段彩虹 */
    private buildRibbons(live: boolean) {
        const rb = this._ribbon!;
        rb.begin();
        const o = this._o;
        // 光带宽度：默认 blockSize × 0.5，离镜头远时保证屏幕上至少 minTrailPixels 像素
        let W = o.trailWidth ?? o.blockSize * 0.5;
        const cc = this._camComp;
        if (cc && this._cam) {
            const dist = Vec3.distance(this._cam.worldPosition, this._center);
            const hPx = screen.windowSize.height || 1334;
            const worldPerPx = cc.projection === Camera.ProjectionType.PERSPECTIVE
                ? 2 * dist * Math.tan((cc.fov * Math.PI / 180) * 0.5) / hPx
                : (cc.orthoHeight * 2) / hPx;
            W = Math.max(W, o.minTrailPixels * worldPerPx);
        }
        this._trailW = W;
        const SUB = 4;
        const p = this._a, prev = this._b, nxt = new Vec3();
        for (const c of this._comets) {
            const h = c.hist;
            if (h.length < 2) continue;
            // 从新到旧生成采样点 (theta, t)
            const samples: number[] = [];
            for (let i = h.length - 1; i > 0; i--) {
                const s1 = h[i], s0 = h[i - 1];
                for (let k = 0; k < SUB; k++) {
                    const f = k / SUB;
                    samples.push(lerp(s1.theta, s0.theta, f), lerp(s1.t, s0.t, f));
                }
            }
            samples.push(h[0].theta, h[0].t);
            const n = Math.min(samples.length / 2, MAX_TRAIL);
            if (!rb.canAdd(n * 2, (n - 1) * 6)) break;
            const base = rb.vertexCount;
            for (let i = 0; i < n; i++) {
                const th = samples[i * 2], st = samples[i * 2 + 1];
                this.cometPos(c, th, p);
                this.cometPos(c, samples[Math.max(0, i - 1) * 2], prev);
                this.cometPos(c, samples[Math.min(n - 1, i + 1) * 2], nxt);
                Vec3.subtract(nxt, prev, nxt);                      // 切线
                Vec3.subtract(prev, this._camPos, p);               // 指向摄像机
                Vec3.cross(nxt, nxt, prev);
                const len = nxt.length();
                if (len > 1e-6) this._side.set(nxt).multiplyScalar(1 / len);
                const uu = Math.min(1, (this._t - st) / TRAIL_LIFE);
                const hw = W * 0.5 * (0.25 + 0.75 * (1 - uu));
                const col = hsvLinear(c.hue + uu * 0.3 + this._t * 0.3, 1, 1, tmpRGB);
                const fa = this.frontFactor(p, c.r);
                rb.vtx(p.x - this._side.x * hw, p.y - this._side.y * hw, p.z - this._side.z * hw, uu, 0, col[0], col[1], col[2], fa);
                rb.vtx(p.x + this._side.x * hw, p.y + this._side.y * hw, p.z + this._side.z * hw, uu, 1, col[0], col[1], col[2], fa);
            }
            for (let i = 0; i < n - 1; i++) {
                const a = base + i * 2;
                rb.tri(a, a + 1, a + 2);
                rb.tri(a + 1, a + 3, a + 2);
            }
        }
        rb.commit();
        if (o.debug) {
            this._debugAcc += 1;
            if (this._debugAcc % 15 === 1) {
                console.log(`[BlockSpin] t=${this._t.toFixed(2)} ribbons verts=${rb.vertexCount} tris=${rb.indexCount / 3}`
                    + ` hist=${this._comets.map(c => c.hist.length).join(',')} width=${W.toFixed(3)} cam=${this._cam ? this._cam.name : 'NONE'}`);
            }
        }
    }

    /** 找渲染这个方块的 3D 摄像机：能看到该 layer、优先透视投影（避开 UI 正交摄像机） */
    private findCamera(layer: number): Camera | null {
        const cams = director.getScene()?.getComponentsInChildren(Camera) || [];
        let best: Camera | null = null;
        for (const c of cams) {
            if (!c.enabledInHierarchy || (c.visibility & layer) === 0) continue;
            const persp = c.projection === Camera.ProjectionType.PERSPECTIVE;
            if (!best) { best = c; continue; }
            const bestPersp = best.projection === Camera.ProjectionType.PERSPECTIVE;
            if (persp && !bestPersp) best = c;
        }
        return best || cams[0] || null;
    }

    onDestroy() {
        if (!this._finished && this._o) this.finish();
    }
}

/** 线性空间颜色 */
class Linear {
    v = new Vec4(1, 1, 1, 1);
    get x() { return this.v.x; } get y() { return this.v.y; } get z() { return this.v.z; }
    set(c: Color) { this.v.set(toLinear(c.r), toLinear(c.g), toLinear(c.b), 1); }
}
