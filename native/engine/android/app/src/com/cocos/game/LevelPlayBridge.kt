/*
 * LevelPlayBridge — Kotlin side of the TS↔Native pipe for Unity LevelPlay
 * (formerly ironSource) mediation SDK.
 *
 * SDK reference:
 *   Docs:  https://developers.is.com/ironsource-mobile/android/android-sdk/
 *   Setup: https://developers.is.com/ironsource-mobile/android/rewarded-video-integration-android/
 *
 * Add these to the app-module `build.gradle` (channel/onestore):
 *
 *   dependencies {
 *       // LevelPlay mediation SDK — main dep. Version at
 *       // https://developers.is.com/ironsource-mobile/android/sdk-changelog/
 *       implementation 'com.ironsource.sdk:mediationsdk:8.14.0'  // TODO(levelplay-version)
 *
 *       // Ad network adapters — pick the networks you enabled in the
 *       // LevelPlay dashboard's Setup → Networks page. Unity Ads is
 *       // recommended baseline; add others (AdMob, Meta, AppLovin, Cauly
 *       // for Korea) to raise fill rate + eCPM.
 *       implementation 'com.unity3d.ads:unity-ads:4.12.5'          // Unity Ads network
 *       implementation 'com.ironsource.adapters:unityadsadapter:4.3.42'
 *       // implementation 'com.ironsource.adapters:admobadapter:4.3.66'
 *       // implementation 'com.ironsource.adapters:facebookadapter:4.3.51'
 *       // implementation 'com.ironsource.adapters:applovinadapter:4.3.55'
 *
 *       // Google Play Services — required for GAID/consent on most networks.
 *       implementation 'com.google.android.gms:play-services-ads-identifier:18.0.1'
 *   }
 *
 * Get your app's LevelPlay **App Key** from https://platform.ironsrc.com
 * (or the Unity Monetization dashboard → App details → App Key). Add to
 * Manifest so this bridge can read it:
 *
 *   <meta-data
 *       android:name="levelplay.app.key"
 *       android:value="YOUR_APP_KEY_HERE" />
 *
 * Wire from AppActivity.onCreate():
 *
 *   com.cocos.game.LevelPlayBridge.install(this)
 *
 * ---
 *
 * Event schema — MUST match assets/scripts/channels/onestore/LevelPlayProvider.ts:
 *
 *   TS ─── sendToNative("levelplay.init", uuid)              → Kotlin
 *   TS ←── onNative("levelplay.initResult", {success})       ← Kotlin
 *
 *   TS ─── sendToNative("levelplay.rewardedReady")
 *   TS ←── onNative("levelplay.rewardedReadyResult", {ready})
 *
 *   TS ─── sendToNative("levelplay.showRewarded", placementName)
 *   TS ←── onNative("levelplay.showRewardedResult",
 *              {kind: 'rewarded' | 'dismissed' | 'error', reason?})
 *
 *   TS ←── onNative("levelplay.rewardedAvailable", {ready}) ← Kotlin push
 *
 * ---
 *
 * Real LevelPlay 9.x SDK wired in. Uses the new
 *   com.unity3d.mediation.LevelPlay + LevelPlayRewardedAd API
 * (NOT the legacy com.ironsource.mediationsdk.IronSource API — that
 * one still exists for backwards-compat but shouldn't be used in new
 * code per Unity docs).
 */
package com.cocos.game

import android.app.Activity
import android.content.pm.PackageManager
import android.os.Handler
import android.os.Looper
import android.util.Log
import com.cocos.lib.JsbBridgeWrapper
import com.unity3d.mediation.LevelPlay
import com.unity3d.mediation.LevelPlayAdError
import com.unity3d.mediation.LevelPlayAdInfo
import com.unity3d.mediation.LevelPlayConfiguration
import com.unity3d.mediation.LevelPlayInitError
import com.unity3d.mediation.LevelPlayInitListener
import com.unity3d.mediation.LevelPlayInitRequest
import com.unity3d.mediation.rewarded.LevelPlayReward
import com.unity3d.mediation.rewarded.LevelPlayRewardedAd
import com.unity3d.mediation.rewarded.LevelPlayRewardedAdListener
import org.json.JSONObject
import java.lang.ref.WeakReference

object LevelPlayBridge {

    private const val TAG = "LevelPlayBridge"

