/**
 * AdManager — Google AdMob (iOS) wrapper.
 *
 * On iOS: routes to AdMobBridge (Swift) via native.bridge.
 * On other platforms: silent no-op — showRewarded resolves
 * {success:false, kind:'platform-unsupported'} so callers gate on
 * `result.success && result.rewarded` uniformly across channels.
 *
 * Boot sequence:
 *   1. AppStoreBoot (channel-specific) → AdManager.init() with the
 *      ad unit IDs (see below — REPLACE placeholders for prod).
 *      Note: AdMob App ID lives in Info.plist as GADApplicationIdentifier,
 *      NOT here.
 *   2. Google Mobile Ads SDK initialises async (~1-2s cold start),
 *      starts loading rewarded (per slot) + interstitial ad slots.
 *   3. Gameplay hooks call showRewarded(slot) / showInterstitial() when
 *      appropriate; if no ad is ready, resolves with 'not-ready'
 *      and immediately triggers a load for next time.
 *
 * Rewarded slots — two independent AdMob rewarded ad units so we get
 * per-placement analytics and can tune fill/floor independently:
 *   - 'magic': picker refresh (HudController.doAdRefresh)
 *   - 'fate':  fate piece reroll (HudController.onFateReroll)
 *
 * Interstitial is a single slot (game-over popup, every 3rd death).
 *
 * Provider swap history: originally targeted AppLovin MAX. Switched
 * to AdMob because AppLovin requires an already-published App Store
 * app to activate the account; AdMob does not. AppLovin bridge files
 * are retained in the tree for future mediation use.
 */

import { native, sys } from 'cc';

// ============================================================
// Google's public TEST ad unit IDs — always serve test creatives,
// safe to use in dev/TestFlight without account approval.
//
// BEFORE SHIPPING TO APP STORE:
//   1. Create your AdMob account (https://apps.admob.com)
//   2. Add your iOS app → get an App ID (ca-app-pub-XXXX~XXXX)
//      → paste into Info.plist GADApplicationIdentifier
//   3. Create THREE ad units:
//        - Rewarded (Magic item refresh) → REWARDED_MAGIC_UNIT_ID
//        - Rewarded (Fate piece reroll)  → REWARDED_FATE_UNIT_ID
//        - Interstitial (Game over)      → INTERSTITIAL_AD_UNIT_ID
//   4. Fill Info.plist SKAdNetworkItems from
//      https://developers.google.com/admob/ios/ios14
//
// Test IDs reference:
// https://developers.google.com/admob/ios/test-ads#demo_ad_units
// ============================================================
const REWARDED_MAGIC_UNIT_ID  = 'ca-app-pub-3940256099942544/1712485313';  // TEST rewarded
const REWARDED_FATE_UNIT_ID   = 'ca-app-pub-3940256099942544/1712485313';  // TEST rewarded (same test unit for now)
const INTERSTITIAL_AD_UNIT_ID = 'ca-app-pub-3940256099942544/4411468910';  // TEST interstitial

const EV = {
    init:                 'ads.init',
    loadRewarded:         'ads.loadRewarded',
    showRewarded:         'ads.showRewarded',
    loadInterstitial:     'ads.loadInterstitial',
    showInterstitial:     'ads.showInterstitial',
    initResult:           'ads.initResult',
    rewardedResult:       'ads.rewardedResult',
    interstitialResult:   'ads.interstitialResult',
} as const;

/** Slot key for rewarded ad units. Keep in sync with AdMobBridge.swift's
 *  SLOT_* constants and the AdMob dashboard unit naming. */
export type RewardedSlot = 'magic' | 'fate';

export type AdErrorKind =
    | 'platform-unsupported'
    | 'not-ready'
    | 'display-failed'
    | 'timeout'
    | 'busy'
    | 'unknown';

export interface RewardedResult {
    success:   boolean;
    rewarded?: boolean;   // true only if user actually watched to reward
    slot?:     RewardedSlot;
    kind?:     AdErrorKind;
    error?:    string;
}
export interface InterstitialResult {
    success: boolean;
    kind?:   AdErrorKind;
    error?:  string;
}

// ---------------------------------------------------------------------------
// One-shot resolvers keyed by event/slot. Rewarded is per-slot so a
// picker refresh watch doesn't steal the resolver of a concurrent
// fate reroll (native side also guards, but JS state stays clean).
// ---------------------------------------------------------------------------
type OneShot<T> = (v: T) => void;
const pendingRewarded: Record<RewardedSlot, OneShot<RewardedResult> | null> = {
    magic: null,
    fate:  null,
};
let pendingInterstitial: OneShot<InterstitialResult> | null = null;
let pendingInit:         OneShot<{success:boolean}>  | null = null;

