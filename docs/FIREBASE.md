# Firebase — Analytics, Crashlytics, Remote Config

Consent scheme A (default-OFF, opt-in) — data collection stays off until
`ConsentModal` records the player's acceptance.

## What's tracked

Boot-time user properties:
- `channel` (from `BuildConfig.BUILD_CHANNEL`)
- `setUserId(uuid)` on register / stored-token restore

Custom + Firebase-predefined events fired by the game:

| Event | Predefined? | Fired from | Params |
|---|---|---|---|
| `player_register` | custom | `PlayerProfile.ensureRegistered` | `account_type` |
| `login_success` | custom | `PlayerProfile.ensureRegistered` | `method` (register / stored_token) |
| `consent_accepted` | custom | `ConsentModal.onStart` | `tos_version`, `privacy_version`, `marketing_opt_in` |
| `level_start` | Firebase | `GameController.loadLevelByIndex` | `level_name` |
| `level_end` | Firebase | `GameController.onLevelWin` | `level_name`, `success`, `elapsed_sec` |
| `stage_fail` | custom | `GameController.onGameOver` | `mode`, `level`, `reason` |
| `mode_start` / `mode_end` | custom | `GameController.startEndless / startBlind / submitEndlessHeight` | `mode`, `score`, `reason` |
| `begin_checkout` | Firebase | `TopUpController.doPurchase` | `currency`, `value`, `item_id`, `item_name` |
| `purchase` | Firebase | `TopUpController.doPurchase` (success path) | `currency`, `value`, `transaction_id`, `item_id`, `item_name` |
| `purchase_cancelled` / `purchase_failed` | custom | `TopUpController.doPurchase` | `sku`, `reason` |
| `ad_shown` / `ad_dismissed` / `ad_error` | custom | `HudController.onFateFreeRerollClicked` + `GameController.onGameOver` interstitial | `placement`, `reason` |
| `earn_virtual_currency` | Firebase | `HudController.onFateFreeRerollClicked` | `virtual_currency_name`, `value`, `placement` |
| `refresh_used` | custom | `HudController.onFatePaidRefreshClicked / onPickerPaidRefreshClicked` | `kind` (fate/magic), `tier`, `gems_spent`, `balance_after` |

Firebase-predefined events (`purchase`, `level_start/end`, `earn_virtual_currency`)
auto-populate the Revenue / Progression / Virtual Economy reports in
Firebase Console with no extra config.

Crashlytics captures:
- All native / JS uncaught crashes automatically
- Non-fatal errors via `AnalyticsApi.logError(err, context)` — currently
  fires from `PlayerProfile.ensureRegistered` and `TopUpController.doPurchase`

## One-time setup

### 1. Firebase Console
- Create project `TetriTower`
- Add Android app with package name `com.konenine.tetritower`
- Add iOS app with the App Store bundle id
- Download `google-services.json` (Android) and `GoogleService-Info.plist` (iOS)

**Recommended:** one Firebase project shared across all channels
(google_play / app_store / onestore / onestore_beta). The `channel`
user-property lets you slice DAU / retention / revenue per-channel in
the console. Separate projects only if you need airtight data
separation for legal or business reasons.

### 2. Drop config files locally (per developer / CI machine)

**Android** — `google-services.json`:
```
native/engine/android/app/google-services.json
```

**iOS** — `GoogleService-Info.plist`:
```
native/engine/ios/GoogleService-Info.plist
```

Both files are gitignored. Each machine that will build the game for
Firebase needs its own copy. CI pipelines should inject these from a
secret store at build time.

**Missing config file → graceful degradation:**
- Android: `google-services` Gradle plugin skip triggers, `FirebaseApp.initializeApp()`
  returns null, `FirebaseBridge.kt` becomes inert. Game still builds and
  runs; no data reported.
- iOS: `+[FIRApp configure]` guard skips, `FirebaseBridgeGlue` becomes
  inert. Same graceful degradation.

### 3. Verify

