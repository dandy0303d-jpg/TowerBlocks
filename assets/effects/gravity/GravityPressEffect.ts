import {
    _decorator, Component, Node, MeshRenderer, Material, EffectAsset, Color, Vec3, Vec4,
    Prefab, instantiate, utils, primitives, Mesh, tween,
} from 'cc';
const { ccclass, property } = _decorator;

/**
 * 重力压制特效（Cocos Creator 3.8.x）
 *
 * 时间轴：
 *   蓄力 chargeTime   塔顶出现旋转的能量光环 + 圆柱能量罩淡入
 *   下压 pressTime    光环和光带从塔顶加速压到塔底，罩上条纹加速向下流，塔被逐渐压扁
 *   冲击              震屏 + 地面冲击波 + 回调 onImpact（在这里执行你的落块逻辑）
 *   回弹 recoverTime  塔弹簧式回弹，特效淡出，结束后 Promise resolve
 *
 * 用法：
 *   await this.gravityFx.play(() => {
 *       // 在冲击瞬间执行游戏逻辑：让方块下落填补空隙
 *       dropBlocks(this.board.applyGravity());
 *   });
 */
const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeOutBack = (t: number) => {
    const c1 = 1.70158, c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

function buildMesh(geo: any): Mesh {
    const u: any = utils;
    return (u.MeshUtils && u.MeshUtils.createMesh) ? u.MeshUtils.createMesh(geo) : u.createMesh(geo);
}

interface FxPart { node: Node; mat: Material; }

@ccclass('GravityPressEffect')
export class GravityPressEffect extends Component {

    @property({ type: Node, tooltip: '圆柱塔的根节点（会被压扁并回弹）' })
    tower: Node | null = null;

    @property({ type: Node, tooltip: '要震动的摄像机节点，可为空' })
    cameraNode: Node | null = null;

    @property({ type: EffectAsset, tooltip: '拖入 gravity-field.effect' })
    fieldEffect: EffectAsset | null = null;

    @property({ type: EffectAsset, tooltip: '拖入 gravity-ring.effect' })
    ringEffect: EffectAsset | null = null;

    @property({ type: Prefab, tooltip: '冲击瞬间在塔底生成的粒子预制体（烟尘/碎光），可为空' })
    impactPrefab: Prefab | null = null;

    @property({ tooltip: '塔的半径（塔父节点坐标系）' })
    towerRadius = 2.2;

    @property({ tooltip: '塔的高度（塔父节点坐标系）' })
    towerHeight = 6;

    @property({ tooltip: '塔底相对塔节点原点的本地 Y。原点就在塔底则填 0；原点在塔中心则填 -高度/2' })
    towerBottomY = 0;

    @property({ type: Color })
    color: Color = new Color(70, 165, 255, 255);

    @property({ tooltip: '蓄力时间（秒）' })
    chargeTime = 0.2;

    @property({ tooltip: '下压时间（秒）' })
    pressTime = 0.45;

    @property({ tooltip: '冲击后回弹 + 淡出时间（秒），建议 ≥ 0.7' })
    recoverTime = 0.9;

    @property({ range: [0, 0.4, 0.01], slide: true, tooltip: '最大压扁比例' })
    squash = 0.12;

    @property({ tooltip: '震屏幅度（摄像机本地单位）' })
    shakeStrength = 0.12;

    @property({ tooltip: '震屏时长（秒）' })
    shakeTime = 0.35;

    private _root: Node | null = null;
    private _shell: FxPart | null = null;
    private _band: FxPart | null = null;
    private _lid: FxPart | null = null;
    private _wave: FxPart | null = null;

    private _playing = false;
    private _impacted = false;
    private _t = 0;
    private _flowPhase = 0;
    private _rotPhase = 0;
    private _onImpact: (() => void) | null = null;
    private _resolve: (() => void) | null = null;

    private _towerPos = new Vec3();
    private _towerScale = new Vec3();
    private _camPos = new Vec3();
    private _v4a = new Vec4();
    private _v4b = new Vec4();

    get isPlaying() { return this._playing; }

    /** 播放特效。onImpact 在冲击瞬间调用，返回的 Promise 在特效完全结束时 resolve。 */
    play(onImpact?: () => void): Promise<void> {
        if (!this.tower || !this.fieldEffect || !this.ringEffect) {
            console.warn('[GravityPressEffect] 请先设置 tower / fieldEffect / ringEffect');
            onImpact && onImpact();
            return Promise.resolve();
        }
        if (this._playing) this.finish();
        this.build();

        const tower = this.tower;
        this._towerPos.set(tower.position);
        this._towerScale.set(tower.scale);
        if (this.cameraNode) this._camPos.set(this.cameraNode.position);

        const root = this._root!;
        root.setPosition(
            this._towerPos.x,
            this._towerPos.y + this.towerBottomY * this._towerScale.y,
            this._towerPos.z,
        );
        root.active = true;
        for (const p of [this._shell!, this._band!, this._lid!, this._wave!]) {
            p.mat.setProperty('mainColor', this.color);
        }

        this._t = 0;
        this._flowPhase = 0;
        this._rotPhase = 0;
        this._impacted = false;
        this._onImpact = onImpact || null;
        this._playing = true;
        this.update(0);

        return new Promise<void>(res => { this._resolve = res; });
    }

    /** 立即结束并复原（塔、摄像机）。 */
    stop() {
        if (this._playing) this.finish();
    }

    update(dt: number) {
        if (!this._playing) return;
        this._t += dt;

        const t = this._t;
        const R = this.towerRadius;
        const H = this.towerHeight;
        const tImpact = this.chargeTime + this.pressTime;

        const k = clamp01(t / Math.max(this.chargeTime, 1e-4));               // 蓄力进度
        const p = clamp01((t - this.chargeTime) / Math.max(this.pressTime, 1e-4)); // 下压进度
        const pe = p * p;                                                     // 加速下压
        const d = t - tImpact;                                                // 冲击后时间
        const after = d >= 0;

        this._flowPhase += dt * (0.6 + 3.5 * pe);
        this._rotPhase += dt * (1.5 + 6 * pe);

        const lidY = lerp(H + 0.35, 0.08, pe);

        // ---- 1. 圆柱能量罩 ----
        const shellH = H * 1.2;
        const shellR = R * 1.12;
        const shellI = easeOutCubic(k) * (after ? 1 - clamp01(d / 0.5) : 1);
        const shell = this._shell!;
        shell.node.setPosition(0, shellH * 0.5, 0);
        shell.node.setScale(shellR, shellH, shellR);
        shell.mat.setProperty('params', this._v4a.set(shellI, this._flowPhase, 6, 0.8));
        shell.mat.setProperty('params2', this._v4b.set(
            lidY / shellH,
            after ? 1.2 * (1 - clamp01(d / 0.2)) : 1.2,
            0.25,
            0.35,
        ));

        // ---- 2. 下压光带 ----
        const bandI = easeOutCubic(k) * (after ? 1 - clamp01(d / 0.25) : 1) * (1.5 + pe);
        const band = this._band!;
        band.node.setPosition(0, lidY, 0);
        band.node.setScale(R * 1.18, 0.35, R * 1.18);
        band.mat.setProperty('params', this._v4a.set(bandI, 0, 0, 0));
        band.mat.setProperty('params2', this._v4b.set(-1, 0, 0, 1.0));

        // ---- 3. 顶部压制光环 ----
        const lidD = R * 2 * 1.45 * Math.max(0.001, easeOutBack(k));
        const lidI = k * (after ? 1 - clamp01(d / 0.2) : 1) * 1.6;
        const lid = this._lid!;
        lid.node.setPosition(0, lidY + 0.01, 0);
        lid.node.setScale(lidD, 1, lidD);
        lid.mat.setProperty('params', this._v4a.set(0.72, 0.05, lidI, 24));
        lid.mat.setProperty('params2', this._v4b.set(this._rotPhase, 0.6, 0.5, 0));

        // ---- 4. 地面冲击波 ----
        const wave = this._wave!;
        if (after) {
            const sp = clamp01(d / 0.65);
            const waveD = lerp(R * 2.2, R * 7, easeOutCubic(sp));
            wave.node.active = sp < 1;
            wave.node.setPosition(0, 0.03, 0);
            wave.node.setScale(waveD, 1, waveD);
            wave.mat.setProperty('params', this._v4a.set(0.9, lerp(0.08, 0.02, sp), (1 - sp) * (1 - sp) * 2, 0));
            wave.mat.setProperty('params2', this._v4b.set(0, 0.25 * (1 - sp), 0.6, 0));
        } else {
            wave.node.active = false;
        }

        // ---- 5. 塔压扁 / 弹簧回弹 ----
        let sy: number;
        if (!after) {
            sy = 1 - this.squash * pe;
        } else {
            sy = 1 - this.squash * Math.exp(-6 * d) * Math.cos(18 * d);
        }
        this.applyTowerSquash(sy);

        // ---- 6. 冲击瞬间 ----
        if (after && !this._impacted) this.doImpact();

        // ---- 7. 震屏 ----
        if (this.cameraNode && after) {
            if (d < this.shakeTime) {
                const f = 1 - d / this.shakeTime;
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

        if (after && d >= this.recoverTime) this.finish();
    }

    onDestroy() {
        if (this._playing) this.finish();
        if (this._root && this._root.isValid) this._root.destroy();
    }

    // ------------------------------------------------------------------

    private applyTowerSquash(sy: number) {
        const tower = this.tower;
        if (!tower) return;
        const sxz = 1 + (1 - sy) * 0.5;   // 压扁时略微变胖
        const s = this._towerScale;
        tower.setScale(s.x * sxz, s.y * sy, s.z * sxz);
        // 以塔底为支点缩放
        tower.setPosition(
            this._towerPos.x,
            this._towerPos.y + this.towerBottomY * s.y * (1 - sy),
            this._towerPos.z,
        );
    }

    private doImpact() {
        this._impacted = true;
        if (this.impactPrefab && this._root) {
            const fx = instantiate(this.impactPrefab);
            this._root.parent!.addChild(fx);
            fx.setPosition(this._root.position);
            this.scheduleOnce(() => { if (fx.isValid) fx.destroy(); }, 3);
        }
        const cb = this._onImpact;
        this._onImpact = null;
        if (cb) {
            try { cb(); } catch (e) { console.error(e); }
        }
    }

    private finish() {
        if (!this._impacted) this.doImpact();   // 保证游戏逻辑一定执行
        this._playing = false;
        if (this.tower) {
            this.tower.setScale(this._towerScale);
            this.tower.setPosition(this._towerPos);
        }
        if (this.cameraNode) this.cameraNode.setPosition(this._camPos);
        if (this._root) this._root.active = false;
        const res = this._resolve;
        this._resolve = null;
        res && res();
    }

    private build() {
        if (this._root) return;
        const tower = this.tower!;
        const root = new Node('GravityPressFx');
        root.layer = tower.layer;
        tower.parent!.addChild(root);

        const cyl = buildMesh(primitives.cylinder(1, 1, 1, { radialSegments: 64, heightSegments: 1, capped: false } as any));
        // Cocos 3.8's `primitives.plane` takes ONLY an opts object —
        // passing width/height as positional args (as the author-side
        // sample did) makes Cocos treat `1` as opts and blow up with
        // "Cannot create property 'includeNormal' on number '1'".
        const plane = buildMesh(primitives.plane({ width: 1, length: 1, widthSegments: 1, lengthSegments: 1 } as any));

        this._shell = this.makePart('Shell', cyl, this.fieldEffect!, root);
        this._band = this.makePart('Band', cyl, this.fieldEffect!, root);
        this._lid = this.makePart('Lid', plane, this.ringEffect!, root);
        this._wave = this.makePart('Shockwave', plane, this.ringEffect!, root);

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

/**
 * 辅助：让方块下落到目标高度，带落地弹跳。低处的先落，高处的依次跟上。
 * items 由你的棋盘逻辑算出（每个方块的节点 + 下落后的本地 Y）。
 */
export function dropBlocks(items: { node: Node; toY: number }[], delayPerUnit = 0.03): Promise<void> {
    if (items.length === 0) return Promise.resolve();
    let minY = Infinity;
    for (const it of items) minY = Math.min(minY, it.node.position.y);

    let maxEnd = 0;
    for (const it of items) {
        const pos = it.node.position;
        const dist = pos.y - it.toY;
        if (dist <= 1e-4) continue;
        const dur = 0.18 + Math.sqrt(dist) * 0.12;
        const delay = (pos.y - minY) * delayPerUnit;
        maxEnd = Math.max(maxEnd, delay + dur);
        tween(it.node)
            .delay(delay)
            .to(dur, { position: new Vec3(pos.x, it.toY, pos.z) }, { easing: 'bounceOut' })
            .start();
    }
    return new Promise<void>(res => {
        tween({ v: 0 }).delay(maxEnd).call(() => res()).start();
    });
}
