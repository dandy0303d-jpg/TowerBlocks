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
 *   sed -i 's|IS_DEV_BUILD: boolean = false|IS_DEV_BUILD: boolean = false|' \
 *       assets/scripts/core/BuildConfig.ts
 *   git add assets/scripts/core/BuildConfig.ts
 *   git commit
 */

/** True on `develop`, false on `main` + `channel/*`. Gates any UI
 *  or entry point that must not ship to players (level reset, one-key
 *  win, admin backdoors, mock data, etc). */
export const IS_DEV_BUILD: boolean = false;
