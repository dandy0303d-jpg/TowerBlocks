import {
    _decorator, Component, Node, MeshRenderer, Material, EffectAsset, Color, Vec3, Vec4,
    utils, primitives, Mesh,
} from 'cc';
const { ccclass, property } = _decorator;

/**
 * 塔快速旋转特效（Cocos Creator 3.8.x）
 *
 * 时间轴：
 *   加速 accelTime   塔离地微微浮起，转速平滑拉满，螺旋气流罩和地面旋转光环随转速变亮
 *   高速 holdTime    全速旋转；中点调用 onPeak（可在这里洗牌/换色，玩家看不清变化）
 *   减速 decelTime   减速并自动停在「列对齐」的角度，带一点回摆
 *   落地 settleTime  塔落回地面，轻微压扁回弹 + 小震屏，特效淡出
 *
 * 旋转是在塔当前角度上叠加的，结束角度 = 起始角度 + 整数个列间隔，不会打乱玩家已有的朝向对齐。
 *
 * 用法：
 *   await this.spinFx.play(() => {
 *       this.board.shuffle();   // 高速旋转时执行
 *   });
 */
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (t: number) => t * t * (3 - 2 * t);

// 减速曲线：带回摆的 easeOutBack
const BACK_C1 = 0.8, BACK_C3 = BACK_C1 + 1;
const backOut = (u: number) => 1 + BACK_C3 * Math.pow(u - 1, 3) + BACK_C1 * Math.pow(u - 1, 2);
const backOutD = (u: number) => 3 * BACK_C3 * Math.pow(u - 1, 2) + 2 * BACK_C1 * (u - 1);
const BACK_D0 = backOutD(0);

function buildMesh(geo: any): Mesh {
    const u: any = utils;
    return (u.MeshUtils && u.MeshUtils.createMesh) ? u.MeshUtils.createMesh(geo) : u.createMesh(geo);
}

interface FxPart { node: Node; mat: Material; }

@ccclass('SpinTowerEffect')
export class SpinTowerEffect extends Component {

    @property({ type: Node, tooltip: '圆柱塔根节点（绕 Y 轴旋转）' })
    tower: Node | null = null;

    @property({ type: Node, tooltip: '要震动的摄像机节点，可为空' })
    cameraNode: Node | null = null;

    @property({ type: EffectAsset, tooltip: '拖入 spin-swirl.effect' })
    swirlEffect: EffectAsset | null = null;

    @property({ type: EffectAsset, tooltip: '拖入 gravity-ring.effect（与重力压制共用）' })
    ringEffect: EffectAsset | null = null;

    @property({ tooltip: '塔的半径（塔父节点坐标系）' })
    towerRadius = 2.2;

    @property({ tooltip: '塔的高度（塔父节点坐标系）' })
    towerHeight = 6;

    @property({ tooltip: '塔底相对塔节点原点的本地 Y。原点在塔底填 0；在中心填 -高度/2' })
    towerBottomY = 0;

    @property({ tooltip: '每圈的列数，用来让停下时方块对齐' })
    columnCount = 20;

    @property({ type: Color })
    color: Color = new Color(190, 140, 255, 255);

    @property({ tooltip: '最高转速（圈/秒）' })
    maxTurnsPerSec = 3;

    @property({ tooltip: '旋转方向：1 = 从上往下看逆时针，-1 = 顺时针' })
    direction = 1;

    @property({ tooltip: '加速时间（秒）' })
    accelTime = 0.4;

    @property({ tooltip: '全速保持时间（秒）' })
    holdTime = 0.6;

    @property({ tooltip: '减速时间（秒），会自动微调以对齐列' })
    decelTime = 0.7;

    @property({ tooltip: '落地回弹 + 淡出时间（秒）' })
    settleTime = 0.5;

    @property({ tooltip: '高速时塔浮起的高度' })
    liftHeight = 0.25;

    @property({ range: [0, 0.2, 0.01], slide: true, tooltip: '落地压扁比例' })
    landSquash = 0.06;

    @property({ tooltip: '落地震屏幅度' })
    shakeStrength = 0.06;

    private _root: Node | null = null;
    private _inner: FxPart | null = null;
    private _outer: FxPart | null = null;
    private _ground: FxPart | null = null;

    private _playing = false;
    private _t = 0;
    private _peakFired = false;
    private _onPeak: (() => void) | null = null;
    private _resolve: (() => void) | null = null;

    // 预计算的时间轴
    private _vmax = 0;          // 度/秒
    private _decelStart = 0;
    private _decelDur = 0;
    private _angleAtDecel = 0;
    private _angleTarget = 0;

