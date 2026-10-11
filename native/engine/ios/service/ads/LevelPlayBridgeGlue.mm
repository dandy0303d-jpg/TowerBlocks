//
//  LevelPlayBridgeGlue.mm
//
//  Cocos JsbBridgeWrapper ⇄ Swift LevelPlayBridge adapter. Mirrors the
//  shape of GoogleAuthBridgeGlue / AdMobBridgeGlue in this codebase.
//
//  Event schema — MUST stay lockstep with:
//    assets/scripts/core/channels/LevelPlayAdProvider.ts
//    native/engine/android/app/src/com/cocos/game/LevelPlayBridge.kt
//
//    JS  → Native:
//      "levelplay.init"             arg = uuid
//      "levelplay.rewardedReady"    arg = (ignored)
//      "levelplay.showRewarded"     arg = ad unit id (placement)
//
//    Native → JS:
//      "levelplay.initResult"            {"success":bool, "error"?}
//      "levelplay.rewardedReadyResult"   {"ready":bool}
//      "levelplay.showRewardedResult"    {"kind":"rewarded"|"dismissed"|"error", "reason"?}
//      "levelplay.rewardedAvailable"     {"ready":bool}   (push)
//

#import "LevelPlayBridgeGlue.h"
#import "platform/apple/JsbBridgeWrapper.h"
#import "tower_blocks_mobile-Swift.h"

static inline void DispatchToJS(NSString *event, NSString *arg) {
    NSString *eventCopy = [event copy];
    NSString *argCopy   = [arg copy];
    dispatch_async(dispatch_get_main_queue(), ^{
        [[JsbBridgeWrapper sharedInstance] dispatchEventToScript:eventCopy arg:argCopy];
    });
}

@implementation LevelPlayBridgeGlue

+ (void)registerWithCocos {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        JsbBridgeWrapper *bridge = [JsbBridgeWrapper sharedInstance];
        LevelPlayBridge *impl = [LevelPlayBridge shared];

        // Wire Swift-side callbacks to dispatch each result to JS.
        impl.onInitResult = [^(NSString *json) {
            DispatchToJS(@"levelplay.initResult", json);
        } copy];
        impl.onRewardedReadyResult = [^(NSString *json) {
            DispatchToJS(@"levelplay.rewardedReadyResult", json);
        } copy];
        impl.onShowRewardedResult = [^(NSString *json) {
            DispatchToJS(@"levelplay.showRewardedResult", json);
        } copy];
        impl.onRewardedAvailable = [^(NSString *json) {
            DispatchToJS(@"levelplay.rewardedAvailable", json);
        } copy];

        // -- levelplay.init ----------------------------------------------
        OnScriptEventListener initListener = [^(NSString *arg) {
            [impl initSdkWithUuid:(arg ?: @"")];
        } copy];
        [bridge addScriptEventListener:@"levelplay.init" listener:initListener];

        // -- levelplay.rewardedReady -------------------------------------
        OnScriptEventListener readyListener = [^(NSString *_ignored) {
            [impl checkRewardedReady];
        } copy];
        [bridge addScriptEventListener:@"levelplay.rewardedReady" listener:readyListener];

        // -- levelplay.preloadRewarded -----------------------------------
        OnScriptEventListener preloadListener = [^(NSString *arg) {
            [impl preloadRewardedWithAdUnit:(arg ?: @"")];
        } copy];
        [bridge addScriptEventListener:@"levelplay.preloadRewarded" listener:preloadListener];

        // -- levelplay.showRewarded --------------------------------------
        OnScriptEventListener showListener = [^(NSString *arg) {
            [impl showRewardedWithPlacement:arg];
        } copy];
        [bridge addScriptEventListener:@"levelplay.showRewarded" listener:showListener];

        NSLog(@"[Ads] LevelPlayBridgeGlue registered — 3 event listeners active");
    });
}

@end
