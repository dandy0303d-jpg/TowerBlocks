/**
 * Rocket exhaust trail — self-contained per-instance ribbon.
 *
 * Attach this component to a Node (typically the rocket-cube prefab or
 * any node that MOVES per frame). Every frame `update(dt)` reads the
 * host node's WORLD position and appends it to a rolling history
 * buffer, then rebuilds a 3-layer triangle-strip mesh that reads as a
 * flame plume trailing behind the host: outer wine red, middle amber,
 * inner white-hot core.
 *
 * Because state lives ON the component (not in a shared pool + slot
 * map), pool re-use is handled by a simple position-jump heuristic:
 * if the host teleports more than `resetDistance` in one frame, the
 * history clears (assumed to be a new rocket instance in the same
 * pooled cube).
 *
 * Author flow:
 *   1. Drop the component on the rocket-cube prefab (or on a child
 *      node aligned with the cube's centre).
 *   2. Save the prefab.
 *   3. Done — no code wiring needed; the trail follows the host.
 */

import {
    _decorator,
    Component,
    Node,
    MeshRenderer,
    Material,
    Color,
    Mesh,
    Vec3,
    utils,
} from 'cc';

const { ccclass, property } = _decorator;

/** One flame layer's config — sample count from tail, half-width
 *  scale relative to `unitSize`, radial outward offset for z-sort,
 *  and tint. */
interface LayerConfig {
    samples: number;
    widthMul: number;
    radialOffset: number;
    color: Color;
}

@ccclass('RocketTrailFX')
export class RocketTrailFX extends Component {

    /** Baseline size — the ribbon's width scales off this. Match the
     *  host cube's edge length so the trail reads as "same size as the
     *  bullet". Default 1.0 (Cocos world unit == 1 cell). */
    @property
    unitSize: number = 1.0;

    /** Movement threshold that triggers a history reset. Pooled hosts
     *  teleport between rockets (last rocket's land position → new
     *  rocket's spawn); a big jump means the trail should start
     *  fresh. Kept generous so slow-moving rockets don't hit it. */
    @property
    resetDistance: number = 2.5;

    /** Outer layer — biggest, coolest, lowest radial offset. */
    @property(Color)
    outerColor: Color = new Color(105, 25, 45, 180);
    @property
    outerSamples: number = 12;
    @property
    outerWidthMul: number = 0.55;
    @property
    outerRadialOffset: number = 0.08;

    /** Middle layer — amber. */
    @property(Color)
    middleColor: Color = new Color(255, 190, 70, 220);
    @property
    middleSamples: number = 8;
    @property
    middleWidthMul: number = 0.35;
    @property
    middleRadialOffset: number = 0.12;

    /** Inner layer — hot white core, most-forward radial. */
    @property(Color)
    innerColor: Color = new Color(255, 240, 200, 240);
    @property
    innerSamples: number = 5;
    @property
    innerWidthMul: number = 0.18;
    @property
    innerRadialOffset: number = 0.16;

    // ---------- Internal state ----------

    private layers: LayerConfig[] = [];
    /** One child Node per layer (built in onLoad). */
    private layerNodes: Node[] = [];
    private layerMRs: MeshRenderer[] = [];
    private layerMeshes: (Mesh | null)[] = [];
    /** Rolling world-position history, newest at END. */
    private history: Vec3[] = [];
    /** Cached last-frame position so we can detect a teleport. */
    private lastPos: Vec3 | null = null;
    /** Cached last-frame active state — used to detect an off→on
     *  transition (pool re-activation) so we reset the buffer. */
    private wasActive: boolean = false;

    onLoad(): void {
        this.layers = [
            { samples: this.outerSamples,  widthMul: this.outerWidthMul,  radialOffset: this.outerRadialOffset,  color: this.outerColor  },
            { samples: this.middleSamples, widthMul: this.middleWidthMul, radialOffset: this.middleRadialOffset, color: this.middleColor },
            { samples: this.innerSamples,  widthMul: this.innerWidthMul,  radialOffset: this.innerRadialOffset,  color: this.innerColor  },
        ];
        // Build one ribbon child per layer. Parented OUTSIDE this
        // component's host node — otherwise the trail inherits the
        // host's per-frame transform (setPosition + setRotationFromEuler
        // in the cube-mover) and rotates around with the cube each
        // frame. Attaching to the host's PARENT keeps trail vertices
        // in the same local space we sample from.
        const parent = this.node.parent;
        if (!parent) {
            console.warn('[RocketTrailFX] no parent — trail disabled');
            return;
        }
        for (let i = 0; i < this.layers.length; i++) {
            const layer = this.layers[i];
            const n = new Node(`RocketTrail_L${i}`);
            n.parent = parent;
            n.layer  = parent.layer;
            n.active = false;
            const mr = n.addComponent(MeshRenderer);
            const mat = new Material();
            mat.initialize({ effectName: 'builtin-unlit', technique: 1 });
            mat.setProperty('mainColor', layer.color);
            mr.material = mat;
            this.layerNodes.push(n);
            this.layerMRs.push(mr);
            this.layerMeshes.push(null);
        }
    }

