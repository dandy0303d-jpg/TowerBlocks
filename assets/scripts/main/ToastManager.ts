/**
 * ToastManager — game-wide unified toast for both "success/info" and
 * "error/warning" messages. Replaces the four scattered toast systems
 * that used to live in MenuController (settings toast + lock-tip toast),
 * HudController (milestone toast), and TopUpController (purchase toast).
 *
 * Scene wiring (drag one node in the scene, attach this component, then):
 *   • toastNode        — root Node that gets active-toggled + fade-tweened
 *   • toastLabel       — Label that receives the message text
 *   • toastBgSprite    — Sprite whose spriteFrame gets swapped per variant
 *   • bgPositive       — SpriteFrame shown for `info()` calls
 *   • bgNegative       — SpriteFrame shown for `error()` calls
 *
 * Usage from anywhere:
 *   ToastManager.instance?.info(t('settings.saved'));
 *   ToastManager.instance?.error(t('topup.failed'));
 *
 * Behaviour:
 *   • Swaps `toastBgSprite.spriteFrame` to the matching variant BG.
 *   • Sets `toastLabel.string` to the message.
 *   • Fades the toast in over 150 ms, holds for `holdMs` (default 1600),
 *     fades out over 300 ms, then deactivates the node.
 *   • Rapid successive calls interrupt the previous fade — the new
 *     message shows immediately with a fresh timeline.
 */

import {
    _decorator,
    Component,
    Node,
    Label,
    Sprite,
    SpriteFrame,
    UIOpacity,
    tween,
    Tween,
} from 'cc';

const { ccclass, property } = _decorator;

export type ToastKind = 'info' | 'error';

@ccclass('ToastManager')
export class ToastManager extends Component {

    private static _instance: ToastManager | null = null;
    /** Global accessor. Null if no ToastManager component is present
     *  in the current scene (Cocos strips components on scene reload). */
    public static get instance(): ToastManager | null { return ToastManager._instance; }

    // ---- Scene refs (drag in editor) ----

    @property({ type: Node, tooltip: 'Toast 根节点（含背景 Sprite + Label；默认 active=false）— 脚本会 tween 淡入/淡出' })
    toastNode: Node | null = null;

    @property({ type: Label, tooltip: 'Toast 内部 Label（脚本写文字）— 可空，会自动从 toastNode 里找' })
    toastLabel: Label | null = null;

    @property({ type: Sprite, tooltip: 'Toast 背景 Sprite（脚本会根据 info/error 换 spriteFrame）— 可空，会自动从 toastNode 里找' })
    toastBgSprite: Sprite | null = null;

    // ---- Background art per variant (drag SpriteFrame in editor) ----

    @property({ type: SpriteFrame, tooltip: '正向/信息类 Toast 背景图（拖 SpriteFrame 进来）' })
    bgPositive: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: '报错/警告类 Toast 背景图（拖 SpriteFrame 进来）' })
    bgNegative: SpriteFrame | null = null;

    // ---- Tuning ----

    @property({ tooltip: 'Toast 停留时长（毫秒）— 淡入淡出时长在此之外' })
    holdMs: number = 1600;

    @property({ tooltip: '淡入时长（毫秒）' })
    fadeInMs: number = 150;

    @property({ tooltip: '淡出时长（毫秒）' })
    fadeOutMs: number = 300;

    // ---- Runtime state ----
    private _uiOpacity: UIOpacity | null = null;

    onLoad(): void {
        ToastManager._instance = this;
        // Auto-resolve label + bg sprite if the author didn't wire them.
        if (this.toastNode) {
            if (!this.toastLabel)   this.toastLabel   = this.toastNode.getComponentInChildren(Label);
            if (!this.toastBgSprite) this.toastBgSprite = this.toastNode.getComponent(Sprite)
                                                       ?? this.toastNode.getComponentInChildren(Sprite);
        }
        // Ensure a UIOpacity is present so we can fade the node.
        if (this.toastNode) {
            this._uiOpacity = this.toastNode.getComponent(UIOpacity)
                           ?? this.toastNode.addComponent(UIOpacity);
        }
    }

    onDestroy(): void {
        if (ToastManager._instance === this) ToastManager._instance = null;
    }

    // ============================================================
    //  Public API
    // ============================================================

    /** Positive / informational message (success confirmations, saves,
     *  progress unlocks, etc.). Uses the `bgPositive` background. */
    public info(text: string): void { this.show(text, 'info'); }

    /** Error / warning message (network failures, invalid input,
     *  locked feature tips, etc.). Uses the `bgNegative` background. */
    public error(text: string): void { this.show(text, 'error'); }

    /** Shared entry point. Prefer `info()` / `error()` at call sites so
     *  intent is obvious in the surrounding code. */
    public show(text: string, kind: ToastKind = 'info'): void {
        if (!this.toastNode) {
            // No scene wiring — cheapest thing is to just log so devs
            // can see toasts fire during headless / test runs.
            console.log(`[Toast/${kind}] ${text}`);
            return;
        }
        // Swap bg per variant. Falls back to whatever's currently set
        // on the Sprite if the variant slot isn't wired.
        const bg = kind === 'error' ? this.bgNegative : this.bgPositive;
        if (this.toastBgSprite && bg) this.toastBgSprite.spriteFrame = bg;
        if (this.toastLabel) this.toastLabel.string = text;
        // Bring toast to the front so it renders on top of overlays /
        // modals it was created alongside.
        if (this.toastNode.parent) {
            this.toastNode.setSiblingIndex(this.toastNode.parent.children.length - 1);
        }
        this.toastNode.active = true;
        const op = this._uiOpacity;
        if (!op) return;
        // Interrupt any in-flight fade so the new message wins immediately.
        Tween.stopAllByTarget(op);
        op.opacity = 0;
        tween<UIOpacity>(op)
            .to(this.fadeInMs / 1000,  { opacity: 255 })
            .delay(this.holdMs / 1000)
            .to(this.fadeOutMs / 1000, { opacity: 0 })
            .call(() => {
                if (this.toastNode && this.toastNode.isValid) {
                    this.toastNode.active = false;
                }
            })
            .start();
    }
}
