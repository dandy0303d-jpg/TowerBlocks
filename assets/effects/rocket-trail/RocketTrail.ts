import {
    _decorator, Component, Node, MeshRenderer, Material, EffectAsset, Color, Vec3, Vec4, Mesh,
    Camera, director, utils,
} from 'cc';
const { ccclass, property } = _decorator;

/**
 * 火箭能量拖尾（Cocos Creator 3.8.x）
 *
 * 包含：朝向摄像机的能量光带（动态网格，按时间淡出）、喷口光晕、飘散火花、命中爆散。
 * 拖尾节点挂在场景根上，跟随 target，所以火箭被销毁后拖尾还能自然淡出。
 *
 * 用法一（代码）：
 *   const trail = RocketTrail.attach(rocketNode, this.trailEffect);
 *   // ……火箭飞行（你的 tween / 物理）……
 *   trail.stop(true);          // 命中：爆散 + 淡出，淡完自动销毁
 *   rocketNode.destroy();
 *
 * 用法二（编辑器）：场景里新建空节点挂 RocketTrail，拖入 target 和 effect。
 */
interface TrailPoint { pos: Vec3; t: number; }
interface Spark { pos: Vec3; vel: Vec3; age: number; life: number; size: number; }

const MAX_POINTS = 96;
const MAX_SPARKS = 120;

const srgbToLinear = (c: number) => Math.pow(c / 255, 2.2);
const rand = (a: number, b: number) => a + Math.random() * (b - a);

@ccclass('RocketTrail')
export class RocketTrail extends Component {

    @property({ type: Node, tooltip: '要跟随的火箭节点' })
    target: Node | null = null;

    @property({ type: Node, tooltip: '主摄像机节点（光带要朝向它）。为空时自动找场景里第一个摄像机' })
    cameraNode: Node | null = null;

    @property({ type: EffectAsset, tooltip: '拖入 rocket-trail.effect' })
    trailEffect: EffectAsset | null = null;

    @property({ type: Color, tooltip: '头部颜色（默认橙色，贴近红方块的高温核心）' })
    headColor: Color = new Color(255, 140, 60, 255);

    @property({ type: Color, tooltip: '尾部颜色（默认红，与红方块一致）' })
    tailColor: Color = new Color(255, 40, 30, 255);

    @property({ tooltip: '光带宽度' })
    width = 0.7;

    @property({ tooltip: '拖尾存在时间（秒），越大越长' })
    lifetime = 0.4;

    @property({ tooltip: '喷口在火箭中心后方的距离（沿飞行方向反向）' })
    tailOffset = 0.3;

    @property({ tooltip: '每秒产生的火花数' })
    sparkRate = 70;

    @property({ tooltip: '火花大小' })
    sparkSize = 0.12;

    @property({ tooltip: '喷口光晕大小' })
    glowSize = 0.9;

    @property({ tooltip: '命中爆散的火花数' })
    burstCount = 40;

    @property({ tooltip: '流光速度' })
    flowSpeed = 18;

    @property({ tooltip: '淡出结束后自动销毁拖尾节点' })
    autoDestroy = true;

    /** 代码创建并开始跟随。opts 可覆盖任意属性，如 { width: 0.6, headColor: new Color(...) } */
    static attach(target: Node, effect: EffectAsset, opts?: Partial<RocketTrail>): RocketTrail {
        const node = new Node('RocketTrail');
        node.layer = target.layer;
        director.getScene()!.addChild(node);
        const c = node.addComponent(RocketTrail);
        c.target = target;
        c.trailEffect = effect;
        if (opts) Object.assign(c, opts);
        return c;
    }

    private _inited = false;
    private _emitting = true;
    private _time = 0;
    private _glowAlpha = 0;

    private _points: TrailPoint[] = [];
    private _pointPool: TrailPoint[] = [];
    private _sparks: Spark[] = [];
    private _sparkPool: Spark[] = [];
    private _sparkAcc = 0;

    private _dir = new Vec3(0, 0, 1);
    private _lastTargetPos = new Vec3();
    private _hasLast = false;
    private _dirInit = false;
    private _emitPos = new Vec3();