    onDestroy(): void {
        for (const n of this.layerNodes) if (n && n.isValid) n.destroy();
        for (const m of this.layerMeshes) if (m) m.destroy();
        this.layerNodes = [];
        this.layerMRs = [];
        this.layerMeshes = [];
    }

    /** onDisable fires when the host node.active flips to false —
     *  Cocos then STOPS calling update() on this component, so the
     *  in-update "hide layers on inactive" branch never runs and the
     *  ribbon lingers on screen forever. Handle the teardown here
     *  instead: deactivate every layer Node + wipe history so the
     *  next onEnable + first update() starts fresh (matches pool
     *  reuse expectations). */
    onDisable(): void {
        for (const n of this.layerNodes) if (n && n.isValid && n.active) n.active = false;
        this.history.length = 0;
        this.lastPos = null;
        this.wasActive = false;
    }

    update(_dt: number): void {
        // Defense in depth — update() shouldn't fire while inactive
        // (see onDisable), but if it does, clean up rather than
        // render a stale trail.
        if (!this.node.active) {
            if (this.wasActive) {
                for (const n of this.layerNodes) if (n.active) n.active = false;
                this.history.length = 0;
                this.lastPos = null;
            }
            this.wasActive = false;
            return;
        }
        this.wasActive = true;

        // Read host's WORLD position — trail lives in host's PARENT
        // local space (same space we passed to render code), so use
        // node.worldPosition converted back to parent local. Since
        // the parent's world transform is what we care about and
        // the ribbon Nodes are siblings of the host, we can use
        // getPosition() (local == parent-space) after the cube-
        // mover has set the host's local position for this frame.
        const p = new Vec3();
        this.node.getPosition(p);

        // Teleport detection: if the host jumped further than
        // resetDistance since last frame, treat as pool re-use.
        if (this.lastPos) {
            const dx = p.x - this.lastPos.x;
            const dy = p.y - this.lastPos.y;
            const dz = p.z - this.lastPos.z;
            const dsqr = dx * dx + dy * dy + dz * dz;
            const reset2 = this.resetDistance * this.resetDistance;
            if (dsqr > reset2) {
                this.history.length = 0;
                // Pre-seed a small "trail-came-from-above" history so
                // the flame reads full from frame 1 instead of ramping
                // up over the first ~4 frames. Assumes vertical fall.
                for (let k = 3; k >= 1; k--) {
                    this.history.push(new Vec3(p.x, p.y + k * this.unitSize, p.z));
                }
            }
        } else {
            // First frame ever — same pre-seed as above.
            for (let k = 3; k >= 1; k--) {
                this.history.push(new Vec3(p.x, p.y + k * this.unitSize, p.z));
            }
        }
        this.history.push(p.clone());
        this.lastPos = p;
        // Cap at longest layer's window.
        const maxSamples = this.layers[0]?.samples ?? 12;
        while (this.history.length > maxSamples) this.history.shift();

        this.rebuild();
    }

    private rebuild(): void {
        const tmpB = new Vec3();
        for (let li = 0; li < this.layers.length; li++) {
            const layer = this.layers[li];
            const node  = this.layerNodes[li];
            const mr    = this.layerMRs[li];
            if (!node || !mr) continue;
            const takeFrom = Math.max(0, this.history.length - layer.samples);
            const slice = this.history.slice(takeFrom);
            const N = slice.length;
            if (N < 2) {
                if (node.active) node.active = false;
                continue;
            }
            if (!node.active) node.active = true;

            const positions: number[] = [];
            const indices:   number[] = [];
            const halfWidthBase = this.unitSize * layer.widthMul * 0.5;
            for (let i = 0; i < N; i++) {
                const q = slice[i];
                // Surface tangent at this sample's (x, z): theta =
                // atan2(x, z). Ribbon width lays along the cylinder
                // wall's horizontal tangent.
                const theta = Math.atan2(q.x, q.z);
                tmpB.set(Math.cos(theta), 0, -Math.sin(theta));
                // Push outward from the cylinder axis by radialOffset.
                const nX = Math.sin(theta);
                const nZ = Math.cos(theta);
                const qx = q.x + nX * layer.radialOffset;
                const qz = q.z + nZ * layer.radialOffset;
                const taper = i / (N - 1);   // 0 oldest → 1 newest
                const halfWidth = halfWidthBase * taper;
                positions.push(
                    qx + tmpB.x * halfWidth,
                    q.y + tmpB.y * halfWidth,
                    qz + tmpB.z * halfWidth,
                    qx - tmpB.x * halfWidth,
                    q.y - tmpB.y * halfWidth,
                    qz - tmpB.z * halfWidth,
                );
            }
            for (let i = 0; i < N - 1; i++) {
                const a = i * 2;
                indices.push(a, a + 2, a + 1);
                indices.push(a + 1, a + 2, a + 3);
            }
            const next: Mesh = utils.MeshUtils.createMesh({ positions, indices });
            mr.mesh = next;
            const prev = this.layerMeshes[li];
            if (prev) prev.destroy();
            this.layerMeshes[li] = next;
        }
    }
}
