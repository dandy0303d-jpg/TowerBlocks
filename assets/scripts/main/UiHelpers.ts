/**
 * Shared UI helpers used by any controller that spawns full-screen
 * modal overlays. Currently just `ensureDimBackdrop` — dedupes the
 * pattern of "make sure my modal has a dim child so the background
 * is blocked visually AND touches don't leak through."
 */

import { Node, Graphics, Widget, UITransform, BlockInputEvents, Canvas, Color, view } from 'cc';

/**
 * Ensure `overlay` has a full-screen semi-transparent dark child that
 *  (a) visually dims whatever is behind the modal
 *  (b) eats touch / mouse events so buttons underneath don't fire
 *
 * If a child named `Dim`, `FateDim`, or `Backdrop` already exists, this
 * is a no-op (respect user-authored dims — they can customise colour /
 * blur / whatever without us re-adding a plain black on top).
 *
 * The synthesized dim is inserted at sibling index 0 so it draws FIRST
 * (behind every other overlay child like the modal card and buttons).
 *
 * @param overlay  Root modal node. Should be full-screen (typically
 *                 has a Widget aligning it to canvas edges).
 * @param color    Fill colour. Defaults to 80% dark black.
 * @param name     Node name for the synthesized child.
 */
export function ensureDimBackdrop(
    overlay: Node | null,
    color: Color = new Color(0, 0, 0, 200),
    name: string = 'Dim',
): void {
    if (!overlay) return;
    // Respect any pre-existing dim-like child.
    const existing = overlay.getChildByName('Dim')
        ?? overlay.getChildByName('FateDim')
        ?? overlay.getChildByName('Backdrop')
        ?? overlay.getChildByName(name);
    if (existing) return;

    // Walk up to the Canvas (or top-most ancestor) so we know the real
    // full-screen rect. If the overlay was authored as a small card-
    // sized node, aligning Widget to the direct parent would make the
    // Dim as small as the card — invisible under the card sprite.
    // Aligning to Canvas guarantees full-screen coverage regardless of
    // where in the hierarchy the overlay lives.
    let canvasNode: Node | null = null;
    let cur: Node | null = overlay;
    while (cur) {
        if (cur.getComponent(Canvas)) { canvasNode = cur; break; }
        cur = cur.parent;
    }
    // If no Canvas found (shouldn't happen in normal UI), fall back to
    // the visible view size.
    let canvasW: number;
    let canvasH: number;
    if (canvasNode) {
        const cTx = canvasNode.getComponent(UITransform);
        canvasW = cTx ? cTx.contentSize.width  : view.getVisibleSize().width;
        canvasH = cTx ? cTx.contentSize.height : view.getVisibleSize().height;
    } else {
        const vs = view.getVisibleSize();
        canvasW = vs.width;
        canvasH = vs.height;
    }

    const dim = new Node(name);
    dim.parent = overlay;
    dim.layer  = overlay.layer;
    // Widget aligned to CANVAS (not our direct parent) so we stretch
    // across the whole screen even when overlay itself is card-sized.
    const w = dim.addComponent(Widget);
    if (canvasNode) w.target = canvasNode;
    w.isAlignLeft = w.isAlignRight = w.isAlignTop = w.isAlignBottom = true;
    w.left = w.right = w.top = w.bottom = 0;
    w.alignMode = Widget.AlignMode.ON_WINDOW_RESIZE;
    w.updateAlignment();
    // Explicit UITransform sized to the CANVAS. We don't trust the
    // post-Widget contentSize alone because some Widget target modes
    // don't write contentSize immediately — better safe than sorry.
    const tx = dim.getComponent(UITransform) ?? dim.addComponent(UITransform);
    tx.setContentSize(canvasW, canvasH);
    // Draw the fill from the actual UITransform size (in case any of
    // the above resolved to something smaller than expected).
    const drawW = Math.max(tx.contentSize.width,  canvasW);
    const drawH = Math.max(tx.contentSize.height, canvasH);
    const g = dim.addComponent(Graphics);
    g.fillColor = color;
    g.rect(-drawW / 2, -drawH / 2, drawW, drawH);
    g.fill();
    // BlockInputEvents = touches / clicks stop at this node instead of
    // reaching whatever's underneath.
    dim.addComponent(BlockInputEvents);
    dim.setSiblingIndex(0);
}
