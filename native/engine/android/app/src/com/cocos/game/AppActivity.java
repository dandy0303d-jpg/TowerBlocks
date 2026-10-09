/****************************************************************************
Copyright (c) 2015-2016 Chukong Technologies Inc.
Copyright (c) 2017-2018 Xiamen Yaji Software Co., Ltd.

http://www.cocos2d-x.org

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
****************************************************************************/
package com.cocos.game;

import android.os.Bundle;
import android.content.Intent;
import android.content.res.Configuration;
import android.view.KeyEvent;
import android.view.WindowManager;

import com.cocos.service.SDKWrapper;
import com.cocos.lib.CocosActivity;

public class AppActivity extends CocosActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Keep the screen awake while the game window is in the
        // foreground — prevents the system from dimming / locking the
        // display when the player hasn't touched the screen for a
        // while (Tetri Tower has passive phases where the player is
        // watching an FX play out, so they'd otherwise get screensaver-
        // ed mid-game). Flag is automatically released when Activity
        // moves off-foreground, so no wake-lock permission needed.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        // DO OTHER INITIALIZATION BELOW
        SDKWrapper.shared().init(this);

        // Google Web OAuth bridge — handles the account-bind flow via
        // Chrome Custom Tabs (no Google Sign-In SDK / GMS dependency).
        // install() only stashes a WeakReference to this Activity; the
        // Custom Tabs intent is only launched when TS calls startAuth().
        // Companion onNewIntent() below forwards the OAuth redirect back
        // to the bridge for parsing.
        com.cocos.game.GoogleWebOAuthBridge.install(this);

        // Firebase bridge — Analytics, Crashlytics, Remote Config.
        // install() initializes FirebaseApp (or no-ops if
        // google-services.json is missing) and leaves data collection
        // DISABLED until TS side flips it on via AnalyticsApi
        // .setEnabled(true) — see consent scheme A in AnalyticsApi.ts.
        com.cocos.game.FirebaseBridge.install(this);

        // Clipboard bridge — the only path that actually reaches
        // Android's system clipboard from Cocos native. Called from
        // TS by MenuController.copyPlayerIdentity via
        // native.reflection.callStaticMethod. Without install(),
        // copyToClipboard returns false and the player sees
        // "复制失败".
        com.cocos.game.ClipboardBridge.install(this);

        // LevelPlay (Unity mediation, formerly ironSource) rewarded-ad
        // bridge — listens for levelplay.* events. Reads the app key
        // from AndroidManifest meta-data `levelplay.app.key` (set per
        // channel branch to its own key). JS calls levelplay.init with
        // the player uuid on boot to kick off SDK init + first ad load.
        com.cocos.game.LevelPlayBridge.install(this);
    }

    @Override
    protected void onResume() {
        super.onResume();
        SDKWrapper.shared().onResume();
    }

    @Override
    protected void onPause() {
        super.onPause();
        SDKWrapper.shared().onPause();
    }

    @Override
    protected void onDestroy() {
        super.onDestroy();
        // Workaround in https://stackoverflow.com/questions/16283079/re-launch-of-activity-on-home-button-but-only-the-first-time/16447508
        if (!isTaskRoot()) {
            return;
        }
        SDKWrapper.shared().onDestroy();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        SDKWrapper.shared().onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        SDKWrapper.shared().onNewIntent(intent);
        // Google Web OAuth redirect capture. We use launchMode="singleTask"
        // + an intent-filter on our custom oauth scheme (see AndroidManifest),
        // so when Google's redirect fires and Android routes it to us, this
        // is where it lands. Gate by scheme so we only forward genuinely
        // Google-oauth intents to the bridge (any other deep-link
        // integration keeps its own path). setIntent so a subsequent
        // getIntent() reflects the new intent, matching Android norms.
        if (intent != null
                && intent.getData() != null
                && intent.getData().getScheme() != null
                && intent.getData().getScheme().startsWith("com.googleusercontent.apps.")) {
            setIntent(intent);
            com.cocos.game.GoogleWebOAuthBridge.handleRedirect(intent);
        }
    }

    @Override
    protected void onRestart() {
        super.onRestart();
        SDKWrapper.shared().onRestart();
    }

    @Override
    protected void onStop() {
        super.onStop();
        SDKWrapper.shared().onStop();
    }

    @Override
    public void onBackPressed() {
        // Fallback path — normally the back key is captured by
        // dispatchKeyEvent() below (fires before any View sees it),
        // so this only runs if some system dialog / IME upstream
        // routes back through the Activity path instead. Keep the
        // SDKWrapper hook so third-party SDKs get lifecycle parity.
        SDKWrapper.shared().onBackPressed();
        try {
            com.cocos.lib.JsbBridgeWrapper.getInstance()
                    .dispatchEventToScript("androidBack", "");
        } catch (Throwable t) {
            android.util.Log.w("AppActivity",
                    "JsbBridge back dispatch failed: " + t.getMessage());
        }
    }

    /**
     * Intercept the hardware back key at the Activity dispatch layer.
     *
     * Why not onBackPressed()? Cocos 3.8's CocosSurfaceView consumes
     * KEYCODE_BACK in its own onKeyDown() and returns true, so the key
     * never bubbles up to Activity.onBackPressed(). It also does NOT
     * forward it to the JS input dispatcher — `input.on(KEY_UP,
     * MOBILE_BACK)` never fires. We tried both paths and confirmed no
     * dispatch either way.
     *
     * dispatchKeyEvent() fires BEFORE the SurfaceView sees the event,
     * so we can consume KEYCODE_BACK cleanly and forward it to JS via
     * JsbBridgeWrapper. BackKeyManager.ts subscribes to the
     * "androidBack" event and runs its LIFO handler stack (popup close
     * → exit-confirm modal at main menu).
     *
     * Returning true here means "handled" — the SurfaceView never sees
     * the key, and Android does NOT background/finish the Activity.
     * If JS wants to exit the app it calls `game.end()`, which finishes
     * the Activity normally.
     *
     * We only capture ACTION_UP (single event per press) so we don't
     * fire twice on a normal press-and-release. Long-press repeats
     * fire more ACTION_DOWN events but only one ACTION_UP on release,
     * which is the behavior we want.
     */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getKeyCode() == KeyEvent.KEYCODE_BACK
                && event.getAction() == KeyEvent.ACTION_UP) {
            android.util.Log.i("AppActivity", "back key → JsbBridge androidBack");
            try {
                com.cocos.lib.JsbBridgeWrapper.getInstance()
                        .dispatchEventToScript("androidBack", "");
            } catch (Throwable t) {
                android.util.Log.w("AppActivity",
                        "JsbBridge back dispatch failed: " + t.getMessage());
                // Fall through to super so the app doesn't feel dead
                // if the bridge broke for some reason.
                return super.dispatchKeyEvent(event);
            }
            return true;   // consumed — do NOT let SurfaceView see it
        }
        return super.dispatchKeyEvent(event);
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        SDKWrapper.shared().onConfigurationChanged(newConfig);
        super.onConfigurationChanged(newConfig);
    }

    @Override
    protected void onRestoreInstanceState(Bundle savedInstanceState) {
        SDKWrapper.shared().onRestoreInstanceState(savedInstanceState);
        super.onRestoreInstanceState(savedInstanceState);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        SDKWrapper.shared().onSaveInstanceState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    protected void onStart() {
        SDKWrapper.shared().onStart();
        super.onStart();
    }

    @Override
    public void onLowMemory() {
        SDKWrapper.shared().onLowMemory();
        super.onLowMemory();
    }
}
