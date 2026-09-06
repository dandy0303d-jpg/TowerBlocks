# Add project specific ProGuard rules here.
# By default, the flags in this file are appended to flags specified
# in E:\developSoftware\Android\SDK/tools/proguard/proguard-android.txt
# You can edit the include path and order by changing the proguardFiles
# directive in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Add any project specific keep options here:

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Proguard Cocos2d-x-lite for release
-keep public class com.cocos.** { *; }
-dontwarn com.cocos.**

# Proguard Apache HTTP for release
-keep class org.apache.http.** { *; }
-dontwarn org.apache.http.**

# Proguard okhttp for release
-keep class okhttp3.** { *; }
-dontwarn okhttp3.**

-keep class okio.** { *; }
-dontwarn okio.**

# Proguard Android Webivew for release. you can comment if you are not using a webview
-keep public class android.net.http.SslError
-keep public class android.webkit.WebViewClient

-keep public class com.google.** { *; }

-dontwarn android.webkit.WebView
-dontwarn android.net.http.SslError
-dontwarn android.webkit.WebViewClient

# -------------------------------------------------------------
# Bridges called from JS via JsbBridge — belt-and-suspenders
# (already covered by `com.cocos.**` above, kept here so channel
# branches that split bridge classes out of com.cocos.game stay
# safe against future refactors).
# -------------------------------------------------------------
-keep class com.cocos.game.AppActivity { *; }
-keep class com.cocos.game.OneStoreBridge { *; }
-keep class com.cocos.game.LevelPlayBridge { *; }
-keep class com.cocos.game.GoogleWebOAuthBridge { *; }
-keep class com.cocos.game.ClipboardBridge { *; }

# Preserve @Keep-annotated members (androidx annotation) — used by
# some SDKs to mark reflection targets that R8 would otherwise strip.
-keep,allowobfuscation @interface androidx.annotation.Keep
-keep @androidx.annotation.Keep class *
-keepclassmembers class * {
    @androidx.annotation.Keep *;
}

# -------------------------------------------------------------
# ONE Store IAP SDK v21 — the SDK ships consumer rules but pin
# the public API here so a future R8 update can't over-shrink.
# -------------------------------------------------------------
-keep class com.gaa.sdk.** { *; }
-keep class com.onestore.** { *; }
-dontwarn com.gaa.sdk.**
-dontwarn com.onestore.**

# -------------------------------------------------------------
# Unity LevelPlay / IronSource / Unity Ads — heavy on reflection.
# -------------------------------------------------------------
-keep class com.unity3d.** { *; }
-keep class com.ironsource.** { *; }
-dontwarn com.unity3d.**
-dontwarn com.ironsource.**

# Google Play Services — usually has consumer rules but keep the
# ads-identifier + appset APIs LevelPlay reflects into.
-keep class com.google.android.gms.ads.identifier.** { *; }
-keep class com.google.android.gms.appset.** { *; }

# Kotlin metadata — needed if reflection reads @Metadata (LevelPlay
# does). Cheap to keep.
-keep class kotlin.Metadata { *; }
-keepattributes RuntimeVisibleAnnotations,AnnotationDefault,Signature,InnerClasses,EnclosingMethod

# JsbBridge — Cocos native ↔ JS glue. addNativeEventListener uses
# reflection on registered handlers.
-keep class com.cocos.lib.JsbBridge { *; }
-keep class com.cocos.lib.JsbBridgeWrapper { *; }

# This is generated automatically by the Android Gradle plugin.
-dontwarn android.hardware.BatteryState
-dontwarn android.hardware.lights.Light
-dontwarn android.hardware.lights.LightState$Builder
-dontwarn android.hardware.lights.LightState
-dontwarn android.hardware.lights.LightsManager$LightsSession
-dontwarn android.hardware.lights.LightsManager
-dontwarn android.hardware.lights.LightsRequest$Builder
-dontwarn android.hardware.lights.LightsRequest
-dontwarn android.net.ssl.SSLSockets
-dontwarn android.os.VibratorManager