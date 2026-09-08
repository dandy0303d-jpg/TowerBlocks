/**
 * LoadingController — sits between the Cocos engine splash and the main
 * menu. Runs a short warmup pipeline (GPU shader compile + texture upload
 * for every FX pool the game will use) while showing a progress overlay
 * to the player. When done, hides itself and hands off to MenuController.
 *
 * Why: on real Android devices, the FIRST time a piece locks / a row
 * clears / a bomb detonates, the GPU driver stalls for a chunk of a
 * second to compile the shader variant + upload textures. This shows
 * up as a hitch in the middle of gameplay. Preparing the pipeline
 * up-front during a "loading" phase moves the cost to a point where
 * the player expects to wait.
 *
 * Wiring (editor):
 *   1. Attach this script to a full-screen overlay Node (typically a
 *      Sprite child of Canvas that covers the whole screen).
 *   2. Fill in `loadingPanel` (the root of the overlay), and OPTIONAL
 *      `progressBar` (a Sprite with Type=FILLED whose fillRange animates
 *      0→1) and `progressLabel` (a Label showing "加载中 X%").
 *   3. Drag the scene's GameController into `gameController`.
 *   4. Drag the scene's MenuController into `menuController`.
 *   5. Set MenuController's `deferMenuShow` @property to true so it
 *      waits for our `beginBoot()` call instead of showing the menu
 *      immediately in start().
 */

import { _decorator, Component, Node, Sprite, Label, sys } from 'cc';
import { GameController } from './GameController';
import { MenuController } from './MenuController';
import { LevelSelectStage3D } from './LevelSelectStage3D';
import { LeaderboardController } from './LeaderboardController';
import { TopUpController } from './TopUpController';
import { LevelProgress } from '../core/LevelProgress';
import { PlayerProfile } from '../core/PlayerProfile';
import { fetchMyLevelTimes } from '../core/LeaderboardApi';
import { t, initFromSystemLang } from '../core/i18n/I18n';
// Channel boot side-effect — registers StoreKitProvider on iOS.
// Module load runs before LoadingController.start(), so Providers.purchase
// is already wired by the time any UI can trigger a buy(). Kept as an
// import (not a call) to hide the platform detail from main code.
import '../channels/apple/AppStoreBoot';
import { AnalyticsApi } from '../core/AnalyticsApi';
import { BUILD_CHANNEL } from '../core/BuildConfig';

const { ccclass, property } = _decorator;

@ccclass('LoadingController')
export class LoadingController extends Component {
    @property({ type: Node, tooltip: 'Loading 覆盖层根节点（全屏 Sprite 之类）' })
    loadingPanel: Node = null!;

    @property({ type: Sprite, tooltip: '进度条 Sprite（组件 Type 设为 FILLED，fillRange 会被脚本改）' })
    progressBar: Sprite | null = null;

    @property({ type: Label, tooltip: '进度百分比 Label（可选）' })
    progressLabel: Label | null = null;

    @property({ type: Label, tooltip: '"加载资源"文字 Label（进度条左侧，可选）。脚本会用 i18n 覆盖里面的字，不拖也没关系。' })
    loadingTextLabel: Label | null = null;

    @property({ type: Sprite, tooltip: 'Loading 页面 Logo Sprite — 脚本会按当前语言 swap spriteFrame（复用 MenuController 里配好的 10 张 logo SF，不需要在这里再拖一遍）— 可空' })
    loadingLogoSprite: Sprite | null = null;

    @property({ type: GameController, tooltip: 'GameController（用它的 warmupFxActivate/Cleanup）' })
    gameController: GameController = null!;

    @property({ type: MenuController, tooltip: 'MenuController（warmup 结束后调它 showModeSelect）' })
    menuController: MenuController = null!;

    @property({ type: LevelSelectStage3D, tooltip: 'LevelSelectStage3D（warmup 时预建 99 层塔，避免首次点关卡模式卡顿）' })
    levelStage3D: LevelSelectStage3D | null = null;

    @property({ type: LeaderboardController, tooltip: 'LeaderboardController（warmup 时预建 500 行 Prefab，避免首次点排行榜卡顿）' })
    leaderboardController: LeaderboardController | null = null;