if (sys.isNative && sys.os === sys.OS.IOS && (native as any).bridge) {
    const prev = (native as any).bridge.onNative;
    (native as any).bridge.onNative = (event: string, arg: string | null) => {
        switch (event) {
            case EV.initResult: {
                const w = pendingInit; pendingInit = null;
                if (w) {
                    try { w(JSON.parse(arg ?? '{}')); }
                    catch { w({ success: false }); }
                }
                return;
            }
            case EV.rewardedResult: {
                // Route the result to the slot's pending resolver. If
                // the payload omits `slot` (older builds / crash path),
                // fall back to whichever slot is currently pending.
                let payload: RewardedResult = { success: false, kind: 'unknown' };
                try { payload = JSON.parse(arg ?? '{}'); }
                catch (e) { payload.error = String(e); }
                const slot: RewardedSlot = (payload.slot as RewardedSlot)
                    ?? (pendingRewarded.magic ? 'magic'
                        : pendingRewarded.fate  ? 'fate'
                        : 'magic');
                const w = pendingRewarded[slot];
                pendingRewarded[slot] = null;
                if (w) w(payload);
                return;
            }
            case EV.interstitialResult: {
                const w = pendingInterstitial; pendingInterstitial = null;
                if (w) {
                    try { w(JSON.parse(arg ?? '{}')); }
                    catch (e) { w({ success: false, kind: 'unknown', error: String(e) }); }
                }
                return;
            }
        }
        if (typeof prev === 'function') prev(event, arg);
    };
}

const iosBridge = sys.isNative && sys.os === sys.OS.IOS && !!(native as any).bridge;

let initialised = false;
export const AdManager = {

    /** Initialise the SDK — call ONCE at boot (from AppStoreBoot).
     *  Idempotent client-side; native side also guards. */
    init(): Promise<{ success: boolean }> {
        if (!iosBridge) {
            return Promise.resolve({ success: false });
        }
        if (initialised) return Promise.resolve({ success: true });
        initialised = true;
        return new Promise((resolve) => {
            pendingInit = resolve;
            // sdkKey field intentionally omitted — AdMob reads
            // GADApplicationIdentifier from Info.plist, not from
            // this init payload.
            (native as any).bridge.sendToNative(EV.init, JSON.stringify({
                rewardedMagicId: REWARDED_MAGIC_UNIT_ID,
                rewardedFateId:  REWARDED_FATE_UNIT_ID,
                interstitialId:  INTERSTITIAL_AD_UNIT_ID,
            }));
        });
    },

    /** Show a rewarded video for the given slot. Resolves with
     *  rewarded=true if the player watched to reward completion.
     *  Timeout 60s so a stuck SDK doesn't hang gameplay forever. */
    showRewarded(slot: RewardedSlot = 'magic', timeoutMs = 60_000): Promise<RewardedResult> {
        if (!iosBridge) {
            return Promise.resolve({ success: false, kind: 'platform-unsupported', error: 'iOS-only', slot });
        }
        if (pendingRewarded[slot]) {
            return Promise.resolve({ success: false, kind: 'busy', error: `rewarded[${slot}] already in flight`, slot });
        }
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                pendingRewarded[slot] = null;
                resolve({ success: false, kind: 'timeout', error: `no result after ${timeoutMs}ms`, slot });
            }, timeoutMs);
            pendingRewarded[slot] = (r) => { clearTimeout(timer); resolve({ ...r, slot: r.slot ?? slot }); };
            (native as any).bridge.sendToNative(EV.showRewarded, slot);
        });
    },

    /** Force preload rewarded slot. Normally not needed — the SDK
     *  auto-reloads after each show. Useful if game logic knows a
     *  showRewarded is imminent (e.g. entering endless mode). */
    loadRewarded(slot: RewardedSlot = 'magic'): void {
        if (!iosBridge) return;
        (native as any).bridge.sendToNative(EV.loadRewarded, slot);
    },

    /** Show an interstitial (full-screen non-rewarded). Resolves
     *  success=true when the ad dismisses; success=false if no ad
     *  ready or displaying failed. */
    showInterstitial(timeoutMs = 30_000): Promise<InterstitialResult> {
        if (!iosBridge) {
            return Promise.resolve({ success: false, kind: 'platform-unsupported', error: 'iOS-only' });
        }
        if (pendingInterstitial) {
            return Promise.resolve({ success: false, kind: 'busy', error: 'another interstitial already in flight' });
        }
        return new Promise((resolve) => {
            const timer = setTimeout(() => {
                pendingInterstitial = null;
                resolve({ success: false, kind: 'timeout', error: `no result after ${timeoutMs}ms` });
            }, timeoutMs);
            pendingInterstitial = (r) => { clearTimeout(timer); resolve(r); };
            (native as any).bridge.sendToNative(EV.showInterstitial, '');
        });
    },

    loadInterstitial(): void {
        if (!iosBridge) return;
        (native as any).bridge.sendToNative(EV.loadInterstitial, '');
    },
};
