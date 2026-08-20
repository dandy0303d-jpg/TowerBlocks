//
//  AppLovinBridgeGlue.mm
//
//  Event schema (JsbBridgeWrapper):
//
//  JS  → Native:
//    "ads.init"             arg = JSON {"sdkKey","rewardedId","interstitialId"}
//    "ads.loadRewarded"     arg = ignored
//    "ads.showRewarded"     arg = ignored
//    "ads.loadInterstitial" arg = ignored
//    "ads.showInterstitial" arg = ignored
//
//  Native → JS:
//    "ads.initResult"          arg = JSON {"success":bool, "error"?}
//    "ads.rewardedResult"      arg = JSON {"success":bool, "rewarded"?, "error"?, "kind"?}
//    "ads.interstitialResult"  arg = JSON {"success":bool, "error"?, "kind"?}
//

#import "AppLovinBridgeGlue.h"
#import "platform/apple/JsbBridgeWrapper.h"
#import "tower_blocks_mobile-Swift.h"

static inline void DispatchToJS(NSString *event, NSString *arg) {
    NSString *eventCopy = [event copy];
    NSString *argCopy   = [arg copy];
    dispatch_async(dispatch_get_main_queue(), ^{
        [[JsbBridgeWrapper sharedInstance] dispatchEventToScript:eventCopy arg:argCopy];
    });
}

@implementation AppLovinBridgeGlue

+ (void)registerWithCocos {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        JsbBridgeWrapper *bridge = [JsbBridgeWrapper sharedInstance];
        AppLovinBridge *impl = [AppLovinBridge shared];

        // Wire the Swift-side callbacks to dispatch each result to JS.
        impl.onInitResult = [^(NSString *json) {
            DispatchToJS(@"ads.initResult", json);
        } copy];
        impl.onRewardedResult = [^(NSString *json) {
            DispatchToJS(@"ads.rewardedResult", json);
        } copy];
        impl.onInterstitialResult = [^(NSString *json) {
            DispatchToJS(@"ads.interstitialResult", json);
        } copy];

        // -- ads.init ----------------------------------------------------
        OnScriptEventListener initListener = [^(NSString *arg) {
            if (![arg isKindOfClass:[NSString class]] || arg.length == 0) {
                DispatchToJS(@"ads.initResult",
                             @"{\"success\":false,\"error\":\"empty arg\"}");
                return;
            }
            NSData *d = [arg dataUsingEncoding:NSUTF8StringEncoding];
            id parsed = [NSJSONSerialization JSONObjectWithData:d options:0 error:nil];
            if (![parsed isKindOfClass:[NSDictionary class]]) {
                DispatchToJS(@"ads.initResult",
                             @"{\"success\":false,\"error\":\"bad JSON\"}");
                return;
            }
            NSDictionary *obj = (NSDictionary *)parsed;
            NSString *sdkKey = obj[@"sdkKey"];
            NSString *rId    = obj[@"rewardedId"];
            NSString *iId    = obj[@"interstitialId"];
            if (![sdkKey isKindOfClass:[NSString class]] || sdkKey.length == 0) {
                DispatchToJS(@"ads.initResult",
                             @"{\"success\":false,\"error\":\"missing sdkKey\"}");
                return;
            }
            [impl initSdkWithKey:sdkKey
               rewardedAdUnitId:(rId ?: @"")
           interstitialAdUnitId:(iId ?: @"")];
        } copy];
        [bridge addScriptEventListener:@"ads.init" listener:initListener];

        // -- ads.loadRewarded --------------------------------------------
        OnScriptEventListener loadRewListener = [^(NSString *_ignored) {
            [impl loadRewarded];
        } copy];
        [bridge addScriptEventListener:@"ads.loadRewarded" listener:loadRewListener];

        // -- ads.showRewarded --------------------------------------------
        OnScriptEventListener showRewListener = [^(NSString *_ignored) {
            [impl showRewarded];
        } copy];
        [bridge addScriptEventListener:@"ads.showRewarded" listener:showRewListener];

        // -- ads.loadInterstitial ----------------------------------------
        OnScriptEventListener loadIntListener = [^(NSString *_ignored) {
            [impl loadInterstitial];
        } copy];
        [bridge addScriptEventListener:@"ads.loadInterstitial" listener:loadIntListener];

        // -- ads.showInterstitial ----------------------------------------
        OnScriptEventListener showIntListener = [^(NSString *_ignored) {
            [impl showInterstitial];
        } copy];
        [bridge addScriptEventListener:@"ads.showInterstitial" listener:showIntListener];

        NSLog(@"[Ads] AppLovinBridgeGlue registered — 5 event listeners active");
    });
}

@end
