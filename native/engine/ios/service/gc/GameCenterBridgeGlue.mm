//
//  GameCenterBridgeGlue.mm
//
//  Event schema (JsbBridgeWrapper):
//
//  JS  → Native:
//    "gc.authenticate"       arg = ignored — installs authenticateHandler
//                            if not yet installed; replays cached state.
//    "gc.getState"           arg = ignored — asks Swift to emit last-known
//                            auth state.
//    "gc.submitScore"        arg = JSON {"leaderboardID":"...", "score":123}
//    "gc.reportAchievement"  arg = JSON {"achievementID":"...", "percentComplete":50.0}
//    "gc.showUI"             arg = stateKind string ("", "leaderboards",
//                            "achievements", "dashboard", or
//                            "leaderboard:<id>" for a specific board)
//
//  Native → JS:
//    "gc.authResult"              arg = JSON auth result (see below).
//    "gc.submitScoreResult"       arg = JSON {"success":bool, "kind"?, "error"?}
//    "gc.reportAchievementResult" arg = JSON {"success":bool, "kind"?, "error"?}
//    "gc.showUIResult"            arg = JSON {"success":bool, "kind"?, "error"?}
//
//  authResult payload:
//    success: {"success":true,"gamePlayerID":"...","teamPlayerID":"...",
//              "displayName":"...","alias":"...","isUnderage":false}
//    failure: {"success":false,"kind":"...","error":"..."}
//
//  MRC + threading notes match AppleAuthBridgeGlue: JsbBridgeWrapper
//  is MRC, so listener blocks must be [copy]'d, and dispatchEventToScript
//  is main-thread-only (Swift side already bounces to main).
//

#import "GameCenterBridgeGlue.h"
#import "platform/apple/JsbBridgeWrapper.h"
// GameKit MUST be imported before the auto-generated Swift header —
// the header exposes GameCenterUIDelegate which conforms to
// GKGameCenterControllerDelegate, and without this import the ObjC
// compiler doesn't know that protocol exists → 'no type or protocol
// named GKGameCenterControllerDelegate' build error.
#import <GameKit/GameKit.h>
#import "tower_blocks_mobile-Swift.h"

static inline void DispatchToJS(NSString *event, NSString *arg) {
    NSString *eventCopy = [event copy];
    NSString *argCopy   = [arg copy];
    dispatch_async(dispatch_get_main_queue(), ^{
        [[JsbBridgeWrapper sharedInstance] dispatchEventToScript:eventCopy arg:argCopy];
    });
}

@implementation GameCenterBridgeGlue

+ (void)registerWithCocos {
    static dispatch_once_t once;
    dispatch_once(&once, ^{
        JsbBridgeWrapper *bridge = [JsbBridgeWrapper sharedInstance];
        GameCenterBridge *impl = [GameCenterBridge shared];

        // Wire the Swift-side onAuthResult callback to dispatch each
        // auth result to JS. Set BEFORE startAutoLogin so we don't
        // miss the first callback.
        impl.onAuthResult = [^(NSString *jsonPayload) {
            DispatchToJS(@"gc.authResult", jsonPayload);
        } copy];

        // -- gc.authenticate ---------------------------------------------
        // Fire-and-forget from JS: kicks off the login flow (or replays
        // cached state if already resolved).
        OnScriptEventListener authListener = [^(NSString *_ignored) {
            dispatch_async(dispatch_get_main_queue(), ^{
                [impl startAutoLogin];
            });
        } copy];
        [bridge addScriptEventListener:@"gc.authenticate" listener:authListener];

        // -- gc.getState -------------------------------------------------
        OnScriptEventListener stateListener = [^(NSString *_ignored) {
            [impl requestState];
        } copy];
        [bridge addScriptEventListener:@"gc.getState" listener:stateListener];

        // -- gc.submitScore ----------------------------------------------
        // arg = JSON {"leaderboardID":"...", "score":<int>}
        OnScriptEventListener submitListener = [^(NSString *arg) {
            NSString *leaderboardID = nil;
            long long score = 0;
            if ([arg isKindOfClass:[NSString class]] && [arg hasPrefix:@"{"]) {
                NSData *d = [arg dataUsingEncoding:NSUTF8StringEncoding];
                id parsed = [NSJSONSerialization JSONObjectWithData:d options:0 error:nil];
                if ([parsed isKindOfClass:[NSDictionary class]]) {
                    NSDictionary *obj = (NSDictionary *)parsed;
                    id lb = obj[@"leaderboardID"];
                    id sc = obj[@"score"];
                    if ([lb isKindOfClass:[NSString class]]) leaderboardID = (NSString *)lb;
                    if ([sc isKindOfClass:[NSNumber class]]) score = [(NSNumber *)sc longLongValue];
                }
            }
            if (leaderboardID.length == 0) {
                DispatchToJS(@"gc.submitScoreResult",
                             @"{\"success\":false,\"kind\":\"bad-arg\",\"error\":\"leaderboardID required\"}");
                return;
            }
            [impl submitScoreWithLeaderboardID:leaderboardID score:score completion:^(NSString *result) {
                DispatchToJS(@"gc.submitScoreResult", result);
            }];
        } copy];
        [bridge addScriptEventListener:@"gc.submitScore" listener:submitListener];

        // -- gc.reportAchievement ----------------------------------------
        // arg = JSON {"achievementID":"...", "percentComplete":<0..100>}
        OnScriptEventListener achListener = [^(NSString *arg) {
            NSString *achID = nil;
            double pct = 0;
            if ([arg isKindOfClass:[NSString class]] && [arg hasPrefix:@"{"]) {
                NSData *d = [arg dataUsingEncoding:NSUTF8StringEncoding];
                id parsed = [NSJSONSerialization JSONObjectWithData:d options:0 error:nil];
                if ([parsed isKindOfClass:[NSDictionary class]]) {
                    NSDictionary *obj = (NSDictionary *)parsed;
                    id a = obj[@"achievementID"];
                    id p = obj[@"percentComplete"];
                    if ([a isKindOfClass:[NSString class]]) achID = (NSString *)a;
                    if ([p isKindOfClass:[NSNumber class]]) pct = [(NSNumber *)p doubleValue];
                }
            }
            if (achID.length == 0) {
                DispatchToJS(@"gc.reportAchievementResult",
                             @"{\"success\":false,\"kind\":\"bad-arg\",\"error\":\"achievementID required\"}");
                return;
            }
            [impl reportAchievementWithAchievementID:achID percentComplete:pct completion:^(NSString *result) {
                DispatchToJS(@"gc.reportAchievementResult", result);
            }];
        } copy];
        [bridge addScriptEventListener:@"gc.reportAchievement" listener:achListener];

        // -- gc.showUI ---------------------------------------------------
        // arg = stateKind string (see header for options).
        OnScriptEventListener showListener = [^(NSString *stateKind) {
            NSString *sk = [stateKind isKindOfClass:[NSString class]] ? stateKind : @"";
            [impl showUIWithStateKind:sk completion:^(NSString *result) {
                DispatchToJS(@"gc.showUIResult", result);
            }];
        } copy];
        [bridge addScriptEventListener:@"gc.showUI" listener:showListener];

        // Kick off auto-login immediately — no need for JS to trigger.
        // On subsequent launches with a live Game Center session this
        // is silent (no UI); on first launch iOS shows the login sheet
        // (or the small "Welcome back" banner).
        dispatch_async(dispatch_get_main_queue(), ^{
            [impl startAutoLogin];
        });

        NSLog(@"[GameCenter] GameCenterBridgeGlue registered — 5 event listeners active, auto-login kicked off");
    });
}

@end
