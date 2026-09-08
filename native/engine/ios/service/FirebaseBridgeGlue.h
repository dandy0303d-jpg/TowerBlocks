//
//  FirebaseBridgeGlue.h
//
//  iOS-side Firebase Analytics / Crashlytics / Remote Config wrapper.
//  Called from TS via native.reflection.callStaticMethod, matching the
//  Android FirebaseBridge.kt signatures exactly. See AnalyticsApi.ts
//  for the TS-facing API.
//
//  Method style: all methods are class methods (+), typed for Cocos
//  reflection. Selector names are `foo:bar:baz:` — TS passes these as
//  the method-name argument to callStaticMethod('FirebaseBridgeGlue', ...).
//
//  Lifecycle:
//    +[FirebaseBridgeGlue install] is called ONCE from
//    application:didFinishLaunchingWithOptions: in AppDelegate.mm, BEFORE
//    any other Firebase-touching code. It calls [FIRApp configure],
//    reads GoogleService-Info.plist from the main bundle, and leaves
//    data-collection DISABLED (consent scheme A). If the plist is
//    missing, install() logs a warning and every subsequent call
//    becomes a no-op — the app still boots, just without Firebase.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface FirebaseBridgeGlue : NSObject

/** One-time bootstrap. Safe to call more than once (dispatch_once). */
+ (void)install;

// ─── Lifecycle ────────────────────────────────────────────
+ (void)setAnalyticsEnabled:(BOOL)enabled;
+ (void)setUserId:(NSString *)uuid;
+ (void)setUserProperty:(NSString *)key value:(NSString *)value;

// ─── Analytics events ────────────────────────────────────
+ (void)logEvent:(NSString *)name paramsJson:(NSString *)paramsJson;

// ─── Crashlytics ─────────────────────────────────────────
+ (void)logError:(NSString *)message
           stack:(NSString *)stack
     contextJson:(NSString *)contextJson;
+ (void)log:(NSString *)message;

// ─── Remote Config ──────────────────────────────────────
+ (void)fetchRemoteConfig;
+ (NSString *)getConfigString:(NSString *)key fallback:(NSString *)fallback;

@end

NS_ASSUME_NONNULL_END
