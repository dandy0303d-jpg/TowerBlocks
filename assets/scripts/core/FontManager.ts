/**
 * FontManager — apply one global TTF font to every Label / RichText in
 * the scene, plus expose the font instance so runtime-created labels
 * (energy picker, flying number/shape animations, dynamic buttons)
 * can pick it up too.
 *
 * Wiring (Cocos editor):
 *   1. Attach this component to any scene node (Canvas is fine).
 *   2. Drag `assets/fonts/HarmonyOS_Sans_Condensed.ttf` into the
 *      `globalFont` @property slot.
 *   3. That's it — onLoad sweeps every authored Label + RichText and
 *      swaps in the font. A second sweep runs one frame later to
 *      catch labels built during sibling components' `start()`.
 *
 * Dynamically-created labels:
 *   Places that build labels at runtime (HudController.makeLabel, the
 *   picker/fate/shapeshifter modals, in-flight number animations)
 *   read `FontManager.font` and apply it on creation, so the sweep
 *   isn't required for correctness — it's just belt-and-suspenders.
 */

import { _decorator, Component, Node, Label, RichText, TTFFont, director } from 'cc';

const { ccclass, property } = _decorator;

@ccclass('FontManager')
export class FontManager extends Component {

    @property({ type: TTFFont, tooltip: '全局 TTF 字体（推荐: HarmonyOS Sans Condensed）' })
    globalFont: TTFFont | null = null;

    private static _font: TTFFont | null = null;

    /** Read the currently-configured global font. `null` until a
     *  FontManager component with a wired `globalFont` has run onLoad. */
    public static get font(): TTFFont | null {
        return this._font;
    }

    /** Convenience — apply the global font to a single Label. No-op
     *  if the font hasn't been wired yet (label keeps its default). */
    public static applyToLabel(label: Label): void {
        if (!this._font || !label) return;
        // useSystemFont MUST be false before assigning `font`, otherwise
        // Cocos ignores the TTF and keeps the system font.
        label.useSystemFont = false;
        label.font = this._font;
    }

    /** Convenience — recurse the subtree and apply to every Label +
     *  RichText found. Called on scene load + one frame later. */
    public static applyToSubtree(root: Node): void {
        if (!this._font || !root) return;
        for (const lab of root.getComponentsInChildren(Label)) {
            lab.useSystemFont = false;
            lab.font = this._font;
        }
        for (const rt of root.getComponentsInChildren(RichText)) {
            // RichText's font prop is same shape as Label's.
            (rt as any).useSystemFont = false;
            (rt as any).font = this._font;
        }
    }

    onLoad(): void {
        if (!this.globalFont) {
            console.warn('[FontManager] globalFont @property not wired — skipping global font swap');
            return;
        }
        FontManager._font = this.globalFont;
        console.log('[FontManager] global font set:', this.globalFont.name);
        this.sweepScene();
    }

    start(): void {
        // Second sweep: catches labels created by sibling components'
        // start() (e.g. HudController.buildPicker / buildFateModal
        // build their own Label nodes at runtime). Cocos runs every
        // component's onLoad before any start(), so this sweep after
        // start finishes covers the initial dynamic labels too.
        this.scheduleOnce(() => this.sweepScene(), 0);
    }

    private sweepScene(): void {
        const scene = director.getScene();
        if (scene) FontManager.applyToSubtree(scene);
    }
}
