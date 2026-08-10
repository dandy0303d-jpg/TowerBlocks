import {
    _decorator,
    Component,
    Node,
    MeshRenderer,
    Material,
    Color,
    Mesh,
    Vec3,
    log,
} from 'cc';

const { ccclass, property } = _decorator;

/**
 * Shape-following bloom halo for item prefabs.
 *
 * Instead of wrapping the prop in a sphere or cube, this component finds
 * the prop's own MeshRenderer and clones its mesh into `layers` copies,
 * each scaled UP slightly more than the last. Every copy uses a fresh
 * `builtin-unlit` transparent material with a soft, decreasing alpha,
 * so the stack reads as a glowing aura that hugs the prop's actual
 * silhouette — including all its zigzag corners, the "1" digit, etc.
 *
 * Drop on the prefab's ROOT node. Auto-corrects for parent scale via
 * parenting halo layers under the mesh node itself (so they share the
 * mesh's local transform without us having to think about scale).
 *
 * Tunables in inspector:
 *   • innerExpand  – how much bigger the brightest layer is vs the mesh
 *   • outerExpand  – how much bigger the faintest layer is
 *   • baseAlpha    – innermost layer alpha (others fall off quadratically)
 *   • haloColor    – RGB tint (alpha here unused)
 *   • pulseRate / pulseAmount / pulseScale – optional breathing animation
 */
@ccclass('ItemHalo')
export class ItemHalo extends Component {

    // ---------- Layer stack ----------

    /** Number of inflated shells. 4 = chunky band, 6–8 = smooth bloom,
     *  >10 starts to look like fog and costs draw calls. */
    @property({ range: [1, 20, 1] })
    layers: number = 6;

    /** Scale offset of the innermost (brightest) halo layer vs the mesh
     *  itself. 0.03 = barely poking out as a thin rim; bigger = chunkier
     *  inner band. */
    @property
    innerExpand: number = 0.05;

    /** Scale offset of the outermost (faintest) halo layer. 0.5 = halo
     *  extends 50% past the mesh's silhouette; 0.8 = generous bloom. */
    @property
    outerExpand: number = 0.55;

    /** Base alpha (0–255) of the innermost layer. Outer layers scale
     *  this down quadratically toward zero. */
    @property({ range: [0, 255, 1] })
    baseAlpha: number = 110;

    /** RGB tint (alpha here is unused — per-layer alphas come from
     *  baseAlpha + falloff). Warm cream reads as a natural glow. */
    @property
    haloColor: Color = new Color(255, 240, 200, 255);

    // ---------- Pulse ----------

    /** Pulses per second. 0 = steady glow. */
    @property
    pulseRate: number = 1.0;

    /** Alpha swing as a fraction of base alpha. 0.20 = ±20%. */
    @property
    pulseAmount: number = 0.20;

    /** Uniform scale-breath amplitude on the halo root. 0 = disabled. */
    @property
    pulseScale: number = 0.04;

    // ---------- Internal state ----------

    private root: Node | null = null;
    /** Per-layer material instance (independent alphas pulsed in sync). */
    private layerMats: Material[] = [];
    /** Per-layer baseline alpha at build time. */
    private layerBaseAlphas: number[] = [];
    private t = 0;

    onLoad(): void {
        // Find the prop's own MeshRenderer to borrow its mesh.
        const sourceMR =
            this.node.getComponent(MeshRenderer)
            ?? this.node.getComponentInChildren(MeshRenderer);
        if (!sourceMR || !sourceMR.mesh) {
            log('[ItemHalo] no MeshRenderer / mesh found on this prefab — halo disabled.');
            return;
        }
        this.buildLayers(sourceMR);
    }

    private buildLayers(sourceMR: MeshRenderer): void {
        const meshNode = sourceMR.node;
        const mesh = sourceMR.mesh!;

        // Parent halo layers UNDER the mesh node so they automatically
        // inherit its local transform (position, rotation, scale). We
        // only have to worry about the extra-expand scale factor here.
        this.root = new Node('Halo');
        this.root.parent = meshNode;
        this.root.layer  = meshNode.layer;
        this.root.setPosition(0, 0, 0);

        const N = Math.max(1, this.layers | 0);
        for (let i = 0; i < N; i++) {
            const t = N > 1 ? i / (N - 1) : 0;          // 0 → 1 inner→outer
            const expand = this.innerExpand + t * (this.outerExpand - this.innerExpand);
            const scale  = 1 + expand;
            // Quadratic alpha falloff: bright inner, near-zero outer.
            const aF = (1 - t) * (1 - t);
            const a  = Math.max(0, Math.min(255, Math.floor(this.baseAlpha * aF)));

            const mat = new Material();
            mat.initialize({ effectName: 'builtin-unlit', technique: 1 });
            mat.setProperty('mainColor', new Color(
                this.haloColor.r, this.haloColor.g, this.haloColor.b, a,
            ));
            this.layerMats.push(mat);
            this.layerBaseAlphas.push(a);

            const n = new Node(`Halo_${i}`);
            n.parent = this.root;
            n.layer  = this.root.layer;
            const mr = n.addComponent(MeshRenderer);
            mr.mesh = mesh;
            mr.material = mat;
            n.setScale(scale, scale, scale);
        }
    }

    update(dt: number): void {
        if (!this.root || this.layerMats.length === 0) return;
        this.t += dt;
        const wave = Math.sin(this.t * this.pulseRate * Math.PI * 2);
        const mult = 1 + wave * this.pulseAmount;

        for (let i = 0; i < this.layerMats.length; i++) {
            const a = Math.max(0, Math.min(255,
                Math.floor(this.layerBaseAlphas[i] * mult),
            ));
            this.layerMats[i].setProperty('mainColor', new Color(
                this.haloColor.r, this.haloColor.g, this.haloColor.b, a,
            ));
        }

        if (this.pulseScale > 0) {
            const ssk = 1 + wave * this.pulseScale;
            this.root.setScale(ssk, ssk, ssk);
        }
    }
}
