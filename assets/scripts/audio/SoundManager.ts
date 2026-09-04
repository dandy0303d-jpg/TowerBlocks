/**
 * Centralised sound-effect (SFX) player.
 *
 * Usage
 *   1. Attach this component to a scene node (usually GameController or Canvas).
 *   2. In the Inspector, drag your imported AudioClip assets into the
 *      matching @property slots (rotateTower, pieceLock, lineClear, etc.).
 *   3. Anywhere in game code:
 *          SoundManager.instance?.play('piece_lock');
 *      Safe to call before clips are loaded — it just no-ops.
 *
 * Design notes
 *   • One SFX at a time per key. Rapid re-triggers use `playOneShot` so
 *     the same clip can layer without cutoff.
 *   • Global volume + mute switch. Volume is read from `Settings.getSfxVolume()`
 *     when present, otherwise defaults to 1.0.
 *   • Music (looped BGM) is NOT handled here — this is SFX only. Add a
 *     separate BgmManager if we later want music tracks.
 */

import { _decorator, Component, AudioClip, AudioSource, Button } from 'cc';

const { ccclass, property } = _decorator;

export type SfxKey =
    | 'rotate_tower'   // 塔旋转 (cylinder move)
    | 'rotate_blocked' // 塔被卡住 (moveCylinder returned false — falling piece jams the rotation)
    | 'piece_lock'     // 方块落地 (piece lands)
    | 'piece_rotate'   // 方块旋转 (tryRotate)
    | 'hard_drop'      // 硬降 (spacebar / swipe down)
    | 'line_clear'     // 消除行
    | 'bomb_boom'      // 爆破道具触发
    | 'item_pick'      // 玩家选中魔法道具
    | 'ui_click'       // 通用按钮点击
    | 'level_win'      // 通关
    | 'game_over'      // 游戏结束
    | 'rocket_launch'  // 火箭弹风暴激活（一次性）
    | 'rocket_fire'    // 火箭弹每发发射
    | 'rocket_hit'     // 火箭弹每次击中方块儿
    | 'gatling_fire'   // 加特林发射
    | 'meteor_fire'    // 流星雨每颗 DOT 发射
    | 'mortar_land'    // 灰泥掉落锁定（每颗落地）
    | 'level_scatter'; // 通关时塔散花的音效（scatter animation）

@ccclass('SoundManager')
export class SoundManager extends Component {

    private static _instance: SoundManager | null = null;
    public static get instance(): SoundManager | null { return SoundManager._instance; }

    // ---- AudioClip slots (drag WAV/MP3 assets in the editor) ----

    @property({ type: AudioClip, tooltip: '塔旋转音效' })
    rotateTower: AudioClip | null = null;

    @property({ type: AudioClip, tooltip: '塔被卡住音效（下落方块顶住了塔，无法旋转时播放）' })
    rotateBlocked: AudioClip | null = null;

    @property({ type: AudioClip, tooltip: '方块落地音效（咚）' })
    pieceLock: AudioClip | null = null;

    @property({ type: AudioClip, tooltip: '方块旋转音效（咔哒）' })
    pieceRotate: AudioClip | null = null;

    @property({ type: AudioClip, tooltip: '硬降音效' })
    hardDrop: AudioClip | null = null;

    @property({ type: AudioClip, tooltip: '消除行音效（爆破/石块散落）' })
    lineClear: AudioClip | null = null;

    @property({ type: AudioClip, tooltip: '爆破道具触发音效' })
    bombBoom: AudioClip | null = null;

    @property({ type: AudioClip, tooltip: '选中魔法道具音效' })
    itemPick: AudioClip | null = null;

    @property({ type: AudioClip, tooltip: 'UI 按钮点击音效' })
    uiClick: AudioClip | null = null;

    @property({ type: AudioClip, tooltip: '过关胜利音效' })
    levelWin: AudioClip | null = null;

    @property({ type: AudioClip, tooltip: '游戏结束音效' })
    gameOver: AudioClip | null = null;

    @property({ type: AudioClip, tooltip: '火箭弹风暴激活音效（一次性，风暴开始时响一次）' })
    rocketLaunch: AudioClip | null = null;

    @property({ type: AudioClip, tooltip: '火箭弹发射音效（每发一次触发）' })
    rocketFire: AudioClip | null = null;

    @property({ type: AudioClip, tooltip: '火箭弹击中方块儿音效（每次命中都触发）' })
    rocketHit: AudioClip | null = null;

    @property({ type: AudioClip, tooltip: '加特林子弹发射音效（每发一次触发）' })
    gatlingFire: AudioClip | null = null;

    @property({ type: AudioClip, tooltip: '流星雨发射音效（每颗 DOT 生成时触发一次）' })
    meteorFire: AudioClip | null = null;

