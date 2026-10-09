/**
 * AnalyticsApi — cross-platform Firebase Analytics / Crashlytics /
 * Remote Config wrapper.
 *
 * ARCHITECTURE
 * ------------
 * Single TS entry point; each method branches on `sys.platform`:
 *   Android  → native.reflection.callStaticMethod('com/cocos/game/FirebaseBridge', ...)
 *   iOS      → native.reflection.callStaticMethod('FirebaseBridgeGlue', ...)
 *   Web/Editor → no-op (returns immediately, logs at debug)
 *
 * The native bridges themselves initialize Firebase with
 * `setAnalyticsCollectionEnabled(false)` — data collection stays OFF
 * until `AnalyticsApi.setEnabled(true)` is called (typically from
 * LoadingController after ConsentApi confirms the user agreed to the
 * "data analytics" checkbox). This matches consent scheme A from
 * the design doc: default-off, opt-in.
 *
 * EVENT NAMING CONVENTION
 * -----------------------
 * Whenever a Firebase-predefined event covers what we want, USE THE
 * PREDEFINED NAME (Firebase Console auto-populates Revenue/Progression/
 * Retention reports from these). Custom names for anything else.
 *
 *   Firebase predefined  → helper here
 *   ─────────────────────────────────────────
 *   purchase             → logPurchase()
 *   begin_checkout       → logBeginCheckout()
 *   earn_virtual_currency → logAdReward()
 *   level_start          → logLevelStart()
 *   level_end            → logLevelEnd()
 *
 *   Custom → logCustom()
 *   ────────────────────
 *   stage_fail, player_register, login_success, refresh_used, ...
 *
 * REMOTE CONFIG
 * -------------
 * Fetch is fire-and-forget on boot; get* accessors return cached
 * values or the fallback. First-run: no cache, fallback wins. Once
 * fetched, values persist in the native side's local cache and are
 * available on next boot instantly.
 */

import { sys, native, log } from 'cc';

// ────────────────────────────────────────────────────────────────
// Platform detection — evaluated once at module load. `sys.platform`
// is set by Cocos on native boot; native.reflection is only defined
// on native runtimes.
// ────────────────────────────────────────────────────────────────
const IS_ANDROID = sys.platform === sys.Platform.ANDROID
    || String((sys as any).os ?? '').toLowerCase().includes('android');
// iOS Firebase bridge was removed from channel/app-store (see
// native/engine/ios/CMakeLists.txt note) — treat iOS as non-native
// here so every logXxx helper short-circuits to the editor/web
// no-op branch. Re-enable this flag when Firebase is re-integrated
// (e.g. via Swift Package Manager + a new FirebaseBridgeGlue).
const IS_IOS     = false; // was: sys.platform === sys.Platform.IOS;
const IS_NATIVE  = IS_ANDROID || IS_IOS;
const HAS_JSB    = IS_NATIVE
    && typeof (native as any)?.reflection?.callStaticMethod === 'function';

// Bridge class names — must stay in sync with the native code.
const ANDROID_CLASS = 'com/cocos/game/FirebaseBridge';
const IOS_CLASS     = 'FirebaseBridgeGlue';   // unused while IS_IOS=false

// ────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────

/** Firebase event param values — strings, numbers, or bool. Firebase
 *  itself coerces bool to number 1/0; be explicit here for clarity. */
export type ParamValue = string | number | boolean;
export type EventParams = Record<string, ParamValue>;

export interface PurchaseParams {
    /** ISO 4217 currency code (KRW, USD, JPY, ...). REQUIRED. */
    currency: string;
    /** Price in major units (not cents). e.g. 5.99 for USD, 5500 for KRW. */
    value: number;
    /** Store transaction id (uniques the purchase). */
    transactionId: string;
    /** SKU sold. */
    sku: string;
    /** Optional human-readable item name; defaults to sku. */
    itemName?: string;
}

export interface AdRewardParams {
    /** Virtual currency the ad paid out (e.g. "gems"). */
    virtualCurrencyName: string;
    /** Amount of that currency granted. */
    value: number;
    /** Optional ad placement identifier. */
    placement?: string;
}

