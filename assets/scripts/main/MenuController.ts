import {
    _decorator,
    Component,
    Node,
    Label,
    Sprite,
    SpriteFrame,
    UITransform,
    UIOpacity,
    Color,
    Button,
    Slider,
    Toggle,
    EditBox,
    Graphics,
    Vec3,
    tween,
    director,
    log,
    sys,
    native,
    game,
    instantiate,
} from 'cc';
import { GameController } from './GameController';
import { HudController } from './HudController';
import { ToastManager } from './ToastManager';
import { ensureDimBackdrop } from './UiHelpers';
import { BackgroundController } from './BackgroundController';
import { TowerBaseMist } from './TowerBaseMist';
import { BackgroundCubes } from './BackgroundCubes';
import { TwinkleStars } from './TwinkleStars';
import { LevelSelectStage3D } from './LevelSelectStage3D';
import { LeaderboardController } from './LeaderboardController';
import { BackpackController } from './BackpackController';
import { fetchMyLevelTimes } from '../core/LeaderboardApi';
import { TopUpController } from './TopUpController';
import { EventNewbie14Panel } from './EventNewbie14Panel';
import { EventButtonSparkles } from './EventButtonSparkles';
import { fetchNewbie14Status } from '../core/EventNewbie14Api';
import { BackKeyManager } from './BackKeyManager';
import { PlayerProfile } from '../core/PlayerProfile';
import type { EmbedProp } from '../core/Types';
import { setBannedHandler, getBannedState, setBearerToken, type BannedState } from '../core/Http';
import { fetchWallet, subscribeBalance } from '../core/WalletApi';
import { BACKEND_BASE_URL } from '../core/BackendConfig';
import { TutorialProgress } from '../core/TutorialProgress';
import { TutorialController } from './TutorialController';
import { t, cycleLang, setLang, getLang, subscribe as subscribeLang, SUPPORTED_LANGS, Lang } from '../core/i18n/I18n';
import {
    getBgmVolume,   setBgmVolume,   cycleBgmVolume,
    getSfxVolume,   setSfxVolume,   cycleSfxVolume,
    getHapticMode,  setHapticMode,
    getControlMode, setControlMode, ControlMode,
    getHideDevButtons, toggleHideDevButtons, subscribe as subscribeSettings,
} from '../core/Settings';
import { SoundManager } from '../audio/SoundManager';
import { HapticsManager } from '../audio/HapticsManager';
import { BgmManager } from '../audio/BgmManager';
import { FontManager } from '../core/FontManager';
import { LevelProgress } from '../core/LevelProgress';
import { deletePlayerSelf } from '../core/PlayerApi';
import { IS_DEV_BUILD } from '../core/BuildConfig';
import { AnalyticsApi } from '../core/AnalyticsApi';
import { Providers } from '../core/channels/Providers';
import { fetchReviveCost, purchaseRevive, DEFAULT_REVIVE_COST_GEMS } from '../core/ReviveApi';

// ============================================================
//  Endless-mode revive prompt — knobs
// ============================================================
/** Seconds the revive prompt sits on screen before it auto-dismisses
 *  and hands off to the regular game-over panel. */
const REVIVE_COUNTDOWN_SEC = 10;

/** First level (1-based, matches LevelData.order) at which the pre-game
 *  fate popup swaps from an auto-dismiss preview to an interactive
 *  embed-prop picker (HudController.showFateEmbedPicker). Levels below
 *  this stay on the classic 1-second preview so the early curve isn't
 *  cluttered with prop decisions. */
const EMBED_MIN_LEVEL_ORDER = 16;

/** Every N consecutive levels share the same 本命方块. Bumping this
 *  in tandem with the level-JSON generator keeps the progress bar +
 *  badge accounting in sync. */
const LEVELS_PER_FATE_PIECE = 9;
import { fetchConsentStatus } from '../core/ConsentApi';
import { ConsentModal } from './ConsentModal';
import { GoogleWebOAuth } from '../channels/google/GoogleWebOAuth';
import { linkGoogleToCurrentAccount, loginWithGoogle } from '../core/GoogleLinkApi';

const { ccclass, property } = _decorator;

/**
 * Main-menu controller. Owns:
 *   - Mode-select panel (Endless / Level buttons)
 *   - Level-select panel (one button per JsonAsset in GameController.levels)
 *   - The "back to menu" button shown by HudController inside game play
 *
 * Drag GameController + HudController + the 3D board root into the inspector
 * slots so the menu can show/hide them as players navigate.
 */
@ccclass('MenuController')
export class MenuController extends Component {

    @property(GameController)
    gameController: GameController | null = null;

    @property(HudController)
    hudController: HudController | null = null;

    /** The 3D board parent — hidden while the menu is up. */
    @property(Node)
    boardRoot3D: Node | null = null;

    /** Optional gameplay-scene background renderer. When set, the in‑game
     *  background image (aurora sky / pagoda art) is shown during endless
     *  and level play and hidden on the menu screens. */
    @property(BackgroundController)
    backgroundController: BackgroundController | null = null;

    /** Procedural mist ring rendered around the bottom of the tower
     *  to soften the silhouette against the cosmic-sky background. */
    @property(TowerBaseMist)
    towerBaseMist: TowerBaseMist | null = null;

    /** Ambient ghost cubes drifting in the background behind the
     *  tower — adds depth and a "wider cosmos" feel. */
    @property(BackgroundCubes)
    backgroundCubes: BackgroundCubes | null = null;

    @property({ type: TwinkleStars, tooltip: '关卡选择画面后方的彩色星星（仅在关卡选择显示）' })
    twinkleStars: TwinkleStars | null = null;

    /** New 3D level-select stage. When wired, `showLevelSelect` uses
     *  the 3D tower stack instead of the old 2D scroll list. Leave
     *  blank to fall back to the old UI. */
    @property(LevelSelectStage3D)
    levelStage3D: LevelSelectStage3D | null = null;

    // ================================================================
    //  Fate-piece progress bar + badge case
    //
    //  Every 9 consecutive levels share the same 本命 shape. The
    //  progress row shows how many of those 9 the player has cleared;
    //  finishing all 9 grants a persistent 徽章 (badge). Badges from
    //  every fate piece the player has completed pile up in the badge
    //  case below the progress row.
    //
    //  Progress is derived from LevelProgress.maxClearedIdx — no new
    //  persistence is needed (level clears are strictly linear, so a
    //  group is complete iff its last level index is ≤ maxClearedIdx).
    //
    //  Every field here is optional — leaving them unwired means the
    //  scene simply has no progress bar / badge case. The refresh
    //  method silently no-ops on missing pieces.
    // ================================================================

    @property({ type: Node, tooltip: '关卡选择界面的整个 2D UI 容器 Node（含 back 箭头、9 关进度条、徽章横排、徽章图鉴按钮）。脚本会在进入 level-select 时 setActive(true)、离开时 setActive(false)。留空表示不由脚本控制显隐。' })
    authoredLevelSelectOverlay: Node | null = null;

    @property({ type: Sprite, tooltip: '本命方块 9 关进度条的填充 Sprite（组件 Type = FILLED, FillType = HORIZONTAL, FillStart = 0）。脚本会写 fillRange = clearedInGroup / 9。可空。' })
    authoredFatePieceProgressFill: Sprite | null = null;

    @property({ type: Label, tooltip: '本命方块 9 关进度条右侧的 "X/9" 文字 Label。脚本会写 "3/9" 格式。可空。' })
    authoredFatePieceProgressLabel: Label | null = null;

    @property({ type: Node, tooltip: '徽章横排容器 Node — 完成一整组本命方块 9 关就添加一枚徽章图标到里面。建议挂 Layout（HORIZONTAL）自动排列。留空时徽章展示整体禁用。' })
    authoredBadgesRoot: Node | null = null;

    @property({ type: Node, tooltip: '徽章模板 Node（须是 authoredBadgesRoot 的子节点或独立预制的原型）。首次 refresh 时会被隐藏；每枚展示的徽章都是它的克隆。含一个 Sprite 组件贴徽章图。可空。' })
    authoredBadgeTemplate: Node | null = null;

    @property({ type: [SpriteFrame], tooltip: '徽章图标数组 — 索引 i 对应第 i 组本命方块（第 i*9+1..i*9+9 关）的徽章。留空或长度不够时，落后位置会 fallback 到模板自带的 Sprite。可空。' })
    authoredBadgeIcons: SpriteFrame[] = [];

    @property({ type: Label, tooltip: '"已获得徽章 N 枚" 文字 Label。脚本会写 t("badges.earned", {n}) 并跟随 i18n 切换。可空。' })
    authoredBadgeCountLabel: Label | null = null;

    @property({ type: Number, tooltip: '徽章横排最多显示几枚（超出后要看全部就点右上角的徽章图鉴入口）。默认 5；改成 0 表示不限制。' })
    authoredBadgeInlineMax: number = 5;

    @property({ type: Button, tooltip: '右上角"徽章图鉴"按钮（点击 → 打开完整徽章面板）。目前脚本会 log 一条占位事件；等图鉴面板做好再接。可空。' })
    authoredBadgeCollectionButton: Button | null = null;

    /** Main gameplay camera. Toggled off while the 3D level-select
     *  stage's own camera is rendering, so the two don't fight over
     *  the framebuffer. */
    @property(Node)
    mainCamera3D: Node | null = null;

    /** Duration (seconds) of the "assemble from outside" shot played
     *  after the level loads and before the game actually starts. */
    @property({ range: [0.2, 3, 0.05], slide: true })
    enterAssembleSec: number = 1.2;

    /** Duration (seconds) of the "scatter outward" shot played when
     *  the player clears a level, before we return to level select. */
    @property({ range: [0.2, 3, 0.05], slide: true })
    exitLevelScatterSec: number = 0.9;

    /** When true, `start()` builds the UI but does NOT show the main
     *  menu — it waits for `LoadingController.beginBootAfterLoading()`
     *  to fire after the warmup pipeline finishes. Turn this OFF (or
     *  leave off) in scenes with no LoadingController wired. */
    @property({ tooltip: '开启后 start 不直接显示主菜单，等 LoadingController 通知' })
    deferMenuShow: boolean = false;

    // ------------------------------------------------------------
    //  Mode-select panel — manually authored controls (optional).
    //  Drag a pre-built Node hierarchy into `modeSelectPanel` and
    //  wire the child buttons/labels below to skip the programmatic
    //  buildUi path. Leave any slot empty to fall back to the old
    //  code-generated version for THAT element.
    // ------------------------------------------------------------
    @property({ type: Node, tooltip: '主页面板根节点（不拖=用代码生成）' })
    modeSelectPanel: Node = null!;

    @property({ type: Label, tooltip: '主页标题 Label' })
    modeTitleLabel: Label | null = null;

    @property({ type: Label, tooltip: '主页副标题 Label' })
    modeSubtitleLabel: Label | null = null;

    // ---- 主页 Logo 图（按当前语言切换）----
    @property({ type: Sprite, tooltip: '主页 Logo Sprite（拖场景里的 Sprite 节点进来；脚本会根据当前语言 swap spriteFrame）— 可空' })
    authoredMenuLogoSprite: Sprite | null = null;

    @property({ type: SpriteFrame, tooltip: 'Logo — 简体中文 (zh) 对应 SpriteFrame' })
    logoZh: SpriteFrame | null = null;
    @property({ type: SpriteFrame, tooltip: 'Logo — 繁體中文 (zh-Hant) 对应 SpriteFrame' })
    logoZhHant: SpriteFrame | null = null;
    @property({ type: SpriteFrame, tooltip: 'Logo — English (en) 对应 SpriteFrame' })
    logoEn: SpriteFrame | null = null;
    @property({ type: SpriteFrame, tooltip: 'Logo — 日本語 (ja) 对应 SpriteFrame' })
    logoJa: SpriteFrame | null = null;
    @property({ type: SpriteFrame, tooltip: 'Logo — 한국어 (ko) 对应 SpriteFrame' })
    logoKo: SpriteFrame | null = null;
    @property({ type: SpriteFrame, tooltip: 'Logo — Español (es) 对应 SpriteFrame' })
    logoEs: SpriteFrame | null = null;
    @property({ type: SpriteFrame, tooltip: 'Logo — Français (fr) 对应 SpriteFrame' })
    logoFr: SpriteFrame | null = null;
    @property({ type: SpriteFrame, tooltip: 'Logo — Português (pt-BR) 对应 SpriteFrame' })
    logoPtBR: SpriteFrame | null = null;
    @property({ type: SpriteFrame, tooltip: 'Logo — Deutsch (de) 对应 SpriteFrame' })
    logoDe: SpriteFrame | null = null;
    @property({ type: SpriteFrame, tooltip: 'Logo — Русский (ru) 对应 SpriteFrame' })
    logoRu: SpriteFrame | null = null;

    @property({ type: Button, tooltip: '无尽模式按钮' })
    modeBtnEndless: Button | null = null;

    @property({ type: Button, tooltip: '关卡模式按钮' })
    modeBtnLevel: Button | null = null;

    @property({ type: Button, tooltip: '闭眼模式按钮（看不到塔，只看到落下的方块）' })
    modeBtnBlind: Button | null = null;

    @property({ type: Button, tooltip: '排行榜按钮（占位，尚未接入后端）' })
    modeBtnLeaderboard: Button | null = null;