    @property({ type: TopUpController, tooltip: 'TopUpController（warmup 时 wire label + 提前 fetchWallet 缓存余额，避免首次点充值时余额空一下）' })
    topUpController: TopUpController | null = null;

    /** Number of "let a frame render" gaps between activate and cleanup.
     *  2 frames is usually enough for the GPU driver to compile all
     *  shader variants and upload the textures. Bump if you see a
     *  hitch on the FIRST in-game FX play; drop to 1 if boot feels
     *  slow. */
    @property({ range: [1, 10, 1], slide: true, tooltip: '激活 pool 后等几帧再清理（默认 2）' })
    warmupFrames: number = 2;

    /** Minimum total time (seconds) the loading overlay stays visible,
     *  even if warmup finishes early. Keeps the flash from looking
     *  buggy on fast devices. Set to 0 to disable. */
    @property({ range: [0, 3, 0.1], slide: true, tooltip: 'Loading 覆盖层最少停留时间（秒）' })
    minVisibleSec: number = 0.6;

    onLoad(): void {
        console.log('[Loading] onLoad — showing panel');
        // First-launch auto-detect the game language from the device's
        // system language. Skipped if the player has previously picked
        // one manually (setLang() persists to localStorage, and
        // initFromSystemLang bails out when it sees a prior save).
        // MUST run BEFORE the first `t()` call below.
        const sysCode = sys.languageCode ?? sys.language ?? 'en';
        const picked = initFromSystemLang(sysCode);
        console.log(`[Loading] system lang = "${sysCode}" → game lang = "${picked}"`);
        // Swap the loading-panel logo to the localized art. Reuses the
        // 10 SpriteFrame slots authored on MenuController so we don't
        // need to duplicate them here. Silent no-op if either the
        // MenuController reference or the loading Sprite is unwired.
        if (this.loadingLogoSprite && this.menuController
            && typeof this.menuController.getLocalizedLogoSpriteFrame === 'function') {
            const sf = this.menuController.getLocalizedLogoSpriteFrame(picked);
            if (sf) this.loadingLogoSprite.spriteFrame = sf;
        }
        // Show the loading panel immediately so the frame after Cocos
        // splash doesn't flash the (unwarmed) main menu. Also walk the
        // ancestor chain to force each parent active — guards against
        // the common wiring mistake of leaving a wrapper node (or the
        // panel itself) unchecked in the editor. `panel.active = true`
        // alone won't render if some parent is still inactive.
        if (this.loadingPanel) {
            this.forceAncestorsActive(this.loadingPanel);
            this.loadingPanel.active = true;
        }
        // Overwrite the "加载资源" default text with the current
        // language's version. Loading page never sees a mid-flight
        // language change (it's the first screen and disappears within
        // ~1s), so no subscribe is needed — a one-shot set is enough.
        if (this.loadingTextLabel) this.loadingTextLabel.string = t('loading.text');
        this.setProgress(0);
        this.startDotsAnimation();
        // Force the main gameplay camera on so any FX we activate
        // during warmup actually enters the render pipeline. Without
        // this, if the scene authored mainCamera3D as inactive-until-
        // showModeSelect, the warmup nodes are visible to NO camera
        // and their shaders never compile. LoadingPanel covers the
        // whole screen so the player doesn't see the game render
        // through this camera.
        try {
            const mc: any = this.menuController as any;
            if (mc && mc.mainCamera3D) {
                mc.mainCamera3D.active = true;
                console.log('[Loading] forced mainCamera3D on for warmup render');
            }
        } catch { /* ignore */ }
        // NOTE: HUD hiding is deferred to start() below because
        // HudController.start() (which builds all HUD nodes) hasn't
        // run yet at onLoad time. Calling setHudVisible(false) here
        // would find no nodes to hide.
    }

