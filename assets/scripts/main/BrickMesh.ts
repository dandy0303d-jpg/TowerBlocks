import { Mesh, utils } from 'cc';

/**
 * Builds a procedural "curved wedge brick" mesh — one column slice of the
 * cylindrical wall.
 *
 *  - Arc width:   12.5°  (300° visual span ÷ 24 columns)
 *  - Height:      1.0 unit along +Y
 *  - Thickness:   0.5 unit (inner-to-outer)
 *  - Centroid:    at local origin
 *  - Local +Z:    points radially outward from the cylinder axis
 *
 * Built from 6 faces; each face's vertices are listed in CCW order **as seen
 * from outside the brick along that face's normal**, so the two triangles
 * 0→1→2 and 0→2→3 both have the correct outward-facing normals (no
 * back-face culling surprises).
 */

const ARC_ANGLE     = (Math.PI * 300 / 180) / 24;   // 12.5° in radians
const HALF_ARC      = ARC_ANGLE / 2;
const CELL_HEIGHT   = 1.0;
const HALF_HEIGHT   = CELL_HEIGHT / 2;
const THICKNESS     = 0.5;
const HALF_THICK    = THICKNESS / 2;
/** Cylinder radius at brick centroid so that chord = CELL_HEIGHT. */
const R_CENTER      = CELL_HEIGHT / (2 * Math.sin(HALF_ARC));
const R_INNER       = R_CENTER - HALF_THICK;
const R_OUTER       = R_CENTER + HALF_THICK;
/** Arc subdivisions for the curved faces — more = smoother. */
const ARC_SEGS      = 4;

type Vec3T = [number, number, number];

/** Convert (angle, radius, y) on the cylinder to brick-local coords
 *  (translated so the brick centroid is at the origin). */
function pos(a: number, r: number, y: number): Vec3T {
    return [r * Math.sin(a), y, r * Math.cos(a) - R_CENTER];
}

