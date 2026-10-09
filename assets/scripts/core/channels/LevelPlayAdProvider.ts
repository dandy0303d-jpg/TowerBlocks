/**
 * LevelPlayAdProvider — Unity LevelPlay (formerly ironSource) IAdProvider.
 *
 * LevelPlay is a mediation SDK that manages a waterfall / bidding across
 * many ad networks (Unity Ads, AdMob, Meta, AppLovin, Chartboost, etc.)
 * so we don't have to integrate each one separately — LevelPlay picks
 * the highest-bidding ad per impression, maximising eCPM.
 *
 * Runs on Android AND iOS (shared implementation).
 *   Android  → TS ⇄ Kotlin via native.bridge; Kotlin talks to
 *              `com.ironsource.mediationsdk.IronSource` (LevelPlay 9.x,
 *              adapters pulled via Gradle).
 *   iOS      → TS ⇄ Swift via native.bridge; Swift talks to
 *              `IronSource` from the LevelPlay iOS SDK (added via
 *              Swift Package Manager, adapters as separate SPM products).
 *
 * The event schema below is identical across both platforms — both
 * native bridges listen for the same `levelplay.*` events and reply
 * on the same channels. Game code never has to care which platform.
 *
 * Event schema — MUST stay lockstep with LevelPlayBridge.kt (Android)
 * AND LevelPlayBridge.swift / LevelPlayBridgeGlue.mm (iOS):
 *
 *   TS ─── sendToNative("levelplay.init", uuid)              → Kotlin
 *   TS ←── onNative("levelplay.initResult", {success})       ← Kotlin
 *
 *   (No explicit load — LevelPlay auto-loads rewarded ads after init.
 *    We just poll readiness and fire show when ready.)
 *
 *   TS ─── sendToNative("levelplay.rewardedReady")           → Kotlin
 *   TS ←── onNative("levelplay.rewardedReadyResult", {ready})
 *
 *   TS ─── sendToNative("levelplay.showRewarded", placement) → Kotlin
 *   TS ←── onNative("levelplay.showRewardedResult",
 *              {kind: 'rewarded' | 'dismissed' | 'error', reason?})
 *
 *   TS ←── onNative("levelplay.rewardedAvailable", {ready}) ← Kotlin push
 *              (Kotlin pushes this whenever availability CHANGES so TS
 *               can hide/show the "Watch Ad" button in real time.)
 *
 * The `uuid` param on init is the player uuid — used for S2S callback
 * routing (LevelPlay passes it as the `userId` field to the server).
 */

import { native, sys } from 'cc';
import { IAdProvider, AdShowResult } from './IAdProvider';

// Default Ad Unit ID — LevelPlay 9.x API takes the AD UNIT ID
// (dashboard Setup → Ad Units → your rewarded unit → ID), NOT the
// Placement Name. Update if you regenerate the ad unit.
//
// Current dashboard state:
//   Android — benMingFangKuai (rewarded) → 8sdnjo086acl132c
//   iOS     — benMingFangKuai (rewarded) → <fill-in-after-dashboard>
//
// LevelPlay has separate ad units per platform; the construct-time
// opts.rewardedAdUnit (see below) overrides this default so channel
// code can pass the right one from BuildConfig.
const DEFAULT_REWARDED_PLACEMENT = '8sdnjo086acl132c';

/** True on either supported native platform. */
function isSupportedOS(): boolean {
    return sys.os === sys.OS.ANDROID || sys.os === sys.OS.IOS;
}

const EV = {
    init:                  'levelplay.init',
    initResult:            'levelplay.initResult',
    rewardedReady:         'levelplay.rewardedReady',
    rewardedReadyResult:   'levelplay.rewardedReadyResult',
    showRewarded:          'levelplay.showRewarded',
    showRewardedResult:    'levelplay.showRewardedResult',
    rewardedAvailable:     'levelplay.rewardedAvailable',   // pushed by Kotlin
} as const;

interface NativeInitResult    { success: boolean; error?: string; }
interface NativeReadyResult   { ready:   boolean; }
interface NativeShowResult    {
    kind:    'rewarded' | 'dismissed' | 'error';
    reason?: string;
}

class Slot<T> {
    private pending: {
        resolve: (v: T) => void;
        reject: (e: Error) => void;
        timer: ReturnType<typeof setTimeout>;
    } | null = null;

    constructor(private readonly kind: string, private readonly timeoutMs = 60_000) {}

    wait(): Promise<T> {
        if (this.pending) return Promise.reject(new Error(`${this.kind}: another call in progress`));
        return new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => {
                if (this.pending) {
                    this.pending = null;
                    reject(new Error(`${this.kind}: timeout after ${this.timeoutMs}ms`));
                }
            }, this.timeoutMs);
            this.pending = { resolve, reject, timer };
        });
    }

    deliver(rawJson: string): void {
        const p = this.pending;
        if (!p) return;
        this.pending = null;
        clearTimeout(p.timer);
        try {
            p.resolve(JSON.parse(rawJson) as T);
        } catch (e) {
            p.reject(new Error(`${this.kind}: invalid JSON — ${(e as Error).message}`));
        }
    }
}

export class LevelPlayAdProvider implements IAdProvider {

