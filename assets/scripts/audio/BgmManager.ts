/**
 * Background-music (BGM) manager. One track plays at a time, loops
 * indefinitely, and switches when the game mode changes.
 *
 * Usage
 *   1. Attach this component to a scene node (usually GameController or Canvas).
 *   2. Inspector: drag your looped BGM AudioClip assets into the three
 *      slots — menuBgm (game outside), endlessBgm, levelBgm.
 *   3. Anywhere in game code:
 *          BgmManager.instance?.play('menu');
 *          BgmManager.instance?.play('endless');
 *          BgmManager.instance?.play('level');
 *          BgmManager.instance?.stop();
 *
 * Design notes
 *   • Only one BGM plays at any moment. `play(key)` stops the previous
 *     track and starts the new one.
 *   • BGM is always looped (`.loop = true`).
 *   • Master volume + mute switch are independent from SFX (SoundManager
 *     has its own).
 *   • Safe no-op if the requested clip isn't wired — never throws.
 */

import { _decorator, Component, AudioClip, AudioSource } from 'cc';

const { ccclass, property } = _decorator;

export type BgmKey = 'menu' | 'endless' | 'level';

@ccclass('BgmManager')
export class BgmManager extends Component {

    private static _instance: BgmManager | null = null;
    public static get instance(): BgmManager | null { return BgmManager._instance; }

    // ---- BGM clip slots ----

    @property({ type: AudioClip, tooltip: '游戏外 / 主菜单 BGM' })
    menuBgm: AudioClip | null = null;

    @property({ type: AudioClip, tooltip: '无尽模式 BGM' })
    endlessBgm: AudioClip | null = null;

    @property({ type: AudioClip, tooltip: '关卡模式 BGM' })
    levelBgm: AudioClip | null = null;

    // ---- Global tuning ----

    @property({ range: [0, 1, 0.05], slide: true, tooltip: 'BGM 主音量' })
    masterVolume = 0.5;

    @property({ tooltip: '取消勾选可整体静音 BGM' })
    bgmEnabled = true;

    private audioSource!: AudioSource;
    private currentKey: BgmKey | null = null;

    onLoad(): void {
        BgmManager._instance = this;
        this.audioSource = this.node.getComponent(AudioSource)
            ?? this.node.addComponent(AudioSource);
        this.audioSource.loop = true;
    }

    onDestroy(): void {
        if (BgmManager._instance === this) BgmManager._instance = null;
    }

    /** Switch to the given BGM. Same-key call is a no-op (won't restart the
     *  current track when re-entering the same mode). */
    public play(key: BgmKey): void {
        if (!this.audioSource) return;
        if (this.currentKey === key && this.audioSource.playing) return;

        const clip = this.clipFor(key);
        if (!clip) {
            // Requested BGM not wired — stop whatever's playing and
            // leave silence rather than keeping the old track alive.
            this.stop();
            this.currentKey = key;
            return;
        }

        this.audioSource.stop();
        this.audioSource.clip = clip;
        this.audioSource.loop = true;
        this.audioSource.volume = this.bgmEnabled ? this.masterVolume : 0;
        this.audioSource.play();
        this.currentKey = key;
    }

    /** Stop any playing BGM (leaves currentKey untouched so re-entering
     *  the mode can restart the track via `play`). */
    public stop(): void {
        if (this.audioSource) this.audioSource.stop();
    }

    /** Pause the current BGM. AudioSource.pause() preserves the playhead
     *  so `resume()` picks up mid-track — the game's pause overlay
     *  freezes the tune where it was. Safe when nothing's playing. */
    public pause(): void {
        if (!this.audioSource) return;
        // Cocos AudioSource.pause() is a no-op if state !== PLAYING,
        // but we guard anyway to avoid the noisy warning some builds emit.
        if (this.audioSource.state === AudioSource.AudioState.PLAYING) {
            this.audioSource.pause();
        }
    }

    /** Resume from the position `pause()` left off at. If the source
     *  isn't in PAUSED state (was stopped, or never started) we fall
     *  back to restarting whatever `currentKey` requested last so the
     *  player doesn't unpause into silence. */
    public resume(): void {
        if (!this.audioSource) return;
        if (this.audioSource.state === AudioSource.AudioState.PAUSED) {
            this.audioSource.play();   // resumes from currentTime
        } else if (this.currentKey && this.audioSource.state === AudioSource.AudioState.INIT) {
            // Nothing was playing to begin with. Kick off the current key.
            const k = this.currentKey;
            this.currentKey = null;    // reset so `play()` doesn't early-return
            this.play(k);
        }
    }

    /** Runtime setters — a Settings UI slider can hook these. */
    public setEnabled(on: boolean): void {
        this.bgmEnabled = on;
        if (this.audioSource) {
            this.audioSource.volume = on ? this.masterVolume : 0;
        }
    }
    public setMasterVolume(v: number): void {
        this.masterVolume = Math.max(0, Math.min(1, v));
        if (this.audioSource && this.bgmEnabled) {
            this.audioSource.volume = this.masterVolume;
        }
    }

    private clipFor(key: BgmKey): AudioClip | null {
        switch (key) {
            case 'menu':    return this.menuBgm;
            case 'endless': return this.endlessBgm;
            case 'level':   return this.levelBgm;
            default:        return null;
        }
    }
}
