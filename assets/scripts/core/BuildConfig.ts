/**
 * BuildConfig — per-branch build-time flags.
 *
 * The VALUES in this file differ across branches. When you merge
 * develop → main (or main → channel/*), this file is EXPECTED to
 * conflict — that's the whole point of the design. Resolve by keeping
 * the TARGET branch's values (never blindly overwrite with source).
 *
 * Convention:
 *   develop           IS_DEV_BUILD = true
 *   main              IS_DEV_BUILD = false
 *   channel/*         IS_DEV_BUILD = false (inherits from main)
 *
 * If you need a runtime dev tool that's OK to ship (analytics debug
 * page, admin backdoor with proper auth), don't gate it on this flag.
 * This flag is ONLY for things that must never reach players (level
 * skip buttons, force-win, wipe-progress, cheat gems, etc).
 *
 * How to flip on merge:
 *   git checkout main
 *   git merge --no-ff develop
 *   # Merge conflict on this file. Fix:
 *   sed -i 's|IS_DEV_BUILD: boolean = true|IS_DEV_BUILD: boolean = false|' \
 *       assets/scripts/core/BuildConfig.ts
 *   git add assets/scripts/core/BuildConfig.ts
 *   git commit
 */

/** True on `develop`, false on `main` + `channel/*`. Gates any UI
 *  or entry point that must not ship to players (level reset, one-key
 *  win, admin backdoors, mock data, etc). */
export const IS_DEV_BUILD: boolean = false;

/** Channel identifier — set to one of:
 *    'dev'           on develop
 *    'main'          on main
 *    'google_play'   on channel/google-play
 *    'app_store'     on channel/app-store
 *    'onestore'      on channel/onestore
 *    'onestore_beta' on channel/onestore-beta
 *
 *  Surfaces in Firebase Analytics as a user-property so the dashboard
 *  can slice DAU / retention / revenue by channel. Set once at boot
 *  by AnalyticsApi.setUserProperty('channel', BUILD_CHANNEL).
 *
 *  Merge conflict on this file is expected and desired (same convention
 *  as IS_DEV_BUILD above) — always keep the TARGET branch's value. */
export const BUILD_CHANNEL: string = 'app_store';

/** LevelPlay (Unity mediation) rewarded ad unit ID for this build.
 *  LevelPlay has SEPARATE ad units per platform — the iOS "benMingFangKuai"
 *  rewarded unit from https://platform.ironsrc.com (Ad Units → iOS).
 *  Passed to LevelPlayAdProvider at boot; it falls back to the Android
 *  default otherwise which would mis-attribute impressions. */
export const LEVELPLAY_REWARDED_AD_UNIT: string = ''; // TODO: fill from LevelPlay dashboard (iOS)

/** The LevelPlay App Key is read natively from Info.plist's
 *  `LevelPlayAppKey` entry (not from here) — iOS SDKs that fingerprint
 *  the plist expect it there, and it keeps the key out of the JS
 *  bundle which can be unpacked more easily than the signed bundle.
 *  Set it in native/engine/ios/Info.plist. */