**Android:** enable Firebase Debug View to see events in real time:
```
adb shell setprop debug.firebase.analytics.app com.konenine.tetritower
```
Then in Firebase Console: Analytics → DebugView. Boot the game with
consent accepted; you should see `session_start`, `channel` user
property, `login_success`, etc. within ~10 seconds.

**iOS:** enable debug logging via URL scheme argument in Xcode:
```
Product → Scheme → Edit Scheme → Run → Arguments → Arguments Passed On Launch:
   -FIRAnalyticsDebugEnabled
   -FIRDebugEnabled
```

## Consent flow

1. `LoadingController.beginBoot` — sets `channel` user property, kicks off
   `fetchRemoteConfig()` (both are cheap and consent-independent).
2. `PlayerProfile.ensureRegistered` — sets `setUserId(uuid)`, logs
   `player_register` + `login_success`. Events are queued if collection is
   still disabled; Firebase drops them if the player never consents.
3. `MenuController.maybeShowConsentGate`:
   - Consent already OK from prior session → `AnalyticsApi.setEnabled(true)`
   - Consent missing → `ConsentModal` opens → on submit → `setEnabled(true)` +
     `logCustom('consent_accepted', …)`
4. From this point forward, all events flow to Firebase.

To add a separate "data analytics" checkbox in the future (distinct from
the ToS + Privacy checkboxes), wire a new toggle in `ConsentModal.ts` and
key the `setEnabled(true)` call on that toggle's `isChecked`.

## Remote Config

Hello-world setup for now — nothing is actively remote-configured. To use:

1. Firebase Console → Remote Config → Add parameter
2. In game code: `AnalyticsApi.getConfigString('my_key', 'fallback_value')`
   or `getConfigNumber` / `getConfigBool`.
3. Fetches happen at boot (`fetchRemoteConfig()`); values from THIS boot's
   fetch apply on the NEXT boot. First boot always uses the fallback.

Default min fetch interval is 12 hours. To iterate faster during
development, either shorten `minimumFetchIntervalInSeconds` in the native
bridges or use Firebase's "Fetch throttling override" in the console.

## Channel setup per branch

| Branch | `BUILD_CHANNEL` | Android? | iOS? |
|---|---|---|---|
| `develop` | `dev` | yes (dev builds) | no |
| `main` | `main` | yes | no |
| `channel/google-play` | `google_play` | yes | no |
| `channel/app-store` | `app_store` | no | yes |
| `channel/onestore` | `onestore` | yes | no |
| `channel/onestore-beta` | `onestore_beta` | yes | no |

`BuildConfig.ts` is expected to conflict on every merge into a channel
branch (same convention as `IS_DEV_BUILD`) — always keep the target
branch's value.

## Files added

TS (all branches, from `develop`):
- `assets/scripts/core/AnalyticsApi.ts` — TS-side singleton
- Event call sites in `PlayerProfile`, `LoadingController`, `MenuController`,
  `ConsentModal`, `GameController`, `HudController`, `TopUpController`

Android (all branches, from `develop`):
- `native/engine/android/app/src/com/cocos/game/FirebaseBridge.kt`
- `native/engine/android/app/build.gradle` — Firebase BoM + conditional plugin
- `native/engine/android/build.gradle` — Google Services + Crashlytics classpath
- `AppActivity.onCreate` — `FirebaseBridge.install(this)`

iOS (`channel/app-store` only):
- `native/engine/ios/service/FirebaseBridgeGlue.h/.mm`
- `native/engine/ios/Podfile` — Firebase pods
- `native/engine/ios/CMakeLists.txt` — source list

Docs: this file.

## Bumping Firebase versions

Android: change the BoM version in `native/engine/android/app/build.gradle`
(currently `firebase-bom:33.7.0`). All sub-modules stay in lock-step.
Bump the plugin classpaths in `native/engine/android/build.gradle` when
switching to a major BoM release.

iOS: change the pinned versions in `native/engine/ios/Podfile`
(currently `~> 11.6`), then `cd build/ios-release/proj && pod update Firebase`.
