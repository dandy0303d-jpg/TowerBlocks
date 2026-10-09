/****************************************************************************
 Copyright (c) 2010-2013 cocos2d-x.org
 Copyright (c) 2013-2016 Chukong Technologies Inc.
 Copyright (c) 2017-2022 Xiamen Yaji Software Co., Ltd.

 http://www.cocos.com

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated engine source code (the "Software"), a limited,
 worldwide, royalty-free, non-assignable, revocable and non-exclusive license
 to use Cocos Creator solely to develop games on your target platforms. You shall
 not use Cocos Creator software for developing other software or tools that's
 used for developing games. You are not granted to publish, distribute,
 sublicense, and/or sell copies of Cocos Creator.

 The software or tools in this License Agreement are licensed, not sold.
 Xiamen Yaji Software Co., Ltd. reserves all rights not expressly granted to you.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
****************************************************************************/

#import "AppDelegate.h"
#import "ViewController.h"
#import "View.h"

#include "platform/ios/IOSPlatform.h"
#import "platform/ios/AppDelegateBridge.h"
#import "service/SDKWrapper.h"
#import "service/iap/PurchaseBridgeGlue.h"
#import "service/auth/AppleAuthBridgeGlue.h"
#import "service/auth/GoogleAuthBridgeGlue.h"
#import "service/gc/GameCenterBridgeGlue.h"
#import "service/haptic/HapticBridgeGlue.h"
// AppLovin bridge exists but is not registered — AdMob is the active
// provider. Left available for future mediation.
// #import "service/ads/AppLovinBridgeGlue.h"
#import "service/ads/AdMobBridgeGlue.h"
#import "service/ClipboardBridgeGlue.h"
// Firebase bridge removed — see CMakeLists.txt note. AnalyticsApi.ts
// iOS branch is now a no-op; Analytics / Crashlytics / Remote Config
// will be re-integrated via Swift Package Manager in a future pass.
#import <AppTrackingTransparency/AppTrackingTransparency.h>

@implementation AppDelegate
@synthesize window;
@synthesize appDelegateBridge;

#pragma mark -
#pragma mark Application lifecycle

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions {
    // Firebase install removed with the FirebaseBridgeGlue — Analytics /
    // Crashlytics / Remote Config will be re-integrated via SwiftPM.
    [[SDKWrapper shared] application:application didFinishLaunchingWithOptions:launchOptions];
    appDelegateBridge = [[AppDelegateBridge alloc] init];
    
    // Add the view controller's view to the window and display.
    CGRect bounds = [[UIScreen mainScreen] bounds];
    self.window   = [[UIWindow alloc] initWithFrame:bounds];

    // Should create view controller first, cc::Application will use it.
    _viewController                           = [[ViewController alloc] init];
    _viewController.view                      = [[View alloc] initWithFrame:bounds];
    _viewController.view.contentScaleFactor   = UIScreen.mainScreen.scale;
    _viewController.view.multipleTouchEnabled = true;
    [self.window setRootViewController:_viewController];

    [self.window makeKeyAndVisible];
    [appDelegateBridge application:application didFinishLaunchingWithOptions:launchOptions];

    // Register the StoreKit 2 bridge so JS can drive purchases via
    // native.bridge.sendToNative("iap.*", ...). Safe to call multiple
    // times — internally guarded by dispatch_once.
    if (@available(iOS 15.0, *)) {
        [PurchaseBridgeGlue registerWithCocos];
    }

    // Register the Sign in with Apple bridge — 'siwa.*' events.
    if (@available(iOS 13.0, *)) {
        [AppleAuthBridgeGlue registerWithCocos];
    }

    // Register the Google Sign-In bridge — 'google.*' events. Uses
    // ASWebAuthenticationSession (iOS 13+; we require 15+).
    if (@available(iOS 13.0, *)) {
        [GoogleAuthBridgeGlue registerWithCocos];
    }

    // Register the clipboard bridge — 'clipboard.copy' event. UIPasteboard
    // has been available since iOS 3; no version guard needed.
    [ClipboardBridgeGlue registerWithCocos];

    // Register the Game Center bridge — installs GKLocalPlayer.local
    // authenticateHandler and kicks off silent login. GameKit is
    // available on all iOS versions we support.
    [GameCenterBridgeGlue registerWithCocos];

    // Register the haptic bridge — 'haptic.impact' event. Pre-warms
    // UIImpactFeedbackGenerators to avoid the first-fire lag.
    [HapticBridgeGlue registerWithCocos];

    // Register the ads bridge — 'ads.*' events. JS calls ads.init
    // with credentials on boot; the SDK initialises asynchronously
    // and starts loading the first ad slots.
    [AdMobBridgeGlue registerWithCocos];

    // Request App Tracking Transparency (ATT) permission ~1 s after
    // launch. Apple guideline: don't fire ATT immediately at boot —
    // wait until UI has settled so the system sheet doesn't compete
    // with launch animation. Without this call, AdMob can only serve
    // non-personalized ads and IDFA stays zeroed.
    // The prompt localizes via NSUserTrackingUsageDescription in
    // each .lproj/InfoPlist.strings (already set up).
    if (@available(iOS 14.0, *)) {
        dispatch_after(dispatch_time(DISPATCH_TIME_NOW, (int64_t)(1.0 * NSEC_PER_SEC)),
                       dispatch_get_main_queue(), ^{
            [ATTrackingManager requestTrackingAuthorizationWithCompletionHandler:^(ATTrackingManagerAuthorizationStatus status) {
                NSString *statusName;
                switch (status) {
                    case ATTrackingManagerAuthorizationStatusAuthorized:    statusName = @"authorized"; break;
                    case ATTrackingManagerAuthorizationStatusDenied:        statusName = @"denied"; break;
                    case ATTrackingManagerAuthorizationStatusRestricted:    statusName = @"restricted"; break;
                    case ATTrackingManagerAuthorizationStatusNotDetermined: statusName = @"notDetermined"; break;
                    default:                                                statusName = @"unknown"; break;
                }
                NSLog(@"[ATT] tracking authorization status = %@", statusName);
            }];
        });
    }

    return YES;
}

