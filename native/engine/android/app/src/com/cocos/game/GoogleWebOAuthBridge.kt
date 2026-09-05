/*
 * GoogleWebOAuthBridge — device-side Google OAuth 2.0 (authorization
 * code + PKCE) for the "bind Google account" flow, WITHOUT the Google
 * Sign-In SDK. Uses Chrome Custom Tabs to open Google's OAuth consent
 * screen in the user's browser, then catches the redirect URI via an
 * intent-filter on this app and hands the auth code back to the TS
 * layer.
 *
 * Why not the Google Sign-In SDK?
 *   - It hard-depends on Google Play Services (GMS). On ONE Store's
 *     Korean install base a big chunk of devices ship without GMS,
 *     so the SDK crashes on init. The web flow works on any Android
 *     device with a browser + our custom-scheme intent-filter.
 *
 * Flow (client-driven):
 *   1. TS side generates a PKCE code_verifier + code_challenge (S256),
 *      a random state, and calls startAuth(url).
 *   2. This bridge opens Chrome Custom Tabs to `url` (Google's
 *      /o/oauth2/v2/auth endpoint with client_id, redirect_uri,
 *      scope, code_challenge, state, response_type=code, ...).
 *   3. User signs in in the browser. Google redirects the browser to
 *      our custom scheme, e.g. `com.tetritower.oauth://google/callback?code=...&state=...`.
 *   4. Android's intent system finds the intent-filter on this app,
 *      brings AppActivity to front (singleTask launchMode), and calls
 *      onNewIntent with the URI.
 *   5. AppActivity.onNewIntent forwards to
 *      GoogleWebOAuthBridge.handleRedirect, which emits a JsbBridge
 *      event ("google.oauth.callback") with the query string so TS
 *      can pick the code + state + validate + exchange for id_token.
 *
 * TS entry points (via native.reflection.callStaticMethod):
 *   startAuth(String url)            : boolean
 *
 * TS-observable JsbBridge events:
 *   google.oauth.callback  data=<query string>   (success — has "code")
 *   google.oauth.callback  data=error:<message>  (Custom Tabs failed to open,
 *                                                 redirect returned no code,
 *                                                 user cancelled, etc.)
 *
 * install() wires a WeakReference to AppActivity. Idempotent.
 */
package com.cocos.game

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.util.Log
import androidx.browser.customtabs.CustomTabsIntent
import com.cocos.lib.JsbBridgeWrapper
import java.lang.ref.WeakReference

object GoogleWebOAuthBridge {

    private const val TAG = "GoogleWebOAuth"

    /** JsbBridge event name — matches the string TS listens for via
     *  JsbBridgeWrapper.getInstance().addScriptEventListener(). */
    private const val EVENT_CALLBACK = "google.oauth.callback"

    private var activityRef: WeakReference<Activity>? = null
    private var installed: Boolean = false

    /** Called once from AppActivity.onCreate. Idempotent. */
    @JvmStatic
    fun install(activity: Activity) {
        if (installed && activityRef?.get() === activity) return
        installed = true
        activityRef = WeakReference(activity)
        Log.i(TAG, "installed — activity ref stashed")
    }

    /** Open Chrome Custom Tabs to `url`. Returns true when the browser
     *  intent was successfully dispatched. TS side is expected to
     *  construct the full OAuth URL (this bridge intentionally stays
     *  ignorant of client_id / scopes / PKCE so all OAuth params live
     *  in one place — the TS layer — for easier config changes).
     *
     *  Signature the TS caller uses:
     *    native.reflection.callStaticMethod(
     *        "com/cocos/game/GoogleWebOAuthBridge",
     *        "startAuth",
     *        "(Ljava/lang/String;)Z",
     *        url,
     *    )
     */
    @JvmStatic
    fun startAuth(url: String): Boolean {
        val activity = activityRef?.get()
        if (activity == null) {
            Log.w(TAG, "startAuth called before install() — no Activity ref")
            emitError("no-activity")
            return false
        }
        return try {
            val intent = CustomTabsIntent.Builder()
                .setShowTitle(false)
                .build()
            // FLAG_ACTIVITY_NO_HISTORY so the browser tab doesn't linger
            // in recents after auth completes and the app takes over.
            intent.intent.addFlags(Intent.FLAG_ACTIVITY_NO_HISTORY)
            intent.launchUrl(activity, Uri.parse(url))
            Log.i(TAG, "startAuth — Custom Tabs launched")
            true
        } catch (e: Throwable) {
            Log.e(TAG, "startAuth threw", e)
            emitError("launch-failed:${e.message ?: e.javaClass.simpleName}")
            false
        }
    }

    /** Called from AppActivity.onNewIntent whenever a VIEW intent
     *  matching our custom scheme arrives. Parses the URI's query
     *  string and forwards to TS via JsbBridge.
     *
     *  IMPORTANT: only called for OUR custom scheme — AppActivity
     *  gates by scheme before invoking, so unrelated intents (deep
     *  links from other integrations) never reach here. */
    @JvmStatic
    fun handleRedirect(intent: Intent) {
        val data = intent.data
        if (data == null) {
            Log.w(TAG, "handleRedirect called with null data")
            emitError("no-data")
            return
        }
        // Successful redirect has ?code=...&state=...; failures have
        // ?error=access_denied&state=... (per RFC 6749 §4.1.2.1).
        // Forward the whole query string unchanged; TS parses.
        val query = data.query ?: ""
        Log.i(TAG, "handleRedirect — query='$query'")
        JsbBridgeWrapper.getInstance().dispatchEventToScript(EVENT_CALLBACK, query)
    }

    private fun emitError(reason: String) {
        JsbBridgeWrapper.getInstance().dispatchEventToScript(EVENT_CALLBACK, "error:$reason")
    }
}
