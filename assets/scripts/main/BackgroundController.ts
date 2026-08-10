import {
    _decorator,
    Component,
    Node,
    Mesh,
    MeshRenderer,
    Material,
    SpriteFrame,
    utils,
    log,
} from 'cc';

const { ccclass, property } = _decorator;

/**
 * Renders a parallax background image behind the 3D playfield.
 *
 * Strategy
 * --------
 * The source image is portrait-aspect (sky → aurora → temples → marble
 * base, top to bottom). We want the player to see the LOWER portion of
 * the image when their tower is short, and the UPPER portion (stars +
 * sky) when the tower is tall — without ever stretching the artwork.
 *
 *  - Quad sits in front of the camera, sized LARGER than the visible
 *    frustum (oversize keeps the image at its natural aspect while
 *    leaving headroom for vertical scrolling).
 *  - Quad's `position.y` slides up/down each frame based on the tower's
 *    accumulated altitude — read from `BoardRoot3D.position.y` (the
 *    camera-follow offset, which is negative as the tower grows).
 *  - UVs span the whole texture (no `tilingOffset` games), so the image
 *    keeps its native pixel-to-world ratio — no warping.
 *
 * Sizing — keep aspect ratio
 * --------------------------
 * The 749 × 1343 source PNG has aspect ≈ 0.557. To avoid distortion
 * the quad must have the SAME width-to-height ratio. The inspector
 * fields are exposed individually so you can tune the look, but if
 * you change one, change the other proportionally:
 *
 *     height = width / 0.557
 *
 * Default 22 × 39.5 covers the screen with roughly ±10 world units
 * of vertical scroll headroom. Bump both up together (e.g. 30 × 53.8)
 * if you want more sky-to-ground travel; shrink for less.
 *
 * Render order
 * ------------
 * The quad lives in the 3D world (MainCamera3D pass, priority 0), so
 * the UI camera (priority 1) cleanly composites HUD + menus on top.
 * The quad sits at view z = −distance, behind the cylinder's farthest
 * vertex, and is occluded naturally by the tower.
 */
@ccclass('BackgroundController')
export class BackgroundController extends Component {

    /** Drag `MainCamera3D` here. The quad parents to this node so it
     *  follows camera transforms automatically. */
    @property(Node)
    cameraNode: Node | null = null;

    /** Drag `BoardRoot3D` here. Its local Y position IS the camera-
     *  follow offset (negative as the tower grows). Leave empty to
     *  pin the background mid-scroll (no altitude reaction). */
    @property(Node)
    boardRoot: Node | null = null;

    /** Drag the SpriteFrame for `assets/textures/background.png` here. */
    @property(SpriteFrame)
    backgroundSprite: SpriteFrame | null = null;

    /** Distance in front of the camera along its forward axis (camera
     *  looks toward −Z). 85 keeps the quad behind the cylinder's back
     *  edge (~view z −70) and well clear of the far plane (100). */
    @property
    distance: number = 85;

    /** Quad size in world units. **Keep width / height ≈ 0.557** to
     *  match the source PNG's aspect — anything else distorts the
     *  artwork. The quad is intentionally LARGER than the camera
     *  frustum (≈ 11.2 × 20 in ORTHO) so that
     *
     *    (height − viewHeight) / 2
     *
     *  is the vertical room available for altitude-based scrolling. */
    @property
    width: number = 22;
    @property
    height: number = 39.5;

    /** Camera's ortho-height visible span in world units. ORTHO @
     *  orthoHeight 10 → visible height = 20. Used to compute the
     *  available scroll range. If you switch the camera to PERSPECTIVE,
     *  estimate the visible height at the placement distance and
     *  put that number here. */
    @property
    viewHeight: number = 20;

    /** Tower altitude (= −BoardRoot3D.y) at which the background has
     *  scrolled all the way from "ground" to "sky". Smaller = sky
     *  arrives faster; larger = sky reserved for very tall towers.
     *  60 world units ≈ 60 stacked rows. */
    @property
    fullScrollAltitude: number = 60;

    /** Flip V coordinate. Cocos imports PNGs with top-left origin —
     *  `flipV=true` makes "image top" land at world +Y (right-side up).
     *  Toggle if the artwork renders upside down. */
    @property
    flipV: boolean = true;

    private quad: Node | null = null;
    private mat: Material | null = null;
    /** Cached half-extents so update() doesn't recompute each frame. */
    private halfHeight = 0;
    /** Last Y position we wrote to the quad — avoids redundant setPosition
     *  calls when the board is stationary. */
    private lastQuadY = Number.NaN;
    /** Last `boardRoot.position.y` we observed. Skipping the per-frame
     *  parallax compute when it hasn't changed makes update() effectively
     *  free on stable frames. */
    private lastOffsetY = Number.NaN;