    private _ribbonMesh: Mesh | null = null;
    private _ribbonMR: MeshRenderer | null = null;
    private _sparkMesh: Mesh | null = null;
    private _sparkMR: MeshRenderer | null = null;

    // 预分配缓冲
    private _rPos = new Float32Array((MAX_POINTS + 1) * 2 * 3);
    private _rUv = new Float32Array((MAX_POINTS + 1) * 2 * 2);
    private _rCol = new Float32Array((MAX_POINTS + 1) * 2 * 4);
    private _rIdx = new Uint16Array(MAX_POINTS * 6);
    private _sPos = new Float32Array((MAX_SPARKS + 1) * 4 * 3);
    private _sUv = new Float32Array((MAX_SPARKS + 1) * 4 * 2);
    private _sCol = new Float32Array((MAX_SPARKS + 1) * 4 * 4);
    private _sIdx = new Uint16Array((MAX_SPARKS + 1) * 6);

    private _tmpA = new Vec3();
    private _tmpB = new Vec3();
    private _side = new Vec3(1, 0, 0);
    private _camPos = new Vec3();
    private _camRight = new Vec3();
    private _camUp = new Vec3();
    private _min = new Vec3();
    private _max = new Vec3();

    get emitting() { return this._emitting; }

    /**
     * 停止喷射，拖尾会按 lifetime 自然淡出。
     * burst=true 时爆散火花；at 为爆散位置（默认喷口）；upward=true 时火花只往上半球溅（适合砸在方块顶面）。
     */
    stop(burst = false, at?: Vec3, upward = false) {
        if (!this._emitting) return;
        this._emitting = false;
        if (burst) this.burst(this.burstCount, at, upward);
    }

    /** 预先指定飞行方向（单位向量），避免刚发射的头几帧拖尾方向不对 */
    setDirection(dir: Vec3) {
        this._dir.set(dir).normalize();
        this._dirInit = true;
    }

    /** 重新开始喷射（例如复用同一条拖尾） */
    restart() {
        this._emitting = true;
        this._hasLast = false;
        for (const p of this._points) this._pointPool.push(p);
        this._points.length = 0;
    }

    /** 爆散火花。at 默认为喷口位置；upward=true 时只往上半球溅 */
    burst(count = this.burstCount, at?: Vec3, upward = false) {
        if (at) this._emitPos.set(at);
        for (let i = 0; i < count; i++) {
            const s = this.newSpark();
            if (!s) break;
            s.pos.set(this._emitPos);
            this.randomUnit(s.vel);
            if (upward) { s.vel.y = Math.abs(s.vel.y) * 0.7 + 0.2; s.vel.normalize(); }
            s.vel.multiplyScalar(rand(3, 7));
            s.life = rand(0.35, 0.7);
            s.size = this.sparkSize * rand(1.0, 1.8);
        }
        this._glowAlpha = 1.6;
    }

    // ------------------------------------------------------------------

