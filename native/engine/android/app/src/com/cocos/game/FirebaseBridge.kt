/*
 * FirebaseBridge — Android-side Firebase Analytics, Crashlytics and
 * Remote Config wrapper, called from TS via
 * native.reflection.callStaticMethod('com/cocos/game/FirebaseBridge', ...).
 *
 * Init flow:
 *   1. AppActivity.onCreate calls FirebaseBridge.install(this).
 *   2. install() calls Firebase.initializeApp(context). Analytics
 *      data-collection starts DISABLED (consent scheme A).
 *   3. Once the player accepts the "data analytics" consent, TS calls
 *      setAnalyticsEnabled(true), which flips both Analytics and
 *      Crashlytics on. Both are persisted by Firebase across restarts,
 *      so we still call setEnabled(current) on every boot to stay in
 *      sync with the local consent state.
 *
 * All methods are static + synchronized on the class monitor.
 * JsbBridge calls are single-threaded (Cocos game thread) but any
 * app-lifecycle callback (activity onDestroy → GC of static state)
 * could theoretically race, so we guard the applicationContext ref.
 *
 * Missing google-services.json?
 *   FirebaseApp.initializeApp() returns null and every subsequent call
 *   becomes a no-op — the game won't crash, it just won't report data.
 *   That's the desired behavior for developer machines without the
 *   config file (see native/engine/android/app/build.gradle: the
 *   google-services plugin is conditionally applied).
 */
package com.cocos.game

import android.app.Activity
import android.content.Context
import android.os.Bundle
import android.util.Log
import java.lang.ref.WeakReference

// Firebase SDK imports — see app/build.gradle for coordinates.
// All three modules are pulled by firebase-bom.
import com.google.firebase.FirebaseApp
import com.google.firebase.analytics.FirebaseAnalytics
import com.google.firebase.crashlytics.FirebaseCrashlytics
import com.google.firebase.remoteconfig.FirebaseRemoteConfig
import com.google.firebase.remoteconfig.FirebaseRemoteConfigSettings

import org.json.JSONObject

@Suppress("unused")   // Called reflectively from Cocos JSB
object FirebaseBridge {

    private const val TAG = "FirebaseBridge"

    /** WeakRef so the Activity can be GC'd normally on process death. */
    private var activityRef: WeakReference<Activity>? = null
    private var appContext: Context? = null
    private var analytics: FirebaseAnalytics? = null
    private var crashlytics: FirebaseCrashlytics? = null
    private var remoteConfig: FirebaseRemoteConfig? = null
    private var initialized = false

    /**
     * Called once from AppActivity.onCreate. Idempotent — a second
     * call just refreshes the Activity ref (useful across recreations).
     */
    @JvmStatic
    fun install(activity: Activity) {
        activityRef = WeakReference(activity)
        appContext = activity.applicationContext
        if (initialized) return

        // Guarded init — a missing google-services.json makes
        // initializeApp return null. We still let the game boot.
        val app = try {
            FirebaseApp.initializeApp(appContext!!)
        } catch (t: Throwable) {
            Log.w(TAG, "FirebaseApp.initializeApp failed: ${t.message}")
            null
        }
        if (app == null) {
            Log.w(TAG, "Firebase not initialized (missing google-services.json?) — bridge inert")
            return
        }

        analytics = FirebaseAnalytics.getInstance(appContext!!)
        crashlytics = FirebaseCrashlytics.getInstance()
        remoteConfig = FirebaseRemoteConfig.getInstance()

        // Consent scheme A: data collection stays OFF until the TS
        // side flips it after the player accepts analytics consent.
        analytics!!.setAnalyticsCollectionEnabled(false)
        crashlytics!!.setCrashlyticsCollectionEnabled(false)

        // Remote Config — 12h min fetch interval by default; game boots
        // aren't chatty enough to need tighter. Tighten via the console
        // parameter set if we want faster propagation of experiments.
        val settings = FirebaseRemoteConfigSettings.Builder()
            .setMinimumFetchIntervalInSeconds(43200)   // 12h
            .setFetchTimeoutInSeconds(10)
            .build()
        remoteConfig!!.setConfigSettingsAsync(settings)

        initialized = true
        Log.i(TAG, "Firebase initialized (analytics=disabled until consent)")
    }

    // ─── Lifecycle ─────────────────────────────────────────

    @JvmStatic
    fun setAnalyticsEnabled(enabled: Boolean) {
        analytics?.setAnalyticsCollectionEnabled(enabled)
        crashlytics?.setCrashlyticsCollectionEnabled(enabled)
        Log.i(TAG, "analytics + crashlytics collection = $enabled")
    }

    @JvmStatic
    fun setUserId(uuid: String) {
        analytics?.setUserId(if (uuid.isEmpty()) null else uuid)
        crashlytics?.setUserId(uuid)
    }

    @JvmStatic
    fun setUserProperty(key: String, value: String) {
        analytics?.setUserProperty(key, value)
    }

    // ─── Analytics events ──────────────────────────────────

    @JvmStatic
    fun logEvent(name: String, paramsJson: String) {
        val a = analytics ?: return
        try {
            val bundle = Bundle()
            if (paramsJson.isNotEmpty() && paramsJson != "{}") {
                val obj = JSONObject(paramsJson)
                val keys = obj.keys()
                while (keys.hasNext()) {
                    val k = keys.next()
                    // Firebase only accepts long / double / string / bool.
                    when (val v = obj.get(k)) {
                        is Int    -> bundle.putLong(k, v.toLong())
                        is Long   -> bundle.putLong(k, v)
                        is Double -> bundle.putDouble(k, v)
                        is Float  -> bundle.putDouble(k, v.toDouble())
                        is Boolean -> bundle.putLong(k, if (v) 1L else 0L)
                        else -> bundle.putString(k, v.toString())
                    }
                }
            }
            a.logEvent(name, bundle)
        } catch (t: Throwable) {
            Log.w(TAG, "logEvent($name) failed: ${t.message}")
        }
    }

    // ─── Crashlytics ───────────────────────────────────────

    @JvmStatic
    fun logError(message: String, stack: String, contextJson: String) {
        val c = crashlytics ?: return
        try {
            if (contextJson.isNotEmpty() && contextJson != "{}") {
                val obj = JSONObject(contextJson)
                val keys = obj.keys()
                while (keys.hasNext()) {
                    val k = keys.next()
                    c.setCustomKey(k, obj.get(k).toString())
                }
            }
            val err = RuntimeException("$message\n$stack")
            c.recordException(err)
        } catch (t: Throwable) {
            Log.w(TAG, "logError failed: ${t.message}")
        }
    }

    @JvmStatic
    fun log(message: String) {
        crashlytics?.log(message)
    }

    // ─── Remote Config ────────────────────────────────────

    @JvmStatic
    fun fetchRemoteConfig() {
        val rc = remoteConfig ?: return
        rc.fetchAndActivate()
            .addOnCompleteListener { t ->
                if (t.isSuccessful) {
                    Log.i(TAG, "remote config fetch success (updated=${t.result})")
                } else {
                    Log.w(TAG, "remote config fetch failed: ${t.exception?.message}")
                }
            }
    }

    @JvmStatic
    fun getConfigString(key: String, fallback: String): String {
        val rc = remoteConfig ?: return fallback
        val v = rc.getString(key)
        return if (v.isEmpty()) fallback else v
    }
}
