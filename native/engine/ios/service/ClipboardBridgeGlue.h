//
//  ClipboardBridgeGlue.h
//
//  Minimal JS <-> UIPasteboard bridge. sys.setClipboardText / setClipboard
//  are unreliable on the Cocos native iOS runtime (either absent or
//  no-op), so we go straight to UIPasteboard.general.
//
//  Event schema (JsbBridgeWrapper):
//
//  JS  → Native:
//    "clipboard.copy" arg = the string to place on the pasteboard.
//
//  There is no reply. Copy either succeeds or is silently no-op'd —
//  the JS caller should always show the "copied" toast optimistically
//  (or fall back to on-screen text if it matters).
//
//  Call [ClipboardBridgeGlue registerWithCocos] ONCE at app boot after
//  the Cocos engine has been initialised.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ClipboardBridgeGlue : NSObject
+ (void)registerWithCocos;
@end

NS_ASSUME_NONNULL_END