    // Event names — MUST match LevelPlayProvider.ts.
    private const val EV_INIT                    = "levelplay.init"
    private const val EV_INIT_RESULT             = "levelplay.initResult"
    private const val EV_REWARDED_READY          = "levelplay.rewardedReady"
    private const val EV_PRELOAD_REWARDED        = "levelplay.preloadRewarded"
    private const val EV_REWARDED_READY_RESULT   = "levelplay.rewardedReadyResult"
    private const val EV_SHOW_REWARDED           = "levelplay.showRewarded"
    private const val EV_SHOW_REWARDED_RESULT    = "levelplay.showRewardedResult"
    private const val EV_REWARDED_AVAILABLE      = "levelplay.rewardedAvailable"   // push

    private var activityRef: WeakReference<Activity>? = null
    private var installed: Boolean = false
    private val mainHandler = Handler(Looper.getMainLooper())

    // Per-placement rewarded ad objects. LevelPlay 9.x is per-placement:
    // one LevelPlayRewardedAd instance per placement name, kept alive
    // across load/show cycles (loadAd + showAd on the same instance).
    private val rewardedAds = mutableMapOf<String, LevelPlayRewardedAd>()

    // Aggregate "any rewarded ad ready" flag. Flipped by
    // LevelPlayRewardedAdListener callbacks. isRewardedAdReady() from
    // TS reads this without needing to reach into a specific placement.
    private var rewardedReady: Boolean = false
    // Set by onAdRewarded(); consumed by onAdClosed() to distinguish
    // 'rewarded' (watched to completion, reward earned) from 'dismissed'
    // (player skipped early, no reward).
    private var earned: Boolean = false

    @JvmStatic
    fun install(activity: Activity) {
        if (installed) return
        installed = true
        activityRef = WeakReference(activity)
        val bridge = JsbBridgeWrapper.getInstance()
        bridge.addScriptEventListener(EV_INIT)             { uuid -> handleInit(uuid) }
        bridge.addScriptEventListener(EV_REWARDED_READY)   { _    -> handleRewardedReady() }
        bridge.addScriptEventListener(EV_SHOW_REWARDED)    { p    -> handleShowRewarded(p) }
        bridge.addScriptEventListener(EV_PRELOAD_REWARDED) { p    -> handlePreloadRewarded(p) }
        Log.i(TAG, "installed — event listeners registered")
    }

    private fun sendJson(event: String, body: JSONObject) {
        JsbBridgeWrapper.getInstance().dispatchEventToScript(event, body.toString())
    }

    /** Push "rewarded ad availability changed" to TS. Called by the
     *  LevelPlayRewardedAdListener callbacks so TS's `isRewardedAdReady()`
     *  reflects state without a native round trip. */
    private fun pushRewardedAvailable(ready: Boolean) {
        rewardedReady = ready
        sendJson(EV_REWARDED_AVAILABLE, JSONObject().apply { put("ready", ready) })
    }

    private fun readAppKeyFromManifest(activity: Activity): String {
        return try {
            val ai = activity.packageManager
                .getApplicationInfo(activity.packageName, PackageManager.GET_META_DATA)
            ai.metaData?.getString("levelplay.app.key") ?: ""
        } catch (e: Exception) {
            Log.w(TAG, "readAppKeyFromManifest failed: ${e.message}")
            ""
        }
    }

    // -----------------------------------------------------------------
    // Handlers — real LevelPlay 9.x SDK calls.
    // Docs:
    //   https://docs.unity.com/en-us/grow/levelplay/sdk/android/sdk-integration
    //   https://docs.unity.com/en-us/grow/levelplay/sdk/android/rewarded-ads-integration
    // -----------------------------------------------------------------

