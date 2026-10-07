/**
 * PlayGamesAchievements — develop/non-google-play stub.
 *
 * The real implementation lives on channel/google-play (bridges to
 * PlayGamesBridge.kt). Develop (and the other channels) need a file
 * at this path because MenuController uses a dynamic `import()` that
 * Cocos's build-script bundler still statically resolves — a missing
 * file breaks the build even though the import is wrapped in `.catch`.
 *
 * All methods are no-ops here; channel/google-play overrides this
 * file via cherry-pick / its own tree.
 */

export const PlayGamesAchievements = {
    onBadgeEarned(_badgeOrdinal: number): void { /* no-op */ },
    syncBadgeCount(_earnedCount: number): void { /* no-op */ },
};
