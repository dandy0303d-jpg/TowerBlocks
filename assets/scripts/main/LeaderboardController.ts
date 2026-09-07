/**
 * Leaderboard panel — 前端 UI (scrollable list, up to 500 entries).
 *
 * ============================================================
 *  Design (matches the mockup, now scrollable):
 *    ┌─────────────────────────────────────────────┐
 *    │  [关卡模式]  [无尽模式]  [闭眼模式]         │  ← mode tabs
 *    │                                             │
 *    │              排 行 榜                       │  ← title
 *    │                                             │
 *    │  ┌── ScrollView ────────────────────────┐   │
 *    │  │ [1👑] avatar 玩家昵称xxx    999999   │   │  rank 1 (default top)
 *    │  │ [2🥈] avatar 玩家昵称xxx    876543   │   │
 *    │  │ [3🥉] avatar 玩家昵称xxx    765432   │   │
 *    │  │ ...                                  │   │  ← scroll for more
 *    │  │ [500] avatar 玩家昵称xxx        1    │   │  down to rank 500
 *    │  └──────────────────────────────────────┘   │
 *    │                                             │
 *    │              [↩ 返回]                       │
 *    └─────────────────────────────────────────────┘
 * ============================================================
 *
 * ARCHITECTURE:
 *   - One authored ROW PREFAB (`LeaderboardRow` component on the root)
 *     holds the visual template for a single line.
 *   - The controller reads entries (currently a MOCK of 500), then
 *     instantiates the prefab once per entry and parents it to the
 *     ScrollView's Content node. A Layout component on Content stacks
 *     them vertically.
 *   - `scrollToTop()` on show so the player always sees rank 1 first.
 *   - Row instances are cached across tab switches — we reuse the
 *     same pool and just re-populate, avoiding node churn.
 *
 * INSPECTOR WIRING (build these in the scene, then drag them here):
 *   Panel       — root Node; Widget-stretched to Canvas
 *   Title Label — big "排行榜" text
 *   Back Button — bottom back button
 *   ScrollView  — cc.ScrollView component (vertical)
 *   Content     — the ScrollView's Content Node (should have a
 *                 Layout component: Vertical, Top-to-Bottom,
 *                 Resize Mode = CONTAINER — script does NOT enforce)
 *   Row Prefab  — Prefab of a LeaderboardRow-driven row
 *   Mode Tabs   — 3 Buttons at the top (Level / Endless / Blind)
 *   Avatar Frames — SpriteFrame pool; each row's avatar is picked by
 *                   entry.avatarIdx or (rank - 1) mod pool length
 *
 * Any slot left null is skipped so a partial editor build still boots.
 */

import {
    _decorator,
    Component,
    Node,
    Label,
    Layout,
    Sprite,
    SpriteFrame,
    Button,
    Prefab,
    ScrollView,
    Widget,
    instantiate,
    log,
} from 'cc';

import { t, subscribe as subscribeI18n } from '../core/i18n/I18n';
import { LeaderboardRow } from './LeaderboardRow';
import { BackKeyManager } from './BackKeyManager';
import { getLang, subscribe as subscribeLang } from '../core/i18n/I18n';
import { fetchTop, fetchMyRank, fetchLevelTops, fetchMyLevelTimes, LeaderboardApiEntry, LeaderboardApiMode, LevelTopEntry, MyLevelTimeEntry, MyRankResult } from '../core/LeaderboardApi';
import { PlayerProfile } from '../core/PlayerProfile';

const { ccclass, property } = _decorator;

/** One row's worth of data. */
export interface LeaderboardEntry {
    rank:  number;
    name:  string;
    score: number;
    /** Index into `avatarFrames`. If null, script picks by rank. */
    avatarIdx?: number | null;
    /** True → this is the local player's row (LeaderboardRow toggles
     *  its `youHighlight` node when set). */
    isYou?: boolean;
    /** Optional pre-formatted string that overrides the numeric `score`
     *  when the row painter is looking for a score text. Used by the
     *  level (time) tab to show "MM:SS" instead of raw milliseconds.
     *  When set, `score` still carries the raw ms so any sort /
     *  compare code that reads it stays honest. */
    scoreLabel?: string;
    /** Optional pre-formatted string that overrides the numeric `rank`
     *  in the row's rank Label. Used by the level tab to show
     *  "关卡 1" / "Level 1" instead of a bare "1" — because on that
     *  tab the "rank" column is really a floor identifier, not a
     *  ranking position. */
    rankLabel?: string;
    /** True → suppress the top-3 gold/silver/bronze badge nodes even
     *  when `rank` is 1/2/3. Level tab uses this because its rank
     *  column is the floor number, not a ranking — a trophy on floor
     *  1/2/3 would be misleading. */
    hideBadges?: boolean;
}

