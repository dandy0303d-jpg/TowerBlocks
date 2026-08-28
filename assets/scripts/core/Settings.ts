/**
 * Lightweight game-settings store (pattern mirrors core/i18n/I18n.ts):
 *
 *   • Plain key/value state persisted to localStorage.
 *   • `subscribe(cb)` lets UI components rebuild on change.
 *   • No Cocos imports — safe to read from any layer.
 *
 * Two settings live here today:
 *   - `gestureMode`: how the tower-rotation gesture behaves on the left
 *     half of the screen.
 *   - `keysMode`: whether on-screen virtual buttons replace gestures.
 *     (Default off — touch gestures handle everything.)
 */

export type GestureMode = 'flick-and-drag' | 'drag-only';
export type KeysMode    = 'off' | 'on';
export type AudioMode   = 'off' | 'on';

const STORAGE_KEY_GESTURE   = 'tetritower.gestureMode';
const STORAGE_KEY_KEYS      = 'tetritower.keysMode';
const STORAGE_KEY_BGM       = 'tetritower.bgmMode';
const STORAGE_KEY_SFX       = 'tetritower.sfxMode';
const STORAGE_KEY_BGM_VOL   = 'tetritower.bgmVolume';
const STORAGE_KEY_SFX_VOL   = 'tetritower.sfxVolume';
const STORAGE_KEY_HAPTIC    = 'tetritower.hapticMode';
const STORAGE_KEY_CONTROL   = 'tetritower.controlMode';

/** The five volume steps the settings cycle exposes: mute + four
 *  levels. 0 is the "off" position (mode also flips to 'off'). */
export const AUDIO_VOLUME_STEPS: readonly number[] = [0, 0.25, 0.5, 0.75, 1.0] as const;

function loadGesture(): GestureMode {
    try {
        const saved = (typeof localStorage !== 'undefined')
            ? localStorage.getItem(STORAGE_KEY_GESTURE) : null;
        if (saved === 'flick-and-drag' || saved === 'drag-only') return saved;
    } catch (_) { /* ignore */ }
    return 'flick-and-drag';
}

function loadKeys(): KeysMode {
    try {
        const saved = (typeof localStorage !== 'undefined')
            ? localStorage.getItem(STORAGE_KEY_KEYS) : null;
        if (saved === 'on' || saved === 'off') return saved;
    } catch (_) { /* ignore */ }
    return 'off';
}

function loadAudio(key: string, dflt: AudioMode): AudioMode {
    try {
        const saved = (typeof localStorage !== 'undefined')
            ? localStorage.getItem(key) : null;
        if (saved === 'on' || saved === 'off') return saved;
    } catch (_) { /* ignore */ }
    return dflt;
}

function loadAudioVolume(key: string, dflt: number): number {
    try {
        const saved = (typeof localStorage !== 'undefined')
            ? localStorage.getItem(key) : null;
        if (saved !== null) {
            const n = parseFloat(saved);
            if (Number.isFinite(n) && n >= 0 && n <= 1) {
                // Snap to the nearest allowed step so a hand-edited
                // localStorage value still lines up with the UI.
                return snapToVolumeStep(n);
            }
        }
    } catch (_) { /* ignore */ }
    return dflt;
}

function snapToVolumeStep(v: number): number {
    let best = AUDIO_VOLUME_STEPS[0];
    let bestD = Infinity;
    for (const s of AUDIO_VOLUME_STEPS) {
        const d = Math.abs(s - v);
        if (d < bestD) { bestD = d; best = s; }
    }
    return best;
}

let gestureMode: GestureMode = loadGesture();
let keysMode:    KeysMode    = loadKeys();
let bgmMode:     AudioMode   = loadAudio(STORAGE_KEY_BGM, 'on');
let sfxMode:     AudioMode   = loadAudio(STORAGE_KEY_SFX, 'on');
// Volume levels: default to full unless the saved mode was 'off'
// (respects the earlier on/off toggle for users upgrading).
let bgmVolume:   number      = loadAudioVolume(STORAGE_KEY_BGM_VOL, bgmMode === 'off' ? 0 : 0.5);
let sfxVolume:   number      = loadAudioVolume(STORAGE_KEY_SFX_VOL, sfxMode === 'off' ? 0 : 0.8);

