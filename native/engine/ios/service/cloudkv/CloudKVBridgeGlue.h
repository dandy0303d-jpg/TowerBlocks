//
//  CloudKVBridgeGlue.h
//  Register once at app boot after Cocos engine init.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface CloudKVBridgeGlue : NSObject
+ (void)registerWithCocos;
@end

NS_ASSUME_NONNULL_END
