//
//  GameCenterBridgeGlue.mm
//
//  Event schema (JsbBridgeWrapper):
//
//  JS  → Native:
//    "gc.authenticate"  arg = ignored (pass empty string)
//                       — installs authenticateHandler if not yet installed;
//                       replays cached state to JS if already resolved.
//    "gc.getState"      arg = ignored — asks Swift to emit last-known
//                       auth state (useful if JS registered its listener
//                       after the initial event already fired).
//
//  Native → JS:
//    "gc.authResult"    arg = JSON
//                       success: {"success":true,"gamePlayerID":"...",
//                                 "teamPlayerID":"...","displayName":"...",
//                                 "alias":"...","isUnderage":false}
//                       failure: {"success":false,"kind":"...","error":"..."}
//                       Possible kinds: "auth-failed" (user declined / no
//                       account / net error), "no-present-vc", "pending"
//                       (getState called before handler fired),
//                       "encode-failed", "unknown".
//
//  MRC + threading notes match AppleAuthBridgeGlue: JsbBridgeWrapper
//  is MRC, so listener blocks must be [copy]'d, and dispatchEventToScript
//  is main-thread-only (Swift side already bounces to main).
//

#import "GameCenterBridgeGlue.h"
#import "platform/apple/JsbBridgeWrapper.h"
#import "tower_blocks_mobile-Swift.h"

static inline void DispatchToJS(NSString *event, NSString *arg) {
    NSString *eventCopy = [event copy];
    NSString *argCopy   = [arg copy];
    dispatch_async(dispatch_get_main_queue(), ^{
        [[JsbBridgeWrapper sharedInstance] dispatchEventToScript:eventCopy arg:argCopy];
    });
}

@implementation GameCenterBridgeGlue

+ (void)registerWithCocos {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        JsbBridgeWrapper *bridge = [JsbBridgeWrapper sharedInstance];
        GameCenterBridge *impl = [GameCenterBridge shared];

        // Wire the Swift-side onAuthResult callback to dispatch each
        // auth result to JS. Set BEFORE startAutoLogin so we don't
        // miss the first callback.
        impl.onAuthResult = [^(NSString *jsonPayload) {
            DispatchToJS(@"gc.authResult", jsonPayload);
        } copy];

        // -- gc.authenticate ---------------------------------------------
        // Fire-and-forget from JS: kicks off the login flow (or replays
        // cached state if already resolved).
        OnScriptEventListener authListener = [^(NSString *_ignored) {
            dispatch_async(dispatch_get_main_queue(), ^{
                [impl startAutoLogin];
            });
        } copy];
        [bridge addScriptEventListener:@"gc.authenticate" listener:authListener];

        // -- gc.getState -------------------------------------------------
        OnScriptEventListener stateListener = [^(NSString *_ignored) {
            [impl requestState];
        } copy];
        [bridge addScriptEventListener:@"gc.getState" listener:stateListener];

        // Kick off auto-login immediately — no need for JS to trigger.
        // On subsequent launches with a live Game Center session this
        // is silent (no UI); on first launch iOS shows the login sheet
        // (or the small "Welcome back" banner).
        dispatch_async(dispatch_get_main_queue(), ^{
            [impl startAutoLogin];
        });

        NSLog(@"[GameCenter] GameCenterBridgeGlue registered — 2 event listeners active, auto-login kicked off");
    });
}

@end