    // ---- Locked-state (gray) sprites ----
    // Endless button uses label-only graying (unlocks quickly at level 10),
    // so no sprite swap for it. Blind + Leaderboard stay locked until
    // BLIND_UNLOCK_ENDLESS_LAYERS endless layers, so they get authored
    // gray art via these slots.
    @property({ type: SpriteFrame, tooltip: '闭眼模式按钮 — 锁定态灰色图（拖 SpriteFrame 进来；留空则不换图）' })
    authoredBlindLockedSprite: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: '排行榜按钮 — 锁定态灰色图（拖 SpriteFrame 进来；留空则不换图）' })
    authoredLeaderboardLockedSprite: SpriteFrame | null = null;

    // Dedicated "locked" display SpriteFrame for Endless mode. Same
    // pattern as the other locked-art slots. When Endless is still
    // locked (fewer than ENDLESS_UNLOCK_LEVEL_COUNT level clears),
    // script swaps modeBtnEndless's sprite frame to this one; when
    // unlocked, the original is restored.
    @property({ type: SpriteFrame, tooltip: '无尽模式 — 未解锁状态图 SpriteFrame（拖一张灰色/带锁图标的图进来；未解锁时脚本把 modeBtnEndless 的 sprite frame 换成这张，解锁时恢复原图）— 可空' })
    modeBtnEndlessLocked: SpriteFrame | null = null;

    @property({ type: LeaderboardController, tooltip: '排行榜面板控制器（拖场景里挂了 LeaderboardController 的节点进来）' })
    leaderboardController: LeaderboardController | null = null;

    @property({ type: Button, tooltip: '主页面背包按钮（点击打开背包面板）— 可空' })
    modeBtnBackpack: Button | null = null;

    @property({ type: BackpackController, tooltip: '背包面板控制器（拖场景里挂了 BackpackController 的节点进来）。点 modeBtnBackpack 时调 show()；rename_card 使用后跳转到改名弹窗也走这里的 onRenameCardUsed 钩子。' })
    backpackController: BackpackController | null = null;

    @property({ type: TopUpController, tooltip: '充值面板控制器（拖场景里挂了 TopUpController 的节点进来）' })
    topUpController: TopUpController | null = null;

    @property({ type: TutorialController, tooltip: '新手引导控制器（首次进入第 1 关时弹）— 拖场景里挂了 TutorialController 的节点进来；不拖就直接跳过' })
    tutorialController: TutorialController | null = null;

    @property({ type: Button, tooltip: '重置进度按钮（DEV）' })
    modeBtnResetProgress: Button | null = null;

    @property({ type: Button, tooltip: '解锁所有模式按钮（DEV 专用；一键把关卡通过数拉到 10 + 无尽最高层数拉到 100，让 Endless / Blind / Leaderboard 全部亮起来。发布版本自动隐藏。）' })
    modeBtnDebugUnlockAll: Button | null = null;

    @property({ type: Button, tooltip: '主页面充值按钮（钻石余额 + 点击弹出充值面板）— 可空' })
    modeBtnTopup: Button | null = null;

    @property({ type: Label, tooltip: '主页面充值按钮上的余额 Label（脚本会写"钻石数字"）— 可空，会自动从按钮子节点找' })
    modeBtnTopupBalanceLabel: Label | null = null;

    // ---- Progressive unlock system ----
    /** Cached endless-mode best cumulative layers. Restored from
     *  localStorage on boot, updated from server bestScores + after
     *  each endless run. Used to gate the Blind mode + Leaderboard
     *  buttons (unlock at 100 layers). */
    private _endlessBestLayers: number = 0;
    /** localStorage key for the endless-best cache. Layers count is
     *  server-authoritative; this local copy just prevents flashes
     *  of the locked state on first frame after boot / reinstall. */
    private static readonly ENDLESS_BEST_KEY = 'cb.endlessBestLayers';
    /** Number of Level-mode clears needed to unlock Endless mode. */
    private static readonly ENDLESS_UNLOCK_LEVEL_COUNT = 10;
    /** Endless best-height needed to unlock Blind mode + Leaderboard.
     *  Both gates share this single threshold — bumping / lowering it
     *  moves both unlocks together, and the `lock.blind` / `lock.leaderboard`
     *  i18n strings both template on `{n}` so the toast text follows
     *  the constant without touching translations. */
    private static readonly BLIND_UNLOCK_ENDLESS_LAYERS = 50;

    @property({ type: Button, tooltip: '设置按钮' })
    modeBtnSettings: Button | null = null;

    // ============================================================
    //  Authored 关卡失败 / 游戏结束 弹窗
    //  Drag scene nodes here; script updates title/subtitle text,
    //  wires up to 3 button clicks, hides unused buttons.
    // ============================================================

    @property({ type: Node, tooltip: '失败/结束弹窗根节点（含 dim 遮罩 + 卡片）— 默认 active=false' })
    authoredResultPanel: Node | null = null;

    @property({ type: Label, tooltip: '标题 Label（脚本写 "关卡失败" / "游戏结束"）' })
    authoredResultTitleLabel: Label | null = null;

    @property({ type: Label, tooltip: '副标题 Label（脚本写失败原因，比如 "漏洞被封死"）' })
    authoredResultSubtitleLabel: Label | null = null;

    @property({ type: Label, tooltip: '统计 Label（无尽模式显示"层高 N"；关卡模式脚本会清空）' })
    authoredResultSummaryLabel: Label | null = null;

    @property({ type: [Button], tooltip: '按钮组（最多 3 个：关卡失败=重试/选关/主页；无尽=再来一局/主页；不够的自动 setActive(false)）' })
    authoredResultButtons: Button[] = [];

    @property({ type: [Label], tooltip: '按钮上的 Label（跟上面 Button 数组一一对应，脚本写按钮文字）' })
    authoredResultButtonLabels: Label[] = [];

    // ============================================================
    //  Authored 设置弹窗
    //  3 rows in FIXED order — [0]=lang, [1]=bgm, [2]=sfx.
    //  Script cycles the setting on click and writes the new value
    //  into the paired Label.
    // ============================================================

    @property({ type: Node, tooltip: '设置弹窗根节点（含 dim 遮罩 + 卡片，默认 active=false）' })
    authoredSettingsPanel: Node | null = null;

    @property({ type: Button, tooltip: '关闭按钮（点击 → 隐藏面板）' })
    authoredSettingsCloseButton: Button | null = null;

    @property({ type: Button, tooltip: '余额按钮（显示钻石数；点击关闭设置弹充值面板）— 可空' })
    authoredSettingsBalanceButton: Button | null = null;

    @property({ type: Label, tooltip: '余额按钮上的 Label（脚本会写"宝石: N"）— 可空，会自动从按钮子节点找' })
    authoredSettingsBalanceLabel: Label | null = null;

    @property({ type: [Button], tooltip: '3 个设置行的可点击按钮（顺序：语言 / BGM / SFX）。BGM/SFX 现在用滑块，只需要给语言拖第 0 个即可，1/2 可空。' })
    authoredSettingsRowButtons: Button[] = [];

    @property({ type: [Label], tooltip: '3 个设置行的左侧文字 Label（"语言" / "背景音乐" / "音效"）。脚本会用 i18n 覆盖，避免场景里 authored 的中文残留。顺序：语言 / BGM / SFX。可空——空的行就保留场景里的字。' })
    authoredSettingsRowLeftLabels: Label[] = [];

    @property({ type: [Label], tooltip: '3 个设置行的当前值 Label（顺序：语言 / BGM% / SFX%）。滑块拖动时也会刷新对应 Label。' })
    authoredSettingsRowValueLabels: Label[] = [];

    @property({ type: Slider, tooltip: 'BGM 音量滑块（progress 0..1）。拖动 → 实时写入 BgmManager + 存档。' })
    authoredSettingsBgmSlider: Slider | null = null;

    @property({ type: Sprite, tooltip: 'BGM 滑轨的填充 Sprite（可选，Type=FILLED, FillType=HORIZONTAL, FillStart=0）。拖进来 → fillRange 会自动跟 slider.progress 同步。' })
    authoredSettingsBgmFill: Sprite | null = null;

    @property({ type: Slider, tooltip: 'SFX 音量滑块（progress 0..1）。拖动 → 实时写入 SoundManager + 存档 + 播放试听音（可选）。' })
    authoredSettingsSfxSlider: Slider | null = null;

    @property({ type: Sprite, tooltip: 'SFX 滑轨的填充 Sprite（可选，Type=FILLED, FillType=HORIZONTAL, FillStart=0）。拖进来 → fillRange 会自动跟 slider.progress 同步。' })
    authoredSettingsSfxFill: Sprite | null = null;

    // ---- 玩家资料区（头像 / 昵称 / 账号类型）----
    @property({ type: Button, tooltip: '头像按钮（视觉占位；点击后暂时空跑，日后可拉起换头像流程）— 可空' })
    authoredSettingsAvatarButton: Button | null = null;

    @property({ type: EditBox, tooltip: '【已废弃，被 Button + Label 组合替代】旧的昵称输入框（EditBox 就地编辑）。留着字段是为了老场景兼容——新场景应该拖 authoredSettingsNicknameButton + authoredSettingsNicknameLabel，不用拖这个。' })
    authoredSettingsNicknameEditBox: EditBox | null = null;

    @property({ type: Label, tooltip: '昵称显示 Label（只读，展示 PlayerProfile.name；点旁边的"改昵称"按钮 → 弹输入弹窗）— 可空' })
    authoredSettingsNicknameLabel: Label | null = null;

    @property({ type: Button, tooltip: '"改昵称"按钮（点击 → 弹通用输入弹窗；确认 → PlayerProfile.setName + 刷新 Label）— 可空' })
    authoredSettingsNicknameButton: Button | null = null;

    @property({ type: Label, tooltip: '当前登录账号信息 Label（脚本写"游客 · <uuid> 📋"格式，包含账号类型 + 玩家 UUID + 复制图标）— 可空' })
    authoredSettingsAccountTypeLabel: Label | null = null;

    @property({ type: Button, tooltip: '账号信息 Button（点击复制昵称 + UUID 到剪贴板；用于客服/申诉时快速提供账号 ID）— 可空。拖你截图里那个 account 行的 Button' })
    authoredSettingsAccountButton: Button | null = null;

    // ---- 已绑定账号按钮（未绑定 / 已绑定 用两张不同 SpriteFrame）----
    // 未绑定 = 灰色版按钮；已绑定 = 绿色版按钮。脚本根据当前
    // PlayerProfile.accountType 自动 swap 按钮的 Sprite spriteFrame。
    @property({ type: Button, tooltip: '谷歌账号绑定按钮（脚本会按当前绑定状态 swap Sprite）— 可空' })
    authoredSettingsGoogleButton: Button | null = null;

    @property({ type: SpriteFrame, tooltip: '谷歌 — 未绑定状态图（灰色）' })
    googleUnboundSprite: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: '谷歌 — 已绑定状态图（绿色）' })
    googleBoundSprite: SpriteFrame | null = null;

    @property({ type: Button, tooltip: '苹果账号绑定按钮（脚本会按当前绑定状态 swap Sprite）— 可空' })
    authoredSettingsAppleButton: Button | null = null;

    @property({ type: SpriteFrame, tooltip: '苹果 — 未绑定状态图（灰色）' })
    appleUnboundSprite: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: '苹果 — 已绑定状态图（绿色）' })
    appleBoundSprite: SpriteFrame | null = null;

    // ---- 新手 14 天活动 ----
    // 主页面右上/角落的活动入口按钮 —— 服务端返回 active=false 时，
    // 脚本会把整个按钮节点 active=false 隐藏（例如玩家过了 14 天）。
    // 弹窗根节点上必须挂 EventNewbie14Panel 组件；点击按钮时脚本调
    // eventNewbie14Panel.show()，弹窗内部自己拉状态、刷新、领取。
    @property({ type: Button, tooltip: '主页面"新手 14 天活动"入口按钮 — 服务端说过期就自动隐藏。可空。' })
    authoredEventNewbie14Button: Button | null = null;

    @property({ type: EventNewbie14Panel, tooltip: '"新手 14 天活动"弹窗组件（挂在弹窗根节点上）— 可空，未拖时按钮永远不显示。' })
    authoredEventNewbie14Panel: EventNewbie14Panel | null = null;

    @property({ type: Sprite, tooltip: '"今日可领"红点提示 Sprite — 挂在活动按钮右上角。服务端说 canClaimToday=true 时脚本自动显示，已领/过期自动隐藏。可空。' })
    authoredEventNewbie14RedDot: Sprite | null = null;

    // ---- 兼容旧场景的 Toggle 版本（不再主动使用，可以留空）----
    @property({ type: Toggle, tooltip: '（已废弃）谷歌已绑定开关 — 请改用 authoredSettingsGoogleButton' })
    authoredSettingsGoogleToggle: Toggle | null = null;

    @property({ type: Toggle, tooltip: '（已废弃）苹果已绑定开关 — 请改用 authoredSettingsAppleButton' })
    authoredSettingsAppleToggle: Toggle | null = null;

    // ---- 触觉反馈开关 ----
    @property({ type: Toggle, tooltip: '震动开关（跨平台触觉反馈，isChecked = 开）— 可空，未拖场景 Toggle 时默认永远开启' })
    authoredSettingsHapticToggle: Toggle | null = null;

    @property({ type: Label, tooltip: '震动行左侧的"手机震动" i18n 标签（走 settings.haptic）— 可空' })
    authoredSettingsHapticLabel: Label | null = null;

    // ---- 隐藏 DEV 按钮开关（仅 develop 分支可见）----
    @property({ type: Toggle, tooltip: '"隐藏 DEV 按钮"开关（仅 develop 分支生效；isChecked = 隐藏加速/重置/解锁三个 DEV 按钮）。行整行会在非-DEV 构建中自动 setActive(false)。可空。' })
    authoredSettingsHideDevToggle: Toggle | null = null;

    @property({ type: Label, tooltip: '"隐藏 DEV 按钮"行左侧的 i18n 标签（走 settings.hideDev）— 可空' })
    authoredSettingsHideDevLabel: Label | null = null;

    @property({ type: Node, tooltip: '"隐藏 DEV 按钮"整行容器 Node（脚本在非-DEV 构建里 setActive(false) 让玩家看不到）— 可空，未拖时脚本只能通过 Toggle/Label 各自 setActive' })
    authoredSettingsHideDevRow: Node | null = null;

    // ---- 新版设置界面的其它 i18n 标签 ----
    @property({ type: Label, tooltip: '设置面板主标题 Label（走 settings.title）— 可空' })
    authoredSettingsTitleLabel: Label | null = null;

    @property({ type: Label, tooltip: '昵称行的"昵称" i18n 表头 Label（走 settings.nickname）— 可空。注意：这不是显示玩家昵称的 Label，那个是 authoredSettingsNicknameLabel。' })
    authoredSettingsNicknameHeaderLabel: Label | null = null;

    @property({ type: Label, tooltip: '昵称冷却状态 Label — 常态显示"距下次可修改还有 N 天"，冷却结束显示"现在可以修改"，服务端还没返回时整个 Node 隐藏。可空。' })
    authoredSettingsNicknameCooldownLabel: Label | null = null;

    @property({ type: Label, tooltip: '音量行左侧的"音乐大小" i18n 标签（走 settings.volume）— 可空' })
    authoredSettingsVolumeLabel: Label | null = null;

    @property({ type: Label, tooltip: '"账号与数据"分组标题 Label（走 settings.accountData）— 可空' })
    authoredSettingsAccountDataLabel: Label | null = null;

    @property({ type: Label, tooltip: '"谷歌账号" i18n 标签（走 settings.googleAccount）— 可空' })
    authoredSettingsGoogleAccountLabel: Label | null = null;

    @property({ type: Label, tooltip: '"苹果账号" i18n 标签（走 settings.appleAccount）— 可空' })
    authoredSettingsAppleAccountLabel: Label | null = null;

    @property({ type: Label, tooltip: '谷歌按钮上"未绑定/已绑定"文字 Label（走 settings.notBound 或空值）— 可空' })
    authoredSettingsGoogleStatusLabel: Label | null = null;

    @property({ type: Label, tooltip: '苹果按钮上"未绑定/已绑定"文字 Label（走 settings.notBound 或空值）— 可空' })
    authoredSettingsAppleStatusLabel: Label | null = null;

    // ---- 语言选择上拉框（10 个按钮 + 选中覆盖 Node）----
    // 点设置面板的语言行 → 从底部滑出 authoredLangPickerPanel。
    // 每个 authoredLangPickerButtons[i] 对应 SUPPORTED_LANGS[i] 的语言。
    // 语言顺序：zh / zh-Hant / en / ja / ko / es / pt-BR / fr / de / ru
    @property({ type: Node, tooltip: '语言选择上拉框面板根节点（含 10 个语言按钮 + 关闭按钮；默认 active=false）— 可空' })
    authoredLangPickerPanel: Node | null = null;

    @property({ type: [Button], tooltip: '10 个语言按钮（按 zh / zh-Hant / en / ja / ko / es / pt-BR / fr / de / ru 顺序拖入）' })
    authoredLangPickerButtons: Button[] = [];

    @property({ type: [Label], tooltip: '10 个语言按钮内部 Label（同顺序）— 选中时脚本会把 Label.color 改成绿色，其他改回白色' })
    authoredLangPickerLabels: Label[] = [];

    @property({ type: [Node], tooltip: '10 个语言按钮尾部的"对号"图标 Node（同顺序）— 选中时脚本把它 active=true，其他 active=false' })
    authoredLangPickerCheckmarks: Node[] = [];

    @property({ type: Button, tooltip: '语言面板关闭按钮 — 可空（不拖也可以点面板外的 dim 关闭，如果背景挂了 Button）' })
    authoredLangPickerCloseButton: Button | null = null;

    // ---- 操作方式：设置面板行内三按钮（无弹窗）----
    // 3 个操作方式对应 3 个 Button + 3 个半透明"选中框"覆盖 Node。
    // 点击 Button → setControlMode 更新持久化 + 同步显示。
    // 选中的按钮上叠加 Selected 覆盖 Node（半透明 sprite），其他 2 个覆盖 Node 隐藏。
    @property({ type: Button, tooltip: '"操作方式"分组的行标签按钮（可选：一般是纯 Label，不用点击）。可空' })
    authoredSettingsControlsButton: Button | null = null;

    @property({ type: Label, tooltip: '"操作方式"分组的行标签 Label（走 i18n settings.controls）。可空' })
    authoredSettingsControlsLabel: Label | null = null;

    @property({ type: Button, tooltip: '操作方式 — 经典模式按钮（虚拟按钮 = buttons 模式）' })
    authoredControlsClassicButton: Button | null = null;

    @property({ type: Node, tooltip: '经典模式按钮的"选中"覆盖 Node（半透明选中框，被选中时显示）' })
    authoredControlsClassicSelected: Node | null = null;

    @property({ type: Label, tooltip: '经典模式按钮 Label（走 i18n controls.classic）' })
    authoredControlsClassicLabel: Label | null = null;

    @property({ type: Button, tooltip: '操作方式 — 进阶模式按钮（滑动屏幕按住连续旋转 = legacy 模式）' })
    authoredControlsAdvancedButton: Button | null = null;

    @property({ type: Node, tooltip: '进阶模式按钮的"选中"覆盖 Node（半透明选中框）' })
    authoredControlsAdvancedSelected: Node | null = null;

    @property({ type: Label, tooltip: '进阶模式按钮 Label（走 i18n controls.advanced）' })
    authoredControlsAdvancedLabel: Label | null = null;

    @property({ type: Button, tooltip: '操作方式 — 高手模式按钮（惯性旋转 = dragFling 模式）' })
    authoredControlsExpertButton: Button | null = null;

    @property({ type: Node, tooltip: '高手模式按钮的"选中"覆盖 Node（半透明选中框）' })
    authoredControlsExpertSelected: Node | null = null;

    @property({ type: Label, tooltip: '高手模式按钮 Label（走 i18n controls.expert）' })
    authoredControlsExpertLabel: Label | null = null;

    // ---- 兼容旧场景的弹窗方案（可以留空，不再主动使用）----

    @property({ type: Node, tooltip: '操作方式选择弹窗根节点（含 dim 遮罩 + 卡片 + 3 个 Toggle + 关闭按钮，默认 active=false）— 可空' })
    authoredControlsPanel: Node | null = null;

    @property({ type: Label, tooltip: '操作方式弹窗标题 Label（走 i18n controls.title）— 可空' })
    authoredControlsTitleLabel: Label | null = null;

    @property({ type: Toggle, tooltip: '操作方式弹窗中的"经典模式" Toggle — 可空' })
    authoredControlsLegacyToggle: Toggle | null = null;

    @property({ type: Label, tooltip: '"经典模式"行 Label（走 i18n controls.legacy）— 可空' })
    authoredControlsLegacyLabel: Label | null = null;

    @property({ type: Toggle, tooltip: '操作方式弹窗中的"拖动+惯性" Toggle — 可空' })
    authoredControlsDragFlingToggle: Toggle | null = null;

    @property({ type: Label, tooltip: '"拖动+惯性"行 Label（走 i18n controls.dragFling）— 可空' })
    authoredControlsDragFlingLabel: Label | null = null;

    @property({ type: Toggle, tooltip: '操作方式弹窗中的"按钮模式" Toggle — 可空' })
    authoredControlsButtonsToggle: Toggle | null = null;

    @property({ type: Label, tooltip: '"按钮模式"行 Label（走 i18n controls.buttons）— 可空' })
    authoredControlsButtonsLabel: Label | null = null;

    @property({ type: Button, tooltip: '操作方式弹窗关闭按钮 — 可空' })
    authoredControlsCloseButton: Button | null = null;

    // ---- 钻石不足弹窗 ----
    @property({ type: Node, tooltip: '"钻石不足"弹窗根节点（含 dim + 卡片 + 消息 + 去充值/取消 两个按钮）— 默认 active=false' })
    authoredInsufficientGemsPanel: Node | null = null;

    @property({ type: Label, tooltip: '"钻石不足"弹窗内的信息 Label（脚本会写 "需要 N 钻石，当前 M"）— 可空' })
    authoredInsufficientGemsLabel: Label | null = null;

    @property({ type: Button, tooltip: '"钻石不足"弹窗内的"去充值"按钮（点击 → 关闭弹窗 + 打开充值面板）— 可空' })
    authoredInsufficientGemsTopUpButton: Button | null = null;

    @property({ type: Button, tooltip: '"钻石不足"弹窗内的"取消"按钮（点击 → 关闭弹窗）— 可空' })
    authoredInsufficientGemsCancelButton: Button | null = null;

    // ---- 用户协议同意弹窗（韩国 PIPA 合规必需）----
    @property({ type: Node, tooltip: '同意弹窗根节点（挂 ConsentModal 组件）— 默认 active=false。留空则跳过合规 gate（App Store 前必须填）' })
    consentModalNode: Node | null = null;

    // ---- 通用确认弹窗（供 SIWA 恢复、删除账号、其他需要"你确定吗"确认的场景复用）----
    @property({ type: Node, tooltip: '通用确认弹窗根节点（含 dim + 卡片 + 标题 + 消息 + 确认/取消 两个按钮）— 默认 active=false' })
    authoredConfirmModal: Node | null = null;

    @property({ type: Label, tooltip: '通用确认弹窗标题 Label（脚本填 i18n 文本）— 可空' })
    authoredConfirmModalTitle: Label | null = null;

    @property({ type: Label, tooltip: '通用确认弹窗消息 Label（脚本填 i18n 文本，可含 \\n 换行）— 可空' })
    authoredConfirmModalMessage: Label | null = null;

    @property({ type: Button, tooltip: '通用确认弹窗"确认"按钮（主按钮，蓝/主题色）— 脚本 wire 点击关弹窗+resolve true' })
    authoredConfirmModalConfirmButton: Button | null = null;

    @property({ type: Button, tooltip: '通用确认弹窗"取消"按钮（次按钮，灰色）— 脚本 wire 点击关弹窗+resolve false' })
    authoredConfirmModalCancelButton: Button | null = null;

    // ---- 通用输入弹窗（改昵称、输兑换码、任何需要"标题 + 输入框 + 确认/取消"的场景）----
    @property({ type: Node, tooltip: '通用输入弹窗根节点（含 dim + 卡片 + 标题 + EditBox + 确认/取消 两个按钮）— 默认 active=false' })
    authoredPromptModal: Node | null = null;

    @property({ type: Label, tooltip: '通用输入弹窗标题 Label（脚本填 i18n 文本）— 可空' })
    authoredPromptModalTitle: Label | null = null;

    @property({ type: EditBox, tooltip: '通用输入弹窗内的 EditBox（脚本会 setString + 设 maxLength + 主动 focus 弹键盘）' })
    authoredPromptModalInput: EditBox | null = null;

    @property({ type: Button, tooltip: '通用输入弹窗"确认"按钮（主按钮）— 脚本 wire 点击关弹窗+resolve 输入内容' })
    authoredPromptModalConfirmButton: Button | null = null;

    @property({ type: Button, tooltip: '通用输入弹窗"取消"按钮（次按钮）— 脚本 wire 点击关弹窗+resolve null' })
    authoredPromptModalCancelButton: Button | null = null;

    // ---- 通用 Toast（设置面板内错误提示，例如昵称超长）----
    @property({ type: Node, tooltip: '设置面板通用 Toast 根节点（含背景 + 内部 Label；默认 active=false；脚本会 tween 淡入淡出）— 可空' })
    authoredSettingsToastNode: Node | null = null;

    @property({ type: Label, tooltip: 'Toast 内部 Label（脚本写内容；可空，会自动从 Toast 节点里找）— 可空' })
    authoredSettingsToastLabel: Label | null = null;

    // ---- 解锁提示 Toast（点击"无尽/闭眼/排行榜"锁定按钮时弹出）----
    @property({ type: Node, tooltip: '解锁提示 Toast 根节点（含背景 + 内部 Label；默认 active=false；脚本会 tween 淡入淡出）— 可空。留空则自动生成一个简易 toast' })
    authoredLockToastNode: Node | null = null;

    @property({ type: Label, tooltip: '解锁 Toast 内部 Label（脚本写内容；可空，会自动从 Toast 节点里找）— 可空' })
    authoredLockToastLabel: Label | null = null;

    @property({ type: Button, tooltip: '"服务条款 / Terms of Service" 按钮 — 点击 → 用系统浏览器打开服务器 /legal/tos 页面。可空' })
    authoredSettingsTosButton: Button | null = null;

    @property({ type: Button, tooltip: '"隐私政策 / Privacy Policy" 按钮 — 点击 → 用系统浏览器打开服务器 /legal/privacy 页面。可空' })
    authoredSettingsPrivacyButton: Button | null = null;

    @property({ type: Button, tooltip: '"删除账号" 按钮（App Store 5.1.1(v) 强制要求）— 点击 → 弹通用确认弹窗 → 确认后 DELETE /player/self + 清本地状态 + 重置为游客。可空但会导致过审失败。' })
    authoredSettingsDeleteAccountButton: Button | null = null;

    // ---- 头像选择弹窗 ----
    @property({ type: Sprite, tooltip: '设置面板里"头像按钮"内的 Sprite（脚本会写玩家当前选中头像 SpriteFrame；不拖也能用，会 getComponentInChildren 找）— 可空' })
    authoredSettingsAvatarSprite: Sprite | null = null;

    @property({ type: Node, tooltip: '选头像弹窗根节点（含 dim 遮罩 + 卡片 + 头像格子；默认 active=false）— 可空' })
    authoredAvatarPickerPanel: Node | null = null;

    @property({ type: Button, tooltip: '选头像弹窗的关闭按钮（点击 → 隐藏面板）— 可空，也可让 dim 底 dismiss' })
    authoredAvatarPickerCloseButton: Button | null = null;

    @property({ type: [Button], tooltip: '选头像弹窗内的头像按钮数组，每个按钮代表一个可选头像；点击 → 保存到 PlayerProfile.setAvatarIdx(i)，同步刷新设置面板头像。数量 = 想给玩家的选择数，可以少于 avatar 池长度。' })
    authoredAvatarPickerButtons: Button[] = [];

    @property({ type: [SpriteFrame], tooltip: '头像 SpriteFrame 池（顺序对应 avatarIdx）。设置面板 + 排行榜自己 + 头像选择弹窗都从这里取图。' })
    authoredAvatarFrames: SpriteFrame[] = [];

    private resultPanel:       Node | null = null;

    /** Labels that carry an i18n key — re-translated whenever the
     *  language changes. The `params` form lets us re-interpolate
     *  dynamic values (level number etc.) on refresh. */
    private i18nLabels: Array<{ label: Label; key: string; params?: Record<string, string | number> }> = [];
    /** Unsubscribe handle for the i18n change listener (cleared in onDestroy). */
    private langUnsub: (() => void) | null = null;
    /** Remembers which level was last loaded, so Retry/Next buttons know
     *  what to play. -1 means endless mode. */
    private currentLevelIdx = -1;
    /** Remember the fate piece the player chose for the current endless
     *  session. Restart paths ("再来一局") re-use this so the player
     *  doesn't have to re-pick the shape every time they die. Cleared
     *  when they bounce back to the mode-select screen (so the next
     *  endless run gets a fresh modal). */
    private lastEndlessFatePiece: { baseType: string; shape: number[][] } | null = null;

    /** True while a 闭眼模式 run is active. Distinguishes blind from
     *  vanilla endless so the fail panel's "再来一局" button routes
     *  back into `startBlind` instead of `startEndless`. Cleared on
     *  showModeSelect (returning home). */
    private blindModeActive: boolean = false;

    /** Cached gem balance for the settings-panel balance button. Painted
     *  immediately on openSettings (may be stale), then refreshed
     *  asynchronously from the server. Also drives the mode-select
     *  topup button label — kept in sync via a WalletApi subscription
     *  registered in onLoad. */
    private _cachedGemBalance: number = 0;

    /** Unsubscribe fn from WalletApi.subscribeBalance — fires on
     *  onDestroy so a torn-down controller doesn't leak a dangling
     *  listener across scene reloads. */
    private balanceUnsub: (() => void) | null = null;

    onLoad(): void {
        log('[TowerBlocks] MenuController.onLoad');
        // Global back-key dispatcher. Popup components push/pop their
        // own dismiss handlers via BackKeyManager.push/pop; when the
        // stack is empty (i.e. we're at the main menu), the default
        // handler below fires and shows the exit-confirm modal.
        BackKeyManager.install();
        BackKeyManager.setDefault(() => this._onBackAtMainMenu());
        // Re-translate every tracked label whenever the user toggles
        // the language at runtime. Stored unsub fires in onDestroy.
        // Also swap the main-menu logo image to the current language's
        // localized brand art (10 authored SpriteFrame slots).
        this.langUnsub = subscribeLang(() => {
            this.refreshI18nLabels();
            this._refreshLocalizedLogo();
        });
        // Paint the correct logo on first load too.
        this._refreshLocalizedLogo();
        // Subscribe to wallet balance broadcasts so the mode-select
        // topup button + settings balance strip repaint the moment
        // gems change — no matter which surface caused the change
        // (paid refresh spends gems in-game, top-up IAP credits mid-
        // session, debug console grant). WalletApi auto-emits from
        // fetchWallet / topupWallet, and RefreshApi.purchaseRefresh
        // emits after a successful gem deduction, so callers don't
        // have to remember to notify us.
        this.balanceUnsub = subscribeBalance((gems) => {
            this._cachedGemBalance = gems;
            this.paintBalanceButton(gems);
        });
    }

    /** Look up the localized logo SpriteFrame for a given i18n code
     *  (defaults to current game language). Returns the English logo
     *  as fallback, or null if even that isn't wired. Public so other
     *  scenes (LoadingController) can reuse the same authored slots
     *  without duplicating 10 SpriteFrame @property fields. */
    public getLocalizedLogoSpriteFrame(code?: string): SpriteFrame | null {
        const c = code ?? getLang();
        const map: Record<string, SpriteFrame | null> = {
            'zh':      this.logoZh,
            'zh-Hant': this.logoZhHant,
            'en':      this.logoEn,
            'ja':      this.logoJa,
            'ko':      this.logoKo,
            'es':      this.logoEs,
            'fr':      this.logoFr,
            'pt-BR':   this.logoPtBR,
            'de':      this.logoDe,
            'ru':      this.logoRu,
        };
        return map[c] ?? this.logoEn;
    }

    /** Swap `authoredMenuLogoSprite`'s spriteFrame to the current
     *  i18n language's localized logo. Silent no-op if either the
     *  Sprite slot or the matching SpriteFrame slot is unwired. */
    private _refreshLocalizedLogo(): void {
        if (!this.authoredMenuLogoSprite) return;
        const sf = this.getLocalizedLogoSpriteFrame();
        if (sf) this.authoredMenuLogoSprite.spriteFrame = sf;
    }

    onDestroy(): void {
        if (this.langUnsub) { this.langUnsub(); this.langUnsub = null; }
        if (this.balanceUnsub) { this.balanceUnsub(); this.balanceUnsub = null; }
    }

    /** Register a label as i18n-driven. Sets its initial string now and
     *  re-translates it when the active language changes. */
    private trackI18nLabel(label: Label, key: string, params?: Record<string, string | number>): Label {
        label.string = t(key, params);
        this.i18nLabels.push({ label, key, params });
        return label;
    }

    private refreshI18nLabels(): void {
        for (const entry of this.i18nLabels) {
            if (!entry.label || !entry.label.isValid) continue;
            entry.label.string = t(entry.key, entry.params);
        }
    }

    start(): void {
        log('[MenuController] start — deferring buildUi() to next frame');
        // IMPORTANT: defer the UI build by one frame. In Cocos 3.8 the
        // Canvas → Camera binding isn't fully wired up until after every
        // component on Canvas has finished start(). Creating UI nodes
        // inside start() races with that binding — the runtime-created
        // children sometimes skip registration with the UI render path,
        // resulting in a visually empty preview even though the nodes
        // exist with active=true at correct positions.
        // scheduleOnce(_, 0) defers to the next update tick, which is
        // after the Canvas binding completes.
        this.scheduleOnce(() => this.actuallyBuildAndShow(), 0);
    }

    private actuallyBuildAndShow(): void {
        try {
            this.buildUi();
            const child = (n: Node | undefined) => {
                if (!n) return 'null';
                return `${n.name}(active=${n.active}, children=${n.children.length})`;
            };
            log(`[MenuController] buildUi() complete — modeSelectPanel: ${child(this.modeSelectPanel)}`);
            if (this.modeSelectPanel) {
                for (const c of this.modeSelectPanel.children) {
                    log(`  └─ ${c.name} pos=(${c.position.x.toFixed(1)},${c.position.y.toFixed(1)}) active=${c.active}`);
                }
            }
        } catch (e) {
            log('[MenuController] buildUi() THREW:', (e as Error).message, (e as Error).stack);
            return;
        }
        if (this.gameController) {
            this.gameController.setMenuController(this);
            // Also register HudController so GameController hooks
            // (esp. onShapeshifterRequest) can open the picker UI.
            if (this.hudController) {
                this.gameController.setHudController(this.hudController);
            }
        }
        // Apply persisted audio prefs so BgmManager / SoundManager start
        // in the right mute state. Runs after the managers' onLoad has
        // registered their instances but before we play the menu BGM.
        this.applyPersistedAudioSettings();
        // Hide the menu panel up-front when a LoadingController is
        // driving the boot sequence — otherwise the (unwarmed) menu
        // would flash for one frame before the loading overlay covers
        // it. LoadingController will call beginBootAfterLoading() once
        // its warmup pipeline finishes.
        if (this.deferMenuShow) {
            if (this.modeSelectPanel) this.modeSelectPanel.active = false;
            log('[MenuController] deferMenuShow=true — waiting for LoadingController');
            return;
        }
        this.showModeSelect();
        log(`[MenuController] showModeSelect done — modeSelectPanel.active: ${this.modeSelectPanel?.active}`);
    }

    /** Called by LoadingController after the FX warmup pipeline
     *  finishes. Flow:
     *   1. Ensure the player has a server-issued userid + nickname
     *      (calls POST /player/register on first launch).
     *   2. If it's their FIRST launch (tutorial not yet seen) → run
     *      the operations tutorial first, then reveal the main menu.
     *   3. Otherwise → straight to the main menu.
     *
     *  Network failure in step 1 falls back to a local UUID and lets
     *  the boot proceed; the tutorial (step 2) doesn't depend on the
     *  network. */
    public beginBootAfterLoading(): void {
        // Register the ban handler BEFORE any Http calls fire — an
        // auth'd request that 403s with "banned" latches immediately
        // and the modal appears without waiting for the player to
        // navigate somewhere.
        setBannedHandler((s) => this.showBannedModal(s));
        void (async () => {
            // Step 1: register / recover the player identity
            await PlayerProfile.ensureRegistered().catch((e) => {
                console.warn('[MenuController] ensureRegistered failed:', e);
            });
            // ensureRegistered is a no-op for existing players (fast
            // path — no server round-trip), so it won't trigger the
            // ban check by itself. Fire a lightweight authenticated
            // request (wallet fetch) so a banned player hits the 403
            // + modal BEFORE the main menu shows. Fire-and-forget —
            // non-ban errors don't block boot.
            // Boot wallet fetch — primary purpose is to trigger the
            // banned-user check (which happens inside the auth path
            // before this promise resolves). Bonus: use the response
            // to paint the mode-select topup button's balance label so
            // it shows the real number instead of the authored "99999"
            // placeholder. Fire-and-forget — non-ban errors don't
            // block boot.
            fetchWallet().then((w) => {
                this._cachedGemBalance = w.gems;
                this.paintBalanceButton(w.gems);
            }).catch((err) => {
                if (!getBannedState()) {
                    console.warn(`[MenuController] boot wallet fetch failed (non-ban): ${err?.message}`);
                }
            });

            // Boot-time profile fetch — AWAITED so the menu doesn't
            // reveal until the server-authoritative profile has landed.
            // This kills the race where a player who just re-installed
            // taps "关卡模式" faster than the fetch resolves and sees
            // level 1 despite the server having their cleared-count.
            // Also seeds LevelProgress from bestScores.level so re-
            // installs / new devices don't reset every player to 1.
            //
            // Non-ban network errors don't block boot — menu comes up
            // with whatever's in localStorage (usually empty on fresh
            // install; player just re-plays the missing levels).
            try {
                const p = await PlayerProfile.fetchProfile();
                // Server-side level progress lives in TWO places (see the
                // same block in LoadingController.beginBoot for the full
                // rationale). Short version: bestScores.level is only
                // bumped by endless/blind submitScore, NOT by level-mode
                // submitLevelTime — so a level-mode-only player has 0
                // there forever. The truth is in the leaderboard/level-
                // time-mine entries: max(levelIdx) is the real "highest
                // cleared". Take the max of both to hydrate correctly on
                // fresh installs / account recovery.
                let serverIdx = (p?.bestScores?.level ?? 0) - 1;
                try {
                    const mine = await fetchMyLevelTimes();
                    if (mine.length > 0) {
                        const derivedIdx = mine.reduce(
                            (max, e) => (e.levelIdx > max ? e.levelIdx : max),
                            -1,
                        );
                        if (derivedIdx > serverIdx) {
                            log(`[MenuController] boot: level-time entries yield higher progress ${derivedIdx} > bestScores.level-1=${serverIdx}`);
                            serverIdx = derivedIdx;
                        }
                    }
                } catch (e) {
                    console.warn(`[MenuController] boot fetchMyLevelTimes failed (progress will fall back to bestScores.level only): ${(e as Error)?.message}`);
                }
                if (serverIdx >= 0) {
                    // Max-merge with whatever's already in localStorage
                    // so a player who just cleared a level on this
                    // device doesn't get bumped BACK if the upload race
                    // lost. Server-side best-of merging keeps subsequent
                    // submissions monotone anyway.
                    const localIdx = LevelProgress.maxClearedIdx;
                    if (serverIdx > localIdx) {
                        LevelProgress.restoreFrom(serverIdx);
                        log(`[MenuController] boot restored LevelProgress from server: ${localIdx} -> ${serverIdx}`);
                    }
                }
                // Endless best-layers: cache locally so the Blind-mode
                // / Leaderboard unlock check doesn't need a server call
                // every menu open. Max-merge with local (same reason
                // as LevelProgress above).
                const serverEndless = p?.bestScores?.endless ?? 0;
                if (serverEndless > this._endlessBestLayers) {
                    this._endlessBestLayers = serverEndless;
                    this._persistEndlessBest();
                }
                log(`[MenuController] boot profile ready — bestScores=${JSON.stringify(p?.bestScores)}`);
                // Repaint mode buttons in case unlock state changed.
                this._refreshModeButtonLocks();
            } catch (err) {
                if (!getBannedState()) {
                    console.warn(`[MenuController] boot fetchProfile failed (non-ban): ${(err as Error)?.message}`);
                }
            }

            // Ban check — if any auth'd request 403'd above, the
            // handler has fired + modal is up; skip further boot work.
            if (getBannedState()) {
                log('[MenuController] boot short-circuited — player banned');
                return;
            }
            log(`[MenuController] beginBootAfterLoading — uuid=${PlayerProfile.uuid} name=${PlayerProfile.name}`);

            // Step 2: consent gate (韩国 PIPA / 게임산업진흥법 요구). Blocks
            // menu reveal until player agrees to current ToS + Privacy
            // versions. If the network's down or the server errors, we
            // skip the gate and let the user in — better than locking
            // them out. `needsConsent=true` on the next successful
            // fetch will re-show the modal.
            await this.maybeShowConsentGate();

            // Step 3: tutorial or menu
            const needTutorial = !TutorialProgress.hasSeen('operations')
                              && !!this.tutorialController;
            if (!needTutorial) {
                this.showModeSelect();
                return;
            }
            log('[MenuController] first launch — running operations tutorial before showing menu');
            this.setGameplayVisible(true);
            if (this.modeSelectPanel) this.modeSelectPanel.active = false;
            this.tutorialController!.show(() => {
                // After the tutorial, drop the player straight into
                // level 1 instead of the main menu — they've just been
                // taught the controls, so the natural next beat is a
                // real level to try them on. The main menu is reachable
                // via the in-game Home button.
                log('[MenuController] tutorial done — entering level 1');
                this.startLevel(0);
            });
        })();
    }

    /** Poll server for consent status; if the current player hasn't
     *  agreed to the latest ToS + Privacy versions, block boot until
     *  they do. Safe no-op if server errors or the ConsentModal node
     *  isn't wired (older scenes). */
    private async maybeShowConsentGate(): Promise<void> {
        if (!this.consentModalNode) {
            console.log('[MenuController] consent modal not wired — skipping gate');
            return;
        }
        let status;
        try {
            status = await fetchConsentStatus();
        } catch (e) {
            console.warn('[MenuController] consent status fetch failed — proceeding:', e);
            return;
        }
        if (!status.needsConsent) {
            console.log('[MenuController] consent OK — versions match');
            // Prior-session consent still applies — flip analytics on
            // WITHOUT logging a new consent_accepted event (that fires
            // only from the modal path). Idempotent on the native side.
            AnalyticsApi.setEnabled(true);
            return;
        }
        const modal = this.consentModalNode.getComponent(ConsentModal);
        if (!modal) {
            console.warn('[MenuController] consentModalNode missing ConsentModal component');
            return;
        }
        console.log('[MenuController] consent required — gating boot');
        await modal.gate(status);
        console.log('[MenuController] consent recorded — resuming boot');
    }

    // ============================================================
    //  Panel state transitions
    // ============================================================
    public showModeSelect(): void {
        // Defense-in-depth: submit any pending endless/blind height
        // BEFORE tearing down gameplay. The pause overlay's Home
        // button already calls this via HudController, but there are
        // several other paths into showModeSelect (result-panel Home
        // in game-over, level-clear return, direct route from
        // TutorialController, etc). Calling here means EVERY return-
        // to-menu path from a live endless/blind run has its height
        // recorded — no matter which button/gesture the player used.
        // No-op in level mode or when height is 0. Fire-and-forget.
        try {
            this.gameController?.submitEndlessHeightIfApplicable('mode-select-return');
        } catch (e) {
            console.warn('[MenuController] submitEndlessHeightIfApplicable threw during showModeSelect:', (e as Error)?.message);
        }
        // Defensive: whichever path got us here (tap return button,
        // enter a level, back key), drop the level-select back
        // handler so it doesn't linger and fire from the wrong
        // screen. pop() is a no-op if not on the stack.
        BackKeyManager.pop(this._levelSelectBack);
        this.modeSelectPanel.active  = true;
        // Reflect any progress that happened between the last time
        // this panel was visible and now (level clear, endless best).
        this._refreshModeButtonLocks();
        // Hide the 3D level-select stage. NOTE: we intentionally do NOT
        // call `teardown()` here — that would destroy the ~2000+ cube
        // nodes and rebuild them on the next `showLevelSelect()`, which
        // stalls the frame for hundreds of milliseconds on real Android
        // devices. Instead, the tower stays cached; showForLevel()
        // detects the cached state and skips the rebuild. The overlay
        // buttons ARE unwired (setActive false + off) so click
        // listeners don't accumulate across shows.
        if (this.levelStage3D) {
            this.levelStage3D.node.active = false;
            this.levelStage3D.hideOverlayButtons();
            // Reset lastShownIdx so re-entering level select after a
            // menu detour doesn't trigger the "advanced" collapse anim
            // (which is meant for the return-from-just-cleared-level
            // path only). This is safe with the cached-tower path
            // because it only resets tracking state, not cube nodes.
            this.levelStage3D.resetShownState();
        }
        // Hide the 2D UI overlay that lives above the level-select
        // tower (back arrow / progress bar / badges / etc). Kept
        // together with the 3D stage's visibility so they behave as
        // a single "screen".
        if (this.authoredLevelSelectOverlay) this.authoredLevelSelectOverlay.active = false;
        if (this.mainCamera3D) this.mainCamera3D.active = true;
        this.setGameplayVisible(false);
        // Twinkle stars are level-select-only decor — hide here.
        if (this.twinkleStars) this.twinkleStars.setVisible(false);
        if (this.gameController?.gameState) {
            this.gameController.gameState.running = false;
        }
        // Going back to the menu ends the endless session — drop the
        // cached fate piece so the next 无尽模式 entry re-shows the
        // modal with a freshly rolled shape.
        this.lastEndlessFatePiece = null;
        // Clear blind-mode active flag — future "再来一局" from a fresh
        // endless run shouldn't accidentally route into blind mode.
        this.blindModeActive = false;
        BgmManager.instance?.play('menu');
        // Balance button — paint cached value immediately (avoids the
        // "99999" placeholder flash on return-to-home), then re-fetch
        // in the background to catch any changes (paid refresh spent
        // gems, ad reward credited on server, IAP completed while
        // player was in-game, etc.).
        this.paintBalanceButton(this._cachedGemBalance);
        fetchWallet().then((w) => {
            this._cachedGemBalance = w.gems;
            this.paintBalanceButton(w.gems);
        }).catch(() => { /* silent — cached value is fine */ });
        // Newbie 14-day event entry button — server tells us whether
        // the player is still inside the 14-day window. Runs on every
        // return-to-menu so the button auto-hides at the moment the
        // window expires (player left the app open past midnight).
        this._refreshEventNewbie14Button();
    }

    /** Ping /player/event/newbie14/status and toggle the main-menu
     *  entry button accordingly. Also wires the click → panel.show()
     *  once (guarded by `_eventNewbie14Wired`). Silent no-op if
     *  either the button or the panel component isn't wired in the
     *  editor. */
    private _eventNewbie14Wired = false;
    private _refreshEventNewbie14Button(): void {
        const btn = this.authoredEventNewbie14Button;
        const panel = this.authoredEventNewbie14Panel;
        if (!btn || !panel) return;
        // Hide up-front — the fetch below will re-show if active.
        // Prevents a one-frame flash of the button for expired players
        // on second-and-later menu opens (cached-button case).
        btn.node.active = false;
        // Red dot starts hidden too — only lit up when server confirms
        // there's an unclaimed reward waiting today.
        if (this.authoredEventNewbie14RedDot) {
            this.authoredEventNewbie14RedDot.node.active = false;
        }
        if (!this._eventNewbie14Wired) {
            btn.node.on(Button.EventType.CLICK, () => {
                void panel.show();
                // Hide the red dot the moment the player opens the
                // popup — the "there's a reward for you" hint has
                // done its job. It'll come back tomorrow if the
                // panel claim confirms + next-day fetch says
                // canClaimToday again.
                if (this.authoredEventNewbie14RedDot) {
                    this.authoredEventNewbie14RedDot.node.active = false;
                }
            }, this);
            // One-shot warmup — the popup lives at active=false and
            // its textures / fonts / layout components aren't uploaded
            // to the GPU or initialized until the node goes active for
            // the first time. Without this, the FIRST tap only kicks
            // off that init work and the panel appears blank / a frame
            // late; the player then taps again to actually see it.
            // Flick active on/off in the same frame — enough to run
            // Cocos's one-frame init pass without ever showing the
            // panel to the player. Safe because show() is idempotent
            // (opacity/scale get re-set every call).
            panel.node.active = true;
            this.scheduleOnce(() => {
                panel.node.active = false;
            }, 0);
            // Attention-grabbing idle FX — gentle pulse + subtle wobble
            // + gold sparkle particles. Wired once (guarded by
            // _eventNewbie14Wired), survives active toggles.
            this._startEventNewbie14ButtonFx(btn.node);
            this._eventNewbie14Wired = true;
        }
        fetchNewbie14Status()
            .then((s) => {
                btn.node.active = s.active;
                if (this.authoredEventNewbie14RedDot) {
                    this.authoredEventNewbie14RedDot.node.active = s.active && s.canClaimToday;
                }
            })
            .catch((err) => {
                console.warn('[MenuController] newbie14 status failed:', (err as Error)?.message);
                // Fail-closed: keep button hidden on network / server
                // errors. Better than a button that opens a broken popup.
                btn.node.active = false;
                if (this.authoredEventNewbie14RedDot) {
                    this.authoredEventNewbie14RedDot.node.active = false;
                }
            });
    }

    /** Idle FX on the newbie-14 entry button: a subtle "breathing"
     *  pulse (scale 0.6 ↔ 0.7) + a shallow rotational wobble
     *  (±4°). Runs forever once wired. The pulse and wobble use
     *  slightly different periods so they don't visually beat
     *  against each other. Set up once — cc.tween's `repeatForever`
     *  keeps running across node active toggles (tween lives on the
     *  node's action manager and is paused when the node is inactive,
     *  resumes automatically when it goes active again).
     *
     *  Kept as a separate method so future tweaks (particles, glow
     *  layer sprite, shake on new-reward day) have a clear entry
     *  point. */
    private _startEventNewbie14ButtonFx(node: Node): void {
        // Pulse (scale): 0.9s in, 0.9s out — 1.8s cycle.
        // Range 0.6 ↔ 0.7 per design.
        tween(node)
            .to(0.9, { scale: new Vec3(0.7, 0.7, 1) }, { easing: 'sineInOut' })
            .to(0.9, { scale: new Vec3(0.6, 0.6, 1) }, { easing: 'sineInOut' })
            .union()
            .repeatForever()
            .start();
        // Wobble (rotation Z): ±4° over a 2.4s cycle — deliberately
        // out of sync with the pulse so the two effects visually
        // desync and the button feels alive instead of mechanical.
        tween(node)
            .to(0.6, { eulerAngles: new Vec3(0, 0,  4) }, { easing: 'sineInOut' })
            .to(0.6, { eulerAngles: new Vec3(0, 0, -4) }, { easing: 'sineInOut' })
            .to(0.6, { eulerAngles: new Vec3(0, 0,  4) }, { easing: 'sineInOut' })
            .to(0.6, { eulerAngles: new Vec3(0, 0,  0) }, { easing: 'sineInOut' })
            .union()
            .repeatForever()
            .start();
        // Sparkles — attach the EventButtonSparkles particle emitter so
        // small glowing dots continuously twinkle around the button.
        // Component is self-contained (builds its own radial-gradient
        // texture, no art asset), auto-tracks the button's active
        // state, and cleans up its own children on disable.
        if (!node.getComponent(EventButtonSparkles)) {
            node.addComponent(EventButtonSparkles);
        }
    }

    private _levelSelectBack = (): void => {
        // Same as tapping the 3D stage's return button — pops us
        // back to the mode-select screen. showModeSelect() also
        // hides the levelStage3D, so both entry points converge.
        BackKeyManager.pop(this._levelSelectBack);
        this.showModeSelect();
    };
    public showLevelSelect(): void {
        this.modeSelectPanel.active = false;
        BgmManager.instance?.play('menu');

        if (!this.levelStage3D) {
            log('[MenuController] levelStage3D unwired — cannot show level select.');
            return;
        }
        this.levelStage3D.node.active = true;
        // Hide the main gameplay camera + everything it renders so
        // the level-select stage owns the frame.
        if (this.mainCamera3D) this.mainCamera3D.active = false;
        this.setGameplayVisible(false);
        // Twinkle stars belong to the level-select scenery only.
        if (this.twinkleStars) this.twinkleStars.setVisible(true);
        // Back-key: return to mode-select. Registered here (not in
        // showModeSelect) so back only fires the return when the
        // player is actually on level-select.
        BackKeyManager.push(this._levelSelectBack);
        // The tower now indexes by FATE-PIECE GROUP (not by level) —
        // one row per unique 本命方块 rather than 9 identical rows
        // per group. Deduplicate the per-level customPiece.shape list
        // into a per-group list before handing it to the stage.
        //
        // `LevelSelectStage3D.currentIdx` becomes "current group idx";
        // the Enter callback translates back to the actual next-to-
        // play level (first uncleared level within the tapped group).
        const flat = (this.gameController as any)?.flatLevels as Array<any> | undefined;
        const groupCount = flat
            ? Math.ceil(flat.length / LEVELS_PER_FATE_PIECE)
            : 0;
        if (flat && typeof this.levelStage3D.setLevelShapes === 'function') {
            const groupShapes: Array<number[][] | null> = [];
            for (let g = 0; g < groupCount; g++) {
                const firstLevelInGroup = flat[g * LEVELS_PER_FATE_PIECE];
                const shape = firstLevelInGroup?.customPiece?.shape;
                groupShapes.push(shape && Array.isArray(shape) ? shape as number[][] : null);
            }
            this.levelStage3D.setLevelShapes(groupShapes);
        }
        if (groupCount > 0) {
            // Bring the stage's `totalLevels` in line so tower height,
            // "剩余关卡" counter, and clamp bounds all reflect the
            // group-indexed universe.
            this.levelStage3D.totalLevels = groupCount;
        }
        const currentGroupIdx = Math.floor(LevelProgress.currentIdx / LEVELS_PER_FATE_PIECE);
        this.levelStage3D.showForLevel(
            currentGroupIdx,
            (groupIdx: number) => {
                // Enter the next-to-play level within the tapped group.
                // "Next" = max(groupStart, first uncleared level in the
                // group). If the whole group is already cleared, fall
                // back to the group's first level (replay).
                const groupStart = groupIdx * LEVELS_PER_FATE_PIECE;
                const groupEnd   = groupStart + LEVELS_PER_FATE_PIECE - 1;
                const nextLevel  = Math.min(
                    groupEnd,
                    Math.max(groupStart, LevelProgress.currentIdx),
                );
                this.enterLevelFromStage3D(nextLevel);
            },
            () => this.showModeSelect(),
        );
        // Reveal the 2D UI overlay (back / progress bar / badges).
        // Kept off by default in the scene so it doesn't leak onto the
        // mode-select screen or into gameplay; script-managed here.
        // Also re-activate the individual authored pieces — the
        // gameplay-entry defense in `setGameplayVisible(true)` may
        // have set them false last time (belt-and-suspenders); flip
        // them back so this fresh open renders them.
        if (this.authoredLevelSelectOverlay) this.authoredLevelSelectOverlay.active = true;
        // Also re-activate leaf AND its immediate parent — the leaf
        // alone doesn't cover progress-bar background containers.
        const showNodeAndParent = (n: Node | null | undefined) => {
            if (!n || !n.isValid) return;
            if (n.parent && n.parent.isValid) n.parent.active = true;
            n.active = true;
        };
        if (this.authoredFatePieceProgressFill)  showNodeAndParent(this.authoredFatePieceProgressFill.node);
        if (this.authoredFatePieceProgressLabel) showNodeAndParent(this.authoredFatePieceProgressLabel.node);
        if (this.authoredBadgesRoot)             showNodeAndParent(this.authoredBadgesRoot);
        if (this.authoredBadgeCountLabel)        showNodeAndParent(this.authoredBadgeCountLabel.node);
        if (this.authoredBadgeCollectionButton)  showNodeAndParent(this.authoredBadgeCollectionButton.node);
        // Refresh the 9-slot progress bar + earned-badge case above the
        // stage so the player sees "3 / 9 of this fate piece done" and
        // the trophies from every fully-completed piece.
        this.refreshFatePieceProgressUi(LevelProgress.currentIdx);
    }

    /** Data helpers — pure functions of `LevelProgress.maxClearedIdx`.
     *  Group index N owns levels [N*9 .. N*9+8].
     *  Progress within a group = how many of its 9 levels are already
     *  cleared (0..9). Badge count = number of groups where all 9
     *  levels are cleared. */
    private _fatePieceGroupIdx(levelIdx: number): number {
        return Math.floor(Math.max(0, levelIdx) / LEVELS_PER_FATE_PIECE);
    }
    private _fatePieceProgressInGroup(maxClearedIdx: number, groupIdx: number): number {
        const groupStart = groupIdx * LEVELS_PER_FATE_PIECE;
        const clearedInGroup = maxClearedIdx - groupStart + 1;
        return Math.max(0, Math.min(LEVELS_PER_FATE_PIECE, clearedInGroup));
    }
    private _earnedBadgeCount(maxClearedIdx: number): number {
        return Math.floor((maxClearedIdx + 1) / LEVELS_PER_FATE_PIECE);
    }

    /** Repaint:
     *    • Progress bar — a single filled Sprite whose `fillRange`
     *      tracks `clearedInGroup / 9`, with an "X/9" label alongside.
     *    • Badge case — a horizontal row of small badge icons, one
     *      per fully-completed fate piece. Capped at
     *      `authoredBadgeInlineMax` icons; overflow lives behind the
     *      collection button (top-right entry point).
     *    • Badge count label — "已获得徽章 N 枚" i18n.
     *  Called after every `showForLevel` (fresh entry, post-clear
     *  re-entry) so the UI stays in sync with LevelProgress. */
    /** Badge-earned celebration: fires when the player clears the
     *  9th (last) level in a fate-piece group.
     *
     *  Timeline (canvas-space):
     *    0.00 s — spawn a temp badge sprite at the top-right
     *             collection button's world position, at scale 1×.
     *    0.00 → 0.50 s — tween to canvas centre (0,0) + scale 1.5×.
     *    0.50 → 1.00 s — pause (holds at centre for the player to
     *             register what they just earned).
     *    1.00 → 1.35 s — "slam" tween into the badge case root
     *             (position + scale back to 1×, easeIn).
     *    1.35 s  — destroy temp sprite + refresh the case (the new
     *             badge appears as a real child of the case root). */
    private _playBadgeEarnedFx(earnedGroupIdx: number): void {
        const icon = this.authoredBadgeIcons[earnedGroupIdx];
        const collectionBtn = this.authoredBadgeCollectionButton;
        const caseRoot = this.authoredBadgesRoot;
        if (!icon || !collectionBtn || !caseRoot) {
            // FX pipeline unwired — still refresh so the new badge
            // shows up statically in the case at least.
            this.refreshFatePieceProgressUi(LevelProgress.currentIdx);
            return;
        }
        const canvasNode = director.getScene()?.getComponentInChildren(Canvas)?.node;
        const canvasUT = canvasNode?.getComponent(UITransform);
        if (!canvasNode || !canvasUT) {
            this.refreshFatePieceProgressUi(LevelProgress.currentIdx);
            return;
        }

        // Convert start (collection button) + end (badge case) world
        // positions into canvas-local UI coords.
        const wp = new Vec3();
        const startPos = new Vec3();
        collectionBtn.node.getWorldPosition(wp);
        canvasUT.convertToNodeSpaceAR(wp, startPos);
        const endPos = new Vec3();
        caseRoot.getWorldPosition(wp);
        canvasUT.convertToNodeSpaceAR(wp, endPos);

        // Spawn a temp badge sprite on top of everything.
        const fx = new Node('BadgeEarnFx');
        fx.parent = canvasNode;
        fx.layer  = canvasNode.layer;
        fx.setSiblingIndex(9999);
        const ut = fx.addComponent(UITransform);
        ut.setContentSize(96, 96);
        const spr = fx.addComponent(Sprite);
        spr.sizeMode = Sprite.SizeMode.CUSTOM;
        spr.spriteFrame = icon;
        fx.setPosition(startPos);
        fx.setScale(1, 1, 1);

        SoundManager.instance?.play('item_pick');
        tween(fx)
            .to(0.5, { position: new Vec3(0, 0, 0), scale: new Vec3(1.5, 1.5, 1) }, { easing: 'quadOut' })
            .delay(0.5)
            .to(0.35, { position: endPos, scale: new Vec3(1, 1, 1) }, { easing: 'quadIn' })
            .call(() => {
                if (fx && fx.isValid) fx.destroy();
                // Repaint — the newly-earned badge is now included
                // in `_earnedBadgeCount(maxClearedIdx)`, so
                // refresh will add it as a child of the case root.
                this.refreshFatePieceProgressUi(LevelProgress.currentIdx);
            })
            .start();
    }

    public refreshFatePieceProgressUi(currentIdx: number): void {
        const maxCleared = LevelProgress.maxClearedIdx;
        const groupIdx   = this._fatePieceGroupIdx(currentIdx);
        const progress   = this._fatePieceProgressInGroup(maxCleared, groupIdx);

        // ---- Progress bar fill + label ----
        if (this.authoredFatePieceProgressFill) {
            this.authoredFatePieceProgressFill.fillRange = progress / LEVELS_PER_FATE_PIECE;
        }
        if (this.authoredFatePieceProgressLabel) {
            this.authoredFatePieceProgressLabel.string = `${progress}/${LEVELS_PER_FATE_PIECE}`;
        }

        // ---- Top-right collection button: preview of the badge the
        // player is CURRENTLY working toward. Pulls the icon at the
        // current group's index from `authoredBadgeIcons`. Falls back
        // to whatever sprite the button already carries when the
        // author didn't supply an icon for that group. ----
        if (this.authoredBadgeCollectionButton) {
            const nextIcon = this.authoredBadgeIcons[groupIdx];
            if (nextIcon) {
                const btnNode = this.authoredBadgeCollectionButton.node;
                const spr = btnNode.getComponent(Sprite) ?? btnNode.getComponentInChildren(Sprite);
                if (spr) spr.spriteFrame = nextIcon;
            }
        }

        // ---- Badges ----
        const badgeCount = this._earnedBadgeCount(maxCleared);
        if (this.authoredBadgeCountLabel) {
            this.authoredBadgeCountLabel.string = t('badges.earned', { n: badgeCount });
        }
        if (!this.authoredBadgesRoot || !this.authoredBadgesRoot.isValid) return;
        const root = this.authoredBadgesRoot;
        // Hide the template on its first paint so it doesn't leak
        // through as a "phantom badge" the player didn't earn.
        if (this.authoredBadgeTemplate && this.authoredBadgeTemplate.isValid) {
            this.authoredBadgeTemplate.active = false;
        }
        // Wipe our previously-cloned badges so the next paint is
        // fresh. The template + any hand-authored decor stay.
        const template = this.authoredBadgeTemplate;
        const toDestroy: Node[] = [];
        for (const child of root.children) {
            if (child === template) continue;
            if ((child as any)._isMenuBadge) toDestroy.push(child);
        }
        for (const c of toDestroy) if (c.isValid) c.destroy();

        // Inline cap — anything past the max lives in the collection
        // panel behind the top-right button.
        const inlineMax = this.authoredBadgeInlineMax > 0
            ? this.authoredBadgeInlineMax
            : badgeCount;
        const showCount = Math.min(badgeCount, inlineMax);
        for (let i = 0; i < showCount; i++) {
            const badge = template && template.isValid
                ? instantiate(template)
                : new Node(`Badge_${i}`);
            (badge as any)._isMenuBadge = true;
            badge.parent = root;
            // Set active AFTER parenting so onEnable fires with the
            // node in the scene tree — some Cocos components (Layout,
            // Widget) only lay out active-in-hierarchy children.
            badge.active = true;
            const icon = this.authoredBadgeIcons[i];
            if (icon) {
                // If the template didn't carry a Sprite component, add
                // one so the icon has somewhere to render. Playing it
                // safe — the author might have intentionally used a
                // Node with a decorative child that itself carries the
                // Sprite; only add a fallback when neither the node
                // nor any descendant has one.
                let spr = badge.getComponent(Sprite) ?? badge.getComponentInChildren(Sprite);
                if (!spr) {
                    spr = badge.addComponent(Sprite);
                    // Match UITransform size so the sprite fills the
                    // authored badge slot instead of showing at the
                    // sprite's native pixel size.
                    const ut = badge.getComponent(UITransform);
                    if (ut) spr.sizeMode = Sprite.SizeMode.CUSTOM;
                }
                spr.spriteFrame = icon;
            }
            // Diagnostic — surfaces "why can't I see my badge?" cases
            // (template unwired, sprite frame missing, size zero).
            const sprCheck = badge.getComponent(Sprite) ?? badge.getComponentInChildren(Sprite);
            const ut = badge.getComponent(UITransform);
            log(`[Badge ${i}] active=${badge.active} pos=(${badge.position.x.toFixed(0)},${badge.position.y.toFixed(0)}) size=(${ut?.width ?? '?'}x${ut?.height ?? '?'}) sprite=${!!sprCheck} spriteFrame=${!!sprCheck?.spriteFrame} parentActive=${root.active} parentActiveInHierarchy=${root.activeInHierarchy}`);
        }
    }

    /** Enter-button callback wired to LevelSelectStage3D. Plays the
     *  scatter animation on the level-select tower (every cube flies
     *  outward and fades out), then hands off to the game: hides the
     *  3D stage, restores the main gameplay camera, kicks BGM, and
     *  boots the chosen level. Sets `currentLevelIdx` so
     *  `showLevelWin` knows we're in level mode. */
    private enterLevelFromStage3D(idx: number): void {
        if (this._enteringLevel) return;   // ignore repeated taps
        this._enteringLevel = true;
        this.currentLevelIdx = idx;
        // Leaving level-select for gameplay — drop the level-select
        // back-handler. In-game back falls through to the default
        // (exit-confirm at main menu). If we want in-game back to
        // pause / return-to-menu instead, do it in GameController.
        BackKeyManager.pop(this._levelSelectBack);
        // Hide the level-select 2D overlay (back arrow, progress bar,
        // badges) — the gameplay HUD takes over on the next frame.
        if (this.authoredLevelSelectOverlay) this.authoredLevelSelectOverlay.active = false;

        const releaseGuard = () => { this._enteringLevel = false; };

        const hud: any = this.hudController as any;
        const flatLevels = (this.gameController as any)?.flatLevels as Array<any> | undefined;
        const rawLvl = flatLevels && flatLevels[idx];

        // NEW ORDER: hide UI → scatter → fate preview → enter game.
        // Previously the fate preview ran first, but the player asked
        // for it to land AFTER the tower's exit-scatter so the modal
        // pops on a clean stage instead of over an intact tower.
        //
        // From level 16 onwards the auto-dismiss preview is replaced by
        // an interactive embed-prop picker (see HudController's
        // `showFateEmbedPicker`) — the modal waits until the player
        // taps 开始, and the chosen prop (if any) is threaded through
        // to `doEnterLevel`.
        const afterScatter = () => {
            // playExitScatter's restore callback puts every cube back
            // at its original position + full scale (needed so the
            // return-from-level "advanced" collapse path can find valid
            // cubes to shrink + fly). If we leave the stage node active
            // during the fate preview, the tower "unscatters" back into
            // view under the modal for a jarring beat. Hide the stage
            // node now so the restored cubes stay invisible — doEnterLevel
            // hides it again later (idempotent, no-op the second time).
            if (this.levelStage3D) this.levelStage3D.node.active = false;
            const useEmbed = (rawLvl?.order ?? 0) >= EMBED_MIN_LEVEL_ORDER;
            if (useEmbed && hud && typeof hud.showFateEmbedPicker === 'function' && rawLvl) {
                hud.showFateEmbedPicker(rawLvl, (embed: EmbedProp | null) => {
                    this.doEnterLevel(idx, releaseGuard, embed);
                });
            } else if (hud && typeof hud.showFatePreview === 'function' && rawLvl) {
                hud.showFatePreview(rawLvl, () => this.doEnterLevel(idx, releaseGuard), 1000);
            } else {
                this.doEnterLevel(idx, releaseGuard);
            }
        };

        if (this.levelStage3D) {
            // Hide the overlay buttons (进入关卡 / 返回主页) BEFORE
            // the scatter animation starts. Otherwise the buttons hang
            // around a beat too long over a disintegrating tower.
            this.levelStage3D.hideOverlayButtons();
            this.levelStage3D.playExitScatter(afterScatter);
        } else {
            afterScatter();
        }
    }

    /** Guard against double-clicks on 进入关卡 during the scatter shot. */
    private _enteringLevel = false;

    /** Hand-off from `enterLevelFromStage3D` into actual gameplay
     *  after the scatter animation completes. NOTE: we do NOT call
     *  `teardown()` / `resetShownState()` on the level-select stage —
     *  `playExitScatter` restored every cube to its pre-scatter
     *  transform before firing this callback, so the stage's internal
     *  state stays intact. On return from the level, `showForLevel`
     *  detects the preserved state and plays the collapse animation
     *  on the OLD top segment (shrink + separator fly + push-up).
     *  Triggers the "assemble from outside" animation on the game side —
     *  cubes fly in and settle into place before the level actually
     *  starts. */
    private doEnterLevel(idx: number, onGameplayReady?: () => void, embed: EmbedProp | null = null): void {
        if (this.levelStage3D) {
            // Hide the Enter / Back overlay buttons — they sit on the
            // main Canvas, not on `levelStage3D.node`, so deactivating
            // the stage node alone doesn't take them down with it.
            this.levelStage3D.hideOverlayButtons();
            this.levelStage3D.node.active = false;
        }
        if (this.mainCamera3D) this.mainCamera3D.active = true;
        this.setGameplayVisible(true);
        BgmManager.instance?.play('level');

        this.gameController?.loadLevelByIndex(idx, embed);
        // Assembly shot — every board cube starts off-screen and tweens
        // to its target position. Game logic (piece falling, input) is
        // paused inside GameController until this completes.
        //
        // After assembly, if the Lvl 16+ embed picker armed a prop,
        // `playEmbedRevealFxIfPending` fires the yellow-orb arc + cell
        // glow reveal, then clears `modalPaused` so the piece drops.
        // No-op for levels < 16 or when the player skipped the pick.
        const afterAssembly = () => {
            const gc = this.gameController as any;
            if (gc && typeof gc.playEmbedRevealFxIfPending === 'function') {
                gc.playEmbedRevealFxIfPending(() => { if (onGameplayReady) onGameplayReady(); });
            } else if (onGameplayReady) {
                onGameplayReady();
            }
        };
        if (this.gameController && typeof this.gameController.playLevelAssembly === 'function') {
            this.gameController.playLevelAssembly(this.enterAssembleSec, afterAssembly);
        } else {
            afterAssembly();
        }
    }

    /** Compute the row index we consider "most recent" for the auto-
     *  centering behaviour, then position the ScrollView so that row
     *  sits in the middle of the viewport.
     *
     *  Row pick:
     *    - Fresh profile (nothing cleared) → row 0 (关卡 1)
     *    - Some cleared but not all → LevelProgress.currentIdx
     *      (the "next to play" — the highest-unlocked-not-cleared row)
     *    - Everything cleared → last row so the player sees the end of
     *      the list rather than staring at the top */
    /** Fresh-entry path for endless mode (the 无尽模式 button). Pops the
     *  本命方块 modal first with a random shape; player can keep or
     *  reroll, then we start endless with the picked piece mixed into
     *  the bag. Restart paths ("再来一局") still call `startEndless`
     *  directly so the modal doesn't loop. */
    public enterEndless(): void {
        // Entering vanilla endless — clear the blind flag so retry
        // routes back into `startEndless`, not `startBlind`.
        this.blindModeActive = false;
        // Resolve HUD: prefer inspector property, fall back to lookups.
        let hud: any = this.hudController as any;
        if (!hud) hud = this.getComponent(HudController);
        if (!hud) {
            const scene = director.getScene();
            if (scene) hud = scene.getComponentInChildren(HudController);
        }
        if (!hud || typeof hud.showFateModal !== 'function') {
            // No HUD available — just start endless without the modal.
            this.startEndless();
            return;
        }
        // Build a fresh pseudo-level so the modal has something to work
        // off. Order=1 picks the first canonical shape as the default,
        // but the player will almost always reroll.
        const fakeLvl: any = { order: 1, customPiece: null };
        this.modeSelectPanel.active  = false;
        this.dismissResultPanel();
        // Keep HUD visible so the modal renders.
        this.setGameplayVisible(true);
        hud.showFateModal(
            fakeLvl,
            (picked: { baseType: string; shape: number[][] }) => {
                // Stash the picked piece so "再来一局" can re-use it
                // instead of starting a vanilla endless game.
                this.lastEndlessFatePiece = {
                    baseType: picked.baseType,
                    shape:    picked.shape.map(r => r.slice()),
                };
                // CRITICAL: reset currentLevelIdx to -1 so downstream
                // code (result panel routing, `重试` button, etc.)
                // recognises this as an endless run. Without this,
                // playing level → home → endless → game over → retry
                // would restart the LAST played level instead of a
                // fresh endless run because `currentLevelIdx` still
                // held that level's index from the previous play.
                this.currentLevelIdx = -1;
                BgmManager.instance?.play('endless');
                this.gameController?.startEndless({
                    baseType: picked.baseType as any,
                    shape:    picked.shape,
                });
            },
            () => {
                // Cancel — bounce back to mode select.
                this.setGameplayVisible(false);
                this.modeSelectPanel.active = true;
            },
        );
    }

    public startEndless(): void {
        this.currentLevelIdx = -1;
        this.hideMenuAndPlay();
        BgmManager.instance?.play('endless');
        // Restart: re-use the fate piece the player picked when they
        // entered endless this session, so "再来一局" feels like a
        // continuation rather than a vanilla run.
        if (this.lastEndlessFatePiece) {
            this.gameController?.startEndless({
                baseType: this.lastEndlessFatePiece.baseType as any,
                shape:    this.lastEndlessFatePiece.shape,
            });
        } else {
            this.gameController?.startEndless();
        }
    }

    /** 闭眼模式 (blind) — no fate modal, no custom piece; jumps straight
     *  into the game. `currentLevelIdx` stays at -1 so the fail flow
     *  routes to "再来一局" instead of level retry. Uses endless BGM. */
    public enterBlindMode(): void {
        this.currentLevelIdx = -1;
        this.blindModeActive = true;
        this.hideMenuAndPlay();
        BgmManager.instance?.play('endless');
        this.gameController?.startBlind();
    }

    /** Retry path for 闭眼模式 — mirrors startEndless but calls into
     *  the blind entry point instead. */
    public startBlind(): void {
        this.currentLevelIdx = -1;
        this.blindModeActive = true;
        this.hideMenuAndPlay();
        BgmManager.instance?.play('endless');
        this.gameController?.startBlind();
    }

    public startLevel(idx: number): void {
        // Only called for retries and non-first-time paths — first
        // entry into level 1 goes through `doEnterLevel` which has
        // its own tutorial gate.
        this.currentLevelIdx = idx;
        this.hideMenuAndPlay();
        BgmManager.instance?.play('level');
        this.gameController?.loadLevelByIndex(idx);
    }

    private hideMenuAndPlay(): void {
        this.modeSelectPanel.active  = false;
        this.dismissResultPanel();
        this.setGameplayVisible(true);
    }

    // ============================================================
    //  Result overlays — invoked by GameController hooks
    // ============================================================
    /** Endless or level mode game-over (player failed). */
    public showGameOver(reason: number | null): void {
        const isLevel = this.currentLevelIdx >= 0;
        // Endless / blind + the one-shot revive is still available →
        // show the revive prompt FIRST. The prompt reuses the authored
        // result panel with a swap-in title, countdown-driven subtitle,
        // and two buttons (watch ad / spend gems). If the player picks
        // one and it succeeds, the run resumes and we never build the
        // regular fail panel. If they let the countdown lapse (or the
        // pick fails), the revive prompt hands off to the regular
        // fail-panel path.
        const gs = this.gameController?.gameState;
        const canRevive = !isLevel && !!gs && !gs.endlessReviveUsed;
        if (canRevive) {
            this.showRevivePrompt(() => this._showGameOverFinal(reason));
            return;
        }
        this._showGameOverFinal(reason);
    }

    /** The original "you lost, retry or home" panel path. Extracted so
     *  showRevivePrompt can fall through to it after countdown expiry
     *  (or when the revive attempt errored out). Keeps the endless
     *  height recording in one place so the leaderboard unlock state
     *  fires exactly once per failed run regardless of which path the
     *  UI took to get here. */
    private _showGameOverFinal(reason: number | null): void {
        const isLevel = this.currentLevelIdx >= 0;
        const title = isLevel ? t('result.levelFail') : t('result.gameOver');
        const subtitle = reason === 1 ? t('result.fail.hole')
                       : reason === 2 ? t('result.fail.tall')
                       : '';
        this.buildResultPanel(title, subtitle, this.makeFailButtons());
        if (!isLevel) {
            const layers = this.gameController?.gameState?.endlessProgress?.cumulative ?? 0;
            this._recordEndlessRun(layers);
        }
    }

    /** Level cleared. */
    public showLevelWin(): void {
        // Level-mode wins skip the result popup entirely.
        //
        // Post-clear sequence (per design):
        //   1. Kick the scatter animation on the current tower.
        //   2. SIMULTANEOUSLY pop the fate-preview overlay showing
        //      "下一关" + the next level's fate cube, matching the
        //      styling of the level-select "剩余关卡" counter.
        //   3. Hold the overlay for ~1s after scatter finishes.
        //   4. Assemble the next level (same fly-in effect as entering
        //      from the level-select stage).
        // If this was the final level, fall back to level-select so
        // the player sees the "game complete" state instead of trying
        // to load a nonexistent level.
        if (this.currentLevelIdx < 0) return; // endless never triggers this
        const totalLevels = (this.gameController as any)?.flatLevels?.length ?? 0;
        const nextIdx = this.currentLevelIdx + 1;
        const hasNext = nextIdx < totalLevels;
        // Just cleared the LAST level in a fate-piece group → a new
        // badge was earned. Divert from the auto-advance flow into a
        // "return to level-select + play badge-earned FX" flow so the
        // player gets the celebration + the tower collapse-rebuild
        // brings the next fate piece up as background action.
        const justEarnedBadge =
            ((this.currentLevelIdx % LEVELS_PER_FATE_PIECE) === LEVELS_PER_FATE_PIECE - 1);
        const earnedGroupIdx = Math.floor(this.currentLevelIdx / LEVELS_PER_FATE_PIECE);

        // ---- Game-complete path OR badge-earned path: no auto-advance.
        // Both go through the same celebration → level-select gateway
        // so the tower's collapse-rebuild animation runs on stage
        // re-entry, and (for badge earns) the badge FX layers on top. ----
        if (!hasNext || justEarnedBadge) {
            const gotoSelect = () => {
                // Stop the gameplay tick BEFORE hiding the HUD so no
                // more pieces spawn / lock during the transition —
                // without this the player still hears drop / lock
                // SFX from the (now-invisible) tower while the badge
                // FX plays on the level-select screen.
                if (this.gameController?.gameState) {
                    this.gameController.gameState.running = false;
                }
                this.showLevelSelect();
                this.setGameplayVisible(false);
                // Badge-earned FX: wait a beat for the tower's own
                // collapse-rebuild animation (playCollapseThenRebuild)
                // to settle, then fly the badge from the top-right
                // preview slot → screen centre (scale 1.5×, 0.5 s) →
                // pause 0.5 s → slam into the badge case (0.35 s).
                if (justEarnedBadge) {
                    this.scheduleOnce(() => this._playBadgeEarnedFx(earnedGroupIdx), 1.5);
                }
            };
            SoundManager.instance?.play('level_win');
            const finalHudAny = this.hudController as any;
            const finalGs = (this.gameController as any)?.gameState;
            const finalElapsedSec = finalGs?.levelElapsedSec ?? 0;
            if (finalHudAny && typeof finalHudAny.showLevelClearTime === 'function') {
                finalHudAny.showLevelClearTime(finalElapsedSec, () => {
                    // Only hide the HUD AFTER the celebration completes,
                    // so the centered "通关时间：MM:SS" isn't yanked off
                    // screen mid-animation.
                    if (this.hudController) this.hudController.setHudVisible(false);
                    gotoSelect();
                });
            } else {
                if (this.hudController) this.hudController.setHudVisible(false);
            }
            // Scatter runs in parallel with the timer animation (same
            // as between-level). No completion callback — the timer
            // onComplete owns the goto-select trigger.
            if (this.gameController
                && typeof this.gameController.playLevelScatter === 'function') {
                const scatterCb = (finalHudAny && typeof finalHudAny.showLevelClearTime === 'function')
                    ? () => { /* handled by showLevelClearTime.onComplete */ }
                    : gotoSelect;
                this.gameController.playLevelScatter(this.exitLevelScatterSec, scatterCb);
            } else if (!(finalHudAny && typeof finalHudAny.showLevelClearTime === 'function')) {
                gotoSelect();
            }
            return;
        }

        // ---- Between-level path: strict sequential timeline ----
        //   1. Stop level BGM
        //   2. Scatter animation START → play level_win SFX at the
        //      exact same beat (per design — SFX lands ON the visual
        //      scatter, not before it)
        //   3. Show fate preview popup once scatter finishes
        //   4. Popup holds 1 second
        //   5. Popup dismisses → assemble next level's tower
        // Step 1: stop level BGM immediately on clear. level_win SFX
        // is deferred to step 2 (the playLevelScatter call below), so
        // it aligns with the scatter animation onset. BGM resumes on
        // preview close so the assembly beat has music under it.
        BgmManager.instance?.stop();

        const holdMs = 2000; // fate preview visible time — long enough to
                             // read '下一关' + inspect the shape

        // Resolve HUD + next level payload up front (used in step 3).
        const hud: any = this.hudController as any;
        const flatLevels = (this.gameController as any)?.flatLevels as Array<any> | undefined;
        const nextRawLvl = flatLevels && flatLevels[nextIdx];

        const advance = (embed: EmbedProp | null = null) => {
            // Step 5: fate popup just closed → restart level BGM and hand
            // off to the same entry point the level-select stage uses,
            // so the assembly animation + camera swap match exactly with
            // what the player sees on first entry.
            //   doEnterLevel → setGameplayVisible(true) → re-shows
            //   boardRoot3D, then plays the assembly fly-in.
            BgmManager.instance?.play('level');
            this.currentLevelIdx = nextIdx;
            this.doEnterLevel(nextIdx, undefined, embed);
        };

        const showPreview = () => {
            // Hide the empty 3D board so the fate popup sits on a clean
            // backdrop — leaving the (now-empty) tower visible pulled
            // the eye away from the next-level cube. HUD stays up so
            // the fate overlay can render.
            if (this.boardRoot3D) this.boardRoot3D.active = false;
            // Play the scatter SFX at the moment the fate popup appears
            // (per design — audio lines up with the popup pop-in beat,
            // not the earlier scatter visual).
            SoundManager.instance?.play('level_scatter');
            // Step 3+4: pop the fate modal.
            //   levels < 16 → auto-dismiss preview (advance after holdMs)
            //   levels ≥ 16 → interactive embed-prop picker (advance on
            //                  START click with the chosen embed threaded
            //                  into `advance`)
            const floorNum = nextIdx + 1;
            const useEmbed = (nextRawLvl?.order ?? 0) >= EMBED_MIN_LEVEL_ORDER;
            if (useEmbed && hud && typeof hud.showFateEmbedPicker === 'function' && nextRawLvl) {
                hud.showFateEmbedPicker(nextRawLvl, (embed: EmbedProp | null) => advance(embed), t('level.floor', { n: floorNum }));
            } else if (hud && typeof hud.showFatePreview === 'function' && nextRawLvl) {
                // Title reads "第 {n} 层" / "Floor {n}" using the
                // stage's 1-based order. Level 0 → 1층, level 98 → 99층.
                hud.showFatePreview(nextRawLvl, () => advance(), holdMs, t('level.floor', { n: floorNum }));
            } else {
                this.scheduleOnce(() => advance(), holdMs / 1000);
            }
        };

        // Step 2: scatter animation + level_win SFX + timer move-to-
        // center + font enlarge ALL fire at the same beat (per user
        // spec — sound lands ON the gray-scatter visual and the timer
        // celebration reads as one composed moment). HudController
        // handles the timer piece; its onComplete callback fires after
        // the center-hold (0.3s move + 2s hold = 2.3s) which we use as
        // the trigger for the fate preview modal. Scatter itself is
        // fire-and-forget — it's much shorter than the center hold
        // (~0.6s vs 2.3s), so it finishes well before the fate popup.
        SoundManager.instance?.play('level_win');
        // Fire the timer center animation at the same beat.
        // gameState.levelElapsedSec was frozen the moment running=false
        // was set in maybeFireLevelWin, so it's identical to the value
        // GameController already submitted to the leaderboard.
        const hudAny = this.hudController as any;
        const gs = (this.gameController as any)?.gameState;
        const elapsedSec = gs?.levelElapsedSec ?? 0;
        if (hudAny && typeof hudAny.showLevelClearTime === 'function') {
            hudAny.showLevelClearTime(elapsedSec, showPreview);
        }
        // Scatter runs in parallel — no onDone hook, since
        // showLevelClearTime.onComplete now owns the fate-preview
        // trigger. When HUD isn't wired for showLevelClearTime,
        // fall back to the old scatter-completion → showPreview
        // sequence so the flow still advances.
        if (this.gameController
            && typeof this.gameController.playLevelScatter === 'function') {
            const scatterCb = (hudAny && typeof hudAny.showLevelClearTime === 'function')
                ? () => {
                    // Scatter animation done. Hide the entire boardRoot3D
                    // immediately so nothing re-paints the tower back
                    // during the ~1.7s window between scatter end and
                    // fate preview open. Without this, the per-frame
                    // paint loop syncs cube visibility from gameState
                    // and can flip cubes back on (they were set active=
                    // false one-by-one at scatter tween end, but the
                    // paint pass overrides that). Killing the root wins
                    // that race unconditionally. showPreview later does
                    // the same thing — safe to no-op there once hidden.
                    if (this.boardRoot3D) this.boardRoot3D.active = false;
                }
                : showPreview;
            this.gameController.playLevelScatter(this.exitLevelScatterSec, scatterCb);
        } else if (!(hudAny && typeof hudAny.showLevelClearTime === 'function')) {
            showPreview();
        }
    }

    private makeFailButtons(): Array<{ label: string; action: () => void }> {
        if (this.currentLevelIdx >= 0) {
            return [
                { label: t('result.retry'), action: () => this.startLevel(this.currentLevelIdx) },
                { label: t('result.home'),  action: () => { this.dismissResultPanel(); this.showModeSelect(); } },
            ];
        }
        const retryAction = this.blindModeActive
            ? () => this.startBlind()
            : () => this.startEndless();
        return [
            { label: t('result.endlessRetry'), action: retryAction },
            { label: t('result.home'),         action: () => { this.dismissResultPanel(); this.showModeSelect(); } },
        ];
    }

    // ============================================================
    //  Revive prompt — reuses the authored result panel, shown
    //  BEFORE the regular game-over panel in endless / blind mode
    //  when the one-shot revive is still available.
    // ============================================================
    /** Client-side default; overwritten by the first successful
     *  `fetchReviveCost` response. Used for the button label until
     *  the network round-trip lands. */
    private _reviveGemCost: number = DEFAULT_REVIVE_COST_GEMS;
    /** Countdown seconds for the revive prompt. Set once at open time
     *  and decremented on the interval. */
    private _reviveCountdownSec: number = 0;
    // setInterval's return type resolves to NodeJS.Timeout under some
    // tsconfig lib combos which Cocos 3.8's browser TS doesn't know
    // about; keep as `any` so the compile stays cross-target.
    private _reviveCountdownTimer: any = null;
    /** Guard so the "did the player pick something / did we already
     *  fall through" state is single-shot. Both the countdown callback
     *  and the button callbacks flip this before doing their work; the
     *  loser is a no-op. */
    private _reviveResolved: boolean = false;

    /** Open the revive prompt. `onSkip` runs when the countdown lapses
     *  or an attempted revive fails — the caller's onSkip is expected
     *  to fall back to the regular game-over panel. If the player
     *  successfully revives (ad rewarded or gems spent) the callback
     *  is NOT invoked — the game just resumes. */
    private showRevivePrompt(onSkip: () => void): void {
        this._reviveResolved = false;
        this._reviveCountdownSec = REVIVE_COUNTDOWN_SEC;
        // Kick off the gem-cost fetch in the background so the button
        // label updates from the fallback to the server-authoritative
        // number as soon as it lands. Non-blocking — the button works
        // with the fallback price too; server also re-validates on
        // purchase, so a stale local price is safe.
        void fetchReviveCost()
            .then(r => {
                this._reviveGemCost = r.gems || DEFAULT_REVIVE_COST_GEMS;
                // If prompt is still on screen, repaint the gem button
                // label with the fresh number.
                if (!this._reviveResolved) this._repaintReviveGemButton();
            })
            .catch(err => {
                console.warn('[Revive] fetchReviveCost failed (using default):', String(err?.message ?? err));
            });

        const buttons: Array<{ label: string; action: () => void }> = [
            { label: t('result.reviveAd'), action: () => this._onReviveAdClicked(onSkip) },
            { label: t('result.reviveGems', { n: this._reviveGemCost }),
              action: () => this._onReviveGemsClicked(onSkip) },
        ];
        this.buildResultPanel(
            t('result.reviveTitle'),
            this._reviveCountdownSubtitle(this._reviveCountdownSec),
            buttons,
        );
        this._startReviveCountdown(onSkip);
    }

    private _reviveCountdownSubtitle(sec: number): string {
        return t('result.reviveCountdown', { n: sec });
    }

    private _repaintReviveGemButton(): void {
        // Result panel's gem button is the second one (index 1) — repaint
        // its label without rebuilding the whole panel so an in-flight
        // countdown doesn't reset.
        const btn = this.authoredResultButtons?.[1];
        if (!btn || !btn.node.isValid) return;
        const paired = this.authoredResultButtonLabels?.[1];
        const lab = paired || btn.getComponentInChildren(Label);
        if (lab) lab.string = t('result.reviveGems', { n: this._reviveGemCost });
    }

    private _startReviveCountdown(onSkip: () => void): void {
        this._clearReviveCountdown();
        this._reviveCountdownTimer = setInterval(() => {
            this._reviveCountdownSec--;
            if (this._reviveCountdownSec <= 0) {
                this._clearReviveCountdown();
                if (!this._reviveResolved) {
                    this._reviveResolved = true;
                    // Dismiss the revive prompt and hand off to the
                    // regular fail panel. Silent — expiring the timer
                    // is a normal outcome, not an error.
                    this.dismissResultPanel();
                    onSkip();
                }
                return;
            }
            // Live-update the subtitle only — don't rebuild the panel
            // (would tear down the button click bindings). authored-
            // ResultSubtitleLabel is the direct paint target.
            if (this.authoredResultSubtitleLabel && this.authoredResultSubtitleLabel.node.isValid) {
                this.authoredResultSubtitleLabel.string = this._reviveCountdownSubtitle(this._reviveCountdownSec);
            }
        }, 1000);
    }

    private _clearReviveCountdown(): void {
        if (this._reviveCountdownTimer !== null) {
            clearInterval(this._reviveCountdownTimer);
            this._reviveCountdownTimer = null;
        }
    }

    /** Watch-ad button on the revive prompt. */
    private _onReviveAdClicked(onSkip: () => void): void {
        if (this._reviveResolved) return;
        this._reviveResolved = true;
        this._clearReviveCountdown();
        void (async () => {
            try {
                AnalyticsApi.logCustom('ad_shown', { placement: 'endless_revive' });
                const r = await Providers.ads.showRewardedAd();
                if (r.kind === 'rewarded') {
                    AnalyticsApi.logAdReward({
                        virtualCurrencyName: 'endless_revive',
                        value:               1,
                        placement:           'endless_revive',
                    });
                    // Dismiss the revive prompt first so the tower is
                    // visible under the row-blast sweep, then hand off
                    // to the game controller to play the wipe FX and
                    // fire gameState.reviveEndless() at the end.
                    this.dismissResultPanel();
                    if (this.gameController) {
                        this.gameController.playReviveWipe(() => { /* onDone */ });
                    }
                    return;
                }
                if (r.kind === 'dismissed') {
                    AnalyticsApi.logCustom('ad_dismissed', { placement: 'endless_revive' });
                    // Player closed the ad early — treat as skip and
                    // route to the fail panel.
                    this.dismissResultPanel();
                    onSkip();
                    return;
                }
                console.warn('[Revive] ad error:', r.reason);
                AnalyticsApi.logCustom('ad_error', {
                    placement: 'endless_revive',
                    reason: String(r.reason ?? 'unknown'),
                });
                ToastManager.instance?.show(t('result.reviveAd.failed'));
                this.dismissResultPanel();
                onSkip();
            } catch (e) {
                console.warn('[Revive] showRewardedAd threw:', (e as Error)?.message ?? e);
                ToastManager.instance?.show(t('result.reviveAd.failed'));
                this.dismissResultPanel();
                onSkip();
            }
        })();
    }

    /** Spend-gems button on the revive prompt. */
    private _onReviveGemsClicked(onSkip: () => void): void {
        if (this._reviveResolved) return;
        this._reviveResolved = true;
        this._clearReviveCountdown();
        void (async () => {
            try {
                const r = await purchaseRevive();
                if (r.ok) {
                    // Same sequence as the ad path — hide the prompt
                    // first, then let GameController play the row-blast
                    // sweep and finalize the revive.
                    this.dismissResultPanel();
                    if (this.gameController) {
                        this.gameController.playReviveWipe(() => { /* onDone */ });
                    }
                    return;
                }
                if (r.reason === 'insufficient-gems') {
                    // Not enough gems — send the player straight to the
                    // top-up panel instead of the fail screen. The
                    // player already committed to reviving; a fail
                    // panel + toast tells them "no" without giving
                    // them a way to fix it. Dismiss the revive prompt
                    // first so the top-up panel doesn't render under it.
                    this.dismissResultPanel();
                    ToastManager.instance?.show(t('result.reviveGems.notEnough'));
                    if (this.topUpController) {
                        this.topUpController.show();
                    }
                    // Still route to onSkip so the game state
                    // eventually lands somewhere concrete (fail panel
                    // behind the top-up sheet). When the player
                    // dismisses the top-up sheet they see the game-
                    // over panel underneath and can retry or home.
                    onSkip();
                    return;
                }
                // Any other server rejection — toast + fail panel.
                ToastManager.instance?.show(t('result.reviveGems.failed'));
                this.dismissResultPanel();
                onSkip();
            } catch (e) {
                console.warn('[Revive] purchaseRevive threw:', (e as Error)?.message ?? e);
                ToastManager.instance?.show(t('result.reviveGems.failed'));
                this.dismissResultPanel();
                onSkip();
            }
        })();
    }

    private dismissResultPanel(): void {
        // Authored panel — just hide the shared node, don't destroy.
        if (this.authoredResultPanel) {
            this.authoredResultPanel.active = false;
        }
        // Programmatic panel (only exists if authoredResultPanel is
        // unwired) — destroy since it was created fresh each show.
        if (this.resultPanel) {
            this.resultPanel.destroy();
            this.resultPanel = null;
        }
    }

    /** Populate the authored fail/game-over panel and show it. */
    private showAuthoredResultPanel(
        title: string,
        subtitle: string,
        buttons: Array<{ label: string; action: () => void }>,
    ): void {
        if (!this.authoredResultPanel) return;
        // Auto-add a Dim backdrop (blocks visuals + touches). Shared
        // helper is a no-op if the user authored one already.
        ensureDimBackdrop(this.authoredResultPanel);
        // Title / subtitle text.
        if (this.authoredResultTitleLabel) {
            this.authoredResultTitleLabel.string = title;
        }
        if (this.authoredResultSubtitleLabel) {
            this.authoredResultSubtitleLabel.string = subtitle;
            this.authoredResultSubtitleLabel.node.active = subtitle.length > 0;
        }
        // Summary — endless / blind show 层高, level modes clear it.
        if (this.authoredResultSummaryLabel) {
            const g = this.gameController?.gameState;
            const isHeightMode = g && (g.mode === 'endless' || g.mode === 'blind');
            const summary = isHeightMode
                ? t('hud.heightValue', { n: g!.endlessProgress.cumulative })
                : '';
            this.authoredResultSummaryLabel.string = summary;
            this.authoredResultSummaryLabel.node.active = summary.length > 0;
        }
        // Buttons — activate + wire the first N, hide the rest.
        const N = this.authoredResultButtons.length;
        for (let i = 0; i < N; i++) {
            const btn = this.authoredResultButtons[i];
            if (!btn) continue;
            if (i < buttons.length) {
                btn.node.active = true;
                // Update the button's label. Prefer the paired
                // authoredResultButtonLabels[i] slot when wired; if
                // it's empty, fall back to whatever Label lives inside
                // the button node. Without the fallback, an authored
                // scene default text (typically Chinese "重试" / "主页")
                // would show even after t() rewrote it.
                const lab = this.authoredResultButtonLabels[i]
                    ?? btn.getComponentInChildren(Label);
                if (lab) lab.string = buttons[i].label;
                // Rewire click — off then on so multiple opens don't
                // stack listeners.
                btn.node.off('click');
                const action = buttons[i].action;
                btn.node.on('click', () => action(), this);
            } else {
                btn.node.active = false;
            }
        }
        // Show the panel. Bump to last sibling so any later-added
        // HUD nodes (energy bar etc.) don't render on top of the dim.
        this.authoredResultPanel.setSiblingIndex(999);
        this.authoredResultPanel.active = true;
    }

    /** Leaderboard button — opens the LeaderboardController panel
     *  (currently populated with mock data; backend integration is
     *  pending). Falls back to a console log if the controller isn't
     *  wired so we can still tell the click plumbing is alive. */
    private onLeaderboardClicked(): void {
        if (this.leaderboardController) {
            this.leaderboardController.show('level');
        } else {
            console.log('[MenuController] Leaderboard tapped — controller not wired.');
        }
    }

    /** Backpack button — opens the BackpackController panel. Also
     *  wires the panel's onRenameCardUsed callback so the "使用" of
     *  a rename_card in the backpack closes the panel and hands off
     *  to the nickname editor. Falls back to a console log if the
     *  controller isn't wired. */
    private onBackpackClicked(): void {
        if (this.backpackController) {
            // Wire the rename-card handoff on first open; harmless to
            // re-assign on later opens (same function reference).
            this.backpackController.onRenameCardUsed = () => this.editNicknameViaPrompt();
            this.backpackController.show();
        } else {
            console.log('[MenuController] Backpack tapped — controller not wired.');
        }
    }

    /** Top-up button — opens the TopUpController panel. Falls back
     *  to a console log if the controller isn't wired. */
    private onTopupClicked(): void {
        if (this.topUpController) {
            this.topUpController.show();
        } else {
            console.log('[MenuController] TopUp tapped — controller not wired.');
        }
    }

    /** DEV: wipe LevelProgress + every localStorage key, then reset
     *  the 3D stage's cached `lastShownIdx` so the next level-select
     *  entry rebuilds from level 1 with no collapse. Wiping the whole
     *  localStorage also nukes player identity, tutorial-seen flags,
     *  settings, bearer token, avatar — you're a fresh player next
     *  boot. Restart the preview after clicking so the runtime
     *  singletons (PlayerProfile, TutorialProgress, Settings) don't
     *  keep the in-memory cache. */
    private onResetProgressClicked(): void {
        LevelProgress.reset();
        try {
            sys.localStorage.clear();
        } catch (err) {
            console.warn('[MenuController] localStorage.clear failed:', err);
        }
        if (this.levelStage3D) this.levelStage3D.resetShownState();
        console.log('[MenuController] LevelProgress + localStorage cleared — restart the preview for full effect.');
    }

    /** DEV-only cheat: unlock all mode buttons in one tap.
     *   • Marks level 10 cleared (satisfies ENDLESS_UNLOCK_LEVEL_COUNT
     *     gate so Endless becomes tappable).
     *   • Sets endless-best layers to 100 (satisfies
     *     BLIND_UNLOCK_ENDLESS_LAYERS so Blind + Leaderboard unlock).
     *  Persists both to localStorage and repaints the lock overlays
     *  so the change is visible immediately. */
    /** Show / hide the two DEV entry buttons on the main menu based
     *  on `IS_DEV_BUILD` and the persisted `hideDevButtons` setting.
     *  Called from `wireModeButtons` (initial paint), from the
     *  Settings subscribe (fires when the settings toggle flips), and
     *  from the toggle click handler (immediate paint on same frame).
     *  A release-build call is still safe — both buttons stay off. */
    private _refreshDevButtonsVisibility(): void {
        const on = IS_DEV_BUILD && !getHideDevButtons();
        if (this.modeBtnResetProgress)  this.modeBtnResetProgress.node.active  = on;
        if (this.modeBtnDebugUnlockAll) this.modeBtnDebugUnlockAll.node.active = on;
    }

    private _debugUnlockAllModes(): void {
        // Nudge level progress up to at least 10 clears (idx = 9).
        const targetIdx = MenuController.ENDLESS_UNLOCK_LEVEL_COUNT - 1;
        if (LevelProgress.maxClearedIdx < targetIdx) {
            LevelProgress.markCleared(targetIdx);
        }
        // Nudge endless best up to at least the blind/leaderboard gate.
        if (this._endlessBestLayers < MenuController.BLIND_UNLOCK_ENDLESS_LAYERS) {
            this._endlessBestLayers = MenuController.BLIND_UNLOCK_ENDLESS_LAYERS;
            this._persistEndlessBest();
        }
        this._refreshModeButtonLocks();
        log(`[DEV] unlockAllModes — maxClearedIdx=${LevelProgress.maxClearedIdx}, endlessBest=${this._endlessBestLayers}`);
    }

    /** Attach click handlers + i18n tracking to the manually-authored
     *  mode-select controls that were wired via @property. Any slot
     *  left empty in the inspector just gets skipped — the code path
     *  degrades gracefully. Called from `buildUi` only when
     *  `modeSelectPanel` is set. */
    private wireModeSelectPanel(): void {
        // Labels — register for i18n so language switch retranslates.
        if (this.modeTitleLabel) {
            this.trackI18nLabel(this.modeTitleLabel, 'menu.title');
        }
        if (this.modeSubtitleLabel) {
            this.trackI18nLabel(this.modeSubtitleLabel, 'menu.subtitle');
        }
        // Buttons — bind click handlers + retranslate their child labels.
        const bindBtn = (btn: Button | null, key: string, onClick: () => void) => {
            if (!btn) return;
            btn.node.on('click', onClick, this);
            const lab = btn.getComponentInChildren(Label);
            if (lab && key) this.trackI18nLabel(lab, key);
        };
        bindBtn(this.modeBtnEndless,       'menu.endless', () => {
            if (this._isEndlessUnlocked()) this.enterEndless();
            else {
                // Forward stage numbering — player needs to clear
                // through Stage `ENDLESS_UNLOCK_LEVEL_COUNT` (default
                // 10) to unlock endless. "Reach floor 10 to unlock
                // Endless" reads naturally.
                this._showLockToast(t('lock.endless', {
                    n: MenuController.ENDLESS_UNLOCK_LEVEL_COUNT,
                }));
            }
        });
        bindBtn(this.modeBtnLevel,         'menu.levels',      () => this.showLevelSelect());
        bindBtn(this.modeBtnBlind,         'menu.blind', () => {
            if (this._isBlindOrLbUnlocked()) this.enterBlindMode();
            else this._showLockToast(t('lock.blind', { n: MenuController.BLIND_UNLOCK_ENDLESS_LAYERS }));
        });
        // Locked-state Blind Sprite is decoration-only — clicks are
        // still handled by the regular modeBtnBlind Button (which sits
        // behind or beside it) and shows the lock toast when locked.
        bindBtn(this.modeBtnLeaderboard,   'menu.leaderboard', () => {
            if (this._isBlindOrLbUnlocked()) this.onLeaderboardClicked();
            else this._showLockToast(t('lock.leaderboard', { n: MenuController.BLIND_UNLOCK_ENDLESS_LAYERS }));
        });
        bindBtn(this.modeBtnSettings,      'settings.button',  () => this.openSettingsPanel());
        // Main-page top-up (recharge) button — opens the TopUp panel.
        // Passes `null` key so bindBtn doesn't retranslate the button
        // label (it's a numeric balance, not an i18n string).
        if (this.modeBtnTopup) {
            this.modeBtnTopup.node.off('click');
            this.modeBtnTopup.node.on('click', () => this.onTopupClicked(), this);
        }
        // Backpack button: opens the BackpackController panel + wires
        // its rename-card handoff to the nickname editor.
        if (this.modeBtnBackpack) {
            this.modeBtnBackpack.node.off('click');
            this.modeBtnBackpack.node.on('click', () => this.onBackpackClicked(), this);
        }
        // Reset progress button + Unlock-all button: DEV-only. Hidden
        // in release builds so players can't nuke their own save by
        // accident. IS_DEV_BUILD is set per branch — see
        // assets/scripts/core/BuildConfig.ts.
        //
        // Even on dev, a settings toggle ("隐藏 DEV 按钮") lets the
        // developer temporarily hide them for screenshots / recordings.
        // Wired via `_refreshDevButtonsVisibility` + a Settings
        // subscribe so a settings-panel toggle repaints immediately.
        if (IS_DEV_BUILD) {
            bindBtn(this.modeBtnResetProgress, 'menu.reset',   () => this.onResetProgressClicked());
            bindBtn(this.modeBtnDebugUnlockAll, 'menu.unlockAll', () => this._debugUnlockAllModes());
        }
        this._refreshDevButtonsVisibility();
        subscribeSettings(() => this._refreshDevButtonsVisibility());
        // Badge-collection button (top-right of the level-select
        // stage). Panel is TODO — the click currently logs a marker
        // so it's easy to spot in analytics that the entry point is
        // being used before the panel ships.
        if (this.authoredBadgeCollectionButton) {
            this.authoredBadgeCollectionButton.node.off('click');
            this.authoredBadgeCollectionButton.node.on('click', () => {
                log('[MenuController] badge collection button clicked — panel not yet implemented');
            }, this);
        }
        // Initial paint of lock state — showModeSelect will refresh on
        // subsequent shows as progress changes.
        this._loadEndlessBestFromStorage();
        this._refreshModeButtonLocks();
    }

    // ============================================================
    //  Progressive-unlock helpers
    //  Endless mode gated behind 10 Level clears.
    //  Blind mode + Leaderboard gated behind 100 endless layers.
    // ============================================================

    private _isEndlessUnlocked(): boolean {
        return LevelProgress.maxClearedIdx >= (MenuController.ENDLESS_UNLOCK_LEVEL_COUNT - 1);
    }

    private _isBlindOrLbUnlocked(): boolean {
        return this._endlessBestLayers >= MenuController.BLIND_UNLOCK_ENDLESS_LAYERS;
    }

    private _loadEndlessBestFromStorage(): void {
        try {
            const raw = sys.localStorage?.getItem(MenuController.ENDLESS_BEST_KEY);
            const n = raw ? parseInt(raw, 10) : 0;
            if (Number.isFinite(n) && n > this._endlessBestLayers) {
                this._endlessBestLayers = n;
            }
        } catch { /* localStorage denied — memory-only */ }
    }

    private _persistEndlessBest(): void {
        try {
            sys.localStorage?.setItem(MenuController.ENDLESS_BEST_KEY, String(this._endlessBestLayers));
        } catch { /* ignore */ }
    }

    /** Called from showGameOver right after an endless/blind run so a
     *  fresh personal best updates the unlock state immediately,
     *  without waiting for the next fetchProfile round-trip. */
    private _recordEndlessRun(layers: number): void {
        if (!Number.isFinite(layers) || layers <= 0) return;
        if (layers <= this._endlessBestLayers) return;
        this._endlessBestLayers = layers;
        this._persistEndlessBest();
        this._refreshModeButtonLocks();
    }

    /** Repaint mode-select buttons + labels to reflect current unlock
     *  state. Locked buttons stay clickable (so we can show a tip)
     *  but their sprite + label are dimmed. */
    /** Cache of each button's original (unlocked) SpriteFrame — captured
     *  the first time we see the button, so swapping to the gray locked
     *  sprite and later restoring the original never loses the reference. */
    private _btnOriginalSprite: Map<Button, SpriteFrame | null> = new Map();

    private _refreshModeButtonLocks(): void {
        // Sprite tinting is intentionally NOT touched — scene author supplies
        // pre-baked gray art. When locked, the Sprite's spriteFrame is
        // swapped to `authoredXxxLockedSprite`; when unlocked, restored
        // from the cached original. Label color still dims for extra clarity.
        // Per-mode unlocked label color (locked = gray for all).
        // Design brief: Endless = #D6D7E4, Blind = #D8DBE7, others = white.
        const COL_LOCKED = new Color(160, 160, 160, 255);
        const COL_DEFAULT_UNLOCKED = new Color(255, 255, 255, 255);
        const paintLock = (
            btn: Button | null,
            unlocked: boolean,
            lockedSpr: SpriteFrame | null,
            unlockedColor: Color = COL_DEFAULT_UNLOCKED,
        ): void => {
            if (!btn) return;
            const spr = btn.getComponent(Sprite);
            if (spr) {
                // Capture original once (before we ever overwrite it).
                if (!this._btnOriginalSprite.has(btn)) {
                    this._btnOriginalSprite.set(btn, spr.spriteFrame);
                }
                const orig = this._btnOriginalSprite.get(btn) ?? null;
                const next = unlocked ? orig : (lockedSpr ?? orig);
                if (spr.spriteFrame !== next) spr.spriteFrame = next;
            }
            const lab = btn.getComponentInChildren(Label);
            if (lab) lab.color = unlocked ? unlockedColor : COL_LOCKED;
        };
        const COL_ENDLESS = new Color(0xD6, 0xD7, 0xE4, 255);   // #D6D7E4
        const COL_BLIND   = new Color(0xD8, 0xDB, 0xE7, 255);   // #D8DBE7
        paintLock(this.modeBtnEndless,     this._isEndlessUnlocked(),     this.modeBtnEndlessLocked,          COL_ENDLESS);
        paintLock(this.modeBtnBlind,       this._isBlindOrLbUnlocked(),   this.authoredBlindLockedSprite,     COL_BLIND);
        paintLock(this.modeBtnLeaderboard, this._isBlindOrLbUnlocked(),   this.authoredLeaderboardLockedSprite);
    }

    /** Show the lock-tip toast. Preferred path is the unified
     *  ToastManager (drag one ToastManager component into the scene
     *  and wire its bgPositive / bgNegative SpriteFrames); locked-
     *  feature tips are "error"-flavoured. Falls back to the older
     *  `authoredLockToastNode` slot, then to a self-built floating
     *  label if nothing is wired. */
    private _showLockToast(text: string): void {
        console.log('[Lock] ' + text);
        // ---- Preferred path: unified ToastManager ----
        if (ToastManager.instance) {
            ToastManager.instance.error(text);
            return;
        }
        // ---- Legacy path: authored lock-toast node ----
        const authored = this.authoredLockToastNode;
        if (authored && authored.isValid) {
            // Write label text.
            let lab = this.authoredLockToastLabel;
            if (!lab) lab = authored.getComponentInChildren(Label);
            if (lab) lab.string = text;
            // Re-parent to Canvas root so the toast stays visible even if
            // the authored panel it lives under gets deactivated mid-game.
            if (authored.parent !== this.node) {
                authored.parent = this.node;
                authored.layer = this.node.layer;
            }
            authored.setSiblingIndex(9999);
            authored.active = true;
            // Fade in → hold → fade out via a UIOpacity component.
            let op = authored.getComponent(UIOpacity);
            if (!op) op = authored.addComponent(UIOpacity);
            op.opacity = 0;
            tween<UIOpacity>(op)
                .to(0.15, { opacity: 255 })
                .delay(1.6)
                .to(0.3, { opacity: 0 })
                .call(() => { if (authored && authored.isValid) authored.active = false; })
                .start();
            return;
        }
        // ---- Fallback: build an ad-hoc floating toast ----
        const parent = this.node;
        if (!parent) { console.log(`[Lock] ${text}`); return; }
        const n = new Node('LockToast');
        n.parent = parent;
        n.layer  = parent.layer;
        const tx = n.addComponent(UITransform);
        tx.setContentSize(500, 60);
        tx.setAnchorPoint(0.5, 0.5);
        n.setPosition(0, -400, 0);
        n.setSiblingIndex(9999);
        const gfx = n.addComponent(Graphics);
        gfx.fillColor = new Color(0, 0, 0, 200);
        gfx.roundRect(-250, -30, 500, 60, 10);
        gfx.fill();
        const labNode = new Node('Label');
        labNode.parent = n;
        labNode.layer  = n.layer;
        const labTx = labNode.addComponent(UITransform);
        labTx.setContentSize(480, 60);
        labTx.setAnchorPoint(0.5, 0.5);
        const lab = labNode.addComponent(Label);
        lab.string   = text;
        lab.fontSize = 22;
        lab.color    = new Color(255, 255, 255, 255);
        lab.horizontalAlign = Label.HorizontalAlign.CENTER;
        lab.verticalAlign   = Label.VerticalAlign.CENTER;
        const op = n.addComponent(UIOpacity);
        op.opacity = 0;
        tween<UIOpacity>(op)
            .to(0.15, { opacity: 255 })
            .delay(1.6)
            .to(0.3, { opacity: 0 })
            .call(() => { if (n && n.isValid) n.destroy(); })
            .start();
    }

    private setGameplayVisible(on: boolean): void {
        // CRITICAL: never touch `this.hudController.node.active` directly —
        // when HudController shares its host node with MenuController
        // (typically both attached to Canvas), disabling the host node
        // hides EVERYTHING including the menu we're trying to show. Use
        // HudController.setHudVisible(on) which only toggles HUD-owned
        // child nodes.
        if (this.hudController) this.hudController.setHudVisible(on);
        if (this.boardRoot3D)   this.boardRoot3D.active = on;
        // Level-select 2D overlay (LevelMode container): back arrow /
        // progress bar / badges. Must be off during gameplay so the
        // stage-select chrome doesn't hang over the play field, and
        // off on the mode-select screen so it doesn't leak in behind
        // the main menu. Only ever ON while the 3D level-select stage
        // is showing (see showLevelSelectStage which re-enables it).
        //
        // Belt-and-suspenders — hide BOTH the container (preferred,
        // covers the whole overlay at once) AND every individual
        // authored piece (rescues the case where the author didn't
        // wire `authoredLevelSelectOverlay` yet). Every leaf setter is
        // guarded against null so unwired fields silently no-op.
        if (on) {
            if (this.authoredLevelSelectOverlay) this.authoredLevelSelectOverlay.active = false;
            // Also hide each authored leaf AND its immediate parent —
            // the parent is typically the progress-bar background /
            // frame container, which the leaf alone doesn't cover.
            const hideNodeAndParent = (n: Node | null | undefined) => {
                if (!n || !n.isValid) return;
                n.active = false;
                if (n.parent && n.parent.isValid) n.parent.active = false;
            };
            if (this.authoredFatePieceProgressFill)  hideNodeAndParent(this.authoredFatePieceProgressFill.node);
            if (this.authoredFatePieceProgressLabel) hideNodeAndParent(this.authoredFatePieceProgressLabel.node);
            if (this.authoredBadgesRoot)             hideNodeAndParent(this.authoredBadgesRoot);
            if (this.authoredBadgeCountLabel)        hideNodeAndParent(this.authoredBadgeCountLabel.node);
            if (this.authoredBadgeCollectionButton)  hideNodeAndParent(this.authoredBadgeCollectionButton.node);
        }
        // Sync the on-screen action buttons (rotate L/R / hard-drop /
        // rotate-piece) with gameplay visibility — they should never
        // show on the level-select or main-menu screens.
        if (this.gameController
            && typeof (this.gameController as any).setGameplayUiVisible === 'function') {
            (this.gameController as any).setGameplayUiVisible(on);
        }
        // Mirror the bg quad's visibility so the menu screens still get
        // a clean dark backdrop while gameplay scenes show the sky / temple art.
        if (this.backgroundController) this.backgroundController.setVisible(on);
        // Tower-base mist disabled per design — hard-force off regardless
        // of `on`. Keep the property wired so removing this line later
        // (to re-enable) doesn't need editor scene surgery.
        if (this.towerBaseMist) this.towerBaseMist.setVisible(false);
        if (this.backgroundCubes) this.backgroundCubes.setVisible(on);
        // Twinkle stars only belong to the level-select screen, so
        // hide them any time gameplay comes up. showLevelSelect()
        // turns them back on explicitly.
        if (on && this.twinkleStars) this.twinkleStars.setVisible(false);
    }

    // ============================================================
    //  UI construction
    // ============================================================
    private buildUi(): void {
        // Script is attached to the Canvas — `this.node` is the Canvas.
        const root = this.node;
        const tx = root.getComponent(UITransform);
        const w = tx?.contentSize.width  ?? 750;
        const h = tx?.contentSize.height ?? 1334;

        // ---------- Mode-select panel ----------
        // Manually authored in the scene — the inspector-wired panel
        // + button/label refs get click handlers + i18n tracking. If
        // `modeSelectPanel` is unwired, log and skip; the menu will
        // simply be non-functional until the scene is fixed.
        if (this.modeSelectPanel) {
            this.wireModeSelectPanel();
        } else {
            log('[MenuController] modeSelectPanel is not wired in the scene — main menu will not appear.');
        }

        // Level-select page is fully owned by `levelStage3D` (a 3D
        // tower rendered by LevelSelectStage3D). No 2D panel needed
        // here — showLevelSelect() just toggles the stage on/off.
    }

    /** Construct a centred modal overlay with a title, summary, and a row of
     *  buttons. The overlay sits on top of the game scene — it doesn't hide
     *  the 3D so the player still sees their final tower state. */
    private buildResultPanel(
        title: string,
        subtitle: string,
        buttons: Array<{ label: string; action: () => void }>,
    ): void {
        this.dismissResultPanel();   // ensure only one result panel exists

        // Authored (Sprite-based) path — if the user wired the scene
        // nodes, populate them and skip programmatic construction.
        if (this.authoredResultPanel) {
            this.showAuthoredResultPanel(title, subtitle, buttons);
            return;
        }

        const root = this.node;
        const tx = root.getComponent(UITransform);
        const w = tx?.contentSize.width  ?? 750;
        const h = tx?.contentSize.height ?? 1334;

        const panel = new Node('ResultPanel');
        panel.parent = root;
        panel.layer = root.layer;
        const panelTx = panel.addComponent(UITransform);
        panelTx.contentSize.set(w, h);
        panel.setPosition(0, 0, 0);
        this.resultPanel = panel;

        // Dim background.
        const bg = new Node('Dim');
        bg.parent = panel;
        bg.layer = panel.layer;
        const bgTx = bg.addComponent(UITransform);
        bgTx.contentSize.set(w, h);
        bg.setPosition(0, 0, 0);
        const dim = bg.addComponent(Graphics);
        dim.fillColor = new Color(0, 0, 0, 180);
        dim.rect(-w / 2, -h / 2, w, h);
        dim.fill();

        // Modal card.
        const cardW = w * 0.78;
        const cardH = 480;
        const card = new Node('Card');
        card.parent = panel;
        card.layer = panel.layer;
        const cardTx = card.addComponent(UITransform);
        cardTx.contentSize.set(cardW, cardH);
        card.setPosition(0, 0, 0);
        const cardG = card.addComponent(Graphics);
        cardG.fillColor = new Color(45, 45, 60, 245);
        cardG.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, 24);
        cardG.fill();
        cardG.strokeColor = new Color(120, 120, 150, 255);
        cardG.lineWidth = 3;
        cardG.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, 24);
        cardG.stroke();

        // Title + subtitle + summary.
        this.makeLabel('Title', card, 0, cardH * 0.32, title, 64, [0.5, 0.5]);
        if (subtitle) this.makeLabel('Subtitle', card, 0, cardH * 0.18, subtitle, 26, [0.5, 0.5]);

        // Result summary — endless / blind show 层高 (cumulative full
        // rows / tower height). Level / collect runs no longer show
        // any stat (score, lines, speed tier all removed per the
        // latest UI simplification request).
        const g = this.gameController?.gameState;
        const isHeightMode = g && (g.mode === 'endless' || g.mode === 'blind');
        const summary = isHeightMode
            ? `层高  ${g!.endlessProgress.cumulative}`
            : '';
        if (summary) {
            this.makeLabel('Summary', card, 0, cardH * 0.0, summary, 30, [0.5, 0.5]);
        }

        // Button row.
        const btnW = Math.min(180, (cardW - 60) / buttons.length - 20);
        const btnH = 80;
        const totalBtnW = btnW * buttons.length + 20 * (buttons.length - 1);
        const btnY = -cardH * 0.32;
        const startX = -totalBtnW / 2 + btnW / 2;
        for (let i = 0; i < buttons.length; i++) {
            const b = buttons[i];
            const x = startX + i * (btnW + 20);
            // Result-panel buttons — cycle through neon palette so multiple
            // actions (Retry / Home / Next) are visually distinct.
            const colors = [
                new Color(78, 220, 181, 255),    // NEON_MINT
                new Color(185, 104, 245, 255),   // NEON_PURPLE
                new Color(255, 201, 60, 255),    // NEON_GOLD
                new Color(255, 59, 124, 255),    // NEON_MAGENTA
            ];
            this.makeButton(`ResBtn_${i}`, card, x, btnY, btnW, btnH,
                b.label, colors[i % colors.length], b.action);
        }
    }

    /** Called once at boot after audio managers register their instances.
     *  Pushes the persisted BGM / SFX volumes (loaded from localStorage
     *  by Settings.ts) into the live managers so the user's chosen level
     *  and mute-state carry across sessions. Safe if either manager is
     *  missing. */
    private applyPersistedAudioSettings(): void {
        const bgm = BgmManager.instance;
        if (bgm) {
            const v = getBgmVolume();
            bgm.setEnabled(v > 0);
            bgm.setMasterVolume(v);
        }
        const sfx = SoundManager.instance;
        if (sfx) {
            const v = getSfxVolume();
            sfx.setEnabled(v > 0);
            sfx.setMasterVolume(v);
        }
    }

    /** Settings modal. Lazily built (rebuilt every time) so values
     *  always reflect the latest store state without having to wire
     *  Settings.subscribe() listeners to long-lived nodes. */
    private settingsPanel: Node | null = null;

    private _settingsBack = (): void => { this.closeSettingsPanel(); };
    private openSettingsPanel(): void {
        // Authored (Sprite-based) path.
        if (this.authoredSettingsPanel) {
            if (!this._settingsAuthoredWired) {
                this.wireAuthoredSettingsPanel();
                this._settingsAuthoredWired = true;
            }
            this.refreshAuthoredSettingsValues();
            ensureDimBackdrop(this.authoredSettingsPanel);
            this.authoredSettingsPanel.setSiblingIndex(999);
            this.authoredSettingsPanel.active = true;
            BackKeyManager.push(this._settingsBack);
            return;
        }
        // If already open, do nothing.
        if (this.settingsPanel && this.settingsPanel.isValid) return;

        const root = this.node;
        const tx = root.getComponent(UITransform);
        const w = tx ? tx.contentSize.width  : 750;
        const h = tx ? tx.contentSize.height : 1334;

        // Dark backdrop that intercepts clicks.
        const panel = new Node('SettingsPanel');
        panel.parent = root;
        panel.layer = root.layer;
        const panelTx = panel.addComponent(UITransform);
        panelTx.setContentSize(w, h);
        panel.setPosition(0, 0, 0);
        const dim = panel.addComponent(Graphics);
        dim.fillColor = new Color(0, 0, 0, 180);
        dim.rect(-w / 2, -h / 2, w, h);
        dim.fill();
        // Make the backdrop tappable so taps outside the card dismiss
        // the panel.
        const dimBtn = panel.addComponent(Button);
        dimBtn.transition = Button.Transition.NONE;
        panel.on(Button.EventType.CLICK, () => this.closeSettingsPanel(), this);

        // Centred card. Add a Button on the card so its own clicks
        // don't bubble to the backdrop (which would dismiss).
        const cardW = Math.min(w * 0.85, 560);
        // 5 rows (语言 / 手势 / 虚拟按键 / BGM / SFX) + 标题 + 关闭 →
        // 720 tall clears the layout without cramping.
        const cardH = 720;
        const card = new Node('Card');
        card.parent = panel;
        card.layer = panel.layer;
        const cardTx = card.addComponent(UITransform);
        cardTx.setContentSize(cardW, cardH);
        card.setPosition(0, 0, 0);
        const cardBg = card.addComponent(Graphics);
        cardBg.fillColor = new Color(20, 25, 44, 250);   // CARD_INNER neon-dark
        cardBg.roundRect(-cardW / 2, -cardH / 2, cardW, cardH, 28);
        cardBg.fill();
        const cardBtn = card.addComponent(Button);
        cardBtn.transition = Button.Transition.NONE;
        // Swallow clicks on the card itself (no-op handler).
        card.on(Button.EventType.CLICK, () => {/* swallow */}, this);

        // Title
        this.trackI18nLabel(
            this.makeLabel('Title', card, 0, cardH * 0.40, '', 44, [0.5, 0.5]),
            'settings.title',
        );

        // Row helper: returns the value button so we can re-render its
        // label when state cycles.
        const ROW_H = 72;
        const ROW_GAP = 20;
        const LABEL_X = -cardW / 2 + 32;
        const VALUE_BTN_W = 220;
        const VALUE_BTN_X = cardW / 2 - VALUE_BTN_W / 2 - 32;
        const firstRowY = cardH * 0.20;

        const makeRow = (
            idx: number,
            i18nLabelKey: string,
            initialValueLabel: string,
            onClick: () => string,
        ): Node => {
            const y = firstRowY - idx * (ROW_H + ROW_GAP);
            // Left-aligned settings name.
            const lab = this.makeLabel(
                `Lab_${i18nLabelKey}`, card,
                LABEL_X, y,
                '', 32, [0, 0.5],
            );
            this.trackI18nLabel(lab, i18nLabelKey);
            // Right-side value button — click cycles state, then we
            // re-render the new label.
            const btn = this.makeButton(
                `Val_${i18nLabelKey}`, card,
                VALUE_BTN_X, y, VALUE_BTN_W, 56,
                initialValueLabel, new Color(185, 104, 245, 235),   // NEON_PURPLE
                () => {
                    const newText = onClick();
                    const valLab = btn.getComponentInChildren(Label);
                    if (valLab) valLab.string = newText;
                },
            );
            return btn;
        };

        // Row 0: language. Value shows current lang token + ▼ so it
        // reads as tappable (cycles through the language list).
        makeRow(0, 'settings.lang', `${t('lang.toggle')} ▼`, () => {
            cycleLang();
            return `${t('lang.toggle')} ▼`;
        });

        // Row 1: background-music volume — cycles through 5 steps
        //   [关 / 25% / 50% / 75% / 100%]. 0 volume also flips the mode
        //   to 'off' internally so the on/off API stays consistent.
        //   Every tap live-applies to BgmManager so the player hears the
        //   change without leaving the settings panel.
        const audioLabel = (v: number): string =>
            v <= 0 ? t('audio.off') : t('audio.percent', { n: Math.round(v * 100) });
        makeRow(1, 'settings.bgm', audioLabel(getBgmVolume()), () => {
            const v = cycleBgmVolume();
            const bgm = BgmManager.instance;
            if (bgm) {
                bgm.setEnabled(v > 0);
                bgm.setMasterVolume(v);
            }
            return audioLabel(v);
        });

        // Row 2: sound-effect volume — same 5-step pattern via SoundManager.
        makeRow(2, 'settings.sfx', audioLabel(getSfxVolume()), () => {
            const v = cycleSfxVolume();
            const sfx = SoundManager.instance;
            if (sfx) {
                sfx.setEnabled(v > 0);
                sfx.setMasterVolume(v);
            }
            return audioLabel(v);
        });

        // Close button (bottom).
        const closeBtn = this.makeButton(
            'BtnClose', card,
            0, -cardH * 0.36, 240, 64,
            t('settings.close'), new Color(160, 170, 204, 255),
            () => this.closeSettingsPanel(),
        );
        const closeLab = closeBtn.getComponentInChildren(Label);
        if (closeLab) this.trackI18nLabel(closeLab, 'settings.close');

        this.settingsPanel = panel;
    }

    private closeSettingsPanel(): void {
        BackKeyManager.pop(this._settingsBack);
        // Authored panel is shared — just hide, don't destroy.
        if (this.authoredSettingsPanel) {
            this.authoredSettingsPanel.active = false;
            return;
        }
        if (this.settingsPanel && this.settingsPanel.isValid) {
            this.settingsPanel.destroy();
        }
        this.settingsPanel = null;
    }

    /** Wire authored settings-panel handlers. Idempotent via
     *  _settingsAuthoredWired guard. Layout:
     *    row 0 → language button (cycle)
     *    BGM   → slider (drag), value shows in row 1's value Label
     *    SFX   → slider (drag), value shows in row 2's value Label
     *  Row buttons 1/2 are still wired as a fallback (in case the
     *  designer wants a mute/unmute tap on the row) — they cycle
     *  through the 5 discrete steps. */
    private _settingsAuthoredWired: boolean = false;
    private wireAuthoredSettingsPanel(): void {
        // ---- i18n on all the static labels in the panel ----
        // Row LEFT labels — "语言" / "音乐" / "音效" default text lives
        // in the scene; overwrite it with the current-lang string.
        const leftKeys: Array<string | null> = ['settings.lang', 'settings.bgm', 'settings.sfx'];
        for (let i = 0; i < leftKeys.length; i++) {
            const key = leftKeys[i];
            const lab = this.authoredSettingsRowLeftLabels[i];
            if (lab && key) this.trackI18nLabel(lab, key);
        }
        // Close button.
        if (this.authoredSettingsCloseButton) {
            this.authoredSettingsCloseButton.node.off('click');
            this.authoredSettingsCloseButton.node.on('click', () => this.closeSettingsPanel(), this);
            // Inner label — same defaulted-in-scene problem.
            const closeLab = this.authoredSettingsCloseButton.getComponentInChildren(Label);
            if (closeLab) this.trackI18nLabel(closeLab, 'settings.close');
        }
        // Balance button — click closes settings + opens top-up panel.
        // Label text is filled by refreshAuthoredSettingsValues (async
        // fetch, paints cached value first + real value when it lands).
        if (this.authoredSettingsBalanceButton) {
            this.authoredSettingsBalanceButton.node.off('click');
            this.authoredSettingsBalanceButton.node.on('click', () => this.onBalanceButtonClicked(), this);
        }
        // Row button click helper — cycle the setting, then re-render.
        const wireBtn = (idx: number, onClick: () => void): void => {
            const btn = this.authoredSettingsRowButtons[idx];
            if (!btn) return;   // silent — buttons 1/2 are optional now.
            btn.node.off('click');
            btn.node.on('click', () => {
                onClick();
                this.refreshAuthoredSettingsValues();
            }, this);
        };
        // Row 0: language — opens the pull-up picker instead of
        // cycling through languages one at a time. Falls back to
        // cycleLang() if the picker panel isn't wired.
        wireBtn(0, () => this.openLangPicker());
        // Row 1 (optional fallback): BGM cycle.
        wireBtn(1, () => {
            const v = cycleBgmVolume();
            const bgm = BgmManager.instance;
            if (bgm) {
                bgm.setEnabled(v > 0);
                bgm.setMasterVolume(v);
            }
        });
        // Row 2 (optional fallback): SFX cycle.
        wireBtn(2, () => {
            const v = cycleSfxVolume();
            const sfx = SoundManager.instance;
            if (sfx) {
                sfx.setEnabled(v > 0);
                sfx.setMasterVolume(v);
            }
        });

        // UNIFIED master-volume slider. Per design the settings panel
        // now exposes ONE volume slider that drives BGM + SFX together
        // at the same value. Both @property slots stay wired for
        // backward compat with existing scenes; dragging either one
        // updates both volumes + keeps the other slider's UI in sync,
        // so scene authors can safely delete whichever one they don't
        // want on-screen. Fill widgets + value labels for both rows
        // also stay in sync (single value → mirror on both).
        const applyMasterVolume = (v: number, source: 'bgm' | 'sfx'): void => {
            v = Math.max(0, Math.min(1, v));
            // Persist to both channels' storage keys so a reboot
            // restores the same volume in either lookup path.
            setBgmVolume(v, false);
            setSfxVolume(v, false);
            const bgm = BgmManager.instance;
            if (bgm) { bgm.setEnabled(v > 0); bgm.setMasterVolume(v); }
            const sfx = SoundManager.instance;
            if (sfx) { sfx.setEnabled(v > 0); sfx.setMasterVolume(v); }
            // Sync the OTHER slider's progress (skip the one being
            // dragged — Cocos would fight the finger position).
            if (source !== 'bgm' && this.authoredSettingsBgmSlider) {
                this.authoredSettingsBgmSlider.progress = v;
            }
            if (source !== 'sfx' && this.authoredSettingsSfxSlider) {
                this.authoredSettingsSfxSlider.progress = v;
            }
            // Mirror value label + fill for BOTH rows if they're wired.
            const labStr = this.formatAudioLabel(v);
            const bgmLab = this.authoredSettingsRowValueLabels[1];
            const sfxLab = this.authoredSettingsRowValueLabels[2];
            if (bgmLab) bgmLab.string = labStr;
            if (sfxLab) sfxLab.string = labStr;
            if (this.authoredSettingsBgmFill) this.authoredSettingsBgmFill.fillRange = v;
            if (this.authoredSettingsSfxFill) this.authoredSettingsSfxFill.fillRange = v;
        };
        if (this.authoredSettingsBgmSlider) {
            const sliderNode = this.authoredSettingsBgmSlider.node;
            sliderNode.off('slide');
            sliderNode.on('slide', () => {
                const s = this.authoredSettingsBgmSlider;
                if (s) applyMasterVolume(s.progress, 'bgm');
            }, this);
        }
        if (this.authoredSettingsSfxSlider) {
            const sliderNode = this.authoredSettingsSfxSlider.node;
            sliderNode.off('slide');
            sliderNode.on('slide', () => {
                const s = this.authoredSettingsSfxSlider;
                if (s) applyMasterVolume(s.progress, 'sfx');
            }, this);
        }

        // ---- Nickname edit ----
        // Save trigger: EditBox "editing-return" (Done key on the
        // on-screen keyboard). Writes to PlayerProfile so future
        // score submissions carry the new name.
        if (this.authoredSettingsNicknameEditBox) {
            const ebNode = this.authoredSettingsNicknameEditBox.node;
            ebNode.off('editing-return');
            ebNode.on('editing-return',
                () => this.saveNicknameFromEditBox(), this);
        }

        // ---- Nickname edit button — opens prompt modal ----
        if (this.authoredSettingsNicknameButton) {
            this.authoredSettingsNicknameButton.node.off('click');
            this.authoredSettingsNicknameButton.node.on('click',
                () => this.editNicknameViaPrompt(), this);
        }

        // ---- Account info button — copy nickname + uuid to clipboard ----
        if (this.authoredSettingsAccountButton) {
            this.authoredSettingsAccountButton.node.off('click');
            this.authoredSettingsAccountButton.node.on('click',
                () => this.copyPlayerIdentity(), this);
        }

        // ---- Avatar button — opens the picker ----
        if (this.authoredSettingsAvatarButton) {
            this.authoredSettingsAvatarButton.node.off('click');
            this.authoredSettingsAvatarButton.node.on('click',
                () => this.openAvatarPicker(), this);
        }
        // ---- Wire the avatar picker (idempotent) ----
        this.wireAvatarPicker();

        // ---- Google / Apple linked buttons ----
        // Buttons swap between "未绑定"（灰）/ "已绑定"（绿）SpriteFrames.
        // Click currently just logs — bind/unbind flow lands later.
        if (this.authoredSettingsGoogleButton) {
            const btn = this.authoredSettingsGoogleButton;
            btn.node.off('click');
            btn.node.on('click', () => this.handleGoogleBindClick(), this);
        }
        if (this.authoredSettingsAppleButton) {
            const btn = this.authoredSettingsAppleButton;
            btn.node.off('click');
            btn.node.on('click', () => {
                log('[Settings] Apple button clicked — bind/unbind flow TODO');
                this.refreshAuthoredSettingsValues();
            }, this);
        }
        // Legacy toggle bindings kept for backward compat — a scene that
        // still uses the Toggle version will still update on click.
        if (this.authoredSettingsGoogleToggle) {
            const tg = this.authoredSettingsGoogleToggle;
            tg.node.off('toggle');
            tg.node.on('toggle', () => {
                log(`[Settings] Google toggle → ${tg.isChecked} — legacy path`);
                this.refreshAuthoredSettingsValues();
            }, this);
        }
        if (this.authoredSettingsAppleToggle) {
            const tg = this.authoredSettingsAppleToggle;
            tg.node.off('toggle');
            tg.node.on('toggle', () => {
                log(`[Settings] Apple toggle → ${tg.isChecked} — legacy path`);
                this.refreshAuthoredSettingsValues();
            }, this);
        }

        // ---- Haptic feedback toggle ----
        // On/off flips Settings.hapticMode which HapticsManager reads
        // live on every impact call. Fires a preview 'medium' impact
        // when turned ON so the player feels the change without needing
        // to trigger gameplay.
        if (this.authoredSettingsHapticToggle) {
            const ht = this.authoredSettingsHapticToggle;
            ht.node.off('toggle');
            ht.node.on('toggle', () => {
                setHapticMode(ht.isChecked ? 'on' : 'off');
                log(`[Settings] haptic → ${ht.isChecked ? 'on' : 'off'}`);
                if (ht.isChecked) HapticsManager.impact('medium');
            }, this);
        }

        // ---- 隐藏 DEV 按钮 (develop-only) ----
        // Hide-in-release: whole row is set inactive when not on dev
        // so channel builds don't show the checkbox at all. On dev,
        // toggling the checkbox persists via Settings + broadcasts to
        // MenuController (main-menu buttons) and HudController (speed
        // button) which re-check `getHideDevButtons()` on their next
        // paint cycle.
        if (this.authoredSettingsHideDevRow) {
            this.authoredSettingsHideDevRow.active = IS_DEV_BUILD;
        } else {
            // No row-container wired — try to hide the label + toggle
            // individually so the release build stays clean.
            if (!IS_DEV_BUILD) {
                if (this.authoredSettingsHideDevToggle) this.authoredSettingsHideDevToggle.node.active = false;
                if (this.authoredSettingsHideDevLabel)  this.authoredSettingsHideDevLabel.node.active  = false;
            }
        }
        if (this.authoredSettingsHideDevLabel) {
            this.trackI18nLabel(this.authoredSettingsHideDevLabel, 'settings.hideDev');
        }
        if (IS_DEV_BUILD && this.authoredSettingsHideDevToggle) {
            const dt = this.authoredSettingsHideDevToggle;
            dt.isChecked = getHideDevButtons();
            dt.node.off('toggle');
            dt.node.on('toggle', () => {
                toggleHideDevButtons();
                log(`[Settings] hideDev → ${getHideDevButtons()}`);
                // Immediate paint — the Settings subscribe wired in
                // wireModeButtons() also fires, but calling here means
                // the buttons hide on the SAME frame as the click.
                this._refreshDevButtonsVisibility();
            }, this);
        }

        // ---- Controls picker (操作方式) —— 直接放在设置面板里的 3 个按钮 ----
        // 每个模式对应一个 Button + 一个半透明"选中"覆盖 Node。
        // 点按钮 → setControlMode → 覆盖 Node 只显示被选中的那个。
        // 常态按钮外观不变，选中状态只是"上面盖一层半透明选中框"。
        // "操作方式" row heading — prefer explicit Label ref; fall back
        // to the Button's inner Label so scenes that only wire the
        // Button still get localised text.
        {
            const controlsLab = this.authoredSettingsControlsLabel
                ?? (this.authoredSettingsControlsButton?.getComponentInChildren(Label) ?? null);
            if (controlsLab) this.trackI18nLabel(controlsLab, 'settings.controls');
        }
        // New-layout section labels — all optional; wire whatever the
        // scene author dragged in. `trackI18nLabel` auto-repaints on
        // language switch.
        if (this.authoredSettingsTitleLabel) {
            this.trackI18nLabel(this.authoredSettingsTitleLabel, 'settings.title');
        }
        if (this.authoredSettingsNicknameHeaderLabel) {
            this.trackI18nLabel(this.authoredSettingsNicknameHeaderLabel, 'settings.nickname');
        }
        if (this.authoredSettingsVolumeLabel) {
            this.trackI18nLabel(this.authoredSettingsVolumeLabel, 'settings.volume');
        }
        if (this.authoredSettingsAccountDataLabel) {
            this.trackI18nLabel(this.authoredSettingsAccountDataLabel, 'settings.accountData');
        }
        if (this.authoredSettingsGoogleAccountLabel) {
            this.trackI18nLabel(this.authoredSettingsGoogleAccountLabel, 'settings.googleAccount');
        }
        if (this.authoredSettingsAppleAccountLabel) {
            this.trackI18nLabel(this.authoredSettingsAppleAccountLabel, 'settings.appleAccount');
        }
        if (this.authoredSettingsGoogleStatusLabel) {
            this.trackI18nLabel(this.authoredSettingsGoogleStatusLabel, 'settings.notBound');
        }
        if (this.authoredSettingsAppleStatusLabel) {
            this.trackI18nLabel(this.authoredSettingsAppleStatusLabel, 'settings.notBound');
        }
        const wireControlButton = (
            btn: Button | null,
            label: Label | null,
            mode: ControlMode,
            labelKey: string,
        ): void => {
            if (!btn) return;
            btn.node.off('click');
            btn.node.on('click', () => this._selectControlMode(mode), this);
            if (label) this.trackI18nLabel(label, labelKey);
        };
        wireControlButton(this.authoredControlsClassicButton,
                          this.authoredControlsClassicLabel,
                          'buttons',   'controls.classic');
        wireControlButton(this.authoredControlsAdvancedButton,
                          this.authoredControlsAdvancedLabel,
                          'legacy',    'controls.advanced');
        wireControlButton(this.authoredControlsExpertButton,
                          this.authoredControlsExpertLabel,
                          'dragFling', 'controls.expert');
        // Paint the currently-active mode on first open.
        this._refreshControlModeSelection();

        // ---- Legal docs (Terms of Service / Privacy Policy) ----
        // Both open the server-hosted HTML page in the system browser
        // via `sys.openURL` — works on web, native Android, and iOS.
        // Button labels are translated via `trackI18nLabel` so a
        // language switch re-paints them in-place.
        if (this.authoredSettingsTosButton) {
            this.authoredSettingsTosButton.node.off('click');
            this.authoredSettingsTosButton.node.on('click',
                () => this.openLegalPage('tos'), this);
            const lab = this.authoredSettingsTosButton.getComponentInChildren(Label);
            if (lab) this.trackI18nLabel(lab, 'settings.tos');
        }
        if (this.authoredSettingsPrivacyButton) {
            this.authoredSettingsPrivacyButton.node.off('click');
            this.authoredSettingsPrivacyButton.node.on('click',
                () => this.openLegalPage('privacy'), this);
            const lab = this.authoredSettingsPrivacyButton.getComponentInChildren(Label);
            if (lab) this.trackI18nLabel(lab, 'settings.privacy');
        }
        // ---- Delete account button — required by App Store 5.1.1(v) ----
        if (this.authoredSettingsDeleteAccountButton) {
            this.authoredSettingsDeleteAccountButton.node.off('click');
            this.authoredSettingsDeleteAccountButton.node.on('click',
                () => this.handleDeleteAccountClick(), this);
            const lab = this.authoredSettingsDeleteAccountButton.getComponentInChildren(Label);
            if (lab) this.trackI18nLabel(lab, 'settings.deleteAccount');
        }
    }

    /** Open a legal document (TOS or Privacy) in the system browser.
     *  Passes the current i18n language so the doc matches the UI —
     *  server returns Chinese / English / Korean based on `?lang=`.
     *  A `_=<ts>` cache-buster is appended so switching language and
     *  re-opening the same doc gets a fresh fetch instead of the
     *  browser's cached previous-language response. */
    /** Open the "操作方式" (control scheme) picker modal, syncing the
     *  3 toggles to reflect the currently-active mode. */
    private _controlsBack = (): void => { this.closeControlsPanel(); };
    private openControlsPanel(): void {
        if (!this.authoredControlsPanel) return;
        this._syncControlToggles(getControlMode());
        this.authoredControlsPanel.active = true;
        BackKeyManager.push(this._controlsBack);
    }

    private closeControlsPanel(): void {
        if (!this.authoredControlsPanel) return;
        this.authoredControlsPanel.active = false;
        BackKeyManager.pop(this._controlsBack);
    }

    /** Apply a player-selected control mode: persist to Settings,
     *  visually flip the OTHER two toggles off (radio behaviour),
     *  and dismiss the picker so the change lands immediately. */
    private applyControlModeSelection(mode: ControlMode): void {
        setControlMode(mode);
        this._syncControlToggles(mode);
        log(`[Settings] controlMode → ${mode}`);
        // Auto-close so the player can jump straight into the game
        // and feel the new scheme — mirrors how the language / avatar
        // pickers behave.
        this.scheduleOnce(() => this.closeControlsPanel(), 0.15);
    }

    /** Push the `mode` state into all three toggles' isChecked flags
     *  without re-firing their `toggle` events (temporary listener
     *  detach — Cocos toggles emit on programmatic writes). */
    private _syncControlToggles(mode: ControlMode): void {
        const set = (t: Toggle | null, active: boolean): void => {
            if (!t) return;
            // Detach listeners so setting isChecked doesn't re-enter
            // applyControlModeSelection recursively.
            t.node.off('toggle');
            t.isChecked = active;
        };
        set(this.authoredControlsLegacyToggle,    mode === 'legacy');
        set(this.authoredControlsDragFlingToggle, mode === 'dragFling');
        set(this.authoredControlsButtonsToggle,   mode === 'buttons');
        // Re-attach handlers (mirrors the wire logic in bindSettingsSection).
        const rewire = (
            toggle: Toggle | null, m: ControlMode,
        ): void => {
            if (!toggle) return;
            toggle.node.on('toggle', () => {
                if (!toggle.isChecked) { toggle.isChecked = true; return; }
                this.applyControlModeSelection(m);
            }, this);
        };
        rewire(this.authoredControlsLegacyToggle,    'legacy');
        rewire(this.authoredControlsDragFlingToggle, 'dragFling');
        rewire(this.authoredControlsButtonsToggle,   'buttons');
    }

    /** Open the language pull-up picker. Idempotent — first call wires
     *  the 10 language buttons + close button; subsequent calls just
     *  toggle visibility. Falls back to `cycleLang()` if no picker
     *  panel is authored (keeps the settings row functional). */
    private openLangPicker(): void {
        if (!this.authoredLangPickerPanel) {
            cycleLang();
            this.refreshAuthoredSettingsValues();
            return;
        }
        // Lazily wire click handlers once — SUPPORTED_LANGS index maps
        // directly to authoredLangPickerButtons[i].
        if (!this._langPickerWired) {
            for (let i = 0; i < this.authoredLangPickerButtons.length; i++) {
                const btn = this.authoredLangPickerButtons[i];
                const lang = SUPPORTED_LANGS[i] as Lang | undefined;
                if (!btn || !lang) continue;
                btn.node.off('click');
                btn.node.on('click', () => this._pickLang(lang), this);
            }
            if (this.authoredLangPickerCloseButton) {
                this.authoredLangPickerCloseButton.node.off('click');
                this.authoredLangPickerCloseButton.node.on('click',
                    () => this.closeLangPicker(), this);
            }
            this._langPickerWired = true;
        }
        this._refreshLangPickerSelection();
        this.authoredLangPickerPanel.active = true;
        this.authoredLangPickerPanel.setSiblingIndex(999);
    }

    private closeLangPicker(): void {
        if (this.authoredLangPickerPanel) this.authoredLangPickerPanel.active = false;
    }

    /** Player picked a language from the pull-up. Persist, repaint
     *  the settings values (i18n labels re-translate via subscribe),
     *  and auto-dismiss the picker. */
    private _pickLang(lang: Lang): void {
        if (getLang() !== lang) {
            setLang(lang);
            log(`[Settings] language → ${lang}`);
        }
        this._refreshLangPickerSelection();
        this.refreshAuthoredSettingsValues();
        // Small delay lets the player see the checkmark move to the new
        // row before the picker vanishes.
        this.scheduleOnce(() => this.closeLangPicker(), 0.15);
    }

    /** Selected language visual: its Label turns green + its checkmark
     *  Node becomes visible. All other rows: Label back to white and
     *  checkmark hidden. No-op on empty arrays so scenes that only
     *  wired one of the two still degrade gracefully. */
    private static readonly _LANG_COLOR_SELECTED = new Color(80, 200, 120, 255);    // 绿色
    private static readonly _LANG_COLOR_DEFAULT  = new Color(0xDC, 0xC0, 0xB5, 255); // #DCC0B5 米粉色
    /** Native language names — each language displayed in its own script
     *  so a player who accidentally switched to a foreign language can
     *  still recognise their own. Order MUST match SUPPORTED_LANGS. */
    private static readonly _LANG_DISPLAY_NAMES: readonly string[] = [
        '简体中文',    // zh
        '繁體中文',    // zh-Hant
        'English',    // en
        '日本語',      // ja
        '한국어',      // ko
        'Español',    // es
        'Português',  // pt-BR
        'Français',   // fr
        'Deutsch',    // de
        'Русский',    // ru
    ];
    private _refreshLangPickerSelection(): void {
        const cur = getLang();
        for (let i = 0; i < SUPPORTED_LANGS.length; i++) {
            const isCur = SUPPORTED_LANGS[i] === cur;
            // Prefer the explicit Label ref; if not wired, fish the Label
            // out of the button itself so the scene author doesn't have
            // to drag 10 additional Label refs.
            let lab = this.authoredLangPickerLabels[i] ?? null;
            if (!lab) {
                const btn = this.authoredLangPickerButtons[i];
                if (btn) lab = btn.getComponentInChildren(Label);
            }
            if (lab) {
                // Native language name (脚本填写, 覆盖 authored 文字).
                const name = MenuController._LANG_DISPLAY_NAMES[i];
                if (name && lab.string !== name) lab.string = name;
                lab.color = isCur
                    ? MenuController._LANG_COLOR_SELECTED
                    : MenuController._LANG_COLOR_DEFAULT;
            }
            const mark = this.authoredLangPickerCheckmarks[i];
            if (mark && mark.isValid && mark.active !== isCur) mark.active = isCur;
        }
    }

    private _langPickerWired: boolean = false;

    /** Player tapped one of the 3 in-panel control-mode buttons.
     *  Persist + repaint the "selected" overlay row. Called from the
     *  wireControlButton click bindings. */
    private _selectControlMode(mode: ControlMode): void {
        if (getControlMode() === mode) {
            // Already-selected — repaint anyway in case the overlay
            // got hidden by a scene reload.
            this._refreshControlModeSelection();
            return;
        }
        setControlMode(mode);
        log(`[Settings] controlMode → ${mode}`);
        this._refreshControlModeSelection();
    }

    /** Show ONLY the "selected" overlay Node above the currently-active
     *  mode's button; hide the other two. Silent no-op if the scene
     *  author hasn't wired overlays yet. */
    private _refreshControlModeSelection(): void {
        const mode = getControlMode();
        const toggle = (n: Node | null, on: boolean): void => {
            if (n && n.isValid && n.active !== on) n.active = on;
        };
        toggle(this.authoredControlsClassicSelected,  mode === 'buttons');
        toggle(this.authoredControlsAdvancedSelected, mode === 'legacy');
        toggle(this.authoredControlsExpertSelected,   mode === 'dragFling');
    }

    private openLegalPage(doc: 'tos' | 'privacy'): void {
        const lang = getLang();
        // Use PATH segment for language — query-string variants got
        // silently rewritten by some environments (`?lang=en` ended
        // up as `?lang=en&lang=zh` on user's setup). Path segments
        // don't have that failure mode.
        // The trailing `?_=<ts>` cache-buster still forces a fresh
        // fetch even if browser cached a prior language.
        const bust = Date.now();
        const url = `${BACKEND_BASE_URL}/legal/${doc}/${encodeURIComponent(lang)}?_=${bust}`;
        log(`[Settings] opening legal page (lang=${lang}): ${url}`);
        try {
            sys.openURL(url);
        } catch (err) {
            console.warn('[Settings] sys.openURL failed:', err);
        }
    }

    /** Max nickname length (characters). Also mirror on the EditBox's
     *  `MaxLength` inspector field so the on-screen keyboard stops
     *  accepting past this limit; this constant is the JS-side belt
     *  in case someone paste-drops a longer string past that gate. */
    private static readonly NICKNAME_MAX_CHARS = 20;

    /** Read the nickname EditBox, hand it to PlayerProfile.setName
     *  (empty / whitespace is rejected inside setName), then refresh
     *  the settings values so the EditBox re-anchors on the persisted
     *  name. Rejects (with a toast) any input > NICKNAME_MAX_CHARS
     *  — refuses to save AND rolls the EditBox back to the previous
     *  name so the player sees what actually stuck. */
    private saveNicknameFromEditBox(): void {
        const eb = this.authoredSettingsNicknameEditBox;
        if (!eb) return;
        const raw = eb.string ?? '';
        const trimmed = raw.trim();
        if (trimmed.length > MenuController.NICKNAME_MAX_CHARS) {
            this.showSettingsToast(
                t('settings.nickname.tooLong', { n: MenuController.NICKNAME_MAX_CHARS }),
                'error',
            );
            eb.string = PlayerProfile.name;   // roll back to what's persisted
            return;
        }
        if (!trimmed) {
            // Restore the previous name so an empty submit doesn't
            // leave the field looking blank.
            eb.string = PlayerProfile.name;
            return;
        }
        PlayerProfile.setName(trimmed)
            .then(() => {
                eb.string = PlayerProfile.name;   // reflects any server-side truncation
                this.paintNicknameCooldownLabel();
                log(`[Settings] nickname saved: ${PlayerProfile.name}`);
            })
            .catch((err) => {
                // Server rejected — PlayerProfile already rolled the
                // local name back; show a toast + restore the EditBox.
                this.showNicknameRejectionToast(err?.message);
                eb.string = PlayerProfile.name;
                this.refreshAuthoredSettingsValues();
            });
    }

    /** Parse a nickname-rejection error from the server into an i18n
     *  toast. Server payloads:
     *    - HTTP 400 `{error:"nickname: <code>"}` — validation failure
     *      (codes: profanity / reserved / too-short / too-long)
     *    - HTTP 429 `{error:"nickname:cooldown", retryAt:"<ISO>"}` —
     *      inside the 7-day nickname-change cooldown; retryAt gives
     *      the wall-clock time when the next change becomes possible
     *  Unknown / network errors fall through to a generic "invalid" toast. */
    private showNicknameRejectionToast(errMessage: string | undefined): void {
        const msg = errMessage ?? '';
        // Server error format is `HTTP <code>: {json body}` (see Http.ts
        // httpPostJson / httpPutJson error wrapping). Match loosely so
        // future server-message tweaks don't silently drop the code.
        const m = /nickname:\s*([a-z_-]+)/i.exec(msg);
        const code = m ? m[1].toLowerCase() : '';

        // Cooldown was the old 7-day gate — retained as a defensive
        // toast in case a legacy server still returns it (post-migration
        // it should never fire). No-card is the new primary gate.
        if (code === 'cooldown') {
            const days = this.parseCooldownDaysRemaining(msg);
            this.showSettingsToast(t('settings.nickname.cooldown', { n: days }), 'error');
            return;
        }

        let key: string;
        switch (code) {
            case 'profanity':  key = 'settings.nickname.profanity'; break;
            case 'reserved':   key = 'settings.nickname.reserved'; break;
            case 'too-short':  key = 'settings.nickname.tooShort'; break;
            case 'too-long':   key = 'settings.nickname.tooLongServer'; break;
            // Server rejected because the player has no rename_card in
            // their backpack — direct them to the backpack to acquire one.
            case 'no-card':    key = 'settings.nickname.noCard'; break;
            default:           key = 'settings.nickname.rejected'; break;
        }
        this.showSettingsToast(t(key), 'error');
    }

    /** Paint the nickname-cooldown status Label. Shows one of:
     *    - "距下次可修改还有 N 天" (cooldown active, N > 0)
     *    - "现在可以修改（下次修改需等 7 天）" (cooldown elapsed / never renamed)
     *    - hidden (server hasn't reported yet — no misleading "0 days")
     *  Called from refreshAuthoredSettingsValues on panel open, and again
     *  after every successful setName so the countdown flips instantly.
     *  Silent no-op when the authored slot isn't wired. */
    private paintNicknameCooldownLabel(): void {
        const lab = this.authoredSettingsNicknameCooldownLabel;
        if (!lab) return;
        const days = PlayerProfile.nicknameCooldownDaysRemaining();
        if (days === null) {
            // Server hasn't reported yet — hide rather than lie.
            lab.node.active = false;
            return;
        }
        lab.node.active = true;
        if (days > 0) {
            lab.string = t('settings.nickname.cooldown', { n: days });
        } else {
            lab.string = t('settings.nickname.cooldownReady');
        }
    }

    /** Pull `retryAt` out of an HTTP error message and convert to
     *  whole days remaining (rounded up so "23 hours left" reads as
     *  "1 day"). Falls back to 7 (the full cooldown length) if we
     *  can't parse — better to slightly overstate than mislead the
     *  player with "0 days". */
    private parseCooldownDaysRemaining(errMessage: string): number {
        const isoMatch = /"retryAt"\s*:\s*"([^"]+)"/.exec(errMessage);
        if (!isoMatch) return 7;
        const retryAtMs = Date.parse(isoMatch[1]);
        if (!Number.isFinite(retryAtMs)) return 7;
        const nowMs = Date.now();
        const deltaMs = Math.max(0, retryAtMs - nowMs);
        return Math.max(1, Math.ceil(deltaMs / (24 * 60 * 60 * 1000)));
    }

    /** Open the generic input prompt to edit the nickname.
     *  Confirm → validate → PlayerProfile.setName → repaint the display
     *  Label (and the legacy EditBox if it's still wired for backward
     *  compat with old scenes). Cancel → no-op. */
    private async editNicknameViaPrompt(): Promise<void> {
        const currentName = PlayerProfile.name;
        const next = await this.showPrompt(
            t('settings.nickname.title'),
            currentName,
            t('settings.nickname.placeholder'),
            t('common.confirm'),
            t('common.cancel'),
            MenuController.NICKNAME_MAX_CHARS,
        );
        if (next === null) {
            log('[Settings] nickname edit cancelled');
            return;
        }
        const trimmed = next.trim();
        if (trimmed.length > MenuController.NICKNAME_MAX_CHARS) {
            this.showSettingsToast(
                t('settings.nickname.tooLong', { n: MenuController.NICKNAME_MAX_CHARS }),
                'error',
            );
            return;
        }
        if (!trimmed) {
            // Blank submit → no-op (silently ignore, matches the EditBox
            // behavior above).
            return;
        }
        if (trimmed === currentName) {
            return;   // unchanged, skip the setName round-trip
        }
        // Optimistic repaint — PlayerProfile.setName has already updated
        // the local name; the settings screen will show the new one
        // immediately. If the server rejects, we roll back below.
        this.refreshAuthoredSettingsValues();
        try {
            await PlayerProfile.setName(trimmed);
            // Refresh again post-success so the cooldown Label flips
            // from "现在可以修改" → "距下次可修改还有 7 天" (the new
            // cooldown-end timestamp arrived in the setName response).
            this.paintNicknameCooldownLabel();
            log(`[Settings] nickname saved via prompt: ${PlayerProfile.name}`);
        } catch (err: any) {
            // Server rejected — PlayerProfile already rolled the local
            // name back to `currentName`. Show a per-code toast + repaint
            // the settings screen so the reverted name is visible.
            this.showNicknameRejectionToast(err?.message);
            this.refreshAuthoredSettingsValues();
            log(`[Settings] nickname rejected: ${err?.message}`);
        }
    }

    // ============================================================
    //  Google account binding (Settings panel)
    // ============================================================
    /** Handler for the Settings-panel Google button. Two paths:
     *    1. Player is already `google`-linked → future work is unlink;
     *       for now we just toast "already linked" (unlink flow isn't
     *       spec'd yet — server has no unbind endpoint).
     *    2. Player is a guest → open Google Web OAuth via Custom Tabs,
     *       exchange code → id_token, POST /player/link/google.
     *       Conflict (this Google account owns another uuid) → confirm
     *       recovery, POST /player/login/google, swap identity.
     *  Errors are logged + toasted; the button stays clickable so the
     *  player can retry after a transient network hiccup. */
    private async handleGoogleBindClick(): Promise<void> {
        // Already bound → tell the player, do nothing else. Unlink is
        // a separate feature the server doesn't support yet; the UI
        // sprite already reads "bound" for their state.
        if (PlayerProfile.accountType === 'google') {
            this.showSettingsToast(t('settings.google.alreadyLinked'), 'info');
            return;
        }
        // Web / iOS / editor preview — Custom Tabs bridge only exists
        // on native Android. Feature-gate cleanly so no cryptic errors.
        if (!GoogleWebOAuth.isSupported) {
            this.showSettingsToast(t('settings.google.unsupported'), 'error');
            return;
        }
        // ---- 1) Open Custom Tabs → wait for id_token ----
        let idToken: string;
        try {
            log('[Settings] Google bind — launching OAuth flow');
            this.showSettingsToast(t('settings.google.pending'), 'info');
            idToken = await GoogleWebOAuth.signIn();
        } catch (err: any) {
            const msg = err?.message ?? String(err);
            // Silence user-cancel in the toast — that's expected UX.
            if (/access_denied|cancel|timeout/i.test(msg)) {
                log(`[Settings] Google sign-in cancelled: ${msg}`);
                return;
            }
            console.warn('[Settings] Google sign-in FAILED:', msg);
            this.showSettingsToast(t('settings.google.error'), 'error');
            return;
        }
        // ---- 2) Try to bind to CURRENT uuid ----
        let link;
        try {
            link = await linkGoogleToCurrentAccount(idToken);
        } catch (err: any) {
            console.warn('[Settings] /link/google FAILED:', err?.message ?? err);
            this.showSettingsToast(t('settings.google.error'), 'error');
            return;
        }
        if (link.linked) {
            // Happy path — mark the profile as google-linked so the
            // button flips to "bound" state on next repaint.
            PlayerProfile.setAccountType('google');
            this.showSettingsToast(t('settings.google.linked'), 'info');
            this.refreshAuthoredSettingsValues();
            log('[Settings] Google linked to current uuid');
            return;
        }
        // ---- 3) Conflict — this Google owns ANOTHER uuid ----
        if (link.alreadyLinked) {
            log(`[Settings] Google already linked to ${link.linkedUuid ?? '(unknown)'} — offering recovery`);
            const ok = await this.showConfirm(
                t('settings.google.recover.title'),
                t('settings.google.recover.desc'),
                t('common.confirm'),
                t('common.cancel'),
            );
            if (!ok) {
                log('[Settings] Google recovery declined by user');
                return;
            }
            try {
                const rec = await loginWithGoogle(idToken);
                PlayerProfile.swapToRecoveredAccount(rec.uuid, rec.bearer, rec.expEpochSec, 'google');
                // Recovery is an ACCOUNT SWAP, not a same-account
                // sync — the outgoing guest's local progress belongs
                // to a uuid we're about to abandon. Wipe every device-
                // scoped progress key so the boot-time
                // fetchProfile().bestScores hydration below writes the
                // recovered account's real values into a clean slate
                // (otherwise the boot code's max-merge would keep the
                // guest's high values and hide the recovered account's
                // actual lower / higher progress inconsistently).
                LevelProgress.reset();
                sys.localStorage.removeItem(MenuController.ENDLESS_BEST_KEY);
                this._endlessBestLayers = 0;
                log(`[Settings] Recovered Google-linked account: ${rec.uuid} — reloading scene`);
                // Full scene reload — the recovered account has a
                // completely different profile / wallet / level
                // progress / event state / leaderboard rank than the
                // outgoing guest, and refreshing a handful of Settings
                // fields would still leave stale in-memory caches all
                // over the tree (GameController's cleared-levels set,
                // HUD balance, EventNewbie14Panel's claim state, etc).
                // Reloading Game.scene fires the same onLoad chain as
                // a fresh app launch — LoadingController shows the
                // loading panel, then beginBoot() runs, which re-
                // registers with the persisted bearer, re-fetches
                // profile/wallet/leaderboard/event and lands the
                // player on the menu with correct data.
                this.showSettingsToast(t('settings.google.recovered'), 'info');
                // Small delay so the toast can be seen before the
                // scene wipes it. director.loadScene is fire-and-
                // forget — anything on `this` after this call is
                // running on a dead scene.
                this.scheduleOnce(() => {
                    director.loadScene('Game');
                }, 0.4);
            } catch (err: any) {
                console.warn('[Settings] /login/google FAILED:', err?.message ?? err);
                this.showSettingsToast(t('settings.google.error'), 'error');
            }
            return;
        }
        // Neither linked nor alreadyLinked — shouldn't happen per spec.
        console.warn('[Settings] /link/google returned unexpected shape:', JSON.stringify(link));
        this.showSettingsToast(t('settings.google.error'), 'error');
    }

    // ============================================================
    //  Delete account (App Store Review Guideline 5.1.1(v))
    // ============================================================
    /** Click handler on the "Delete Account" button. Shows the generic
     *  confirm modal with a scary-enough message + Confirm/Cancel.
     *  Confirmed → commitDeleteAccount fires the server DELETE +
     *  wipes local state + drops back into fresh guest. */
    private async handleDeleteAccountClick(): Promise<void> {
        const ok = await this.showConfirm(
            t('settings.deleteAccount.title'),
            t('settings.deleteAccount.desc'),
            t('common.confirm'),
            t('common.cancel'),
        );
        if (!ok) {
            log('[Settings] delete account cancelled');
            return;
        }
        await this.commitDeleteAccount();
    }

    /** Actually delete the account.
     *  1. Show pending toast so player knows something is happening
     *     (server call may take 1-2s including Apple revoke on iOS)
     *  2. DELETE /player/self — server nukes DB rows + calls Apple
     *     /auth/revoke if SIWA was linked
     *  3. Wipe every player-scoped localStorage key + device-scoped
     *     progress keys (LevelProgress + endless-best) — no reason to
     *     keep them around when the account they belonged to is gone.
     *  4. Close the app via game.end() so the ex-player isn't dropped
     *     into an auto-created fresh guest against their will (Korean
     *     ONE Store copy explicitly says "게임이 종료됩니다").
     *
     * NOTE: we deliberately do NOT re-register a new guest here. If
     * the player reopens the app, ensureRegistered() at boot mints
     * one — that path is the same as a first-install fresh device.
     */
    private async commitDeleteAccount(): Promise<void> {
        const btn = this.authoredSettingsDeleteAccountButton;
        const btnComp = btn ? btn.getComponent(Button) : null;
        if (btnComp) btnComp.interactable = false;
        this.showSettingsToast(t('settings.deleteAccount.pending'));
        try {
            log('[Settings] delete account — calling DELETE /player/self');
            await deletePlayerSelf();
            log('[Settings] server-side delete OK — wiping local state');
            // Wipe player-scoped localStorage keys (keep audio/language
            // etc — those are per-device preferences, not per-account).
            sys.localStorage.removeItem('tt.player.uuid');
            sys.localStorage.removeItem('tt.player.name');
            sys.localStorage.removeItem('tt.player.accountType');
            sys.localStorage.removeItem('tt.player.token');
            sys.localStorage.removeItem('tt.player.tokenExpEpochSec');
            sys.localStorage.removeItem('tt.player.avatarIdx');
            // Also clear device-scoped progress caches. These aren't
            // strictly per-account (they use device-global keys) but
            // showing the deleted account's cleared-levels /
            // endless-best to whoever reopens the app next would be
            // wrong — they belonged to the deleted uuid, and the
            // server no longer has them.
            LevelProgress.reset();
            sys.localStorage.removeItem(MenuController.ENDLESS_BEST_KEY);
            // Clear PlayerProfile's in-memory cache — without this, the
            // module-level singleton would keep serving the deleted
            // uuid until the process ends.
            PlayerProfile.resetInMemoryState();
            log('[Settings] closing app after delete');
            // Small delay so the pending toast is visible for a beat
            // before the window vanishes — otherwise the player sees
            // an instant close and wonders whether the delete actually
            // went through.
            this.scheduleOnce(() => {
                game.end();
            }, 0.6);
        } catch (err) {
            const msg = (err as Error).message ?? String(err);
            console.warn(`[Settings] delete account failed: ${msg}`);
            this.showSettingsToast(t('settings.deleteAccount.failed'), 'error');
            // Only re-enable the button on failure. On success the
            // app is about to close, so leaving it disabled prevents
            // a double-tap from firing another DELETE.
            if (btnComp) btnComp.interactable = true;
        }
    }

    /** Ban-detected handler — registered on Http via setBannedHandler
     *  from beginBootAfterLoading. Hides all panels, shows the ban
     *  modal, and quits the app when the player taps OK. Http is
     *  already latched (all further requests short-circuit) so no
     *  gameplay is reachable even in the sliver of time before quit.
     *
     *  If quit fails (Cocos web preview, an emulator where game.end()
     *  is a no-op) we fall through to a modal-loop so the player
     *  still can't proceed. */
    private _bannedModalActive = false;
    private async showBannedModal(state: BannedState): Promise<void> {
        if (this._bannedModalActive) return;   // idempotent — one modal is enough
        this._bannedModalActive = true;
        console.warn(`[MenuController] SHOWING BAN MODAL — reason: ${state.reason}`);
        // Hide the main menu + gameplay + any open panel so the modal
        // isn't over a working-looking UI.
        if (this.modeSelectPanel) this.modeSelectPanel.active = false;
        this.setGameplayVisible(false);
        if (this.authoredSettingsPanel) this.authoredSettingsPanel.active = false;

        // Show once. Both Confirm and Cancel labels are "OK" so any
        // tap resolves. We don't care WHICH — either way we quit.
        await this.showConfirm(
            t('banned.title'),
            t('banned.desc', { reason: state.reason }),
            t('banned.ok'),
            t('banned.ok'),
        );

        // Quit the app. game.end() calls the platform-appropriate
        // shutdown: on native iOS/Android it terminates the process;
        // on web preview it's a no-op (fall through to modal loop).
        log('[MenuController] ban acknowledged — quitting app');
        try { game.end(); } catch (e) { console.warn('[MenuController] game.end() threw:', e); }

        // Fallback: if the app is still running one frame later
        // (web / broken quit) keep the modal up so gameplay stays
        // unreachable.
        await new Promise<void>((r) => setTimeout(r, 300));
        // eslint-disable-next-line no-constant-condition
        while (true) {
            await this.showConfirm(
                t('banned.title'),
                t('banned.desc', { reason: state.reason }),
                t('banned.ok'),
                t('banned.ok'),
            );
            try { game.end(); } catch { /* ignore */ }
            await new Promise<void>((r) => setTimeout(r, 300));
        }
    }

    /** Lazily resolve the scene's LoadingController. Cached on first
     *  hit. `null` if no LoadingController is present in the scene
     *  (unlikely — every scene wires one — but callers should treat as
     *  optional). */
    private _cachedLoadingController: LoadingController | null | undefined = undefined;
    private getLoadingController(): LoadingController | null {
        if (this._cachedLoadingController !== undefined) return this._cachedLoadingController;
        const scene = director.getScene();
        this._cachedLoadingController = scene?.getComponentInChildren(LoadingController) ?? null;
        if (!this._cachedLoadingController) {
            console.warn('[MenuController] LoadingController not found in scene — reload overlay disabled');
        }
        return this._cachedLoadingController;
    }

    /** Show the loading panel, run `body`, then hide it — regardless of
     *  whether `body` throws. Used by the account-swap flows (delete,
     *  bind, recover) so the player sees a clean "reloading with new
     *  data" transition. If the LoadingController isn't wired the
     *  overlay is skipped but `body` still runs.
     *
     *  A guaranteed minimum overlay-visible time keeps the transition
     *  from flashing by too fast when the network work finishes in
     *  <100ms. */
    private async runWithReloadOverlay(body: () => Promise<void>): Promise<void> {
        const lc = this.getLoadingController();
        const startTs = performance.now();
        const minOverlayMs = 600;
        if (lc) lc.showAccountSwapOverlay();
        try {
            await body();
            // Rebuild the level-select tower for the (possibly changed)
            // LevelProgress.currentIdx. Body has already restored the
            // progress state, so this now points at the correct level.
            // Runs inside the overlay so the player doesn't see the
            // rebuild hitch on their first level-select tap after the
            // swap. Also give Cocos one paint frame after activating
            // the stage so the shader compile actually happens under
            // the overlay rather than on that first tap.
            if (lc) {
                lc.rebuildLevelTowerForCurrentAccount();
                await new Promise<void>((r) => setTimeout(r, 32));
            }
        } finally {
            const elapsed = performance.now() - startTs;
            const remaining = Math.max(0, minOverlayMs - elapsed);
            if (remaining > 0) {
                await new Promise<void>((r) => setTimeout(r, remaining));
            }
            if (lc) lc.hideAccountSwapOverlay();
        }
    }

    /** Bind the avatar-picker panel's close button + each per-avatar
     *  button. Idempotent via `_avatarPickerWired`. Called from
     *  `wireAuthoredSettingsPanel` after the settings avatar button
     *  is bound — the picker button dependencies (frames, target
     *  index) are stable, so one wire is enough. */
    private _avatarPickerWired: boolean = false;
    private wireAvatarPicker(): void {
        if (this._avatarPickerWired) return;
        this._avatarPickerWired = true;
        if (this.authoredAvatarPickerCloseButton) {
            this.authoredAvatarPickerCloseButton.node.off('click');
            this.authoredAvatarPickerCloseButton.node.on('click',
                () => this.closeAvatarPicker(), this);
        }
        // Each picker button maps to `authoredAvatarFrames[i]`. Click
        // -> save i as the new avatar, refresh settings visual, close.
        for (let i = 0; i < this.authoredAvatarPickerButtons.length; i++) {
            const btn = this.authoredAvatarPickerButtons[i];
            if (!btn) continue;
            const idx = i;
            btn.node.off('click');
            btn.node.on('click', () => this.selectAvatar(idx), this);
            // Also paint each button's inner Sprite with the matching
            // avatar frame (if it's not already authored in the scene).
            const spr = btn.getComponentInChildren(Sprite);
            const frame = this.authoredAvatarFrames[idx];
            if (spr && frame && spr.spriteFrame !== frame) spr.spriteFrame = frame;
        }
    }

    private openAvatarPicker(): void {
        this.wireAvatarPicker();
        const panel = this.authoredAvatarPickerPanel;
        if (!panel) { log('[Settings] avatar picker not wired'); return; }
        ensureDimBackdrop(panel);
        panel.setSiblingIndex(999);
        panel.active = true;
    }

    private closeAvatarPicker(): void {
        if (this.authoredAvatarPickerPanel) this.authoredAvatarPickerPanel.active = false;
    }

    /** Pick avatar `idx` — persist, repaint the settings avatar Sprite,
     *  close the picker. Called from each picker button's click. */
    private selectAvatar(idx: number): void {
        PlayerProfile.setAvatarIdx(idx);
        this.paintSettingsAvatar();
        this.closeAvatarPicker();
        log(`[Settings] avatar picked: ${idx}`);
    }

    /** Paint the settings-panel avatar Sprite with the currently-
     *  selected avatar frame. Called from `refreshAuthoredSettingsValues`
     *  and after a fresh pick. Falls back to the first frame in the pool
     *  if the player hasn't picked yet AND we couldn't derive a default. */
    private paintSettingsAvatar(): void {
        const frames = this.authoredAvatarFrames;
        if (!frames.length) return;
        const picked = PlayerProfile.avatarIdx;
        // Fallback for unpicked players: hash the uuid so guests still
        // get a stable, varied default across the pool.
        let idx: number;
        if (picked !== null) {
            idx = picked;
        } else {
            const u = PlayerProfile.uuid;
            let h = 0;
            for (let i = 0; i < u.length; i++) h = (h * 31 + u.charCodeAt(i)) | 0;
            idx = Math.abs(h) % frames.length;
        }
        idx = ((idx % frames.length) + frames.length) % frames.length;
        const frame = frames[idx];
        const spr = this.authoredSettingsAvatarSprite
            ?? this.authoredSettingsAvatarButton?.getComponentInChildren(Sprite)
            ?? null;
        if (spr && frame) spr.spriteFrame = frame;
    }

    /** Fade-in / auto-hide toast for settings-panel errors + info.
     *  Preferred path is the unified ToastManager; falls back to the
     *  older per-panel authored toast node when ToastManager is not
     *  wired. Settings toasts are info-flavoured unless the caller
     *  explicitly signals an error (kept simple for now: all settings
     *  toasts go through `info`; if we later want per-message variants,
     *  add a `kind` param and route to `error`). */
    private showSettingsToast(text: string, kind: 'info' | 'error' = 'info'): void {
        if (ToastManager.instance) {
            ToastManager.instance.show(text, kind);
            return;
        }
        const node = this.authoredSettingsToastNode;
        if (!node) { log(`[Settings] toast (no node): ${text}`); return; }
        const lab = this.authoredSettingsToastLabel
            ?? node.getComponentInChildren(Label);
        if (lab) lab.string = text;
        node.active = true;
        node.setSiblingIndex(999);
        let op = node.getComponent(UIOpacity);
        if (!op) op = node.addComponent(UIOpacity);
        op.opacity = 0;
        tween<UIOpacity>(op)
            .to(0.15, { opacity: 255 })
            .delay(1.5)
            .to(0.3, { opacity: 0 })
            .call(() => { if (node) node.active = false; })
            .start();
    }

    /** "关" if muted, otherwise "N%". */
    private formatAudioLabel(v: number): string {
        return v <= 0 ? t('audio.off') : t('audio.percent', { n: Math.round(v * 100) });
    }

    /** Push the current value of each setting into its paired Label
     *  AND sync the sliders to match the current volume. Called on
     *  every openSettingsPanel + after any row-button click (never
     *  from inside the slider's own 'slide' event — that would fight
     *  the user's drag). */
    private refreshAuthoredSettingsValues(): void {
        // Repaint the "selected" overlay above the currently-active
        // control-mode button (in case the mode changed since last open).
        this._refreshControlModeSelection();
        const set = (idx: number, text: string): void => {
            const lab = this.authoredSettingsRowValueLabels[idx];
            if (lab) lab.string = text;
        };
        // Language row — append a small down-triangle ▼ so the value
        // reads as "this is tappable, tap to cycle" without needing
        // a dedicated dropdown icon Sprite.
        set(0, `${t('lang.toggle')} ▼`);
        const bgmV = getBgmVolume();
        const sfxV = getSfxVolume();
        set(1, this.formatAudioLabel(bgmV));
        set(2, this.formatAudioLabel(sfxV));
        if (this.authoredSettingsBgmSlider) this.authoredSettingsBgmSlider.progress = bgmV;
        if (this.authoredSettingsSfxSlider) this.authoredSettingsSfxSlider.progress = sfxV;
        if (this.authoredSettingsBgmFill)   this.authoredSettingsBgmFill.fillRange   = bgmV;
        if (this.authoredSettingsSfxFill)   this.authoredSettingsSfxFill.fillRange   = sfxV;
        // Balance button: paint cached balance immediately (instant on
        // re-open), then kick off async refresh + repaint when it lands.
        this.paintBalanceButton(this._cachedGemBalance);
        fetchWallet()
            .then((w) => {
                this._cachedGemBalance = w.gems;
                this.paintBalanceButton(w.gems);
            })
            .catch((err) => {
                console.warn('[Settings] fetchWallet failed:', err.message);
            });
        // Nickname EditBox — prefill with the current display name so
        // the field isn't blank on open. Placeholder falls back to
        // `user-<hex>` if PlayerProfile hasn't resolved yet.
        if (this.authoredSettingsNicknameEditBox) {
            this.authoredSettingsNicknameEditBox.string = PlayerProfile.name;
        }
        if (this.authoredSettingsNicknameLabel) {
            this.authoredSettingsNicknameLabel.string = PlayerProfile.name;
        }
        this.paintNicknameCooldownLabel();
        // Account row Label — "<账号类型> · <uuid> 📋" so player can
        // copy their UUID for customer support / disputes. Full uuid
        // (not truncated) so the copied string is directly usable.
        if (this.authoredSettingsAccountTypeLabel) {
            this.authoredSettingsAccountTypeLabel.string
                = this.formatAccountRow(PlayerProfile.accountType, PlayerProfile.uuid);
        }
        // Google / Apple binding buttons — swap their Sprite between
        // "未绑定"（灰）和 "已绑定"（绿）based on the real bind state.
        // Until real OAuth is wired every player is `anonymous`, so
        // both buttons show the unbound (gray) variant.
        const acct = PlayerProfile.accountType;
        const setBtnState = (btn: Button | null, sf: SpriteFrame | null, bound: boolean): void => {
            if (!btn) return;
            if (sf) {
                const spr = btn.getComponent(Sprite) ?? btn.getComponentInChildren(Sprite);
                if (spr) spr.spriteFrame = sf;
            }
            // The button's visible text lives in a child Label node
            // (Google → Sprite, Label). Swapping the sprite frame
            // alone leaves the "未绑定" text unchanged, so update it
            // here too. i18n so it tracks language changes.
            const lab = btn.getComponentInChildren(Label);
            if (lab) lab.string = t(bound ? 'settings.bound' : 'settings.unbound');
        };
        setBtnState(this.authoredSettingsGoogleButton,
                    acct === 'google' ? this.googleBoundSprite : this.googleUnboundSprite,
                    acct === 'google');
        setBtnState(this.authoredSettingsAppleButton,
                    acct === 'apple'  ? this.appleBoundSprite  : this.appleUnboundSprite,
                    acct === 'apple');
        // Legacy toggle version (kept for backward compat).
        if (this.authoredSettingsGoogleToggle) {
            this.authoredSettingsGoogleToggle.isChecked = (acct === 'google');
        }
        if (this.authoredSettingsAppleToggle) {
            this.authoredSettingsAppleToggle.isChecked = (acct === 'apple');
        }
        // Haptic toggle — reflect Settings state each open (may have
        // been changed by another entry point, though today it's only
        // touched from this panel).
        if (this.authoredSettingsHapticToggle) {
            this.authoredSettingsHapticToggle.isChecked = (getHapticMode() === 'on');
        }
        if (this.authoredSettingsHapticLabel) {
            this.trackI18nLabel(this.authoredSettingsHapticLabel, 'settings.haptic');
        }
        // Hide-DEV row: only paints in DEV builds (row Node was set
        // inactive at wire time on release). Sync the toggle to the
        // persisted setting so a fresh open reflects current state.
        if (IS_DEV_BUILD && this.authoredSettingsHideDevToggle) {
            this.authoredSettingsHideDevToggle.isChecked = getHideDevButtons();
        }
        // Avatar Sprite — repaint from PlayerProfile in case the player
        // picked a new one since the last open.
        this.paintSettingsAvatar();
    }

    /** Translate PlayerProfile.accountType into the settings-label
     *  string via i18n. Null → "游客" (anonymous fallback). */
    private accountTypeText(acct: import('../core/PlayerProfile').AccountType | null): string {
        switch (acct) {
            case 'google': return t('settings.account.google');
            case 'apple':  return t('settings.account.apple');
            case 'email':  return t('settings.account.email');
            case 'anonymous':
            default:       return t('settings.account.guest');
        }
    }

    /** Build the account-row display string: "<account type> · <uuid> 📋".
     *  Full uuid so what's shown = what gets copied. Emoji 📋 acts as
     *  the copy affordance — no image asset needed, renders on every
     *  device that has OS emoji support (iOS/Android/desktop). */
    private formatAccountRow(
        acct: import('../core/PlayerProfile').AccountType | null,
        uuid: string,
    ): string {
        return `${this.accountTypeText(acct)} · ${uuid}  📋`;
    }

    /** Copy the player's identity (nickname + uuid) to the clipboard.
     *  Called when the player taps the account-info row button —
     *  useful for support / disputes / account transfer requests.
     *
     *  Clipboard APIs differ across Cocos runtime versions and target
     *  platforms — try each in order until one works. Log the method
     *  that succeeded so future debugging is quick.
     *
     *  Method cascade:
     *    1. sys.setClipboardText(text)  — Cocos 3.x legacy name
     *    2. sys.setClipboard(text)      — Cocos 3.8+ new name (may return Promise)
     *    3. navigator.clipboard.writeText(text)  — Web / Cocos preview (Promise)
     *    4. document.execCommand('copy') — old-browser fallback via <textarea>
     */
    private async copyPlayerIdentity(): Promise<void> {
        const text =
            `${t('settings.nickname.title')}: ${PlayerProfile.name}\n` +
            `UserID: ${PlayerProfile.uuid}`;
        let copied = false;
        let method = 'none';
        const anySys = sys as any;

        // (0) Android native — go straight to the Kotlin ClipboardBridge
        //     via JSB reflection. Cocos 3.8.8's built-in sys.setClipboard*
        //     and Web Clipboard APIs are ALL no-ops on native Android
        //     (the JSB just returns undefined without touching the system
        //     clipboard), so without this bridge every fallback below
        //     silently fails and the player sees "copy failed" even
        //     though the button "worked".
        const isAndroid = sys.platform === sys.Platform.ANDROID
            || String(sys.os ?? '').toLowerCase().includes('android');
        if (!copied
            && isAndroid
            && typeof (native as any)?.reflection?.callStaticMethod === 'function') {
            try {
                const r = (native as any).reflection.callStaticMethod(
                    'com/cocos/game/ClipboardBridge',
                    'copyToClipboard',
                    '(Ljava/lang/String;Ljava/lang/String;)Z',
                    'TetriTower Account',
                    text,
                );
                copied = r === true;
                method = 'ClipboardBridge';
            } catch (e) {
                console.warn('[Settings] ClipboardBridge.copyToClipboard threw:', e);
            }
        }

        // (1) Cocos 3.x legacy: sys.setClipboardText
        if (!copied && typeof anySys.setClipboardText === 'function') {
            try {
                const r = anySys.setClipboardText(text);
                copied = r !== false;
                method = 'sys.setClipboardText';
            } catch (e) {
                console.warn('[Settings] sys.setClipboardText threw:', e);
            }
        }

        // (2) Cocos 3.8+ new name: sys.setClipboard (may be async)
        if (!copied && typeof anySys.setClipboard === 'function') {
            try {
                const r = anySys.setClipboard(text);
                if (r && typeof r.then === 'function') {
                    await r;
                    copied = true;
                } else {
                    copied = r !== false;
                }
                method = 'sys.setClipboard';
            } catch (e) {
                console.warn('[Settings] sys.setClipboard threw:', e);
            }
        }

        // (3) Web Clipboard API — modern browsers + Cocos web preview.
        // MUST await — writeText returns a Promise that rejects on
        // permission denial, not-focused-doc, etc.
        if (!copied && typeof navigator !== 'undefined' && (navigator as any).clipboard?.writeText) {
            try {
                await (navigator as any).clipboard.writeText(text);
                copied = true;
                method = 'navigator.clipboard';
            } catch (e) {
                console.warn('[Settings] navigator.clipboard.writeText rejected:', e);
            }
        }

        // (4) Legacy execCommand — works in older browsers + some
        // WebView contexts where navigator.clipboard is blocked.
        if (!copied && typeof document !== 'undefined' && typeof document.execCommand === 'function') {
            try {
                const ta = document.createElement('textarea');
                ta.value = text;
                ta.style.position = 'fixed';
                ta.style.left = '-9999px';
                ta.style.top = '-9999px';
                document.body.appendChild(ta);
                ta.focus();
                ta.select();
                copied = document.execCommand('copy');
                document.body.removeChild(ta);
                if (copied) method = 'document.execCommand';
            } catch (e) {
                console.warn('[Settings] execCommand copy threw:', e);
            }
        }

        console.log(`[Settings] copy — method=${method}, success=${copied}, text=${text.replace(/\n/g, ' | ')}`);

        if (copied) {
            this.showSettingsToast(t('settings.account.copied'));
        } else {
            this.showSettingsToast(t('settings.account.copyFailed'), 'error');
        }
    }

    /** Write the current balance into the button's inner label. Uses
     *  `topup.balance` i18n key ("宝石: {n}") for consistency with the
     *  top-up panel's own balance strip. */
    private paintBalanceButton(gems: number): void {
        // Settings-panel balance button (legacy location, may still be
        // wired in older scenes).
        if (this.authoredSettingsBalanceButton) {
            const lab = this.authoredSettingsBalanceLabel
                ?? this.authoredSettingsBalanceButton.getComponentInChildren(Label);
            if (lab) lab.string = t('topup.balance', { n: gems.toString() });
        }
        // Main mode-select page balance button (new location).
        if (this.modeBtnTopup) {
            const lab = this.modeBtnTopupBalanceLabel
                ?? this.modeBtnTopup.getComponentInChildren(Label);
            if (lab) lab.string = t('topup.balance', { n: gems.toString() });
        }
    }

    /** Balance button click — close settings, open top-up. Both panels
     *  are `authoredSettingsPanel` / `topUpController.panel` respectively
     *  and are independent siblings under Canvas, so the transition
     *  is just hide-one / show-the-other. */
    private onBalanceButtonClicked(): void {
        this.closeSettingsPanel();
        if (this.topUpController) {
            this.topUpController.show();
        } else {
            console.log('[Settings] balance button clicked — topUpController not wired');
        }
    }

    // ============================================================
    //  Insufficient-gems popup
    // ============================================================
    /** Called by HudController when a paid-refresh (or any gem-spend)
     *  server call returns 402. Shows the "not enough gems, top up?"
     *  overlay with the exact amounts. Silently no-ops if the panel
     *  isn't wired in the scene.
     *
     *  Buttons in the panel:
     *   - `authoredInsufficientGemsTopUpButton` → close popup + open TopUp panel
     *   - `authoredInsufficientGemsCancelButton` → close popup */
    public showInsufficientGems(needed: number, balance: number): void {
        const panel = this.authoredInsufficientGemsPanel;
        if (!panel) {
            console.log(`[InsufficientGems] popup not wired (needed=${needed} balance=${balance})`);
            return;
        }
        this.wireInsufficientGemsPanelOnce();
        if (this.authoredInsufficientGemsLabel) {
            this.authoredInsufficientGemsLabel.string
                = t('gems.insufficient', { need: needed, have: balance });
        }
        ensureDimBackdrop(panel);
        panel.setSiblingIndex(999);
        panel.active = true;
    }

    private _insufficientGemsPanelWired: boolean = false;
    private wireInsufficientGemsPanelOnce(): void {
        if (this._insufficientGemsPanelWired) return;
        this._insufficientGemsPanelWired = true;
        if (this.authoredInsufficientGemsTopUpButton) {
            const btn = this.authoredInsufficientGemsTopUpButton;
            btn.node.off('click');
            btn.node.on('click', () => {
                if (this.authoredInsufficientGemsPanel) this.authoredInsufficientGemsPanel.active = false;
                if (this.topUpController) this.topUpController.show();
            }, this);
            const lab = btn.getComponentInChildren(Label);
            if (lab) this.trackI18nLabel(lab, 'gems.goTopUp');
        }
        if (this.authoredInsufficientGemsCancelButton) {
            const btn = this.authoredInsufficientGemsCancelButton;
            btn.node.off('click');
            btn.node.on('click', () => {
                if (this.authoredInsufficientGemsPanel) this.authoredInsufficientGemsPanel.active = false;
            }, this);
            const lab = btn.getComponentInChildren(Label);
            if (lab) this.trackI18nLabel(lab, 'gems.cancel');
        }
    }

    // ============================================================
    //  Generic confirm modal (reusable across callers)
    // ============================================================
    /** Only one pending confirm at a time. If a caller opens a second
     *  confirm before the first resolves, we auto-resolve the first
     *  as false (cancelled) and take over the modal. */
    private _confirmPendingResolve: ((confirmed: boolean) => void) | null = null;
    private _confirmModalWired: boolean = false;

    /** Show the generic confirmation modal. Returns a Promise that
     *  resolves to `true` if the user tapped Confirm, `false` if they
     *  tapped Cancel (or the modal was auto-cancelled by a second
     *  showConfirm call).
     *
     *  Title / message are shown as-is (caller passes t('...')). If
     *  the modal isn't authored in the scene, resolves to `false` and
     *  logs — caller MUST tolerate the missing-panel case (usually by
     *  falling back to a safer no-op default).
     *
     *  Example usage:
     *
     *     const ok = await this.showConfirm(
     *         t('settings.deleteAccount.title'),
     *         t('settings.deleteAccount.desc'),
     *         t('settings.deleteAccount.confirm'),
     *         t('common.cancel'),
     *     );
     *     if (!ok) return;
     *     await this.doDelete();
     */
    public showConfirm(
        title: string,
        message: string,
        confirmLabelText: string,
        cancelLabelText: string,
    ): Promise<boolean> {
        const panel = this.authoredConfirmModal;
        if (!panel) {
            console.warn('[Confirm] modal panel not wired in scene — auto-cancelling');
            return Promise.resolve(false);
        }
        return new Promise<boolean>((resolve) => {
            // Any previous pending confirm becomes a "cancel" — take over.
            const prev = this._confirmPendingResolve;
            this._confirmPendingResolve = resolve;
            if (prev) prev(false);

            this.wireConfirmModalOnce();

            if (this.authoredConfirmModalTitle) {
                this.authoredConfirmModalTitle.string = title;
            }
            if (this.authoredConfirmModalMessage) {
                this.authoredConfirmModalMessage.string = message;
            }
            if (this.authoredConfirmModalConfirmButton) {
                const lab = this.authoredConfirmModalConfirmButton.getComponentInChildren(Label);
                if (lab) lab.string = confirmLabelText;
            }
            if (this.authoredConfirmModalCancelButton) {
                const lab = this.authoredConfirmModalCancelButton.getComponentInChildren(Label);
                if (lab) lab.string = cancelLabelText;
            }
            ensureDimBackdrop(panel);
            panel.setSiblingIndex(999);
            panel.active = true;
            // Android hardware back inside the confirm resolves as
            // "cancel". Push our closer onto the back-key stack —
            // pop happens in closeConfirmModal.
            BackKeyManager.push(this._confirmBack);
        });
    }

    /** Bound back-handler for the shared confirm modal. Same fn ref
     *  used for push+pop so BackKeyManager can deduplicate. */
    private _confirmBack = (): void => { this.closeConfirmModal(false); };

    private wireConfirmModalOnce(): void {
        if (this._confirmModalWired) return;
        this._confirmModalWired = true;
        if (this.authoredConfirmModalConfirmButton) {
            const btn = this.authoredConfirmModalConfirmButton;
            btn.node.off('click');
            btn.node.on('click', () => this.closeConfirmModal(true), this);
        }
        if (this.authoredConfirmModalCancelButton) {
            const btn = this.authoredConfirmModalCancelButton;
            btn.node.off('click');
            btn.node.on('click', () => this.closeConfirmModal(false), this);
        }
    }

    private closeConfirmModal(confirmed: boolean): void {
        if (this.authoredConfirmModal) this.authoredConfirmModal.active = false;
        BackKeyManager.pop(this._confirmBack);
        const cb = this._confirmPendingResolve;
        this._confirmPendingResolve = null;
        if (cb) cb(confirmed);
    }

    /** Default back-key fallback — fires when NO popup handler is on
     *  the BackKeyManager stack (i.e. player is at main-mode-select
     *  or the game screen and hit back). Shows an exit-confirm modal;
     *  on confirm we quit via game.end() (same primitive the ban
     *  modal uses). Second back INSIDE the confirm dismisses it as
     *  cancel (see BackKeyManager wiring in showConfirm above). */
    private _exitConfirmActive = false;
    private async _onBackAtMainMenu(): Promise<void> {
        if (this._exitConfirmActive) return;   // paranoia — showConfirm dedupes
        this._exitConfirmActive = true;
        try {
            const ok = await this.showConfirm(
                t('exit.title'),
                t('exit.desc'),
                t('exit.confirm'),
                t('exit.cancel'),
            );
            if (ok) {
                log('[MenuController] player confirmed exit — calling game.end()');
                try { game.end(); } catch (e) { console.warn('[MenuController] game.end() threw:', e); }
            }
        } finally {
            this._exitConfirmActive = false;
        }
    }

    // ============================================================
    //  Generic input prompt modal (reusable across callers)
    // ============================================================
    /** Same single-instance rule as showConfirm — a second showPrompt
     *  cancels the first. */
    private _promptPendingResolve: ((value: string | null) => void) | null = null;
    private _promptModalWired: boolean = false;

    /** Show a modal input prompt with a title + EditBox + confirm/cancel
     *  buttons. Returns a Promise that resolves to:
     *    - the TRIMMED input string on confirm (empty string OK if the
     *      caller wants to allow that; empty callers should check for
     *      it themselves before writing state)
     *    - null on cancel, or if the modal panel isn't authored
     *
     *  `maxLength`: forwarded to the EditBox (caller must trust the
     *   OSK enforces; JS-side validation is caller's job).
     *
     *  Example usage — nickname edit:
     *
     *     const next = await this.showPrompt(
     *         t('settings.nickname.title'),
     *         PlayerProfile.name,
     *         t('settings.nickname.placeholder'),
     *         t('common.confirm'),
     *         t('common.cancel'),
     *         MenuController.NICKNAME_MAX_CHARS,
     *     );
     *     if (next === null) return;         // cancelled
     *     if (!next.trim()) return;          // caller policy: reject blank
     *     PlayerProfile.setName(next);
     */
    public showPrompt(
        title: string,
        initialValue: string,
        placeholder: string,
        confirmLabelText: string,
        cancelLabelText: string,
        maxLength?: number,
    ): Promise<string | null> {
        const panel = this.authoredPromptModal;
        if (!panel) {
            console.warn('[Prompt] modal panel not wired in scene — auto-cancelling');
            return Promise.resolve(null);
        }
        return new Promise<string | null>((resolve) => {
            // Take over from any pending prompt (previous one becomes
            // "cancelled").
            const prev = this._promptPendingResolve;
            this._promptPendingResolve = resolve;
            if (prev) prev(null);

            this.wirePromptModalOnce();

            if (this.authoredPromptModalTitle) {
                this.authoredPromptModalTitle.string = title;
            }
            if (this.authoredPromptModalConfirmButton) {
                const lab = this.authoredPromptModalConfirmButton.getComponentInChildren(Label);
                if (lab) lab.string = confirmLabelText;
            }
            if (this.authoredPromptModalCancelButton) {
                const lab = this.authoredPromptModalCancelButton.getComponentInChildren(Label);
                if (lab) lab.string = cancelLabelText;
            }
            if (this.authoredPromptModalInput) {
                const eb = this.authoredPromptModalInput;
                if (typeof maxLength === 'number' && maxLength > 0) eb.maxLength = maxLength;
                eb.placeholder = placeholder;
                eb.string = initialValue ?? '';
                // Focus in the next frame so the OSK actually shows —
                // focus before the panel is visible + laid out is a
                // no-op on some Cocos versions.
                this.scheduleOnce(() => {
                    try { eb.focus(); } catch (_) { /* ignore */ }
                }, 0);
            }
            ensureDimBackdrop(panel);
            panel.setSiblingIndex(999);
            panel.active = true;
        });
    }

    private wirePromptModalOnce(): void {
        if (this._promptModalWired) return;
        this._promptModalWired = true;
        if (this.authoredPromptModalConfirmButton) {
            const btn = this.authoredPromptModalConfirmButton;
            btn.node.off('click');
            btn.node.on('click', () => this.closePromptModal(this.authoredPromptModalInput?.string ?? ''), this);
        }
        if (this.authoredPromptModalCancelButton) {
            const btn = this.authoredPromptModalCancelButton;
            btn.node.off('click');
            btn.node.on('click', () => this.closePromptModal(null), this);
        }
    }

    private closePromptModal(value: string | null): void {
        if (this.authoredPromptModal) this.authoredPromptModal.active = false;
        const cb = this._promptPendingResolve;
        this._promptPendingResolve = null;
        if (cb) cb(value);
    }

    private makeLabel(
        name: string, parent: Node,
        x: number, y: number,
        text: string, fontSize: number,
        anchor: [number, number] = [0.5, 0.5],
    ): Label {
        const n = new Node(name);
        n.parent = parent;
        n.layer = parent.layer;
        const tx = n.addComponent(UITransform);
        tx.setAnchorPoint(anchor[0], anchor[1]);
        n.setPosition(x, y, 0);
        const lab = n.addComponent(Label);
        lab.string = text;
        lab.fontSize = fontSize;
        lab.lineHeight = fontSize * 1.2;
        // Neon-white text (design token: TEXT_BRIGHT).
        lab.color = new Color(245, 245, 255, 255);
        lab.horizontalAlign = Label.HorizontalAlign.CENTER;
        lab.verticalAlign = Label.VerticalAlign.CENTER;
        // Apply the global TTF font (HarmonyOS Sans Condensed) so
        // runtime-created labels match authored ones. No-op if the
        // scene's FontManager component hasn't been wired.
        FontManager.applyToLabel(lab);
        return lab;
    }

    /**
     *  Neon "card" button — dark interior, glowing rounded border in the
     *  passed accent colour. Matches the reference picker cards:
     *    ┌────────────────────┐  ← neon border
     *    │                    │
     *    │      Text          │
     *    │                    │
     *    └────────────────────┘
     *  The `bgColor` argument is repurposed as the neon accent (was solid
     *  fill in the old style; now controls the border + label glow tint).
     */
    private makeButton(
        name: string, parent: Node,
        x: number, y: number, w: number, h: number,
        text: string, bgColor: Color,
        onClick: () => void,
    ): Node {
        const btn = new Node(name);
        btn.parent = parent;
        btn.layer = parent.layer;
        const tx = btn.addComponent(UITransform);
        tx.contentSize.set(w, h);
        btn.setPosition(x, y, 0);

        // ---- Android compatibility ----
        // Cocos 3.8 Android APK: Graphics.roundRect + complex draw chains
        // are unreliable. Use the simplest possible primitive — plain
        // rect() with a single fill(). No rounded corners, but stable
        // across editor and Android APK builds. Sprite with the built-in
        // sprite frame was tried but triggers a texSubImage2D crash in
        // the editor's preview WebGL layer.
        const g = btn.addComponent(Graphics);
        g.fillColor = new Color(bgColor.r, bgColor.g, bgColor.b, 235);
        g.rect(-w / 2, -h / 2, w, h);
        g.fill();

        // Label on top.
        this.makeLabel('Text', btn, 0, 0, text, Math.min(36, w / 6), [0.5, 0.5]);
        btn.addComponent(Button);
        btn.on(Button.EventType.CLICK, onClick, this);
        return btn;
    }


}
