//
//  ClipboardBridgeGlue.mm
//
//  See ClipboardBridgeGlue.h for the event schema.
//
//  Threading: UIPasteboard is main-thread-only. JsbBridgeWrapper listener
//  callbacks arrive on the JS thread, so every access to
//  [UIPasteboard generalPasteboard] is dispatched to the main queue.
//
//  MRC note: JsbBridgeWrapper is compiled without ARC. Blocks stored in
//  its listener registry MUST be [copy]'d before being handed over — the
//  same gotcha PurchaseBridgeGlue and AppleAuthBridgeGlue hit — otherwise
//  the stack frame that created the block returns, the block goes stale,
//  and later invocation crashes with EXC_BAD_ACCESS.
//

#import "ClipboardBridgeGlue.h"
#import "platform/apple/JsbBridgeWrapper.h"
#import <UIKit/UIKit.h>

@implementation ClipboardBridgeGlue

+ (void)registerWithCocos {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        JsbBridgeWrapper *bridge = [JsbBridgeWrapper sharedInstance];

        OnScriptEventListener copyListener = [^(NSString *text) {
            if (![text isKindOfClass:[NSString class]]) {
                NSLog(@"[Clipboard] copy called with non-string arg — ignored");
                return;
            }
            NSString *textCopy = [text copy];
            dispatch_async(dispatch_get_main_queue(), ^{
                [[UIPasteboard generalPasteboard] setString:textCopy];
                NSLog(@"[Clipboard] copied %lu chars via UIPasteboard",
                      (unsigned long)textCopy.length);
            });
        } copy];
        [bridge addScriptEventListener:@"clipboard.copy" listener:copyListener];

        NSLog(@"[Clipboard] ClipboardBridgeGlue registered — 1 event listener active");
    });
}

@end
