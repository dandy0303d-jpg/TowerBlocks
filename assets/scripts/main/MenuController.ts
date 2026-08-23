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
} from 'cc';
import { GameController } from './GameController';
import { HudController } from './HudController';
import { ensureDimBackdrop } from './UiHelpers';
import { BackgroundController } from './BackgroundController';
import { TowerBaseMist } from './TowerBaseMist';
import { BackgroundCubes } from './BackgroundCubes';
import { TwinkleStars } from './TwinkleStars';
import { LevelSelectStage3D } from './LevelSelectStage3D';
import { LeaderboardController } from './LeaderboardController';
import { TopUpController } from './TopUpController';
import { PlayerProfile } from '../core/PlayerProfile';
import { setBannedHandler, getBannedState, type BannedState } from '../core/Http';
import { fetchWallet } from '../core/WalletApi';
import { BACKEND_BASE_URL } from '../core/BackendConfig';
import { TutorialProgress } from '../core/TutorialProgress';
import { TutorialController } from './TutorialController';
import { t, cycleLang, getLang, subscribe as subscribeLang } from '../core/i18n/I18n';
import {
    getBgmVolume,   setBgmVolume,   cycleBgmVolume,
    getSfxVolume,   setSfxVolume,   cycleSfxVolume,
    getHapticMode,  setHapticMode,
} from '../core/Settings';
import { SoundManager } from '../audio/SoundManager';
import { HapticManager } from '../audio/HapticManager';
import { BgmManager } from '../audio/BgmManager';
import { FontManager } from '../core/FontManager';
import { LevelProgress } from '../core/LevelProgress';
import { LoadingController } from './LoadingController';
// SIWA on channel/app-store. Imports resolve to no-op / iOS-only paths;
// on non-iOS platforms AppleAuth.signIn() rejects with 'platform-unsupported'
// so the button click handler surfaces a benign toast rather than crashing.
import { AppleAuth } from '../channels/apple/AppleAuth';
import { linkAppleAccount, fetchLinkedAccounts, loginWithApple } from '../channels/apple/AppleAuthApi';
import { GoogleAuth } from '../channels/apple/GoogleAuth';
import { linkGoogleAccount, loginWithGoogle } from '../channels/apple/GoogleAuthApi';
import { deletePlayerSelf } from '../core/PlayerApi';
import { IS_DEV_BUILD } from '../core/BuildConfig';
import { fetchConsentStatus } from '../core/ConsentApi';
import { ConsentModal } from './ConsentModal';

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

    @property({ type: Button, tooltip: '无尽模式按钮' })
    modeBtnEndless: Button | null = null;

    @property({ type: Button, tooltip: '关卡模式按钮' })
    modeBtnLevel: Button | null = null;

    @property({ type: Button, tooltip: '闭眼模式按钮（看不到塔，只看到落下的方块）' })
    modeBtnBlind: Button | null = null;

    @property({ type: Button, tooltip: '排行榜按钮（占位，尚未接入后端）' })
    modeBtnLeaderboard: Button | null = null;

    @property({ type: LeaderboardController, tooltip: '排行榜面板控制器（拖场景里挂了 LeaderboardController 的节点进来）' })
    leaderboardController: LeaderboardController | null = null;

    @property({ type: TopUpController, tooltip: '充值面板控制器（拖场景里挂了 TopUpController 的节点进来）' })
    topUpController: TopUpController | null = null;

    @property({ type: TutorialController, tooltip: '新手引导控制器（首次进入第 1 关时弹）— 拖场景里挂了 TutorialController 的节点进来；不拖就直接跳过' })
    tutorialController: TutorialController | null = null;

    @property({ type: Button, tooltip: '重置进度按钮（DEV）' })
    modeBtnResetProgress: Button | null = null;

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

    // ---- 已绑定账号开关（登录 + 解绑一体，登录按钮已废弃）----
    @property({ type: Toggle, tooltip: '谷歌已绑定开关（isChecked 反映当前是否绑定；切换事件暂时只 log）— 可空' })
    authoredSettingsGoogleToggle: Toggle | null = null;

    @property({ type: Toggle, tooltip: '苹果已绑定开关（isChecked 反映当前是否绑定；切换事件暂时只 log）— 可空' })
    authoredSettingsAppleToggle: Toggle | null = null;

    // ---- 触觉反馈开关 ----
    @property({ type: Toggle, tooltip: '震动开关（iOS 触觉反馈，isChecked = 开）— 可空，未拖场景 Toggle 时默认永远开启' })
    authoredSettingsHapticToggle: Toggle | null = null;

    @property({ type: Label, tooltip: '震动行左侧的"震动" i18n 标签，可空' })
    authoredSettingsHapticLabel: Label | null = null;

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

    @property({ type: Label, tooltip: '通用输入弹窗提示 Label（脚本填提示文本，例如改名冷却剩余天数；不填就隐藏）— 可空' })
    authoredPromptModalHint: Label | null = null;

    // ---- 通用 Toast（设置面板内错误提示，例如昵称超长）----
    @property({ type: Node, tooltip: '设置面板通用 Toast 根节点（含背景 + 内部 Label；默认 active=false；脚本会 tween 淡入淡出）— 可空' })
    authoredSettingsToastNode: Node | null = null;

    @property({ type: Label, tooltip: 'Toast 内部 Label（脚本写内容；可空，会自动从 Toast 节点里找）— 可空' })
    authoredSettingsToastLabel: Label | null = null;

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
     *  asynchronously from the server. */
    private _cachedGemBalance: number = 0;

    onLoad(): void {
        log('[TowerBlocks] MenuController.onLoad');
        // Re-translate every tracked label whenever the user toggles
        // the language at runtime. Stored unsub fires in onDestroy.
        this.langUnsub = subscribeLang(() => this.refreshI18nLabels());
    }

    onDestroy(): void {
        if (this.langUnsub) { this.langUnsub(); this.langUnsub = null; }
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

            // Fire a lightweight authenticated request (wallet fetch)
            // so a banned player hits the 403 + modal BEFORE the main
            // menu shows. Fire-and-forget — non-ban errors don't block
            // boot; if it fails for any other reason the menu still
            // comes up.
            fetchWallet().catch((err) => {
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
                const clearedCount = p?.bestScores?.level ?? 0;
                if (clearedCount > 0) {
                    // Max-merge with whatever's already in localStorage
                    // so a player who just cleared a level on this
                    // device doesn't get bumped BACK if the upload race
                    // lost. Server-side best-of merging keeps subsequent
                    // submissions monotone anyway.
                    const localIdx = LevelProgress.maxClearedIdx;
                    const serverIdx = clearedCount - 1;
                    if (serverIdx > localIdx) {
                        LevelProgress.restoreFrom(serverIdx);
                        log(`[MenuController] boot restored LevelProgress from server: ${localIdx} -> ${serverIdx}`);
                    }
                }
                log(`[MenuController] boot profile ready — bestScores=${JSON.stringify(p?.bestScores)}`);
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
                log('[MenuController] tutorial done — showing main menu');
                this.showModeSelect();
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
        this.modeSelectPanel.active  = true;
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
    }

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
        this.levelStage3D.showForLevel(
            LevelProgress.currentIdx,
            (idx: number) => this.enterLevelFromStage3D(idx),
            () => this.showModeSelect(),
        );
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

        const releaseGuard = () => { this._enteringLevel = false; };

        const hud: any = this.hudController as any;
        const flatLevels = (this.gameController as any)?.flatLevels as Array<any> | undefined;
        const rawLvl = flatLevels && flatLevels[idx];

        // NEW ORDER: hide UI → scatter → fate preview → enter game.
        // Previously the fate preview ran first, but the player asked
        // for it to land AFTER the tower's exit-scatter so the modal
        // pops on a clean stage instead of over an intact tower.
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
            if (hud && typeof hud.showFatePreview === 'function' && rawLvl) {
                hud.showFatePreview(rawLvl, () => this.doEnterLevel(idx, releaseGuard), 500);
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
    private doEnterLevel(idx: number, onGameplayReady?: () => void): void {
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

        this.gameController?.loadLevelByIndex(idx);
        // Assembly shot — every board cube starts off-screen and tweens
        // to its target position. Game logic (piece falling, input) is
        // paused inside GameController until this completes.
        if (this.gameController && typeof this.gameController.playLevelAssembly === 'function') {
            this.gameController.playLevelAssembly(this.enterAssembleSec, () => {
                if (onGameplayReady) onGameplayReady();
            });
        } else if (onGameplayReady) {
            onGameplayReady();
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
        const title = isLevel ? t('result.levelFail') : t('result.gameOver');
        const subtitle = reason === 1 ? t('result.fail.hole')
                       : reason === 2 ? t('result.fail.tall')
                       : '';
        this.buildResultPanel(title, subtitle, this.makeFailButtons());
    }

    /** Level cleared. */
    public showLevelWin(): void {
        // Level-mode wins skip the result popup entirely. Hide the HUD
        // FIRST so the scatter animation plays over a clean scene (no
        // pause button / energy bar hanging around while the cubes
        // fly away), THEN play scatter, THEN jump back to the 3D
        // level-select stage.
        if (this.currentLevelIdx >= 0) {
            if (this.hudController) this.hudController.setHudVisible(false);
            const gotoSelect = () => {
                this.showLevelSelect();
                this.setGameplayVisible(false);
                // Play the "level cleared" SFX HERE — not at the
                // moment of onLevelWin, because line_clear + shatter
                // were still ringing then and would drown it out.
                // Firing at the level-select transition guarantees the
                // player hears it clearly on a quiet scene. Only in
                // the post-win path, so entering level-select from
                // the main menu stays silent.
                SoundManager.instance?.play('level_win');
            };
            if (this.gameController
                && typeof this.gameController.playLevelScatter === 'function') {
                this.gameController.playLevelScatter(this.exitLevelScatterSec, gotoSelect);
            } else {
                gotoSelect();
            }
            return;
        }
        // Endless never triggers onLevelWin — nothing to do.
    }

    private makeFailButtons(): Array<{ label: string; action: () => void }> {
        if (this.currentLevelIdx >= 0) {
            return [
                { label: t('result.retry'), action: () => this.startLevel(this.currentLevelIdx) },
                { label: t('result.home'),  action: () => { this.dismissResultPanel(); this.showModeSelect(); } },
            ];
        } else if (this.blindModeActive) {
            return [
                { label: t('result.endlessRetry'), action: () => this.startBlind() },
                { label: t('result.home'),         action: () => { this.dismissResultPanel(); this.showModeSelect(); } },
            ];
        } else {
            return [
                { label: t('result.endlessRetry'), action: () => this.startEndless() },
                { label: t('result.home'),         action: () => { this.dismissResultPanel(); this.showModeSelect(); } },
            ];
        }
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
            this.leaderboardController.show('endless');
        } else {
            console.log('[MenuController] Leaderboard tapped — controller not wired.');
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
        bindBtn(this.modeBtnEndless,       'menu.endless',     () => this.enterEndless());
        bindBtn(this.modeBtnLevel,         'menu.levels',      () => this.showLevelSelect());
        bindBtn(this.modeBtnBlind,         'menu.blind',       () => this.enterBlindMode());
        bindBtn(this.modeBtnLeaderboard,   'menu.leaderboard', () => this.onLeaderboardClicked());
        bindBtn(this.modeBtnSettings,      'settings.button',  () => this.openSettingsPanel());
        // Reset progress button: DEV-only. Hidden in release builds so
        // players can't nuke their own save by accident (and to keep
        // the main menu clean). IS_DEV_BUILD is set per branch — see
        // assets/scripts/core/BuildConfig.ts.
        if (IS_DEV_BUILD) {
            bindBtn(this.modeBtnResetProgress, 'menu.reset',   () => this.onResetProgressClicked());
        } else if (this.modeBtnResetProgress) {
            this.modeBtnResetProgress.node.active = false;
        }
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
        // Row 0: language (cycle button, required).
        wireBtn(0, () => cycleLang());
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

        // BGM slider — continuous drag, no snap.
        if (this.authoredSettingsBgmSlider) {
            const sliderNode = this.authoredSettingsBgmSlider.node;
            sliderNode.off('slide');
            sliderNode.on('slide', () => {
                const s = this.authoredSettingsBgmSlider;
                if (!s) return;
                const v = Math.max(0, Math.min(1, s.progress));
                setBgmVolume(v, false);
                const bgm = BgmManager.instance;
                if (bgm) {
                    bgm.setEnabled(v > 0);
                    bgm.setMasterVolume(v);
                }
                // Only update the value label + fill — do NOT re-write
                // slider progress (would fight the user's drag).
                const lab = this.authoredSettingsRowValueLabels[1];
                if (lab) lab.string = this.formatAudioLabel(v);
                if (this.authoredSettingsBgmFill) this.authoredSettingsBgmFill.fillRange = v;
            }, this);
        }
        // SFX slider — same shape as BGM.
        if (this.authoredSettingsSfxSlider) {
            const sliderNode = this.authoredSettingsSfxSlider.node;
            sliderNode.off('slide');
            sliderNode.on('slide', () => {
                const s = this.authoredSettingsSfxSlider;
                if (!s) return;
                const v = Math.max(0, Math.min(1, s.progress));
                setSfxVolume(v, false);
                const sfx = SoundManager.instance;
                if (sfx) {
                    sfx.setEnabled(v > 0);
                    sfx.setMasterVolume(v);
                }
                const lab = this.authoredSettingsRowValueLabels[2];
                if (lab) lab.string = this.formatAudioLabel(v);
                if (this.authoredSettingsSfxFill) this.authoredSettingsSfxFill.fillRange = v;
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

        // ---- Google / Apple linked toggles ----
        // Login-button @property fields removed — the Toggle IS the
        // click surface now. Tap toggle to bind, tap again to attempt
        // unbind (not implemented yet, snaps back).
        // Toggle ON when NOT bound  → same as tapping the "Apple 登录" btn
        //                             (kicks off SIWA + link flow).
        // Toggle OFF when bound     → unbind not implemented yet. We snap
        //                             the check back on via refresh so
        //                             the UI stays truthful. If we ever
        //                             ship an unbind flow, replace the
        //                             snap-back with the real call.
        // Toggle ON when already ON → no-op (handleAppleLoginClick's
        //                             own early-out covers this).
        // NOTE ON DUAL-BIND LOOP:
        // A user can be bound to BOTH Apple and Google. reconcile picks
        // ONE as `accountType` (apple wins today), but sets BOTH toggles
        // to their true bind state. If we only check `accountType` here,
        // Google Toggle=true + accountType='apple' would re-fire login.
        // Guard by checking `_knownLinkedProviders` (server-authoritative
        // set) — only trigger login when a provider is truly NOT bound.
        // Also suppress toggle events during programmatic isChecked=
        // assignment (Cocos fires 'toggle' on both user + programmatic).
        if (this.authoredSettingsGoogleToggle) {
            const gt = this.authoredSettingsGoogleToggle;
            gt.node.off('toggle');
            gt.node.on('toggle', () => {
                if (this._suppressToggleEvents) return;
                log(`[Settings] Google toggle → ${gt.isChecked}`);
                const alreadyBound = this._knownLinkedProviders.has('google');
                if (gt.isChecked && !alreadyBound) {
                    void this.handleGoogleLoginClick();
                } else if (!gt.isChecked && alreadyBound) {
                    log('[Settings] Google toggle OFF — unbind not implemented, snapping back');
                    this.refreshAuthoredSettingsValues();
                }
                // isChecked matches the bound state (either both true
                // or both false) → no-op, don't re-trigger login.
            }, this);
        }
        if (this.authoredSettingsAppleToggle) {
            const at = this.authoredSettingsAppleToggle;
            at.node.off('toggle');
            at.node.on('toggle', () => {
                if (this._suppressToggleEvents) return;
                log(`[Settings] Apple toggle → ${at.isChecked}`);
                const alreadyBound = this._knownLinkedProviders.has('apple');
                if (at.isChecked && !alreadyBound) {
                    void this.handleAppleLoginClick();
                } else if (!at.isChecked && alreadyBound) {
                    log('[Settings] Apple toggle OFF — unbind not implemented, snapping back');
                    this.refreshAuthoredSettingsValues();
                }
            }, this);
        }

        // ---- Haptic feedback toggle ----
        // On/off flips Settings.hapticMode which HapticManager reads.
        // Fires a preview 'medium' impact when turned ON so the player
        // feels the change without needing to trigger gameplay.
        if (this.authoredSettingsHapticToggle) {
            const ht = this.authoredSettingsHapticToggle;
            ht.node.off('toggle');
            ht.node.on('toggle', () => {
                setHapticMode(ht.isChecked ? 'on' : 'off');
                log(`[Settings] haptic → ${ht.isChecked ? 'on' : 'off'}`);
                if (ht.isChecked) HapticManager.instance.impact('medium');
            }, this);
        }

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

    /** Sign in with Apple → link current guest uuid → refresh UI.
     *
     *  If already linked, no-op with a friendly log.
     *  If Apple returns user-cancelled, silent — user just backed out.
     *  Otherwise log the error kind; UI shows unchanged (toggle stays OFF).
     *
     *  In-flight guard: the button node is disabled while the sheet is
     *  up, so double-taps don't trigger overlapping flows. */
    private async handleAppleLoginClick(): Promise<void> {
        if (PlayerProfile.accountType === 'apple') {
            log('[Settings] Apple already linked — no-op');
            return;
        }
        let cachedIdentityToken: string | null = null;
        try {
            log('[Settings] Apple login tapped — starting SIWA flow');
            const cred = await AppleAuth.signIn();
            cachedIdentityToken = cred.identityToken;
            log(`[Settings] SIWA success — appleSub=${cred.appleSub.substring(0, 12)}..., calling /player/link/apple`);
            const result = await linkAppleAccount(cred.identityToken, cred.appleSub, cred.authorizationCode);
            log(`[Settings] link result — linked=${result.linked}, alreadyLinked=${result.alreadyLinked}`);
            PlayerProfile.setAccountType('apple');
            this._knownLinkedProviders.add('apple');
            // Show the loading overlay while we sync the newly-bound
            // account state (server-authoritative profile + level
            // progress) so the transition looks intentional. Settings
            // panel closes first so the overlay sits over the main
            // menu the player returns to.
            this.closeSettingsPanel();
            await this.runWithReloadOverlay(async () => {
                try {
                    const p = await PlayerProfile.fetchProfile();
                    LevelProgress.restoreFrom((p.bestScores?.level ?? 0) - 1);
                } catch (e) {
                    console.warn(`[Settings] fetchProfile after bind failed: ${(e as Error).message}`);
                }
                this.refreshAuthoredSettingsValues();
            });
            this.showSettingsToast(t('settings.bind.success'));
        } catch (err) {
            const msg = (err as Error).message ?? String(err);
            if (msg.startsWith('user-cancelled') || msg.startsWith('platform-unsupported')) {
                log(`[Settings] SIWA aborted: ${msg}`);
                // Only toast user-initiated cancel; a platform-unsupported
                // path shouldn't reach real users (button is iOS-only).
                if (msg.startsWith('user-cancelled')) {
                    this.showSettingsToast(t('settings.bind.cancelled'));
                }
                // Snap the Apple toggle back off — user may have flipped
                // it ON to trigger this flow; the bind didn't happen so
                // the UI shouldn't claim it did.
                this.refreshAuthoredSettingsValues();
                return;
            }
            // "This Apple ID is bound to another player" — offer recovery
            // via the generic confirm modal (same UX as delete-account).
            // The server returns 409 with body {"error":"apple already linked"}
            // which Http.ts serializes as `HTTP 409: {"error":"..."}`.
            if (msg.includes('apple already linked') && cachedIdentityToken) {
                // finally{} will re-enable the button before we await; that's
                // fine — showConfirm's modal blocks further Apple clicks.
                const token = cachedIdentityToken;
                void (async () => {
                    const ok = await this.showConfirm(
                        t('settings.appleRecovery.title'),
                        t('settings.appleRecovery.desc'),
                        t('common.confirm'),
                        t('common.cancel'),
                    );
                    if (!ok) {
                        log('[Settings] Apple recovery cancelled by user');
                        // Recovery not confirmed → bind still didn't happen,
                        // snap toggle back off.
                        this.refreshAuthoredSettingsValues();
                        return;
                    }
                    await this.commitAppleRecovery(token);
                })();
                return;
            }
            console.warn(`[Settings] SIWA / link failed: ${msg}`);
            this.showSettingsToast(t('settings.bind.failed'));
            // Bind failed for some other reason → snap toggle back off.
            this.refreshAuthoredSettingsValues();
        }
    }

    /** Actually recover the linked account.
     *  1. POST /player/login/apple with the identity token
     *  2. Server returns {uuid, bearer} for the previously-linked account
     *  3. Swap local PlayerProfile state (uuid, bearer, accountType='apple')
     *  4. Refresh Settings UI — wallet / linked accounts re-fetch under the new uuid */
    private async commitAppleRecovery(identityToken: string): Promise<void> {
        try {
            log('[Settings] Apple recovery — calling /player/login/apple');
            const r = await loginWithApple(identityToken);
            log(`[Settings] Apple recovery success — recovered uuid=${r.uuid}`);
            PlayerProfile.swapToRecoveredAccount(r.uuid, r.bearer);
            this.closeSettingsPanel();
            await this.runWithReloadOverlay(async () => {
                // swap wipes the local name (it belongs to the OLD guest
                // uuid). Pull the recovered account's real name + avatar
                // + best scores so refreshAuthoredSettingsValues() paints
                // from authoritative data. Non-fatal if fetch fails — the
                // placeholder will be replaced on next Settings open.
                try {
                    const p = await PlayerProfile.fetchProfile();
                    log(`[Settings] recovered profile — name="${p.name}", avatarIdx=${p.avatarIdx}, bestScores=${JSON.stringify(p.bestScores)}`);
                    // Server stores level-mode best score = count of
                    // levels cleared. Convert to idx (0-based) before
                    // restoring. Guard against undefined/negative just
                    // in case the server hasn't tracked any yet.
                    const clearedCount = p.bestScores?.level ?? 0;
                    LevelProgress.restoreFrom(clearedCount - 1);
                    log(`[Settings] LevelProgress restored to maxClearedIdx=${clearedCount - 1}`);
                } catch (e) {
                    console.warn(`[Settings] fetchProfile after recovery failed: ${(e as Error).message}`);
                }
                this.refreshAuthoredSettingsValues();
            });
            this.showSettingsToast(t('settings.appleRecovery.success'));
        } catch (err) {
            const msg = (err as Error).message ?? String(err);
            console.warn(`[Settings] Apple recovery failed: ${msg}`);
            this.showSettingsToast(t('settings.appleRecovery.failed'));
            // Recovery failed → user is still on the original guest uuid;
            // snap toggle back off so it doesn't misrepresent bind state.
            this.refreshAuthoredSettingsValues();
        }
    }

    // ============================================================
    //  Google Sign-In flow — mirrors Apple's shape end-to-end
    // ============================================================

    /** Kick off the Google Sign-In flow. Mirrors handleAppleLoginClick:
     *  ASWebAuthenticationSession → server /player/link/google →
     *  refresh profile + LevelProgress under the loading overlay →
     *  toast success. On 409 (google already linked to another uuid)
     *  the confirm modal offers to recover instead. */
    private async handleGoogleLoginClick(): Promise<void> {
        if (PlayerProfile.accountType === 'google') {
            log('[Settings] Google already linked — no-op');
            return;
        }
        let cachedIdToken: string | null = null;
        try {
            log('[Settings] Google login tapped — starting OAuth flow');
            const cred = await GoogleAuth.signIn();
            cachedIdToken = cred.idToken;
            log(`[Settings] Google sign-in success — googleSub=${cred.googleSub.substring(0, 12)}..., calling /player/link/google`);
            const result = await linkGoogleAccount(cred.idToken);
            log(`[Settings] link result — linked=${result.linked}, alreadyLinked=${result.alreadyLinked}`);
            PlayerProfile.setAccountType('google');
            this._knownLinkedProviders.add('google');
            this.closeSettingsPanel();
            await this.runWithReloadOverlay(async () => {
                try {
                    const p = await PlayerProfile.fetchProfile();
                    LevelProgress.restoreFrom((p.bestScores?.level ?? 0) - 1);
                } catch (e) {
                    console.warn(`[Settings] fetchProfile after Google bind failed: ${(e as Error).message}`);
                }
                this.refreshAuthoredSettingsValues();
            });
            this.showSettingsToast(t('settings.bind.success'));
        } catch (err) {
            const msg = (err as Error).message ?? String(err);
            if (msg.startsWith('user-cancelled') || msg.startsWith('platform-unsupported')) {
                log(`[Settings] Google sign-in aborted: ${msg}`);
                if (msg.startsWith('user-cancelled')) {
                    this.showSettingsToast(t('settings.bind.cancelled'));
                }
                this.refreshAuthoredSettingsValues();
                return;
            }
            // 409 = 'google already linked to another uuid' — same
            // recovery UX as Apple.
            if (msg.includes('google already linked') && cachedIdToken) {
                const token = cachedIdToken;
                void (async () => {
                    const ok = await this.showConfirm(
                        t('settings.googleRecovery.title'),
                        t('settings.googleRecovery.desc'),
                        t('common.confirm'),
                        t('common.cancel'),
                    );
                    if (!ok) {
                        log('[Settings] Google recovery cancelled by user');
                        this.refreshAuthoredSettingsValues();
                        return;
                    }
                    await this.commitGoogleRecovery(token);
                })();
                return;
            }
            console.warn(`[Settings] Google sign-in / link failed: ${msg}`);
            this.showSettingsToast(t('settings.bind.failed'));
            this.refreshAuthoredSettingsValues();
        }
    }

    /** Recover a previously-linked Google account — mirrors
     *  commitAppleRecovery: POST /player/login/google → swap identity
     *  → pull fresh profile + LevelProgress under loading overlay. */
    private async commitGoogleRecovery(idToken: string): Promise<void> {
        try {
            log('[Settings] Google recovery — calling /player/login/google');
            const r = await loginWithGoogle(idToken);
            log(`[Settings] Google recovery success — recovered uuid=${r.uuid}`);
            PlayerProfile.swapToRecoveredAccount(r.uuid, r.bearer);
            // swap defaults accountType='apple' inside PlayerProfile
            // (SIWA was implemented first). Override to 'google' here
            // so the Settings toggles paint correctly.
            PlayerProfile.setAccountType('google');
            this.closeSettingsPanel();
            await this.runWithReloadOverlay(async () => {
                try {
                    const p = await PlayerProfile.fetchProfile();
                    log(`[Settings] recovered Google profile — name="${p.name}", bestScores=${JSON.stringify(p.bestScores)}`);
                    LevelProgress.restoreFrom((p.bestScores?.level ?? 0) - 1);
                } catch (e) {
                    console.warn(`[Settings] fetchProfile after Google recovery failed: ${(e as Error).message}`);
                }
                this.refreshAuthoredSettingsValues();
            });
            this.showSettingsToast(t('settings.googleRecovery.success'));
        } catch (err) {
            const msg = (err as Error).message ?? String(err);
            console.warn(`[Settings] Google recovery failed: ${msg}`);
            this.showSettingsToast(t('settings.googleRecovery.failed'));
            this.refreshAuthoredSettingsValues();
        } finally {
            if (btn) btn.getComponent(Button)!.interactable = true;
        }
    }

    /** Double-tap-confirm state for the Delete Account button. When
     *  null the button is idle; when non-null the button is "armed"
     *  and a second click within DELETE_ARM_WINDOW_MS commits. */
    private deleteAccountArmTimer: number | null = null;

    private static readonly DELETE_ARM_WINDOW_MS = 5000;

    /** Delete Account button handler. Two-tap pattern:
     *    1st tap  → arm — button label flips to "再次点击确认删除",
     *               5-second timer resets it back if no follow-up.
     *    2nd tap  → commit — API call + wipe local storage + reload
     *               the current scene into fresh guest state.
     *
     *  We deliberately DON'T pop a native modal — Cocos 3.x doesn't
     *  ship one, and Apple's App Review has accepted this in-app-only
     *  double-confirm pattern (see e.g. many indie games shipping the
     *  same UX). If reviewers ever push back we upgrade to a proper
     *  confirmation panel or a native UIAlertController bridge. */
    private handleDeleteAccountClick(): void {
        const btn = this.authoredSettingsDeleteAccountButton;
        if (!btn) return;
        const lab = btn.getComponentInChildren(Label);

        // Second click inside the arm window — commit.
        if (this.deleteAccountArmTimer !== null) {
            clearTimeout(this.deleteAccountArmTimer);
            this.deleteAccountArmTimer = null;
            this.commitDeleteAccount();
            return;
        }

        // First click — arm.
        log('[Settings] Delete account armed — waiting 5s for confirmation click');
        if (lab) lab.string = t('settings.deleteAccount.confirm');
        // Turn the button red-ish while armed. Only if it has a Sprite
        // to color — best-effort; skip if not.
        const bgSprite = btn.node.getComponent(Sprite);
        const originalColor = bgSprite ? bgSprite.color.clone() : null;
        if (bgSprite) bgSprite.color = new Color(220, 60, 60, 255);

        this.deleteAccountArmTimer = setTimeout(() => {
            this.deleteAccountArmTimer = null;
            log('[Settings] Delete account confirmation timed out — reset');
            if (lab) lab.string = t('settings.deleteAccount');
            if (bgSprite && originalColor) bgSprite.color = originalColor;
        }, MenuController.DELETE_ARM_WINDOW_MS) as unknown as number;
    }

    /** Actually delete the account. Called after the second confirmation
     *  tap. Fire-and-forget promise chain — failures log but don't
     *  brick the UI (button reset happens either way in the caller). */
    private async commitDeleteAccount(): Promise<void> {
        const btn = this.authoredSettingsDeleteAccountButton;
        const lab = btn?.getComponentInChildren(Label) ?? null;
        // Disable to prevent further clicks during the network round-trip.
        if (btn) btn.getComponent(Button)!.interactable = false;
        if (lab) lab.string = t('settings.deleteAccount.pending');
        try {
            log('[Settings] Delete account — calling DELETE /player/self');
            await deletePlayerSelf();
            log('[Settings] Server-side delete OK — wiping local state');
            // Wipe every player-scoped localStorage key. Nuclear option
            // (localStorage.clear()) would also wipe settings like
            // volume/language which players probably want to keep —
            // enumerate the player-identity keys explicitly.
            sys.localStorage.removeItem('tt.player.uuid');
            sys.localStorage.removeItem('tt.player.name');
            sys.localStorage.removeItem('tt.player.accountType');
            sys.localStorage.removeItem('tt.player.token');
            sys.localStorage.removeItem('tt.player.tokenExpEpochSec');
            sys.localStorage.removeItem('tt.player.avatarIdx');
            // Wipe PlayerProfile's in-memory cache. Without this the
            // module-level singleton would keep serving the deleted
            // uuid, which no longer exists server-side → any subsequent
            // API call fails with 500 (FK violation on player_wallets)
            // or 401 (bearer no longer maps to a player row).
            PlayerProfile.resetInMemoryState();
            log('[Settings] Re-registering as fresh guest…');
            // Re-run register to mint a new anonymous uuid + bearer.
            // This is ~200ms — much cheaper than reloading the whole
            // scene (30-60 seconds on iOS due to asset/pool teardown).
            await PlayerProfile.ensureRegistered();
            log('[Settings] Fresh guest ready — refreshing Settings UI');
            // Repaint whatever's currently visible in Settings:
            //   - wallet balance → 0
            //   - Apple toggle → OFF
            //   - AccountTypeLabel → "游客"
            //   - nickname EditBox → new user-XXXX
            this.refreshAuthoredSettingsValues();
        } catch (err) {
            const msg = (err as Error).message ?? String(err);
            console.warn(`[Settings] delete account failed: ${msg}`);
            if (lab) lab.string = t('settings.deleteAccount.failed');
            // Re-enable button after a brief cool-down so user can retry.
            setTimeout(() => {
                if (btn) btn.getComponent(Button)!.interactable = true;
                if (lab) lab.string = t('settings.deleteAccount');
            }, 3000);
        }
    }

    /** Max nickname length (characters). Also mirror on the EditBox's
     *  `MaxLength` inspector field so the on-screen keyboard stops
     *  accepting past this limit; this constant is the JS-side belt
     *  in case someone paste-drops a longer string past that gate. */
    private static readonly NICKNAME_MAX_CHARS = 20;

    // ---- Nickname change cooldown (client-side) ----
    //
    // Players can only change their nickname once every 7 days.
    // Timestamp is stored in localStorage and read at modal open time
    // to render the remaining-days hint. Cheatable via device-clock
    // rollback — server-side enforcement is a follow-up (add a
    // `nickname_changed_at` column + reject PUT /player/profile when
    // within cooldown). Client gate catches honest players and
    // provides the required UX.
    private static readonly NICKNAME_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
    private static readonly NICKNAME_CHANGED_AT_KEY = 'nicknameChangedAt';

    /** Read the last recorded nickname change timestamp (ms epoch), or
     *  0 if never changed / storage unavailable / malformed. */
    private static readNicknameChangedAt(): number {
        if (typeof localStorage === 'undefined') return 0;
        const raw = localStorage.getItem(MenuController.NICKNAME_CHANGED_AT_KEY);
        const n = raw ? Number(raw) : 0;
        return Number.isFinite(n) && n > 0 ? n : 0;
    }

    /** Persist the current time as the last nickname change. Called on
     *  successful setName only — a rejected change (profanity, network)
     *  should NOT arm the cooldown. */
    private static markNicknameChanged(): void {
        if (typeof localStorage === 'undefined') return;
        try {
            localStorage.setItem(MenuController.NICKNAME_CHANGED_AT_KEY, String(Date.now()));
        } catch { /* full/private mode — noop */ }
    }

    /** Whole days remaining until the player can change their nickname
     *  again. Prefers the server-authoritative `nicknameNextChangeAt`
     *  (from GET /profile / mutating PUTs); falls back to localStorage
     *  when the server hasn't reported yet or is on an older build.
     *  Rounds UP so "6.1 days left" reads as "7 days". */
    public static remainingNicknameCooldownDays(): number {
        const serverReadyAt = PlayerProfile.nicknameNextChangeAt;
        const localLast = MenuController.readNicknameChangedAt();
        const localReadyAt = localLast > 0
            ? localLast + MenuController.NICKNAME_COOLDOWN_MS
            : 0;
        // Take whichever is later — server truth wins when present,
        // local truth catches offline-changed-then-came-back-online.
        const readyAt = Math.max(serverReadyAt ?? 0, localReadyAt);
        if (readyAt === 0) return 0;
        const msLeft = readyAt - Date.now();
        if (msLeft <= 0) return 0;
        return Math.ceil(msLeft / (24 * 60 * 60 * 1000));
    }

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
        PlayerProfile.setName(trimmed);
        eb.string = PlayerProfile.name;   // reflects any server-side truncation once we add it
        log(`[Settings] nickname saved: ${PlayerProfile.name}`);
    }

    /** Open the generic input prompt to edit the nickname.
     *  Confirm → validate → PlayerProfile.setName → repaint the display
     *  Label (and the legacy EditBox if it's still wired for backward
     *  compat with old scenes). Cancel → no-op. */
    private async editNicknameViaPrompt(): Promise<void> {
        const currentName = PlayerProfile.name;
        // 7-day nickname change cooldown. Timestamp lives in
        // localStorage — see NICKNAME_COOLDOWN_MS / readNicknameChangedAt.
        // Server-side enforcement is a follow-up; this catches honest
        // players and gives visible UX for the limit.
        const remainingDays = MenuController.remainingNicknameCooldownDays();
        const hint = remainingDays > 0
            ? t('settings.nickname.cooldown', { n: remainingDays })
            : t('settings.nickname.cooldownReady');
        const next = await this.showPrompt(
            t('settings.nickname.title'),
            currentName,
            t('settings.nickname.placeholder'),
            t('common.confirm'),
            t('common.cancel'),
            MenuController.NICKNAME_MAX_CHARS,
            hint,
        );
        if (next === null) {
            log('[Settings] nickname edit cancelled');
            return;
        }
        // Re-check cooldown at submit time in case the user opened the
        // modal exactly at the boundary (or the day rolled over while
        // the modal was open). Reject with a toast if still on cooldown.
        const remainingAtSubmit = MenuController.remainingNicknameCooldownDays();
        if (remainingAtSubmit > 0) {
            this.showSettingsToast(t('settings.nickname.cooldown', { n: remainingAtSubmit }));
            log(`[Settings] nickname change blocked — ${remainingAtSubmit} day(s) remaining`);
            return;
        }
        const trimmed = next.trim();
        if (trimmed.length > MenuController.NICKNAME_MAX_CHARS) {
            this.showSettingsToast(
                t('settings.nickname.tooLong', { n: MenuController.NICKNAME_MAX_CHARS }),
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
        try {
            await PlayerProfile.setName(trimmed);
            // Record the successful change timestamp so the 7-day
            // cooldown starts from now. Only on success — a rejected
            // change (profanity, server error) should NOT arm the timer.
            MenuController.markNicknameChanged();
        } catch (err) {
            const msg = (err as Error)?.message ?? String(err);
            // 429 nickname:cooldown — PlayerProfile.setName already
            // updated the cached nicknameNextChangeAt from the server's
            // retryAt; re-read the remaining days off that and show a
            // precise toast. Falls back to generic message if the body
            // couldn't be parsed.
            if (msg.startsWith('HTTP 429') && msg.includes('nickname:cooldown')) {
                const days = MenuController.remainingNicknameCooldownDays();
                this.showSettingsToast(t('settings.nickname.cooldown', { n: days || 1 }));
                log(`[Settings] nickname change rejected by server cooldown — ${days} day(s) remaining`);
                return;
            }
            // Server returns 400 with error body 'nickname: <code>'
            // (see server/src/nickname-validator.ts). Map each code
            // to a specific toast so the player knows WHY.
            let toastKey = 'settings.nickname.rejected';   // generic fallback
            if (msg.includes('nickname: profanity')) toastKey = 'settings.nickname.profanity';
            else if (msg.includes('nickname: reserved')) toastKey = 'settings.nickname.reserved';
            else if (msg.includes('nickname: too-long')) toastKey = 'settings.nickname.tooLongServer';
            else if (msg.includes('nickname: too-short')) toastKey = 'settings.nickname.tooShort';
            log(`[Settings] nickname rejected by server: ${msg}`);
            this.showSettingsToast(t(toastKey));
            return;
        }
        // Repaint the Settings screen so the new name shows immediately.
        this.refreshAuthoredSettingsValues();
        log(`[Settings] nickname saved via prompt: ${PlayerProfile.name}`);
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
     *  3. Wipe every player-scoped localStorage key
     *  4. PlayerProfile.resetInMemoryState() — clears cached uuid,
     *     name, accountType, avatarIdx, AND the Http bearer token
     *  5. ensureRegistered() → mint fresh anonymous account
     *  6. Refresh Settings UI — wallet=0, toggles OFF, guest label
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
            // From here on, the operation cannot be aborted — go through
            // the loading overlay to give the player a clear "reloading
            // with new data" transition instead of a jarring stale-UI
            // flash. closeSettingsPanel + hide top-up so the overlay
            // covers only the main menu underneath.
            this.closeSettingsPanel();
            await this.runWithReloadOverlay(async () => {
                // Wipe player-scoped localStorage keys (keep audio/language
                // etc — those are per-device preferences, not per-account).
                sys.localStorage.removeItem('tt.player.uuid');
                sys.localStorage.removeItem('tt.player.name');
                sys.localStorage.removeItem('tt.player.accountType');
                sys.localStorage.removeItem('tt.player.token');
                sys.localStorage.removeItem('tt.player.tokenExpEpochSec');
                sys.localStorage.removeItem('tt.player.avatarIdx');
                // Also wipe level progress — the deleted account's
                // cleared levels don't belong to the fresh guest.
                LevelProgress.reset();
                // Clear PlayerProfile's in-memory cache — without this, the
                // module-level singleton would keep serving the deleted
                // uuid, which no longer exists server-side.
                PlayerProfile.resetInMemoryState();
                this._knownLinkedProviders.clear();
                log('[Settings] re-registering as fresh guest…');
                await PlayerProfile.ensureRegistered();
                log('[Settings] fresh guest ready — refreshing Settings UI');
                this.refreshAuthoredSettingsValues();
            });
        } catch (err) {
            const msg = (err as Error).message ?? String(err);
            console.warn(`[Settings] delete account failed: ${msg}`);
            this.showSettingsToast(t('settings.deleteAccount.failed'));
        } finally {
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
     *  Silently no-ops if the toast node isn't wired. Mirrors the
     *  pattern in TopUpController.showToast. */
    private showSettingsToast(text: string): void {
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
        // Account row Label — "<账号类型> · <uuid> 📋" so player can
        // copy their UUID for customer support / disputes. Full uuid
        // (not truncated) so the copied string is directly usable.
        if (this.authoredSettingsAccountTypeLabel) {
            this.authoredSettingsAccountTypeLabel.string
                = this.formatAccountRow(PlayerProfile.accountType, PlayerProfile.uuid);
        }
        // Google / Apple toggles — reflect the real bind state. Until
        // real OAuth is wired every player is `anonymous`, so both
        // toggles read as OFF. First paint is from local state (fast,
        // no flash); the server-side reconcile below then corrects
        // any drift.
        // Programmatic isChecked= fires 'toggle' events in Cocos —
        // wrap in the suppress flag so the handlers know it's not a
        // user tap.
        //
        // Toggle state is paint from _knownLinkedProviders (server
        // truth) — NOT PlayerProfile.accountType. The accountType only
        // reflects ONE provider (apple wins when both bound), so
        // painting from it would force the OTHER toggle off every
        // refresh + make Google visibly flip whenever the user taps
        // Apple.
        this._suppressToggleEvents = true;
        try {
            if (this.authoredSettingsGoogleToggle) {
                this.authoredSettingsGoogleToggle.isChecked = this._knownLinkedProviders.has('google');
            }
            if (this.authoredSettingsAppleToggle) {
                this.authoredSettingsAppleToggle.isChecked = this._knownLinkedProviders.has('apple');
            }
            if (this.authoredSettingsHapticToggle) {
                this.authoredSettingsHapticToggle.isChecked = (getHapticMode() === 'on');
            }
        } finally {
            this._suppressToggleEvents = false;
        }
        if (this.authoredSettingsHapticLabel) {
            this.trackI18nLabel(this.authoredSettingsHapticLabel, 'settings.haptic');
        }
        // Avatar Sprite — repaint from PlayerProfile in case the player
        // picked a new one since the last open.
        this.paintSettingsAvatar();
        // Ask the server what we're ACTUALLY bound to and reconcile
        // local state / toggles. Handles the case where:
        //   - the local accountType is stale (localStorage restored
        //     from an old backup, or user manually cleared)
        //   - the server-side link was removed (admin action, refund
        //     of Apple ID, etc.)
        //   - the app was reinstalled and the local state got out of
        //     sync with the recovered uuid
        this.reconcileLinkedAccountsFromServer();
    }

    /** Fetch the server-authoritative list of providers this uuid is
     *  bound to and repaint the Settings toggles + label. Silent on
     *  network failure — local state (already painted) is a fine
     *  fallback. Fire-and-forget from refreshAuthoredSettingsValues. */
    private reconcileLinkedAccountsFromServer(): void {
        fetchLinkedAccounts()
            .then((r) => {
                const hasApple  = r.providers.indexOf('apple')  >= 0;
                const hasGoogle = r.providers.indexOf('google') >= 0;
                // Update local PlayerProfile so subsequent reads (e.g.
                // handleAppleLoginClick's early-out) see the truth.
                // Priority order: apple > google > anonymous. Since we
                // only support one label at a time today, apple wins
                // if both are ever bound. Revisit when we have UI to
                // display multiple bindings simultaneously.
                const newAcct = hasApple  ? 'apple'
                              : hasGoogle ? 'google'
                              : 'anonymous';
                if (PlayerProfile.accountType !== newAcct) {
                    log(`[Settings] server reconcile — accountType ${PlayerProfile.accountType} → ${newAcct}`);
                    PlayerProfile.setAccountType(newAcct);
                }
                // Update the known-linked-providers cache so the
                // toggle handlers don't misinterpret a dual-bound
                // repaint as a fresh login attempt.
                this._knownLinkedProviders.clear();
                if (hasApple)  this._knownLinkedProviders.add('apple');
                if (hasGoogle) this._knownLinkedProviders.add('google');
                // Repaint the toggles with the server truth. Suppress
                // toggle events during programmatic isChecked= so we
                // don't re-fire login handlers.
                this._suppressToggleEvents = true;
                try {
                    if (this.authoredSettingsGoogleToggle) {
                        this.authoredSettingsGoogleToggle.isChecked = hasGoogle;
                    }
                    if (this.authoredSettingsAppleToggle) {
                        this.authoredSettingsAppleToggle.isChecked = hasApple;
                    }
                } finally {
                    this._suppressToggleEvents = false;
                }
                // Repaint the account-type label as well. Use
                // formatAccountRow (not accountTypeText) so the UUID +
                // 📋 copy affordance stay visible after server reconcile.
                if (this.authoredSettingsAccountTypeLabel) {
                    this.authoredSettingsAccountTypeLabel.string
                        = this.formatAccountRow(PlayerProfile.accountType, PlayerProfile.uuid);
                }
            })
            .catch((err) => {
                console.warn('[Settings] fetchLinkedAccounts failed (offline?):', err?.message);
            });
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
            // Hard-coded English label — kept in English (matches
            // 'UserID:') so support / disputes can read it regardless
            // of the player's game language. The previous code reused
            // the panel button's i18n key ('修改昵称' / 'Edit Nickname')
            // which read awkwardly out of context (support ticket:
            // "修改昵称: Albert" makes it look like an action, not a
            // field label).
            `Nickname: ${PlayerProfile.name}\n` +
            `UserID: ${PlayerProfile.uuid}`;
        let copied = false;
        let method = 'none';
        const anySys = sys as any;

        // (0) Native bridge — ClipboardBridgeGlue.mm hands off to
        // UIPasteboard directly. Only path that actually works on the
        // Cocos native iOS runtime; sys.setClipboard* below are either
        // missing or no-ops there. Fire-and-forget: assume success on
        // native iOS, don't try the JS/web fallbacks after.
        if (!copied && sys.isNative && sys.os === sys.OS.IOS) {
            try {
                (native as any).bridge.sendToNative('clipboard.copy', text);
                copied = true;
                method = 'native.bridge/clipboard.copy';
            } catch (e) {
                console.warn('[Settings] native clipboard bridge threw:', e);
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
            this.showSettingsToast(t('settings.account.copyFailed'));
        }
    }

    /** Write the current balance into the button's inner label. Uses
     *  `topup.balance` i18n key ("宝石: {n}") for consistency with the
     *  top-up panel's own balance strip. */
    private paintBalanceButton(gems: number): void {
        const btn = this.authoredSettingsBalanceButton;
        if (!btn) return;
        const lab = this.authoredSettingsBalanceLabel
            ?? btn.getComponentInChildren(Label);
        if (lab) lab.string = t('topup.balance', { n: gems.toString() });
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

    /** Set to true around any programmatic assignment to
     *  authored*Toggle.isChecked so the fired 'toggle' event handlers
     *  short-circuit — otherwise we get an infinite login loop
     *  (see the block wire in wireAuthoredSettingsPanel).
     *  See MenuController._suppressToggleEvents. */
    private _suppressToggleEvents: boolean = false;

    /** Server-authoritative snapshot of providers this uuid is bound
     *  to. Updated by reconcileLinkedAccountsFromServer + immediately
     *  after successful link. Toggle handlers consult this to decide
     *  whether an ON tap is a real bind attempt or a re-paint from a
     *  dual-bound state (bound to BOTH apple + google but accountType
     *  only stores one). */
    private _knownLinkedProviders: Set<string> = new Set();

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

            // Rewire buttons EVERY show — the panel node is shared
            // with the pause overlay in some scenes; whichever showX
            // (confirm / pause) most recently activated the panel
            // needs its handlers to own the buttons, else the OTHER
            // module's handler fires and the modal appears un-
            // dismissable to the user.
            this.wireConfirmModal();

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
        });
    }

    private wireConfirmModal(): void {
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
        const cb = this._confirmPendingResolve;
        this._confirmPendingResolve = null;
        if (cb) cb(confirmed);
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
        hintText?: string,
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
            // Optional hint Label — set text if scene binds one and
            // hintText is non-empty; hide/blank otherwise so leftover
            // text from a previous prompt doesn't leak through.
            if (this.authoredPromptModalHint) {
                const hint = hintText ?? '';
                this.authoredPromptModalHint.string = hint;
                if (this.authoredPromptModalHint.node) {
                    this.authoredPromptModalHint.node.active = hint.length > 0;
                }
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