    private _phaseIn = 0;
    private _phaseOut = 0;
    private _ringPhase = 0;

    private _towerPos = new Vec3();
    private _towerScale = new Vec3();
    private _towerEuler = new Vec3();
    private _camPos = new Vec3();
    private _v4a = new Vec4();
    private _v4b = new Vec4();

    get isPlaying() { return this._playing; }

    /** 播放旋转。onPeak 在全速阶段中点调用；Promise 在完全结束时 resolve。 */
    play(onPeak?: () => void): Promise<void> {
        if (!this.tower || !this.swirlEffect || !this.ringEffect) {
            console.warn('[SpinTowerEffect] 请先设置 tower / swirlEffect / ringEffect');
            onPeak && onPeak();
            return Promise.resolve();
        }
        if (this._playing) this.finish();
        this.build();

        const tower = this.tower;
        this._towerPos.set(tower.position);
        this._towerScale.set(tower.scale);
        this._towerEuler.set(tower.eulerAngles);
        if (this.cameraNode) this._camPos.set(this.cameraNode.position);

        // ---- 预计算：保证减速段速度连续，并停在列对齐角度 ----
        const dir = this.direction >= 0 ? 1 : -1;
        const step = 360 / Math.max(1, Math.round(this.columnCount));
        this._vmax = this.maxTurnsPerSec * 360;
        this._decelStart = this.accelTime + this.holdTime;
        this._angleAtDecel = this._vmax * this.accelTime / 3 + this._vmax * this.holdTime;
        const minDist = this._vmax * this.decelTime / BACK_D0;
        this._angleTarget = Math.ceil((this._angleAtDecel + minDist) / step) * step;
        this._decelDur = (this._angleTarget - this._angleAtDecel) * BACK_D0 / this._vmax;
        if (dir < 0) { this._angleAtDecel = -this._angleAtDecel; this._angleTarget = -this._angleTarget; }

        const root = this._root!;
        root.setPosition(
            this._towerPos.x,
            this._towerPos.y + this.towerBottomY * this._towerScale.y,
            this._towerPos.z,
        );
        root.active = true;
        for (const p of [this._inner!, this._outer!, this._ground!]) {
            p.mat.setProperty('mainColor', this.color);
        }

        this._t = 0;
        this._phaseIn = this._phaseOut = this._ringPhase = 0;
        this._peakFired = false;
        this._onPeak = onPeak || null;
        this._playing = true;
        this.update(0);

        return new Promise<void>(res => { this._resolve = res; });
    }

    stop() {
        if (this._playing) this.finish();
    }

