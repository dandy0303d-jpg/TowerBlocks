/**
 * Cross-platform haptic feedback helper.
 *
 * Three canonical intensities: `light` / `medium` / `heavy` — mapped to
 * short vibration bursts (12 / 28 / 55 ms) on Android + iOS. Web falls
 * back to `navigator.vibrate` where available.
 *
 * Native path uses Cocos' built-in `jsb.device.vibrate(seconds)` which
 * routes to the platform Vibrator (Android) / haptic engine (iOS)
 * automatically. No extra JNI/Obj-C bridge needed for this MVP.
 *
 * Toggle via `HapticsManager.setEnabled(false)` — the setting persists
 * across sessions via localStorage so a player who dislikes haptics
 * only has to disable it once.
 *
 * Android platform note: the app manifest MUST declare
 *   <uses-permission android:name="android.permission.VIBRATE" />
 * or the vibrate call is a silent no-op on device. This lives in the
 * google-play branch's AndroidManifest.xml.
 */

import { sys } from 'cc';
import { getHapticMode } from '../core/Settings';

type Intensity = 'light' | 'medium' | 'heavy';

// Duration table (ms). Tuned so light is barely perceptible (rotation
// tick), medium is a clear "row cleared" pulse, and heavy is the "prop
// blast" thump — but none so long that rapid triggers overlap into a
// muddy buzz.
const DURATION_MS: Record<Intensity, number> = {
    light:  12,
    medium: 80,
    heavy:  120,
};

// Per-intensity throttle. iOS `jsb.device.vibrate` maps to
// AudioServicesPlaySystemSound (kSystemSoundID_Vibrate), which fires a
// FIXED ~400 ms buzz and ignores the duration argument — so if tower
// rotation fires 'light' on every column tick, back-to-back 400 ms
// buzzes merge into a continuous rumble that feels HEAVIER than a
// discrete embedded-prop impact. Fix: throttle light aggressively so
// rapid rotation still reads as an accented "tap-tap-tap" rather than
// a continuous drone. medium/heavy keep tight throttling because
// their trigger events are inherently rare.
const MIN_INTERVAL_MS_BY_INTENSITY: Record<Intensity, number> = {
    light:  200,
    medium: 40,
    heavy:  20,
};

export class HapticsManager {
    private static _lastFireAt: Partial<Record<Intensity, number>> = {};

    /** Source of truth: Settings.hapticMode (persisted to localStorage
     *  by the Settings module). Settings panel toggle writes through
     *  `setHapticMode('on'|'off')`, which this reads live every impact
     *  call — so runtime flips take effect on the very next trigger. */
    public static isEnabled(): boolean {
        return getHapticMode() === 'on';
    }

    /** Fire a canonical intensity pulse. Silent no-op if the user
     *  disabled haptics or the platform doesn't expose a vibrate API. */
    public static impact(intensity: Intensity): void {
        if (!HapticsManager.isEnabled()) return;
        const now = Date.now();
        const last = HapticsManager._lastFireAt[intensity] ?? 0;
        if (now - last < MIN_INTERVAL_MS_BY_INTENSITY[intensity]) return;
        HapticsManager._lastFireAt[intensity] = now;
        HapticsManager._vibrate(DURATION_MS[intensity]);
    }

    private static _vibrate(ms: number): void {
        // Native path (iOS / Android) via Cocos JSB.
        if (sys.isNative) {
            try {
                const g: any = globalThis as any;
                if (g.jsb && g.jsb.device && typeof g.jsb.device.vibrate === 'function') {
                    // Cocos native expects SECONDS.
                    g.jsb.device.vibrate(ms / 1000);
                    return;
                }
            } catch { /* fall through to web */ }
        }
        // Web / browser fallback — Chrome + Firefox on Android support this;
        // iOS Safari ignores it silently, which is fine.
        try {
            const nav: any = (globalThis as any).navigator;
            if (nav && typeof nav.vibrate === 'function') nav.vibrate(ms);
        } catch { /* ignore */ }
    }
}