    update(dt: number) {
        if (!this._inited && !this.init()) return;
        this._time += dt;

        const target = this.target;
        if (!target || !target.isValid || !target.activeInHierarchy) this._emitting = false;

        // ---- 1. 跟随目标，记录轨迹点 ----
        if (this._emitting && target) {
            const p = target.worldPosition;
            if (this._hasLast) {
                Vec3.subtract(this._tmpA, p, this._lastTargetPos);
                const len = this._tmpA.length();
                if (len > 1e-4) {
                    this._tmpA.multiplyScalar(1 / len);
                    if (this._dirInit) {
                        Vec3.lerp(this._dir, this._dir, this._tmpA, Math.min(1, dt * 20));
                        this._dir.normalize();
                    } else {
                        this._dir.set(this._tmpA);
                        this._dirInit = true;
                    }
                }
            }
            this._lastTargetPos.set(p);
            this._hasLast = true;

            Vec3.scaleAndAdd(this._emitPos, p, this._dir, -this.tailOffset);

            const last = this._points[this._points.length - 1];
            const minSeg = 0.04;
            if (this._dirInit && (!last || Vec3.distance(last.pos, this._emitPos) >= minSeg)) {
                if (this._points.length >= MAX_POINTS) this._pointPool.push(this._points.shift()!);
                const np = this._pointPool.pop() || { pos: new Vec3(), t: 0 };
                np.pos.set(this._emitPos);
                np.t = this._time;
                this._points.push(np);
            }

            // 喷射火花
            this._sparkAcc += this.sparkRate * dt;
            while (this._dirInit && this._sparkAcc >= 1) {
                this._sparkAcc -= 1;
                const s = this.newSpark();
                if (!s) break;
                s.pos.set(this._emitPos);
                this.randomUnit(s.vel);
                s.vel.multiplyScalar(rand(0.6, 1.6));
                Vec3.scaleAndAdd(s.vel, s.vel, this._dir, -rand(1, 3));
                s.life = rand(0.25, 0.55);
                s.size = this.sparkSize * rand(0.6, 1.2);
            }
            this._glowAlpha = Math.max(this._glowAlpha - dt * 4, 1);
        } else {
            this._glowAlpha = Math.max(0, this._glowAlpha - dt * 6);
        }

        // 移除过期的轨迹点
        while (this._points.length && this._time - this._points[0].t > this.lifetime) {
            this._pointPool.push(this._points.shift()!);
        }

        // 更新火花
        const damp = Math.max(0, 1 - 3 * dt);
        for (let i = this._sparks.length - 1; i >= 0; i--) {
            const s = this._sparks[i];
            s.age += dt;
            if (s.age >= s.life) {
                this._sparkPool.push(s);
                this._sparks.splice(i, 1);
                continue;
            }
            Vec3.scaleAndAdd(s.pos, s.pos, s.vel, dt);
            s.vel.multiplyScalar(damp);
        }

        // ---- 2. 摄像机朝向 ----
        const cam = this.cameraNode;
        if (cam && cam.isValid) {
            this._camPos.set(cam.worldPosition);
            Vec3.transformQuat(this._camRight, Vec3.RIGHT, cam.worldRotation);
            Vec3.transformQuat(this._camUp, Vec3.UP, cam.worldRotation);
        }

        this.buildRibbon();
        this.buildSparks();

        // ---- 3. 结束 ----
        if (!this._emitting && this._points.length === 0 && this._sparks.length === 0 && this._glowAlpha <= 0) {
            if (this.autoDestroy) this.node.destroy();
        }
    }

    private init(): boolean {
        if (!this.trailEffect) return false;
        if (!this.cameraNode) {
            const camComp = director.getScene()?.getComponentInChildren(Camera);
            if (camComp) this.cameraNode = camComp.node;
        }
        this.node.setPosition(0, 0, 0);
        this.node.setRotationFromEuler(0, 0, 0);
        this.node.setScale(1, 1, 1);

        const ribbonNode = new Node('Ribbon');
        ribbonNode.layer = this.node.layer;
        this.node.addChild(ribbonNode);
        this._ribbonMR = ribbonNode.addComponent(MeshRenderer);
        this._ribbonMesh = this.createDynMesh((MAX_POINTS + 1) * 2, MAX_POINTS * 6);
        this._ribbonMR.mesh = this._ribbonMesh;
        this._ribbonMR.setSharedMaterial(this.createMat(true), 0);

        const sparkNode = new Node('Sparks');
        sparkNode.layer = this.node.layer;
        this.node.addChild(sparkNode);
        this._sparkMR = sparkNode.addComponent(MeshRenderer);
        this._sparkMesh = this.createDynMesh((MAX_SPARKS + 1) * 4, (MAX_SPARKS + 1) * 6);
        this._sparkMR.mesh = this._sparkMesh;
        this._sparkMR.setSharedMaterial(this.createMat(false), 0);

        if (this.target) {
            this._emitPos.set(this.target.worldPosition);
        }
        this._inited = true;
        return true;
    }