/** Which mode's leaderboard is currently showing. */
export type LeaderboardMode = 'level' | 'endless' | 'blind';

/** Hard cap on how many entries we display. Server can return fewer;
 *  we won't try to show more than this even if it returns more. */
const MAX_ENTRIES = 500;

@ccclass('LeaderboardController')
export class LeaderboardController extends Component {

    // ---- Panel root + static UI ----
    @property({ type: Node, tooltip: '排行榜面板根节点（含全屏 dim + 卡片）— 默认 active=false' })
    panel: Node | null = null;

    @property({ type: Label, tooltip: '"排行榜" 标题 Label' })
    titleLabel: Label | null = null;

    @property({ type: Sprite, tooltip: '排行榜面板顶部 Logo Sprite — 脚本会按当前语言 swap spriteFrame（复用 MenuController 里配好的 10 张 logo SF）— 可空' })
    logoSprite: Sprite | null = null;

    @property({ type: Node, tooltip: 'MenuController 所在节点（脚本会拿它的 getLocalizedLogoSpriteFrame 复用 10 张 logo SF）— 可空，不拖则跳过 logo 换图' })
    menuControllerNode: Node | null = null;

    @property({ type: Button, tooltip: '返回按钮（点击 → 隐藏面板回到主菜单）' })
    backButton: Button | null = null;

    // ---- Mode tabs ----
    @property({ type: [Button], tooltip: '3 个模式 Tab 按钮（顺序：关卡 / 无尽 / 闭眼）' })
    modeTabButtons: Button[] = [];

    @property({ type: [Label], tooltip: '3 个 Tab 按钮内部的 Label（可空；空的会自动 getComponentInChildren 找）' })
    modeTabLabels: Label[] = [];

    @property({ type: [Node], tooltip: '3 个 Tab 的"选中"指示节点（可空；有的话脚本会切换 active）' })
    modeTabIndicators: Node[] = [];

    // ---- Scroll list ----
    @property({ type: ScrollView, tooltip: '排行榜 ScrollView（Vertical）' })
    scrollView: ScrollView | null = null;

    @property({ type: Node, tooltip: 'ScrollView 的 Content 节点（挂 Layout: Vertical + TopToBottom + Resize Mode CONTAINER）' })
    content: Node | null = null;

    @property({ type: Prefab, tooltip: '单行 Prefab（预制体上挂 LeaderboardRow 组件，@property 拖对应 Label/Sprite 槽位）' })
    rowPrefab: Prefab | null = null;

    // ---- My-rank fixed row (below the ScrollView) ----
    @property({ type: LeaderboardRow, tooltip: '固定在 ScrollView 下方的"我的排名"行 — 拖场景里挂了 LeaderboardRow 的 Node（不在 ScrollView Content 里，而是同级/下方固定位置）。留空则不显示。' })
    myRankRow: LeaderboardRow | null = null;

    // ---- Assets ----
    @property({ type: [SpriteFrame], tooltip: '头像 SpriteFrame 池；行按索引循环使用。空的话头像保留 Prefab 默认。' })
    avatarFrames: SpriteFrame[] = [];

    // ============================================================
    //  Internal state
    // ============================================================

    /** Currently-selected mode tab. */
    private currentMode: LeaderboardMode = 'endless';

    /** Cached row instances — grown on demand, reused across tab
     *  switches / re-shows. Extra rows past the current data length
     *  get `active = false` so they don't take up scroll space. */
    private rowPool: LeaderboardRow[] = [];

    /** Unsub handle for i18n subscribe. */
    private i18nUnsub: (() => void) | null = null;