// ────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────

/** Serialize event params to a stable JSON string. Native side
 *  parses this back into a Bundle / NSDictionary. Filter out
 *  undefined/null so we don't pollute Firebase's param schema. */
function serialize(params: EventParams | undefined): string {
    if (!params) return '{}';
    const clean: EventParams = {};
    for (const k of Object.keys(params)) {
        const v = params[k];
        if (v === undefined || v === null) continue;
        clean[k] = v;
    }
    return JSON.stringify(clean);
}

/** Fire a native call, swallow any error so a broken bridge never
 *  crashes gameplay. Log at debug so we can see it in Cocos console
 *  during dev. */
function safeCall(method: string, signature: string, ...args: any[]): any {
    if (!HAS_JSB) return null;
    const cls = IS_ANDROID ? ANDROID_CLASS : IOS_CLASS;
    try {
        return (native as any).reflection.callStaticMethod(cls, method, signature, ...args);
    } catch (e: any) {
        log(`[Analytics] ${method} failed: ${e?.message ?? e}`);
        return null;
    }
}

// ────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────

export class AnalyticsApi {

    // ─── Lifecycle ────────────────────────────────────────────

    /** Enable or disable Firebase data collection. Called on consent
     *  changes. Native side flips both Analytics and Crashlytics. */
    static setEnabled(enabled: boolean): void {
        if (!HAS_JSB) { log('[Analytics] setEnabled: no bridge'); return; }
        safeCall(
            'setAnalyticsEnabled',
            IS_ANDROID ? '(Z)V' : 'setAnalyticsEnabled:',
            enabled,
        );
    }

    /** Attach a user id (typically our internal player uuid). Firebase
     *  hashes this before storing; do NOT pass personally identifiable
     *  info. Call once after login, and after uuid changes. */
    static setUserId(uuid: string | null): void {
        if (!HAS_JSB) return;
        safeCall(
            'setUserId',
            IS_ANDROID ? '(Ljava/lang/String;)V' : 'setUserId:',
            uuid ?? '',
        );
    }

    /** Attach a durable user property (max 25 total per app). Great
     *  for slicing dashboards by channel / build / experiment cohort.
     *  Values must be < 36 chars, keys < 24 chars — Firebase rejects
     *  longer ones silently. */
    static setUserProperty(key: string, value: string): void {
        if (!HAS_JSB) return;
        safeCall(
            'setUserProperty',
            IS_ANDROID ? '(Ljava/lang/String;Ljava/lang/String;)V' : 'setUserProperty:value:',
            key, value ?? '',
        );
    }

    // ─── Analytics events ────────────────────────────────────

    /** Log a custom event with arbitrary params. Prefer the
     *  specialized helpers below (logPurchase / logLevelStart / …)
     *  when a Firebase-predefined event matches your intent. */
    static logCustom(name: string, params?: EventParams): void {
        if (!HAS_JSB) { log(`[Analytics] event ${name}`, params); return; }
        safeCall(
            'logEvent',
            IS_ANDROID ? '(Ljava/lang/String;Ljava/lang/String;)V' : 'logEvent:paramsJson:',
            name, serialize(params),
        );
    }

    /** Firebase `purchase` predefined event. Feeds directly into the
     *  Revenue / ARPU / LTV reports in Firebase Console. */
    static logPurchase(p: PurchaseParams): void {
        AnalyticsApi.logCustom('purchase', {
            currency:       p.currency,
            value:          p.value,
            transaction_id: p.transactionId,
            item_id:        p.sku,
            item_name:      p.itemName ?? p.sku,
        });
    }

    /** Firebase `begin_checkout` predefined event. */
    static logBeginCheckout(p: Omit<PurchaseParams, 'transactionId'>): void {
        AnalyticsApi.logCustom('begin_checkout', {
            currency:   p.currency,
            value:      p.value,
            item_id:    p.sku,
            item_name:  p.itemName ?? p.sku,
        });
    }

