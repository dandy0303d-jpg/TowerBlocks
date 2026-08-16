//
//  HapticBridgeGlue.mm
//
//  JS  → Native:
//    "haptic.impact"  arg = style string ("light" | "medium" | "heavy" | "success")
//
//  No native → JS events. Fire-and-forget.
//

#import "HapticBridgeGlue.h"
#import "platform/apple/JsbBridgeWrapper.h"
#import "tower_blocks_mobile-Swift.h"

@implementation HapticBridgeGlue

+ (void)registerWithCocos {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        JsbBridgeWrapper *bridge = [JsbBridgeWrapper sharedInstance];
        HapticBridge *impl = [HapticBridge shared];

        OnScriptEventListener impactListener = [^(NSString *style) {
            if (![style isKindOfClass:[NSString class]] || style.length == 0) return;
            [impl impactWithStyle:style];
        } copy];
        [bridge addScriptEventListener:@"haptic.impact" listener:impactListener];

        NSLog(@"[Haptic] HapticBridgeGlue registered — 1 event listener active");
    });
}

@end
