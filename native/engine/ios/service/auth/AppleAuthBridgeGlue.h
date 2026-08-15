//
//  AppleAuthBridgeGlue.h
//  ObjC glue between the Cocos JS bridge and Swift AppleAuthBridge.
//  Register via [AppleAuthBridgeGlue registerWithCocos] at app boot.
//

#import <Foundation/Foundation.h>

@interface AppleAuthBridgeGlue : NSObject

/// Register JS ↔ native event handlers with JsbBridgeWrapper.
/// Safe to call multiple times (dispatch_once internally).
+ (void)registerWithCocos;

@end