    start(): void {
        console.log('[Loading] start — scheduling beginBoot');
        // Defer HUD hide to a setTimeout so it fires AFTER every
        // component's start() has finished — HudController.start()
        // builds the HUD nodes we want to hide, and sibling start()
        // ordering is undefined. Calling setHudVisible in-line here
        // could run before HudController.start() → nodes not yet
        // built → nothing to hide → HUD flashes visible during loading.
        setTimeout(() => this.hideHudDuringLoading(), 0);
        // Kick off the boot pipeline on the next frame so every other
        // component's onLoad + start has already run (in particular:
        // GameController.start builds all pools, which we're about to
        // warm up). Use setTimeout instead of scheduleOnce — Cocos's
        // scheduleOnce refuses to re-schedule the same function while
        // an earlier scheduling is still pending, which broke our
        // frame-by-frame tick loop.
        setTimeout(() => this.beginBoot(), 16);
    }

    private hideHudDuringLoading(): void {
        try {
            const mc: any = this.menuController as any;
            const hud: any = mc?.hudController;
            if (hud && typeof hud.setHudVisible === 'function') {
                hud.setHudVisible(false);
                console.log('[Loading] forced HUD off during loading');
            } else {
                console.warn('[Loading] menuController.hudController not resolvable — HUD may flash during load');
            }
        } catch { /* ignore */ }
    }

    /** Boot pipeline: warmup → wait a few frames → cleanup → show menu.
     *  Heavy synchronous work (FX activate + tower prebuild) is split
     *  across THREE frames so the Loading UI has a chance to render
     *  its first frame before we block the main thread with 2000 cube
     *  instantiations. Without this split, Cocos never gets to draw
     *  the loading panel before beginBoot's synchronous work blows
     *  past 500ms — the panel effectively never becomes visible. */
    private beginBoot(): void {
        console.log('[Loading] beginBoot — starting boot pipeline');
        const startTs = performance.now();
        this.setProgress(0.05);

        // ─── Firebase boot: tag channel + kick off Remote Config ────
        // setUserProperty is a one-shot per boot and cheap. Setting it
        // BEFORE we know the uuid is fine — user-property is device-
        // scoped, uuid is set later by PlayerProfile.ensureRegistered.
        // fetchRemoteConfig() is fire-and-forget: values used later
        // in the game come from local cache if the fetch hasn't
        // completed yet, and the fresh values apply on the NEXT boot.
        AnalyticsApi.setUserProperty('channel', BUILD_CHANNEL);
        AnalyticsApi.fetchRemoteConfig();
        AnalyticsApi.breadcrumb('boot start');

        // Frame 1: FX pool warmup (relatively cheap, one node per pool).
        setTimeout(() => this.beginBootFrame2(startTs), 16);
    }

    private beginBootFrame2(startTs: number): void {
        console.log('[Loading] beginBoot frame 2 — FX activate');
        try {
            if (this.gameController) {
                this.gameController.warmupFxActivate();
                console.log('[Loading] warmup activate returned');
            } else {
                console.warn('[Loading] gameController is null — skipping warmup activate');
            }
        } catch (err) {
            console.error('[Loading] warmup activate THREW:', err);
        }
        this.setProgress(0.2);

        // Frame 2: tower prebuild (heavy — ~2000 node instantiations).
        setTimeout(() => this.beginBootFrame3(startTs), 16);
    }

