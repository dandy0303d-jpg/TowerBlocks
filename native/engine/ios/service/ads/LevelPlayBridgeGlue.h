//
//  LevelPlayBridgeGlue.h
//
//  Register once at app boot AFTER Cocos engine init. See AppDelegate.mm.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface LevelPlayBridgeGlue : NSObject
+ (void)registerWithCocos;
@end

NS_ASSUME_NONNULL_END
