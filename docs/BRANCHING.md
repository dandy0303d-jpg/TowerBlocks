# Branching model

This project ships to multiple app stores from one codebase. To keep
main clean and channel-branch merges predictable, we use a
**develop + main + long-lived channel branches + short-lived release
branches** model, plus a moving `stable-*` tag on the latest tested
main commit.

```
develop                       — daily integration; unstable / in-progress
   ↓ (merge after testing)
main                          — stable baseline; only tested code lands here
   │                            ← tagged `stable-YYYYMMDD` at each merge in
   ├─ channel/google-play     — long-lived, only Google Play differences
   ├─ channel/app-store       — long-lived, only App Store differences
   ├─ channel/huawei          — (未来) 华为应用市场
   ├─ channel/vivo            — (未来) Vivo 应用商店
   ├─ channel/xiaomi          — (未来) 小米应用商店 / Get Apps
   ├─ channel/oppo            — (未来) OPPO 软件商店
   ├─ channel/taptap          — (未来) TapTap 国内 & 国际
   └─ release/{channel}-{ver} — short-lived, cut per store submission
```

**Channel topology = flat**. Each store branch sits at the same level,
merges from `main` directly. No intermediate `channel/android` layer
even for the multi-Android-channel case — the truly shared Android
code (Manifest permissions, common gradle config, AppActivity.java
base, launcher icons) lives on `main`, and channels only diverge on
store-specific SDK integration (IAP / login / push / ads / analytics),
which is completely different per store and can't be usefully shared.

Flat structure keeps merges to a single hop (`main → channel/xxx`) and
avoids the "channel/android/base → channel/android/huawei" two-step
merge that trips up multi-layer nesting. If channel count ever grows
past 8-10 with significant shared Android-only code, revisit and
consider adding a `channel/android` intermediate layer at that point.

**Golden rule**: `main` never has broken code. If you're not sure it's
tested, it goes on `develop`. Channels only ever merge from `main` —
never from `develop`.

---

## Where each kind of change lives

| Kind of change                              | Starts on                              |
|---------------------------------------------|----------------------------------------|
| Gameplay / balance / bug fix                | `feat/xxx` or `fix/xxx` → PR → `develop` → `main` |
| New content (levels, art, sound)            | same as above                          |
| Backend endpoint / server schema            | same as above                          |
| i18n strings                                | same as above                          |
| Emergency line-issue hotfix                 | `hotfix/xxx` from `main`, merge back into both `main` **and** `develop` |
| Google Play Billing SDK integration         | `channel/google-play` directly         |
| Firebase / GameCenter / AppsFlyer SDK       | corresponding channel branch           |
| Manifest / build.gradle / Info.plist edits  | corresponding channel branch           |
| Store-specific keystore, provisioning       | corresponding channel branch (local)   |
| Compliance banner text (GDPR, kids)         | corresponding channel branch           |

---

## Everyday workflow

### Add a game feature (day-to-day)

```bash
git checkout develop
git pull                                # if remote exists
git checkout -b feat/some-thing
# ... code, commit ...
git checkout develop
git merge --no-ff feat/some-thing
git branch -d feat/some-thing
# ...test it (Cocos preview / unit tests / APK smoke test)...
```

Nothing on `develop` is guaranteed stable — it's your integration sandbox.

### Promote develop → main (when a batch of work is verified)

```bash
git checkout main
git merge --no-ff develop -m "release: promote develop → main (yyyy-mm-dd)"
# Tag the new stable snapshot (see "Stable tags" section).
git tag stable-$(date +%Y%m%d)
```

After promoting, propagate to the channel branches so their next
release has the new code:

```bash
git checkout channel/google-play
git merge --no-ff main
git checkout channel/app-store
git merge --no-ff main
git checkout develop
```

Or use the helper script (auto-loops over every `channel/*` branch,
so newly added channels get synced automatically):

```bash
./scripts/promote-to-channels.sh
```

**Merge, don't rebase** — rebasing a long-lived shared branch rewrites
history you or a teammate may already have pulled.

### Add a new channel (e.g. 华为 / Vivo / 小米)

```bash
git checkout main
git checkout -b channel/huawei
# On the new branch:
#   1. Install channel SDK jars/aars in native/engine/android/app/libs/
#   2. Edit native/engine/android/app/build.gradle → add SDK deps
#   3. Edit native/engine/android/app/AndroidManifest.xml → add
#      SDK permissions & <meta-data> (Huawei App ID etc.)
#   4. Create assets/scripts/channels/huawei/HuaweiPurchaseProvider.ts
#      (implements IPurchaseProvider using Huawei IapClient)
#   5. Register in boot: Providers.setPurchase(new HuaweiPurchaseProvider())
#   6. Update this doc's channel table + add to promote-to-channels.sh
git add -A
git commit -m "feat(huawei): integrate HMS Core IAP"
```

Then update `scripts/promote-to-channels.sh` to include the new branch
(it auto-discovers via `git for-each-ref refs/heads/channel/*`, so no
edit needed unless you want to skip one).

### Cut a release (submitting to a store)

```bash
git checkout channel/google-play
git pull                          # make sure it's fresh (remote if any)
git checkout -b release/gp-1.2.0  # freeze the code that goes to review
# ... bump versionCode / versionName in build.gradle ...
git commit -am "chore(release): bump to 1.2.0"
git tag v1.2.0-gp
# ... build APK/AAB from this branch, upload to Play Console ...
```

### Hotfix during store review

The fix must land back on `main` and `develop` too — otherwise the next
release will regress.

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
git tag stable-$(date +%Y%m%d)              # main advanced, refresh the tag
git checkout develop
git cherry-pick <the-fix-commit-sha>
git checkout channel/google-play
git cherry-pick <the-fix-commit-sha>
# (if the fix is store-specific, only cherry-pick to the channel and skip main/develop)
```

### Line-issue hotfix (bug found in prod, not related to a pending release)

```bash
git checkout main
git checkout -b hotfix/prod-crash
# ... fix, commit ...
git checkout main
git merge --no-ff hotfix/prod-crash
git tag stable-$(date +%Y%m%d)
# Propagate down to develop so the next dev cycle has it:
git checkout develop
git merge --no-ff main
# And out to channels for the next release:
git checkout channel/google-play
git merge --no-ff main
git checkout channel/app-store
git merge --no-ff main
```

---

## Stable tags

Every time `develop` merges into `main` (or a hotfix lands on `main`),
tag the merge commit as `stable-YYYYMMDD`. These tags:

- Give a one-line summary of "the state of main over time" — quickly
  see all past stable snapshots.
- Immutable: never move or delete a `stable-*` tag once created. If
  two stable merges happen the same day, append a suffix (`-b`, `-2`).
- Cheap way to bisect a regression: `git bisect` between two tags
  narrows down which promote-to-main introduced a bug.

**Making a tag** (already inlined above; here as a standalone recipe):

```bash
git checkout main
git tag stable-$(date +%Y%m%d)
# push if there's a remote:
# git push origin stable-$(date +%Y%m%d)
```

**Listing stable snapshots**:

```bash
git tag -l "stable-*" | sort
```

**Checkout the latest stable** (useful when preparing an emergency
build from the last known-good state):

```bash
git checkout $(git tag -l "stable-*" | sort | tail -1)
```

**Compare two stable states** (what changed between two snapshots):

```bash
git log --oneline stable-20260810..stable-20260820
```

The very first tag on this repo is `stable-init`, pointing at the
initial main baseline before any develop-based promote workflow began.

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