    private createMat(ribbon: boolean): Material {
        const mat = new Material();
        mat.initialize({ effectAsset: this.trailEffect!, technique: 0, defines: { RIBBON: ribbon } });
        mat.setProperty('headColor', this.headColor);
        mat.setProperty('tailColor', this.tailColor);
        mat.setProperty('params', new Vec4(this.flowSpeed, 22, 1, 0));
        return mat;
    }

    private createDynMesh(maxV: number, maxI: number): Mesh {
        const geo: any = {
            positions: new Float32Array(12),
            uvs: new Float32Array(8),
            colors: new Float32Array(16),
            indices16: new Uint16Array([0, 1, 2, 0, 2, 3]),
            minPos: new Vec3(-1, -1, -1),
            maxPos: new Vec3(1, 1, 1),
        };
        const MU: any = (utils as any).MeshUtils || utils;
        return MU.createDynamicMesh(0, geo, undefined, {
            maxSubMeshes: 1,
            maxSubMeshVertices: maxV,
            maxSubMeshIndices: maxI,
        });
    }

    private commit(mesh: Mesh, mr: MeshRenderer, nv: number, ni: number,
        pos: Float32Array, uv: Float32Array, col: Float32Array, idx: Uint16Array) {
        if (nv === 0) {
            // 空的时候提交一个看不见的退化三角形
            pos.fill(0, 0, 12); col.fill(0, 0, 16); uv.fill(0, 0, 8);
            idx[0] = 0; idx[1] = 1; idx[2] = 2; idx[3] = 0; idx[4] = 2; idx[5] = 3;
            nv = 4; ni = 6;
            this._min.set(-1, -1, -1); this._max.set(1, 1, 1);
        }
        const geo: any = {
            positions: pos.subarray(0, nv * 3),
            uvs: uv.subarray(0, nv * 2),
            colors: col.subarray(0, nv * 4),
            indices16: idx.subarray(0, ni),
            minPos: this._min,
            maxPos: this._max,
        };
        (mesh as any).updateSubMesh(0, geo);
        const m: any = mr;
        if (m.onGeometryChanged) m.onGeometryChanged();
    }

    private resetBounds() {
        this._min.set(Infinity, Infinity, Infinity);
        this._max.set(-Infinity, -Infinity, -Infinity);
    }

    private growBounds(x: number, y: number, z: number) {
        const a = this._min, b = this._max;
        if (x < a.x) a.x = x; if (y < a.y) a.y = y; if (z < a.z) a.z = z;
        if (x > b.x) b.x = x; if (y > b.y) b.y = y; if (z > b.z) b.z = z;
    }

    private buildRibbon() {
        const pts = this._points;
        // 头部实时点
        const n = pts.length + (this._emitting ? 1 : 0);
        const P = this._rPos, U = this._rUv, C = this._rCol, I = this._rIdx;
        if (n < 2) { this.commit(this._ribbonMesh!, this._ribbonMR!, 0, 0, P, U, C, I); return; }

        const getPos = (k: number) => (k < pts.length ? pts[k].pos : this._emitPos);
        const getT = (k: number) => (k < pts.length ? pts[k].t : this._time);

        this.resetBounds();
        let v = 0;
        // i = 0 为头部（最新），往尾部遍历
        for (let i = 0; i < n; i++) {
            const k = n - 1 - i;
            const pos = getPos(k);
            const prev = getPos(Math.min(n - 1, k + 1));
            const next = getPos(Math.max(0, k - 1));
            Vec3.subtract(this._tmpA, prev, next);                // 切线
            Vec3.subtract(this._tmpB, this._camPos, pos);          // 指向摄像机
            Vec3.cross(this._tmpA, this._tmpA, this._tmpB);
            const len = this._tmpA.length();
            if (len > 1e-5) this._side.set(this._tmpA).multiplyScalar(1 / len);

            const u = Math.min(1, (this._time - getT(k)) / this.lifetime);
            const hw = this.width * 0.5 * (0.35 + 0.65 * (1 - u));

            for (let s = 0; s < 2; s++) {
                const sign = s === 0 ? -1 : 1;
                const x = pos.x + this._side.x * hw * sign;
                const y = pos.y + this._side.y * hw * sign;
                const z = pos.z + this._side.z * hw * sign;
                P[v * 3] = x; P[v * 3 + 1] = y; P[v * 3 + 2] = z;
                U[v * 2] = u; U[v * 2 + 1] = s;
                C[v * 4] = 1; C[v * 4 + 1] = 1; C[v * 4 + 2] = 1; C[v * 4 + 3] = 1;
                this.growBounds(x, y, z);
                v++;
            }
        }
        let ii = 0;
        for (let i = 0; i < n - 1; i++) {
            const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
            I[ii++] = a; I[ii++] = b; I[ii++] = c;
            I[ii++] = b; I[ii++] = d; I[ii++] = c;
        }
        this.commit(this._ribbonMesh!, this._ribbonMR!, v, ii, P, U, C, I);
    }

