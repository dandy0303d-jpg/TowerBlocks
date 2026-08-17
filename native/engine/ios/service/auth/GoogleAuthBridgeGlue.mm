//
//  GoogleAuthBridgeGlue.mm
//
//  Event schema (JsbBridgeWrapper):
//
//  JS  → Native:
//    "google.signIn"   arg = ignored (pass empty string)
//
//  Native → JS:
//    "google.signInResult"  arg = JSON
//      Success: {"success":true,"idToken":"<jwt>","nonce":"...","googleSub":"..."}
//      Cancel:  {"success":false,"kind":"user-cancelled","error":"..."}
//      Failure: {"success":false,"kind":"failed"|"unknown","error":"..."}
//
//  Same MRC + threading notes as AppleAuthBridgeGlue: listeners are
//  [copy]'d, replies dispatched to main queue.
//

#import "GoogleAuthBridgeGlue.h"
#import "platform/apple/JsbBridgeWrapper.h"
#import "tower_blocks_mobile-Swift.h"

static inline void DispatchToJS(NSString *event, NSString *arg) {
    NSString *eventCopy = [event copy];
    NSString *argCopy   = [arg copy];
    dispatch_async(dispatch_get_main_queue(), ^{
        [[JsbBridgeWrapper sharedInstance] dispatchEventToScript:eventCopy arg:argCopy];
    });
}

@implementation GoogleAuthBridgeGlue

+ (void)registerWithCocos {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        JsbBridgeWrapper *bridge = [JsbBridgeWrapper sharedInstance];
        GoogleAuthBridge *impl = [GoogleAuthBridge shared];

        // -- google.signIn -----------------------------------------------
        OnScriptEventListener signInListener = [^(NSString *_ignored) {
            [impl signInWithCompletion:^(NSString *result) {
                DispatchToJS(@"google.signInResult", result);
            }];
        } copy];
        [bridge addScriptEventListener:@"google.signIn" listener:signInListener];

        NSLog(@"[GoogleAuth] GoogleAuthBridgeGlue registered — 1 event listener active");
    });
}

@end
