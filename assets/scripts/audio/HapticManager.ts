/**
 * HapticManager — cross-platform haptic feedback wrapper.
 *
 * iOS native: routes to HapticBridge (UIImpactFeedbackGenerator /
 * UINotificationFeedbackGenerator). Non-iOS: no-op.
 *
 * Guarded by Settings.getHapticMode() — silently drops when the
 * player has turned haptics off in the settings panel.
 *
 * Usage:
 *   HapticManager.instance.impact('light');   // line clear
 *   HapticManager.instance.impact('medium');  // item activation
 *   HapticManager.instance.impact('heavy');   // big event
 *   HapticManager.instance.impact('success'); // celebratory
 */

import { native, sys } from 'cc';
import { getHapticMode, subscribe } from '../core/Settings';

export type HapticStyle = 'light' | 'medium' | 'heavy' | 'success';

class HapticManagerImpl {
    private _enabled: boolean = getHapticMode() === 'on';
    // Bridge availability: only true on native iOS with the bridge
    // wired via AppDelegate. Cached to avoid the sys check per call.
    private _bridgeAvailable: boolean = sys.isNative
        && sys.os === sys.OS.IOS
        && !!(native as any).bridge;

    constructor() {
        // Keep _enabled in sync with the Settings store so the toggle
        // in the panel takes effect without a reload.
        subscribe(() => { this._enabled = getHapticMode() === 'on'; });
    }

    /** Fire a haptic pulse. Silent no-op on non-iOS or when disabled. */
    impact(style: HapticStyle): void {
        if (!this._enabled) return;
        if (!this._bridgeAvailable) return;
        try {
            (native as any).bridge.sendToNative('haptic.impact', style);
        } catch (e) {
            console.warn('[Haptic] sendToNative threw:', e);
        }
    }
}

export const HapticManager = { instance: new HapticManagerImpl() };