    /** True after we've wired click handlers + i18n subscribe. */
    private wired: boolean = false;

    /** Per-mode cache of the latest fetched entries. Used so switching
     *  tabs feels instant on second visit; refreshes each time the
     *  panel opens for the currently-selected mode. */
    private cachedEntries: Partial<Record<LeaderboardMode, LeaderboardEntry[]>> = {};

    /** Per-mode cache of the local player's rank+score. Same instant-
     *  paint story as `cachedEntries`. */
    private cachedMyRank: Partial<Record<LeaderboardMode, MyRankResult>> = {};

    /** Monotonically increasing request id so late-arriving responses
     *  from a fetch we no longer care about (e.g. user tab-switched
     *  before it resolved) don't overwrite fresher data. */
    private lastFetchId: number = 0;

    /** Level tab — cache of the local player's personal-best time for
     *  every level they've cleared. Populated once per level-tab open
     *  via fetchMyLevelTimes(). Key: levelIdx (0-based). Value:
     *  elapsedSec. Missing key = player hasn't cleared that floor. */
    private myLevelTimes: Map<number, number> = new Map();

    /** Level tab — currently-selected stage index (0-based) whose PB
     *  is shown in the bottom my-rank row. Defaults to 0 (Stage 1) on
     *  first open; changes when the player taps a row. */
    private selectedLevelIdx: number = 0;

    // ============================================================
    //  Lifecycle
    // ============================================================

    onLoad(): void {
        // Panel starts hidden regardless of scene state — the menu
        // button is the only way in.
        if (this.panel) this.panel.active = false;
        // Repaint the localized logo on first boot + every language
        // switch. The panel is hidden until the player opens it, so
        // the initial paint just primes the SpriteFrame so it's ready
        // when the panel activates.
        this._refreshLocalizedLogo();
        this._langUnsub = subscribeLang(() => this._refreshLocalizedLogo());
    }

    onDestroy(): void {
        if (this.i18nUnsub) { this.i18nUnsub(); this.i18nUnsub = null; }
        if (this._langUnsub) { this._langUnsub(); this._langUnsub = null; }
    }

    /** Localized logo swap — reuses MenuController's authored 10 SF
     *  slots via its getLocalizedLogoSpriteFrame() accessor. Silent
     *  no-op if either the Sprite slot or the MenuController node
     *  isn't wired. */
    private _langUnsub: (() => void) | null = null;
    private _refreshLocalizedLogo(): void {
        if (!this.logoSprite || !this.menuControllerNode) return;
        const menu = this.menuControllerNode.getComponent('MenuController') as any;
        if (menu && typeof menu.getLocalizedLogoSpriteFrame === 'function') {
            const sf = menu.getLocalizedLogoSpriteFrame(getLang());
            if (sf) this.logoSprite.spriteFrame = sf;
        }
    }

    // ============================================================
    //  Public API
    // ============================================================

    /** Show the leaderboard for `mode` (default: endless). Auto-scrolls
     *  to the top so the player always sees rank 1 first. */
    private _back = (): void => { this.hide(); };
    public show(mode: LeaderboardMode = 'endless'): void {
        if (!this.panel) {
            log('[Leaderboard] panel not wired — cannot show');
            return;
        }
        BackKeyManager.push(this._back);
        log(`[Leaderboard] show(${mode}) — panel=${!!this.panel} content=${!!this.content} scrollView=${!!this.scrollView} rowPrefab=${!!this.rowPrefab}`);
        // Activate the tree BEFORE we instantiate + populate rows.
        // Cocos Layout only recalculates content size when the layout
        // node is active — instantiating rows under an inactive parent
        // would leave `content` at 0×0 until the next tick, and the
        // ScrollView would clip everything. Ordering here fixes the
        // "first click shows an empty list, second click shows rows"
        // symptom.
        this.panel.active = true;
        this.panel.setSiblingIndex(999);
        // Ensure the logo matches the current language every open —
        // covers the case where MenuController's SF slots weren't
        // populated at first-boot onLoad ordering.
        this._refreshLocalizedLogo();
        this.wire();
        this.currentMode = mode;
        this.refresh();
        log(`[Leaderboard] show() done — pool=${this.rowPool.length} content children=${this.content?.children.length ?? '(no content)'}`);
        // All tabs (level, endless, blind) snap to top on open now.
        // Level tab used to defer + auto-scroll to the cleared range
        // when the order was reversed and cleared rows sat at the
        // bottom of the list; with forward ordering, cleared rows are
        // at the TOP, so the default scrollToTop already lands the
        // player on the interesting part.
        if (this.scrollView) this.scrollView.scrollToTop(0);
    }

