//
//  FirebaseBridgeGlue.mm
//
//  Objective-C++ implementation of the Firebase bridge. Backed by the
//  Firebase iOS SDK (installed via CocoaPods — see native/engine/ios/Podfile).
//
//  Threading:
//    Firebase Analytics is thread-safe. Crashlytics recordError: is
//    thread-safe. Remote Config fetchWithCompletionHandler is async
//    and takes its completion on the main queue. We don't wrap any
//    of these — TS reflection calls arrive on whichever thread Cocos
//    chooses, and Firebase handles the dispatch internally.
//
//  Missing GoogleService-Info.plist:
//    +[FIRApp configure] itself will throw an NSException if the plist
//    is missing. We guard by checking the bundle first; on miss, log
//    once and set _configured = NO so every subsequent method no-ops.
//
//  MRC vs ARC:
//    Cocos on iOS mixes MRC (JsbBridgeWrapper) with ARC (everything
//    else). This file compiles under ARC — no manual retain/release.
//

#import "FirebaseBridgeGlue.h"

// Switched from `@import FirebaseXxx` (Clang modules) to classic
// `#import` so this file builds under Cocos's CMake-generated Xcode
// project, which doesn't flip on CLANG_ENABLE_MODULES for the
// CocosGame target. Both forms resolve to the same Firebase symbols.
#import <FirebaseCore/FirebaseCore.h>
#import <FirebaseAnalytics/FirebaseAnalytics.h>
#import <FirebaseCrashlytics/FirebaseCrashlytics.h>
#import <FirebaseRemoteConfig/FirebaseRemoteConfig.h>

static BOOL _configured = NO;
static FIRRemoteConfig *_remoteConfig = nil;

@implementation FirebaseBridgeGlue

// ─── install ────────────────────────────────────────────
+ (void)install {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        // Check for the plist first — [FIRApp configure] throws on miss.
        NSString *plistPath = [[NSBundle mainBundle] pathForResource:@"GoogleService-Info"
                                                              ofType:@"plist"];
        if (!plistPath) {
            NSLog(@"[Firebase] GoogleService-Info.plist not found — bridge inert");
            return;
        }
        @try {
            [FIRApp configure];
        } @catch (NSException *ex) {
            NSLog(@"[Firebase] FIRApp configure threw: %@", ex.reason);
            return;
        }

        // Consent scheme A: data collection stays OFF until the TS
        // side flips it after the player accepts analytics consent.
        [[FIRAnalytics class] setAnalyticsCollectionEnabled:NO];
        [[FIRCrashlytics crashlytics] setCrashlyticsCollectionEnabled:NO];

        // Remote Config — 12h min fetch interval by default.
        _remoteConfig = [FIRRemoteConfig remoteConfig];
        FIRRemoteConfigSettings *settings = [[FIRRemoteConfigSettings alloc] init];
        settings.minimumFetchInterval = 43200;   // 12h
        settings.fetchTimeout = 10;              // seconds
        _remoteConfig.configSettings = settings;

        _configured = YES;
        NSLog(@"[Firebase] initialized (analytics=disabled until consent)");
    });
}

// ─── Lifecycle ────────────────────────────────────────────
+ (void)setAnalyticsEnabled:(BOOL)enabled {
    if (!_configured) return;
    [[FIRAnalytics class] setAnalyticsCollectionEnabled:enabled];
    [[FIRCrashlytics crashlytics] setCrashlyticsCollectionEnabled:enabled];
    NSLog(@"[Firebase] analytics + crashlytics collection = %d", (int)enabled);
}

+ (void)setUserId:(NSString *)uuid {
    if (!_configured) return;
    NSString *actual = uuid.length > 0 ? uuid : nil;
    [FIRAnalytics setUserID:actual];
    [[FIRCrashlytics crashlytics] setUserID:uuid ?: @""];
}

+ (void)setUserProperty:(NSString *)key value:(NSString *)value {
    if (!_configured) return;
    [FIRAnalytics setUserPropertyString:value forName:key];
}

// ─── Analytics events ────────────────────────────────────
+ (void)logEvent:(NSString *)name paramsJson:(NSString *)paramsJson {
    if (!_configured) return;
    NSDictionary *params = @{};
    if (paramsJson.length > 0 && ![paramsJson isEqualToString:@"{}"]) {
        NSError *err = nil;
        NSData *data = [paramsJson dataUsingEncoding:NSUTF8StringEncoding];
        id parsed = [NSJSONSerialization JSONObjectWithData:data
                                                    options:0
                                                      error:&err];
        if (!err && [parsed isKindOfClass:[NSDictionary class]]) {
            params = (NSDictionary *)parsed;
        } else {
            NSLog(@"[Firebase] logEvent %@ — bad params JSON: %@", name, err);
        }
    }
    [FIRAnalytics logEventWithName:name parameters:params];
}

// ─── Crashlytics ─────────────────────────────────────────
+ (void)logError:(NSString *)message
           stack:(NSString *)stack
     contextJson:(NSString *)contextJson {
    if (!_configured) return;
    FIRCrashlytics *cl = [FIRCrashlytics crashlytics];
    if (contextJson.length > 0 && ![contextJson isEqualToString:@"{}"]) {
        NSError *err = nil;
        NSData *data = [contextJson dataUsingEncoding:NSUTF8StringEncoding];
        id parsed = [NSJSONSerialization JSONObjectWithData:data
                                                    options:0
                                                      error:&err];
        if (!err && [parsed isKindOfClass:[NSDictionary class]]) {
            NSDictionary *ctx = (NSDictionary *)parsed;
            for (NSString *k in ctx) {
                [cl setCustomValue:[NSString stringWithFormat:@"%@", ctx[k]]
                            forKey:k];
            }
        }
    }
    NSString *combined = stack.length > 0
        ? [NSString stringWithFormat:@"%@\n%@", message, stack]
        : message;
    NSError *nsErr = [NSError errorWithDomain:@"AnalyticsApi.logError"
                                         code:0
                                     userInfo:@{ NSLocalizedDescriptionKey: combined }];
    [cl recordError:nsErr];
}

+ (void)log:(NSString *)message {
    if (!_configured) return;
    [[FIRCrashlytics crashlytics] log:message];
}

// ─── Remote Config ──────────────────────────────────────
+ (void)fetchRemoteConfig {
    if (!_configured || _remoteConfig == nil) return;
    [_remoteConfig fetchAndActivateWithCompletionHandler:^(FIRRemoteConfigFetchAndActivateStatus status, NSError * _Nullable error) {
        if (error) {
            NSLog(@"[Firebase] remote config fetch failed: %@", error.localizedDescription);
        } else {
            NSLog(@"[Firebase] remote config fetch success (status=%ld)", (long)status);
        }
    }];
}

+ (NSString *)getConfigString:(NSString *)key fallback:(NSString *)fallback {
    if (!_configured || _remoteConfig == nil) return fallback ?: @"";
    FIRRemoteConfigValue *val = [_remoteConfig configValueForKey:key];
    NSString *s = val.stringValue;
    return (s && s.length > 0) ? s : (fallback ?: @"");
}

@end