    private beginBootFrame3(startTs: number): void {
        // Auth pipeline runs BEFORE tower prebuild so the tower is
        // built at the RIGHT idx first time — otherwise a re-installed
        // player on level 7 gets a tower prebuilt for level 1, then
        // the collapse+rebuild fires when they tap 关卡模式.
        console.log('[Loading] beginBoot frame 3 — auth + profile fetch → tower prebuild');
        void (async () => {
            try {
                await PlayerProfile.ensureRegistered();
                console.log('[Loading] ensureRegistered done');
            } catch (e) {
                console.warn('[Loading] ensureRegistered failed:', (e as Error).message);
            }
            try {
                const p = await PlayerProfile.fetchProfile();
                // Server-side level progress lives in TWO places, and we
                // need the max of both to hydrate correctly:
                //
                //   1. player.bestScores.level — historically the "highest
                //      cleared level count". Only bumped by endless/blind
                //      submitScore calls; the level-mode submitLevelTime
                //      endpoint writes to the leaderboard table but never
                //      touches this field. So for a level-mode-only
                //      player, bestScores.level stays 0 forever.
                //
                //   2. leaderboard/level-time entries — every per-level
                //      submitLevelTime creates one row per (uuid, level),
                //      keyed by the fastest elapsedSec. The MAX levelIdx
                //      across all my rows IS my true "highest cleared" —
                //      it's the only source of truth for level-mode
                //      progress after a device switch / account recovery.
                //
                // Take the max of both so a player who's cleared level 45
                // via level-mode + reached endless-layer 20 still recovers
                // to level 46 unlocked on a fresh device.
                let serverIdx = (p?.bestScores?.level ?? 0) - 1;   // -1 if server has nothing
                try {
                    const mine = await fetchMyLevelTimes();
                    if (mine.length > 0) {
                        const derivedIdx = mine.reduce(
                            (max, e) => (e.levelIdx > max ? e.levelIdx : max),
                            -1,
                        );
                        if (derivedIdx > serverIdx) {
                            console.log(`[Loading] level-time entries yield higher progress: ${derivedIdx} > bestScores.level-1=${serverIdx}`);
                            serverIdx = derivedIdx;
                        }
                    }
                } catch (e) {
                    console.warn('[Loading] fetchMyLevelTimes failed (progress hydration will fall back to bestScores.level only):', (e as Error).message);
                }
                const localIdx = LevelProgress.maxClearedIdx;
                if (serverIdx > localIdx) {
                    LevelProgress.restoreFrom(serverIdx);
                    console.log(`[Loading] LevelProgress restored ${localIdx} -> ${serverIdx}`);
                }
                console.log(`[Loading] fetchProfile done — bestScores=${JSON.stringify(p?.bestScores)}, effectiveServerIdx=${serverIdx}, localIdx=${localIdx}`);
            } catch (e) {
                console.warn('[Loading] fetchProfile failed:', (e as Error).message);
            }
            // Now prebuild with the correct (server-restored) idx.
            try {
                if (this.levelStage3D) {
                    this.levelStage3D.node.active = true;
                    const startIdx = LevelProgress.currentIdx ?? 0;
                    this.levelStage3D.prebuild(startIdx);
                    console.log(`[Loading] levelStage3D prebuild done (idx=${startIdx})`);
                } else {
                    console.warn('[Loading] levelStage3D is null — skipping tower prebuild');
                }
            } catch (err) {
                console.error('[Loading] levelStage3D prebuild THREW:', err);
            }
            this.setProgress(0.3);
            setTimeout(() => this.beginBootFrame3b(startTs), 16);
        })();
    }

    private beginBootFrame3b(startTs: number): void {
        console.log('[Loading] beginBoot frame 3b — leaderboard preload');
        try {
            if (this.leaderboardController) {
                this.leaderboardController.preload();
                console.log('[Loading] leaderboard preload returned');
            } else {
                console.warn('[Loading] leaderboardController is null — skipping preload');
            }
        } catch (err) {
            console.error('[Loading] leaderboard preload THREW:', err);
        }
        this.setProgress(0.33);
        // Frame 3c: top-up preload — wires labels + primes wallet cache.
        setTimeout(() => this.beginBootFrame3c(startTs), 16);
    }

    private beginBootFrame3c(startTs: number): void {
        console.log('[Loading] beginBoot frame 3c — top-up preload');
        try {
            if (this.topUpController) {
                this.topUpController.preload();
                console.log('[Loading] top-up preload returned');
            } else {
                console.warn('[Loading] topUpController is null — skipping preload');
            }
        } catch (err) {
            console.error('[Loading] top-up preload THREW:', err);
        }
        this.setProgress(0.35);
        // Frame 4: fake row clear — exercises the full row-clear code
        // path (flash + prePulse + shatter burst + line_clear sound)
        // so JIT compiles it, all shaders / materials bind, batching
        // sets up, audio codec decodes. Without this the first REAL
        // clear in gameplay pays all these first-time costs at once.
        setTimeout(() => this.beginBootFrame4(startTs), 16);
    }