type Subscriber = () => void;
const subscribers: Subscriber[] = [];

export function subscribe(cb: Subscriber): () => void {
    subscribers.push(cb);
    return () => {
        const i = subscribers.indexOf(cb);
        if (i >= 0) subscribers.splice(i, 1);
    };
}

function notify(): void {
    for (const cb of subscribers) {
        try { cb(); } catch (e) { console.warn('[settings] subscriber threw', e); }
    }
}

// ---------- gestureMode ----------
export function getGestureMode(): GestureMode { return gestureMode; }

export function setGestureMode(mode: GestureMode): void {
    if (mode === gestureMode) return;
    gestureMode = mode;
    try { localStorage?.setItem(STORAGE_KEY_GESTURE, mode); } catch (_) { /* ignore */ }
    notify();
}

export function cycleGestureMode(): GestureMode {
    setGestureMode(gestureMode === 'flick-and-drag' ? 'drag-only' : 'flick-and-drag');
    return gestureMode;
}

// ---------- keysMode ----------
export function getKeysMode(): KeysMode { return keysMode; }

export function setKeysMode(mode: KeysMode): void {
    if (mode === keysMode) return;
    keysMode = mode;
    try { localStorage?.setItem(STORAGE_KEY_KEYS, mode); } catch (_) { /* ignore */ }
    notify();
}

export function toggleKeysMode(): KeysMode {
    setKeysMode(keysMode === 'on' ? 'off' : 'on');
    return keysMode;
}

// ---------- bgmMode ----------
export function getBgmMode(): AudioMode { return bgmMode; }

export function setBgmMode(mode: AudioMode): void {
    if (mode === bgmMode) return;
    bgmMode = mode;
    try { localStorage?.setItem(STORAGE_KEY_BGM, mode); } catch (_) { /* ignore */ }
    notify();
}

export function toggleBgmMode(): AudioMode {
    setBgmMode(bgmMode === 'on' ? 'off' : 'on');
    return bgmMode;
}

// ---------- sfxMode ----------
export function getSfxMode(): AudioMode { return sfxMode; }

export function setSfxMode(mode: AudioMode): void {
    if (mode === sfxMode) return;
    sfxMode = mode;
    try { localStorage?.setItem(STORAGE_KEY_SFX, mode); } catch (_) { /* ignore */ }
    notify();
}

export function toggleSfxMode(): AudioMode {
    setSfxMode(sfxMode === 'on' ? 'off' : 'on');
    return sfxMode;
}

// ---------- bgmVolume ----------
export function getBgmVolume(): number { return bgmVolume; }

/** @param snap  When true (default) the incoming value is snapped to
 *  one of the 5 discrete AUDIO_VOLUME_STEPS entries — matches the old
 *  cycle-button UI. Pass `false` for the settings-panel slider so
 *  drag values stay continuous (0..1) and the audio doesn't jump. */
export function setBgmVolume(v: number, snap: boolean = true): void {
    let val = Math.max(0, Math.min(1, v));
    if (snap) val = snapToVolumeStep(val);
    if (val === bgmVolume) return;
    bgmVolume = val;
    // Keep bgmMode in sync so legacy consumers (and existing on/off UIs)
    // still work: 0 volume ⇒ off, non-zero ⇒ on.
    const newMode: AudioMode = val > 0 ? 'on' : 'off';
    if (newMode !== bgmMode) {
        bgmMode = newMode;
        try { localStorage?.setItem(STORAGE_KEY_BGM, newMode); } catch (_) { /* ignore */ }
    }
    try { localStorage?.setItem(STORAGE_KEY_BGM_VOL, String(val)); } catch (_) { /* ignore */ }
    notify();
}