    onLoad(): void {
        this.build();
        if (this.quad) this.quad.active = false;
        log(`[BackgroundController] onLoad — quad built: ${!!this.quad}`);
    }

    public setVisible(on: boolean): void {
        if (on && !this.quad) this.build();
        if (this.quad) this.quad.active = on;
        log(`[BackgroundController] setVisible(${on}) — quad active: ${this.quad?.active}`);
    }

    update(_dt: number): void {
        if (!this.quad || !this.quad.active) return;

        // Early-out: no scroll target wired up → nothing to drive the
        // parallax. Quad stays at whatever position build() set.
        if (!this.boardRoot) return;

        // Available scroll travel in each direction. If the quad isn't
        // any larger than the visible frustum there's no headroom to
        // move it; skip the update so we don't snap-jitter the artwork.
        const maxScroll = (this.height - this.viewHeight) / 2;
        if (maxScroll <= 0) return;

        // Skip the whole compute when the board hasn't moved since the
        // last frame — the lerp in GameController has a deadband, so on
        // most frames `position.y` doesn't change.
        const offsetY = this.boardRoot.position.y;
        if (offsetY === this.lastOffsetY) return;
        this.lastOffsetY = offsetY;

        const altitude = Math.max(0, -offsetY);
        const t = Math.min(1, altitude / Math.max(0.001, this.fullScrollAltitude));

        // Map altitude → quad Y in camera-local frame.
        //   At t=0 we want the BOTTOM of the artwork (marble base) at
        //   the view bottom — that means shifting the quad UPWARD so its
        //   bottom edge aligns with the view's bottom edge. Concretely
        //   quad.y = +maxScroll.
        //   At t=1 we want the TOP of the artwork (stars) visible — quad
        //   shifted DOWN: quad.y = −maxScroll.
        // `flipV` only affects which texture V maps to "image top", not
        // the direction we want to push the quad — but if the user
        // toggles flipV (image rendered upside down) the relationship
        // inverts, so we flip the scroll direction too.
        const dir = this.flipV ? 1 : -1;
        const quadY = dir * maxScroll * (1 - 2 * t);

        if (quadY !== this.lastQuadY) {
            this.lastQuadY = quadY;
            this.quad.setPosition(0, quadY, -Math.abs(this.distance));
        }
    }

    private build(): void {
        if (!this.backgroundSprite) {
            log('[BackgroundController] backgroundSprite not set — skipping build.');
            return;
        }
        const tex = this.backgroundSprite.texture;
        if (!tex) {
            log('[BackgroundController] SpriteFrame has no underlying texture.');
            return;
        }

        const parent = this.cameraNode ?? this.node;
        const quad = new Node('BackgroundQuad');
        quad.parent = parent;
        quad.layer  = parent.layer;
        // Initial position at altitude 0 — will be repositioned each
        // frame by `update()` based on the board offset.
        quad.setPosition(0, 0, -Math.abs(this.distance));
        log(`[BackgroundController] build — parent="${parent.name}" tex="${(tex as any).name ?? '?'}" size=${this.width}x${this.height} viewHeight=${this.viewHeight} flipV=${this.flipV}`);

        const hw = this.width  / 2;
        const hh = this.height / 2;
        this.halfHeight = hh;

        // UV mapping. With flipV=true, mesh BL.v=1 maps texture V=1 to
        // the quad's bottom edge — for Cocos's PNG import convention
        // that lands the image right-side up. Toggle in inspector if
        // your texture pipeline differs.
        const vTop = this.flipV ? 0 : 1;
        const vBot = this.flipV ? 1 : 0;

        // Vertices BL → BR → TR → TL. Indices [0,1,2, 0,2,3] wind CCW
        // from the camera viewpoint (+Z side of the quad), so the
        // textured face is front-facing under default backface culling.
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
            uvs: [
                0, vBot,
                1, vBot,
                1, vTop,
                0, vTop,
            ],
            indices: [0, 1, 2, 0, 2, 3],
        });

        const mr = quad.addComponent(MeshRenderer);
        mr.mesh = mesh;

        const mat = new Material();
        // USE_TEXTURE define is mandatory — without it the unlit shader
        // optimises its sampler out and `setProperty('mainTexture', …)`
        // becomes a no-op, leaving the quad coloured by `mainColor`
        // (default white).
        mat.initialize({
            effectName: 'builtin-unlit',
            defines: { USE_TEXTURE: true },
        });
        mat.setProperty('mainTexture', tex);
        mr.material = mat;

        this.quad = quad;
        this.mat  = mat;
    }

    onDestroy(): void {
        if (this.quad && this.quad.isValid) {
            this.quad.destroy();
        }
        this.quad = null;
        this.mat  = null;
    }
}
