//
//  GameCenterBridgeGlue.h
//
//  Register once at app boot AFTER the Cocos engine has been
//  initialised. Installs GKLocalPlayer.local.authenticateHandler and
//  wires JS event listeners.
//

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface GameCenterBridgeGlue : NSObject
+ (void)registerWithCocos;
@end

NS_ASSUME_NONNULL_END