export function createCurvedBrickMesh(): Mesh {
    const positions: number[] = [];
    const normals:   number[] = [];
    const uvs:       number[] = [];
    const indices:   number[] = [];

    /**
     * Push one quad. **Vertices must be in CCW order viewed from the side
     * the normal points to** — both triangles (0-1-2 and 0-2-3) will then
     * be front-facing along the supplied normal.
     *
     * UVs are dummy (per-corner 0/1 mapping) — we don't actually sample any
     * texture map, but builtin-standard shader expects the UV attribute to
     * exist or it generates undefined sample reads on some platforms.
     */
    function pushQuad(p0: Vec3T, p1: Vec3T, p2: Vec3T, p3: Vec3T, n: Vec3T): void {
        const v0 = positions.length / 3;
        positions.push(...p0, ...p1, ...p2, ...p3);
        for (let i = 0; i < 4; i++) normals.push(...n);
        uvs.push(0, 0,  0, 1,  1, 1,  1, 0);
        indices.push(v0, v0 + 1, v0 + 2, v0, v0 + 2, v0 + 3);
    }

    // ============================================================
    //  OUTER FACE — curved, normal radially outward (+Z-ish per segment)
    //  Viewed from outside: +Y up, +X right. CCW = UL → LL → LR → UR.
    // ============================================================
    for (let i = 0; i < ARC_SEGS; i++) {
        const a1 = -HALF_ARC + (i      / ARC_SEGS) * ARC_ANGLE;   // smaller X side
        const a2 = -HALF_ARC + ((i + 1) / ARC_SEGS) * ARC_ANGLE;   // larger X side
        const am = (a1 + a2) / 2;
        pushQuad(
            pos(a1, R_OUTER, +HALF_HEIGHT),   // UL
            pos(a1, R_OUTER, -HALF_HEIGHT),   // LL
            pos(a2, R_OUTER, -HALF_HEIGHT),   // LR
            pos(a2, R_OUTER, +HALF_HEIGHT),   // UR
            [Math.sin(am), 0, Math.cos(am)],
        );
    }

    // ============================================================
    //  INNER FACE — curved, normal radially inward (−Z-ish per segment)
    //  Viewed from INSIDE the brick (camera at −Z looking toward +Z),
    //  the +X direction is to the camera's LEFT. So:
    //   UL_inside = larger X (= a2), upper Y
    //   LL_inside = larger X (= a2), lower Y
    //   LR_inside = smaller X (= a1), lower Y
    //   UR_inside = smaller X (= a1), upper Y
    //  CCW from inside = UL → LL → LR → UR.
    // ============================================================
    for (let i = 0; i < ARC_SEGS; i++) {
        const a1 = -HALF_ARC + (i      / ARC_SEGS) * ARC_ANGLE;
        const a2 = -HALF_ARC + ((i + 1) / ARC_SEGS) * ARC_ANGLE;
        const am = (a1 + a2) / 2;
        pushQuad(
            pos(a2, R_INNER, +HALF_HEIGHT),
            pos(a2, R_INNER, -HALF_HEIGHT),
            pos(a1, R_INNER, -HALF_HEIGHT),
            pos(a1, R_INNER, +HALF_HEIGHT),
            [-Math.sin(am), 0, -Math.cos(am)],
        );
    }

    // ============================================================
    //  TOP FACE — annular sector at +Y, normal +Y
    //  Viewed from above (looking down −Y): +X right, +Z away from camera.
    //  CCW from above: outer-near-right → outer-far-right → inner-far → inner-near
    //  i.e., (a1, OUTER) → (a2, OUTER) → (a2, INNER) → (a1, INNER)
    //  This is the SAME order I had originally — it was correct.
    // ============================================================
    for (let i = 0; i < ARC_SEGS; i++) {
        const a1 = -HALF_ARC + (i      / ARC_SEGS) * ARC_ANGLE;
        const a2 = -HALF_ARC + ((i + 1) / ARC_SEGS) * ARC_ANGLE;
        pushQuad(
            pos(a1, R_OUTER, +HALF_HEIGHT),
            pos(a2, R_OUTER, +HALF_HEIGHT),
            pos(a2, R_INNER, +HALF_HEIGHT),
            pos(a1, R_INNER, +HALF_HEIGHT),
            [0, 1, 0],
        );
    }

    // ============================================================
    //  BOTTOM FACE — annular sector at -Y, normal -Y
    //  Same as TOP but reversed winding (viewed from below).
    // ============================================================
    for (let i = 0; i < ARC_SEGS; i++) {
        const a1 = -HALF_ARC + (i      / ARC_SEGS) * ARC_ANGLE;
        const a2 = -HALF_ARC + ((i + 1) / ARC_SEGS) * ARC_ANGLE;
        pushQuad(
            pos(a1, R_INNER, -HALF_HEIGHT),
            pos(a2, R_INNER, -HALF_HEIGHT),
            pos(a2, R_OUTER, -HALF_HEIGHT),
            pos(a1, R_OUTER, -HALF_HEIGHT),
            [0, -1, 0],
        );
    }

    // ============================================================
    //  LEFT SIDE — flat radial wall at angle −HALF_ARC
    //  Normal: (−cos a, 0, sin a) — i.e. roughly −X with a touch of −Z.
    //  Viewed from outside (along the normal), +Y is up, and "right" in
    //  camera view corresponds to going INWARD (toward smaller r).
    //  So CCW from outside: OUTER-top → OUTER-bottom → INNER-bottom → INNER-top.
    // ============================================================
    {
        const a = -HALF_ARC;
        pushQuad(
            pos(a, R_OUTER, +HALF_HEIGHT),
            pos(a, R_INNER, +HALF_HEIGHT),
            pos(a, R_INNER, -HALF_HEIGHT),
            pos(a, R_OUTER, -HALF_HEIGHT),
            [-Math.cos(a), 0, +Math.sin(a)],
        );
    }

    // ============================================================
    //  RIGHT SIDE — flat radial wall at angle +HALF_ARC
    //  Normal: (+cos a, 0, −sin a).
    //  Viewed from outside, +Y up; "right" in camera view = going OUTWARD.
    //  CCW from outside: INNER-top → INNER-bottom → OUTER-bottom → OUTER-top.
    // ============================================================
    {
        const a = +HALF_ARC;
        pushQuad(
            pos(a, R_INNER, +HALF_HEIGHT),
            pos(a, R_OUTER, +HALF_HEIGHT),
            pos(a, R_OUTER, -HALF_HEIGHT),
            pos(a, R_INNER, -HALF_HEIGHT),
            [+Math.cos(a), 0, -Math.sin(a)],
        );
    }

    return utils.MeshUtils.createMesh({
        positions,
        normals,
        uvs,
        indices,
    });
}
