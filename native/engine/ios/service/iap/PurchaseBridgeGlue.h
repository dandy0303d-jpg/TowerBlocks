//
//  PurchaseBridgeGlue.h
//  ObjC glue between the Cocos JS bridge (JsbBridgeWrapper) and the
//  Swift StoreKit 2 implementation (PurchaseBridge.swift).
//
//  Call [PurchaseBridgeGlue registerWithCocos] ONCE at app boot, after
//  the Cocos JS engine has finished initialising. AppDelegate does
//  this in applicationDidFinishLaunching.
//

#import <Foundation/Foundation.h>

@interface PurchaseBridgeGlue : NSObject

/// Register JS <-> native event handlers with JsbBridgeWrapper.
/// Safe to call multiple times (subsequent calls are no-op).
+ (void)registerWithCocos;

@end