    /** Firebase `earn_virtual_currency` predefined event — logged when
     *  the player is granted in-game currency (e.g. gems from a
     *  rewarded ad). Extra params (placement) are carried through. */
    static logAdReward(p: AdRewardParams): void {
        AnalyticsApi.logCustom('earn_virtual_currency', {
            virtual_currency_name: p.virtualCurrencyName,
            value:                 p.value,
            ...(p.placement ? { placement: p.placement } : {}),
        });
    }

    /** Firebase `level_start` — logged when player starts a stage. */
    static logLevelStart(mode: string, level: number): void {
        AnalyticsApi.logCustom('level_start', {
            level_name: `${mode}:${level}`,
        });
    }

    /** Firebase `level_end` — logged on successful stage clear.
     *  `success` param is Firebase-predefined: 1 = cleared, 0 = failed. */
    static logLevelEnd(mode: string, level: number, elapsedSec: number, success: boolean): void {
        AnalyticsApi.logCustom('level_end', {
            level_name: `${mode}:${level}`,
            success:    success ? 1 : 0,
            elapsed_sec: Math.round(elapsedSec),
        });
    }

    // ─── Crashlytics ─────────────────────────────────────────

    /** Log a non-fatal error to Crashlytics. Auto-uncaught JS/native
     *  crashes are captured by Crashlytics automatically; use this
     *  for expected-but-notable errors (bad server response,
     *  purchase-flow failure, etc.). */
    static logError(err: Error | string, context?: EventParams): void {
        const msg = typeof err === 'string' ? err : (err?.message ?? String(err));
        const stack = typeof err === 'string' ? '' : (err?.stack ?? '');
        if (!HAS_JSB) { log('[Analytics] error', msg, context); return; }
        safeCall(
            'logError',
            IS_ANDROID
                ? '(Ljava/lang/String;Ljava/lang/String;Ljava/lang/String;)V'
                : 'logError:stack:contextJson:',
            msg, stack, serialize(context),
        );
    }

    /** Attach a breadcrumb to the next crash report. Cheap; call
     *  liberally around suspicious code paths. */
    static breadcrumb(message: string): void {
        if (!HAS_JSB) return;
        safeCall(
            'log',
            IS_ANDROID ? '(Ljava/lang/String;)V' : 'log:',
            message,
        );
    }

    // ─── Remote Config ───────────────────────────────────────

    /** Kick off an async fetch. Fire-and-forget. First fetch may take
     *  up to a few seconds on cold network; subsequent fetches use
     *  Firebase's built-in 12h minimum interval unless overridden
     *  server-side. Safe to call on every boot. */
    static fetchRemoteConfig(): void {
        if (!HAS_JSB) return;
        safeCall(
            'fetchRemoteConfig',
            IS_ANDROID ? '()V' : 'fetchRemoteConfig',
        );
    }

    /** Read a Remote Config string key, returning `fallback` if the
     *  key is missing or fetch has never completed. Synchronous —
     *  reads from local cache. */
    static getConfigString(key: string, fallback: string): string {
        if (!HAS_JSB) return fallback;
        const v = safeCall(
            'getConfigString',
            IS_ANDROID
                ? '(Ljava/lang/String;Ljava/lang/String;)Ljava/lang/String;'
                : 'getConfigString:fallback:',
            key, fallback,
        );
        return typeof v === 'string' ? v : fallback;
    }

    /** Read a Remote Config numeric key. */
    static getConfigNumber(key: string, fallback: number): number {
        const s = AnalyticsApi.getConfigString(key, String(fallback));
        const n = Number(s);
        return Number.isFinite(n) ? n : fallback;
    }

    /** Read a Remote Config bool key. Accepts "true"/"false"/"1"/"0". */
    static getConfigBool(key: string, fallback: boolean): boolean {
        const s = AnalyticsApi.getConfigString(key, fallback ? 'true' : 'false').toLowerCase();
        if (s === 'true' || s === '1' || s === 'yes')  return true;
        if (s === 'false' || s === '0' || s === 'no')  return false;
        return fallback;
    }
}
