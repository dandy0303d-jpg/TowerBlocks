//
//  CloudKVBridgeGlue.mm
//
//  JS  → Native:
//    "cloudkv.setIdentity"    arg = JSON blob string (arbitrary)
//    "cloudkv.getIdentity"    arg = ignored
//    "cloudkv.clearIdentity"  arg = ignored
//
//  Native → JS:
//    "cloudkv.identityResult"    arg = JSON {"success":true,"identity":"<blob>"}
//                                       from getIdentity replies
//    "cloudkv.identityChanged"   arg = raw blob string — fires when
//                                iCloud pushes a change from another
//                                device (not for our own writes).
//

#import "CloudKVBridgeGlue.h"
#import "platform/apple/JsbBridgeWrapper.h"
#import "tower_blocks_mobile-Swift.h"

static inline void DispatchToJS(NSString *event, NSString *arg) {
    NSString *eventCopy = [event copy];
    NSString *argCopy   = [arg copy];
    dispatch_async(dispatch_get_main_queue(), ^{
        [[JsbBridgeWrapper sharedInstance] dispatchEventToScript:eventCopy arg:argCopy];
    });
}

@implementation CloudKVBridgeGlue

+ (void)registerWithCocos {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        JsbBridgeWrapper *bridge = [JsbBridgeWrapper sharedInstance];
        CloudKVBridge *impl = [CloudKVBridge shared];

        // Wire external-change notifications first so we don't miss the
        // very first one during boot.
        impl.onIdentityChanged = [^(NSString *raw) {
            DispatchToJS(@"cloudkv.identityChanged", raw);
        } copy];

        // -- cloudkv.setIdentity ------------------------------------------
        OnScriptEventListener setListener = [^(NSString *json) {
            if (![json isKindOfClass:[NSString class]]) return;
            [impl setIdentity:json];
        } copy];
        [bridge addScriptEventListener:@"cloudkv.setIdentity" listener:setListener];

        // -- cloudkv.getIdentity ------------------------------------------
        OnScriptEventListener getListener = [^(NSString *_ignored) {
            [impl getIdentityWithCompletion:^(NSString *result) {
                DispatchToJS(@"cloudkv.identityResult", result);
            }];
        } copy];
        [bridge addScriptEventListener:@"cloudkv.getIdentity" listener:getListener];

        // -- cloudkv.clearIdentity ----------------------------------------
        OnScriptEventListener clearListener = [^(NSString *_ignored) {
            [impl clearIdentity];
        } copy];
        [bridge addScriptEventListener:@"cloudkv.clearIdentity" listener:clearListener];

        NSLog(@"[CloudKV] CloudKVBridgeGlue registered — 3 event listeners active");
    });
}

@end
