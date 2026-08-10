import {
    _decorator,
    Component,
    Node,
    Mesh,
    MeshRenderer,
    Material,
    Color,
    Texture2D,
    utils,
    log,
} from 'cc';

const { ccclass, property } = _decorator;

/**
 * Single soft mist quad at the base of the tower.
 *
 * One billboard quad, one draw call, one material — cheaper and
 * visually cleaner than the previous ring-of-puffs approach.
 *
 * The quad is parented to the camera so it always sits at a fixed
 * screen position in front of the cylinder, with a soft radial
 * gradient texture (white centre, transparent edges) tinted to
 * whatever atmosphere colour matches the scene's sky.
 *
 * Because the camera in this game is fixed, the quad needs no
 * per-frame billboarding maths — its orientation is set once in
 * build() and `update()` is a no-op (the component doesn't even
 * declare one, saving the per-frame visit).
 */
@ccclass('TowerBaseMist')
export class TowerBaseMist extends Component {

    /** Drag `MainCamera3D` here. Quad parents under this node so it
     *  always renders in front of the lens regardless of camera move. */
    @property(Node)
    cameraNode: Node | null = null;

    /** Drag the SpriteFrame for a cloud texture here. Leave empty to
     *  fall back to a procedural soft radial gradient (default). */
    @property
    useProceduralTexture: boolean = true;

    /** Local position of the quad in the camera's frame. Cocos cameras
     *  look toward local −Z, so a negative Z value puts the quad in
     *  front of the camera. */
    @property
    localX: number = 0;
    @property
    localY: number = -3.5;
    @property
    localZ: number = -50;

    /** Quad size in world units (at the local Z above). With ortho
     *  projection the visible vertical span is ~20 and width ~11.2,
     *  so a 20 × 8 quad blankets the bottom third of the screen. */
    @property
    width: number = 20;
    @property
    height: number = 8;

    /** Tint colour multiplied with the white radial gradient. Default
     *  is a deep cosmic navy; lift toward (220, 225, 240) for
     *  bright daytime themes. */
    @property
    tint: Color = new Color(40, 35, 65, 255);

    /** Peak opacity at the centre of the gradient. */
    @property({ range: [0.0, 1.0, 0.05] })
    opacity: number = 0.7;

    private quad: Node | null = null;
    private mat: Material | null = null;
    private cloudTex: Texture2D | null = null;

    onLoad(): void {
        this.build();
        if (this.quad) this.quad.active = false;
        log(`[TowerBaseMist] onLoad — quad built: ${!!this.quad}`);
    }

    public setVisible(on: boolean): void {
        if (this.quad) this.quad.active = on;
    }

    private build(): void {
        if (this.quad) return; // idempotent

        const parent = this.cameraNode ?? this.node;
        const quad = new Node('TowerBaseMistQuad');
        quad.parent = parent;
        quad.layer  = parent.layer;
        quad.setPosition(this.localX, this.localY, this.localZ);
        // Parented to the camera → local −Z is the view-forward axis.
        // Quad's mesh sits in local XY with normal +Z, so no rotation
        // needed: the front face naturally points at the camera origin.

        this.cloudTex = this.makeCloudTexture(256);

        const hw = this.width  / 2;
        const hh = this.height / 2;
        const mesh: Mesh = utils.MeshUtils.createMesh({
            positions: [
                -hw, -hh, 0,
                 hw, -hh, 0,
                 hw,  hh, 0,
                -hw,  hh, 0,
            ],
            normals: [
                0, 0, 1,  0, 0, 1,  0, 0, 1,  0, 0, 1,
            ],
            // V mapped 1→0 from bottom to top so the gradient renders
            // right-side-up (the cosine texture is rotation-symmetric
            // so it doesn't actually matter, kept for consistency).
            uvs: [
                0, 1,
                1, 1,
                1, 0,
                0, 0,
            ],
            indices: [0, 1, 2, 0, 2, 3],
        });

        const mr = quad.addComponent(MeshRenderer);
        mr.mesh = mesh;

        const mat = new Material();
        mat.initialize({
            effectName: 'builtin-unlit',
            technique: 1,                         // transparent
            defines: { USE_TEXTURE: true },
        });
        mat.setProperty('mainTexture', this.cloudTex);
        mat.setProperty('mainColor', new Color(
            this.tint.r, this.tint.g, this.tint.b,
            Math.round(this.opacity * 255),
        ));
        mr.material = mat;

        this.quad = quad;
        this.mat  = mat;
    }

    /** Procedural soft cloud texture — wide elliptical gradient that
     *  fades smoothly to zero at the edges. We use raised-cosine
     *  (cos²) along both axes so the falloff has a long soft tail
     *  rather than a sharp ring. The X axis fades 1.4× slower than Y
     *  so the quad reads as a horizontal fog band, not a circular
     *  cloud blob. */
    private makeCloudTexture(size: number): Texture2D {
        const buf = new Uint8Array(size * size * 4);
        const cx = size / 2;
        const cy = size / 2;
        const rxMax = size / 2;
        const ryMax = size / 2;
        for (let y = 0; y < size; y++) {
            for (let x = 0; x < size; x++) {
                // Anisotropic distance: the X axis is "softer" so the
                // gradient extends wider horizontally than vertically.
                const rx = Math.abs(x - cx) / rxMax / 1.4;
                const ry = Math.abs(y - cy) / ryMax;
                const r = Math.min(1, Math.sqrt(rx * rx + ry * ry));
                const c = Math.cos(r * Math.PI / 2);
                const alpha = c * c;
                const i = (y * size + x) * 4;
                buf[i]     = 255;
                buf[i + 1] = 255;
                buf[i + 2] = 255;
                buf[i + 3] = Math.round(alpha * 255);
            }
        }
        const tex = new Texture2D();
        tex.reset({ width: size, height: size, format: Texture2D.PixelFormat.RGBA8888 });
        tex.uploadData(buf);
        return tex;
    }

    onDestroy(): void {
        if (this.quad && this.quad.isValid) this.quad.destroy();
        this.quad = null;
        this.mat  = null;
    }
}
