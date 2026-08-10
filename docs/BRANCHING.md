# Branching model

This project ships to multiple app stores from one codebase. To keep
main free of store-specific SDK clutter, we use a **main + long-lived
channel branches + short-lived release branches** model.

```
main                          — the game itself (pure gameplay + backend)
├─ channel/google-play        — long-lived, only Google Play differences
├─ channel/app-store          — long-lived, only App Store differences
└─ release/{channel}-{ver}    — short-lived, cut per store submission
```

---

## Where each kind of change lives

| Kind of change                              | Branch                                |
|---------------------------------------------|----------------------------------------|
| Gameplay / balance / bug fix                | `main` (via a feature branch → PR)     |
| New content (levels, art, sound)            | `main`                                 |
| Backend endpoint / server schema            | `main`                                 |
| i18n strings                                | `main`                                 |
| Google Play Billing SDK integration         | `channel/google-play`                  |
| Firebase / GameCenter / AppsFlyer SDK       | corresponding channel branch           |
| Manifest / build.gradle / Info.plist edits  | corresponding channel branch           |
| Store-specific keystore, provisioning       | corresponding channel branch (local)   |
| Compliance banner text (GDPR, kids)         | corresponding channel branch           |

---

## Everyday workflow

### Add a game feature

```bash
git checkout main
git checkout -b feat/some-thing
# ... code, commit ...
git push -u origin feat/some-thing
# Open PR to main, merge when ready
```

### Sync main → channel (do this at least weekly + before every release)

```bash
git checkout channel/google-play
git merge --no-ff main
# resolve any conflicts, then:
git push
```

Repeat for `channel/app-store`.

**Merge, don't rebase** — rebasing a long-lived shared branch rewrites
history for anyone else who pulled it.

### Cut a release (submitting to a store)

```bash
git checkout channel/google-play
git pull                          # make sure it's fresh
git checkout -b release/gp-1.2.0  # freeze the code that goes to review
# ... bump versionCode / versionName in build.gradle ...
git commit -am "chore(release): bump to 1.2.0"
git tag v1.2.0-gp
git push --set-upstream origin release/gp-1.2.0
git push origin v1.2.0-gp
# ... build APK/AAB from this branch, upload to Play Console ...
```

### Hotfix during store review

```bash
git checkout release/gp-1.2.0
git checkout -b hotfix/gp-1.2.1-crash
# ... fix, commit ...
git checkout release/gp-1.2.0
git merge --no-ff hotfix/gp-1.2.1-crash
git tag v1.2.1-gp
# rebuild, resubmit
# then propagate the fix back home:
git checkout main
git cherry-pick <the-fix-commit-sha>
git checkout channel/google-play
git cherry-pick <the-fix-commit-sha>
# (if the fix is store-specific, only cherry-pick to the channel)
```

---

## Adapter layer (main-branch code that channel branches swap out)

Main only ever touches **interfaces** from `assets/scripts/core/channels/`.
Concrete implementations live in each channel branch. Current adapters:

| Interface           | Main default              | GP branch                        | AS branch                  |
|---------------------|---------------------------|----------------------------------|----------------------------|
| `IPurchaseProvider` | `MockPurchaseProvider`    | `GooglePlayBillingProvider` (TBD) | `StoreKitProvider` (TBD)   |

Channel branches register the real implementation at boot:

```typescript
// e.g. in channel/google-play's LoadingController override
import { Providers } from '../core/channels/Providers';
import { GooglePlayBillingProvider } from './GooglePlayBillingProvider';

Providers.setPurchase(new GooglePlayBillingProvider());
await Providers.purchase.init();
```

**Adding a new adapter** (analytics, remote config, push, ad SDK):

1. Define `IFoo` interface in `assets/scripts/core/channels/IFoo.ts`
   (main branch).