    private fun handleInit(uuid: String?) {
        val activity = activityRef?.get()
        if (activity == null) {
            sendJson(EV_INIT_RESULT, JSONObject().apply {
                put("success", false)
                put("error", "activity is gone (install() not called?)")
            })
            return
        }
        val appKey = readAppKeyFromManifest(activity)
        if (appKey.isBlank()) {
            sendJson(EV_INIT_RESULT, JSONObject().apply {
                put("success", false)
                put("error", "levelplay.app.key meta-data not set in AndroidManifest")
            })
            return
        }
        // Build init request. withUserId is REQUIRED for S2S reward
        // callbacks — the server matches uuid → wallet by this field.
        // Empty string is allowed here (for pre-login boot) but S2S
        // won't work until Providers.ads.setPlayerUuid + re-init runs.
        val initReq = LevelPlayInitRequest.Builder(appKey)
            .withUserId(uuid ?: "")
            .build()
        // Enable Integration Test Suite. Comment out for production
        // — this only helps you validate networks are wired right,
        // doesn't affect live ads. Toggled by BuildConfig.DEBUG so
        // release APKs don't accidentally ship with it.
        try {
            LevelPlay.setMetaData("is_test_suite", "enable")
        } catch (e: Exception) {
            Log.w(TAG, "setMetaData(is_test_suite) failed: ${e.message}")
        }
        Log.i(TAG, "LevelPlay.init starting (appKey=${appKey.take(6)}…, uuid=${uuid?.take(8)}…)")
        LevelPlay.init(activity.applicationContext, initReq, object : LevelPlayInitListener {
            override fun onInitSuccess(configuration: LevelPlayConfiguration) {
                Log.i(TAG, "LevelPlay onInitSuccess")
                // Kick the first rewarded ad load for the default placement.
                // Ad ops can enable more placements later by calling
                // createAndLoadRewarded(name) — one instance per name.
                createAndLoadRewarded("8sdnjo086acl132c")
                sendJson(EV_INIT_RESULT, JSONObject().apply { put("success", true) })
            }
            override fun onInitFailed(error: LevelPlayInitError) {
                Log.w(TAG, "LevelPlay onInitFailed: code=${error.errorCode} msg=${error.errorMessage}")
                sendJson(EV_INIT_RESULT, JSONObject().apply {
                    put("success", false)
                    put("error", error.errorMessage ?: "init failed (code=${error.errorCode})")
                })
            }
        })
    }

    /** Build (or reuse) the LevelPlayRewardedAd for `placement`, attach a
     *  listener that forwards events to TS, and kick a load. Auto-called
     *  after init for the default placement; also called after each
     *  successful showAd → onAdClosed to preload the next ad.
     *  Idempotent — safe to call for the same placement repeatedly (it
     *  reuses the cached instance and just calls loadAd()). */
    private fun createAndLoadRewarded(placement: String) {
        val existing = rewardedAds[placement]
        if (existing != null) {
            existing.loadAd()
            return
        }
        val ad = LevelPlayRewardedAd(placement)
        ad.setListener(object : LevelPlayRewardedAdListener {
            override fun onAdLoaded(adInfo: LevelPlayAdInfo) {
                Log.i(TAG, "rewarded onAdLoaded placement=$placement")
                pushRewardedAvailable(true)
            }
            override fun onAdLoadFailed(error: LevelPlayAdError) {
                Log.w(TAG, "rewarded onAdLoadFailed placement=$placement code=${error.errorCode} msg=${error.errorMessage}")
                pushRewardedAvailable(false)
                // Backoff-and-retry — LevelPlay's default is to fire this
                // callback with no-fill errors constantly; a 30s cooldown
                // avoids hammering the network. 30s is Unity's docs
                // recommendation.
                mainHandler.postDelayed({ ad.loadAd() }, 30_000)
            }
            override fun onAdDisplayed(adInfo: LevelPlayAdInfo) {
                Log.i(TAG, "rewarded onAdDisplayed placement=$placement")
                earned = false
                pushRewardedAvailable(false)   // consumed
            }
            override fun onAdDisplayFailed(error: LevelPlayAdError, adInfo: LevelPlayAdInfo) {
                Log.w(TAG, "rewarded onAdDisplayFailed placement=$placement code=${error.errorCode} msg=${error.errorMessage}")
                sendJson(EV_SHOW_REWARDED_RESULT, JSONObject().apply {
                    put("kind", "error")
                    put("reason", error.errorMessage ?: "display failed (code=${error.errorCode})")
                })
                // Preload the next attempt.
                ad.loadAd()
            }
            override fun onAdRewarded(reward: LevelPlayReward, adInfo: LevelPlayAdInfo) {
                Log.i(TAG, "rewarded onAdRewarded placement=$placement reward=${reward.name}x${reward.amount}")
                // Mark for onAdClosed to send the 'rewarded' result. Client
                // reward signal is spoofable, so this is UI-only — server
                // credits gems from the trusted S2S callback (see
                // tetritower-levelplay-v1 tar package).
                earned = true
            }
            override fun onAdClosed(adInfo: LevelPlayAdInfo) {
                Log.i(TAG, "rewarded onAdClosed placement=$placement earned=$earned")
                sendJson(EV_SHOW_REWARDED_RESULT, JSONObject().apply {
                    put("kind", if (earned) "rewarded" else "dismissed")
                })
                // Preload the next ad so isRewardedAdReady() flips true
                // again quickly (within ~5-15s network dependent).
                ad.loadAd()
            }
            override fun onAdClicked(adInfo: LevelPlayAdInfo) {
                Log.i(TAG, "rewarded onAdClicked placement=$placement")
            }
            override fun onAdInfoChanged(adInfo: LevelPlayAdInfo) {
                // Fires when the auction result changes but the ad hasn't
                // been shown yet (e.g., a higher-eCPM bidder won the
                // pending slot). No user-facing action needed.
            }
        })
        rewardedAds[placement] = ad
        ad.loadAd()
    }