/** Cycle to the next volume step, wrapping around back to mute. Returns
 *  the newly-set volume so UI can re-render the label in the same tick. */
export function cycleBgmVolume(): number {
    const idx = AUDIO_VOLUME_STEPS.indexOf(bgmVolume);
    const nextIdx = idx < 0 ? 0 : (idx + 1) % AUDIO_VOLUME_STEPS.length;
    setBgmVolume(AUDIO_VOLUME_STEPS[nextIdx]);
    return bgmVolume;
}

// ---------- sfxVolume ----------
export function getSfxVolume(): number { return sfxVolume; }

/** @param snap  See setBgmVolume — pass `false` for slider drag. */
export function setSfxVolume(v: number, snap: boolean = true): void {
    let val = Math.max(0, Math.min(1, v));
    if (snap) val = snapToVolumeStep(val);
    if (val === sfxVolume) return;
    sfxVolume = val;
    const newMode: AudioMode = val > 0 ? 'on' : 'off';
    if (newMode !== sfxMode) {
        sfxMode = newMode;
        try { localStorage?.setItem(STORAGE_KEY_SFX, newMode); } catch (_) { /* ignore */ }
    }
    try { localStorage?.setItem(STORAGE_KEY_SFX_VOL, String(val)); } catch (_) { /* ignore */ }
    notify();
}

export function cycleSfxVolume(): number {
    const idx = AUDIO_VOLUME_STEPS.indexOf(sfxVolume);
    const nextIdx = idx < 0 ? 0 : (idx + 1) % AUDIO_VOLUME_STEPS.length;
    setSfxVolume(AUDIO_VOLUME_STEPS[nextIdx]);
    return sfxVolume;
}

// ---------- hapticMode ----------
// Cross-platform touch/rumble feedback (iOS UIImpactFeedbackGenerator,
// Android Vibrator, web navigator.vibrate). ON by default; players who
// dislike vibration can flip it off from the Settings panel.
function loadHaptic(): AudioMode {
    return loadAudio(STORAGE_KEY_HAPTIC, 'on');
}
let hapticMode: AudioMode = loadHaptic();
export function getHapticMode(): AudioMode { return hapticMode; }
export function setHapticMode(mode: AudioMode): void {
    if (mode !== 'on' && mode !== 'off') return;
    if (mode === hapticMode) return;
    hapticMode = mode;
    try { localStorage?.setItem(STORAGE_KEY_HAPTIC, mode); } catch (_) { /* ignore */ }
    notify();
}
export function toggleHapticMode(): AudioMode {
    setHapticMode(hapticMode === 'on' ? 'off' : 'on');
    return hapticMode;
}

// ---------- controlMode ----------
// Tower rotation input scheme. Three values:
//   - 'legacy'    : old scheme — horizontal swipe = rotate 1 col;
//                   swipe+hold enters continuous-repeat rotation.
//   - 'dragFling' : new default — drag = per-column rotation, release
//                   with velocity = inertia spin with friction.
//   - 'buttons'   : on-screen L/R buttons for rotation; swipe input
//                   disabled (tap + swipe-down still work).
export type ControlMode = 'legacy' | 'dragFling' | 'buttons';
function loadControl(): ControlMode {
    try {
        const v = localStorage?.getItem(STORAGE_KEY_CONTROL);
        if (v === 'legacy' || v === 'dragFling' || v === 'buttons') return v;
    } catch (_) { /* ignore */ }
    return 'dragFling';
}
let controlMode: ControlMode = loadControl();
export function getControlMode(): ControlMode { return controlMode; }
export function setControlMode(mode: ControlMode): void {
    if (mode !== 'legacy' && mode !== 'dragFling' && mode !== 'buttons') return;
    if (mode === controlMode) return;
    controlMode = mode;
    try { localStorage?.setItem(STORAGE_KEY_CONTROL, mode); } catch (_) { /* ignore */ }
    notify();
}