    public hide(): void {
        if (this.panel) this.panel.active = false;
        BackKeyManager.pop(this._back);
    }

    public isOpen(): boolean {
        return !!this.panel?.active;
    }

    /**
     * Pre-instantiate the 500 row Prefabs during boot so the panel
     * opens instantly when the player taps the leaderboard button. No
     * visual change — we briefly flip `panel.active = true` so Cocos
     * Layout can compute row positions (Layout is skipped on inactive
     * nodes), then restore the previous state. The LoadingPanel dim
     * covers everything during boot, so the momentary activation is
     * invisible.
     *
     * Called by LoadingController from the boot pipeline. Idempotent
     * via the `wired` flag inside `wire()` and via `ensureRowPool`
     * only growing the pool, never shrinking it.
     */
    public preload(): void {
        if (!this.panel) {
            log('[Leaderboard] preload skipped — panel not wired');
            return;
        }
        if (!this.rowPrefab || !this.content) {
            log('[Leaderboard] preload skipped — rowPrefab or content not wired');
            return;
        }
        const wasActive = this.panel.active;
        this.panel.active = true;
        try {
            this.wire();
            // Eagerly build the full 500-row pool + rows hidden until
            // data arrives. This is the whole POINT of preload: pay
            // the node-instantiation + Layout cost during boot, so
            // the panel opens instantly with just a data repaint.
            this.ensureRowPool(MAX_ENTRIES);
            for (const row of this.rowPool) row.node.active = false;
            if (this.content) {
                const layout = this.content.getComponent(Layout);
                if (layout) layout.updateLayout(true);
            }
            // Kick off the data fetch — populates cache when it lands.
            this.refresh();
            log(`[Leaderboard] preload triggered — pool=${this.rowPool.length} content children=${this.content.children.length} (network fetch in-flight)`);
        } catch (err) {
            console.error('[Leaderboard] preload THREW:', err);
        } finally {
            this.panel.active = wasActive;
        }
    }

    // ============================================================
    //  Setup
    // ============================================================

    private wire(): void {
        if (this.wired) return;
        this.wired = true;

        // ---- Static labels (title + back button) ----
        if (this.titleLabel) {
            this.titleLabel.string = t('leaderboard.title');
        }
        if (this.backButton) {
            this.backButton.node.off('click');
            this.backButton.node.on('click', () => this.hide(), this);
            const lab = this.backButton.getComponentInChildren(Label);
            if (lab) lab.string = t('leaderboard.back');
        }

        // ---- Mode tabs ----
        this.wireTabs();

        // Re-translate everything on language change while open;
        // hidden panels get a fresh render at next `show()` anyway.
        this.i18nUnsub = subscribeI18n(() => {
            if (!this.panel?.active) return;
            if (this.titleLabel) this.titleLabel.string = t('leaderboard.title');
            if (this.backButton) {
                const lab = this.backButton.getComponentInChildren(Label);
                if (lab) lab.string = t('leaderboard.back');
            }
            this.retranslateTabs();
            this.refresh();
        });
    }

    /** Kept separate from `wire()` so `retranslateTabs()` can share
     *  the same array walk without duplicating the click bindings. */
    private wireTabs(): void {
        const tabModes: LeaderboardMode[] = ['level', 'endless', 'blind'];
        const tabKeys = ['leaderboard.tab.level', 'leaderboard.tab.endless', 'leaderboard.tab.blind'];
        for (let i = 0; i < this.modeTabButtons.length; i++) {
            const btn = this.modeTabButtons[i];
            if (!btn) continue;
            const mode = tabModes[i];
            if (!mode) continue;
            btn.node.off('click');
            btn.node.on('click', () => this.onTabClick(mode), this);
            const lab = this.modeTabLabels[i] ?? btn.getComponentInChildren(Label);
            if (lab) lab.string = t(tabKeys[i]);
        }
    }

