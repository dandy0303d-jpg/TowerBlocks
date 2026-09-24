/*
 * ClipboardBridge — Android-side clipboard writer, called from TS via
 * `native.reflection.callStaticMethod('com/cocos/game/ClipboardBridge',
 *                                     'copyToClipboard',
 *                                     '(Ljava/lang/String;Ljava/lang/String;)Z',
 *                                     label, text)`.
 *
 * Why not `sys.setClipboard(text)`?
 *   Cocos 3.8.8's built-in clipboard JSB is a no-op on native Android
 *   (returns undefined without touching the system clipboard). Same
 *   for `navigator.clipboard.writeText` — the WebView layer isn't
 *   accessible from the Cocos native runtime. This bridge is the only
 *   path that actually reaches Android's ClipboardManager.
 *
 * Install:
 *   AppActivity.onCreate calls `ClipboardBridge.install(this)`. The
 *   applicationContext is cached statically so subsequent copyToClipboard
 *   calls don't need to receive a Context from JS. If install wasn't
 *   called (developer forgot to wire), the method logs + returns false —
 *   TS's cascade then falls through to the other fallbacks (also broken
 *   on Android, so the player sees "copy failed" but the client won't
 *   crash).
 *
 * Threading:
 *   ClipboardManager access is main-thread-only in modern Android.
 *   JSB reflection dispatches on the game thread, so we route the
 *   actual `setPrimaryClip` call through the main thread and BLOCK
 *   the game thread on the result — the caller expects a synchronous
 *   `boolean` return. The block is short (microseconds), and the game
 *   is already frozen while the "copy identity" modal is up.
 */

package com.cocos.game

import android.annotation.SuppressLint
import android.app.Activity
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.util.Log
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

@SuppressLint("StaticFieldLeak")   // applicationContext, not the Activity — safe to hold.
object ClipboardBridge {
    private const val TAG = "ClipboardBridge"
    private var appContext: Context? = null
    private val mainHandler = Handler(Looper.getMainLooper())

    /** Call from AppActivity.onCreate — caches applicationContext so
     *  subsequent `copyToClipboard` calls can reach ClipboardManager. */
    @JvmStatic
    fun install(activity: Activity) {
        appContext = activity.applicationContext
        Log.i(TAG, "install() — applicationContext cached")
    }

    /** Copy `text` to the system clipboard under `label` (label is
     *  UI-facing metadata some launchers show; keep it short and human).
     *  Returns `true` on success, `false` if the ClipboardManager was
     *  unavailable or `install()` wasn't called yet. */
    @JvmStatic
    fun copyToClipboard(label: String, text: String): Boolean {
        val ctx = appContext
        if (ctx == null) {
            Log.w(TAG, "copyToClipboard: appContext is null (install() not called?)")
            return false
        }
        val latch = CountDownLatch(1)
        var success = false
        val work = Runnable {
            try {
                val cm = ctx.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                if (cm == null) {
                    Log.w(TAG, "copyToClipboard: CLIPBOARD_SERVICE unavailable")
                } else {
                    cm.setPrimaryClip(ClipData.newPlainText(label, text))
                    success = true
                }
            } catch (t: Throwable) {
                Log.w(TAG, "copyToClipboard: setPrimaryClip threw", t)
            } finally {
                latch.countDown()
            }
        }
        if (Looper.myLooper() == Looper.getMainLooper()) {
            work.run()
        } else {
            mainHandler.post(work)
            try {
                // 500 ms is generous — main-thread post + setPrimaryClip
                // resolve in a couple of ms in practice. Anything longer
                // means the main thread is stuck; return false so TS
                // shows "copy failed" instead of hanging the game.
                if (!latch.await(500, TimeUnit.MILLISECONDS)) {
                    Log.w(TAG, "copyToClipboard: main-thread post timed out")
                    return false
                }
            } catch (e: InterruptedException) {
                Thread.currentThread().interrupt()
                Log.w(TAG, "copyToClipboard: interrupted waiting for main-thread")
                return false
            }
        }
        Log.i(TAG, "copyToClipboard success=$success label='$label' textLen=${text.length}")
        return success
    }
}