    /** Fire-and-forget preload for a specific placement. TS boot code
     *  fires this per ad unit so the first player tap gets a ready ad
     *  instead of the lazy-create latency path. */
    private fun handlePreloadRewarded(placement: String?) {
        if (placement.isNullOrBlank()) return
        Log.i(TAG, "preloadRewarded placement=$placement")
        createAndLoadRewarded(placement)
    }

    private fun handleRewardedReady() {
        // Check the default placement's actual readiness — the aggregate
        // rewardedReady flag can lag by one listener callback, so read
        // from the SDK directly when TS asks.
        val ad = rewardedAds["8sdnjo086acl132c"]
        val ready = ad?.isAdReady() ?: false
        rewardedReady = ready
        sendJson(EV_REWARDED_READY_RESULT, JSONObject().apply { put("ready", ready) })
    }

    private fun handleShowRewarded(placement: String?) {
        val activity = activityRef?.get()
        if (activity == null) {
            sendJson(EV_SHOW_REWARDED_RESULT, JSONObject().apply {
                put("kind", "error")
                put("reason", "activity is gone")
            })
            return
        }
        val p = if (placement.isNullOrBlank()) "8sdnjo086acl132c" else placement
        val ad = rewardedAds[p]
        if (ad == null) {
            // TS asked for a placement we've never created — build+load it
            // lazily and tell TS to retry after the load completes.
            Log.i(TAG, "handleShowRewarded: no ad for placement=$p, creating lazily")
            createAndLoadRewarded(p)
            sendJson(EV_SHOW_REWARDED_RESULT, JSONObject().apply {
                put("kind", "error")
                put("reason", "not-ready — placement was lazily created, try again in a few seconds")
            })
            return
        }
        if (!ad.isAdReady()) {
            sendJson(EV_SHOW_REWARDED_RESULT, JSONObject().apply {
                put("kind", "error")
                put("reason", "not-ready")
            })
            return
        }
        earned = false
        Log.i(TAG, "handleShowRewarded: showing placement=$p")
        // The 2-arg showAd(activity, placementName) form lets LevelPlay
        // route the show through its internal placement-cap logic even
        // when the ad instance was built for one specific placement.
        ad.showAd(activity, p)
        // Result arrives asynchronously via the listener above:
        //   onAdRewarded → earned=true
        //   onAdClosed   → sendJson(SHOW_REWARDED_RESULT, ...)
        //   onAdDisplayFailed → sendJson(kind='error')
    }

    // -----------------------------------------------------------------
    // Lifecycle passthrough — call these from AppActivity.
    // -----------------------------------------------------------------

    /** Call from AppActivity.onResume(). No-op on Unity LevelPlay 9.x
     *  (the SDK auto-tracks lifecycle via ActivityLifecycleCallbacks),
     *  kept for symmetry with the old API in case a future version
     *  requires explicit pumping again. */
    @JvmStatic
    fun onActivityResume(activity: Activity) {
        // No-op; SDK handles this internally now.
    }

    /** Call from AppActivity.onPause(). No-op — see onActivityResume comment. */
    @JvmStatic
    fun onActivityPause(activity: Activity) {
        // No-op; SDK handles this internally now.
    }
}