    private retranslateTabs(): void {
        const tabKeys = ['leaderboard.tab.level', 'leaderboard.tab.endless', 'leaderboard.tab.blind'];
        for (let i = 0; i < this.modeTabButtons.length; i++) {
            const btn = this.modeTabButtons[i];
            if (!btn) continue;
            const lab = this.modeTabLabels[i] ?? btn.getComponentInChildren(Label);
            if (lab) lab.string = t(tabKeys[i]);
        }
    }

    private onTabClick(mode: LeaderboardMode): void {
        if (this.currentMode === mode) return;
        this.currentMode = mode;
        this.refresh();
        // Any tab switch resets scroll to top so the player always
        // starts at rank 1 (or Stage 1 on the level tab) for the
        // newly-picked mode.
        if (this.scrollView) this.scrollView.scrollToTop(0);
    }

    // ============================================================
    //  Data + rendering
    // ============================================================

    /** Update tab indicators + trigger a fresh data fetch. Uses the
     *  cached entries (if any) for instant paint, then updates when
     *  the network fetch resolves. Handles tab-switch race conditions
     *  via `lastFetchId`. */
    private refresh(): void {
        // ---- Tab indicators (sync, immediate) ----
        const tabModes: LeaderboardMode[] = ['level', 'endless', 'blind'];
        for (let i = 0; i < this.modeTabIndicators.length; i++) {
            const ind = this.modeTabIndicators[i];
            if (!ind) continue;
            ind.active = tabModes[i] === this.currentMode;
        }

        // ---- Paint cached data immediately so the list isn't empty
        // while the network fetch is in flight (returning users see
        // whatever was there last time). ----
        const cached = this.cachedEntries[this.currentMode];
        if (cached && cached.length > 0) {
            this.paintRows(cached);
        }
        const cachedMy = this.cachedMyRank[this.currentMode];
        if (cachedMy) this.paintMyRankRow(cachedMy);
        else          this.paintMyRankRow({ rank: null, score: null });

        // ---- Kick off a network fetch; paint again when it resolves. ----
        const reqId = ++this.lastFetchId;
        const mode  = this.currentMode;
        this.fetchEntriesAsync(mode)
            .then((entries) => {
                // Stale response — user tab-switched (or fired a fresh
                // refresh) between the fetch starting and resolving.
                if (reqId !== this.lastFetchId) return;
                if (this.currentMode !== mode) return;
                this.cachedEntries[mode] = entries;
                this.paintRows(entries);
            })
            .catch((err) => {
                console.warn(`[Leaderboard] fetch ${mode} failed:`, err.message);
                // Keep whatever was on screen (either the cached data
                // from earlier, or an empty list) — no UI toast for now.
                // TODO(polish): show a "network error, tap to retry" hint.
            });
        // Parallel fetch: local player's own rank + score. Uses the
        // same reqId so a tab-switch mid-flight discards this too.
        //
        // For the LEVEL tab we don't have a single "my rank" (rank is
        // per-floor), so instead we fetch the player's PB for every
        // level they've cleared and paint the my-row for the currently-
        // selected floor. First open defaults to floor 1 (selectedLevelIdx=0);
        // subsequent taps on a scroll row update the selection.
        if (mode === 'level') {
            fetchMyLevelTimes()
                .then((entries) => {
                    if (reqId !== this.lastFetchId) return;
                    if (this.currentMode !== mode) return;
                    this.myLevelTimes.clear();
                    for (const e of entries) this.myLevelTimes.set(e.levelIdx, e.elapsedSec);
                    this.paintLevelMyRankRow();
                })
                .catch((err) => {
                    console.warn(`[Leaderboard] fetchMyLevelTimes failed:`, err.message);
                    // Still paint with whatever we have (probably empty).
                    this.paintLevelMyRankRow();
                });
            // Paint immediately with any prior cache so the row isn't
            // blank while the fetch is in flight.
            this.paintLevelMyRankRow();
            return;
        }
        fetchMyRank(mode)
            .then((r) => {
                if (reqId !== this.lastFetchId) return;
                if (this.currentMode !== mode) return;
                this.cachedMyRank[mode] = r;
                this.paintMyRankRow(r);
            })
            .catch((err) => {
                console.warn(`[Leaderboard] fetchMyRank ${mode} failed:`, err.message);
            });
    }