    private beginBootFrame4(startTs: number): void {
        console.log('[Loading] beginBoot frame 4 — fake clear');
        try {
            if (this.gameController && typeof (this.gameController as any).warmupFakeClear === 'function') {
                (this.gameController as any).warmupFakeClear();
                console.log('[Loading] fake clear triggered');
            } else {
                console.warn('[Loading] gameController.warmupFakeClear missing');
            }
        } catch (err) {
            console.error('[Loading] warmupFakeClear THREW:', err);
        }
        this.setProgress(0.35);
        this.beginBootWait(startTs);
    }

    private beginBootWait(startTs: number): void {

        // Step 2: wait `warmupFrames` for the GPU driver to actually
        // compile every shader variant. Progress ticks up during the
        // wait so the bar doesn't sit still. (Split out from beginBoot
        // above so the tower-prebuild frame stays isolated.)
        void 0;
        const totalFrames = Math.max(1, this.warmupFrames);
        let waited = 0;
        // Use setTimeout for the tick loop — see the comment in
        // start() for why Cocos's scheduleOnce doesn't work here.
        const tick = (): void => {
            waited++;
            const pct = 0.35 + (waited / totalFrames) * 0.55;
            this.setProgress(pct);
            console.log(`[Loading] tick ${waited}/${totalFrames}`);
            if (waited < totalFrames) {
                setTimeout(tick, 16);
                return;
            }
            // Step 3: cleanup + hand off. Honour minVisibleSec so the
            // loading UI doesn't flash by too fast on strong devices.
            try {
                if (this.gameController) this.gameController.warmupFxCleanup();
                console.log('[Loading] warmup cleanup returned');
            } catch (err) {
                console.error('[Loading] warmup cleanup THREW:', err);
            }
            // Hide the level-select stage — it was left active during
            // warmup so its cubes could render for shader compile.
            // The tower cubes stay instantiated at their target
            // positions; showForLevel() will detect the cache and skip
            // the rebuild.
            if (this.levelStage3D) {
                this.levelStage3D.node.active = false;
            }
            this.setProgress(0.95);

            const elapsed = (performance.now() - startTs) / 1000;
            const remaining = Math.max(0, this.minVisibleSec - elapsed);
            console.log(`[Loading] scheduling finish in ${remaining.toFixed(2)}s`);
            setTimeout(() => this.finish(), remaining * 1000);
        };
        setTimeout(tick, 16);
    }

    private finish(): void {
        console.log('[Loading] finish — hiding panel, handing off to MenuController');
        this.setProgress(1);
        this.stopDotsAnimation();
        if (this.loadingPanel) this.loadingPanel.active = false;
        if (this.menuController && typeof this.menuController.beginBootAfterLoading === 'function') {
            this.menuController.beginBootAfterLoading();
        } else {
            console.warn('[Loading] menuController is null or missing beginBootAfterLoading — main menu will not show');
        }
    }

    /** Last painted percentage — kept so the dots-animation tick can
     *  repaint the label without knowing the current value. */
    private _lastPct: number = 0;
    /** Dots phase: 1, 2, 3 → back to 1. Advanced by the schedule tick
     *  registered in onLoad. */
    private _dotsPhase: number = 1;

    private setProgress(pct: number): void {
        pct = Math.max(0, Math.min(1, pct));
        this._lastPct = pct;
        if (this.progressBar) this.progressBar.fillRange = pct;
        this.paintProgressLabel();
    }

    private paintProgressLabel(): void {
        if (!this.progressLabel) return;
        const pctStr = `${Math.round(this._lastPct * 100)}%`;
        const dots = '.'.repeat(this._dotsPhase);
        this.progressLabel.string = `${pctStr} ${dots}`;
    }