    @property({ type: AudioClip, tooltip: '灰泥掉落锁定音效（每颗砂石落地印在方块儿上触发一次）' })
    mortarLand: AudioClip | null = null;

    @property({ type: AudioClip, tooltip: '通关后塔散花动画音效（scatter 开始时触发一次）— 拖 AudioClip 进来' })
    levelScatter: AudioClip | null = null;

    // ---- Global tuning ----

    @property({ range: [0, 1, 0.05], slide: true, tooltip: '主音量（乘算所有 playOneShot）' })
    masterVolume = 0.8;

    @property({ tooltip: '取消勾选可整体静音（调试用）' })
    sfxEnabled = true;

    private audioSource!: AudioSource;

    onLoad(): void {
        SoundManager._instance = this;
        this.audioSource = this.node.getComponent(AudioSource)
            ?? this.node.addComponent(AudioSource);
        SoundManager.installGlobalButtonClickSound();
    }

    // ============================================================
    //  Global button-click SFX
    // ============================================================
    // Every Button emits `Button.EventType.CLICK` on tap via its
    // internal `_onTouchEnded`. Patching that method once at boot
    // gives us "any Button tap plays a click sound" without having
    // to remember it at each click handler. Idempotent via
    // `_ttGlobalHookInstalled`. Firing BEFORE the original ensures
    // the sound plays even if the user's own click handler navigates
    // away or throws.
    /** Buttons registered here are exempt from the global click SFX.
     *  Use for on-screen game-action buttons (硬降 / 变形 / 塔旋转)
     *  where the action itself already fires its own SFX and stacking
     *  a `ui_click` on top makes the audio muddy. */
    private static _suppressedButtons: WeakSet<Button> = new WeakSet();
    public static suppressClickSound(btn: Button | null | undefined): void {
        if (btn) SoundManager._suppressedButtons.add(btn);
    }

    private static _globalHookInstalled = false;
    private static installGlobalButtonClickSound(): void {
        if (SoundManager._globalHookInstalled) return;
        SoundManager._globalHookInstalled = true;
        const proto: any = Button.prototype;
        const orig = proto._onTouchEnded;
        if (typeof orig !== 'function') {
            console.warn('[SoundManager] Button.prototype._onTouchEnded not found — click SFX auto-hook disabled. Cocos version incompatible?');
            return;
        }
        proto._onTouchEnded = function (...args: any[]) {
            try {
                // Only play if the button is actually interactable, the
                // touch was inside it, AND the button hasn't been
                // suppressed by SoundManager.suppressClickSound(). The
                // suppression list covers game-action buttons (硬降 /
                // 变形 / 塔旋转) whose own SFX would otherwise stack
                // with ui_click and read as muddy overlapping audio.
                if (this.interactable !== false
                    && this._pressed
                    && !SoundManager._suppressedButtons.has(this)) {
                    SoundManager.instance?.play('ui_click');
                }
            } catch (e) { /* never let a SFX error break button flow */ }
            return orig.apply(this, args);
        };
    }

    onDestroy(): void {
        if (SoundManager._instance === this) SoundManager._instance = null;
    }

    /** Fire a SFX by key. Silent no-op if disabled, un-registered, or the
     *  clip failed to load — never throws. */
    public play(key: SfxKey, volumeScale = 1.0): void {
        if (!this.sfxEnabled || !this.audioSource) return;
        const clip = this.clipFor(key);
        if (!clip) return;
        try {
            this.audioSource.playOneShot(clip, this.masterVolume * volumeScale);
        } catch (e) {
            console.warn(`[SoundManager] play(${key}) threw`, e);
        }
    }

    /** Runtime setters — a Settings UI slider can hook these. */
    public setEnabled(on: boolean): void { this.sfxEnabled = on; }
    public setMasterVolume(v: number): void {
        this.masterVolume = Math.max(0, Math.min(1, v));
    }

    private clipFor(key: SfxKey): AudioClip | null {
        switch (key) {
            case 'rotate_tower':   return this.rotateTower;
            case 'rotate_blocked': return this.rotateBlocked;
            case 'piece_lock':    return this.pieceLock;
            case 'piece_rotate':  return this.pieceRotate;
            case 'hard_drop':     return this.hardDrop;
            case 'line_clear':    return this.lineClear;
            case 'bomb_boom':     return this.bombBoom;
            case 'item_pick':     return this.itemPick;
            case 'ui_click':      return this.uiClick;
            case 'level_win':     return this.levelWin;
            case 'game_over':     return this.gameOver;
            case 'rocket_launch': return this.rocketLaunch;
            case 'rocket_fire':   return this.rocketFire;
            case 'rocket_hit':    return this.rocketHit;
            case 'gatling_fire':  return this.gatlingFire;
            case 'meteor_fire':   return this.meteorFire;
            case 'mortar_land':   return this.mortarLand;
            case 'level_scatter': return this.levelScatter;
            default:              return null;
        }
    }
}