    /** Fill the fixed "my rank" row below the ScrollView. Shows the
     *  local player's rank + score if they've submitted; falls back to
     *  a "—" placeholder + rank 0 if they haven't scored in this mode
     *  yet. Always keeps the `isYou` highlight on. */
    private paintMyRankRow(result: MyRankResult): void {
        const row = this.myRankRow;
        if (!row) return;
        row.node.active = true;
        const hasRank = result.rank !== null && result.score !== null;
        row.populate({
            rank:  hasRank ? result.rank! : 0,
            name:  PlayerProfile.name,
            score: hasRank ? result.score! : 0,
            isYou: true,
            // Local player's own avatar — read from PlayerProfile
            // instead of the server, so the row updates instantly
            // after a fresh pick without waiting for a re-fetch.
            // Resolves the uuid-hash fallback for guests who haven't
            // explicitly picked, matching what the Settings avatar shows.
            avatarIdx: this.resolveMyAvatarIdx(),
        }, this.avatarFrames);
        // Overwrite the rank / score Labels with placeholder strings
        // when the player hasn't scored in this mode yet — populate()
        // above would have written "0" for both, which reads worse
        // than a plain dash.
        if (!hasRank) {
            if (row.rankLabel)  row.rankLabel.string  = '—';
            if (row.scoreLabel) row.scoreLabel.string = '—';
        }
    }

    /** Resolve the local player's avatar index for row rendering.
     *  Matches the fallback the Settings avatar Sprite uses (uuid
     *  hash → index) when the player hasn't explicitly picked one,
     *  so the "my row" avatar in the leaderboard always agrees with
     *  the avatar shown on the settings panel + throughout the app. */
    private resolveMyAvatarIdx(): number | null {
        const picked = PlayerProfile.avatarIdx;
        if (picked !== null) return picked;
        const frames = this.avatarFrames;
        if (!frames.length) return null;
        const u = PlayerProfile.uuid;
        let h = 0;
        for (let i = 0; i < u.length; i++) h = (h * 31 + u.charCodeAt(i)) | 0;
        return Math.abs(h) % frames.length;
    }

    /** Paint the bottom my-rank row for the LEVEL tab — shows the
     *  local player's PB for `selectedLevelIdx`. Called after a fresh
     *  fetch and after a row-click updates the selection. */
    private paintLevelMyRankRow(): void {
        const row = this.myRankRow;
        if (!row) return;
        row.node.active = true;
        const idx = this.selectedLevelIdx;
        const secs = this.myLevelTimes.get(idx);
        const hasPB = typeof secs === 'number';
        const mm = hasPB ? Math.floor(secs! / 60).toString().padStart(2, '0') : '';
        const ss = hasPB ? (secs! % 60).toString().padStart(2, '0') : '';
        row.populate({
            rank:       idx + 1,
            rankLabel:  t('level.floorName', { n: idx + 1 }),
            name:       PlayerProfile.name,
            score:      hasPB ? secs! : 0,
            scoreLabel: hasPB ? `${mm}:${ss}` : '—',
            avatarIdx:  this.resolveMyAvatarIdx(),
            isYou:      true,
            hideBadges: true,
        }, this.avatarFrames);
    }

    /** Handle a row tap on the LEVEL tab — update the selected floor,
     *  repaint the bottom my-rank row AND the scroll rows so the
     *  selection highlight moves to the tapped row. No-op for other tabs. */
    private onLevelRowClicked(entry: LeaderboardEntry): void {
        if (this.currentMode !== 'level') return;
        // entry.rank is 1-based floor number; convert to 0-based index.
        this.selectedLevelIdx = Math.max(0, entry.rank - 1);
        this.paintLevelMyRankRow();
        // Repaint scroll rows so youHighlight moves to the tapped row.
        // Use the cached entries (they're already loaded — the tap only
        // happens after the fetch resolved and painted rows).
        const cached = this.cachedEntries['level'];
        if (cached) this.paintRows(cached);
    }

