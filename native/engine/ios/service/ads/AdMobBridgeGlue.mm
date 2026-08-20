//
//  AdMobBridgeGlue.mm
//
//  Event schema (JsbBridgeWrapper) — identical to AppLovinBridgeGlue,
//  extended with a `slot` field on rewarded show/load requests to
//  support multiple rewarded placements sharing one bridge.
//
//  JS  → Native:
//    "ads.init"             arg = JSON {"rewardedMagicId","rewardedFateId","interstitialId"}
//                                 (sdkKey field, if present, is ignored — AdMob
//                                 reads GADApplicationIdentifier from Info.plist)
//    "ads.loadRewarded"     arg = slot key string ("magic" | "fate")
//    "ads.showRewarded"     arg = slot key string ("magic" | "fate")
//    "ads.loadInterstitial" arg = ignored
//    "ads.showInterstitial" arg = ignored
//
//  Native → JS:
//    "ads.initResult"          arg = JSON {"success":bool, "error"?}
//    "ads.rewardedResult"      arg = JSON {"success":bool, "rewarded"?, "slot":str, "error"?, "kind"?}
//    "ads.interstitialResult"  arg = JSON {"success":bool, "error"?, "kind"?}
//

#import "AdMobBridgeGlue.h"
#import "platform/apple/JsbBridgeWrapper.h"
#import "tower_blocks_mobile-Swift.h"

static inline void DispatchToJS(NSString *event, NSString *arg) {
    NSString *eventCopy = [event copy];
    NSString *argCopy   = [arg copy];
    dispatch_async(dispatch_get_main_queue(), ^{
        [[JsbBridgeWrapper sharedInstance] dispatchEventToScript:eventCopy arg:argCopy];
    });
}

// Default slot used when JS omits or passes an empty string. Keeps
// the older single-slot call sites working without a JS change.
static NSString *const kDefaultSlot = @"magic";

static inline NSString *NormalizedSlot(NSString *arg) {
    if (![arg isKindOfClass:[NSString class]] || arg.length == 0) return kDefaultSlot;
    return arg;
}

@implementation AdMobBridgeGlue

+ (void)registerWithCocos {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        JsbBridgeWrapper *bridge = [JsbBridgeWrapper sharedInstance];
        AdMobBridge *impl = [AdMobBridge shared];

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
            NSString *rMagic = obj[@"rewardedMagicId"];
            NSString *rFate  = obj[@"rewardedFateId"];
            NSString *iId    = obj[@"interstitialId"];
            [impl initSdkWithRewardedMagicAdUnitId:(rMagic ?: @"")
                              rewardedFateAdUnitId:(rFate  ?: @"")
                              interstitialAdUnitId:(iId    ?: @"")];
        } copy];
        [bridge addScriptEventListener:@"ads.init" listener:initListener];

        // -- ads.loadRewarded --------------------------------------------
        OnScriptEventListener loadRewListener = [^(NSString *arg) {
            [impl loadRewardedForSlot:NormalizedSlot(arg)];
        } copy];
        [bridge addScriptEventListener:@"ads.loadRewarded" listener:loadRewListener];

        // -- ads.showRewarded --------------------------------------------
        OnScriptEventListener showRewListener = [^(NSString *arg) {
            [impl showRewardedForSlot:NormalizedSlot(arg)];
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

        NSLog(@"[Ads] AdMobBridgeGlue registered — 5 event listeners active");
    });
}

@end