- (void)applicationWillResignActive:(UIApplication *)application {
    /*
     Sent when the application is about to move from active to inactive state. This can occur for certain types of temporary interruptions (such as an incoming phone call or SMS message) or when the user quits the application and it begins the transition to the background state.
     Use this method to pause ongoing tasks, disable timers, and throttle down OpenGL ES frame rates. Games should use this method to pause the game.
     */
    [[SDKWrapper shared] applicationWillResignActive:application];
    [appDelegateBridge applicationWillResignActive:application];
}

- (void)applicationDidBecomeActive:(UIApplication *)application {
    /*
     Restart any tasks that were paused (or not yet started) while the application was inactive. If the application was previously in the background, optionally refresh the user interface.
     */
    [[SDKWrapper shared] applicationDidBecomeActive:application];
    [appDelegateBridge applicationDidBecomeActive:application];
}

- (void)applicationDidEnterBackground:(UIApplication *)application {
    /*
     Use this method to release shared resources, save user data, invalidate timers, and store enough application state information to restore your application to its current state in case it is terminated later.
     If your application supports background execution, called instead of applicationWillTerminate: when the user quits.
     */
    [[SDKWrapper shared] applicationDidEnterBackground:application];
}

- (void)applicationWillEnterForeground:(UIApplication *)application {
    /*
     Called as part of  transition from the background to the inactive state: here you can undo many of the changes made on entering the background.
     */
    [[SDKWrapper shared] applicationWillEnterForeground:application];
}

- (void)applicationWillTerminate:(UIApplication *)application {
    [[SDKWrapper shared] applicationWillTerminate:application];
    [appDelegateBridge applicationWillTerminate:application];
}

#pragma mark -
#pragma mark Memory management

- (void)applicationDidReceiveMemoryWarning:(UIApplication *)application {
    [[SDKWrapper shared] applicationDidReceiveMemoryWarning:application];
}

// Highest-priority orientation hook — iOS asks the app delegate first,
// before falling through to the root view controller. Returning
// Portrait here overrides any child view-controller that might allow
// rotation, and covers presented sheets / alerts as well. Combined
// with ViewController.mm's supportedInterfaceOrientations and
// Info.plist's UISupportedInterfaceOrientations, this locks the app
// to portrait on every device / iOS version.
- (UIInterfaceOrientationMask)application:(UIApplication *)application
    supportedInterfaceOrientationsForWindow:(UIWindow *)window {
    return UIInterfaceOrientationMaskPortrait;
}

@end
