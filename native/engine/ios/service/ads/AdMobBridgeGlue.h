//
//  AdMobBridgeGlue.h
//  Register once at app boot AFTER Cocos engine init.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface AdMobBridgeGlue : NSObject
+ (void)registerWithCocos;
@end

NS_ASSUME_NONNULL_END