    /** Sync paint helper — pool + tail-hide + force Layout. Called
     *  both from the immediate cached-paint path and the async
     *  fetch-resolved path. */
    private paintRows(entries: ReadonlyArray<LeaderboardEntry>): void {
        const n = Math.min(entries.length, MAX_ENTRIES);
        this.ensureRowPool(n);
        // Row click handler — only meaningful for the LEVEL tab; other
        // tabs get a no-op handler so the pooled rows don't retain a
        // stale level-mode click callback across tab switches.
        const isLevel = this.currentMode === 'level';
        const clickHandler: ((e: LeaderboardEntry) => void) | null =
            isLevel
                ? (e) => this.onLevelRowClicked(e)
                : null;
        for (let i = 0; i < this.rowPool.length; i++) {
            const row = this.rowPool[i];
            if (i < n) {
                row.node.active = true;
                row.onClick = clickHandler;
                // Level tab: repurpose the youHighlight to mark the
                // player's CURRENT SELECTION (which floor they tapped),
                // not the "own row" concept — endless/blind still use it
                // for "this is your row" and pass through unchanged.
                let entry = entries[i];
                if (isLevel) {
                    const isSelected = (entry.rank - 1) === this.selectedLevelIdx;
                    if (entry.isYou !== isSelected) {
                        entry = { ...entry, isYou: isSelected };
                    }
                }
                row.populate(entry, this.avatarFrames);
            } else {
                row.node.active = false;
                row.onClick = null;
            }
        }
        // Force the Content Layout to recalculate NOW — see original
        // comment on the "first click shows empty" bug.
        if (this.content) {
            const layout = this.content.getComponent(Layout);
            if (layout) layout.updateLayout(true);
        }
    }

    /** Instantiate additional row Prefab copies until the pool has
     *  at least `n` instances. Newer instances get parented to the
     *  ScrollView Content node so the Layout arranges them. */
    private ensureRowPool(n: number): void {
        if (!this.rowPrefab) {
            if (this.rowPool.length === 0) {
                log('[Leaderboard] rowPrefab not wired — no rows will render');
            }
            return;
        }
        if (!this.content) {
            log('[Leaderboard] content not wired — cannot parent rows');
            return;
        }
        const before = this.rowPool.length;
        while (this.rowPool.length < n) {
            const inst = instantiate(this.rowPrefab);
            inst.parent = this.content;
            inst.layer  = this.content.layer;
            // The row prefab root has a cc.Widget (align: horizontal-center
            // + top) baked in from editor authoring. Left enabled, every
            // instantiated row snaps to that same anchor inside Content,
            // stacking all rows on top of each other and making only the
            // last-painted one visible — this is the "only 1 row shows"
            // bug on the level tab. Disable the Widget on the pooled
            // instance so cc.Layout can position rows freely.
            const w = inst.getComponent(Widget);
            if (w) w.enabled = false;
            const row = inst.getComponent(LeaderboardRow);
            if (!row) {
                // Prefab is missing the component — bail out loudly so
                // the misconfiguration is obvious in the console. Keep
                // the (un-typed) node so we don't loop-instantiate.
                log('[Leaderboard] row prefab missing LeaderboardRow component; aborting pool growth');
                inst.destroy();
                return;
            }
            this.rowPool.push(row);
        }
        const added = this.rowPool.length - before;
        if (added > 0) {
            log(`[Leaderboard] ensureRowPool: spawned ${added} rows (pool now ${this.rowPool.length}, target ${n})`);
        }
    }

    // ============================================================
    //  Data source — real backend via LeaderboardApi.
    // ============================================================