    update(dt: number) {
        if (!this._playing) return;
        this._t += dt;

        const t = this._t;
        const dir = this.direction >= 0 ? 1 : -1;
        const vmax = this._vmax;
        const A = Math.max(this.accelTime, 1e-4);
        const D0 = this._decelStart;
        const DT = Math.max(this._decelDur, 1e-4);
        const landT = D0 + DT;

        // ---- 1. 旋转角度 & 当前转速 ----
        let angle: number;
        let speed: number;  // 度/秒（绝对值）
        if (t < A) {
            angle = vmax * t * t * t / (3 * A * A);
            speed = vmax * (t / A) * (t / A);
            angle *= dir;
        } else if (t < D0) {
            angle = dir * (vmax * A / 3 + vmax * (t - A));
            speed = vmax;
        } else if (t < landT) {
            const u = (t - D0) / DT;
            angle = lerp(this._angleAtDecel, this._angleTarget, backOut(u));
            speed = Math.abs((this._angleTarget - this._angleAtDecel) * backOutD(u) / DT);
        } else {
            angle = this._angleTarget;
            speed = 0;
        }
        const sn = clamp01(speed / Math.max(vmax, 1e-4));   // 归一化转速 0~1

        if (!this._peakFired && t >= this.accelTime + this.holdTime * 0.5) {
            this._peakFired = true;
            const cb = this._onPeak; this._onPeak = null;
            if (cb) { try { cb(); } catch (e) { console.error(e); } }
        }

        // ---- 2. 塔：旋转 + 浮起 + 落地回弹 ----
        const tower = this.tower!;
        const e = this._towerEuler;
        tower.setRotationFromEuler(e.x, e.y + angle, e.z);

        const lift = this.liftHeight * smooth(sn);
        let sy = 1;
        const dl = t - landT;
        if (dl >= 0) sy = 1 - this.landSquash * Math.exp(-7 * dl) * Math.sin(16 * dl);
        const sxz = 1 + (1 - sy) * 0.5;
        const s = this._towerScale;
        tower.setScale(s.x * sxz, s.y * sy, s.z * sxz);
        tower.setPosition(
            this._towerPos.x,
            this._towerPos.y + lift + this.towerBottomY * s.y * (1 - sy),
            this._towerPos.z,
        );

        // ---- 3. 落地小震屏 ----
        if (this.cameraNode) {
            if (dl >= 0 && dl < 0.25) {
                const f = 1 - dl / 0.25;
                const amp = this.shakeStrength * f * f;
                this.cameraNode.setPosition(
                    this._camPos.x + (Math.random() * 2 - 1) * amp,
                    this._camPos.y + (Math.random() * 2 - 1) * amp,
                    this._camPos.z,
                );
            } else {
                this.cameraNode.setPosition(this._camPos);
            }
        }

        // ---- 4. 特效 ----
        const R = this.towerRadius, H = this.towerHeight;
        const fade = dl >= 0 ? 1 - clamp01(dl / this.settleTime) : 1;
        const vis = Math.pow(sn, 0.7) * fade;
        const turns = speed / 360 * dt;                 // 本帧转过的圈数
        this._phaseIn += turns * 1.6;
        this._phaseOut += turns * 2.4;
        this._ringPhase += turns * 10;

        const inner = this._inner!;
        inner.node.setPosition(0, lift + H * 0.55, 0);
        inner.node.setScale(R * 1.08, H * 1.1, R * 1.08);
        inner.mat.setProperty('params', this._v4a.set(vis * 1.2, this._phaseIn * 7 * dir, 7, 1.2));
        inner.mat.setProperty('params2', this._v4b.set(6, 0.3, dir, 0));

        const outer = this._outer!;
        outer.node.setPosition(0, lift + H * 0.5, 0);
        outer.node.setScale(R * 1.35, H * 0.9, R * 1.35);
        outer.mat.setProperty('params', this._v4a.set(vis * 0.8, this._phaseOut * 4 * dir, 4, -0.8));
        outer.mat.setProperty('params2', this._v4b.set(10, 0.15, dir, 0));

        const ground = this._ground!;
        const gD = R * 2 * lerp(1.25, 1.6, sn);
        ground.node.setPosition(0, 0.03, 0);
        ground.node.setScale(gD, 1, gD);
        ground.mat.setProperty('params', this._v4a.set(0.78, 0.05, vis * 1.6, 16));
        ground.mat.setProperty('params2', this._v4b.set(this._ringPhase * dir, 0.35, 0.6, 0));

        if (dl >= this.settleTime) this.finish();
    }

    onDestroy() {
        if (this._playing) this.finish();
        if (this._root && this._root.isValid) this._root.destroy();
    }

    // ------------------------------------------------------------------

    private finish() {
        this._playing = false;
        if (!this._peakFired) {
            this._peakFired = true;
            const cb = this._onPeak; this._onPeak = null;
            if (cb) { try { cb(); } catch (e) { console.error(e); } }
        }
        if (this.tower) {
            const e = this._towerEuler;
            this.tower.setRotationFromEuler(e.x, e.y + this._angleTarget, e.z);
            this.tower.setScale(this._towerScale);
            this.tower.setPosition(this._towerPos);
        }
        if (this.cameraNode) this.cameraNode.setPosition(this._camPos);
        if (this._root) this._root.active = false;
        const res = this._resolve; this._resolve = null;
        res && res();
    }

    private build() {
        if (this._root) return;
        const tower = this.tower!;
        const root = new Node('SpinTowerFx');
        root.layer = tower.layer;
        tower.parent!.addChild(root);

        const cyl = buildMesh(primitives.cylinder(1, 1, 1, { radialSegments: 64, heightSegments: 1, capped: false } as any));
        // Cocos 3.8's `primitives.plane` takes ONLY an opts object.
        const plane = buildMesh(primitives.plane({ width: 1, length: 1, widthSegments: 1, lengthSegments: 1 } as any));

        this._inner = this.makePart('SwirlInner', cyl, this.swirlEffect!, root);
        this._outer = this.makePart('SwirlOuter', cyl, this.swirlEffect!, root);
        this._ground = this.makePart('GroundRing', plane, this.ringEffect!, root);

        root.active = false;
        this._root = root;
    }

    private makePart(name: string, mesh: Mesh, effect: EffectAsset, parent: Node): FxPart {
        const node = new Node(name);
        node.layer = parent.layer;
        parent.addChild(node);
        const mr = node.addComponent(MeshRenderer);
        const mat = new Material();
        mat.initialize({ effectAsset: effect, technique: 0 });
        mr.mesh = mesh;
        mr.setSharedMaterial(mat, 0);
        return { node, mat };
    }
}
