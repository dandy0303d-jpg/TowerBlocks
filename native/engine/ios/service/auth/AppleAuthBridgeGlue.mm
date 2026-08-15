//
//  AppleAuthBridgeGlue.mm
//
//  Event schema (JsbBridgeWrapper):
//
//  JS  → Native:
//    "siwa.signIn"   arg = ignored (pass empty string)
//    "siwa.getState" arg = appleSub string
//
//  Native → JS:
//    "siwa.signInResult"  arg = JSON {success, identityToken, authorizationCode, appleSub}
//                                or {success:false, kind, error}
//    "siwa.stateResult"   arg = JSON {state: "authorized"|"revoked"|"notFound"|"transferred"|"unknown"}
//
//  MRC + threading notes:
//  - Same as PurchaseBridgeGlue — Cocos's JsbBridgeWrapper is MRC, so
//    listener blocks must be [copy]'d before storage or they crash
//    when triggered from a stack that has since returned.
//  - dispatchEventToScript touches V8; only safe on main thread. Every
//    reply is dispatched to the main queue.
//

#import "AppleAuthBridgeGlue.h"
#import "platform/apple/JsbBridgeWrapper.h"
#import "tower_blocks_mobile-Swift.h"

/// Marshal an event to JS on the main queue. Copies inputs so late
/// dispatch after outer scope exit is safe.
static inline void DispatchToJS(NSString *event, NSString *arg) {
    NSString *eventCopy = [event copy];
    NSString *argCopy   = [arg copy];
    dispatch_async(dispatch_get_main_queue(), ^{
        [[JsbBridgeWrapper sharedInstance] dispatchEventToScript:eventCopy arg:argCopy];
    });
}

@implementation AppleAuthBridgeGlue

+ (void)registerWithCocos {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        JsbBridgeWrapper *bridge = [JsbBridgeWrapper sharedInstance];
        AppleAuthBridge *impl = [AppleAuthBridge shared];

        // -- siwa.signIn --------------------------------------------------
        OnScriptEventListener signInListener = [^(NSString *_ignored) {
            [impl signInWithCompletion:^(NSString *result) {
                DispatchToJS(@"siwa.signInResult", result);
            }];
        } copy];
        [bridge addScriptEventListener:@"siwa.signIn" listener:signInListener];

        // -- siwa.getState ------------------------------------------------
        OnScriptEventListener getStateListener = [^(NSString *sub) {
            if (![sub isKindOfClass:[NSString class]] || sub.length == 0) {
                DispatchToJS(@"siwa.stateResult", @"{\"state\":\"notFound\"}");
                return;
            }
            [impl getCredentialStateWithSub:sub completion:^(NSString *result) {
                DispatchToJS(@"siwa.stateResult", result);
            }];
        } copy];
        [bridge addScriptEventListener:@"siwa.getState" listener:getStateListener];

        NSLog(@"[SIWA] AppleAuthBridgeGlue registered — 2 event listeners active");
    });
}

@end