    /**
     * Fetch leaderboard entries for `mode` from the backend and adapt
     * the server-side shape into this component's `LeaderboardEntry`.
     * The server returns [{rank, uuid, name, score}]; we tack on the
     * `isYou` flag by comparing uuid against the local player's UUID.
     *
     * Errors propagate so `refresh()` can catch and decide (currently
     * keeps the cached / empty list).
     */
    private async fetchEntriesAsync(mode: LeaderboardMode): Promise<LeaderboardEntry[]> {
        const myUuid = PlayerProfile.uuid;
        // ---- LEVEL tab: per-level top-1 by fastest time ----
        // fetchLevelTops returns a SPARSE list (levels with no clear yet
        // are omitted). We paint a full 1..N grid so the player sees
        // every floor's slot — filled OR "—" — for a stable at-a-glance
        // read. Rank column carries the floor number (level.order = idx+1
        // by convention for level mode), name/avatar/time from the top-1.
        if (mode === 'level') {
            const tops: LevelTopEntry[] = await fetchLevelTops();
            // Index the sparse response by levelIdx for O(1) row lookup.
            const byIdx = new Map<number, LevelTopEntry>();
            let maxIdx = -1;
            for (const e of tops) {
                byIdx.set(e.levelIdx, e);
                if (e.levelIdx > maxIdx) maxIdx = e.levelIdx;
            }
            // Total-floor count — fall back to 99 (Tetri Tower's authored
            // level count). If a future version bumps flatLevels.length
            // we could route it through here, but a static 99 is fine
            // for now — extra empty rows just render "—".
            const TOTAL_LEVELS = 99;
            const out: LeaderboardEntry[] = [];
            // Iterate LOW → HIGH so the first array item is Stage 1
            // (levelIdx 0) and the last is Stage 99. The scene's
            // Content Layout is Top-To-Bottom
            // (LayoutVerticalDirection.TOP_TO_BOTTOM = 1, matching
            // _verticalDirection: 1 in Game.scene), which places the
            // FIRST child at the top of the container. Result: "관卡 1"
            // at top, "관卡 99" at bottom — natural forward order
            // matching all the other stage-number displays (level
            // select label, fate preview, HUD floor).
            //
            // The `rank` field is the 1-based stage number (idx + 1),
            // used both as the row's rank column AND as the reverse
            // lookup key in onLevelRowClicked (levelIdx = rank - 1).
            for (let idx = 0; idx < TOTAL_LEVELS; idx++) {
                const top = byIdx.get(idx);
                if (top) {
                    const mm = Math.floor(top.elapsedSec / 60).toString().padStart(2, '0');
                    const ss = (top.elapsedSec % 60).toString().padStart(2, '0');
                    out.push({
                        rank:       idx + 1,   // floor number (1..99)
                        rankLabel:  t('level.floorName', { n: idx + 1 }),  // "스테이지 99층" / "Level 99"
                        name:       top.name,
                        score:      top.elapsedSec,     // raw seconds — honest sort field
                        scoreLabel: `${mm}:${ss}`,     // painter-facing display
                        avatarIdx:  top.avatarIdx > 0 ? top.avatarIdx : null,
                        // Level tab: isYou is NOT "you own this row" — it's
                        // "this row is the currently-selected floor". Kept
                        // false here; paintRows applies the selection-based
                        // override at render time.
                        isYou:      false,
                        hideBadges: true,   // no gold/silver/bronze on floor number
                    });
                } else {
                    // No clear yet for this floor — empty placeholder row.
                    // LeaderboardRow paints "—" for empty name / score.
                    out.push({
                        rank:       idx + 1,
                        rankLabel:  t('level.floorName', { n: idx + 1 }),
                        name:       '—',
                        score:      0,
                        scoreLabel: '—',
                        avatarIdx:  null,
                        isYou:      false,
                        hideBadges: true,
                    });
                }
            }
            return out;
        }

        // ---- ENDLESS / BLIND tabs (unchanged): score = height ----
        const apiEntries: LeaderboardApiEntry[] = await fetchTop(mode, MAX_ENTRIES);
        return apiEntries.map((e) => ({
            rank:  e.rank,
            name:  e.name,
            score: e.score,
            // Server returns 0 as the DB DEFAULT for players who never
            // picked. Treat that as "unset" so LeaderboardRow falls
            // back to its rank-cycled variety (visually distinct rows)
            // instead of every default player showing avatar 0.
            avatarIdx: e.avatarIdx > 0 ? e.avatarIdx : null,
            isYou: e.uuid === myUuid,
        }));
    }
}