    // LevelPlay init runs a bunch of network handshakes, can be slow.
    private readonly initSlot         = new Slot<NativeInitResult>('init',         60_000);
    private readonly readySlot        = new Slot<NativeReadyResult>('rewardedReady', 5_000);
    // Show timeout wraps the ad play + user idle time.
    private readonly showSlot         = new Slot<NativeShowResult>('showRewarded', 300_000);

    private hookInstalled = false;
    private inited        = false;
    private _ready        = false;
    /** Player uuid — passed to Kotlin so LevelPlay tags the impression
     *  with our user id, which the S2S callback echoes back. */
    private playerUuid: string = '';

    /** Per-platform ad unit id. Falls back to DEFAULT_REWARDED_PLACEMENT
     *  (the Android unit) if the caller doesn't override — channel
     *  branches should pass the right one from BuildConfig. */
    private rewardedAdUnit: string = DEFAULT_REWARDED_PLACEMENT;

    /** Optional constructor args:
     *    uuid           — player uuid for S2S reward attribution
     *    rewardedAdUnit — LevelPlay ad unit id (per platform; set from
     *                     BuildConfig in each channel)
     *  Provider still works without them but server-side reward
     *  callbacks won't know which wallet to credit — call setters
     *  before init() if constructing lazily. */
    constructor(opts?: { uuid?: string; rewardedAdUnit?: string }) {
        this.playerUuid = opts?.uuid ?? '';
        if (opts?.rewardedAdUnit) this.rewardedAdUnit = opts.rewardedAdUnit;
    }

    setPlayerUuid(uuid: string): void {
        this.playerUuid = uuid;
    }

    private installHook(): void {
        if (this.hookInstalled) return;
        this.hookInstalled = true;
        const bridge = (native as any)?.bridge;
        if (!bridge || typeof bridge.onNative !== 'function') {
            console.warn('[LevelPlay] native.bridge not available — running in stub mode');
            return;
        }
        const prevOnNative = bridge.onNative;
        bridge.onNative = (arg0: string, arg1: string): void => {
            switch (arg0) {
                case EV.initResult:          this.initSlot.deliver(arg1); return;
                case EV.rewardedReadyResult: this.readySlot.deliver(arg1); return;
                case EV.rewardedAvailable:
                    // Kotlin push — availability changed. Update flag so
                    // isRewardedAdReady() reflects it without a round trip.
                    try {
                        const r = JSON.parse(arg1) as NativeReadyResult;
                        this._ready = !!r.ready;
                    } catch { /* ignore */ }
                    return;
                case EV.showRewardedResult:
                    this._ready = false;   // consumed; will flip back via rewardedAvailable
                    this.showSlot.deliver(arg1);
                    return;
            }
            if (typeof prevOnNative === 'function') prevOnNative(arg0, arg1);
        };
    }

    private send(event: string, arg: string = ''): void {
        const bridge = (native as any)?.bridge;
        if (!bridge || typeof bridge.sendToNative !== 'function') {
            console.warn(`[LevelPlay] cannot send ${event} — native.bridge missing`);
            return;
        }
        bridge.sendToNative(event, arg);
    }

    async init(): Promise<void> {
        if (this.inited) return;
        if (!isSupportedOS()) {
            console.log('[LevelPlay] unsupported platform (editor/web), init is no-op');
            this.inited = true;
            return;
        }
        this.installHook();
        const waiter = this.initSlot.wait();
        // Send the uuid so Kotlin can call IronSource.setUserId(uuid) —
        // required for S2S reward attribution.
        this.send(EV.init, this.playerUuid);
        const r = await waiter;
        if (!r.success) {
            throw new Error(`levelplay init failed: ${r.error ?? 'unknown'}`);
        }
        this.inited = true;
        console.log('[LevelPlay] init OK; rewarded ads auto-load in background');
    }

    /** No-op for LevelPlay — it auto-loads rewarded videos after init
     *  and re-loads after every show. Kept in the interface for parity
     *  with providers that require explicit loads. */
    async loadRewardedAd(): Promise<void> {
        if (!isSupportedOS()) return;
        if (!this.inited) {
            try { await this.init(); } catch { return; }
        }
        // Kick a fresh readiness check so `_ready` reflects the current
        // state (in case we missed a push while paused).
        this.installHook();
        try {
            const waiter = this.readySlot.wait();
            this.send(EV.rewardedReady);
            const r = await waiter;
            this._ready = !!r.ready;
        } catch (e) {
            console.warn(`[LevelPlay] rewardedReady check failed: ${(e as Error).message}`);
        }
    }

    isRewardedAdReady(): boolean {
        return this._ready && isSupportedOS();
    }

    async showRewardedAd(placement?: string): Promise<AdShowResult> {
        if (!isSupportedOS()) {
            return { kind: 'error', reason: 'unsupported-platform' };
        }
        const adUnit = placement ?? this.rewardedAdUnit;
        if (!this.inited) {
            try { await this.init(); } catch (e) {
                return { kind: 'error', reason: (e as Error).message };
            }
        }
        if (!this._ready) {
            return { kind: 'error', reason: 'not-ready' };
        }
        this.installHook();
        try {
            const waiter = this.showSlot.wait();
            this.send(EV.showRewarded, adUnit);
            return await waiter;
        } catch (e) {
            return { kind: 'error', reason: (e as Error).message };
        }
    }
}