2. Add `MockFoo` default implementation (main branch).
3. Add slot to `Providers`: `static foo: IFoo = new MockFoo();`
4. Refactor callers in `main` to use `Providers.foo.<method>()`.
5. Merge main into each channel branch, then implement `RealFoo` on
   each channel branch and register in its boot code.

---

## Files that CHANNEL BRANCHES own (never edit on main)

Once a channel branch overrides these files, the merge from main
should be careful to preserve the channel's version (usually
`git merge` will just work, but if main also touches the same lines
you get a conflict — always keep the channel's version, since main's
version is the "no SDK integration" baseline).

- `native/engine/android/app/AndroidManifest.xml` (permissions, meta-data)
- `native/engine/android/app/build.gradle` (SDK deps, keystore refs)
- `native/engine/android/app/proguard-rules.pro` (SDK keep rules)
- `native/engine/android/app/src/com/cocos/game/AppActivity.java` (SDK init hooks)
- `native/engine/ios/` (whole tree, when iOS branch is populated)
- `assets/scripts/channels/gp/` or `/as/` (channel-specific TS)
- `settings/store-listing/` (store metadata: description, screenshots)
  — TBD folder, not yet created

## Files that MAIN owns (channel branches inherit — don't fork)

- Everything under `assets/scripts/core/`, `assets/scripts/main/`,
  `assets/scripts/audio/`
- All `assets/scenes/`, `assets/prefabs/`, `assets/image/`,
  `assets/textures/`, `assets/models/`, `assets/audio/`
- `assets/scripts/core/channels/I*.ts` (interfaces — implementations go on channel)
- `assets/scripts/core/channels/Mock*.ts` (default fallbacks)
- `assets/scripts/core/channels/Providers.ts` (registry)
- `tests/` (unit tests)
- `package.json`, `tsconfig.json`, `vitest.config.ts`
- `native/engine/common/` (C++ boot — usually stock)
- `native/engine/android/res/mipmap-*/ic_launcher.png` (default placeholder — channels may override)
- `native/engine/android/res/values/strings.xml` (app name; channel may override)
- Server code (`../tetritower-backend/`, out-of-tree here)

## Files that are IGNORED entirely (never in git)

See `.gitignore`. Highlights:

- `library/`, `temp/`, `build/`, `profiles/` — Cocos build cache & task config
- `native/engine/**/build/`, `.gradle/`, `.cxx/`, `CMakeCache.txt`,
  `CMakeFiles/`, `*.o`, `*.obj` — native compile products
- `node_modules/`
- `open-source-mac-os-apps/` — stray unrelated repo

---

## Package name

Unified across all channels: **`com.konenine.tetritower`**.

The whole company uses one app identity, so an install can migrate
between stores without becoming "a different app" for the OS.
Consequence: Play Store and third-party Android stores can't both
list the same package (Play requires unique appId across the ecosystem
they know about). If we ever need China-store distribution alongside
GP, we'll add per-channel suffixes at that point.

## Backend URL

Unified across all channels: **`https://tetritower.konenine.kr`**
(nginx reverse proxy → docker `server:8080`, Let's Encrypt cert, HSTS-ready
so iOS ATS passes without exception plist).

Backend does not currently vary per channel. If GP-only or AS-only
endpoints appear later (e.g. subscription webhook), they live on the
same server behind path prefixes — no per-channel API URL.

---

## Version numbering

`MAJOR.MINOR.PATCH` on tags, per channel:

- `v1.2.0-gp` — Google Play, 1.2.0
- `v1.2.0-as` — App Store, 1.2.0

Bump rules:
- MAJOR: breaking gameplay change, save-data incompatibility
- MINOR: new feature / new content
- PATCH: bugfix, no user-visible feature change

Android `versionCode` (integer) tracks releases monotonically across
all channels — never reuse. `versionName` mirrors the semver tag
(strip the `v` prefix + channel suffix).

iOS `CFBundleShortVersionString` == semver, `CFBundleVersion` ==
monotonic integer (same rule as versionCode).