    /** Kick off the "..." cycle. Runs at ~2.5Hz (400ms period). Safe
     *  to call multiple times — schedule is keyed on the callback and
     *  Cocos dedupes. Stopped when the loading panel hides via
     *  unschedule in finish() / hideAccountSwapOverlay(). */
    private startDotsAnimation(): void {
        this.schedule(this._dotsTick, 0.4);
    }
    private stopDotsAnimation(): void {
        this.unschedule(this._dotsTick);
    }
    // Bound as a class field so `this` is preserved AND schedule/
    // unschedule dedupe by identity.
    private _dotsTick = (): void => {
        this._dotsPhase = this._dotsPhase >= 3 ? 1 : this._dotsPhase + 1;
        this.paintProgressLabel();
    };

    /** Show the loading panel as a mid-session overlay — used by the
     *  account-swap flows (delete, bind, recover) so the player sees a
     *  clear "reloading with new data" screen instead of a stale UI
     *  flashing to the new one. This is NOT a full boot: no warmup
     *  pipeline, no scene reload. It just:
     *    1. Shows the loading panel + forces ancestors active
     *    2. Repaints the loading text via i18n (in case the player
     *       switched language between boot and now)
     *    3. Ticks the progress bar to a small non-zero value so the
     *       player sees motion rather than a stuck 0%
     *
     *  Pair with `hideAccountSwapOverlay()`. Safe to call while the
     *  panel is already visible (idempotent).
     */
    public showAccountSwapOverlay(): void {
        console.log('[Loading] showAccountSwapOverlay — panel up for account swap');
        if (!this.loadingPanel) {
            console.warn('[Loading] loadingPanel not wired — account-swap overlay skipped');
            return;
        }
        this.forceAncestorsActive(this.loadingPanel);
        this.loadingPanel.active = true;
        this.loadingPanel.setSiblingIndex(999);
        if (this.loadingTextLabel) this.loadingTextLabel.string = t('loading.text');
        this.setProgress(0.15);
        this.startDotsAnimation();
    }

    /** Hide the account-swap loading overlay. Bumps the progress bar to
     *  100% first so the player sees the fill complete before the panel
     *  disappears. */
    public hideAccountSwapOverlay(): void {
        console.log('[Loading] hideAccountSwapOverlay — dismissing overlay');
        this.setProgress(1);
        this.stopDotsAnimation();
        if (this.loadingPanel) this.loadingPanel.active = false;
    }

    /** Re-build the level-select tower under the loading overlay for
     *  the account that's currently active. The prebuilt tower from
     *  boot points at the OLD account's currentIdx — after an account
     *  swap it's stale, so the first `showForLevel()` from the level
     *  select menu would pay the full ~2000-cube instantiation cost
     *  again. Running the rebuild here (while the loading panel is
     *  visible) hides that hitch inside the intentional loading
     *  transition instead.
     *
     *  Same pattern as beginBootFrame3: activate the stage node briefly
     *  so the GPU renders/uploads the new cubes, then deactivate again
     *  so the level-select panel doesn't see it flash on the main menu
     *  when the overlay hides. Safe to call multiple times — prebuild
     *  is idempotent when the target idx already matches. No-op if the
     *  stage isn't wired.
     */
    public rebuildLevelTowerForCurrentAccount(): void {
        if (!this.levelStage3D) {
            console.warn('[Loading] levelStage3D not wired — tower rebuild skipped');
            return;
        }
        try {
            const idx = LevelProgress.currentIdx ?? 0;
            console.log(`[Loading] rebuilding level tower for currentIdx=${idx}`);
            this.levelStage3D.node.active = true;
            this.levelStage3D.prebuild(idx);
            this.setProgress(0.7);
            // Deactivate again so the tower doesn't linger visible over
            // the main menu after the overlay drops.
            this.levelStage3D.node.active = false;
        } catch (err) {
            console.error('[Loading] tower rebuild THREW:', err);
        }
    }

    /** Walk from `node` up to the scene root and mark every ancestor
     *  `active = true`. Guards against the common editor wiring
     *  mistake of leaving a container node unchecked — a hidden
     *  parent silently swallows the panel even if `panel.active = true`
     *  runs successfully. Idempotent: only touches nodes that are
     *  actually inactive. */
    private forceAncestorsActive(node: Node): void {
        let cur: Node | null = node.parent;
        while (cur) {
            if (!cur.active) cur.active = true;
            cur = cur.parent;
        }
    }
}