    private buildSparks() {
        const P = this._sPos, U = this._sUv, C = this._sCol, I = this._sIdx;
        const hc = this.headColor, tc = this.tailColor;
        const hr = srgbToLinear(hc.r), hg = srgbToLinear(hc.g), hb = srgbToLinear(hc.b);
        const tr = srgbToLinear(tc.r), tg = srgbToLinear(tc.g), tb = srgbToLinear(tc.b);
        let q = 0;
        this.resetBounds();

        const quad = (px: number, py: number, pz: number, size: number, r: number, g: number, b: number, a: number) => {
            const R = this._camRight, Up = this._camUp;
            const base = q * 4;
            for (let c = 0; c < 4; c++) {
                const sx = (c === 1 || c === 2) ? 1 : -1;
                const sy = (c >= 2) ? 1 : -1;
                const x = px + (R.x * sx + Up.x * sy) * size;
                const y = py + (R.y * sx + Up.y * sy) * size;
                const z = pz + (R.z * sx + Up.z * sy) * size;
                const vi = base + c;
                P[vi * 3] = x; P[vi * 3 + 1] = y; P[vi * 3 + 2] = z;
                U[vi * 2] = sx * 0.5 + 0.5; U[vi * 2 + 1] = sy * 0.5 + 0.5;
                C[vi * 4] = r; C[vi * 4 + 1] = g; C[vi * 4 + 2] = b; C[vi * 4 + 3] = a;
                this.growBounds(x, y, z);
            }
            const ii = q * 6;
            I[ii] = base; I[ii + 1] = base + 1; I[ii + 2] = base + 2;
            I[ii + 3] = base; I[ii + 4] = base + 2; I[ii + 5] = base + 3;
            q++;
        };

        // 喷口光晕（带闪烁）
        if (this._glowAlpha > 0) {
            const flicker = 0.9 + 0.1 * Math.sin(this._time * 45) + 0.05 * Math.sin(this._time * 97);
            const e = this._emitPos;
            quad(e.x, e.y, e.z, this.glowSize * 0.5 * flicker * Math.min(1.4, this._glowAlpha), hr, hg, hb, Math.min(1, this._glowAlpha));
        }
        for (const s of this._sparks) {
            const k = s.age / s.life;
            quad(s.pos.x, s.pos.y, s.pos.z, s.size * (1 - k * 0.5),
                hr + (tr - hr) * k, hg + (tg - hg) * k, hb + (tb - hb) * k, 1 - k);
        }
        this.commit(this._sparkMesh!, this._sparkMR!, q * 4, q * 6, P, U, C, I);
    }

    private newSpark(): Spark | null {
        if (this._sparks.length >= MAX_SPARKS) return null;
        const s = this._sparkPool.pop() || { pos: new Vec3(), vel: new Vec3(), age: 0, life: 1, size: 0.1 };
        s.age = 0;
        this._sparks.push(s);
        return s;
    }

    private randomUnit(out: Vec3) {
        const z = rand(-1, 1), a = rand(0, Math.PI * 2), r = Math.sqrt(1 - z * z);
        out.set(r * Math.cos(a), r * Math.sin(a), z);
    }
}
