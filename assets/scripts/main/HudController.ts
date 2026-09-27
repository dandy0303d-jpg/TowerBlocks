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
    Vec2,
    Vec3,
    Button,
    Graphics,
    Layout,
    Widget,
    Canvas,
    Camera,
    director,
    Font,
    game,
    Game,
    tween,
    Tween,
    instantiate,
    log,
} from 'cc';
import { ensureDimBackdrop } from './UiHelpers';
import { LevelCompletePopup } from '../../effects/level-complete/LevelCompletePopup';
import { GameController } from './GameController';
import { ToastManager } from './ToastManager';
import { BackKeyManager } from './BackKeyManager';
// NOTE: MenuController is referenced via getComponent('MenuController')
// at runtime (string-lookup) — direct import would create a circular
// dependency (HudController → MenuController → HudController) that
// Rollup rejects at build time.
import { ITEM_KEYS, ITEM_BASE_PROBS, MagicItemKey, ENERGY_FULL_THRESHOLD, COLORS, SHAPES, PieceType, CellValue, COLS, Rarity, rarityForKey } from '../core/Constants';
import { FATE_SHAPES, fateIndexOfShape, pickFateIndex, pickFateIndex4Connected, FATE_SHAPES_4CONNECTED_INDICES, fateShapeAsCustomPiece } from '../core/FateShapes';
import { CustomPieceDef, EmbedProp, LevelData } from '../core/Types';
import { getKeysMode, getHideDevButtons, subscribe as subscribeSettings } from '../core/Settings';
import { AnalyticsApi } from '../core/AnalyticsApi';
import { BgmManager } from '../audio/BgmManager';
import { FontManager } from '../core/FontManager';
import { SoundManager } from '../audio/SoundManager';
import { t, subscribe as subscribeI18n } from '../core/i18n/I18n';
import { purchaseRefresh, RefreshType, REFRESH_COST_TIERS, MAX_PAID_REFRESHES_PER_MODAL } from '../core/RefreshApi';
import { consumeDailyFree } from '../core/DailyFreeApi';
import { PlayerProfile } from '../core/PlayerProfile';
import { fetchBackpack, consumeBackpackItem, getCachedBackpack } from '../core/BackpackApi';
import { IS_DEV_BUILD } from '../core/BuildConfig';

/** 5-row × 3-col pixel-font bitmap patterns for digits 0-9. Each row is
 *  a 3-char bitmask ('1' = lit pixel, '0' = empty). Rows are top → bottom.
 *  Same font the level-select "剩余层数" counter uses, duplicated here
 *  so the blind-mode top readout can render in an identical art style
 *  without cross-file coupling. */
const BLIND_DIGIT_PIXELS: Record<string, string[]> = {
    '0': ['111', '101', '101', '101', '111'],
    '1': ['010', '110', '010', '010', '111'],
    '2': ['111', '001', '111', '100', '111'],
    '3': ['111', '001', '111', '001', '111'],
    '4': ['101', '101', '111', '001', '001'],
    '5': ['111', '100', '111', '001', '111'],
    '6': ['111', '100', '111', '101', '111'],
    '7': ['111', '001', '001', '001', '001'],
    '8': ['111', '101', '111', '101', '111'],
    '9': ['111', '101', '111', '001', '111'],
};

/** Item glyphs shown in the energy picker — kept here so the HUD can render
 *  the picker without depending on external SpriteFrames. */
const ITEM_GLYPHS: Record<MagicItemKey, string> = {
    hourglass1:    '⏳',
    hourglass2:    '⏳',
    hourglass3:    '⏳',
    // 底部消除：↓ + N 横杠（在箭头下方），N = 消除的行数
    excavator1:    '↓\n━',
    excavator2:    '↓\n━\n━',
    excavator3:    '↓\n━\n━\n━',
    // 顶部消除：N 横杠 + ↑（在箭头上方），N = 消除的行数
    excavatorTop1: '━\n↑',
    excavatorTop2: '━\n━\n↑',
    excavatorTop3: '━\n━\n━\n↑',
    shapeshifter:  '🎲',
    rewind:        '⏪',
    meteor1:       '🌠',
    meteor2:       '🌠',
    meteor3:       '🌠',
    rocket1:       '🚀',
    rocket2:       '🚀',
    rocket3:       '🚀',
    gatling1:      '🎯',
    gatling2:      '🎯',
    gatling3:      '🎯',
    mortar5:       '🧱',
    mortar10:      '🧱',
    mortar15:      '🧱',
};
/** Localized item name (used in debug logs; item name label in the picker
 *  slot is currently blank per user request). Reads from the active
 *  language via `t()` so switching language re-translates. */
function itemLabel(key: MagicItemKey): string {
    return t(`item.${key}`);
}
/** Localized short effect description shown under each picker slot. */
function itemDesc(key: MagicItemKey): string {
    return t(`desc.${key}`);
}

// Rarity type + rarityForKey helper live in core/Constants.ts (single
// source of truth) so GameState's picker roll can share them for pity
// boosting without duplicating the threshold table here.
/** Tuple-to-Color helper — avoids `new Color(...tuple)` spread, which
 *  Cocos Creator's `Color` constructor signature doesn't accept cleanly
 *  in strict TS. */
function rgbaToColor(rgba: [number, number, number, number]): Color {
    return new Color(rgba[0], rgba[1], rgba[2], rgba[3]);
}
/** Colour data for each rarity. The badge TEXT is looked up via i18n
 *  (`t('rarity.<rarity>')`) so it retranslates on language change —
 *  don't cache the string here. */
interface RarityColors {
    bg:        [number, number, number, number];
    border:    [number, number, number, number];
    badgeBg:   [number, number, number, number];
    badgeText: [number, number, number, number];
}
const RARITY_STYLES: Record<Rarity, RarityColors> = {
    common:   { bg: [60,  70, 100, 240], border: [180, 200, 255, 240], badgeBg: [100, 130, 180, 255], badgeText: [240, 245, 255, 255] },
    uncommon: { bg: [50,  90,  70, 240], border: [120, 220, 150, 240], badgeBg: [ 60, 160,  90, 255], badgeText: [225, 255, 230, 255] },
    rare:     { bg: [70,  60, 110, 240], border: [200, 150, 255, 240], badgeBg: [140,  90, 220, 255], badgeText: [240, 230, 255, 255] },
    epic:     { bg: [110, 80,  40, 240], border: [255, 200,  90, 240], badgeBg: [220, 160,  40, 255], badgeText: [255, 245, 215, 255] },
};
/** Localized rarity badge label. */
function rarityLabel(rarity: Rarity): string {
    return t(`rarity.${rarity}`);
}

const { ccclass, property } = _decorator;

/**
 * 2D HUD overlay — score / lines / next-piece preview / item bar.
 *
 * Reads state every frame from a sibling `GameController` (drag-in via the
 * Inspector). All UI nodes are created programmatically in `start()` to
 * minimise editor setup: you only need to provide
 *   • this script attached to the Canvas node
 *   • a reference to GameController
 *   • the 5 magic-item icon SpriteFrames (drag from `assets/textures/icons/`)
 */
@ccclass('HudController')
export class HudController extends Component {

    /** Reference to the GameController so we can read live game state. */
    @property(GameController)
    gameController: GameController | null = null;

    /** Optional reference to MenuController's host NODE — at build time
     *  we can't reference MenuController directly (circular import), so
     *  drag the Canvas (or whichever node carries the MenuController
     *  component) into this slot. We look the component up by string
     *  name on first use, structurally typed. */
    @property(Node)
    menuControllerNode: Node | null = null;

    /** Structurally-typed handle to the MenuController. Resolved lazily
     *  from `menuControllerNode` on first access — see comment above. */
    private get menuController(): {
        showModeSelect(): void;
        showInsufficientGems?(needed: number, balance: number): void;
    } | null {
        if (!this.menuControllerNode) return null;
        return (this.menuControllerNode.getComponent('MenuController') as
            {
                showModeSelect(): void;
                showInsufficientGems?(needed: number, balance: number): void;
            } | null) ?? null;
    }

    // ============================================================
    //  Authored HUD — top strip / Row 1 buttons / score label /
    //  NEXT preview. Drag the scene nodes into these slots; the
    //  script only wires click handlers + updates label text and the
    //  NEXT preview Graphics.
    // ============================================================

    @property({ type: Button, tooltip: '暂停按钮（点击 → togglePause）' })
    authoredPauseButton: Button | null = null;

    @property({ type: Button, tooltip: '通关按钮（DEV，无尽模式自动隐藏）' })
    authoredDebugWinButton: Button | null = null;

    @property({ type: Button, tooltip: '速度累加按钮（DEV，仅无尽/盲选；1.0→1.1→...→2.0→回1.0）' })
    authoredDebugSpeedButton: Button | null = null;

    // ============================================================
    //  Backpack in-game quick-use buttons (bomb_block / mini_block)
    //  Tap in-game → server consume 1 → arm GameState.pendingNextPieceModifier.
    //  Hidden when count <= 0 (via the Label showing "0" and the
    //  wrapper node deactivating). Wired independently — either can
    //  be left empty in Inspector; only wired ones become interactive.
    // ============================================================
    @property({ type: Button, tooltip: '游戏内快捷使用『炸弹方块』的按钮。点击后服务器扣 1 张，下一块变 1×1 炸弹，触底 3×3 消除。数量=0 时按钮所在节点自动隐藏。' })
    authoredBombBlockButton: Button | null = null;

    @property({ type: Label, tooltip: '『炸弹方块』数量 Label（"×N"）。跟 authoredBombBlockButton 配对；留空则不显示数量。' })
    authoredBombBlockCountLabel: Label | null = null;

    @property({ type: Button, tooltip: '游戏内快捷使用『迷你方块』的按钮。点击后服务器扣 1 张，下一块强制变 1×1 小方块。数量=0 时按钮所在节点自动隐藏。' })
    authoredMiniBlockButton: Button | null = null;

    @property({ type: Label, tooltip: '『迷你方块』数量 Label（"×N"）。跟 authoredMiniBlockButton 配对；留空则不显示数量。' })
    authoredMiniBlockCountLabel: Label | null = null;

    @property({ type: Button, tooltip: '游戏内快捷使用『甩干机』的按钮。点击后服务器扣 1 张，方块暂停下落，塔在 1 秒内旋转一圈，每层的方块横向挨到一起，然后继续。数量=0 时按钮所在节点自动隐藏。' })
    authoredDryerButton: Button | null = null;

    @property({ type: Label, tooltip: '『甩干机』数量 Label（"×N"）。跟 authoredDryerButton 配对；留空则不显示数量。' })
    authoredDryerCountLabel: Label | null = null;

    @property({ type: Button, tooltip: '游戏内快捷使用『重力压制』的按钮。点击后服务器扣 1 张，方块暂停下落，下方所有彩色方块因重力落下填满空格，然后继续。数量=0 时按钮所在节点自动隐藏。' })
    authoredGravityPressButton: Button | null = null;

    @property({ type: Label, tooltip: '『重力压制』数量 Label（"×N"）。跟 authoredGravityPressButton 配对；留空则不显示数量。' })
    authoredGravityPressCountLabel: Label | null = null;

    @property({ type: SpriteFrame, tooltip: '小方块贴图（assets/image/smallBlock.png）— NEXT 预览 + 本命方块两处会用这张图 tint 出每种颜色的方块；留空 fallback 到旧的矢量矩形。' })
    authoredSmallBlockSprite: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: '能量条背景图（可选 — 拖 assets/image/energy_bar_bg.png；不拖则程序绘制矢量胶囊）' })
    authoredEnergyBarBgSprite: SpriteFrame | null = null;

    // ============================================================
    //  Magic item picker icons + tier stars
    //  Drag each PNG from assets/image/items/. If any slot is
    //  unwired, that item falls back to the emoji Label glyph.
    // ============================================================
    @property({ type: SpriteFrame, tooltip: '沙漏图标 (hourglass.png)' })
    itemIconHourglass: SpriteFrame | null = null;
    @property({ type: SpriteFrame, tooltip: '底部消除 (excavator.png)' })
    itemIconExcavator: SpriteFrame | null = null;
    @property({ type: SpriteFrame, tooltip: '顶部消除 (excavatorTop.png)' })
    itemIconExcavatorTop: SpriteFrame | null = null;
    @property({ type: SpriteFrame, tooltip: '变形 (shapeshifter.png)' })
    itemIconShapeshifter: SpriteFrame | null = null;
    @property({ type: SpriteFrame, tooltip: '回退 (rewind.png)' })
    itemIconRewind: SpriteFrame | null = null;
    @property({ type: SpriteFrame, tooltip: '流星雨 (meteor.png)' })
    itemIconMeteor: SpriteFrame | null = null;
    @property({ type: SpriteFrame, tooltip: '火箭 (rocket.png)' })
    itemIconRocket: SpriteFrame | null = null;
    @property({ type: SpriteFrame, tooltip: '加特林 (gatling.png)' })
    itemIconGatling: SpriteFrame | null = null;
    @property({ type: SpriteFrame, tooltip: '灰泥 (mortar.png)' })
    itemIconMortar: SpriteFrame | null = null;
    @property({ type: SpriteFrame, tooltip: '空星槽 (star_slot.png)' })
    itemStarSlot: SpriteFrame | null = null;
    @property({ type: SpriteFrame, tooltip: '亮星 (star_filled.png)' })
    itemStarFilled: SpriteFrame | null = null;

    @property({ type: Label, tooltip: '层高 Label（右上角）' })
    authoredScoreLabel: Label | null = null;

    @property({ type: Label, tooltip: '关卡计时 Label（暂停按钮下方，格式 MM:SS，仅关卡/收集模式显示）— 通关后 0.8s tween 到屏幕中央 + 前缀 "通关时间：" 展示。可空——不拖则关卡计时器不显示' })
    authoredLevelTimerLabel: Label | null = null;

    @property({ type: Node, tooltip: '关卡计时 Label 的容器 Node（可选，通常放暂停按钮同级）— tween-to-center 时会移动此 Node。留空时会 tween Label 自己的 node。仅关卡/收集模式显示' })
    authoredLevelTimerContainer: Node | null = null;

    @property({ type: Node, tooltip: '通关庆祝面板 Node（内含 恭喜通关 + 通关时间 + 放射光 + 任何美术）。运行时强制 active=false 起手，通关时 scale 0.15→1 pop-in 300ms 弹入；hide 阶段 scale→0.5 淡出 200ms 后 active=false。可空——不拖则不显示。' })
    authoredLevelClearPanel: Node | null = null;

    /** 通关庆祝新版弹窗（挂 LevelCompletePopup 的节点）。非空时用它
     *  的完整入场动画（面板砸落 + 光晕 + 彩纸 + 计时滚动 + 扫光）
     *  代替上面 `authoredLevelClearPanel` 的简单 scale-tween。留空则
     *  fallback 到旧的 scale-tween 面板。show(seconds) 内部会 await
     *  完成再走后续 hide 流程。 */
    @property({ type: LevelCompletePopup, tooltip: '通关庆祝新版弹窗（挂 LevelCompletePopup 的节点）。留空则用旧的 scale-tween 面板。' })
    authoredLevelCompletePopup: LevelCompletePopup | null = null;

    @property({ type: Label, tooltip: '通关庆祝面板里的"恭喜通关"标题 Label。showLevelClearTime 时会把它的 string 填成 t("level.congrats")（各语言已翻译）。可空——不拖则不设置标题（面板里静态字符串也行）。' })
    authoredLevelClearTitleLabel: Label | null = null;

    @property({ type: Label, tooltip: '通关庆祝面板里显示"通关时间：MM:SS"的 Label（一体式）。showLevelClearTime 时填 t("level.clearTime", { time })。如果同时拖了 authoredLevelClearTimeValueLabel，这里只填前缀（"通关时间："），时间部分单独交给 value label——两个 Label 可以各自设不同的颜色。可空。' })
    authoredLevelClearTimeLabel: Label | null = null;

    @property({ type: Label, tooltip: '通关庆祝面板里"MM:SS"的独立 Label（数字部分）。拖了这个之后，authoredLevelClearTimeLabel 只显示前缀"通关时间："，这里显示"01:23"——两个 Label 可以在场景里各自授权不同颜色/字号。不拖则回退到一体式（authoredLevelClearTimeLabel 显示完整"通关时间：01:23"）。' })
    authoredLevelClearTimeValueLabel: Label | null = null;

    @property({ type: Sprite, tooltip: '层高 Label 背景 Sprite（可选，纯装饰底图；不拖也没关系）— 通常放在 Label 的同级 sibling，UITransform 铺满 Label 的容器' })
    authoredScoreBgSprite: Sprite | null = null;

    // ============================================================
    //  Authored HUD — 本命方块 (fate piece) modal
    //  Drag the scene nodes into these slots to replace the
    //  programmatic Graphics build. The shape canvas keeps its
    //  Graphics component (added at wire time if missing) because
    //  the shape itself is drawn dynamically per fate index.
    // ============================================================

    @property({ type: Node, tooltip: '本命方块弹窗根节点（含全屏 dim 底 + box）' })
    authoredFateOverlay: Node | null = null;

    @property({ type: Label, tooltip: '"本命方块" 标题 Label' })
    authoredFateTitleLabel: Label | null = null;

    @property({ type: Label, tooltip: '副标题 Label（脚本会写形状序号 / 提示）' })
    authoredFateSubtitleLabel: Label | null = null;

    @property({ type: Node, tooltip: '形状画布节点（脚本会挂 Graphics 画每次的方块形状）' })
    authoredFateShapeCanvas: Node | null = null;

    @property({ type: Node, tooltip: '按钮组容器（预览模式会 setActive(false) 一次性隐藏 reroll + start + hint）' })
    authoredFateButtonsGroup: Node | null = null;

    @property({ type: Button, tooltip: '逆天改命按钮（点击 → 换一个随机形状）' })
    authoredFateRerollButton: Button | null = null;

    @property({ type: Label, tooltip: '逆天改命按钮上的 Label（脚本按每日剩余次数写"逆天改命 (n/3)" / 用完切"🎬 看广告改命"）— 可空，会自动 getComponentInChildren 找' })
    authoredFateRerollLabel: Label | null = null;

    @property({ type: Button, tooltip: '直接开始按钮（点击 → 确认当前形状进入游戏）' })
    authoredFateStartButton: Button | null = null;

    @property({ type: Button, tooltip: '"消耗宝石刷新"按钮（本命方块弹窗）— 点击 → 服务器扣宝石 + 客户端重新 roll。可空。' })
    authoredFatePaidRefreshButton: Button | null = null;

    @property({ type: Label, tooltip: '"消耗宝石刷新"按钮上的 Label（脚本会写"💎 N"）— 可空，会自动 getComponentInChildren 找。' })
    authoredFatePaidRefreshLabel: Label | null = null;

    @property({ type: Label, tooltip: '按钮下面的提示文字（可选）' })
    authoredFateHintLabel: Label | null = null;

    // ============================================================
    //  Authored HUD — 嵌入道具选择器（Lvl 16+ 本命弹窗才启用）
    //
    //  Layout expectation: `embedPickerRoot` is a container (usually a
    //  child of `authoredFateOverlay`) that holds:
    //    - two option buttons (boom1 + row1) with icon sprites
    //    - a "选中" 高亮节点 under each (active only when picked)
    //    - a "开始" 确认按钮
    //
    //  Every field is optional — leaving `embedPickerRoot` unwired
    //  degrades the level-16+ flow back to the classic auto-dismiss
    //  preview (see MenuController's showFateEmbedPicker guard).
    // ============================================================

    @property({ type: Node, tooltip: '嵌入道具选择器容器节点（脚本 setActive 控制显示）' })
    authoredEmbedPickerRoot: Node | null = null;

    @property({ type: Button, tooltip: '选项 1：1 级范围爆破（boom lvl 1）— 点击 → 切换选中' })
    authoredEmbedBoomButton: Button | null = null;

    @property({ type: Node, tooltip: 'boom1 按钮的"选中"高亮节点（脚本 setActive 控制）' })
    authoredEmbedBoomSelectMark: Node | null = null;

    @property({ type: Label, tooltip: 'boom1 按钮上的数量 Label（脚本会写 "x N" / "-"）' })
    authoredEmbedBoomCountLabel: Label | null = null;

    @property({ type: Button, tooltip: '选项 2：1 级横向爆破（row1 bomb）— 点击 → 切换选中' })
    authoredEmbedRowBombButton: Button | null = null;

    @property({ type: Node, tooltip: 'row1 按钮的"选中"高亮节点（脚本 setActive 控制）' })
    authoredEmbedRowBombSelectMark: Node | null = null;

    @property({ type: Label, tooltip: 'row1 按钮上的数量 Label（脚本会写 "x N" / "-"）' })
    authoredEmbedRowBombCountLabel: Label | null = null;

    @property({ type: Button, tooltip: '选项 3：拆迁队（wrecker）— 点击 → 切换选中' })
    authoredEmbedWreckerButton: Button | null = null;

    @property({ type: Node, tooltip: 'wrecker 按钮的"选中"高亮节点（脚本 setActive 控制）' })
    authoredEmbedWreckerSelectMark: Node | null = null;

    @property({ type: Label, tooltip: 'wrecker 按钮上的数量 Label（脚本会写 "x N" / "-"）' })
    authoredEmbedWreckerCountLabel: Label | null = null;

    @property({ type: Button, tooltip: '"开始"确认按钮（点击 → 带着当前选中的道具进入游戏）' })
    authoredEmbedStartButton: Button | null = null;

    @property({ type: Label, tooltip: '"开始"按钮上的 Label（脚本会写 t("fate.start")）— 可空' })
    authoredEmbedStartLabel: Label | null = null;

    @property({ type: Label, tooltip: '选择器提示 Label（"选择一个开场道具"）— 脚本会写 t("fate.embedPick.hint") 并跟随 i18n 切换' })
    authoredEmbedHintLabel: Label | null = null;

    // ============================================================
    //  Authored HUD — 暂停弹窗
    // ============================================================

    @property({ type: Node, tooltip: '暂停弹窗根节点（含 dim 遮罩 + 卡片，默认 active=false）' })
    authoredPauseOverlay: Node | null = null;

    @property({ type: Button, tooltip: '继续按钮（点击 → 取消暂停）' })
    authoredPauseContinueButton: Button | null = null;

    @property({ type: Button, tooltip: '主页按钮（点击 → 退出到主菜单）' })
    authoredPauseHomeButton: Button | null = null;

    @property({ type: Label, tooltip: '暂停弹窗标题 Label（"⏸ 已暂停"）— 脚本会用 i18n 覆盖；可空' })
    authoredPauseTitleLabel: Label | null = null;

    @property({ type: Label, tooltip: '暂停弹窗提示 Label（"点击继续回到游戏"）— 脚本会用 i18n 覆盖；可空' })
    authoredPauseHintLabel: Label | null = null;

    // ============================================================
    //  Authored HUD — 魔法道具选择弹窗 (Energy Picker)
    //  能量满时弹出、玩家从 2 张卡里选 1 张。之前是 Graphics 画的，
    //  安卓真机上按钮点不动 —— 换成 authored Sprite 后就正常了。
    // ============================================================

    @property({ type: Node, tooltip: '魔法道具选择弹窗根节点（全屏 dim + 卡片容器，默认 active=false）' })
    authoredEnergyPicker: Node | null = null;

    @property({ type: Label, tooltip: '标题 Label（脚本会写"⚡ 选 1 个魔法道具"）' })
    authoredPickerTitleLabel: Label | null = null;

    @property({ type: Label, tooltip: '副标题 Label（脚本会写"点击卡片确认 · 颜色 = 稀有度"）' })
    authoredPickerSubtitleLabel: Label | null = null;

    @property({ type: [Button], tooltip: '2 张道具卡的可点击 Button（左 / 右，顺序固定）' })
    authoredPickerSlotButtons: Button[] = [];

    @property({ type: [Sprite], tooltip: '2 张卡片的底板 Sprite（脚本按稀有度改 color 上色）' })
    authoredPickerSlotBackgrounds: Sprite[] = [];

    @property({ type: [Sprite], tooltip: '2 个稀有度徽章的底板 Sprite（脚本按稀有度改 color 上色）；可空' })
    authoredPickerSlotBadgeBackgrounds: Sprite[] = [];

    @property({ type: [Label], tooltip: '2 个稀有度徽章的文字 Label（脚本写"普通/少见/稀有/史诗"+文字颜色）' })
    authoredPickerSlotBadgeLabels: Label[] = [];

    @property({ type: [Label], tooltip: '2 个大 emoji glyph Label（脚本写 ⏳/⛏/🎲 等）' })
    authoredPickerSlotGlyphLabels: Label[] = [];

    @property({ type: [Label], tooltip: '2 个道具名称 Label（脚本写"沙漏 1 分"等）' })
    authoredPickerSlotNameLabels: Label[] = [];

    @property({ type: [Label], tooltip: '2 个道具描述 Label（脚本写效果说明）' })
    authoredPickerSlotDescLabels: Label[] = [];

    @property({ type: Button, tooltip: '刷新按钮（点击 → 重新掷两张牌）' })
    authoredPickerRefreshButton: Button | null = null;

    @property({ type: Label, tooltip: '刷新按钮上的 Label（脚本按次数写"🔄 免费刷新"/"🎬 看广告再刷一次"）' })
    authoredPickerRefreshLabel: Label | null = null;

    @property({ type: Button, tooltip: '"消耗宝石刷新"按钮（魔法道具弹窗）— 点击 → 服务器扣宝石 + 客户端重新 roll 两张牌。可空。' })
    authoredPickerPaidRefreshButton: Button | null = null;

    @property({ type: Label, tooltip: '"消耗宝石刷新"按钮上的 Label（脚本会写"💎 N"）— 可空，会自动 getComponentInChildren 找。' })
    authoredPickerPaidRefreshLabel: Label | null = null;

    // ============================================================
    //  Authored HUD — 变形道具选择弹窗 (Shapeshifter picker)
    //  玩家使用"变形"道具时弹出，7 张 tetromino 卡（I/O/T/S/Z/J/L）。
    //  之前是 Graphics 画的，安卓上按钮点击有时无响应。
    //  Slot 数组顺序**必须固定**：[I, O, T, S, Z, J, L]。
    // ============================================================

    @property({ type: Node, tooltip: '变形选择弹窗根节点（全屏 dim + 卡片容器，默认 active=false）' })
    authoredShapeshifterOverlay: Node | null = null;

    @property({ type: Label, tooltip: '标题 Label（脚本写"🎲 变形"）' })
    authoredShapeshifterTitleLabel: Label | null = null;

    @property({ type: Label, tooltip: '副标题 Label（脚本写"选一种形状让当前方块变身"）' })
    authoredShapeshifterSubtitleLabel: Label | null = null;

    @property({ type: [Button], tooltip: '7 张形状卡的可点击 Button（顺序固定：I / O / T / S / Z / J / L）' })
    authoredShapeshifterSlotButtons: Button[] = [];

    @property({ type: [Sprite], tooltip: '7 张形状卡的底板 Sprite（脚本按形状颜色 tint）；顺序同上' })
    authoredShapeshifterSlotBackgrounds: Sprite[] = [];

    @property({ type: [Node], tooltip: '7 张形状卡的 shape preview 节点（脚本挂 Graphics 画每种 tetromino 形状）；顺序同上' })
    authoredShapeshifterSlotShapeCanvases: Node[] = [];

    @property({ type: Button, tooltip: '取消按钮（点击 → 关闭弹窗，道具不消耗）' })
    authoredShapeshifterCancelButton: Button | null = null;

    @property({ type: Node, tooltip: 'NEXT 预览框容器（脚本内在里面动态画形状）' })
    authoredNextPreviewBox: Node | null = null;

    @property({ type: Node, tooltip: 'NEXT 预览的形状画布节点（脚本会往里面加 Graphics 画每帧形状）' })
    authoredNextShapeCanvas: Node | null = null;

    @property({ type: Label, tooltip: 'NEXT 预览框顶部的 "Next" 标题 Label — 脚本用 i18n key hud.next 覆写，本地化跟随语言切换' })
    authoredNextPreviewTitleLabel: Label | null = null;

    private scoreLabel!:   Label;
    private linesLabel!:   Label;
    private modeLabel!:    Label;
    private nextLabel!:    Label;
    /** Debug "instant win" button — dev-only, visible in level mode. */
    private debugWinButtonNode: Node | null = null;
    /** Debug speed-bump button — dev-only, endless/blind only. */
    private debugSpeedButtonNode: Node | null = null;
    /** Cached Label inside debug speed button (shows current mult). */
    private debugSpeedLabel: Label | null = null;
    /** Last multiplier we painted on the debug speed label — cheap
     *  early-out for per-frame refresh (avoids allocating a new string
     *  every tick when the value hasn't changed). */
    private _lastPaintedSpeedMult: number = -1;
    /** Full-screen "已暂停" overlay. Lazily built the first time the
     *  player pauses; destroyed only on scene teardown so re-pausing is
     *  a cheap `active = true`. */
    private pauseOverlay: Node | null = null;
    /** Cached last-rendered pause state so update()'s per-frame sync can
     *  early-exit when nothing changed (avoids re-drawing / re-showing
     *  the overlay every tick). */
    private pauseUiLastPaused: boolean = false;
    /** Whether the in-game back handler is currently pushed onto
     *  BackKeyManager's stack. Tracked so update() can push exactly once
     *  when gameplay becomes active and pop exactly once when it ends,
     *  without spamming push/pop every frame. */
    private _gameBackPushed: boolean = false;
    /** Cached arrow func so BackKeyManager.pop() can find the same
     *  reference we pushed with. Toggles pause on/off — if the pause
     *  overlay is open, resume; otherwise, open it. Returns true so
     *  BackKeyManager treats the press as consumed and doesn't fall
     *  through to the main-menu exit-confirm handler. Silently no-ops
     *  during tutorial / game-over / not-running to leave those states
     *  unmodified. */
    private _gameBack = (): boolean => {
        const gs = this.gameController?.gameState;
        if (!gs || !gs.running || gs.gameOver || gs.tutorialActive) return false;
        // BackKeyManager._dispatch pops us AFTER this returns (that's
        // the standard popup contract — handler runs once, then
        // vanishes). We flip our own guard here so the next update()
        // tick re-pushes while gameplay is still active. Without this
        // the second back-press would fall through to the main-menu
        // exit-confirm default handler, which is exactly the "wanted
        // resume, got 'quit game?' dialog" bug.
        this._gameBackPushed = false;
        // togglePause() itself gates on running/gameOver — the tutorial
        // gate above is our own extra guard (same reason the pause
        // button hides in update() when tutorialActive).
        gs.togglePause();
        this.refreshPauseUi();
        return true;
    };
    /** Suspended by the OS while we're in the middle of a run — Android
     *  home / recents, iOS app-switcher, incoming call, etc. Cocos
     *  fires Game.EVENT_HIDE for all of these. We flip `paused=true`
     *  so the simulation freezes and the pause overlay is visible
     *  when the player returns. We do NOT auto-resume on
     *  Game.EVENT_SHOW — that would tank the player mid-tetromino if
     *  they briefly glanced at a notification. Let them tap Continue. */
    private _onAppHide = (): void => {
        const gs = this.gameController?.gameState;
        if (!gs || !gs.running || gs.gameOver || gs.tutorialActive) return;
        if (gs.paused) return;
        gs.paused = true;
        this.refreshPauseUi();
    };
    /** Graphics canvas for the NEXT-piece preview. Each frame we paint
     *  the queued shape as a faux-3D mini-tower so the player can read
     *  what's coming at a glance. */
    private nextPreviewGfx!: Graphics;
    /** Caches the last shape we painted so we only repaint on change. */
    private lastNextPreviewKey: string = '';
    private itemCountLabels: Map<MagicItemKey, Label> = new Map();

    // ---------- Energy bar + picker ----------
    private energyBarBg!:   Node;     // background track
    private energyBarFill!: Node;     // fill rect (scaled via Graphics redraw)
    private energyBarFillGfx!: Graphics;
    private energyLabel!:   Label;

    // ---- Blind mode column indicator (built programmatically) ----
    /** Root node holding the pixel-cube digit renderer. Hidden unless
     *  the current game mode is `blind`. */
    private blindIndicatorRoot: Node | null = null;
    /** Graphics component used to paint the pixel-font digits — same
     *  5×3 bitmap patterns the level-select "剩余层数" counter uses,
     *  drawn as small square blocks. Repainted only when the integer
     *  column actually changes. */
    private blindColumnGfx:     Graphics | null = null;
    /** Cached last-drawn column so per-frame updates don't repaint
     *  when the value hasn't changed. */
    private blindLastColumn:    number = -1;

    // ---- Pickup countdown indicators (hourglass / gatling / meteor) ----
    // Three pixel-cube digit readouts under the NEXT preview box. Same
    // art as `blindColumnGfx` (cream #fff4c8 blocks with bronze outline)
    // but stacked in two rows: hourglass on row 1, gatling + meteor
    // side-by-side on row 2. Each auto-hides when its value is 0 so the
    // top strip stays clean when no pickups are active.
    private hourglassCountRoot:  Node | null = null;
    private hourglassCountGfx:   Graphics | null = null;
    private lastHourglassSec:    number = -1;
    private hourglassRestPos:    Vec3 = new Vec3(0, 0, 0);
    private gatlingCountRoot:    Node | null = null;
    private gatlingCountGfx:     Graphics | null = null;
    private lastGatlingCount:    number = -1;
    private gatlingRestPos:      Vec3 = new Vec3(0, 0, 0);
    private meteorCountRoot:     Node | null = null;
    private meteorCountGfx:      Graphics | null = null;
    private lastMeteorCount:     number = -1;
    private meteorRestPos:       Vec3 = new Vec3(0, 0, 0);

    // ---- Post-fail reveal prompt (built programmatically) ----
    /** Full-screen tap catcher + bottom label shown right after a
     *  game-over, BEFORE the actual fail popup fires. Gives the player
     *  a moment to see the final tower state (especially useful in
     *  blind mode) and dismiss it with a single tap. */
    private failRevealRoot:      Node | null = null;
    private failRevealTextLabel: Label | null = null;
    private failRevealTapHandler: (() => void) | null = null;

    // ---- Blind mode debug: show/hide tower toggle button ----
    /** Bottom-left button visible only in 闭眼模式. Flips
     *  `gameController.blindShowTowerDebug` so testers can peek at
     *  the tower's state without editing the inspector every time. */
    private blindTowerToggleRoot:  Node | null = null;
    private blindTowerToggleLabel: Label | null = null;
    /** Cached numbers so we only redraw the bar when the charge changes. */
    private lastEnergyDrawn = -1;

    // ---------- Collect-mode goal panel ----------
    // Top-left HUD shown only when gameState.mode === 'collect'. Lists
    // each goal as `🟦 T  N/M ✓`. Rebuilt whenever the goal list changes
    // (level swap); per-frame we just update the count labels.
    private collectPanel: Node | null = null;
    private collectGoalLabels: Label[] = [];     // one per goal row
    private collectGoalCache: string = '';        // cheap dirty-check key
    private lastCollectProgressKey: string = '';

    private pickerOverlay!: Node;     // full-screen dimmer; hidden by default
    private pickerSlotNodes: Node[] = [];     // 2 choice nodes
    private pickerSlotGfx:   Graphics[] = []; // 2 background painters — redrawn per pick to colour by rarity
    private pickerSlotGlyphs: Label[] = [];   // 2 emoji labels (top)
    private pickerSlotNames: Label[] = [];    // 2 name labels (middle)
    private pickerSlotDescs: Label[] = [];    // 2 description labels (bottom)
    private pickerSlotBadges: Label[] = [];   // 2 rarity-pill labels above the glyph
    private pickerSlotIcons:  Sprite[] = [];  // 2 icon Sprites — new PNG-based icon replaces the emoji Label
    private pickerSlotStarFills: Sprite[][] = [];   // 2 × 3: filled-star overlays per slot, toggled by tier
    private pickerSlotKeys: (MagicItemKey | null)[] = [null, null];
    private refreshBtnLabel!: Label;

    /** Cached "rest" position of the level timer container (its authored
     *  local position, snapshot on wire). showLevelClearTime tweens the
     *  container to (0,0) → hides after modal; if the player replays the
     *  same level, we restore back to this position on next start. */
    private _levelTimerRestPos = new Vec3();
    /** Cached authored scale (mirror of _levelTimerRestPos). Reset needs
     *  to restore this too — the center-hold animation scales to 5x, and
     *  without restore the next level's timer would stay 5x and clip out
     *  of the top-strip. */
    private _levelTimerRestScale = new Vec3(1, 1, 1);
    /** True once showLevelClearTime has captured a live snapshot of the
     *  container's position + scale (i.e., the player has actually cleared
     *  a level this session). When false, resetLevelTimerPosition MUST
     *  NOT restore pos/scale — Vec3.ZERO default would snap the container
     *  to screen center. Cleared after reset restores, and stays false
     *  across fail/exit paths that never trigger showLevelClearTime. */
    private _levelTimerSnapshotCaptured: boolean = false;
    /** True during the "timer disappeared, waiting for fate modal to
     *  pop" window (the POST_HIDE_MS gap at the end of the level-clear
     *  animation). refreshHud reads this to skip its per-frame active
     *  toggle — otherwise the next frame would flip container.active
     *  back to true and undo the "timer visibly leaves the screen"
     *  beat the user asked for. Cleared in resetLevelTimerPosition. */
    private _levelTimerForceHidden: boolean = false;

    /** True between showLevelClearTime and resetLevelTimerPosition —
     *  gates the pause button, NEXT preview, and energy bar so they
     *  hide during the scatter/celebration beat and don't compete
     *  visually with the centered clear-time panel. Distinct from
     *  _levelTimerForceHidden so a future change to one doesn't
     *  accidentally unhide the other. */
    private _hudCelebrationHidden: boolean = false;
    /** Pending setTimeout IDs for the level-clear animation. If a new
     *  level starts (or the HUD tears down) before the animation
     *  finishes, we cancel these so a stray callback doesn't fire
     *  mid-fresh-level and re-tween the container off-position. */
    private _levelClearTimeouts: ReturnType<typeof setTimeout>[] = [];
    /** Frozen-time snapshot (whole seconds) painted while the container
     *  is tweening / displayed as the clear-time modal. When set,
     *  refreshHud stops updating the label so it doesn't tick past the
     *  winning time. */
    private _levelTimerFrozenSec: number | null = null;
    /** Last integer-second value the timer label was painted to. Skip
     *  the string write when unchanged — Label.string setter triggers a
     *  full render-data rebuild, and MM:SS at 60fps would burn cycles
     *  writing the same string 59 times per tick. */
    private _levelTimerLastSec = -1;
    private refreshesUsedThisFull = 0;       // resets when picker closes
    private hooksWired = false;

    /** True while the magic picker is in an OPEN session (energy full
     *  → player still hasn't picked). Set on the FIRST onEnergyPickerOpen
     *  after a close, cleared on onEnergyPickerClose. Used to gate the
     *  per-session paid-refresh counter reset — refreshes reopen the
     *  picker via `hooks.onEnergyPickerOpen` too, but we want to keep
     *  the tier counter across refreshes within one session. */
    private _pickerSessionActive: boolean = false;

    /** Mirror of setHudVisible's last `on` value. refreshHud checks
     *  this before flipping timer container visibility so a stale
     *  gameState.mode === 'level' doesn't leave the level timer
     *  visible after the player returns to the main menu. */
    private _hudOn: boolean = false;

    // ---------- 本命方块 (fate piece) entry modal ----------
    private fateOverlay!: Node;
    private fateShapeGfx!: Graphics;
    private fateTitleLab!: Label;
    private fateSubLab!:   Label;
    private fateHintLab!:  Label;
    /** Caller's resolve fn — set when showFateModal opens, invoked on
     *  "直接开始" with the picked CustomPieceDef. */
    private fateResolve: ((picked: CustomPieceDef) => void) | null = null;
    private fateCancel:  (() => void) | null = null;
    private fateCurrentIdx = 0;
    private fateCurrentBase: PieceType = 'I';
    /** Overrides FATE_SHAPES[fateCurrentIdx] for both the modal preview
     *  and the confirmed piece. Set when the entering level provides
     *  a custom shape that isn't in the FATE_SHAPES pool (e.g. 6-cell
     *  levels, or hand-authored shapes whose D4 canonicalisation
     *  fateIndexOfShape didn't recognise). Cleared on reroll — after
     *  which we're back on the pool and fateCurrentIdx is authoritative. */
    private fateCurrentShape: number[][] | null = null;
    private fateLevelOrder = 0;
    /** Set by showFateModal when the entry is endless (no level-assigned
     *  fate piece). Restricts the reroll button to the 4-connected
     *  subset so the player never ends up with a dead-lock shape. */
    private fateIsEndlessEntry = false;
    private fateButtonsGroup!: Node;

    /** Embed-prop picker state (Lvl 16+ pre-game modal). `_embedResolve`
     *  is set when `showFateEmbedPicker` opens and invoked on "开始"
     *  click with the currently-picked embed (`null` when the player
     *  chose to skip). `_embedPicked` mirrors the currently-highlighted
     *  option so the two select-mark nodes can be toggled without an
     *  extra field per button. */
    private _embedResolve: ((picked: EmbedProp | null) => void) | null = null;
    private _embedPicked: EmbedProp | null = null;
    /** True while the level-16+ picker is on screen. Used by hideFateModal
     *  to skip the auto-dismiss timer clear path (there is no timer in
     *  picker mode) and to reset the picker root when the modal closes. */
    private _fateEmbedModeActive = false;
    /** Server-authoritative count of each embed item, refreshed every
     *  time the picker opens (see `_paintEmbedCounts`). Rendered onto
     *  the three button labels; count=0 disables its button so a
     *  player can't pick an item they don't own. */
    private _embedCounts: Record<EmbedProp, number> = { boom1: 0, row1: 0, wrecker: 0 };
    /** True while a `consumeBackpackItem` for the picker's Start click
     *  is in flight — the Start button is greyed for the duration so
     *  a double-tap doesn't fire a second consume. */
    private _embedConsuming = false;
    /** Auto-dismiss timer id for the read-only fate preview shown when
     *  entering a level. Cleared in `hideFateModal` in case the user
     *  navigates away before it fires. */
    private fatePreviewTimer: any = null;

    // ---------- Shapeshifter (变形道具) picker ----------
    /** Lazily-built modal overlay for the shapeshifter magic item. Player
     *  taps one of 7 tetromino cards → we invoke the pending apply
     *  callback with that PieceType. Rebuilt from scratch each open so
     *  Android's Graphics vertex buffer bug doesn't leave a blank card. */
    private shapeshifterOverlay: Node | null = null;
    private shapeshifterApply: ((type: PieceType) => void) | null = null;

    onLoad(): void {
        log('[TowerBlocks] HudController.onLoad');
        // Hard-hide the sunburst backdrop the moment the HUD boots.
        // The artist typically leaves the Node active in the scene so
        // it can be positioned + previewed in the editor, and without
        // this line that authored state would leak into the first
        // frame of gameplay (a yellow flash before showLevelClearTime
        // plays it). Setting active=false directly here guarantees
        // the sunburst is only ever visible during the celebration.
        if (this.authoredLevelClearPanel && this.authoredLevelClearPanel.isValid) {
            this.authoredLevelClearPanel.active = false;
        }
    }

    /** Called when the component / its node is deactivated. Fires when
     *  the game scene is torn down or the HUD is hidden between runs.
     *  Pop the in-game back handler so returning to the main menu (or
     *  any other screen that renders HUD-off) doesn't leave a dead
     *  handler at the top of BackKeyManager's stack — that would
     *  swallow the first back press on whatever screen took over. */
    onDisable(): void {
        if (this._gameBackPushed) {
            BackKeyManager.pop(this._gameBack);
            this._gameBackPushed = false;
        }
    }

    onDestroy(): void {
        // Unsubscribe from the Settings store so we don't keep a stale
        // callback referencing a destroyed node.
        if (this.settingsUnsub) { this.settingsUnsub(); this.settingsUnsub = null; }
        if (this.i18nUnsub) { this.i18nUnsub(); this.i18nUnsub = null; }
        // Clear any in-flight hold-to-repeat timers so they don't fire
        // after the scene is torn down.
        for (const handle of this.holdIntervals.values()) {
            clearInterval(handle);
            clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
        }
        this.holdIntervals.clear();
        // Detach the app-lifecycle listener — the singleton `game`
        // outlives the scene, so leaving this subscribed would keep
        // us referenced past destroy.
        game.off(Game.EVENT_HIDE, this._onAppHide, this);
        // Same for BackKeyManager — pop the in-game handler so
        // BackKeyManager doesn't hold a ref to a destroyed component.
        if (this._gameBackPushed) {
            BackKeyManager.pop(this._gameBack);
            this._gameBackPushed = false;
        }
    }

    start(): void {
        if (!this.gameController) {
            log('[TowerBlocks] HudController ERROR — gameController not assigned.');
            return;
        }
        this.buildUi();
        this.wireGameStateHooks();
        // Backpack quick-use buttons — wire click handlers. The
        // server fetch happens lazily the first time a game becomes
        // running (see _pollBackpackButtonState), so we don't waste a
        // round-trip on the main-menu view where the buttons are
        // hidden anyway.
        this._wireBackpackQuickButtonsOnce();
        this._paintBackpackQuickButtons();   // start hidden
        // Subscribe to language changes so static labels re-translate
        // and open modals repaint their dynamic content (item names,
        // rarity badges, etc.).
        this.i18nUnsub = subscribeI18n(() => this.onLangChanged());
        // Auto-pause when the app is backgrounded (Android home /
        // recents / incoming call, iOS app-switcher, etc.). See the
        // _onAppHide handler for why we don't wire EVENT_SHOW.
        game.on(Game.EVENT_HIDE, this._onAppHide, this);
    }

    /** Register a Label as i18n-driven: sets its initial string via
     *  `t(key, params)` and remembers it so `refreshI18nLabels()` can
     *  re-translate on language change. */
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

    /** Called when the active language changes. Refreshes every
     *  tracked static label, then re-invokes the paint methods that
     *  own DYNAMIC label content (score / picker slots / blind
     *  toggle) so they reflect the new language too. */
    private onLangChanged(): void {
        this.refreshI18nLabels();
        // Blind toggle button label depends on current debug flag —
        // re-render via the sync helper.
        this.refreshBlindTowerToggleLabel();
        // Blind top column readout is pixel-cube pattern and doesn't
        // localize (just digits), so no action needed.
        // Score label (层高 N) is repainted every frame by refreshHud,
        // so it'll pick up the new lang on the next update tick.
        // Picker: if open, re-run the paint path so item names + rarity
        // badges retranslate.
        if (this.authoredEnergyPicker?.active) {
            const keys = this.pickerSlotKeys.filter((k): k is MagicItemKey => !!k);
            if (keys.length) this.showAuthoredPicker(keys);
        } else if (this.pickerOverlay?.active) {
            const keys = this.pickerSlotKeys.filter((k): k is MagicItemKey => !!k);
            if (keys.length) this.showPicker(keys);
        }
        // Fate modal subtitle has dynamic content — re-run its paint
        // if the modal is up. `refreshFateSubtitle` re-derives the
        // cell count from the currently-selected fate shape.
        const fateActive = this.authoredFateOverlay?.active
            || (this.fateOverlay && this.fateOverlay.active);
        if (fateActive) this.refreshFateSubtitle();
        // Fate reroll button label ("逆天改命 (n/3)") also carries
        // dynamic count that trackI18nLabel can't re-interpolate —
        // repaint unconditionally so language switch mid-session picks
        // up the new locale even for buttons off-screen. Cheap:
        // updateFateRerollButtonLabel is a single string write.
        this.updateFateRerollButtonLabel();
    }

    /** Show or hide all HUD-built child nodes. Used by MenuController to
     *  swap between menu and gameplay layouts WITHOUT touching `this.node`
     *  directly — important when HudController shares its host node with
     *  the MenuController (typically both attached to Canvas), where
     *  toggling `this.node.active` would hide the entire UI tree
     *  including the menu and the test label.
     *
     *  Persistent HUD elements (top strip, NEXT preview, energy bar) get
     *  the on/off treatment unconditionally. Modal overlays (FateModal,
     *  EnergyPicker, CollectPanel) are *only* force-hidden when `on=false`
     *  — when `on=true` we leave their active state alone so the modal's
     *  own show/hide logic stays authoritative. Without this distinction,
     *  switching back to gameplay after dismissing the fate modal would
     *  re-enable the modal node (visible as orphaned title / buttons
     *  floating over the live game scene). */
    public setHudVisible(on: boolean): void {
        this._hudOn = on;
        // Energy bar is still built programmatically (buildEnergyBar
        // adds an 'Energy' child under this.node) — keep the name-based
        // toggle for that until it's Sprite-ified in a later batch.
        // Blind mode has no magic items (energy pipeline is skipped
        // in GameState), so the bar shouldn't render at all — force
        // it off regardless of `on`.
        const isBlind = this.gameController?.gameState?.mode === 'blind';
        const persistent = ['Energy'];
        const modals = ['EnergyPicker', 'FateModal', 'CollectPanel'];
        for (const name of persistent) {
            const n = this.node.getChildByName(name);
            if (n) n.active = on && !(name === 'Energy' && isBlind);
        }
        // Authored (Sprite-based) HUD nodes live wherever the user
        // authored them in the scene, not necessarily under this.node,
        // so we can't find them by name — toggle each wired @property
        // node directly.
        if (this.authoredPauseButton) this.authoredPauseButton.node.active = on;
        // Debug win button follows HUD visibility, but only in dev
        // builds AND when the "隐藏 DEV 按钮" settings toggle is off.
        // Release builds keep it forever-hidden.
        if (this.authoredDebugWinButton) {
            this.authoredDebugWinButton.node.active =
                on && IS_DEV_BUILD && !getHideDevButtons();
        }
        // Score container — respect the endless-only rule. When on=true,
        // only show if we're in endless mode; otherwise keep hidden so
        // it doesn't flash visible for one frame before refreshHud fires.
        // When on=false (going to menu), always hide.
        //
        // Toggle the BG SPRITE node (typically the Label's parent, since
        // the Label sits inside the bg pill in the authored hierarchy).
        // Falls back to the Label's own node if the bg sprite isn't
        // wired, matching the pre-bg behaviour. Hiding the bg cascades
        // to the Label child via Cocos active-in-hierarchy — no need to
        // toggle both explicitly, and it guarantees the pill can't be
        // visible without the number (or vice versa).
        const scoreTarget = this.authoredScoreBgSprite?.node
                         ?? this.authoredScoreLabel?.node
                         ?? null;
        if (scoreTarget) {
            const mode = this.gameController?.gameState?.mode;
            // Endless AND blind mode both use the height-based scoring
            // display — both should show 层高 in the top-right.
            const showsHeight = mode === 'endless' || mode === 'blind';
            scoreTarget.active = on && showsHeight;
        }
        if (this.authoredNextPreviewBox) this.authoredNextPreviewBox.active = on;
        // Level timer container follows HUD visibility, gated further
        // by "level mode" inside refreshHud. Force-hide on `on=false`
        // so returning to the main menu doesn't leave a stale timer
        // pill on screen even if gameState.mode is still 'level'.
        const timerNode = this.authoredLevelTimerContainer
            ?? this.authoredLevelTimerLabel?.node
            ?? null;
        if (timerNode) {
            // Only force-hide on false — on=true is handled by the
            // per-frame refreshHud paint (which additionally checks
            // mode === 'level' | 'collect').
            if (!on) timerNode.active = false;
        }
        // Virtual on-screen keys: only show during gameplay AND when user
        // has enabled them in Settings.
        const vkeys = this.node.getChildByName('VirtualKeys');
        if (vkeys) vkeys.active = on && getKeysMode() === 'on';
        if (!on) {
            // Going to "hide everything" — also force-close any open modal
            // so it doesn't bleed into the menu screen.
            for (const name of modals) {
                const n = this.node.getChildByName(name);
                if (n) n.active = false;
            }
            if (this.authoredEnergyPicker)        this.authoredEnergyPicker.active        = false;
            if (this.authoredFateOverlay)         this.authoredFateOverlay.active         = false;
            if (this.authoredPauseOverlay)        this.authoredPauseOverlay.active        = false;
            if (this.authoredShapeshifterOverlay) this.authoredShapeshifterOverlay.active = false;
            // Blind indicator is gameplay-only — always hide when leaving.
            this.setBlindIndicatorVisible(false);
            // Fail-reveal prompt too — a straggler tap catcher would
            // eat all subsequent menu / retry taps.
            this.hideFailRevealPrompt();
        } else {
            // Coming back to gameplay: show only if we're in blind mode
            // (GameController also flips this on startBlind, but re-
            // syncing here handles paths like resume-from-pause).
            const isBlind = this.gameController?.gameState?.mode === 'blind';
            this.setBlindIndicatorVisible(isBlind);
        }
    }

    /** Subscribe to the picker hooks so the overlay opens/closes when the
     *  game state says so. We poll the energy charge in `update` instead of
     *  subscribing (less moving parts; the value is read-only). */
    private wireGameStateHooks(): void {
        if (this.hooksWired) return;
        const g = this.gameController?.gameState;
        if (!g) return;
        const prev = g.hooks;
        g.hooks = {
            ...prev,
            onEnergyPickerOpen: (choices) => {
                prev.onEnergyPickerOpen?.(choices);
                // Fresh-session detection: this hook fires both on the
                // energy-bar-full first open AND on every refresh
                // (refreshEnergyPicker calls it too). Reset the paid-
                // refresh tier counter ONLY on a fresh open — refreshes
                // must keep the counter climbing so 10 → 15 → 20 →
                // 已达上限 actually escalates instead of resetting to
                // 10 every click. refreshesUsedThisFull is per-session
                // too and gets reset here safely because it's a "count
                // of past clicks THIS session" metric.
                if (!this._pickerSessionActive) {
                    this._paidRefreshUsed.magic = 0;
                    this._pickerSessionActive = true;
                }
                this.refreshesUsedThisFull = 0;
                this.showPicker(choices);
            },
            onEnergyPickerClose: () => {
                prev.onEnergyPickerClose?.();
                // Session ends → next open is fresh → will reset paid
                // counter above.
                this._pickerSessionActive = false;
                this.hidePicker();
            },
        };
        this.hooksWired = true;
    }

    update(_dt: number): void {
        if (!this.gameController || !this.gameController.gameState) return;
        // Subscribe lazily — GameController may build gameState after our start().
        if (!this.hooksWired) this.wireGameStateHooks();
        // Cheap poll: detect running-state transition and repaint
        // the backpack quick-use buttons so they hide on menu / game
        // over and re-appear when a match starts.
        this._pollBackpackButtonState();
        const g = this.gameController.gameState;

        // Keep the pause button glyph + overlay in sync with the actual
        // gameState.paused. External code (energy picker, fate modal)
        // can toggle `paused` outside our button handler, and we want
        // the UI to reflect that immediately. Cheap early exit when
        // nothing changed keeps this from thrashing.
        this.syncPauseUi();

        // Wire the hardware back key into gameplay: while a run is
        // active (running, not game-over, not tutorial), push a
        // handler that toggles pause; when the run ends or gets torn
        // down, pop it so back returns to whatever menu / popup owns
        // the screen next. Same push/pop discipline every other panel
        // uses — one boolean guard so we don't churn the stack every
        // frame.
        const gameplayActive = g.running && !g.gameOver && !g.tutorialActive;
        if (gameplayActive && !this._gameBackPushed) {
            BackKeyManager.push(this._gameBack);
            this._gameBackPushed = true;
        } else if (!gameplayActive && this._gameBackPushed) {
            BackKeyManager.pop(this._gameBack);
            this._gameBackPushed = false;
        }

        // Hide the pause BUTTON (not the overlay — the pause overlay
        // is a separate concern) whenever the tutorial is active.
        // Reason: tapping pause during the guided tutorial pops the
        // authored pause overlay, which has a "Home" button; taking
        // that path bails out of the tutorial mid-step and leaves
        // TutorialController wired up over an unrelated scene state,
        // producing hand-glow-over-menu and other UI ghost bugs. Just
        // make the button unreachable while the tutorial owns the
        // screen. Cheap per-frame — one bool compare + one .active
        // write, which Cocos short-circuits when the value is unchanged.
        if (this.authoredPauseButton) {
            const tutorialActive = !!g.tutorialActive;
            const shouldShow = this._hudOn && !tutorialActive
                            && !this._hudCelebrationHidden;
            if (this.authoredPauseButton.node.active !== shouldShow) {
                this.authoredPauseButton.node.active = shouldShow;
            }
        }

        // Debug speed button — refresh label + visibility per frame.
        // Cheap: refreshDebugSpeedLabel() early-exits when nothing
        // changed. Visibility flips as the mode changes (e.g. player
        // exits endless via portal — should never happen since the
        // scene tears down, but defensive).
        this.syncDebugSpeedButton(g);

        // Pickup countdown readouts (hourglass / gatling / meteor) under
        // the NEXT preview. Each cluster hides at 0 and repaints only
        // when its integer changes.
        this.syncPickupCountdowns(g);

        // Score display was removed (both modes no longer score). The
        // left slot of Row 2 is now mode-dependent:
        //   • Endless / Blind — shows 层高 (cumulative full rows = tower height)
        //   • Level / Collect — HIDDEN (the mode label + lines tell the story)
        // Toggle the BG SPRITE node (typically the Label's parent) so
        // hiding cascades to the Label + pill together; fall back to the
        // Label's own node when bg isn't wired. Otherwise the pill would
        // stay visible in level mode while only the number disappears.
        if (this.scoreLabel) {
            const scoreTarget = this.authoredScoreBgSprite?.node
                             ?? this.scoreLabel.node;
            // Blind mode uses endless mechanics (height-based scoring),
            // so show 层高 there too.
            if (g.mode === 'endless' || g.mode === 'blind') {
                this.scoreLabel.string = t('hud.heightValue', { n: g.endlessProgress.cumulative });
                scoreTarget.active = true;
            } else {
                this.scoreLabel.string = '';
                scoreTarget.active = false;
            }
        }
        // Level timer paint — only in level / collect modes. Value is
        // frozen (label stops updating) between showLevelClearTime and
        // the next reset, so the "通关时间：xx:xx" modal doesn't tick
        // past the winning number. Endless / blind hide the whole
        // container. Skip the string write when the integer second
        // hasn't changed (Label.string setter triggers a full re-tesselate;
        // at 60fps this would burn cycles writing the same string).
        // Format: MM:SS with each part zero-padded to 2 digits, and MM
        // uncapped (55min55sec → "55:55", 105min3sec → "105:03").
        if (this.authoredLevelTimerLabel) {
            const containerNode = this.authoredLevelTimerContainer
                ?? this.authoredLevelTimerLabel.node;
            // Gate on BOTH gameplay-is-visible AND mode is level/collect.
            // Additionally respect _levelTimerForceHidden — set true in
            // showLevelClearTime's hide-at-end callback so the "timer
            // disappears" beat isn't clobbered by this per-frame toggle
            // flipping it back on. Cleared in resetLevelTimerPosition
            // when the next level starts.
            const isLevelMode = g.mode === 'level' || g.mode === 'collect';
            const wantActive = this._hudOn && isLevelMode && !this._levelTimerForceHidden;
            containerNode.active = wantActive;
            if (wantActive) {
                const totalSec = this._levelTimerFrozenSec ?? g.levelElapsedSec;
                if (totalSec !== this._levelTimerLastSec) {
                    this._levelTimerLastSec = totalSec;
                    const mm = Math.floor(totalSec / 60).toString().padStart(2, '0');
                    const ss = (totalSec % 60).toString().padStart(2, '0');
                    this.authoredLevelTimerLabel.string = `${mm}:${ss}`;
                }
                // (Per-frame position enforcement was removed — it was
                // stepping on the author's ability to set the initial
                // position in the editor. Rest snapshot now happens
                // JUST BEFORE the tween-to-center starts, so
                // resetLevelTimerPosition restores to whatever the
                // container was actually at when the win fired —
                // Widget / Layout / manual moves all respected.)
            } else {
                this._levelTimerLastSec = -1;
            }
        }
        // Lines counter — also gone. Endless tracks 层高 (left slot);
        // level / collect just show the mode + NEXT now (cleared-rows
        // count was removed per the latest request).
        if (this.linesLabel) {
            this.linesLabel.string = '';
            this.linesLabel.node.active = false;
        }
        // Mode label was retired entirely — endless used to show
        // 'ENDLESS' in the top-right, but 层高 takes that slot now and
        // 'ENDLESS' was redundant. Keep the field around (so other
        // code paths don't have to null-check), but never paint it.
        if (this.modeLabel) {
            this.modeLabel.string = '';
            this.modeLabel.node.active = false;
        }
        // Paint the NEXT-piece preview if it changed.
        const nextType  = g.nextType ?? '?';
        const nextShape = g.nextShape;
        const previewKey = `${nextType}|${nextShape ? nextShape.map(r => r.join(',')).join(';') : 'std'}`;
        if (this.nextPreviewGfx && this.lastNextPreviewKey !== previewKey) {
            this.lastNextPreviewKey = previewKey;
            this.paintNextPreview(nextType as PieceType, nextShape);
        }

        // Collect-mode progress panel — rebuild when the goal set changes
        // (new level), otherwise just refresh the counter strings.
        this.refreshCollectPanel(g);

        for (const key of ITEM_KEYS) {
            const lab = this.itemCountLabels.get(key);
            if (lab) lab.string = `×${g.inventory[key]}`;
        }

        // Energy bar — redraw only on change.
        if (this.energyLabel && this.lastEnergyDrawn !== g.energyCharge) {
            this.lastEnergyDrawn = g.energyCharge;
            this.energyLabel.string = `⚡ ${g.energyCharge}/${ENERGY_FULL_THRESHOLD}`;
            this.redrawEnergyFill(g.energyCharge);
        }
    }

    // ============================================================
    //  UI construction
    // ============================================================
    private buildUi(): void {
        // Attached to the Canvas node — so `this.node` is the Canvas.
        // Top-strip / Row 1 buttons / score / NEXT preview are all
        // authored in the scene (see wireAuthoredHudTop for the slot
        // list). The remaining Graphics-driven bits — energy bar,
        // picker overlay, fate modal — are built programmatically
        // below until they're Sprite-ified in a later batch.
        const root = this.node;
        const w = 750;
        const h = 1334;
        const tx = root.getComponent(UITransform);
        const liveW = tx?.contentSize.width  ?? w;
        const liveH = tx?.contentSize.height ?? h;
        log(`[TowerBlocks] HUD layout using design ${w}×${h} (live canvas ${liveW}×${liveH})`);

        this.wireAuthoredHudTop();
        this.buildEnergyBar(root, w, h);
        this.buildPicker(root, w, h);
        this.buildFateModal(root, w, h);
        this.buildBlindColumnIndicator(root, w, h);
        this.buildPickupCountdownIndicators(root, w, h);
        this.buildFailRevealPrompt(root, w, h);
        // "Show Tower" toggle is a DEV-only cheat — it defeats the
        // whole point of Blind mode. Only build it on development
        // builds; release builds simply never create the node.
        if (IS_DEV_BUILD) {
            this.buildBlindTowerToggleButton(root, w, h);
        }
    }

    /** Wire the authored (Sprite-based) top-strip HUD nodes: cache the
     *  label refs the update loop reads from, bind click handlers,
     *  and add a Graphics component to the NEXT shape canvas so
     *  paintNextPreview() has a target. Any missing @property slot
     *  gets a soft warning — the game runs, that element just won't
     *  do anything. */
    private wireAuthoredHudTop(): void {
        // Level timer container — cache its authored local position so
        // showLevelClearTime can tween to (0,0) and resetLevelTimerPosition
        // can restore for the next level run. Also clear the frozen-ms
        // snapshot so a fresh scene load starts ticking again.
        const timerNode = this.authoredLevelTimerContainer
            ?? this.authoredLevelTimerLabel?.node
            ?? null;
        // Rest position/scale snapshot moved to showLevelClearTime —
        // capturing at wire time was too early (Widget / Layout may
        // not have run yet) AND it locked the container's initial
        // position to whatever the first frame happened to compute.
        // Snapshotting at tween-start captures the ACTUAL live
        // position the container had just before we moved it, so
        // resetLevelTimerPosition restores to exactly that.
        this._levelTimerFrozenSec = null;
        this._levelTimerLastSec = -1;

        // Score / 层高 label — read by refreshHud() each frame.
        if (this.authoredScoreLabel) {
            this.scoreLabel = this.authoredScoreLabel;
        } else {
            log('[HudController] authoredScoreLabel not wired');
            // Fallback: create an off-screen dummy so downstream code
            // doesn't crash on `.string =`.
            this.scoreLabel = this.makeDummyLabel();
        }
        // Lines / mode labels aren't shown in the current UI but the
        // update() loop still writes to them defensively — give them
        // off-screen dummies so no null-check is needed.
        this.linesLabel = this.makeDummyLabel();
        this.modeLabel  = this.makeDummyLabel();
        this.nextLabel  = this.makeDummyLabel();

        // NEXT preview title Label — static i18n text. trackI18nLabel
        // handles the initial paint + automatic re-paint on language
        // switch, so we don't have to manage it in the per-frame loop.
        if (this.authoredNextPreviewTitleLabel) {
            this.trackI18nLabel(this.authoredNextPreviewTitleLabel, 'hud.next');
        }

        // Pause button + its inner Label (for ⏸ ↔ ▶ swap).
        if (this.authoredPauseButton) {
            this.authoredPauseButton.node.off('click');
            this.authoredPauseButton.node.on('click', () => this.onPauseButtonClicked(), this);
        } else {
            log('[HudController] authoredPauseButton not wired');
        }

        // Debug win — hidden in endless mode by hideDebugWinInEndless(),
        // which reads debugWinButtonNode.
        // Also DEV-only overall: hidden in release builds so players
        // can't skip levels with a tap. IS_DEV_BUILD is set per branch
        // (assets/scripts/core/BuildConfig.ts). Additionally, the
        // "隐藏 DEV 按钮" settings toggle (develop-only) can hide it
        // in-session for clean recordings — see `_syncDebugWinButton`
        // which is called on wire + on every settings subscribe fire.
        if (this.authoredDebugWinButton) {
            if (!IS_DEV_BUILD) {
                this.authoredDebugWinButton.node.active = false;
            } else {
                this.authoredDebugWinButton.node.off('click');
                this.authoredDebugWinButton.node.on('click', () => this.onDebugWinClicked(), this);
                this.debugWinButtonNode = this.authoredDebugWinButton.node;
                const lab = this.authoredDebugWinButton.getComponentInChildren(Label);
                if (lab) this.trackI18nLabel(lab, 'debug.forceWin');
                // React to the settings toggle: hide when
                // `getHideDevButtons()` is true, show otherwise.
                this._syncDebugWinButton();
                subscribeSettings(() => this._syncDebugWinButton());
            }
        } else {
            log('[HudController] authoredDebugWinButton not wired');
        }

        // Debug speed — DEV-only. Cycles override 1.0 → 1.1 → ... → 2.0
        // → null (back to natural cumulative-derived speed). Label
        // reflects the *effective* current multiplier so testers see
        // exactly what the game is running at.
        if (this.authoredDebugSpeedButton) {
            if (!IS_DEV_BUILD) {
                this.authoredDebugSpeedButton.node.active = false;
            } else {
                this.authoredDebugSpeedButton.node.off('click');
                this.authoredDebugSpeedButton.node.on('click', () => this.onDebugSpeedClicked(), this);
                this.debugSpeedButtonNode = this.authoredDebugSpeedButton.node;
                this.debugSpeedLabel = this.authoredDebugSpeedButton.getComponentInChildren(Label);
                this.refreshDebugSpeedLabel();
            }
        } else {
            log('[HudController] authoredDebugSpeedButton not wired');
        }

        // NEXT preview shape canvas — add a Graphics component if the
        // authored node doesn't already have one, then cache the ref
        // so paintNextPreview() can draw each frame.
        if (this.authoredNextShapeCanvas) {
            let gfx = this.authoredNextShapeCanvas.getComponent(Graphics);
            if (!gfx) gfx = this.authoredNextShapeCanvas.addComponent(Graphics);
            this.nextPreviewGfx = gfx;
        } else {
            log('[HudController] authoredNextShapeCanvas not wired — NEXT preview shape will not render');
            // Fallback: create an off-screen Graphics so refreshHud
            // doesn't crash reading nextPreviewGfx.
            const off = new Node('NextPreviewGfxFallback');
            off.parent = this.node;
            off.setPosition(-9999, -9999);
            this.nextPreviewGfx = off.addComponent(Graphics);
        }
    }

    /** Off-screen dummy Label so the update loop's `label.string = ...`
     *  writes don't crash when the authored slot for that specific
     *  label wasn't wired. */
    private makeDummyLabel(): Label {
        const n = new Node('HudDummyLabel');
        n.parent = this.node;
        n.setPosition(-9999, -9999);
        const lab = n.addComponent(Label);
        lab.string = '';
        return lab;
    }

    /** Debug helper: walk up the parent chain to check if any ancestor
     *  is inactive (which would hide the node even if it says active). */
    private isNodeChainActive(n: Node | null): string {
        let cur: Node | null = n;
        const chain: string[] = [];
        while (cur) {
            chain.push(`${cur.name}:${cur.active ? '✓' : '✗'}`);
            cur = cur.parent;
        }
        return chain.join(' → ');
    }

    private _nextPaintLogged: boolean = false;

    // ---- Energy bar (VERTICAL, right side of screen) ----
    private buildEnergyBar(root: Node, w: number, h: number): void {
        // Vertical bar. THICKNESS is the visible width of the pill;
        // LENGTH is its height (grows bottom → top with charge).
        // Uses a Widget component to right-align, which correctly
        // handles ANY Fit Mode / aspect ratio — computing a local X
        // from design 750 is unreliable when Canvas contentSize is
        // stretched (e.g., Fit Height + wide preview → contentSize
        // width ≈ 1837, and design coord X=335 ends up past the
        // camera's visible right edge).
        const BAR_THICKNESS = 28;
        const BAR_LENGTH    = 420;
        const RIGHT_GUTTER  = 40;

        // Position is set by Widget below — initial X/Y don't matter.
        const wrap = this.makeNode('Energy', root, 0, 0, BAR_THICKNESS + 12, BAR_LENGTH + 20);
        const widget = wrap.addComponent(Widget);
        widget.isAlignRight = true;
        widget.right = RIGHT_GUTTER;
        widget.isAlignVerticalCenter = true;
        widget.verticalCenter = 0;
        widget.alignMode = Widget.AlignMode.ON_WINDOW_RESIZE;
        widget.updateAlignment();

        // Background track (rounded pill, vertical).
        // Prefer the authored SpriteFrame if wired (assets/image/
        // energy_bar_bg.png) — matches the Graphics fallback pixel-
        // for-pixel and lets the art team retouch without touching
        // code. Falls back to a programmatic Graphics pill so the
        // scene still works with an unwired @property slot.
        const bg = this.makeNode('EnergyBg', wrap, 0, 0, BAR_THICKNESS, BAR_LENGTH);
        if (this.authoredEnergyBarBgSprite) {
            const spr = bg.addComponent(Sprite);
            spr.spriteFrame = this.authoredEnergyBarBgSprite;
            spr.sizeMode    = Sprite.SizeMode.CUSTOM;
            spr.type        = Sprite.Type.SIMPLE;
            // Preserve the exact BAR_THICKNESS × BAR_LENGTH footprint
            // so the fill on top lines up regardless of the source
            // PNG's actual pixel dimensions.
            const bgTx = bg.getComponent(UITransform);
            if (bgTx) bgTx.setContentSize(BAR_THICKNESS, BAR_LENGTH);
        } else {
            const bgGfx = bg.addComponent(Graphics);
            bgGfx.fillColor = new Color(23, 27, 46, 245);   // CARD_INNER
            bgGfx.roundRect(-BAR_THICKNESS / 2, -BAR_LENGTH / 2, BAR_THICKNESS, BAR_LENGTH, BAR_THICKNESS / 2);
            bgGfx.fill();
            bgGfx.strokeColor = new Color(255, 201, 60, 220);   // NEON_GOLD frame
            bgGfx.lineWidth = 2;
            bgGfx.roundRect(-BAR_THICKNESS / 2, -BAR_LENGTH / 2, BAR_THICKNESS, BAR_LENGTH, BAR_THICKNESS / 2);
            bgGfx.stroke();
        }
        this.energyBarBg = bg;

        // Foreground fill — redrawn per energy change. Grows from the
        // bottom of the pill upward. Sits inset inside the bg border
        // (19×410 vs bar 28×420) so the fill doesn't clip through the
        // gold frame — dimensions match `redrawEnergyFill` below.
        const fill = this.makeNode('EnergyFill', wrap, 0, 0, 19, 410);
        this.energyBarFill    = fill;
        this.energyBarFillGfx = fill.addComponent(Graphics);
        this.redrawEnergyFill(0);

        // "⚡" icon above the bar. Text like "N/5" sits on the bottom
        // so the pill's interior stays clean. Both are separate labels
        // now; the existing energyLabel field keeps the numeric text
        // (refreshHud writes to it every frame).
        this.makeLabel('EnergyCap', wrap, 0, BAR_LENGTH / 2 + 16, '⚡', 20, [0.5, 0.5]);
        this.energyLabel = this.makeLabel('EnergyTxt', wrap, 0, -BAR_LENGTH / 2 - 16, `0/${ENERGY_FULL_THRESHOLD}`, 16, [0.5, 0.5]);
        this.energyLabel.color = new Color(245, 248, 255, 255);
    }

    private redrawEnergyFill(charge: number): void {
        if (!this.energyBarFillGfx) return;
        // Inset from the 28×420 bg pill — 19 wide × 410 tall leaves
        // ~4.5px horizontal margin + ~5px vertical margin so the fill
        // sits cleanly inside the gold frame.
        const BAR_THICKNESS = 19;
        const BAR_LENGTH    = 410;
        const ratio = Math.max(0, Math.min(1, charge / ENERGY_FULL_THRESHOLD));
        const fillH = BAR_LENGTH * ratio;
        this.energyBarFillGfx.clear();
        if (fillH <= 0) return;
        // Pulse-style colour: cyan ramping to gold as we approach full.
        const t = ratio;
        const r = Math.round(80  + 200 * t);
        const g = Math.round(220 - 30  * t);
        const b = Math.round(255 - 200 * t);
        this.energyBarFillGfx.fillColor = new Color(r, g, b, 255);
        // Round caps that follow the track radius. Draws a pill anchored
        // to the BOTTOM of the track, growing upward as charge increases.
        const radius = BAR_THICKNESS / 2;
        this.energyBarFillGfx.roundRect(-BAR_THICKNESS / 2, -BAR_LENGTH / 2, BAR_THICKNESS, fillH, radius);
        this.energyBarFillGfx.fill();
    }

    // ---- Blind mode: pixel-cube column number ----
    /**
     * Builds the top-center column-number readout for 闭眼模式.
     *
     * Visual matches the level-select "剩余层数" counter: 5-row × 3-col
     * bitmap font, each lit pixel rendered as a small cream-colored
     * square block via a shared Graphics component. No "列" text — the
     * player's mental model in blind mode is already "which column am
     * I aiming at?", so the label prefix was redundant.
     *
     * Layout: Widget-anchored top-center, sits just below the HUD strip.
     * Repainted only when the integer column changes (see
     * `paintBlindColumn`). Default state: hidden.
     */
    private buildBlindColumnIndicator(root: Node, _w: number, _h: number): void {
        const wrap = new Node('BlindColumnIndicator');
        wrap.parent = root;
        wrap.layer  = root.layer;
        const wrapTx = wrap.addComponent(UITransform);
        // Sized big enough to hold a 2-digit number at the pixel size
        // we draw with — see paintBlindColumn for the geometry.
        const WRAP_WIDTH  = 240;
        const WRAP_HEIGHT = 90;
        wrapTx.setContentSize(WRAP_WIDTH, WRAP_HEIGHT);
        wrapTx.setAnchorPoint(0.5, 1);   // top-center

        const widget = wrap.addComponent(Widget);
        widget.isAlignTop = true;
        widget.top = 90;
        widget.isAlignHorizontalCenter = true;
        widget.horizontalCenter = 0;
        widget.alignMode = Widget.AlignMode.ON_WINDOW_RESIZE;
        widget.updateAlignment();

        // Graphics that draws the pixel-font digits. Painted once here
        // (default "--") and re-drawn on every column change.
        const gfxNode = new Node('BlindColGfx');
        gfxNode.parent = wrap;
        gfxNode.layer  = wrap.layer;
        const gfxTx = gfxNode.addComponent(UITransform);
        gfxTx.setContentSize(WRAP_WIDTH, WRAP_HEIGHT);
        gfxTx.setAnchorPoint(0.5, 1);   // top-center inside wrap
        gfxNode.setPosition(0, 0, 0);
        this.blindColumnGfx = gfxNode.addComponent(Graphics);

        // Default hidden — GameController flips it on when blind starts.
        wrap.active = false;
        this.blindIndicatorRoot = wrap;
    }

    /**
     * Repaint the top-center pixel digits to show `n` (0..COLS-1).
     * Uses the same 5×3 bitmap font as the level-select counter, drawn
     * as filled squares. Cream color (#fff4c8) with a slightly darker
     * outline so each "cube" reads as a distinct block against the sky.
     */
    private paintBlindColumn(n: number): void {
        const gfx = this.blindColumnGfx;
        if (!gfx) return;
        gfx.clear();

        const digits = String(n).split('');
        // Pixel size in UI pixels — 10 makes a 2-digit number about
        // 70px wide (2 digits × 3 cols × 10 + 10 gap), which reads well
        // at the top-center of a 750-wide design canvas.
        const PX      = 10;
        const GAP_X   = PX;               // gap between digits
        const digitW  = 3 * PX;
        const totalW  = digits.length * digitW + Math.max(0, digits.length - 1) * GAP_X;
        // Start X: centered horizontally within the wrap's coordinate
        // space (wrap anchor is (0.5, 1), so x=0 is horizontally centered).
        const startX  = -totalW / 2;
        // Y offset: wrap anchor is top (y=0 is top of wrap). Start
        // digits a few pixels below the top for visual breathing room.
        const TOP_PAD = 6;
        const startY  = -TOP_PAD;

        // Colors match the level-select "剩余层数" counter.
        const fill    = new Color(255, 244, 200, 255);   // warm cream #fff4c8
        const stroke  = new Color(120, 90, 20, 220);     // dark bronze outline

        for (let d = 0; d < digits.length; d++) {
            const pattern = BLIND_DIGIT_PIXELS[digits[d]];
            if (!pattern) continue;
            const dxOffset = startX + d * (digitW + GAP_X);
            for (let row = 0; row < pattern.length; row++) {
                const bits = pattern[row];
                for (let col = 0; col < bits.length; col++) {
                    if (bits.charAt(col) !== '1') continue;
                    // UI y grows UPWARD (Cocos UI). Bitmap row 0 is
                    // the TOP row of the digit, so we subtract to go
                    // downward from `startY`.
                    const px = dxOffset + col * PX;
                    const py = startY - row * PX - PX;   // -PX so cell fits above baseline
                    gfx.fillColor = fill;
                    gfx.rect(px, py, PX, PX);
                    gfx.fill();
                    gfx.strokeColor = stroke;
                    gfx.lineWidth = 1;
                    gfx.rect(px, py, PX, PX);
                    gfx.stroke();
                }
            }
        }
    }

    /**
     * Build the pickup countdown readouts (hourglass / gatling / meteor).
     *
     *   Row 1 (top): hourglass — remaining seconds, centered under NEXT
     *   Row 2 (below): gatling (left of center) | meteor (right of center)
     *
     * Same pixel-cube digit art as `blindColumnGfx` (see paintBlindColumn).
     * Each cluster auto-hides when its value is 0 so the top strip
     * stays clean when no pickup is currently active. Repaint happens
     * only when the integer value changes (see syncPickupCountdowns).
     */
    private buildPickupCountdownIndicators(root: Node, _w: number, _h: number): void {
        // Hourglass sits directly under the authored NEXT preview box
        // (parented to it so it follows the box wherever the artist
        // places it in the scene). Falls back to HUD root if the
        // @property slot wasn't wired.
        const nextBox = this.authoredNextPreviewBox ?? root;
        const HG_WRAP_WIDTH  = 180;     // matches gatling/meteor readouts
        const HG_WRAP_HEIGHT = 80;      // matches gatling/meteor readouts (12px digits)
        // Hardcoded local position relative to nextBox (or HUD root
        // fallback). Was previously derived from nextBox's UITransform
        // + ROW_GAP so it hugged the bottom edge — swapped to a fixed
        // offset because the authored NEXT box's height moved and the
        // derived position drifted off. Y = -156 is where art wants it.
        const hgTopY = -156;

        const { root: hgWrap, gfx: hgGfx } =
            this.buildPixelCountReadout(nextBox, 'HourglassCountdown', 0, hgTopY, HG_WRAP_WIDTH, HG_WRAP_HEIGHT);
        this.hourglassCountRoot = hgWrap;
        this.hourglassCountGfx  = hgGfx;
        // Cache rest position for the entrance tween (fly in from the
        // right at 2× → land here at 1×).
        this.hourglassRestPos.set(hgWrap.position.x, hgWrap.position.y, hgWrap.position.z);

        // Gatling + Meteor: BIG readouts at the DEAD CENTER of the top
        // strip (same X + Y as the "piece spawn" area). Both indicators
        // occupy the SAME spot because they never activate simultan-
        // eously — gatling storm and meteor rain are mutually exclusive
        // magic-item flows, and the sync loop only unhides one at a
        // time. Doubled pixel size (12px vs hourglass's 6px) so they're
        // easy to read during the frantic storm phase.
        const BIG_WRAP_WIDTH  = 180;
        const BIG_WRAP_HEIGHT = 80;
        const BIG_TOP_PX      = 90;     // matches blindColumn indicator top

        const { root: gtWrap, gfx: gtGfx } =
            this.buildTopCenteredReadout(root, 'GatlingCountdown', 0, BIG_TOP_PX,
                                         BIG_WRAP_WIDTH, BIG_WRAP_HEIGHT);
        this.gatlingCountRoot = gtWrap;
        this.gatlingCountGfx  = gtGfx;
        this.gatlingRestPos.set(gtWrap.position.x, gtWrap.position.y, gtWrap.position.z);

        const { root: mtWrap, gfx: mtGfx } =
            this.buildTopCenteredReadout(root, 'MeteorCountdown', 0, BIG_TOP_PX,
                                         BIG_WRAP_WIDTH, BIG_WRAP_HEIGHT);
        this.meteorCountRoot = mtWrap;
        this.meteorCountGfx  = mtGfx;
        this.meteorRestPos.set(mtWrap.position.x, mtWrap.position.y, mtWrap.position.z);
    }

    /** Multi-stage entrance tween for a countdown readout:
     *    Stage 1 (300ms, backOut): pop from scale 0 → 2× at SCREEN
     *      CENTER. backOut = fast burst with a slight overshoot.
     *    HOLD (500ms): sits perfectly still at center 2×. Gives the
     *      player a beat to register which item just fired.
     *    Stage 2a (250ms, quadOut): travels HALF the distance to the
     *      rest position, scaling 2× → 1.5×. Fast start, decelerating
     *      into the middle → "slow middle".
     *    Stage 2b (250ms, quadIn): travels the SECOND half, scaling
     *      1.5× → 1×. Slow start (matches 2a end), accelerating out
     *      → "fast end". Together 2a+2b give the fast → slow → fast
     *      arc the user asked for (not the default slow → fast → slow
     *      of quadInOut).
     *
     *  All coordinates are computed in the WRAP's parent-local frame so
     *  the animation looks the same regardless of whether the wrap is
     *  parented to NextPreviewBox (hourglass) or the HUD root
     *  (gatling / meteor). */
    private _playCountdownEntrance(wrap: Node, restPos: Vec3): void {
        if (!wrap.isValid || !wrap.parent) return;
        const parentTx = wrap.parent.getComponent(UITransform);
        // Convert world (0, 0) = screen dead-center into the wrap
        // parent's local frame. HUD root origin already sits at screen
        // center (Canvas 750×1334 anchor 0.5,0.5), so for gatling/
        // meteor this is (0, 0). For hourglass (parented to
        // NextPreviewBox) it accounts for the box's offset from center.
        const centerLocal = parentTx
            ? parentTx.convertToNodeSpaceAR(new Vec3(0, 0, 0))
            : new Vec3(0, 0, 0);
        // Midpoint of the center → rest position path. Used as the
        // "slow middle" waypoint for the two-stage fly-out so we get
        // the fast → slow → fast velocity curve.
        const midX = (centerLocal.x + restPos.x) * 0.5;
        const midY = (centerLocal.y + restPos.y) * 0.5;

        // Kick off at screen center, scale 0 (invisible dot).
        wrap.setPosition(centerLocal.x, centerLocal.y, restPos.z);
        wrap.setScale(new Vec3(0, 0, 1));

        tween(wrap)
            // Stage 1: pop from 0 → 2× at screen center (fast entrance).
            .to(0.30, {
                position: new Vec3(centerLocal.x, centerLocal.y, restPos.z),
                scale:    new Vec3(2, 2, 1),
            }, { easing: 'backOut' })
            // HOLD: 500ms of stillness in the middle. Nothing changes.
            .delay(0.50)
            // Stage 2a: fast start → slow middle. Half the distance,
            // scale 2× → 1.5×.
            .to(0.25, {
                position: new Vec3(midX, midY, restPos.z),
                scale:    new Vec3(1.5, 1.5, 1),
            }, { easing: 'quadOut' })
            // Stage 2b: slow middle → fast end. Rest of the distance,
            // scale 1.5× → 1×.
            .to(0.25, {
                position: new Vec3(restPos.x, restPos.y, restPos.z),
                scale:    new Vec3(1, 1, 1),
            }, { easing: 'quadIn' })
            .start();
    }

    /** Factory: one pixel-cube number readout, positioned relative to
     *  its parent (typically the NEXT preview box). `centerOffsetX` is
     *  the X offset from the parent's origin; `topY` is the local Y
     *  where the wrap's TOP edge sits (wrap anchor is 0.5, 1 so the
     *  wrap position IS its top-center). Returns { root, gfx } so the
     *  caller can toggle active + repaint. */
    private buildPixelCountReadout(
        parent: Node,
        name: string,
        centerOffsetX: number,
        topY: number,
        wrapWidth: number,
        wrapHeight: number,
    ): { root: Node; gfx: Graphics } {
        const wrap = new Node(name);
        wrap.parent = parent;
        wrap.layer  = parent.layer;
        const wrapTx = wrap.addComponent(UITransform);
        wrapTx.setContentSize(wrapWidth, wrapHeight);
        wrapTx.setAnchorPoint(0.5, 1);
        wrap.setPosition(centerOffsetX, topY, 0);

        const gfxNode = new Node(name + 'Gfx');
        gfxNode.parent = wrap;
        gfxNode.layer  = wrap.layer;
        const gfxTx = gfxNode.addComponent(UITransform);
        gfxTx.setContentSize(wrapWidth, wrapHeight);
        gfxTx.setAnchorPoint(0.5, 1);
        gfxNode.setPosition(0, 0, 0);
        const gfx = gfxNode.addComponent(Graphics);

        wrap.active = false;   // shown by syncPickupCountdowns when > 0
        return { root: wrap, gfx };
    }

    /** Factory: one pixel-cube number readout, Widget-anchored to the
     *  top of the HUD with a horizontal offset from center. Same
     *  pattern as blindColumnGfx wrap (top-center anchor, digits paint
     *  down from y=0). Used for the BIG gatling + meteor readouts at
     *  the top of the screen. */
    private buildTopCenteredReadout(
        parent: Node,
        name: string,
        centerOffsetX: number,
        topPx: number,
        wrapWidth: number,
        wrapHeight: number,
    ): { root: Node; gfx: Graphics } {
        const wrap = new Node(name);
        wrap.parent = parent;
        wrap.layer  = parent.layer;
        const wrapTx = wrap.addComponent(UITransform);
        wrapTx.setContentSize(wrapWidth, wrapHeight);
        wrapTx.setAnchorPoint(0.5, 1);

        const widget = wrap.addComponent(Widget);
        widget.isAlignTop = true;
        widget.top = topPx;
        widget.isAlignHorizontalCenter = true;
        widget.horizontalCenter = centerOffsetX;
        widget.alignMode = Widget.AlignMode.ON_WINDOW_RESIZE;
        widget.updateAlignment();

        const gfxNode = new Node(name + 'Gfx');
        gfxNode.parent = wrap;
        gfxNode.layer  = wrap.layer;
        const gfxTx = gfxNode.addComponent(UITransform);
        gfxTx.setContentSize(wrapWidth, wrapHeight);
        gfxTx.setAnchorPoint(0.5, 1);
        gfxNode.setPosition(0, 0, 0);
        const gfx = gfxNode.addComponent(Graphics);

        wrap.active = false;
        return { root: wrap, gfx };
    }

    /** Paint pixel-cube digits. PX defaults to 6 (small — hourglass);
     *  pass 12 for the big centered gatling/meteor readouts.
     *  Same colors as blind column: cream #fff4c8 fill + bronze outline. */
    private paintSmallPixelNumber(gfx: Graphics, n: number, PX: number = 6): void {
        gfx.clear();
        const digits = String(Math.max(0, Math.floor(n))).split('');
        const GAP_X   = PX;
        const digitW  = 3 * PX;
        const totalW  = digits.length * digitW + Math.max(0, digits.length - 1) * GAP_X;
        const startX  = -totalW / 2;
        const TOP_PAD = 6;
        const startY  = -TOP_PAD;
        const fill    = new Color(255, 244, 200, 255);
        const stroke  = new Color(120, 90, 20, 220);
        for (let d = 0; d < digits.length; d++) {
            const pattern = BLIND_DIGIT_PIXELS[digits[d]];
            if (!pattern) continue;
            const dxOffset = startX + d * (digitW + GAP_X);
            for (let row = 0; row < pattern.length; row++) {
                const bits = pattern[row];
                for (let col = 0; col < bits.length; col++) {
                    if (bits.charAt(col) !== '1') continue;
                    const px = dxOffset + col * PX;
                    const py = startY - row * PX - PX;
                    gfx.fillColor = fill;
                    gfx.rect(px, py, PX, PX);
                    gfx.fill();
                    gfx.strokeColor = stroke;
                    gfx.lineWidth = 1;
                    gfx.rect(px, py, PX, PX);
                    gfx.stroke();
                }
            }
        }
    }

    /** Per-frame update: read hourglass / gatling / meteor state, show/
     *  hide the corresponding readouts, and repaint only when the
     *  integer value changed. Called from update() so it stays in sync
     *  with the game clock without wiring hooks into every activation
     *  path. */
    private syncPickupCountdowns(g: any): void {
        // Only show countdown widgets during ACTIVE play. On level-win /
        // game-over the underlying state (gatling pendingCount, meteor
        // bag remaining, hourglass ms) may still be non-zero because the
        // storm/rain/slowdown hadn't finished when the level ended — but
        // the run is over, so the countdowns should disappear immediately.
        const active = !!g.running && !g.gameOver;

        // Hourglass — round UP so "3s left" doesn't visually flip to 0
        // half a frame early. Hide at 0 (inactive).
        const hgMs  = g.hourglass?.remainingMs?.() ?? 0;
        const hgSec = hgMs > 0 ? Math.ceil(hgMs / 1000) : 0;
        if (this.hourglassCountRoot) {
            const show = active && hgSec > 0;
            if (this.hourglassCountRoot.active !== show) {
                this.hourglassCountRoot.active = show;
                // Ensure the wrap is at its rest position + scale 1×
                // when re-shown (the fake-label flight in
                // _flyNumberThenPick left no trace on the real wrap;
                // reset here defensively in case anything else moved it).
                if (show) {
                    this.hourglassCountRoot.setPosition(this.hourglassRestPos);
                    this.hourglassCountRoot.setScale(new Vec3(1, 1, 1));
                }
            }
            if (show && hgSec !== this.lastHourglassSec) {
                this.lastHourglassSec = hgSec;
                if (this.hourglassCountGfx) this.paintSmallPixelNumber(this.hourglassCountGfx, hgSec, 12);
            }
            if (!show) this.lastHourglassSec = -1;
        }

        // Gatling — bullets still to fire + in-flight. Hide at 0.
        // Uses PX=12 (2× hourglass) for the big screen-centered readout.
        const gtCount = g.gatling?.unresolvedCount?.() ?? 0;
        if (this.gatlingCountRoot) {
            const show = active && gtCount > 0;
            if (this.gatlingCountRoot.active !== show) {
                this.gatlingCountRoot.active = show;
                if (show) {
                    this.gatlingCountRoot.setPosition(this.gatlingRestPos);
                    this.gatlingCountRoot.setScale(new Vec3(1, 1, 1));
                }
            }
            if (show && gtCount !== this.lastGatlingCount) {
                this.lastGatlingCount = gtCount;
                if (this.gatlingCountGfx) this.paintSmallPixelNumber(this.gatlingCountGfx, gtCount, 12);
            }
            if (!show) this.lastGatlingCount = -1;
        }

        // Meteor — DOTs still queued in the bag + the live DOT if the
        // current active piece is a meteor fragment. Hide at 0.
        // Uses PX=12 (2× hourglass) for the big screen-centered readout.
        const bagPending = g.bag?.meteorRemaining ?? 0;
        const liveDot    = g.current && g.current.type === 'DOT' ? 1 : 0;
        const mtCount    = bagPending + liveDot;
        if (this.meteorCountRoot) {
            const show = active && mtCount > 0;
            if (this.meteorCountRoot.active !== show) {
                this.meteorCountRoot.active = show;
                if (show) {
                    this.meteorCountRoot.setPosition(this.meteorRestPos);
                    this.meteorCountRoot.setScale(new Vec3(1, 1, 1));
                }
            }
            if (show && mtCount !== this.lastMeteorCount) {
                this.lastMeteorCount = mtCount;
                if (this.meteorCountGfx) this.paintSmallPixelNumber(this.meteorCountGfx, mtCount, 12);
            }
            if (!show) this.lastMeteorCount = -1;
        }
    }

    /** Toggle the blind-mode column indicator + the test tower-toggle
     *  button together. Called by GameController when the mode changes
     *  (start of blind run / return to menu / etc). */
    public setBlindIndicatorVisible(on: boolean): void {
        if (this.blindIndicatorRoot) this.blindIndicatorRoot.active = on;
        if (this.blindTowerToggleRoot) {
            this.blindTowerToggleRoot.active = on;
            // On show, sync label to whatever the debug flag was
            // left at (default false / hidden on a fresh run).
            if (on) this.refreshBlindTowerToggleLabel();
        }
        if (!on) this.blindLastColumn = -1;   // force redraw on next show
    }

    /** Update the top pixel-cube column readout. GameController polls
     *  the camera-facing column each frame and calls this; the graphics
     *  only repaint when the integer column actually changed. */
    public setBlindColumn(col: number): void {
        if (!this.blindColumnGfx) return;
        const int = Math.round(col);
        // Normalize into [0, COLS) so displayed value doesn't drift
        // negative after continuous left-rotation.
        const normalized = ((int % COLS) + COLS) % COLS;
        if (normalized === this.blindLastColumn) return;
        this.blindLastColumn = normalized;
        this.paintBlindColumn(normalized);
    }

    // ---- Post-fail reveal prompt ----
    /**
     * Build the "very sorry, tap to continue" full-screen overlay that
     * gates the actual game-over popup. Design:
     *   - Root is a full-canvas Node with a Sprite background at very
     *     low alpha (just enough to catch touches — visually almost
     *     invisible so the player still sees the tower behind).
     *   - A bottom-center Label carries the prompt text.
     *   - Root Node listens for `TOUCH_START`; when tapped, fires the
     *     stored `failRevealTapHandler` callback (installed by
     *     `showFailRevealPrompt`) once, then clears it.
     *
     * The overlay stays hidden by default. Caller flow:
     *   1. `showFailRevealPrompt(onTap)` — displays overlay
     *   2. player taps → onTap fires
     *   3. caller calls `hideFailRevealPrompt()` to tear it down
     */
    private buildFailRevealPrompt(root: Node, w: number, h: number): void {
        const wrap = new Node('FailRevealPrompt');
        wrap.parent = root;
        wrap.layer  = root.layer;
        const wrapTx = wrap.addComponent(UITransform);
        wrapTx.setContentSize(w, h);
        wrapTx.setAnchorPoint(0.5, 0.5);
        // Stretch full canvas via Widget so it catches taps anywhere
        // and its size follows Canvas fit-mode.
        const widget = wrap.addComponent(Widget);
        widget.isAlignLeft = true;   widget.left = 0;
        widget.isAlignRight = true;  widget.right = 0;
        widget.isAlignTop = true;    widget.top = 0;
        widget.isAlignBottom = true; widget.bottom = 0;
        widget.alignMode = Widget.AlignMode.ON_WINDOW_RESIZE;
        widget.updateAlignment();

        // Faint dim so the tower still reads clearly through the
        // overlay. Sprite is required for the node to catch touches;
        // color alpha of ~60/255 is just enough to signal "modal
        // active" without hiding the tower.
        const dim = wrap.addComponent(Sprite);
        dim.color = new Color(0, 0, 0, 60);
        // ensureDimBackdrop pattern isn't used here — Sprite by itself
        // is fine because the wrap doesn't need a rounded card etc.

        // Bottom-center prompt label. Y = -0.35 * h puts it about 15%
        // above the bottom edge, clearly separated from screen bottom
        // but still low enough to not cover the tower.
        const label = this.makeLabel(
            'FailRevealText', wrap, 0, -h * 0.35,
            t('blind.fail.prompt'), 32, [0.5, 0.5],
        );
        // Style (color + outline + shadow) is re-applied every time the
        // prompt is shown — see applyFailRevealTextStyle. That way a
        // stale hot-reloaded node still gets the current look.
        this.failRevealTextLabel = label;
        this.applyFailRevealTextStyle();
        this.trackI18nLabel(label, 'blind.fail.prompt');

        // Any tap fires the caller's continuation once and clears the
        // callback so double-taps don't re-invoke it.
        wrap.on(Node.EventType.TOUCH_START, () => {
            const cb = this.failRevealTapHandler;
            if (!cb) return;
            this.failRevealTapHandler = null;
            cb();
        });

        wrap.active = false;
        this.failRevealRoot = wrap;
    }

    /** Show the post-fail reveal overlay. `onTap` fires exactly once
     *  when the player taps anywhere; caller is expected to call
     *  `hideFailRevealPrompt()` in that callback (or immediately
     *  before firing the next popup). */
    public showFailRevealPrompt(onTap: () => void): void {
        if (!this.failRevealRoot) {
            // No HUD prompt available — fire the continuation
            // immediately so the caller's flow doesn't stall.
            onTap();
            return;
        }
        this.failRevealTapHandler = onTap;
        this.failRevealRoot.active = true;
        // Ensure the overlay sits above every previously-added HUD
        // element (energy bar, blind indicator, etc.) so its tap
        // handler wins the touch.
        this.failRevealRoot.setSiblingIndex(999);
        // Re-apply the prompt text style on every show so a stale
        // hot-reloaded label from a previous session picks up the
        // latest color / outline / shadow.
        this.applyFailRevealTextStyle();
    }

    /** Layer toast: small "第 N 层达成！" gold text that briefly pops
     *  and fades. Fires every layer, so it's tuned FAST + SUBTLE:
     *  ~0.7s total, 36pt, drifts up a bit while fading. Built lazily
     *  on first call; nodes are re-used across firings so the tween
     *  just restarts.
     *
     *  Called by GameController.playMilestoneCelebration. */
    public showMilestoneToast(milestone: number, cumulative: number): void {
        // Preferred path: unified ToastManager (endless milestones are
        // positive/celebration events → info variant).
        const key = 'endless.milestone';
        const translated = t(key, { n: cumulative });
        const text = translated === key
            ? `第 ${cumulative} 层达成！`
            : translated;
        if (ToastManager.instance) {
            ToastManager.instance.info(text);
            return;
        }
        this.ensureMilestoneToast();
        const label = this.milestoneToastLabel;
        const node  = this.milestoneToastRoot;
        if (!label || !node) return;
        label.string = text;
        node.active = true;
        node.setSiblingIndex(999);
        // Reset transform + fade + start-Y for each firing. Y = 60
        // above dead-center so the toast doesn't cover the tower;
        // it drifts UP another 40 units over its lifetime.
        node.setScale(0.6, 0.6, 1);
        node.setPosition(0, 60, 0);
        const op = node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
        op.opacity = 255;
        // Pop in (0.15s) → hold briefly (0.25s) → drift up + fade (0.35s).
        tween(node)
            .to(0.15, { scale: new Vec3(1.0, 1.0, 1) }, { easing: 'backOut' })
            .delay(0.25)
            .to(0.35, { position: new Vec3(0, 100, 0) }, { easing: 'quadOut' })
            .start();
        tween(op)
            .delay(0.40)
            .to(0.35, { opacity: 0 }, { easing: 'quadIn' })
            .call(() => { if (node) node.active = false; })
            .start();
        // milestone === cumulative currently; param kept for future
        // "every N layers = bigger celebration" branching.
        void milestone;
    }

    /** Layer toast: gold text with black outline + shadow. Built
     *  lazily inside showMilestoneToast — we don't want to pay the
     *  Node cost during boot for a feature that may never fire this
     *  session (e.g., level mode). */
    private milestoneToastRoot:  Node  | null = null;
    private milestoneToastLabel: Label | null = null;

    private ensureMilestoneToast(): void {
        if (this.milestoneToastRoot) return;
        const wrap = new Node('MilestoneToast');
        wrap.parent = this.node;
        wrap.layer  = this.node.layer;
        wrap.active = false;
        const tx = wrap.addComponent(UITransform);
        tx.setContentSize(400, 60);
        tx.setAnchorPoint(0.5, 0.5);
        wrap.setPosition(0, 60, 0);
        wrap.addComponent(UIOpacity);
        const lab = this.makeLabel('Text', wrap, 0, 0, '', 36, [0.5, 0.5]);
        // Style — gold fill, thin black outline, small drop shadow.
        lab.color = new Color(255, 220, 90, 255);   // NEON_GOLD
        const anyLab = lab as any;
        anyLab.enableOutline = true;
        anyLab.outlineColor  = new Color(0, 0, 0, 255);
        anyLab.outlineWidth  = 1;
        anyLab.enableShadow  = true;
        anyLab.shadowColor   = new Color(0, 0, 0, 200);
        anyLab.shadowOffset  = new Vec2(-2, -2);
        anyLab.shadowBlur    = 0;
        this.milestoneToastRoot  = wrap;
        this.milestoneToastLabel = lab;
    }

    /** Apply white fill + 1px black outline + (-3, -3) hard drop
     *  shadow to the fail-reveal prompt label. Re-runnable so a
     *  hot-reloaded stale node picks up the latest look. */
    private applyFailRevealTextStyle(): void {
        const label = this.failRevealTextLabel;
        if (!label || !label.isValid) return;
        // Cocos 3.x direct properties (LabelOutline / LabelShadow
        // components are deprecated in 3.8 and spam warnings on set).
        const anyLab = label as any;
        anyLab.enableOutline = true;
        anyLab.outlineColor  = new Color(0, 0, 0, 255);
        anyLab.outlineWidth  = 1;
        anyLab.enableShadow  = true;
        anyLab.shadowColor   = new Color(0, 0, 0, 200);
        anyLab.shadowOffset  = new Vec2(-3, -3);
        anyLab.shadowBlur    = 0;
        label.color = new Color(255, 255, 255, 255);
    }

    /** Hide the overlay. Safe to call even if it was never shown. */
    public hideFailRevealPrompt(): void {
        if (!this.failRevealRoot) return;
        this.failRevealRoot.active = false;
        this.failRevealTapHandler = null;
    }

    // ---- Blind mode debug: show/hide tower toggle button ----
    /**
     * Bottom-left button used during 闭眼模式 for testing. Clicking it
     * flips `gameController.blindShowTowerDebug`, which the render loop
     * reads to decide whether to draw the settled tower cells. Button
     * label updates to reflect the CURRENT state:
     *   - Tower hidden  → button reads "🙉 显示塔"  (click to reveal)
     *   - Tower visible → button reads "🙈 隐藏塔"  (click to hide)
     *
     * Positioned in bottom-left via Widget so it doesn't collide with
     * the pause button (top-right) or the "列 N" indicator (top-center).
     * Toggled visible together with `blindIndicatorRoot`.
     */
    private buildBlindTowerToggleButton(root: Node, _w: number, _h: number): void {
        const BTN_W = 150;
        const BTN_H = 70;

        const wrap = new Node('BlindTowerToggleBtn');
        wrap.parent = root;
        wrap.layer  = root.layer;
        const tx = wrap.addComponent(UITransform);
        tx.setContentSize(BTN_W, BTN_H);
        tx.setAnchorPoint(0.5, 0.5);

        // Anchor to bottom-left with a small gutter — stays put across
        // fit modes / aspect ratios.
        const widget = wrap.addComponent(Widget);
        widget.isAlignLeft   = true; widget.left   = 30;
        widget.isAlignBottom = true; widget.bottom = 30;
        widget.alignMode = Widget.AlignMode.ON_WINDOW_RESIZE;
        widget.updateAlignment();

        // Card background: dark pill with a neon-gold outline so it
        // reads as a debug UI affordance and not a game button.
        const g = wrap.addComponent(Graphics);
        g.fillColor = new Color(20, 22, 40, 220);   // near-black card
        g.roundRect(-BTN_W / 2, -BTN_H / 2, BTN_W, BTN_H, 16);
        g.fill();
        g.strokeColor = new Color(255, 220, 90, 220);   // NEON_GOLD frame
        g.lineWidth = 2;
        g.roundRect(-BTN_W / 2, -BTN_H / 2, BTN_W, BTN_H, 16);
        g.stroke();

        this.blindTowerToggleLabel = this.makeLabel(
            'ToggleLabel', wrap, 0, 0, t('blind.showTower'), 24, [0.5, 0.5],
        );
        this.blindTowerToggleLabel.color = new Color(255, 220, 90, 255);

        wrap.addComponent(Button);
        wrap.on(Button.EventType.CLICK, () => {
            const gc = this.gameController;
            if (!gc) return;
            gc.blindShowTowerDebug = !gc.blindShowTowerDebug;
            this.refreshBlindTowerToggleLabel();
        }, this);

        wrap.active = false;
        this.blindTowerToggleRoot = wrap;
    }

    /** Sync the button text with the current debug-flag state. Called
     *  after any programmatic flip AND every time we show the button
     *  so a re-entry doesn't carry stale copy from the previous run. */
    private refreshBlindTowerToggleLabel(): void {
        if (!this.blindTowerToggleLabel) return;
        const showing = !!this.gameController?.blindShowTowerDebug;
        this.blindTowerToggleLabel.string = showing ? t('blind.hideTower') : t('blind.showTower');
    }

    // ---- Picker overlay ----
    private buildPicker(root: Node, w: number, h: number): void {
        // If the scene has an authored EnergyPicker wired to the
        // @property slot, DON'T build a parallel programmatic one —
        // otherwise we end up with two 'EnergyPicker' nodes fighting
        // for sibling order / render layer and any icons/stars we
        // inject may go into the wrong overlay.
        if (this.authoredEnergyPicker) {
            console.log('[Picker] authored EnergyPicker detected — skipping programmatic buildPicker');
            return;
        }
        const overlay = this.makeNode('EnergyPicker', root, 0, 0, w, h);
        overlay.active = false;
        this.pickerOverlay = overlay;

        // Dimmer background. Note: Graphics-based fills don't always render
        // on Android — accept that the dim might be invisible on device.
        const dim = this.makeNode('Dim', overlay, 0, 0, w, h);
        const dimGfx = dim.addComponent(Graphics);
        dimGfx.fillColor = new Color(0, 0, 0, 180);
        dimGfx.rect(-w / 2, -h / 2, w, h);
        dimGfx.fill();

        // Title — energy bar full, the player must spend it on one item.
        const title = this.makeLabel('Title', overlay, 0, 230, t('picker.title'), 36, [0.5, 0.5]);
        this.trackI18nLabel(title, 'picker.title');
        title.color = new Color(255, 235, 180, 255);
        // Small subtitle hint below the title.
        const subtitle = this.makeLabel('TitleHint', overlay, 0, 188, t('picker.hint'), 18, [0.5, 0.5]);
        this.trackI18nLabel(subtitle, 'picker.hint');
        subtitle.color = new Color(200, 210, 230, 220);

        // 2 choice slots, side by side. Slot bg is redrawn per pick so
        // it can paint the rarity colour — keep the Graphics ref.
        const SLOT_W = 270, SLOT_H = 340;
        const GAP = 40;
        const SLOT_Y = -30;
        const xs = [-(SLOT_W / 2 + GAP / 2), SLOT_W / 2 + GAP / 2];
        for (let i = 0; i < 2; i++) {
            const slot = this.makeNode(`Slot_${i}`, overlay, xs[i], SLOT_Y, SLOT_W, SLOT_H);
            const slotGfx = slot.addComponent(Graphics);
            // Initial fill — gets overwritten by repaintSlot in showPicker.
            this.repaintSlotBg(slotGfx, SLOT_W, SLOT_H, RARITY_STYLES.common);

            // Rarity badge (above the glyph) — small pill with label.
            const badgeBgNode = this.makeNode(`BadgeBg_${i}`, slot, 0, 130, 110, 30);
            const badgeGfx = badgeBgNode.addComponent(Graphics);
            badgeGfx.fillColor = rgbaToColor(RARITY_STYLES.common.badgeBg);
            badgeGfx.roundRect(-55, -15, 110, 30, 15);
            badgeGfx.fill();
            const badgeLab = this.makeLabel(`Badge_${i}`, badgeBgNode, 0, 0, t('rarity.common'), 18, [0.5, 0.5]);
            badgeLab.color = new Color(240, 245, 255, 255);

            // Glyph (big emoji) — kept as fallback for items without a
            // wired PNG icon. Sprite icon below sits on top of it and
            // hides it visually when an icon SpriteFrame is available.
            const glyphLab = this.makeLabel(`Glyph_${i}`, slot, 0, 60, '?', 90, [0.5, 0.5]);
            glyphLab.color = new Color(255, 255, 255, 255);

            // Item icon Sprite — same slot position as the glyph, sits
            // on top. repaintSlot swaps the spriteFrame per item.
            const iconNode = this.makeNode(`Icon_${i}`, slot, 0, 60, 200, 200);
            const iconSpr = iconNode.addComponent(Sprite);
            iconSpr.sizeMode = Sprite.SizeMode.CUSTOM;
            iconSpr.type     = Sprite.Type.SIMPLE;
            iconNode.active  = false;   // shown by repaintSlot when a frame is available
            this.pickerSlotIcons.push(iconSpr);

            // Tier stars — 3 slots (always shown when a key is set) +
            // 3 fill overlays (toggled by tier). Sits BELOW the icon,
            // above the description text.
            const STAR_SIZE = 36;
            const STAR_GAP  = 8;
            const STAR_ROW_Y = -75;
            const totalW = STAR_SIZE * 3 + STAR_GAP * 2;
            const startX = -totalW / 2 + STAR_SIZE / 2;
            const slotFills: Sprite[] = [];
            for (let s = 0; s < 3; s++) {
                const sx = startX + s * (STAR_SIZE + STAR_GAP);
                // Empty slot background (always visible).
                const bg = this.makeNode(`StarSlot_${i}_${s}`, slot, sx, STAR_ROW_Y, STAR_SIZE, STAR_SIZE);
                const bgSpr = bg.addComponent(Sprite);
                bgSpr.sizeMode = Sprite.SizeMode.CUSTOM;
                bgSpr.type     = Sprite.Type.SIMPLE;
                if (this.itemStarSlot) bgSpr.spriteFrame = this.itemStarSlot;
                // Filled overlay (toggled per tier).
                const fill = this.makeNode(`StarFill_${i}_${s}`, slot, sx, STAR_ROW_Y, STAR_SIZE, STAR_SIZE);
                const fillSpr = fill.addComponent(Sprite);
                fillSpr.sizeMode = Sprite.SizeMode.CUSTOM;
                fillSpr.type     = Sprite.Type.SIMPLE;
                if (this.itemStarFilled) fillSpr.spriteFrame = this.itemStarFilled;
                fill.active = false;
                slotFills.push(fillSpr);
            }
            this.pickerSlotStarFills.push(slotFills);

            // Name
            const nameLab = this.makeLabel(`Name_${i}`, slot, 0, -40, '—', 26, [0.5, 0.5]);
            nameLab.color = new Color(255, 245, 215, 255);

            // Description (smaller, dimmer, wraps across the slot width).
            const descLab = this.makeLabel(`Desc_${i}`, slot, 0, -100, '', 16, [0.5, 0.5]);
            descLab.color = new Color(192, 200, 232, 240);
            const descTx = descLab.node.getComponent(UITransform)!;
            descTx.setContentSize(SLOT_W - 30, 90);
            descLab.overflow = Label.Overflow.RESIZE_HEIGHT;
            descLab.enableWrapText = true;
            descLab.horizontalAlign = Label.HorizontalAlign.CENTER;

            // Tap to pick
            slot.addComponent(Button);
            slot.on(Button.EventType.CLICK, () => this.onSlotClicked(i), this);

            this.pickerSlotNodes.push(slot);
            this.pickerSlotGfx.push(slotGfx);
            this.pickerSlotGlyphs.push(glyphLab);
            this.pickerSlotNames.push(nameLab);
            this.pickerSlotDescs.push(descLab);
            this.pickerSlotBadges.push(badgeLab);
            // Stash the badge bg Graphics on the slot node so repaint can
            // reach it without another field array.
            (slot as any).__badgeGfx = badgeGfx;
            (slot as any).__badgeBgNode = badgeBgNode;
        }

        // Refresh button below the slots
        const REFRESH_Y = -260;
        const REFRESH_W = 280, REFRESH_H = 70;
        const refresh = this.makeNode('Refresh', overlay, 0, REFRESH_Y, REFRESH_W, REFRESH_H);
        const refGfx = refresh.addComponent(Graphics);
        refGfx.fillColor = new Color(110, 80, 160, 240);
        refGfx.roundRect(-REFRESH_W / 2, -REFRESH_H / 2, REFRESH_W, REFRESH_H, 16);
        refGfx.fill();
        refGfx.strokeColor = new Color(200, 180, 255, 240);
        refGfx.lineWidth = 2;
        refGfx.roundRect(-REFRESH_W / 2, -REFRESH_H / 2, REFRESH_W, REFRESH_H, 16);
        refGfx.stroke();
        this.refreshBtnLabel = this.makeLabel('RefreshTxt', refresh, 0, 0, t('picker.refresh'), 26, [0.5, 0.5]);
        refresh.addComponent(Button);
        refresh.on(Button.EventType.CLICK, () => this.onRefreshClicked(), this);
    }

    /** Repaint a single slot's background + border with the given rarity
     *  palette. Called from `buildPicker` (initial setup) and from
     *  `showPicker` (per draw, since each pick rolls fresh rarities). */
    private repaintSlotBg(gfx: Graphics, w: number, h: number, style: RarityColors): void {
        gfx.clear();
        gfx.fillColor = rgbaToColor(style.bg);
        gfx.roundRect(-w / 2, -h / 2, w, h, 18);
        gfx.fill();
        gfx.strokeColor = rgbaToColor(style.border);
        gfx.lineWidth = 4;
        gfx.roundRect(-w / 2, -h / 2, w, h, 18);
        gfx.stroke();
    }

    private showPicker(choices: MagicItemKey[]): void {
        console.log('[Picker] showPicker called with choices =', choices);
        // ---- Modal mutex ----
        // FateModal and EnergyPicker are independent root-level overlays
        // at the same z position. On editor preview the open-order naturally
        // serialised them (fate closes first, then picker opens), but on
        // Android the frame timing differs and both could end up active=true
        // at once — visually the two titles + buttons overlap. Force
        // exclusion: closing the other modal before showing ours.
        if (this.fateOverlay && this.fateOverlay.active) {
            console.warn('[Picker] fate modal still active — closing it first to avoid overlap');
            this.hideFateModal();
        }
        // Authored (Sprite-based) path — preferred; the legacy Graphics
        // path below is kept for scenes that haven't been rewired yet.
        if (this.authoredEnergyPicker) {
            this.showAuthoredPicker(choices);
            return;
        }
        if (!this.pickerOverlay) {
            console.log('[Picker] pickerOverlay is null, aborting');
            return;
        }
        this.pickerOverlay.active = true;
        // Slot dimensions must match buildPicker (kept as constants).
        const SLOT_W = 270, SLOT_H = 340;
        // Populate slots — glyph / name / desc + rarity-driven colours.
        for (let i = 0; i < this.pickerSlotNodes.length; i++) {
            const key = choices[i] ?? null;
            this.pickerSlotKeys[i] = key;
            console.log(`[Picker] slot ${i} key=${key} glyph=${key ? ITEM_GLYPHS[key] : '(none)'} label=${key ? itemLabel(key) : '(none)'}`);
            const slotNode = this.pickerSlotNodes[i];
            const badgeBgNode = (slotNode as any).__badgeBgNode as Node | undefined;
            const badgeGfx    = (slotNode as any).__badgeGfx    as Graphics | undefined;
            if (key) {
                const rarity = rarityForKey(key);
                const style  = RARITY_STYLES[rarity];
                // Slot bg + border
                this.repaintSlotBg(this.pickerSlotGfx[i], SLOT_W, SLOT_H, style);
                // Badge pill bg + label colour
                if (badgeGfx) {
                    badgeGfx.clear();
                    badgeGfx.fillColor = rgbaToColor(style.badgeBg);
                    badgeGfx.roundRect(-55, -15, 110, 30, 15);
                    badgeGfx.fill();
                }
                if (badgeBgNode) badgeBgNode.active = true;
                this.pickerSlotBadges[i].string = rarityLabel(rarity);
                this.pickerSlotBadges[i].color  = rgbaToColor(style.badgeText);
                // Item content — emoji Label glyph (fallback) + new
                // PNG icon Sprite + tier star fills.
                this._applyPickerGlyph(this.pickerSlotGlyphs[i], ITEM_GLYPHS[key] ?? '?');
                this._applyPickerIcon(i, key);
                this.pickerSlotNames[i].string  = '';   // name removed per request
                this.pickerSlotDescs[i].string  = itemDesc(key);
            } else {
                // Empty slot (shouldn't happen but defend).
                this.repaintSlotBg(this.pickerSlotGfx[i], SLOT_W, SLOT_H, RARITY_STYLES.common);
                if (badgeBgNode) badgeBgNode.active = false;
                this.pickerSlotGlyphs[i].string = '—';
                this.pickerSlotNames[i].string  = '—';
                this.pickerSlotDescs[i].string  = '';
                // Hide the icon Sprite + all tier stars for empty slots.
                if (this.pickerSlotIcons[i]) this.pickerSlotIcons[i].node.active = false;
                const fills = this.pickerSlotStarFills[i];
                if (fills) for (const f of fills) f.node.active = false;
            }
        }
        this.updateRefreshButtonLabel();
    }

    /** Inject icon Sprite + 3-star tier row as children of `slotNode`
     *  and register them into pickerSlotIcons / pickerSlotStarFills at
     *  slot index `i` so `_applyPickerIcon(i, key)` works uniformly for
     *  both authored and programmatic picker paths. Idempotent —
     *  guarded by array length checks. */
    private _injectPickerIconAndStars(slotNode: Node, i: number): void {
        // Grow arrays sparsely so slot index `i` has a stable position.
        while (this.pickerSlotIcons.length      <= i) (this.pickerSlotIcons as any).push(undefined);
        while (this.pickerSlotStarFills.length  <= i) (this.pickerSlotStarFills as any).push(undefined);
        if (this.pickerSlotIcons[i] && this.pickerSlotStarFills[i]) return;

        // Helper to build a properly-sized sprite child. `makeNode` uses
        // `contentSize.set()` which doesn't trigger the internal render
        // update for CUSTOM-mode Sprites — so we call setContentSize
        // explicitly here to guarantee the quad has a visible extent.
        const spawnSprite = (name: string, x: number, y: number, w: number, h: number): { node: Node; spr: Sprite } => {
            const node = new Node(name);
            node.parent = slotNode;
            node.layer  = slotNode.layer;
            const tx = node.addComponent(UITransform);
            tx.setContentSize(w, h);
            tx.setAnchorPoint(0.5, 0.5);
            node.setPosition(x, y, 0);
            const spr = node.addComponent(Sprite);
            spr.type     = Sprite.Type.SIMPLE;
            spr.sizeMode = Sprite.SizeMode.CUSTOM;
            return { node, spr };
        };

        // Icon Sprite — upper half of the slot. TRIMMED sizeMode uses
        // the SpriteFrame's natural (trimmed) size so we don't need
        // to fight the PNG's own dimensions; controlled position only.
        const { node: iconNode, spr: iconSpr } = spawnSprite(`AuthoredIcon_${i}`, 0, 40, 130, 130);
        iconSpr.sizeMode = Sprite.SizeMode.TRIMMED;
        iconNode.active = false;
        this.pickerSlotIcons[i] = iconSpr;

        // Tier stars — 3 star slots + 3 fills, positioned below the icon.
        const STAR_SIZE  = 32;
        const STAR_GAP   = 6;
        const STAR_ROW_Y = -62.92;
        const totalW = STAR_SIZE * 3 + STAR_GAP * 2;
        const startX = -totalW / 2 + STAR_SIZE / 2;
        const fills: Sprite[] = [];
        for (let s = 0; s < 3; s++) {
            const sx = startX + s * (STAR_SIZE + STAR_GAP);
            // Empty slot bg (always shown when a key is set).
            const bg = spawnSprite(`AuthoredStarSlot_${i}_${s}`, sx, STAR_ROW_Y, STAR_SIZE, STAR_SIZE);
            if (this.itemStarSlot) bg.spr.spriteFrame = this.itemStarSlot;
            // Fill overlay (toggled by tier).
            const fill = spawnSprite(`AuthoredStarFill_${i}_${s}`, sx, STAR_ROW_Y, STAR_SIZE, STAR_SIZE);
            if (this.itemStarFilled) fill.spr.spriteFrame = this.itemStarFilled;
            fill.node.active = false;
            fills.push(fill.spr);
        }
        this.pickerSlotStarFills[i] = fills;
        // Diagnostic: dump what actually got created so we can see if
        // parent chain / active / positioning is what we expect.
        const iconTx = iconNode.getComponent(UITransform);
        console.log(
            `[Picker/inject] slot ${i}: parent=${slotNode.name} (active=${slotNode.activeInHierarchy}, `
            + `layer=${slotNode.layer}, `
            + `children=${slotNode.children.length}) icon pos=(${iconNode.position.x.toFixed(1)},${iconNode.position.y.toFixed(1)}) `
            + `size=(${iconTx?.contentSize.width},${iconTx?.contentSize.height}) `
            + `iconLayer=${iconNode.layer} iconActive=${iconNode.active}`
        );
    }

    /** Map a MagicItemKey to its base PNG icon SpriteFrame. Returns
     *  null if the SpriteFrame @property for that family isn't wired
     *  — caller falls back to the emoji Label glyph. */
    private _iconForKey(key: MagicItemKey): SpriteFrame | null {
        if (key.startsWith('hourglass'))     return this.itemIconHourglass;
        if (key.startsWith('excavatorTop'))  return this.itemIconExcavatorTop;
        if (key.startsWith('excavator'))     return this.itemIconExcavator;
        if (key === 'shapeshifter')          return this.itemIconShapeshifter;
        if (key === 'rewind')                return this.itemIconRewind;
        if (key.startsWith('meteor'))        return this.itemIconMeteor;
        if (key.startsWith('rocket'))        return this.itemIconRocket;
        if (key.startsWith('gatling'))       return this.itemIconGatling;
        if (key.startsWith('mortar'))        return this.itemIconMortar;
        return null;
    }

    /** Return the tier (1-3) for a MagicItemKey. Items with numeric
     *  suffix use that; mortar uses 5/10/15 → 1/2/3; single-tier items
     *  (shapeshifter, rewind) return 1. */
    private _tierForKey(key: MagicItemKey): number {
        if (key === 'shapeshifter' || key === 'rewind') return 1;
        if (key === 'mortar5')  return 1;
        if (key === 'mortar10') return 2;
        if (key === 'mortar15') return 3;
        if (key.endsWith('3')) return 3;
        if (key.endsWith('2')) return 2;
        if (key.endsWith('1')) return 1;
        return 1;
    }

    /** Apply a MagicItemKey to slot `idx`: icon Sprite frame + tier
     *  star fills + fallback emoji glyph visibility. Hides BOTH the
     *  programmatic glyph label AND the authored one so the icon
     *  renders alone (authored path was previously leaving the emoji
     *  Label on top of the injected Sprite → looked unchanged). */
    private _applyPickerIcon(idx: number, key: MagicItemKey): void {
        const iconSpr = this.pickerSlotIcons[idx];
        const glyphLabProg  = this.pickerSlotGlyphs[idx];
        const glyphLabAuth  = this.authoredPickerSlotGlyphLabels[idx];
        const frame = this._iconForKey(key);
        if (iconSpr && frame) {
            iconSpr.spriteFrame = frame;
            iconSpr.node.active = true;
            iconSpr.node.setSiblingIndex(9999);   // render on top of sibling labels
            // Shrink icon visually to 0.8× of the SpriteFrame's natural
            // size — TRIMMED sizeMode locks contentSize to the frame,
            // so setScale is the cheapest way to resize without
            // touching per-icon UITransform math.
            iconSpr.node.setScale(0.8, 0.8, 1);
            const iTx = iconSpr.node.getComponent(UITransform);
            console.log(`[Picker/apply] slot ${idx} key=${key}: iconActive=${iconSpr.node.activeInHierarchy} `
                + `pos=(${iconSpr.node.position.x},${iconSpr.node.position.y}) `
                + `size=(${iTx?.contentSize.width},${iTx?.contentSize.height}) `
                + `frame=${iconSpr.spriteFrame?.name ?? 'NULL'} `
                + `parent=${iconSpr.node.parent?.name}`);
            // Hide BOTH emoji fallbacks so nothing renders behind/over
            // the icon (icon PNGs typically have transparent backgrounds).
            if (glyphLabProg) glyphLabProg.node.active = false;
            if (glyphLabAuth) glyphLabAuth.node.active = false;
        } else {
            // No icon wired → fall back to the emoji Label glyph.
            if (iconSpr) iconSpr.node.active = false;
            if (glyphLabProg) glyphLabProg.node.active = true;
            if (glyphLabAuth) glyphLabAuth.node.active = true;
        }
        // Tier stars: fill the first `tier` slots, hide the rest.
        const tier = this._tierForKey(key);
        const fills = this.pickerSlotStarFills[idx];
        if (fills) {
            for (let s = 0; s < fills.length; s++) {
                fills[s].node.active = s < tier;
            }
        }
    }

    /** Set the picker-slot glyph string and auto-shrink the font when
     *  the text has multiple lines (excavator variants are ↓/↑ + N
     *  horizontal bars stacked vertically; a full 90pt fontSize per
     *  line would overflow the slot). Base size 90pt for single-line
     *  emoji glyphs, scaled down proportionally by line count so the
     *  total visual height stays roughly the same regardless of tier. */
    private _applyPickerGlyph(label: Label, glyph: string): void {
        label.string = glyph;
        const lines = glyph.split('\n').length;
        // Line spacing 1.05 = tight so bars visually connect. Base
        // fontSize 90; halve at 2 lines, third at 3 lines, quarter at
        // 4 lines — keeps total height ≤ single-emoji glyph.
        let fs: number;
        if (lines <= 1)      fs = 90;
        else if (lines === 2) fs = 56;
        else if (lines === 3) fs = 42;
        else                  fs = 34;   // 4+ lines
        label.fontSize = fs;
        label.lineHeight = Math.round(fs * 1.05);
    }

    private hidePicker(): void {
        if (this.authoredEnergyPicker) {
            this.authoredEnergyPicker.active = false;
        }
        if (this.pickerOverlay) {
            this.pickerOverlay.active = false;
        }
    }

    /** Fallback max free picker refreshes shown when the server hasn't
     *  reported a real number yet (fresh boot / offline). Must match
     *  the "/3" denominator in the picker.refresh i18n string. */
    private static readonly DEFAULT_FREE_REFRESHES = 3;

    private updateRefreshButtonLabel(): void {
        // Read the server-authoritative daily-free counter from
        // PlayerProfile. null = server hasn't reported yet — show the
        // optimistic default (3); the atomic consume call on click
        // will correct it if the server disagrees.
        const serverRemaining = PlayerProfile.dailyFreeRemaining('magic');
        const remaining = (typeof serverRemaining === 'number')
            ? serverRemaining
            : HudController.DEFAULT_FREE_REFRESHES;
        const txt = remaining > 0
            ? t('picker.refresh',   { n: remaining })
            : t('picker.adRefresh');
        if (this.authoredPickerRefreshLabel) this.authoredPickerRefreshLabel.string = txt;
        if (this.refreshBtnLabel) this.refreshBtnLabel.string = txt;
    }

    /** Sibling of updateRefreshButtonLabel — repaints the Fate modal's
     *  "逆天改命" button. Reads the server's remaining fate-reroll count
     *  from PlayerProfile and picks the i18n string:
     *    remaining > 0  → t('fate.reroll',    { n: remaining })  e.g. "逆天改命 (2/3)"
     *    remaining == 0 → t('fate.reroll.ad')                    e.g. "🎬 看广告改命"
     *  Called on wire, on showFateModal open, after each successful
     *  free reroll consume (which decrements remaining), and on
     *  language change. Idempotent — silent no-op if the label isn't
     *  wired / can't be found. */
    private updateFateRerollButtonLabel(): void {
        if (!this.authoredFateRerollLabel) return;
        const serverRemaining = PlayerProfile.dailyFreeRemaining('fate');
        // Same optimistic-default fallback as the picker: null (server
        // hasn't reported yet — fresh boot / offline) shows the max
        // count so the button reads "逆天改命 (3/3)" rather than a
        // placeholder. Atomic consume corrects it if the server
        // disagrees.
        const remaining = (typeof serverRemaining === 'number')
            ? serverRemaining
            : HudController.DEFAULT_FREE_REFRESHES;
        this.authoredFateRerollLabel.string = remaining > 0
            ? t('fate.reroll',    { n: remaining })
            : t('fate.reroll.ad');
    }

    /** Free reroll click handler — server-authoritative atomic
     *  check-and-decrement via POST /player/daily-free/consume, mirrors
     *  onRefreshClicked for the magic picker.
     *   - 200 → grant the local reroll (onFateReroll) + repaint label
     *           with the new remaining count
     *   - 429 → daily quota exhausted; force the cached count to 0 so
     *           the label flips to the ad-watch state. Ad-watch flow
     *           itself is TODO — for now the button stops working until
     *           tomorrow's server reset (paid refresh button still
     *           functions independently).
     *  Network/other errors log without changing UI state so a flaky
     *  connection doesn't burn the daily count. */
    private onFateFreeRerollClicked(): void {
        // Two-stage flow mirroring the magic picker's onRefreshClicked:
        //   1. Try consumeDailyFree('fate') — atomic server-side
        //      check-and-decrement. 200 → grant reroll.
        //   2. On quota exhausted (ok=false, remaining=0) fall through
        //      to Providers.ads.showRewardedAd(). Rewarded → grant reroll;
        //      dismissed / error → no-op (or toast on error).
        // MockAdProvider (non-channel builds) resolves 'rewarded'
        // instantly so the flow exercises end-to-end in Preview;
        // LevelPlayProvider (channel/onestore) shows a real ad.
        void (async () => {
            let free: { ok: boolean; remaining: number } | null = null;
            try {
                free = await consumeDailyFree('fate');
            } catch (err) {
                // Non-429 error (network / 5xx) — DailyFreeApi rethrows
                // those. Skip both branches so a flaky network doesn't
                // burn an ad on a transient hiccup.
                console.warn('[FateModal] daily-free consume failed:', String((err as any)?.message ?? err));
                return;
            }
            // Server swallows 429 into { ok: false, remaining: 0 }.
            if (free.ok) {
                PlayerProfile.setDailyFreeRemaining('fate', free.remaining);
                this.onFateReroll();
                this.updateFateRerollButtonLabel();
                return;
            }
            // Quota exhausted → repaint label to ad-watch state, then
            // attempt the rewarded ad.
            PlayerProfile.setDailyFreeRemaining('fate', 0);
            this.updateFateRerollButtonLabel();
            try {
                AnalyticsApi.logCustom('ad_shown', { placement: 'fate_reroll' });
                const r = await Providers.ads.showRewardedAd();
                if (r.kind === 'rewarded') {
                    // Firebase `earn_virtual_currency` — populates the
                    // virtual-economy report. `value` here is 1 because
                    // the "currency" earned is a single reroll ticket,
                    // not gems.
                    AnalyticsApi.logAdReward({
                        virtualCurrencyName: 'fate_reroll',
                        value:               1,
                        placement:           'fate_reroll',
                    });
                    this.onFateReroll();
                    this.updateFateRerollButtonLabel();
                    return;
                }
                if (r.kind === 'dismissed') {
                    console.log('[FateModal] ad dismissed early — no reroll');
                    AnalyticsApi.logCustom('ad_dismissed', { placement: 'fate_reroll' });
                    return;
                }
                console.warn('[FateModal] ad error:', r.reason);
                AnalyticsApi.logCustom('ad_error', {
                    placement: 'fate_reroll',
                    reason: String(r.reason ?? 'unknown'),
                });
                ToastManager.instance?.show(t('picker.adRefresh.failed'));
            } catch (e) {
                console.warn('[FateModal] showRewardedAd threw:', (e as Error)?.message ?? e);
                ToastManager.instance?.show(t('picker.adRefresh.failed'));
            }
        })();
    }

    // ---- Authored (Sprite-based) picker path ----
    private _pickerAuthoredWired: boolean = false;
    /** Cached keys for the 2 authored slots — used by onSlotClicked (which
     *  reads pickerSlotKeys). Same array as the legacy path (both fill it),
     *  so slot-click routing already works without duplicating fields. */
    private wireAuthoredPicker(): void {
        // Deliberately NOT guarded by _pickerAuthoredWired anymore: a
        // scene-merge or lazy @property load could leave some buttons
        // null on the first call, and the old guard would mark the
        // whole picker "wired" and never retry — silent-dead buttons.
        // Re-wiring every open is cheap (each `.on('click')` is
        // preceded by `.off('click')` so no duplicate handlers stack).
        // The picker only opens once per row-lock at most; the extra
        // work is a handful of listener swaps.
        //
        // Slot buttons + inject icon/star children lazily on first show.
        // The scene has authored bg + labels but no PNG icon or tier stars
        // — we build those at runtime so no editor rewiring is needed.
        for (let i = 0; i < this.authoredPickerSlotButtons.length; i++) {
            const btn = this.authoredPickerSlotButtons[i];
            if (!btn?.node) {
                if (btn) console.warn(`[Picker] slot ${i} button has no node — skipping`);
                continue;
            }
            btn.node.off('click');
            btn.node.on('click', () => this.onSlotClicked(i), this);
            // Icon/stars injection is one-shot per node — the helper
            // no-ops when the child nodes already exist, so it's safe
            // to call every wire pass.
            this._injectPickerIconAndStars(btn.node, i);
        }
        // Refresh button. Guarded by ?. because after a scene merge the
        // @property may hold a Button whose underlying node has been
        // torn down — accessing `.node.off` in that state throws
        // "Cannot read properties of undefined (reading 'off')".
        const rb = this.authoredPickerRefreshButton;
        if (rb?.node) {
            rb.node.off('click');
            rb.node.on('click', () => this.onRefreshClicked(), this);
        } else if (rb) {
            console.warn('[Picker] authoredPickerRefreshButton has no node — skipping wire');
        }
        // Paid refresh (spend gems). Cost fetched from server on every
        // picker-open (see `refreshPickerPaidCost`).
        const pb = this.authoredPickerPaidRefreshButton;
        if (pb?.node) {
            pb.node.off('click');
            pb.node.on('click', () => this.onPickerPaidRefreshClicked(), this);
        } else if (pb) {
            console.warn('[Picker] authoredPickerPaidRefreshButton has no node — skipping wire');
        } else {
            // pb is null — @property not wired in the scene, so there
            // is NO gem-refresh button to click. Loud once so the
            // scene issue surfaces in logs rather than presenting as
            // "click does nothing" mystery bug.
            console.warn('[Picker] authoredPickerPaidRefreshButton @property is null — gem-refresh will not work; check scene wiring on EnergyPicker root');
        }
        this._pickerAuthoredWired = true;
    }

    private showAuthoredPicker(choices: MagicItemKey[]): void {
        const overlay = this.authoredEnergyPicker;
        if (!overlay) return;
        this.wireAuthoredPicker();
        console.log(`[Picker] showAuthoredPicker: slot buttons wired=${this.authoredPickerSlotButtons.length}, `
            + `icons registered=${this.pickerSlotIcons.filter(x => !!x).length}, `
            + `itemIconHourglass wired=${!!this.itemIconHourglass}, `
            + `itemStarSlot wired=${!!this.itemStarSlot}, `
            + `itemStarFilled wired=${!!this.itemStarFilled}`);
        // Paint the paid-refresh button label from local tier state
        // (no server round-trip needed). Counter reset happens ONLY on
        // a fresh session open (see wireGameStateHooks.onEnergyPickerOpen),
        // NOT here — showAuthoredPicker also fires on every refresh,
        // and resetting here would defeat the 10 → 15 → 20 escalation.
        this.refreshPaidRefreshLabel('magic');
        // Static labels.
        if (this.authoredPickerTitleLabel)    this.authoredPickerTitleLabel.string    = t('picker.title');
        if (this.authoredPickerSubtitleLabel) this.authoredPickerSubtitleLabel.string = t('picker.hint');
        // Per-slot content.
        const slotCount = Math.min(this.authoredPickerSlotButtons.length, 2);
        for (let i = 0; i < slotCount; i++) {
            const key = choices[i] ?? null;
            this.pickerSlotKeys[i] = key;
            const btn      = this.authoredPickerSlotButtons[i];
            const bg       = this.authoredPickerSlotBackgrounds[i];
            const badgeBg  = this.authoredPickerSlotBadgeBackgrounds[i];
            const badgeLab = this.authoredPickerSlotBadgeLabels[i];
            const glyphLab = this.authoredPickerSlotGlyphLabels[i];
            const nameLab  = this.authoredPickerSlotNameLabels[i];
            const descLab  = this.authoredPickerSlotDescLabels[i];
            if (!key) {
                // Empty slot — hide the whole button (shouldn't happen).
                if (btn) btn.node.active = false;
                continue;
            }
            if (btn) btn.node.active = true;
            const rarity = rarityForKey(key);
            const style  = RARITY_STYLES[rarity];
            // Tint sprites by rarity. Sprite.color multiplies with the
            // sprite frame, so this works best with a white / near-white
            // authored SpriteFrame.
            if (bg)      bg.color      = rgbaToColor(style.bg);
            if (badgeBg) badgeBg.color = rgbaToColor(style.badgeBg);
            if (badgeLab) {
                badgeLab.string = rarityLabel(rarity);
                badgeLab.color  = rgbaToColor(style.badgeText);
            }
            if (glyphLab) this._applyPickerGlyph(glyphLab, ITEM_GLYPHS[key] ?? '?');
            // PNG icon + tier stars (injected as children in wireAuthoredPicker).
            this._applyPickerIcon(i, key);
            // Name label removed per request — clear + hide so any
            // authored NameLabel node stays invisible without needing
            // scene-level deletion.
            if (nameLab) {
                nameLab.string = '';
                nameLab.node.active = false;
            }
            if (descLab) {
                descLab.string = itemDesc(key);
                // Honor whatever overflow mode the scene author set
                // (typically SHRINK so text auto-scales to fit the
                // fixed slot box). Previously we hard-forced
                // RESIZE_HEIGHT which overrode the author's choice
                // every open — removed.
            }
        }
        this.updateRefreshButtonLabel();
        ensureDimBackdrop(overlay);
        overlay.setSiblingIndex(999);
        overlay.active = true;
    }

    private onSlotClicked(idx: number): void {
        console.log(`[Picker] slot ${idx} clicked, key=${this.pickerSlotKeys[idx]}`);
        // Guard against click-through from the InsufficientGems modal.
        // Repro: paid-refresh → server 402 → insufficient-gems panel
        // pops up on top of the picker → user taps the panel's
        // "recharge" or "cancel" button → the same tap sometimes leaks
        // to a slot behind (rendering order / sibling-parent quirks in
        // the authored scene). Defense in depth on top of the modal's
        // own Dim + BlockInputEvents.
        if (this.menuController?.authoredInsufficientGemsPanel?.active) {
            console.log('[Picker] slot click swallowed — insufficient-gems modal active');
            return;
        }
        const g = this.gameController?.gameState;
        if (!g) {
            console.log('[Picker] no gameState, abort');
            return;
        }
        const key = this.pickerSlotKeys[idx];
        if (!key) {
            console.log('[Picker] key is null, abort');
            return;
        }
        // Fire the item-pick SFX on every magic-item slot tap — covers
        // countdown items (hourglass/gatling/meteor) that go through the
        // flying-number animation AND everything else (chest, excavator,
        // shapeshifter, rewind) that fires instantly.
        SoundManager.instance?.play('item_pick');
        // Hourglass / gatling / meteor get a "flying number" cinematic:
        // a temp label materialises at screen center at 3× scale, holds,
        // then flies + shrinks to the countdown's rest position. Only
        // AFTER it arrives does pickEnergyReward fire — so blocks /
        // slowdown don't kick in until the number is at rest. Everything
        // else fires instantly.
        if (this._isFlyingPickKey(key)) {
            this._flyNumberThenPick(key);
            return;
        }
        const ok = g.pickEnergyReward(key);
        console.log(`[Picker] pickEnergyReward('${key}') returned ${ok}`);
    }

    /** Item families that get the "big pop → fly to rest" preview
     *  animation before their effect actually starts. Shapeshifter is
     *  NOT in this list — its animation happens AFTER the player picks
     *  a shape from the shapeshifter modal (see onShapeshifterPick),
     *  where the chosen shape flies from screen center to the piece
     *  spawn position and then the transform actually fires. */
    private _isFlyingPickKey(key: MagicItemKey): boolean {
        return key.startsWith('hourglass')
            || key.startsWith('gatling')
            || key.startsWith('meteor');
    }

    /** Initial countdown value for a given magic-item key — matches what
     *  the real countdown widget will show on frame 1 after activation.
     *  Gatling/meteor return bullet/DOT counts; hourglass returns seconds. */
    private _initialCountFor(key: MagicItemKey): number {
        if (key === 'gatling1') return 4;
        if (key === 'gatling2') return 8;
        if (key === 'gatling3') return 12;
        if (key === 'meteor1')  return 5;
        if (key === 'meteor2')  return 10;
        if (key === 'meteor3')  return 15;
        if (key === 'hourglass1') return 60;
        if (key === 'hourglass2') return 120;
        if (key === 'hourglass3') return 180;
        return 0;
    }

    /** Pop the initial countdown number at screen center 3×, hold, then
     *  fly + shrink to the target countdown widget's rest position.
     *  Only when it arrives do we call pickEnergyReward so the item's
     *  actual effect (bullets / meteors / slowdown) starts AFTER the
     *  number lands. On landing the fake cross-fades into the real
     *  countdown widget for a seamless handoff. */
    private _flyNumberThenPick(key: MagicItemKey): void {
        const g = this.gameController?.gameState;
        if (!g) return;

        const initial = this._initialCountFor(key);
        if (initial <= 0) {
            // Unknown key — just fire immediately.
            g.pickEnergyReward(key);
            return;
        }

        // Pick which countdown widget this belongs to → grab its wrap's
        // WORLD position (parent + local) so we can convert to root
        // frame for the temp label's flight target.
        let targetWrap: Node | null = null;
        if (key.startsWith('hourglass'))     targetWrap = this.hourglassCountRoot;
        else if (key.startsWith('gatling'))  targetWrap = this.gatlingCountRoot;
        else if (key.startsWith('meteor'))   targetWrap = this.meteorCountRoot;

        const rootNode = this.node;
        const rootTx = rootNode.getComponent(UITransform);
        let restInRoot = new Vec3(0, 0, 0);
        if (targetWrap?.parent) {
            const parentTx = targetWrap.parent.getComponent(UITransform);
            if (parentTx && rootTx) {
                const worldPos = parentTx.convertToWorldSpaceAR(targetWrap.position);
                restInRoot = rootTx.convertToNodeSpaceAR(worldPos);
            }
        }

        // Suppress the real countdown widget from popping in during the
        // fly (it would otherwise appear at rest position the frame
        // pickEnergyReward fires and cause a double-number). Wrap stays
        // inactive; sync loop will re-enable it once the item fires.
        // Since we fire the pick AFTER the animation completes, the
        // countdown is naturally hidden the whole time — nothing to do.

        // Fire the pick reward via g.pickEnergyReward. We WANT the
        // picker overlay to close now (visual feedback) but delay the
        // actual effect. Trick: close the overlay manually + delay the
        // pick. But pickEnergyReward is what activates the item state,
        // and there's no way to "close overlay without activating".
        // Instead: hide the overlay ourselves, delay activation.
        // Close BOTH picker overlays (authored + programmatic) at the
        // exact frame the fake number pops at screen center so the modal
        // doesn't linger under the animation. Use the shared helper —
        // pickEnergyReward's onEnergyPickerClose hook would do this
        // eventually but we've delayed pickEnergyReward until after the
        // fly lands, so we need to close manually here.
        this.hidePicker();

        // Temp pixel-number readout — parented to HUD root at screen
        // center, starting at scale 0.
        const fly = new Node('FlyingCountdownNumber');
        fly.parent = rootNode;
        fly.layer  = rootNode.layer;
        fly.setSiblingIndex(9999);
        const flyTx = fly.addComponent(UITransform);
        flyTx.setContentSize(180, 80);
        flyTx.setAnchorPoint(0.5, 1);
        fly.setPosition(0, 0, 0);          // screen center
        fly.setScale(new Vec3(0, 0, 1));   // start invisible

        const gfxNode = new Node('FlyingCountdownGfx');
        gfxNode.parent = fly;
        gfxNode.layer  = fly.layer;
        const gfxTx = gfxNode.addComponent(UITransform);
        gfxTx.setContentSize(180, 80);
        gfxTx.setAnchorPoint(0.5, 1);
        gfxNode.setPosition(0, 0, 0);
        const gfx = gfxNode.addComponent(Graphics);
        this.paintSmallPixelNumber(gfx, initial, 12);

        // Midpoint of center → rest for the fast-slow-fast segmentation.
        const midX = restInRoot.x * 0.5;
        const midY = restInRoot.y * 0.5;

        tween(fly)
            // Stage 1: pop from 0 → 3× at screen center (fast entrance).
            .to(0.30, {
                position: new Vec3(0, 0, 0),
                scale:    new Vec3(3, 3, 1),
            }, { easing: 'backOut' })
            // HOLD: 500ms perfectly still.
            .delay(0.50)
            // Stage 2a: fast start → slow middle.
            .to(0.25, {
                position: new Vec3(midX, midY, 0),
                scale:    new Vec3(2, 2, 1),
            }, { easing: 'quadOut' })
            // Stage 2b: slow middle → fast end.
            .to(0.25, {
                position: new Vec3(restInRoot.x, restInRoot.y, 0),
                scale:    new Vec3(1, 1, 1),
            }, { easing: 'quadIn' })
            .call(() => {
                // Fire the pick — item state activates. Real countdown
                // widget will appear at rest position with the same
                // number on the next syncPickupCountdowns run.
                const ok = g.pickEnergyReward(key);
                console.log(`[Picker] flying number landed, fired '${key}' -> ${ok}`);
                if (this.gameController?.gameState) {
                    // Force one immediate sync so the real widget flips
                    // to active + paints its number THIS frame, before
                    // we start fading the fake out.
                    this.syncPickupCountdowns(this.gameController.gameState);
                }
                // Cross-fade the fake out over 150ms. Real is already
                // fully opaque underneath at the same spot → clean
                // handoff, no blank frame.
                const flyOp = fly.getComponent(UIOpacity) ?? fly.addComponent(UIOpacity);
                tween(flyOp)
                    .to(0.15, { opacity: 0 }, { easing: 'quadOut' })
                    .call(() => { if (fly.isValid) fly.destroy(); })
                    .start();
            })
            .start();
    }

    private onRefreshClicked(): void {
        const g = this.gameController?.gameState;
        if (!g) return;
        // Pre-gate on the cached remaining count so we don't refresh
        // for free when the quota is already known-exhausted. The
        // server /consume endpoint SHOULD 429 in that case but doesn't
        // on all versions — this guard is client-side belt-and-braces
        // so the "🎬 Watch Ad" label matches actual behaviour.
        // Ad-watch integration is a separate TODO — for now the click
        // is a silent noop instead of a free refresh.
        const cached = PlayerProfile.dailyFreeRemaining('magic');
        if (cached === 0) {
            console.log('[Picker] daily-free exhausted — ad-watch not wired, ignoring click');
            // TODO(rewarded-ad): call channel's ad SDK, play rewarded
            // video, on completion refreshEnergyPicker() + update label.
            return;
        }
        // Server-authoritative daily-free gate. POST /player/daily-free/consume
        // atomically checks-and-decrements — on 200 we grant the refresh
        // and update the cached remaining count; on 429 the slot is
        // exhausted for today and we log (UI can later fall back to a
        // paid or ad path).
        void (async () => {
            try {
                const r = await consumeDailyFree('magic');
                PlayerProfile.setDailyFreeRemaining('magic', r.remaining);
                g.refreshEnergyPicker();
                this.refreshesUsedThisFull++;
                this.updateRefreshButtonLabel();
            } catch (err) {
                const msg = String((err as any)?.message ?? err);
                // 429 = daily quota used up. Refresh the label so it
                // switches to the ad-watch state (remaining=0).
                if (msg.includes('HTTP 429')) {
                    PlayerProfile.setDailyFreeRemaining('magic', 0);
                    this.updateRefreshButtonLabel();
                    console.log('[Picker] daily-free exhausted — showing ad-watch label');
                    return;
                }
                console.warn('[Picker] daily-free consume failed:', msg);
            }
        })();
    }

    // ============================================================
    //  Virtual on-screen keys
    //  Left cluster (hold-to-repeat):  ◀ ▶   tower rotation
    //  Right cluster (single-tap, vertical column):
    //      ↑   top    — rotate piece counter-clockwise
    //      ↻   mid    — 变形 (rotate piece clockwise)
    //      ▼   bottom — hard drop
    //  Visible only when Settings.keysMode === 'on'.
    // ============================================================
    private virtualKeysRoot: Node | null = null;
    private settingsUnsub: (() => void) | null = null;

    // ---- i18n plumbing ----
    /** Labels registered via `trackI18nLabel` — kept in memory so a
     *  language change can re-translate every one in a single loop. */
    private i18nLabels: Array<{ label: Label; key: string; params?: Record<string, string | number> }> = [];
    /** Unsub handle for the i18n subscribe. */
    private i18nUnsub: (() => void) | null = null;
    /** Per-button repeat-interval handles (one for each hold button). */
    private holdIntervals: Map<Node, ReturnType<typeof setInterval>> = new Map();

    private buildVirtualKeys(root: Node, w: number, h: number): void {
        const container = this.makeNode('VirtualKeys', root, 0, -h / 2 + 240, w, 400);
        this.virtualKeysRoot = container;

        const BTN = 110;
        const GAP_X = 18;
        const GAP_Y = 18;
        const PAD = 40;

        // ----- Left cluster: ◀ ▶  (tower rotation, hold-to-repeat) -----
        const leftCenterX = -w / 2 + PAD + BTN + GAP_X / 2;
        this.makeHoldButton(container,
            leftCenterX - (BTN / 2 + GAP_X / 2), 0, BTN, BTN,
            '◀', new Color(70, 100, 150, 235),
            () => this.gameController?.gameState?.moveCylinder(-1));
        this.makeHoldButton(container,
            leftCenterX + (BTN / 2 + GAP_X / 2), 0, BTN, BTN,
            '▶', new Color(70, 100, 150, 235),
            () => this.gameController?.gameState?.moveCylinder(+1));

        // ----- Right cluster: vertical column [↻ / ▼] -----
        const rightX = w / 2 - PAD - BTN / 2;
        const rowH   = BTN + GAP_Y;
        // Top: 变形 (clockwise rotation — the "main" transform)
        this.makeTapButton(container, rightX, +rowH / 2, BTN, BTN,
            '↻', new Color(110, 80, 150, 235),
            () => this.gameController?.gameState?.tryRotate(1));
        // Bottom: ▼ hard drop
        this.makeTapButton(container, rightX, -rowH / 2, BTN, BTN,
            '▼', new Color(150, 80, 80, 235),
            () => this.gameController?.gameState?.hardDrop());

        // Initial visibility based on saved setting.
        container.active = getKeysMode() === 'on';

        // Live-update when the user toggles the setting in the Settings panel.
        if (this.settingsUnsub) this.settingsUnsub();
        this.settingsUnsub = subscribeSettings(() => {
            if (this.virtualKeysRoot && this.virtualKeysRoot.isValid) {
                this.virtualKeysRoot.active = getKeysMode() === 'on';
            }
        });
    }

    /** Single-tap virtual-key button — fires `onTap` once per click. */
    private makeTapButton(
        parent: Node, x: number, y: number, w: number, h: number,
        glyph: string, bgColor: Color, onTap: () => void,
    ): Node {
        const btn = this.makeVKeyBox(parent, x, y, w, h, glyph, bgColor);
        btn.addComponent(Button);
        btn.on(Button.EventType.CLICK, onTap, this);
        return btn;
    }

    /** Hold-to-repeat virtual-key button:
     *    • Fires `onFire` immediately on TOUCH_START.
     *    • Then repeats every `REPEAT_MS` while held.
     *    • Clears on TOUCH_END / TOUCH_CANCEL. */
    private makeHoldButton(
        parent: Node, x: number, y: number, w: number, h: number,
        glyph: string, bgColor: Color, onFire: () => void,
    ): Node {
        const btn = this.makeVKeyBox(parent, x, y, w, h, glyph, bgColor);
        const INITIAL_DELAY_MS = 220;   // wait before auto-repeat kicks in
        const REPEAT_MS        = 90;    // repeat interval after the initial delay

        const start = () => {
            // Fire once immediately so a quick tap still feels responsive.
            onFire();
            // Stop any prior interval (shouldn't normally happen, but defensively).
            const prev = this.holdIntervals.get(btn);
            if (prev) clearInterval(prev);
            // After INITIAL_DELAY, start the repeating fire.
            const delayHandle = setTimeout(() => {
                const iv = setInterval(() => onFire(), REPEAT_MS);
                this.holdIntervals.set(btn, iv);
            }, INITIAL_DELAY_MS);
            // Store the timeout handle in the same map (cleared on release).
            this.holdIntervals.set(btn, delayHandle as unknown as ReturnType<typeof setInterval>);
        };
        const stop = () => {
            const handle = this.holdIntervals.get(btn);
            if (handle) {
                clearInterval(handle);
                clearTimeout(handle as unknown as ReturnType<typeof setTimeout>);
                this.holdIntervals.delete(btn);
            }
        };
        btn.on(Node.EventType.TOUCH_START,  start, this);
        btn.on(Node.EventType.TOUCH_END,    stop,  this);
        btn.on(Node.EventType.TOUCH_CANCEL, stop,  this);
        return btn;
    }

    /** Shared visual: rounded box + label, no event handlers. */
    private makeVKeyBox(
        parent: Node, x: number, y: number, w: number, h: number,
        glyph: string, bgColor: Color,
    ): Node {
        const btn = new Node(`VKey_${glyph}`);
        btn.parent = parent;
        btn.layer = parent.layer;
        const tx = btn.addComponent(UITransform);
        tx.setContentSize(w, h);
        btn.setPosition(x, y, 0);
        const g = btn.addComponent(Graphics);
        g.fillColor = bgColor;
        g.roundRect(-w / 2, -h / 2, w, h, 20);
        g.fill();
        g.strokeColor = new Color(255, 255, 255, 200);
        g.lineWidth = 3;
        g.roundRect(-w / 2, -h / 2, w, h, 20);
        g.stroke();
        this.makeLabel('Glyph', btn, 0, 0, glyph, 56, [0.5, 0.5]);
        return btn;
    }

    private makeNode(name: string, parent: Node, x: number, y: number, w: number, h: number): Node {
        const n = new Node(name);
        n.parent = parent;
        n.layer = parent.layer;
        const tx = n.addComponent(UITransform);
        tx.contentSize.set(w, h);
        n.setPosition(x, y, 0);
        return n;
    }

    // ============================================================
    //  本命方块 entry modal
    // ============================================================
    private buildFateModal(root: Node, w: number, h: number): void {
        // Fate modal is now fully scene-authored — see wireAuthoredFateModal.
        // Args root/w/h kept for signature parity with the other builders
        // that buildUi calls.
        void root; void w; void h;
        this.wireAuthoredFateModal();
    }

    /** Wire authored fate-modal nodes: cache overlay + label refs,
     *  ensure the shape canvas has a Graphics component (added at
     *  runtime if missing), bind reroll / start button click handlers.
     *  Static backgrounds are just scene-authored Sprites so we don't
     *  touch them at all. */
    private wireAuthoredFateModal(): void {
        // Overlay root — showFateModal / showFatePreview toggle its
        // active state to display / hide the whole modal.
        if (this.authoredFateOverlay) {
            this.fateOverlay = this.authoredFateOverlay;
            this.fateOverlay.active = false;
            // Ensure a full-screen dark backdrop exists so the modal
            // blocks the gameplay / menu scene behind it. Shared helper
            // is a no-op if the user authored a Dim / FateDim / Backdrop
            // child in the scene.
            ensureDimBackdrop(this.fateOverlay);
        } else {
            log('[HudController] authoredFateOverlay not wired — fate modal will not work');
            // Fallback: dummy inactive node so downstream `.active =`
            // writes don't crash.
            const dummy = new Node('FateOverlayFallback');
            dummy.parent = this.node;
            dummy.active = false;
            this.fateOverlay = dummy;
        }
        // Labels — refreshFateSubtitle / show* write to these.
        this.fateTitleLab = this.authoredFateTitleLabel ?? this.makeDummyLabel();
        this.fateSubLab   = this.authoredFateSubtitleLabel ?? this.makeDummyLabel();
        this.fateHintLab  = this.authoredFateHintLabel ?? this.makeDummyLabel();
        // i18n on the two STATIC fate labels (title + hint). Subtitle
        // is dynamic (level tag + cell count) — refreshFateSubtitle
        // handles it via t() each time.
        if (this.authoredFateTitleLabel) {
            this.trackI18nLabel(this.authoredFateTitleLabel, 'fate.modalTitle');
        }
        if (this.authoredFateHintLabel) {
            this.trackI18nLabel(this.authoredFateHintLabel, 'fate.hint');
        }
        // Shape canvas — ensure a Graphics is on it (drawFateShape uses
        // this). If not there yet, add it at runtime.
        if (this.authoredFateShapeCanvas) {
            let gfx = this.authoredFateShapeCanvas.getComponent(Graphics);
            if (!gfx) gfx = this.authoredFateShapeCanvas.addComponent(Graphics);
            this.fateShapeGfx = gfx;
        } else {
            log('[HudController] authoredFateShapeCanvas not wired — fate shape will not render');
            const off = new Node('FateShapeGfxFallback');
            off.parent = this.node;
            off.setPosition(-9999, -9999);
            this.fateShapeGfx = off.addComponent(Graphics);
        }
        // Buttons group — preview mode hides this in one shot.
        if (this.authoredFateButtonsGroup) {
            this.fateButtonsGroup = this.authoredFateButtonsGroup;
        } else {
            // No group given — synthesize one from the buttons/hint so
            // toggling still works. Only useful for endless mode; level
            // preview mode wouldn't set it anyway.
            const dummy = new Node('FateButtonsFallback');
            dummy.parent = this.fateOverlay;
            this.fateButtonsGroup = dummy;
        }
        // Reroll / Start button click bindings + i18n on their inner
        // labels ("逆天改命" / "直接开始").
        if (this.authoredFateRerollButton) {
            this.authoredFateRerollButton.node.off('click');
            this.authoredFateRerollButton.node.on('click', () => {
                console.log('[FateModal] REROLL clicked');
                this.onFateFreeRerollClicked();
            }, this);
            // Cache the inner Label so updateFateRerollButtonLabel() has a
            // paint target without a getComponentInChildren scan every
            // repaint. Auto-fall-back if the author didn't wire the
            // dedicated @property (older scenes). NOT tracked via
            // trackI18nLabel — that helper writes a STATIC t(key) with
            // no params, which would burn the literal "{n}/3" placeholder
            // back into the label every language change. Lang refresh
            // routes through onLangChanged → updateFateRerollButtonLabel
            // so the "{n}" gets its real number.
            if (!this.authoredFateRerollLabel) {
                this.authoredFateRerollLabel =
                    this.authoredFateRerollButton.getComponentInChildren(Label);
            }
            // Initial paint so the button doesn't flash "{n}/3" between
            // scene load and the first modal open.
            this.updateFateRerollButtonLabel();
        }
        // Paid refresh (spend gems). Cost is fetched from the server
        // on every fate-modal open (see `refreshFatePaidCost`). Click
        // → POST /refresh/purchase/fate; on success re-roll + repaint.
        if (this.authoredFatePaidRefreshButton) {
            this.authoredFatePaidRefreshButton.node.off('click');
            this.authoredFatePaidRefreshButton.node.on('click',
                () => this.onFatePaidRefreshClicked(), this);
        }
        if (this.authoredFateStartButton) {
            this.authoredFateStartButton.node.off('click');
            this.authoredFateStartButton.node.on('click', () => {
                console.log('[FateModal] START clicked');
                this.onFateConfirm();
            }, this);
            const lab = this.authoredFateStartButton.getComponentInChildren(Label);
            if (lab) this.trackI18nLabel(lab, 'fate.start');
        }

        // -------- Embed-prop picker buttons (Lvl 16+ fate modal) --------
        if (this.authoredEmbedBoomButton) {
            this.authoredEmbedBoomButton.node.off('click');
            this.authoredEmbedBoomButton.node.on('click', () => {
                console.log('[FateEmbedPicker] boom1 clicked');
                this._togglePickedEmbed('boom1');
            }, this);
        }
        if (this.authoredEmbedRowBombButton) {
            this.authoredEmbedRowBombButton.node.off('click');
            this.authoredEmbedRowBombButton.node.on('click', () => {
                console.log('[FateEmbedPicker] row1 clicked');
                this._togglePickedEmbed('row1');
            }, this);
        }
        if (this.authoredEmbedWreckerButton) {
            this.authoredEmbedWreckerButton.node.off('click');
            this.authoredEmbedWreckerButton.node.on('click', () => {
                console.log('[FateEmbedPicker] wrecker clicked');
                this._togglePickedEmbed('wrecker');
            }, this);
        }
        if (this.authoredEmbedStartButton) {
            this.authoredEmbedStartButton.node.off('click');
            this.authoredEmbedStartButton.node.on('click', () => {
                if (this._embedConsuming) return;   // debounce double-tap during network round-trip
                const picked = this._embedPicked;
                console.log(`[FateEmbedPicker] START clicked, picked=${picked ?? 'none'}`);
                if (!picked) {
                    // No item to consume — resolve immediately.
                    this._resolveEmbedAndClose(null);
                    return;
                }
                // Debit server-side FIRST — client-side embed injection
                // must only fire after the server confirms the debit.
                this._embedConsuming = true;
                if (this.authoredEmbedStartButton) this.authoredEmbedStartButton.interactable = false;
                consumeBackpackItem(picked).then((r) => {
                    console.log(`[FateEmbedPicker] consume OK ${picked} → remaining ${r.count}`);
                    this._playPickToCenterFx(picked, () => this._resolveEmbedAndClose(picked));
                }).catch((err) => {
                    console.warn(`[FateEmbedPicker] consume failed for ${picked}:`, err);
                    this._embedConsuming = false;
                    if (this.authoredEmbedStartButton) this.authoredEmbedStartButton.interactable = true;
                    // Refetch server truth so the label updates (probably
                    // 0 now if it was a not-enough error). Selection clears
                    // in _paintEmbedCounts if the count fell to 0.
                    fetchBackpack().then((res) => {
                        if (this._fateEmbedModeActive) this._paintEmbedCounts(res.items);
                    }).catch(() => { /* stay on cached */ });
                });
            }, this);
            const lab = this.authoredEmbedStartLabel
                     ?? this.authoredEmbedStartButton.getComponentInChildren(Label);
            if (lab) this.trackI18nLabel(lab, 'fate.start');
        }
        // Picker hint label — track for i18n so it updates when the
        // player changes UI language mid-game.
        if (this.authoredEmbedHintLabel) {
            this.trackI18nLabel(this.authoredEmbedHintLabel, 'fate.embedPick.hint');
        }
    }


    /** Render the current fate shape onto the preview Graphics. */
    /** Paint the queued NEXT piece into the HUD's mini-canvas as a
     *  FLAT 2D shape — just colored squares with a thin outline, no
     *  shading. */
    private paintNextPreview(type: PieceType, customShape: number[][] | null): void {
        const g = this.nextPreviewGfx;
        if (!g) {
            console.warn('[HUD NEXT] paintNextPreview called but nextPreviewGfx is null');
            return;
        }
        if (!this._nextPaintLogged) {
            this._nextPaintLogged = true;
            const worldPos = g.node.worldPosition;
            console.log('[HUD NEXT] first paint — type=', type,
                        'gfx node=', g.node.name,
                        'worldPos=', `(${worldPos.x.toFixed(0)},${worldPos.y.toFixed(0)},${worldPos.z.toFixed(0)})`,
                        'parent active chain=', this.isNodeChainActive(g.node));
        }
        g.clear();
        // Also wipe any Sprite tile children spawned by a previous paint
        // (the small-block art path spawns one Node per filled cell).
        const gNode = g.node;
        for (let i = gNode.children.length - 1; i >= 0; i--) {
            const child = gNode.children[i];
            if (child.name.startsWith('NextTile_')) child.destroy();
        }
        const shape = customShape ?? SHAPES[type];
        if (!shape || !shape.length) return;
        // Find filled-cell bbox so we can centre the piece in the canvas.
        const h = shape.length;
        // Use MAX row width, not row[0]'s — FATE_SHAPES contains ragged
        // shapes like `[[1,1,1],[0,0,0,1]]` where row[0].length would
        // clip filled cells in later, wider rows. This was the "level
        // 28 fate piece显示不全" bug — the piece's rightmost cell sat
        // outside the loop's column range and never rendered.
        let w = 0;
        for (const row of shape) if (row && row.length > w) w = row.length;
        let minR = h, maxR = -1, minC = w, maxC = -1;
        for (let r = 0; r < h; r++) {
            const row = shape[r];
            if (!row) continue;
            for (let c = 0; c < row.length; c++) {
                if (row[c]) {
                    if (r < minR) minR = r;
                    if (r > maxR) maxR = r;
                    if (c < minC) minC = c;
                    if (c > maxC) maxC = c;
                }
            }
        }
        if (maxR < 0) return;        // empty shape
        const bw = maxC - minC + 1;
        const bh = maxR - minR + 1;
        // Canvas dimensions — read from the node's UITransform so the
        // shape scales to whatever size the scene has authored the
        // preview at. Fallback constants match the historical hard-
        // coded (124, 60) so a scene without a UITransform still
        // renders sanely.
        const ut = g.node.getComponent(UITransform);
        const CANV_W = ut ? Math.max(1, ut.width)  : 124;
        const CANV_H = ut ? Math.max(1, ut.height) : 60;
        // Fixed reference bbox — same trick drawFateShape uses. Divide
        // by the ref (not the per-shape bw/bh) so every tetromino /
        // fate piece uses the SAME cell size regardless of its actual
        // dimensions. Otherwise I (4×1) and O (2×2) would render at
        // wildly different cell sizes on the same canvas — the "next
        // preview blocks look sometimes big, sometimes small" bug.
        // Smaller shapes just occupy less of the canvas.
        const REF_W = 4, REF_H = 4;
        // 1.1x bump on the computed cell size — player wanted the
        // preview tiles slightly larger than the "everything fits
        // exactly" default. 4×4 shape still fits inside the canvas
        // because REF=4 leaves a natural margin (a 4×4 shape at the
        // bumped cell size occupies REF_W * cell * 1.1 = 4.4 * cell,
        // still under CANV_W-8 for any reasonable canvas > 40 px).
        const SIZE_BUMP = 1.1;
        const cell = Math.floor(Math.min((CANV_W - 8) / REF_W, (CANV_H - 8) / REF_H) * SIZE_BUMP);
        const totalW = cell * bw, totalH = cell * bh;
        const offX = -totalW / 2;
        const offY =  totalH / 2 - cell;
        const base = this.hexToCcColor(COLORS[type as CellValue] || '#6dd5ff');
        const tileSf = this.authoredSmallBlockSprite;
        for (let r = 0; r < h; r++) {
            const row = shape[r];
            if (!row) continue;
            // Iterate up to THIS row's actual length — same ragged-shape
            // guard as the bbox scan above.
            for (let c = 0; c < row.length; c++) {
                if (!row[c]) continue;
                const x = offX + (c - minC) * cell;
                const y = offY - (r - minR) * cell;
                if (tileSf) {
                    // Preferred path: spawn a Sprite child for each filled
                    // cell using the small-block PNG, tinted per piece
                    // color. Cocos Sprite.color multiplies the texture, so
                    // a near-white base gives vivid tints; the beige base
                    // muted, still readable.
                    //
                    // TILE_SCALE oversizes the rendered sprite relative to
                    // the layout cell (positions stay on the cell grid, so
                    // adjacent tiles overlap on their transparent margins
                    // to read as one connected shape). 2 = tiles visually
                    // twice as big as the cell — per player request.
                    const TILE_SCALE = 1.05;
                    const tileSize = cell * TILE_SCALE;
                    const tile = new Node(`NextTile_${r}_${c}`);
                    tile.parent = gNode;
                    tile.layer  = gNode.layer;
                    const ttx = tile.addComponent(UITransform);
                    tile.setPosition(x + cell / 2, y + cell / 2, 0);
                    const spr = tile.addComponent(Sprite);
                    // ORDER CRITICAL: sizeMode must be CUSTOM before
                    // assigning spriteFrame, otherwise TRIMMED (the
                    // default) auto-resizes UITransform to the sprite's
                    // trimmed dimensions on assignment, wiping any
                    // contentSize we set earlier.
                    spr.type = Sprite.Type.SIMPLE;
                    spr.sizeMode = Sprite.SizeMode.CUSTOM;
                    spr.spriteFrame = tileSf;
                    spr.color = base;
                    // Re-apply contentSize AFTER spriteFrame assign so
                    // internal size updates don't undo it.
                    ttx.setContentSize(tileSize, tileSize);
                } else {
                    // Fallback: original vector rect + outline (older
                    // scenes that never wired the tile SpriteFrame).
                    // Scaled 1.5x to match the Sprite path — rectangles
                    // grow around the cell centre so the overall shape
                    // reads noticeably chunkier.
                    const SCALE = 1.05;
                    const rw = (cell - 2) * SCALE;
                    const cx = x + cell / 2, cy = y + cell / 2;
                    const rx = cx - rw / 2, ry = cy - rw / 2;
                    g.fillColor = base;
                    g.rect(rx, ry, rw, rw);
                    g.fill();
                    g.strokeColor = new Color(20, 25, 45, 230);
                    g.lineWidth = 1.5;
                    g.rect(rx, ry, rw, rw);
                    g.stroke();
                }
            }
        }
    }

    private drawFateShape(): void {
        if (!this.fateShapeGfx) return;
        // Clear the base Graphics (kept for the background — a single
        // fill draw done once at build time doesn't degrade).
        this.fateShapeGfx.clear();

        // Wipe any previously-spawned cell nodes so we don't accumulate
        // children across reroll / re-open cycles.
        const container = this.fateShapeGfx.node;
        for (let i = container.children.length - 1; i >= 0; i--) {
            const child = container.children[i];
            if (child.name.startsWith('FateCell_')) child.destroy();
        }

        // Prefer the level's authored shape (fateCurrentShape) over the
        // pool entry — see field docstring. Falls back to the pool for
        // reroll / endless-entry paths that don't set the override.
        const shape = this.fateCurrentShape ?? FATE_SHAPES[this.fateCurrentIdx];
        if (!shape || !shape.length) return;
        const h = shape.length;
        // Use MAX row length — several FATE_SHAPES entries are ragged
        // (row[0] narrower than a later row); using row[0].length would
        // silently drop cells off the right edge. Same bug fix as
        // paintNextPreview.
        let w = 0;
        for (const row of shape) if (row && row.length > w) w = row.length;
        // Preview canvas — read from the node's UITransform instead of
        // assuming 240. Scenes can size the fate-shape canvas anywhere
        // from ~180 (compact modal) to ~320 (large celebration modal);
        // the shape should scale into whatever the author set. Fall
        // back to 240 if UITransform is missing.
        const ut = this.fateShapeGfx.node.getComponent(UITransform);
        const PREV_W = ut ? Math.max(1, ut.width)  : 240;
        const PREV_H = ut ? Math.max(1, ut.height) : 240;
        // Fixed reference bbox — all fate shapes cap at 4×4. Dividing
        // by the ref (not the per-shape w/h) keeps every shape at the
        // SAME unit cell size; smaller shapes get centered with unused
        // space around them instead of blowing up their cells to fill.
        const REF_W = 4, REF_H = 4;
        const cell = Math.floor(Math.min(PREV_W / REF_W, PREV_H / REF_H));
        const totalW = cell * w, totalH = cell * h;
        const offX = -totalW / 2, offY = totalH / 2 - cell;
        const colHex = COLORS[this.fateCurrentBase as CellValue] || '#6dd5ff';
        const col = this.hexToCcColor(colHex);

        // Each filled cell = one child Node. Preferred path: Sprite with
        // the small-block PNG, tinted per piece color (matches the NEXT
        // preview). Fallback: single-fill Graphics (kept for scenes that
        // haven't wired the tile SpriteFrame yet).
        //
        // Cocos 3.8 Android APK note: the Graphics fallback intentionally
        // does ONE fill() per Graphics — multiple fills on the same
        // Graphics degraded the vertex buffer and caused the FateModal
        // to visually erode after repeated opens.
        const tileSf = this.authoredSmallBlockSprite;
        for (let r = 0; r < h; r++) {
            const row = shape[r];
            if (!row) continue;
            for (let c = 0; c < row.length; c++) {
                if (!row[c]) continue;
                const x = offX + c * cell;
                const y = offY - r * cell;
                const cellNode = new Node(`FateCell_${r}_${c}`);
                cellNode.parent = container;
                cellNode.layer  = container.layer;
                const baseSize = cell - 4;
                // TILE_SCALE oversizes the rendered tile relative to the
                // layout cell (positions stay on the cell grid; adjacent
                // tiles overlap their transparent margins so the piece
                // reads as one connected shape). 2 = tiles visually twice
                // as big — per player request.
                const TILE_SCALE = 1.05;
                const drawSize = baseSize * TILE_SCALE;
                const tx = cellNode.addComponent(UITransform);
                cellNode.setPosition(x + baseSize / 2 + 2, y + baseSize / 2 + 2, 0);
                if (tileSf) {
                    const spr = cellNode.addComponent(Sprite);
                    // ORDER CRITICAL: sizeMode=CUSTOM must precede the
                    // spriteFrame assignment; otherwise TRIMMED
                    // (default) auto-resizes UITransform to the sprite's
                    // trimmed size when the frame is set, wiping any
                    // contentSize we chose.
                    spr.type = Sprite.Type.SIMPLE;
                    spr.sizeMode = Sprite.SizeMode.CUSTOM;
                    spr.spriteFrame = tileSf;
                    spr.color = col;
                    // Re-apply contentSize AFTER spriteFrame assign so
                    // internal size updates don't undo it.
                    tx.setContentSize(drawSize, drawSize);
                } else {
                    // Fallback path — scale the drawn rect by TILE_SCALE
                    // so scenes that haven't wired the SpriteFrame still
                    // see the requested chunkier look.
                    tx.setContentSize(drawSize, drawSize);
                    const cellGfx = cellNode.addComponent(Graphics);
                    cellGfx.fillColor = col;
                    cellGfx.rect(-drawSize / 2, -drawSize / 2, drawSize, drawSize);
                    cellGfx.fill();
                }
            }
        }
    }

    private hexToCcColor(hex: string): Color {
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        return new Color(r, g, b, 255);
    }

    // ============================================================
    //  Level timer — showLevelClearTime / resetLevelTimerPosition
    // ============================================================

    /** Timing constants for the level-clear timer animation. Tweak
     *  these to change how the celebration feels; MenuController /
     *  GameController don't need to know about them.
     *
     *  Design timeline (per user spec):
     *    1. Colored blocks clear (win FX finishes)
     *    2. Gray tower scatter STARTS + level_win SFX plays + timer
     *       starts moving to center + scaling up → ALL SIMULTANEOUS
     *    3. Timer sits at center for 2 seconds (scatter has already
     *       finished during step 3 — ~0.6s scatter vs 2s hold)
     *    4. Timer DISAPPEARS (container hidden)
     *    5. Short beat so the disappearance reads as its own moment
     *    6. Fate modal pops
     *
     *  Pre-hold was removed because MenuController now calls
     *  showLevelClearTime AT the scatter-start beat itself, so the
     *  drain-fx wait already lives upstream.  */
    private static readonly LEVEL_CLEAR_MOVE_MS       = 300;   // duration of the move-to-center tween
    private static readonly LEVEL_CLEAR_CENTER_HOLD_MS = 2000; // sit at center for this long
    private static readonly LEVEL_CLEAR_POST_HIDE_MS  = 250;   // gap between timer-disappear and fate modal
    private static readonly LEVEL_CLEAR_CENTER_SCALE  = 1.5;   // font enlargement while centered
    /** Total ms from showLevelClearTime call to onComplete callback.
     *  Exported so callers that want to schedule dependent animations
     *  (fate preview modal, scatter FX) can align without hard-coding
     *  the individual pieces. */
    public static readonly LEVEL_CLEAR_TOTAL_MS =
        HudController.LEVEL_CLEAR_MOVE_MS
      + HudController.LEVEL_CLEAR_CENTER_HOLD_MS
      + HudController.LEVEL_CLEAR_POST_HIDE_MS;

    /** GameController.onLevelWin calls this with the frozen elapsed
     *  time. Sequence:
     *    t=0            : freeze value + return
     *    t=0.8s         : swap label to "通关时间：MM:SS", start move
     *                     + scale tween (300ms → center, scale 5x)
     *    t=1.1s..3.1s   : sit at center, scaled 5x
     *    t=3.1s         : fire onComplete callback (caller uses this to
     *                     defer the fate-preview modal so it appears
     *                     AFTER the celebration lands)
     *
     *  Value is FROZEN via _levelTimerFrozenMs so the per-frame paint
     *  loop stops re-reading GameState (which might tick past on a
     *  technicality). Restore happens via resetLevelTimerPosition when
     *  the next level starts. */
    /** Signature now takes WHOLE SECONDS (matches GameState.levelElapsedSec).
     *  Was previously milliseconds — audit call sites when merging. */
    public showLevelClearTime(elapsedSec: number, onComplete?: () => void): void {
        // New behaviour: no longer moves + scales the HUD timer into
        // the middle of the screen. Instead, the caller has authored a
        // dedicated celebration panel (authoredLevelClearPanel) with its
        // own "MM:SS" label (authoredLevelClearTimeLabel) inside it —
        // we just fill in the label and pop the whole panel in.
        //
        // The small HUD timer is force-hidden for the duration so it
        // doesn't compete with the panel's centered time display. We
        // still freeze _levelTimerFrozenSec so per-frame refreshHud
        // doesn't keep ticking the HUD timer text underneath.
        this._levelTimerFrozenSec = elapsedSec;
        this._levelTimerLastSec = elapsedSec;
        const mm = Math.floor(elapsedSec / 60).toString().padStart(2, '0');
        const ss = (elapsedSec % 60).toString().padStart(2, '0');

        // 1) Hide the HUD timer container immediately. refreshHud
        //    checks _levelTimerForceHidden and skips reactivating.
        if (this.authoredLevelTimerLabel) {
            const container = this.authoredLevelTimerContainer
                ?? this.authoredLevelTimerLabel.node;
            this._levelTimerForceHidden = true;
            container.active = false;
        }

        // 1b) Hide the rest of the gameplay HUD (pause button, NEXT
        //     preview, energy bar) so the celebration panel + tower
        //     scatter FX get a clean stage. Pause button is gated via
        //     _hudCelebrationHidden in refreshHud (so it can't re-show
        //     mid-celebration); NEXT preview + energy bar only have a
        //     one-shot set in setHudVisible, so we hide them directly
        //     here and restore them in resetLevelTimerPosition when
        //     the next level starts.
        this._hudCelebrationHidden = true;
        if (this.authoredNextPreviewBox) {
            this.authoredNextPreviewBox.active = false;
        }
        const energyNode = this.node.getChildByName('Energy');
        if (energyNode) energyNode.active = false;

        // 2) Fill in the celebration panel's title + "MM:SS" labels.
        //    Title is localized via t('level.congrats'). Leave the
        //    label alone if the slot is null — the artist may have
        //    baked the title into a bitmap graphic instead.
        if (this.authoredLevelClearTitleLabel && this.authoredLevelClearTitleLabel.isValid) {
            this.authoredLevelClearTitleLabel.string = t('level.congrats');
        }
        // Split-label mode: when the artist wires a separate value
        // Label, the prefix Label gets ONLY the "通关时间：" prefix
        // (so it can carry its own color / font in the scene) and the
        // value Label gets just the "MM:SS" number (different color).
        // When the value slot is null we fall back to the legacy
        // single-label full "通关时间：MM:SS" render.
        const mmss = `${mm}:${ss}`;
        if (this.authoredLevelClearTimeValueLabel && this.authoredLevelClearTimeValueLabel.isValid) {
            this.authoredLevelClearTimeValueLabel.string = mmss;
            if (this.authoredLevelClearTimeLabel && this.authoredLevelClearTimeLabel.isValid) {
                // Substituting an empty {time} strips the placeholder
                // from every language's template ('通关时间：{time}' →
                // '通关时间：', 'Clear time: {time}' → 'Clear time: '),
                // leaving the prefix + separator the artist expects.
                // trim() cleans any trailing space some templates use
                // before the placeholder.
                this.authoredLevelClearTimeLabel.string
                    = t('level.clearTime', { time: '' }).trim();
            }
        } else if (this.authoredLevelClearTimeLabel && this.authoredLevelClearTimeLabel.isValid) {
            this.authoredLevelClearTimeLabel.string = t('level.clearTime', { time: mmss });
        }

        // 3) Pop the panel in.
        //
        //   Preferred path — new author-supplied `LevelCompletePopup`
        //   (character bounce, panel slam, confetti burst, time roll,
        //   idle breathing/shine). Its `show(seconds)` returns a
        //   Promise resolved once the intro animation settles; we
        //   let it own the whole intro + idle animation window, then
        //   its own `hide()` fires when the caller's onComplete
        //   fallback runs (at LEVEL_CLEAR_MOVE_MS + CENTER_HOLD_MS).
        //
        //   Fallback — the old scale-tween on `authoredLevelClearPanel`.
        if (this.authoredLevelCompletePopup && this.authoredLevelCompletePopup.node.isValid) {
            const popup = this.authoredLevelCompletePopup;
            popup.node.active = true;
            popup.show(elapsedSec);
        } else if (this.authoredLevelClearPanel && this.authoredLevelClearPanel.isValid) {
            const sb = this.authoredLevelClearPanel;
            Tween.stopAllByTarget(sb);
            sb.active = true;
            sb.setScale(0.15, 0.15, 1);
            tween(sb)
                .to(HudController.LEVEL_CLEAR_MOVE_MS / 1000,
                    { scale: new Vec3(1, 1, 1) },
                    { easing: 'backOut' })
                .start();
        }

        console.log(`[LevelTimer] show panel — elapsedSec=${elapsedSec}`);

        // 4) At (move + center-hold) the "2s at center" is over —
        //    fade the panel out with scale 1 → 0.5 over 200ms then
        //    hide. onComplete fires POST_HIDE_MS after this so the
        //    fate modal (caller-scheduled) opens on a clean screen.
        const hideAtMs = HudController.LEVEL_CLEAR_MOVE_MS + HudController.LEVEL_CLEAR_CENTER_HOLD_MS;
        const hideHandle = setTimeout(() => {
            if (this.authoredLevelCompletePopup && this.authoredLevelCompletePopup.node.isValid) {
                const popup = this.authoredLevelCompletePopup;
                popup.hide().then(() => {
                    if (popup.node && popup.node.isValid) popup.node.active = false;
                });
            } else if (this.authoredLevelClearPanel && this.authoredLevelClearPanel.isValid) {
                const sb = this.authoredLevelClearPanel;
                Tween.stopAllByTarget(sb);
                tween(sb)
                    .to(HudController.LEVEL_CLEAR_POST_HIDE_MS / 1000,
                        { scale: new Vec3(0.5, 0.5, 1) },
                        { easing: 'quadIn' })
                    .call(() => { if (sb && sb.isValid) sb.active = false; })
                    .start();
            }
        }, hideAtMs);
        this._levelClearTimeouts.push(hideHandle);
        // onComplete fires POST_HIDE_MS after the hide — caller uses
        // this to trigger the next-level fate preview. Handle is
        // tracked so resetLevelTimerPosition can cancel it if the
        // next level starts before the animation finishes (prevents
        // stale callbacks from firing mid-fresh-level).
        if (onComplete) {
            const doneHandle = setTimeout(onComplete, HudController.LEVEL_CLEAR_TOTAL_MS);
            this._levelClearTimeouts.push(doneHandle);
        }
    }

    /** Snap the timer container back to its authored rest position +
     *  scale, un-freeze the value, cancel any pending animation
     *  timeouts AND kill any in-flight center tween. Called from
     *  GameController.startLevel on every fresh level. Idempotent —
     *  safe to call even when the timer never moved.
     *
     *  The 位置不对 bug was: a pending setTimeout scheduled by
     *  showLevelClearTime would still fire AFTER reset, kicking off a
     *  new tween that re-moved the container to (0,0). Fix: track the
     *  setTimeout handles and cancel them here. */
    public resetLevelTimerPosition(): void {
        // Cancel every pending showLevelClearTime handle so no lingering
        // callback fires after the reset. Iterate + splice to release
        // the array; we won't need the handles again.
        for (const h of this._levelClearTimeouts) clearTimeout(h);
        this._levelClearTimeouts.length = 0;

        this._levelTimerFrozenSec = null;
        this._levelTimerLastSec = -1;
        // Clear the force-hidden latch — a fresh level should let the
        // per-frame refreshHud take back over toggling visibility.
        this._levelTimerForceHidden = false;
        // Clear the celebration latch + explicitly re-show the NEXT
        // preview and energy bar. Pause button flips back on its own
        // via refreshHud's per-frame gate (which now respects
        // _hudCelebrationHidden). Energy is skipped in blind mode
        // just like setHudVisible does — no magic items there.
        this._hudCelebrationHidden = false;
        if (this._hudOn && this.authoredNextPreviewBox) {
            this.authoredNextPreviewBox.active = true;
        }
        const energyNode = this.node.getChildByName('Energy');
        if (energyNode && this._hudOn) {
            const isBlind = this.gameController?.gameState?.mode === 'blind';
            energyNode.active = !isBlind;
        }
        // Belt-and-suspenders sunburst cleanup: if the player somehow
        // triggers a new level while the celebration is still on
        // screen (e.g. rapid restart before hideAtMs fires), snap it
        // off immediately — no tween, no fade, just gone. resetting is
        // supposed to look instant.
        if (this.authoredLevelClearPanel && this.authoredLevelClearPanel.isValid) {
            Tween.stopAllByTarget(this.authoredLevelClearPanel);
            this.authoredLevelClearPanel.active = false;
        }
        if (!this.authoredLevelTimerLabel) return;
        const container = this.authoredLevelTimerContainer
            ?? this.authoredLevelTimerLabel.node;
        // Kill any in-flight tween (from the move-to-center animation)
        // — the tween writes to position/scale every frame and would
        // immediately undo the snap-back below.
        Tween.stopAllByTarget(container);
        // Only restore position/scale if we actually captured a snapshot
        // from a previous showLevelClearTime run. Fail / exit paths that
        // never trigger the win animation leave the flag false — in
        // that case the container is still at its authored position
        // and we MUST NOT overwrite it (default _levelTimerRestPos is
        // Vec3.ZERO, which would snap the container to screen center).
        if (this._levelTimerSnapshotCaptured) {
            const before = { x: container.position.x, y: container.position.y };
            // Use the (x, y, z) scalar overload — the Readonly<Vec3>
            // overload has a documented bug in some Cocos 3.x builds
            // where it partially updates the internal cached vec but
            // doesn't notify the transform system. Scalar form is
            // universally supported and always emits the
            // transform-changed signal.
            container.setPosition(this._levelTimerRestPos.x, this._levelTimerRestPos.y, this._levelTimerRestPos.z);
            container.setScale(this._levelTimerRestScale.x, this._levelTimerRestScale.y, this._levelTimerRestScale.z);
            console.log(`[LevelTimer] reset — pos ${before.x.toFixed(1)},${before.y.toFixed(1)} → ${this._levelTimerRestPos.x.toFixed(1)},${this._levelTimerRestPos.y.toFixed(1)} scale → ${this._levelTimerRestScale.x.toFixed(2)}`);
            // Clear the flag — the snapshot has been "spent". A future
            // level clear will capture a fresh one before its tween.
            this._levelTimerSnapshotCaptured = false;
        } else {
            console.log(`[LevelTimer] reset — no snapshot captured, leaving authored pos/scale alone`);
        }
    }

    /** Show the modal for a level. The caller provides callbacks: `onStart`
     *  fires with the picked CustomPieceDef when the player taps 直接开始,
     *  `onCancel` fires if the modal is dismissed without confirming. */
    public showFateModal(
        level: LevelData,
        onStart: (picked: CustomPieceDef) => void,
        onCancel?: () => void,
    ): void {
        if (!this.fateOverlay) {
            console.warn('[FateModal] fateOverlay node not built — modal cannot show');
            return;
        }
        console.log('[FateModal] showFateModal: level order=', level?.order);
        // Starting shape: if the level pre-assigns one (level mode), use
        // that as the default; otherwise (endless mode passes a level
        // stub with no customPiece) roll a random shape so each run
        // starts fresh. Player can always reroll via 逆天改命.
        const cp = level.customPiece;
        let idx = -1;
        if (cp && Array.isArray(cp.shape)) idx = fateIndexOfShape(cp.shape);
        // Two paths to a preview shape:
        //   1. Level provided a custom shape → use IT as the source of
        //      truth. fateCurrentIdx tracks a pool index for the reroll
        //      button's "avoid" arg; fateCurrentShape holds the actual
        //      shape used for render + confirm, whether or not idx
        //      found a match. This is the fix for 6-cell shapes and
        //      hand-authored shapes fateIndexOfShape doesn't canonicalise
        //      — previously we discarded cp.shape and rolled random.
        //   2. Endless entry (cp === null) → roll a random 4-connected
        //      fate shape and let it flow through the pool path.
        if (cp && Array.isArray(cp.shape)) {
            this.fateCurrentShape = cp.shape;
            // Fallback idx when the shape wasn't in the pool — pick any
            // valid idx so the reroll button's `avoid` arg has SOMETHING
            // to steer away from. -1 would make pickFateIndex include
            // it in the pool and possibly re-pick it.
            if (idx < 0) idx = 0;
        } else {
            // No pre-assigned shape → roll a random fate piece from the
            // 4-connected subset only. 8-connected shapes (diagonals like
            // ▞) leave tiny isolated holes when they land on an uneven
            // stack — almost guaranteed dead-locks in the long-haul
            // endless mode. The full 8-connected pool stays available
            // for level mode via the branch above.
            const pool = FATE_SHAPES_4CONNECTED_INDICES;
            idx = pool.length > 0
                ? pool[Math.floor(Math.random() * pool.length)]
                : Math.floor(Math.random() * FATE_SHAPES.length);
            this.fateCurrentShape = null;
        }
        this.fateCurrentIdx  = idx;
        this.fateCurrentBase = (cp && cp.baseType) || (['I','O','T','S','Z','J','L'] as PieceType[])[idx % 7];
        this.fateLevelOrder  = level.order || 0;
        // Track whether this modal was opened as an endless entry (no
        // pre-assigned shape) — affects the reroll button's pool.
        this.fateIsEndlessEntry = !cp;
        this.fateResolve = onStart;
        this.fateCancel  = onCancel || null;
        // Belt: hide the embed picker root if a prior Lvl 16+ open left
        // it visible (fresh interactive fate modal should never show it).
        if (this.authoredEmbedPickerRoot) this.authoredEmbedPickerRoot.active = false;
        this.refreshFateSubtitle();
        this.drawFateShape();
        // Mutex with EnergyPicker — see showPicker for rationale.
        if (this.pickerOverlay && this.pickerOverlay.active) {
            console.warn('[FateModal] picker still active — closing it first to avoid overlap');
            this.hidePicker();
        }
        // Force the overlay to draw on top of every sibling (HUD strip,
        // energy bar, item icons, etc.). Programmatic HUD nodes like
        // the energy bar are added later than the authored fate modal,
        // so without a sibling-index bump they'd render on top of the
        // dim and leak into the modal.
        this.fateOverlay.setSiblingIndex(999);
        this.fateOverlay.active = true;
        // Reset the per-modal paid-refresh tier counter so this fresh
        // open starts back at tier 0 (10 gems). Cap is
        // MAX_PAID_REFRESHES_PER_MODAL — after that the button greys
        // out and shows "已达上限" until the modal is reopened.
        this._paidRefreshUsed.fate = 0;
        // Paint the paid-refresh button label. Fate uses local tier
        // state (no server round-trip), so this is synchronous — the
        // player sees "10 (3/3)" the first frame the modal appears.
        this.refreshPaidRefreshLabel('fate');
        // Repaint the FREE reroll button so "(n/3)" reflects the
        // latest server count. Kept in sync from consume/lang/wire
        // paths, but re-run on open too so back-to-back modal opens
        // pick up any external mutation (e.g. profile refresh between
        // opens).
        this.updateFateRerollButtonLabel();
    }

    private hideFateModal(): void {
        if (this.fateOverlay) this.fateOverlay.active = false;
        this.fateResolve = null;
        this.fateCancel  = null;
        if (this.fatePreviewTimer) {
            clearTimeout(this.fatePreviewTimer);
            this.fatePreviewTimer = null;
        }
        // Restore buttons for next interactive use.
        if (this.fateButtonsGroup) this.fateButtonsGroup.active = true;
        // Also close the embed picker if it happened to be open (e.g.
        // scene navigation while a Lvl 16+ modal is up). Reset state
        // so the next open starts clean.
        if (this.authoredEmbedPickerRoot) this.authoredEmbedPickerRoot.active = false;
        this._embedResolve = null;
        this._embedPicked = null;
        this._fateEmbedModeActive = false;
    }

    /** Read-only preview variant: shows the level's assigned fate piece
     *  for `durationMs`, then auto-dismisses and fires `onDone`. No
     *  buttons, no reroll. Used by the level-mode entry flow ("本命弹窗"). */
    public showFatePreview(
        level: LevelData,
        onDone: () => void,
        durationMs: number = 1500,
        subtitleOverride?: string | null,
    ): void {
        if (!this.fateOverlay) { onDone(); return; }
        const cp = level.customPiece;
        let idx = -1;
        if (cp && Array.isArray(cp.shape)) idx = fateIndexOfShape(cp.shape);
        if (idx < 0) idx = ((level.order || 1) - 1) % FATE_SHAPES.length;
        // Same "custom shape wins over pool" rule as showFateModal —
        // preview MUST render the level's actual assigned piece, not
        // the FATE_SHAPES fallback that fateIndexOfShape lands on when
        // canonicalisation fails.
        this.fateCurrentShape = (cp && Array.isArray(cp.shape)) ? cp.shape : null;
        this.fateCurrentIdx  = idx;
        this.fateCurrentBase = (cp && cp.baseType) || (['I','O','T','S','Z','J','L'] as PieceType[])[idx % 7];
        this.fateLevelOrder  = level.order || 0;
        // Subtitle: caller override (e.g., "下一关" between-level preview)
        // takes precedence over the default "关卡 X - Y 格" line so the
        // post-clear flow can show a distinct label without touching
        // the fate-entry path.
        if (subtitleOverride != null && this.fateSubLab) {
            this.fateSubLab.string = subtitleOverride;
        } else {
            this.refreshFateSubtitle();
        }
        this.drawFateShape();
        // Hide interactive buttons + hint for the preview pass.
        if (this.fateButtonsGroup) this.fateButtonsGroup.active = false;
        // Hide embed picker root — preview mode is auto-dismiss.
        if (this.authoredEmbedPickerRoot) this.authoredEmbedPickerRoot.active = false;
        // Mutex with EnergyPicker — see showPicker for rationale.
        if (this.pickerOverlay && this.pickerOverlay.active) {
            console.warn('[FatePreview] picker still active — closing it first');
            this.hidePicker();
        }
        this.fateOverlay.active = true;
        if (this.fatePreviewTimer) clearTimeout(this.fatePreviewTimer);
        this.fatePreviewTimer = setTimeout(() => {
            this.fatePreviewTimer = null;
            this.hideFateModal();
            onDone();
        }, durationMs);
    }

    /** Interactive fate modal for level 16+ entries.
     *
     *  Same visual layout as `showFatePreview` for the fate piece itself
     *  (title / subtitle / shape canvas), but instead of auto-dismissing
     *  it stays open and reveals a picker:
     *
     *    [ boom1 ]  [ row1 ]        ← tap once to select (mutually
     *                                  exclusive; tap again to deselect)
     *    [    开 始    ]            ← enters game with the current pick
     *                                  (or `null` if nothing selected)
     *
     *  The picker root + option buttons are wired via `@property`; if
     *  the scene hasn't been extended yet, this method still opens the
     *  overlay (so behaviour degrades to a preview) but the option
     *  buttons stay hidden and the caller sees `null` on 开始.
     *
     *  `subtitleOverride` matches the same param on `showFatePreview`
     *  (used by the post-clear flow to show "下一关 - X 层" instead of
     *  the default "关卡 X - Y 格" line).
     */
    public showFateEmbedPicker(
        level: LevelData,
        onStart: (picked: EmbedProp | null) => void,
        subtitleOverride?: string | null,
    ): void {
        if (!this.fateOverlay) { onStart(null); return; }

        // ---- Same shape-canvas setup as showFatePreview ----
        const cp = level.customPiece;
        let idx = -1;
        if (cp && Array.isArray(cp.shape)) idx = fateIndexOfShape(cp.shape);
        if (idx < 0) idx = ((level.order || 1) - 1) % FATE_SHAPES.length;
        this.fateCurrentShape = (cp && Array.isArray(cp.shape)) ? cp.shape : null;
        this.fateCurrentIdx   = idx;
        this.fateCurrentBase  = (cp && cp.baseType) || (['I','O','T','S','Z','J','L'] as PieceType[])[idx % 7];
        this.fateLevelOrder   = level.order || 0;
        this.fateIsEndlessEntry = false;
        if (subtitleOverride != null && this.fateSubLab) {
            this.fateSubLab.string = subtitleOverride;
        } else {
            this.refreshFateSubtitle();
        }
        this.drawFateShape();

        // ---- Hide the standard reroll/paid-refresh/start button row.
        //      The picker's own start button replaces it. ----
        if (this.fateButtonsGroup) this.fateButtonsGroup.active = false;

        // Mutex with EnergyPicker — see showPicker for rationale.
        if (this.pickerOverlay && this.pickerOverlay.active) {
            console.warn('[FateEmbedPicker] picker still active — closing it first');
            this.hidePicker();
        }

        // ---- Show the embed picker + reset selection ----
        this._embedPicked = null;
        this._embedResolve = onStart;
        this._fateEmbedModeActive = true;
        this._embedConsuming = false;
        if (this.authoredEmbedPickerRoot) this.authoredEmbedPickerRoot.active = true;
        // Reset any transform mutations left by the previous open's
        // pick-to-centre animation. Layout will reposition on next
        // frame — we just have to restore scale/opacity/active state.
        this._resetEmbedPickerButtons();
        this._refreshEmbedSelectMarks();
        if (this.authoredEmbedStartLabel) this.authoredEmbedStartLabel.string = t('fate.start');
        if (this.authoredEmbedHintLabel)  this.authoredEmbedHintLabel.string  = t('fate.embedPick.hint');
        if (this.authoredEmbedStartButton) {
            this.authoredEmbedStartButton.interactable = true;
            this.authoredEmbedStartButton.node.active = true;
        }

        // Populate counts optimistically from cache so the labels don't
        // flash empty during the network round-trip; then fetch fresh
        // and repaint. If the network fails we keep the cached values.
        const cached = getCachedBackpack(60_000);
        if (cached) this._paintEmbedCounts(cached.items);
        else this._paintEmbedCounts([]);   // renders "-" placeholders + disables buttons
        fetchBackpack().then((r) => {
            // Only apply if this picker session is still current — a
            // fast player who closed + reopened before the fetch resolved
            // shouldn't have the stale reply stomp their new state.
            if (!this._fateEmbedModeActive) return;
            this._paintEmbedCounts(r.items);
        }).catch((err) => {
            console.warn('[FateEmbedPicker] backpack fetch failed:', err);
        });

        // Cancel any pending preview timer left over from a previous
        // preview open — the picker is stay-open until 开始.
        if (this.fatePreviewTimer) { clearTimeout(this.fatePreviewTimer); this.fatePreviewTimer = null; }

        this.fateOverlay.setSiblingIndex(999);
        this.fateOverlay.active = true;
    }

    /** Sync `_embedCounts` from a backpack items list, then paint the
     *  three button labels + disable buttons that have zero count.
     *
     *  Zero-count button state:
     *    • Label reads `0` (not `-`) so the visual matches "有多少"
     *      semantics rather than "缺失".
     *    • `button.interactable = false` blocks the click handler.
     *    • The button node's opacity is dimmed to ~120/255 so the grey
     *      state reads visually even when the Button component has no
     *      transition configured (the default authoring case). */
    private _paintEmbedCounts(items: Array<{ id: string; count: number }>): void {
        // Reset then apply — items missing from the list mean 0 owned.
        this._embedCounts = { boom1: 0, row1: 0, wrecker: 0 };
        for (const it of items) {
            if (it.id === 'boom1'   && it.count > 0) this._embedCounts.boom1   = it.count;
            if (it.id === 'row1'    && it.count > 0) this._embedCounts.row1    = it.count;
            if (it.id === 'wrecker' && it.count > 0) this._embedCounts.wrecker = it.count;
        }
        const fmt = (n: number) => `x${n}`;
        if (this.authoredEmbedBoomCountLabel)    this.authoredEmbedBoomCountLabel.string    = fmt(this._embedCounts.boom1);
        if (this.authoredEmbedRowBombCountLabel) this.authoredEmbedRowBombCountLabel.string = fmt(this._embedCounts.row1);
        if (this.authoredEmbedWreckerCountLabel) this.authoredEmbedWreckerCountLabel.string = fmt(this._embedCounts.wrecker);
        // Disable interaction for zero-count options so the player
        // can't pick something they don't own. Also modulate the node
        // opacity so the grey state reads visually — Button.interactable
        // alone only affects transitions when one is configured, so
        // without an explicit dim the "禁用" state looks identical to
        // "可选" in the default authoring case.
        const dim = (btn: Button | null, on: boolean) => {
            if (!btn) return;
            btn.interactable = on;
            const op = btn.node.getComponent(UIOpacity) ?? btn.node.addComponent(UIOpacity);
            op.opacity = on ? 255 : 120;
        };
        dim(this.authoredEmbedBoomButton,    this._embedCounts.boom1   > 0);
        dim(this.authoredEmbedRowBombButton, this._embedCounts.row1    > 0);
        dim(this.authoredEmbedWreckerButton, this._embedCounts.wrecker > 0);
        if (this._embedPicked && this._embedCounts[this._embedPicked] === 0) {
            this._embedPicked = null;
            this._refreshEmbedSelectMarks();
        }
    }

    /** Snapshot of each embed-button's original local position, taken
     *  the FIRST time `_resetEmbedPickerButtons` runs (i.e. before
     *  any pick-to-centre animation has moved them). We can't rely on
     *  a parent Layout to reposition them on reopen — Layout only
     *  re-lays-out on child add/remove or an explicit call, so the
     *  animated position sticks and the buttons stack in the middle
     *  on the second open. */
    private _embedButtonHomePos: Map<Node, Vec3> = new Map();

    /** Restore active + scale + opacity + position on the three embed
     *  buttons. Called by `showFateEmbedPicker` on every open so the
     *  previous session's pick-to-centre animation doesn't leave a
     *  button shrunk / hidden / mid-flight. */
    private _resetEmbedPickerButtons(): void {
        for (const btn of [this.authoredEmbedBoomButton, this.authoredEmbedRowBombButton, this.authoredEmbedWreckerButton]) {
            if (!btn) continue;
            Tween.stopAllByTarget(btn.node);
            btn.node.active = true;
            btn.node.setScale(1, 1, 1);
            const op = btn.node.getComponent(UIOpacity);
            if (op) op.opacity = 255;
            // Snapshot original position on first pass, restore
            // afterwards. First-open positions are Layout-authored;
            // we cache them so re-opens land in the same spot even
            // after our tween has moved the node.
            const home = this._embedButtonHomePos.get(btn.node);
            if (home) {
                btn.node.setPosition(home);
            } else {
                this._embedButtonHomePos.set(btn.node, btn.node.position.clone());
            }
        }
        // If there's a Layout anywhere along the button-parent chain,
        // force a recompute — snapshot restore alone should suffice,
        // this is belt-and-suspenders. Walks up from each button's
        // direct parent since the Layout can live on any container.
        const seen: Set<Node> = new Set();
        for (const btn of [this.authoredEmbedBoomButton, this.authoredEmbedRowBombButton, this.authoredEmbedWreckerButton]) {
            let n: Node | null = btn?.node.parent ?? null;
            while (n && !seen.has(n)) {
                seen.add(n);
                const layout = n.getComponent(Layout);
                if (layout) { layout.updateLayout(); break; }
                n = n.parent;
            }
        }
    }

    /** Toggle picker state — tapping the currently-picked option
     *  deselects it, tapping another option switches. Called from the
     *  three @property click handlers. Guards against picking an item
     *  the player doesn't own (defense in depth — the button should
     *  already be non-interactable in that case). */
    private _togglePickedEmbed(next: EmbedProp): void {
        if (this._embedCounts[next] <= 0) {
            console.log(`[FateEmbedPicker] ignore pick — ${next} count=0`);
            return;
        }
        this._embedPicked = (this._embedPicked === next) ? null : next;
        this._refreshEmbedSelectMarks();
    }

    /** Sync the three select-mark nodes to the current `_embedPicked`. */
    private _refreshEmbedSelectMarks(): void {
        if (this.authoredEmbedBoomSelectMark) {
            this.authoredEmbedBoomSelectMark.active = this._embedPicked === 'boom1';
        }
        if (this.authoredEmbedRowBombSelectMark) {
            this.authoredEmbedRowBombSelectMark.active = this._embedPicked === 'row1';
        }
        if (this.authoredEmbedWreckerSelectMark) {
            this.authoredEmbedWreckerSelectMark.active = this._embedPicked === 'wrecker';
        }
    }

    /** Play the pre-game intro animation for the picked embed prop:
     *    1. Hide the OTHER two option buttons + Start button so the
     *       picked icon is visually alone.
     *    2. Tween the picked button's node to the picker root's centre.
     *    3. At centre, scale down + fade out.
     *    4. Simultaneously spawn a Graphics-based radial burst that
     *       expands + fades.
     *  On completion (~500ms), fire `onDone` so MenuController can
     *  hand off to the game transition. Non-blocking for the caller —
     *  everything runs on Cocos tweens/schedulers.
     *
     *  Steps 4-5 of the design brief (yellow orb arcs to the actual
     *  tower cell + prop reveal glow) require the game view to be up
     *  and the target cell world-position known. GameController plays
     *  those AFTER the level assembly animation completes (see the
     *  `lastEmbedInjection` getter on GameState). */
    private _playPickToCenterFx(picked: EmbedProp, onDone: () => void): void {
        const button = picked === 'boom1' ? this.authoredEmbedBoomButton
                     : picked === 'row1'  ? this.authoredEmbedRowBombButton
                     : this.authoredEmbedWreckerButton;
        const root = this.authoredEmbedPickerRoot;
        if (!button || !root) { onDone(); return; }

        // Hide siblings so the picked icon is alone at centre.
        if (picked !== 'boom1'   && this.authoredEmbedBoomButton)    this.authoredEmbedBoomButton.node.active    = false;
        if (picked !== 'row1'    && this.authoredEmbedRowBombButton) this.authoredEmbedRowBombButton.node.active = false;
        if (picked !== 'wrecker' && this.authoredEmbedWreckerButton) this.authoredEmbedWreckerButton.node.active = false;
        if (this.authoredEmbedStartButton) this.authoredEmbedStartButton.node.active = false;
        // Also hide the selectmark so the icon looks clean during the fly.
        this._embedPicked = null;
        this._refreshEmbedSelectMarks();

        const node = button.node;
        // Note: intentionally do NOT touch node.setSiblingIndex here.
        // The picker's parent is (typically) a Layout, which re-lays-
        // out children by sibling order — bumping the sibling index
        // permanently reorders it, breaking re-open positions. We
        // instead put the burst node BEHIND every child by inserting
        // it at index 0 below.
        // Ensure a UIOpacity so we can fade later.
        const opacity = node.getComponent(UIOpacity) ?? node.addComponent(UIOpacity);
        opacity.opacity = 255;

        // Destination — centre of picker root, converted to node.parent
        // local space so we can tween `position` directly.
        const destWorld = new Vec3();
        root.getWorldPosition(destWorld);
        const parentUT = node.parent?.getComponent(UITransform);
        const destLocal = new Vec3(0, 0, 0);
        if (parentUT) parentUT.convertToNodeSpaceAR(destWorld, destLocal);

        // Spawn the burst node as a child of picker root, centred at (0,0)
        // in root-local space. Graphics circle expands from r=0 → r=140
        // while opacity fades 220 → 0.
        // Parent the burst to the fate overlay (or the picker root's
        // parent as a fallback) rather than the picker root itself —
        // adding a child to a Layout-managed node re-lays-out siblings,
        // which would shove the three buttons around while one of them
        // is flying to centre. The overlay has no Layout, so it's safe.
        const burstParent = this.fateOverlay ?? root.parent ?? root;
        const burst = new Node('EmbedPickBurst');
        burstParent.addChild(burst);
        // Position the burst at the picker root's centre in the
        // burst-parent's local space.
        const rootWorld = new Vec3();
        root.getWorldPosition(rootWorld);
        const burstParentUT = burstParent.getComponent(UITransform);
        const burstLocal = new Vec3();
        if (burstParentUT) burstParentUT.convertToNodeSpaceAR(rootWorld, burstLocal);
        burst.setPosition(burstLocal);
        const burstUT = burst.addComponent(UITransform);
        burstUT.setContentSize(300, 300);
        const gfx = burst.addComponent(Graphics);
        const burstOp = burst.addComponent(UIOpacity);
        burstOp.opacity = 0;
        // Redraw each frame's tween tick — we schedule a small update
        // loop keyed on start time.
        const burstStart = Date.now();
        const burstDurMs = 400;
        const drawBurst = () => {
            const t = Math.min(1, (Date.now() - burstStart) / burstDurMs);
            const r = 30 + t * 130;                  // 30 → 160 px
            const alpha = Math.floor(220 * (1 - t)); // 220 → 0
            burstOp.opacity = alpha;
            gfx.clear();
            // Outer ring — golden.
            gfx.lineWidth = 4;
            gfx.strokeColor = new Color(255, 210, 80, 255);
            gfx.circle(0, 0, r);
            gfx.stroke();
            // Inner glow — brighter, thinner ring at half radius.
            gfx.lineWidth = 2;
            gfx.strokeColor = new Color(255, 245, 180, 255);
            gfx.circle(0, 0, r * 0.6);
            gfx.stroke();
            if (t >= 1) {
                this.unschedule(drawBurst);
                burst.destroy();
            }
        };

        // Timeline:
        //   0 - 300ms: fly to centre (position tween)
        //   300 - 500ms: scale + fade + burst (kicked off inside .call)
        //   ~500ms: fire onDone → game transition kicks in
        Tween.stopAllByTarget(node);
        tween(node)
            .to(0.3, { position: destLocal }, { easing: 'quadOut' })
            .call(() => {
                // Start the burst as we reach centre.
                this.schedule(drawBurst, 0);
                // Shrink + fade (200ms, run in parallel with burst).
                tween(node).to(0.2, { scale: new Vec3(0.05, 0.05, 1) }, { easing: 'quadIn' }).start();
                tween(opacity).to(0.2, { opacity: 0 }).start();
            })
            .delay(0.22)
            .call(() => onDone())
            .start();
    }

    /** [DEPRECATED — kept as fallback] 2D Canvas-Graphics version of
     *  the embed-pick reveal FX. Superseded by `EmbedRevealFX3D` (real
     *  3D scene FX with correct tower depth occlusion). Left in place
     *  for reference and as a fallback if the 3D FX ever needs to be
     *  disabled — swap the caller in `GameController.playEmbedRevealFxIfPending`.
     *
     *  See `EmbedRevealFX3D.ts` for the current production path. */
    public playEmbedRevealFx(
        targetWorld: Vec3,
        camera: Camera,
        canvasUT: UITransform,
        _kind: EmbedProp,
        onArrive: () => void,
        onDone: () => void,
    ): void {
        const canvasNode = canvasUT.node;

        const overlay = new Node('EmbedRevealFx');
        overlay.layer = canvasNode.layer;
        canvasNode.addChild(overlay);
        overlay.setSiblingIndex(9999);
        const ut = overlay.addComponent(UITransform);
        ut.setContentSize(1, 1);
        const gfx = overlay.addComponent(Graphics);

        // Tower geometry, derived from the target cell so we don't need
        // to import Constants from here.
        const targetR = Math.max(0.1, Math.sqrt(targetWorld.x * targetWorld.x + targetWorld.z * targetWorld.z));
        const orbitR  = targetR * 1.5;
        // Shortest angular direction from θ=0 (front) to targetTheta.
        let targetTheta = Math.atan2(targetWorld.x, targetWorld.z);
        // Ensure we take the shorter path — same normalisation as
        // atan2 already gives us (-π .. π), which IS the shortest.
        const startY = targetWorld.y + 3;   // start ~3 cells above target
        const peakH  = 2;                   // sin-bump height above the linear glide

        // Reusable temp vectors to avoid GC.
        const wp = new Vec3();
        const sp = new Vec3();
        const uiP = new Vec3();

        // Compute 3D world → UI screen point (Canvas centre origin).
        const worldToUi = (w: Vec3, out: Vec3): boolean => {
            camera.worldToScreen(w, sp);
            // Behind-camera or off-screen projection returns invalid
            // values on some builds; z<0 is a reliable clue. Bail so
            // we don't draw a nonsense frame.
            if (!isFinite(sp.x) || !isFinite(sp.y)) return false;
            canvasUT.convertToNodeSpaceAR(sp, out);
            return true;
        };

        const flyDurMs  = 700;
        const glowDurMs = 400;
        const startTime = Date.now();
        const history: Array<{ x: number; y: number }> = [];
        const HISTORY_LEN = 14;
        let arrived = false;
        let arrivedAt = 0;

        // Pre-compute the target cell's UI position for the glow pulse.
        const targetUi = new Vec3();
        worldToUi(targetWorld, targetUi);

        const drawFrame = () => {
            const now = Date.now();
            gfx.clear();

            if (!arrived) {
                const t = Math.min(1, (now - startTime) / flyDurMs);
                // Radius: outside for most, converges in last 20%.
                const rt = t < 0.8 ? orbitR : orbitR + (targetR - orbitR) * ((t - 0.8) / 0.2);
                // Angular sweep 0 → targetTheta with quadOut easing so
                // the orb accelerates into the wrap and settles at the
                // cell rather than passing it.
                const ease = 1 - (1 - t) * (1 - t);
                const theta = targetTheta * ease;
                // Linear glide + sin-bump arc.
                const y = startY + (targetWorld.y - startY) * t + peakH * Math.sin(Math.PI * t);
                wp.set(rt * Math.sin(theta), y, rt * Math.cos(theta));
                if (!worldToUi(wp, uiP)) return;   // skip degenerate frames

                history.push({ x: uiP.x, y: uiP.y });
                if (history.length > HISTORY_LEN) history.shift();

                // Trail — golden strip, alpha fades from oldest to newest.
                gfx.lineWidth = 10;
                for (let i = 1; i < history.length; i++) {
                    const a = i / history.length;
                    gfx.strokeColor = new Color(255, 220, 90, Math.floor(a * 180));
                    gfx.moveTo(history[i - 1].x, history[i - 1].y);
                    gfx.lineTo(history[i].x, history[i].y);
                    gfx.stroke();
                }
                gfx.fillColor = new Color(255, 220, 100, 180);   // outer halo
                gfx.circle(uiP.x, uiP.y, 26);
                gfx.fill();
                gfx.fillColor = new Color(255, 235, 150, 220);   // mid glow
                gfx.circle(uiP.x, uiP.y, 16);
                gfx.fill();
                gfx.fillColor = new Color(255, 252, 220, 255);   // core
                gfx.circle(uiP.x, uiP.y, 8);
                gfx.fill();

                if (t >= 1) {
                    arrived = true;
                    arrivedAt = now;
                    // Impact — commit the prop to state so the glow
                    // pulse (about to draw below on the next frame)
                    // reveals a freshly-formed embed overlay rather
                    // than an already-visible one.
                    try { onArrive(); } catch (e) { console.warn('[EmbedRevealFx] onArrive threw', e); }
                }
            } else {
                // Golden pulse on the target cell (放大 → 缩小 → 揭示).
                const t = Math.min(1, (now - arrivedAt) / glowDurMs);
                const puff = Math.sin(Math.PI * t);
                const rOuter = 30 + t * 130;
                const rInner = 20 + puff * 40;
                const alphaOuter = Math.floor(220 * (1 - t));
                const alphaInner = Math.floor(200 * puff);

                gfx.lineWidth = 5;
                gfx.strokeColor = new Color(255, 220, 80, alphaOuter);
                gfx.circle(targetUi.x, targetUi.y, rOuter);
                gfx.stroke();

                gfx.fillColor = new Color(255, 245, 170, alphaInner);
                gfx.circle(targetUi.x, targetUi.y, rInner);
                gfx.fill();

                if (t >= 1) {
                    this.unschedule(drawFrame);
                    overlay.destroy();
                    onDone();
                }
            }
        };
        this.schedule(drawFrame, 0);
    }

    /** Fire the caller's onStart with the picked embed, then close. */
    private _resolveEmbedAndClose(picked: EmbedProp | null): void {
        const cb = this._embedResolve;
        this._embedResolve = null;
        this._embedPicked = null;
        this._fateEmbedModeActive = false;
        if (this.authoredEmbedPickerRoot) this.authoredEmbedPickerRoot.active = false;
        this._refreshEmbedSelectMarks();   // clear both marks visually
        this.hideFateModal();
        if (cb) cb(picked);
    }

    private refreshFateSubtitle(): void {
        if (!this.fateSubLab) return;
        let cellCount = 0;
        // Same source-of-truth rule as drawFateShape: level-authored
        // shape wins over the FATE_SHAPES pool entry. Without this the
        // subtitle's "X 格" cell count reads the pool shape (5 max) even
        // when the actual piece is a 6-cell level shape.
        const s = this.fateCurrentShape ?? FATE_SHAPES[this.fateCurrentIdx];
        for (let r = 0; r < s.length; r++) {
            for (let c = 0; c < s[r].length; c++) {
                if (s[r][c]) cellCount++;
            }
        }
        // Level mode: show the stage's 1-based order directly. Level 0
        // → Stage 1, level 98 → Stage 99 (fateLevelOrder is already
        // 1-based). Forward numbering matches every other display path
        // — level select, fate preview, leaderboard row labels.
        const prefix = this.fateIsEndlessEntry
            ? t('fate.endlessSub')
            : t('level.floor', { n: this.fateLevelOrder ?? '?' });
        this.fateSubLab.string = t('fate.subtitle', { tag: prefix, n: cellCount });
    }

    // ============================================================
    //  Paid refresh (spend gems to re-roll)
    // ============================================================
    /** Per-modal count of successful paid refreshes, keyed by type.
     *  Read as the tier index into REFRESH_COST_TIERS for the NEXT
     *  purchase (used=0 → cost=10, used=1 → cost=15, used=2 → cost=20).
     *  Reset to 0 when the corresponding modal opens (fate in
     *  showFateModal, magic in showAuthoredPicker). Applies to both
     *  fate + magic — same escalation table. Client-side counter is
     *  UX only; server also enforces via the `tier` parameter to
     *  POST /refresh/purchase. */
    private _paidRefreshUsed: Record<RefreshType, number> = { fate: 0, magic: 0 };

    /** Paint the paid-refresh button label for the given type from
     *  local tier state — no server round-trip. Called on modal open
     *  (via `refreshPaidRefreshLabel(type)`) and after every successful
     *  purchase to advance the price display. Grays out the button at
     *  cap so the "no more paid refreshes this modal" state reads
     *  visually and doesn't fire on subsequent taps.
     *
     *  Cost tiers are hard-coded in REFRESH_COST_TIERS so the server
     *  charge (via `purchaseRefresh(type, tier)`) matches what the
     *  player just saw on the button. Same rule for fate + magic. */
    private refreshPaidRefreshLabel(type: RefreshType): void {
        const btn = type === 'fate'
            ? this.authoredFatePaidRefreshButton
            : this.authoredPickerPaidRefreshButton;
        const authoredLab = type === 'fate'
            ? this.authoredFatePaidRefreshLabel
            : this.authoredPickerPaidRefreshLabel;
        if (!btn) {
            console.warn(`[${type === 'fate' ? 'FateModal' : 'Picker'}] refreshPaidRefreshLabel: button unwired — nothing to paint`);
            return;
        }
        // Prefer the explicit @property; fall back to painting EVERY
        // Label descendant of the button. `getComponentInChildren`
        // returns just the FIRST label it finds — if the button prefab
        // has multiple Labels (e.g. a "💎" icon Label + a cost Label),
        // painting only the first one silently misses the visible cost
        // label. `getComponentsInChildren` (plural) covers all of them.
        const labels: Label[] = authoredLab
            ? [authoredLab]
            : btn.node.getComponentsInChildren(Label);

        const used      = this._paidRefreshUsed[type];
        const remaining = Math.max(0, MAX_PAID_REFRESHES_PER_MODAL - used);
        const exhausted = remaining <= 0;
        // Clamp past the tier table's end (defensive — never hit at
        // cap = tiers.length, but keeps things sane if either constant
        // changes independently).
        const cost = REFRESH_COST_TIERS[Math.min(used, REFRESH_COST_TIERS.length - 1)];

        const text = exhausted
            ? t('refresh.limitReached')
            : `${cost}  (${remaining}/${MAX_PAID_REFRESHES_PER_MODAL})`;
        console.log(`[${type === 'fate' ? 'FateModal' : 'Picker'}] refreshPaidRefreshLabel — used=${used} remaining=${remaining} cost=${cost} text="${text}" labelsPainted=${labels.length} authoredWired=${!!authoredLab}`);
        for (const lab of labels) lab.string = text;

        // Match Cocos Button semantics: interactable=false blocks click
        // events AND applies the greyed-out transition (whichever kind
        // is authored on the Button component).
        btn.interactable = !exhausted;
    }

    /** Fate paid refresh click — spend gems on the server at the
     *  current tier, then trigger the local re-roll on success. Toast
     *  the error on failure. Advances `_paidRefreshUsed.fate` so the
     *  next click charges the next tier (10 → 15 → 20). */
    private onFatePaidRefreshClicked(): void {
        const used = this._paidRefreshUsed.fate;
        // Belt-and-suspenders: button should be non-interactable at cap
        // (refreshPaidRefreshLabel handles that), so this guard is just
        // for safety if something bypasses the button.
        if (used >= MAX_PAID_REFRESHES_PER_MODAL) {
            console.log('[FateModal] paid refresh at cap — ignoring click');
            return;
        }
        const tier = used;
        const cost = REFRESH_COST_TIERS[Math.min(tier, REFRESH_COST_TIERS.length - 1)];
        purchaseRefresh('fate', tier)
            .then((r) => {
                console.log(`[FateModal] paid refresh OK (tier=${tier}) — spent=${r.gemsSpent} balance=${r.balance}`);
                this._paidRefreshUsed.fate++;
                AnalyticsApi.logCustom('refresh_used', {
                    kind: 'fate', tier, gems_spent: r.gemsSpent, balance_after: r.balance,
                });
                this.onFateReroll();
                // Repaint so the next tier's cost + updated remaining
                // count show immediately.
                this.refreshPaidRefreshLabel('fate');
            })
            .catch((err) => this.handlePaidRefreshError(err, cost));
    }

    /** Picker paid refresh click — same escalating-tier flow as fate.
     *  Spend gems at the current tier, then re-roll the two choices
     *  via GameState.refreshEnergyPicker (bypasses the free / ad-gated
     *  path). Advances `_paidRefreshUsed.magic` so the next click
     *  charges the next tier (10 → 15 → 20). */
    private onPickerPaidRefreshClicked(): void {
        const used = this._paidRefreshUsed.magic;
        console.log(`[Picker] paid refresh CLICK — used=${used}/${MAX_PAID_REFRESHES_PER_MODAL} sessionActive=${this._pickerSessionActive}`);
        if (used >= MAX_PAID_REFRESHES_PER_MODAL) {
            // Silent 'ignore' looked like a dead button to players who
            // didn't realise they'd hit the cap. Surface it — the
            // button's own label already says '限已达上限', but a
            // toast confirms the tap was received.
            console.log('[Picker] paid refresh at cap — ignoring click');
            ToastManager.instance?.show(t('refresh.limitReached'));
            return;
        }
        const tier = used;
        const cost = REFRESH_COST_TIERS[Math.min(tier, REFRESH_COST_TIERS.length - 1)];
        purchaseRefresh('magic', tier)
            .then((r) => {
                console.log(`[Picker] paid refresh OK (tier=${tier}) — spent=${r.gemsSpent} balance=${r.balance}`);
                this._paidRefreshUsed.magic++;
                AnalyticsApi.logCustom('refresh_used', {
                    kind: 'magic', tier, gems_spent: r.gemsSpent, balance_after: r.balance,
                });
                this.gameController?.gameState?.refreshEnergyPicker();
                // Repaint the button so the next tier + updated
                // remaining count show immediately.
                this.refreshPaidRefreshLabel('magic');
            })
            .catch((err) => this.handlePaidRefreshError(err, cost));
    }

    /** Shared 402 handler for both paid-refresh flows. Server returns
     *  a body like `{"error":"insufficient gems","needed":10,"balance":3}`
     *  on 402 — parse the balance out and route to
     *  `MenuController.showInsufficientGems` for the top-up prompt.
     *  Other errors (network, 5xx) just log. */
    private handlePaidRefreshError(err: unknown, fallbackNeeded: number): void {
        const msg = String((err as any)?.message || err);
        console.warn(`[HUD] paid refresh FAILED: ${msg}`);
        // Match `HTTP 402: {"error":"...","needed":N,"balance":M}` from Http.ts.
        const m = /HTTP 402:\s*(\{.*\})$/.exec(msg);
        if (!m) {
            // Non-402 error (network, 5xx, etc.) — surface it as an
            // error-flavoured toast so the player sees SOMETHING when
            // the refresh silently fails.
            ToastManager.instance?.error(t('topup.failBody', { reason: msg }));
            return;
        }
        let needed = fallbackNeeded;
        let balance = 0;
        try {
            const body = JSON.parse(m[1]);
            if (typeof body.needed === 'number')  needed  = body.needed;
            if (typeof body.balance === 'number') balance = body.balance;
        } catch { /* ignore parse errors */ }
        const menu = this.menuController;
        if (menu && typeof menu.showInsufficientGems === 'function') {
            menu.showInsufficientGems(needed, balance);
        } else {
            console.log('[HUD] insufficient-gems popup not wired — falling back to console log');
        }
    }

    private onFateReroll(): void {
        // Endless entries keep the player on the 4-connected subset to
        // avoid dead-locking shapes; level entries reroll across the
        // full 8-connected pool (the level may explicitly want one).
        const newIdx = this.fateIsEndlessEntry
            ? pickFateIndex4Connected(this.fateCurrentIdx)
            : pickFateIndex(this.fateCurrentIdx);
        this.fateCurrentIdx  = newIdx;
        this.fateCurrentBase = (['I','O','T','S','Z','J','L'] as PieceType[])[newIdx % 7];
        // A reroll switches to the FATE_SHAPES pool — clear the level
        // shape override so the pool entry becomes authoritative for
        // both preview and confirm.
        this.fateCurrentShape = null;
        this.refreshFateSubtitle();
        this.drawFateShape();
    }

    private onFateConfirm(): void {
        const resolve = this.fateResolve;
        // Prefer the level-authored shape (fateCurrentShape) so 6-cell
        // and other non-pool shapes are returned as-authored. Falls
        // back to fateShapeAsCustomPiece(idx, base) when the player
        // rerolled or entered from endless.
        const picked = this.fateCurrentShape
            ? { baseType: this.fateCurrentBase, shape: this.fateCurrentShape.map(row => row.slice()) }
            : fateShapeAsCustomPiece(this.fateCurrentIdx, this.fateCurrentBase);
        this.hideFateModal();
        resolve?.(picked);
    }

    // ============================================================
    //  变形道具 (Shapeshifter) picker
    // ============================================================
    /** Open the shapeshifter picker so the player can transform the
     *  current live piece. GameState fires `onShapeshifterRequest(apply)`
     *  when the player selects the item; GameController forwards to here.
     *  Tapping a card fires `apply(chosenType)`, tapping the dim backdrop
     *  cancels (no-op — the picker refunds the item via GameState's
     *  bypass-inventory pattern only if `apply` never runs). */
    public showShapeshifterPicker(apply: (type: PieceType) => void): void {
        this.shapeshifterApply = apply;
        // Freeze the game while the picker is open — the player is
        // choosing a shape and doesn't want their piece to keep
        // falling / locking / advancing. Cleared in hideShapeshifterPicker.
        const gs = this.gameController?.gameState;
        if (gs) gs.modalPaused = true;
        // Authored (Sprite-based) path — preferred; the legacy Graphics
        // path below is kept for scenes that haven't been rewired yet.
        if (this.authoredShapeshifterOverlay) {
            this.showAuthoredShapeshifterPicker();
            return;
        }
        // Destroy any previous overlay so multi-open sequences don't
        // leak nodes and so Graphics fills always render fresh.
        if (this.shapeshifterOverlay && this.shapeshifterOverlay.isValid) {
            this.shapeshifterOverlay.destroy();
            this.shapeshifterOverlay = null;
        }

        const root = this.node;
        const rootTx = root.getComponent(UITransform);
        const w = rootTx ? rootTx.contentSize.width  : 750;
        const h = rootTx ? rootTx.contentSize.height : 1334;

        const overlay = new Node('ShapeshifterOverlay');
        overlay.parent = root;
        overlay.layer  = root.layer;
        const overlayTx = overlay.addComponent(UITransform);
        overlayTx.setContentSize(w, h);
        overlay.setPosition(0, 0, 0);

        // Dim backdrop — dismisses on tap.
        const dim = overlay.addComponent(Graphics);
        dim.fillColor = new Color(0, 0, 0, 200);
        dim.rect(-w / 2, -h / 2, w, h);
        dim.fill();
        const dimBtn = overlay.addComponent(Button);
        dimBtn.transition = Button.Transition.NONE;
        overlay.on(Button.EventType.CLICK, () => this.hideShapeshifterPicker(), this);

        // Centre card — clicks on the card itself DON'T bubble to the
        // backdrop (so tapping empty card area doesn't dismiss).
        const CARD_W = Math.min(w * 0.88, 620);
        const CARD_H = 560;
        const card = new Node('Card');
        card.parent = overlay;
        card.layer  = overlay.layer;
        const cardTx = card.addComponent(UITransform);
        cardTx.setContentSize(CARD_W, CARD_H);
        card.setPosition(0, 0, 0);
        const cardBg = card.addComponent(Graphics);
        cardBg.fillColor = new Color(20, 25, 44, 250);      // CARD_INNER
        cardBg.roundRect(-CARD_W / 2, -CARD_H / 2, CARD_W, CARD_H, 24);
        cardBg.fill();
        cardBg.strokeColor = new Color(185, 104, 245, 220);  // NEON_PURPLE
        cardBg.lineWidth = 2;
        cardBg.roundRect(-CARD_W / 2, -CARD_H / 2, CARD_W, CARD_H, 24);
        cardBg.stroke();
        const cardBtn = card.addComponent(Button);
        cardBtn.transition = Button.Transition.NONE;
        card.on(Button.EventType.CLICK, () => {/* swallow */}, this);

        // Title + subtitle.
        const ssTitle = this.makeLabel('SsTitle', card, 0, CARD_H * 0.40,
            t('shapeshifter.title'), 42, [0.5, 0.5]);
        ssTitle.color = new Color(245, 240, 220, 255);
        this.trackI18nLabel(ssTitle, 'shapeshifter.title');
        const ssSub = this.makeLabel('SsSub', card, 0, CARD_H * 0.32,
            t('shapeshifter.subtitle'), 18, [0.5, 0.5]);
        ssSub.color = new Color(180, 190, 210, 220);
        this.trackI18nLabel(ssSub, 'shapeshifter.subtitle');

        // Tetromino grid — 4 on top row, 3 on bottom row.
        const OPTIONS: PieceType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
        const SLOT_W = 118;
        const SLOT_H = 148;
        const H_GAP  = 14;
        const V_GAP  = 18;
        const TOP_ROW = OPTIONS.slice(0, 4);
        const BOT_ROW = OPTIONS.slice(4);
        const layoutRow = (types: PieceType[], y: number): void => {
            const rowW = types.length * SLOT_W + (types.length - 1) * H_GAP;
            const startX = -rowW / 2 + SLOT_W / 2;
            for (let i = 0; i < types.length; i++) {
                const x = startX + i * (SLOT_W + H_GAP);
                this.buildShapeshifterSlot(card, x, y, SLOT_W, SLOT_H, types[i]);
            }
        };
        layoutRow(TOP_ROW,  50);
        layoutRow(BOT_ROW, 50 - (SLOT_H + V_GAP));

        // Cancel button at the bottom.
        const CANCEL_W = 220, CANCEL_H = 60;
        const cancelBtn = new Node('SsCancel');
        cancelBtn.parent = card;
        cancelBtn.layer  = card.layer;
        cancelBtn.setPosition(0, -CARD_H * 0.40, 0);
        const cancelTx = cancelBtn.addComponent(UITransform);
        cancelTx.setContentSize(CANCEL_W, CANCEL_H);
        const cancelG = cancelBtn.addComponent(Graphics);
        cancelG.fillColor = new Color(50, 55, 80, 220);
        cancelG.roundRect(-CANCEL_W / 2, -CANCEL_H / 2, CANCEL_W, CANCEL_H, 14);
        cancelG.fill();
        cancelG.strokeColor = new Color(160, 170, 204, 200);
        cancelG.lineWidth = 1.5;
        cancelG.roundRect(-CANCEL_W / 2, -CANCEL_H / 2, CANCEL_W, CANCEL_H, 14);
        cancelG.stroke();
        this.trackI18nLabel(
            this.makeLabel('SsCancelTxt', cancelBtn, 0, 0, t('shapeshifter.cancel'), 24, [0.5, 0.5]),
            'shapeshifter.cancel',
        )
            .color = new Color(220, 225, 240, 235);
        cancelBtn.addComponent(Button).transition = Button.Transition.NONE;
        cancelBtn.on(Button.EventType.CLICK, () => this.hideShapeshifterPicker(), this);

        this.shapeshifterOverlay = overlay;
    }

    /** Build one tetromino card inside the shapeshifter picker. */
    private buildShapeshifterSlot(
        parent: Node, x: number, y: number, w: number, h: number, type: PieceType,
    ): void {
        const slot = new Node(`SsSlot_${type}`);
        slot.parent = parent;
        slot.layer  = parent.layer;
        const tx = slot.addComponent(UITransform);
        tx.setContentSize(w, h);
        slot.setPosition(x, y, 0);

        const bg = slot.addComponent(Graphics);
        bg.fillColor = new Color(10, 13, 30, 220);
        bg.roundRect(-w / 2, -h / 2, w, h, 10);
        bg.fill();
        const hex = COLORS[type as CellValue] || '#6dd5ff';
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        const accent = new Color(r, g, b, 255);
        bg.strokeColor = accent;
        bg.lineWidth = 2;
        bg.roundRect(-w / 2, -h / 2, w, h, 10);
        bg.stroke();

        // Shape preview — draw the tetromino cells inside the slot.
        const shape = SHAPES[type];
        let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
        for (let rr = 0; rr < shape.length; rr++) {
            for (let cc = 0; cc < shape[rr].length; cc++) {
                if (shape[rr][cc]) {
                    if (rr < minR) minR = rr;
                    if (rr > maxR) maxR = rr;
                    if (cc < minC) minC = cc;
                    if (cc > maxC) maxC = cc;
                }
            }
        }
        if (minR <= maxR) {
            const rows = maxR - minR + 1;
            const cols = maxC - minC + 1;
            const previewW = w * 0.68;
            const previewH = h * 0.50;
            const cell = Math.max(3, Math.floor(Math.min(previewW / cols, previewH / rows)));
            const totalW = cell * cols;
            const totalH = cell * rows;
            const offX = -totalW / 2;
            const offY = totalH / 2 - cell + 12;   // slight upward shift to make room for label
            bg.fillColor = accent;
            for (let rr = 0; rr < rows; rr++) {
                for (let cc = 0; cc < cols; cc++) {
                    if (!shape[minR + rr][minC + cc]) continue;
                    const px = offX + cc * cell;
                    const py = offY - rr * cell;
                    bg.rect(px + 1, py + 1, cell - 2, cell - 2);
                    bg.fill();
                }
            }
        }

        // Whole slot is clickable. (Letter label removed — shape
        // preview alone is enough to identify each tetromino.)
        slot.addComponent(Button).transition = Button.Transition.NONE;
        slot.on(Button.EventType.CLICK, () => this.onShapeshifterPick(type), this);
    }

    private onShapeshifterPick(type: PieceType): void {
        const apply = this.shapeshifterApply;
        this.hideShapeshifterPicker();
        if (!apply) return;
        // Cinematic: chosen shape pops at screen center 3×, holds, then
        // flies + shrinks to the piece-spawn Y (top of the play field).
        // The actual transform (apply(type)) fires when the shape lands,
        // so the player sees the shape "arrive" before the piece changes.
        this._flyShapeThenApply(type, apply);
    }

    /** Fly the chosen tetromino shape from screen center to the piece-
     *  spawn location, then apply the transform. Timing / easing match
     *  the countdown-item pop-and-fly (300ms pop → 500ms hold → 250ms
     *  quadOut → 250ms quadIn → 150ms fade). */
    private _flyShapeThenApply(type: PieceType, apply: (t: PieceType) => void): void {
        const rootNode = this.node;
        // Target = the authored NEXT preview box's on-screen position,
        // converted to the HUD root's local frame. NEXT is where the
        // "upcoming piece" preview lives, so having the freshly-picked
        // shape fly INTO it reads as "this is now your next piece".
        // Falls back to top-center of screen if the @property slot
        // isn't wired (defensive).
        let targetPos = new Vec3(0, 400, 0);
        const rootTx = rootNode.getComponent(UITransform);
        if (this.authoredNextPreviewBox?.parent && rootTx) {
            const parentTx = this.authoredNextPreviewBox.parent.getComponent(UITransform);
            if (parentTx) {
                const worldPos = parentTx.convertToWorldSpaceAR(this.authoredNextPreviewBox.position);
                targetPos = rootTx.convertToNodeSpaceAR(worldPos);
            }
        }
        const midX = targetPos.x * 0.5;
        const midY = targetPos.y * 0.5;

        // Temp wrap centered on screen, holds the shape-preview gfx.
        const fly = new Node('FlyingShapeshifterShape');
        fly.parent = rootNode;
        fly.layer  = rootNode.layer;
        fly.setSiblingIndex(9999);
        const flyTx = fly.addComponent(UITransform);
        flyTx.setContentSize(180, 180);
        flyTx.setAnchorPoint(0.5, 0.5);
        fly.setPosition(0, 0, 0);
        fly.setScale(new Vec3(0, 0, 1));

        const gfxNode = new Node('FlyingShapeshifterGfx');
        gfxNode.parent = fly;
        gfxNode.layer  = fly.layer;
        const gfxTx = gfxNode.addComponent(UITransform);
        gfxTx.setContentSize(180, 180);
        gfxTx.setAnchorPoint(0.5, 0.5);
        gfxNode.setPosition(0, 0, 0);
        const gfx = gfxNode.addComponent(Graphics);
        this._paintTetrominoShape(gfx, type, 180, 180);

        tween(fly)
            // Stage 1: pop 0 → 0.75× at screen center (fast entrance).
            // 0.75× = half of the previous 1.5× peak — earlier version
            // dominated the screen too much for the shape's chunky
            // silhouette.
            .to(0.30, {
                position: new Vec3(0, 0, 0),
                scale:    new Vec3(0.75, 0.75, 1),
            }, { easing: 'backOut' })
            // HOLD 500ms at 0.75×.
            .delay(0.50)
            // Stage 2: continuous glide to target while shrinking.
            // Scale continues to shrink 0.75× → 0.5× so it fits inside
            // the NEXT preview box slot without spilling out.
            // `cubicOut` = smooth deceleration into landing, no
            // mid-flight 0-velocity stutter.
            .to(0.55, {
                position: new Vec3(targetPos.x, targetPos.y, 0),
                scale:    new Vec3(0.5, 0.5, 1),
            }, { easing: 'cubicOut' })
            .call(() => {
                // Apply the transform NOW — the piece changes to this
                // shape and continues falling (or spawns fresh) from
                // its current position. The fake stays visible for the
                // 150ms fade so there's no blank frame at the spawn.
                apply(type);
                const flyOp = fly.getComponent(UIOpacity) ?? fly.addComponent(UIOpacity);
                tween(flyOp)
                    .to(0.15, { opacity: 0 }, { easing: 'quadOut' })
                    .call(() => { if (fly.isValid) fly.destroy(); })
                    .start();
            })
            .start();
    }

    /** Paint one tetromino shape (colored cells for the given type)
     *  centered inside a `w × h` box. Cell size auto-scales so the
     *  shape fits with a small margin. Mirrors the visual style of
     *  the shapeshifter picker slots (see buildShapeshifterSlot). */
    private _paintTetrominoShape(gfx: Graphics, type: PieceType, w: number, h: number): void {
        gfx.clear();
        const shape = SHAPES[type];
        if (!shape) return;
        let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
        for (let rr = 0; rr < shape.length; rr++) {
            for (let cc = 0; cc < shape[rr].length; cc++) {
                if (shape[rr][cc]) {
                    if (rr < minR) minR = rr;
                    if (rr > maxR) maxR = rr;
                    if (cc < minC) minC = cc;
                    if (cc > maxC) maxC = cc;
                }
            }
        }
        if (minR > maxR) return;
        const rows = maxR - minR + 1;
        const cols = maxC - minC + 1;
        const cell = Math.max(3, Math.floor(Math.min(w * 0.85 / cols, h * 0.85 / rows)));
        const totalW = cell * cols;
        const totalH = cell * rows;
        const offX = -totalW / 2;
        const offY = totalH / 2 - cell;
        const hex = COLORS[type as CellValue] || '#6dd5ff';
        const r = parseInt(hex.slice(1, 3), 16);
        const g = parseInt(hex.slice(3, 5), 16);
        const b = parseInt(hex.slice(5, 7), 16);
        gfx.fillColor = new Color(r, g, b, 255);
        for (let rr = 0; rr < rows; rr++) {
            for (let cc = 0; cc < cols; cc++) {
                if (!shape[minR + rr][minC + cc]) continue;
                const px = offX + cc * cell;
                const py = offY - rr * cell;
                gfx.rect(px + 1, py + 1, cell - 2, cell - 2);
                gfx.fill();
            }
        }
    }

    private hideShapeshifterPicker(): void {
        if (this.authoredShapeshifterOverlay) {
            this.authoredShapeshifterOverlay.active = false;
        }
        if (this.shapeshifterOverlay && this.shapeshifterOverlay.isValid) {
            this.shapeshifterOverlay.destroy();
        }
        this.shapeshifterOverlay = null;
        this.shapeshifterApply = null;
        // Un-freeze — pair with the modalPaused = true in showShapeshifterPicker.
        const gs = this.gameController?.gameState;
        if (gs) gs.modalPaused = false;
    }

    /** Authored (Sprite-based) shapeshifter picker path. Wires cards once,
     *  paints per-slot color + shape preview on each open, then activates
     *  the overlay + shows the dim backdrop. */
    private _shapeshifterAuthoredWired: boolean = false;
    private readonly SHAPESHIFTER_ORDER: PieceType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

    private wireAuthoredShapeshifterPicker(): void {
        if (this._shapeshifterAuthoredWired) return;
        // Slot buttons — each fixed to its type via SHAPESHIFTER_ORDER.
        for (let i = 0; i < this.authoredShapeshifterSlotButtons.length; i++) {
            const btn = this.authoredShapeshifterSlotButtons[i];
            if (!btn) continue;
            const type = this.SHAPESHIFTER_ORDER[i];
            if (!type) continue;
            btn.node.off('click');
            btn.node.on('click', () => this.onShapeshifterPick(type), this);
        }
        // Cancel button.
        if (this.authoredShapeshifterCancelButton) {
            const cb = this.authoredShapeshifterCancelButton;
            cb.node.off('click');
            cb.node.on('click', () => this.hideShapeshifterPicker(), this);
            const lab = cb.getComponentInChildren(Label);
            if (lab) this.trackI18nLabel(lab, 'shapeshifter.cancel');
        }
        this._shapeshifterAuthoredWired = true;
    }

    private showAuthoredShapeshifterPicker(): void {
        const overlay = this.authoredShapeshifterOverlay;
        if (!overlay) return;
        this.wireAuthoredShapeshifterPicker();
        // Static labels.
        if (this.authoredShapeshifterTitleLabel)    this.authoredShapeshifterTitleLabel.string    = t('shapeshifter.title');
        if (this.authoredShapeshifterSubtitleLabel) this.authoredShapeshifterSubtitleLabel.string = t('shapeshifter.subtitle');
        // Per-slot content — tint the bg + paint the shape preview.
        const N = Math.min(this.SHAPESHIFTER_ORDER.length, this.authoredShapeshifterSlotButtons.length);
        for (let i = 0; i < N; i++) {
            const type   = this.SHAPESHIFTER_ORDER[i];
            const bg     = this.authoredShapeshifterSlotBackgrounds[i];
            const canvas = this.authoredShapeshifterSlotShapeCanvases[i];
            // Piece colour → tint bg + paint preview.
            const hex   = (COLORS as Record<string, string>)[type as unknown as string] || '#6dd5ff';
            const rC = parseInt(hex.slice(1, 3), 16);
            const gC = parseInt(hex.slice(3, 5), 16);
            const bC = parseInt(hex.slice(5, 7), 16);
            const accent = new Color(rC, gC, bC, 255);
            if (bg)     bg.color = accent;
            if (canvas) this.paintShapeshifterPreview(canvas, type, accent);
        }
        ensureDimBackdrop(overlay);
        overlay.setSiblingIndex(999);
        overlay.active = true;
    }

    /** Paint the tetromino shape preview inside a slot's canvas. Uses a
     *  small Graphics component (adds one if not authored). Same logic
     *  as the legacy `buildShapeshifterSlot` shape-preview loop. */
    private paintShapeshifterPreview(canvas: Node, type: PieceType, accent: Color): void {
        const tx = canvas.getComponent(UITransform) ?? canvas.addComponent(UITransform);
        const w = tx.contentSize.width  || 80;
        const h = tx.contentSize.height || 80;
        const gfx = canvas.getComponent(Graphics) ?? canvas.addComponent(Graphics);
        gfx.clear();
        const shape = SHAPES[type];
        let minR = Infinity, maxR = -Infinity, minC = Infinity, maxC = -Infinity;
        for (let rr = 0; rr < shape.length; rr++) {
            for (let cc = 0; cc < shape[rr].length; cc++) {
                if (shape[rr][cc]) {
                    if (rr < minR) minR = rr;
                    if (rr > maxR) maxR = rr;
                    if (cc < minC) minC = cc;
                    if (cc > maxC) maxC = cc;
                }
            }
        }
        if (minR > maxR) return;
        const rows = maxR - minR + 1;
        const cols = maxC - minC + 1;
        // Fixed reference bbox so unit cells match across all 7 pieces
        // (widest piece = I at 4 wide, tallest = O/T/S/Z/J/L at 2 tall).
        // Previously we divided by the piece's OWN bbox — O (2x2) ended
        // up with cells nearly 2x the size of I (4x1). Uniform reference
        // gives every piece the same unit-cube size + centers the piece
        // within the canvas.
        const REF_COLS = 4;
        const REF_ROWS = 2;
        const cell = Math.max(4, Math.floor(Math.min(w * 0.85 / REF_COLS, h * 0.85 / REF_ROWS)));
        const totalW = cell * cols;
        const totalH = cell * rows;
        const offX = -totalW / 2;
        const offY = totalH / 2 - cell;
        gfx.fillColor = accent;
        for (let rr = 0; rr < rows; rr++) {
            for (let cc = 0; cc < cols; cc++) {
                if (!shape[minR + rr][minC + cc]) continue;
                const px = offX + cc * cell;
                const py = offY - rr * cell;
                gfx.rect(px + 1, py + 1, cell - 2, cell - 2);
                gfx.fill();
            }
        }
    }

    // ============================================================
    //  Pause button + overlay
    // ============================================================
    /** HUD pause button clicked. Toggle `gameState.paused` and reflect
     *  the new state visually (button glyph + overlay). Works for both
     *  level mode and endless mode; no-op when the game isn't running
     *  (menu, game-over popup up, etc). */
    private onPauseButtonClicked(): void {
        const gs = this.gameController?.gameState;
        if (!gs || !gs.running || gs.gameOver) return;
        // Defense-in-depth for the tutorial. The button node itself is
        // hidden in update() while tutorialActive, so this branch is
        // unreachable in the normal touch path; kept here so any non-
        // touch trigger (BackKeyManager, ADB input tap, editor script)
        // can't slip a pause through and derail the tutorial state
        // machine.
        if (gs.tutorialActive) return;
        gs.togglePause();
        this.refreshPauseUi();
    }

    /** Debug cheat — dev-only. Wipes the current level, marks it
     *  cleared, and lets the pending-popup drain kick off the win
     *  popup + transition to the level-select stage. */
    private onDebugWinClicked(): void {
        this.gameController?.debugForceWin();
    }

    /** DEV speed button — cycles gameState.debugSpeedMultOverride from
     *  null → 1× → 2× → ... → 8× → null. Each click bumps +1×, and
     *  hitting the 8× cap wraps back to natural (null) so testers can
     *  compare with the cumulative-derived speed without restarting. */
    private onDebugSpeedClicked(): void {
        const gs = this.gameController?.gameState;
        if (!gs) return;
        const cur = gs.debugSpeedMultOverride;
        let next: number | null;
        if (cur === null || cur === undefined) {
            next = 1.0;
        } else if (cur >= 8.0 - 1e-6) {
            next = null;   // wrap back to natural
        } else {
            next = Math.min(8.0, Math.round(cur + 1.0));
        }
        gs.debugSpeedMultOverride = next;
        // Apply immediately so the current-in-flight piece speeds up
        // without waiting for the next lock's recalc.
        if (next !== null) {
            gs.dropInterval = 800 / next;    // BASE_DROP_INTERVAL_MS
        }
        this.refreshDebugSpeedLabel();
    }

    /** Debug win ("一键通关") button visibility. Hidden in release
     *  builds by construction (wire block skips setup); on dev, also
     *  hides while the "隐藏 DEV 按钮" settings toggle is on. Called
     *  at wire time and on every Settings subscribe fire. */
    private _syncDebugWinButton(): void {
        if (!this.debugWinButtonNode) return;
        const on = IS_DEV_BUILD && !getHideDevButtons();
        if (this.debugWinButtonNode.active !== on) {
            this.debugWinButtonNode.active = on;
        }
    }

    /** Compute effective speed multiplier and gate button visibility. */
    private syncDebugSpeedButton(g: any): void {
        if (!this.debugSpeedButtonNode) return;
        // Hidden in release builds unconditionally. In dev builds the
        // player can also hide it via Settings ("隐藏 DEV 按钮"), so a
        // developer can record clean footage without a rebuild.
        const showable = IS_DEV_BUILD
                      && !getHideDevButtons()
                      && (g.mode === 'endless' || g.mode === 'blind');
        if (this.debugSpeedButtonNode.active !== showable) {
            this.debugSpeedButtonNode.active = showable;
        }
        if (showable) this.refreshDebugSpeedLabel();
    }

    /** Paint current effective drop-speed multiplier on the DEV button.
     *  Shows "Speed 1.2×" or "Speed 1.5× (dev)" — the (dev) suffix means
     *  override is active; without it, we're on the natural cumulative
     *  ramp. Early-out when the value hasn't changed since last paint. */
    private refreshDebugSpeedLabel(): void {
        if (!this.debugSpeedLabel) return;
        const gs = this.gameController?.gameState;
        if (!gs) return;
        const override = gs.debugSpeedMultOverride;
        const cum = gs.endlessProgress?.cumulative ?? 0;
        const natural = Math.min(8.0, 1.0 + Math.floor(cum / 12) * 0.1);
        const effective = override ?? natural;
        // Key includes override flag so switching to/from override
        // triggers a repaint even at the same numeric value.
        const key = effective + (override !== null && override !== undefined ? 0.001 : 0);
        if (Math.abs(key - this._lastPaintedSpeedMult) < 1e-6) return;
        this._lastPaintedSpeedMult = key;
        const suffix = (override !== null && override !== undefined) ? ' (dev)' : '';
        this.debugSpeedLabel.string = `Speed ${effective.toFixed(1)}×${suffix}`;
    }

    /** Sync the pause button glyph + overlay visibility with the current
     *  gameState.paused value. Called after toggling and also on every
     *  frame's update() so external state changes (e.g. picker code
     *  temporarily pausing while the modal is up) stay in sync. */
    private refreshPauseUi(): void {
        const gs = this.gameController?.gameState;
        const paused = !!(gs && gs.paused && gs.running && !gs.gameOver);
        this.pauseUiLastPaused = paused;
        // Freeze / restore the BGM alongside the visual pause. Uses
        // pause()/resume() (not stop/play) so the track picks up mid-
        // measure when the player unpauses instead of restarting.
        const bgm = BgmManager.instance;
        if (bgm) {
            if (paused) bgm.pause();
            else        bgm.resume();
        }
        if (paused) this.showPauseOverlay();
        else        this.hidePauseOverlay();
    }

    /** Per-frame variant: only refreshes the UI when the paused-state
     *  actually flipped since last frame. */
    private syncPauseUi(): void {
        const gs = this.gameController?.gameState;
        const paused = !!(gs && gs.paused && gs.running && !gs.gameOver);
        if (paused === this.pauseUiLastPaused) return;
        this.refreshPauseUi();
    }

    private showPauseOverlay(): void {
        if (!this.authoredPauseOverlay) {
            log('[HudController] authoredPauseOverlay not wired — pause UI will not show');
            return;
        }
        // Lazy-wire on first open (idempotent via _pauseAuthoredWired).
        if (!this._pauseAuthoredWired) {
            this.wireAuthoredPauseOverlay();
            this._pauseAuthoredWired = true;
        }
        // Defensive: force-rewrite the pause labels every show so a
        // previously-used shared modal (e.g., MenuController's confirm
        // dialog) that stamped its own text onto these Labels can't
        // leak through as stale "delete account?" content in the pause
        // popup. Cheap: two string assigns per open.
        if (this.authoredPauseTitleLabel) {
            this.authoredPauseTitleLabel.string = t('pause.title');
        }
        if (this.authoredPauseHintLabel) {
            this.authoredPauseHintLabel.string = t('pause.hint');
        }
        if (this.authoredPauseContinueButton) {
            const lab = this.authoredPauseContinueButton.getComponentInChildren(Label);
            if (lab) lab.string = t('pause.continue');
        }
        if (this.authoredPauseHomeButton) {
            const lab = this.authoredPauseHomeButton.getComponentInChildren(Label);
            if (lab) lab.string = t('pause.home');
        }
        this.pauseOverlay = this.authoredPauseOverlay;
        // Same reason as showFateModal: bump to last sibling so the
        // energy bar / HUD strip / any other later-added child doesn't
        // render over the dim.
        this.pauseOverlay.setSiblingIndex(999);
        this.pauseOverlay.active = true;
    }

    private hidePauseOverlay(): void {
        if (this.pauseOverlay && this.pauseOverlay.isValid) {
            this.pauseOverlay.active = false;
        }
    }

    /** Wire authored pause-overlay button clicks. Called once on the
     *  first showPauseOverlay when authoredPauseOverlay is set. Idempotent
     *  via _pauseAuthoredWired guard so repeat opens don't stack. */
    private _pauseAuthoredWired: boolean = false;
    private wireAuthoredPauseOverlay(): void {
        // Auto-add a Dim backdrop so the pause overlay actually blocks
        // the game underneath (visually + touch). No-op if the user
        // authored their own Dim.
        ensureDimBackdrop(this.authoredPauseOverlay);
        // ---- i18n on the static labels ----
        if (this.authoredPauseTitleLabel) {
            this.trackI18nLabel(this.authoredPauseTitleLabel, 'pause.title');
        }
        if (this.authoredPauseHintLabel) {
            this.trackI18nLabel(this.authoredPauseHintLabel, 'pause.hint');
        }
        if (this.authoredPauseContinueButton) {
            this.authoredPauseContinueButton.node.off('click');
            this.authoredPauseContinueButton.node.on('click', () => {
                const gs = this.gameController?.gameState;
                if (gs) gs.paused = false;
                this.refreshPauseUi();
            }, this);
            const lab = this.authoredPauseContinueButton.getComponentInChildren(Label);
            if (lab) this.trackI18nLabel(lab, 'pause.continue');
        } else {
            log('[HudController] authoredPauseContinueButton not wired');
        }
        if (this.authoredPauseHomeButton) {
            this.authoredPauseHomeButton.node.off('click');
            this.authoredPauseHomeButton.node.on('click', () => {
                const gs = this.gameController?.gameState;
                // Report partial endless/blind progress BEFORE quitting so
                // the player's tower height still counts toward the
                // leaderboard even though they didn't play to game-over.
                // No-op in level mode. Fire-and-forget — network error
                // just logs; we still exit to the mode-select screen.
                this.gameController?.submitEndlessHeightIfApplicable('pause-quit');
                if (gs) gs.paused = false;
                this.hidePauseOverlay();
                this.menuController?.showModeSelect();
            }, this);
            const lab = this.authoredPauseHomeButton.getComponentInChildren(Label);
            if (lab) this.trackI18nLabel(lab, 'pause.home');
        } else {
            log('[HudController] authoredPauseHomeButton not wired');
        }
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
        lab.color = new Color(245, 240, 220, 255);
        // Horizontal alignment from anchor
        if (anchor[0] === 0)   lab.horizontalAlign = Label.HorizontalAlign.LEFT;
        else if (anchor[0] === 1) lab.horizontalAlign = Label.HorizontalAlign.RIGHT;
        else lab.horizontalAlign = Label.HorizontalAlign.CENTER;
        lab.verticalAlign = Label.VerticalAlign.CENTER;
        // Apply the global TTF font (HarmonyOS Sans Condensed) so runtime-
        // created labels match authored ones. FontManager.font is null
        // until the scene's FontManager component's onLoad runs — no-op
        // in that case, label keeps its default system font.
        FontManager.applyToLabel(lab);
        return lab;
    }

    // ============================================================
    //  Collect-mode goal panel
    // ============================================================

    /** Pinned to the top-left of the canvas. Visible only while
     *  gameState.mode === 'collect'. Lists each goal as
     *  `[colour] color  N/M  ✓`. Cheap dirty-check so we don't rebuild
     *  every frame. */
    private refreshCollectPanel(g: GameController['gameState']): void {
        const visible = g.mode === 'collect' && g.collectGoals.length > 0;
        if (!visible) {
            if (this.collectPanel) this.collectPanel.active = false;
            this.collectGoalCache = '';
            return;
        }
        // Goal-set fingerprint: rebuild only when the set itself changes.
        const goalKey = g.collectGoals.map(go => `${go.color}:${go.count}`).join(',');
        if (goalKey !== this.collectGoalCache) {
            this.rebuildCollectPanel(g.collectGoals);
            this.collectGoalCache = goalKey;
            this.lastCollectProgressKey = '';
        }
        if (this.collectPanel) this.collectPanel.active = true;

        // Progress-set fingerprint: refresh count labels only when progress moved.
        const progressKey = g.collectGoals
            .map(go => `${go.color}:${g.collectProgress[go.color] ?? 0}`)
            .join(',');
        if (progressKey === this.lastCollectProgressKey) return;
        this.lastCollectProgressKey = progressKey;
        for (let i = 0; i < g.collectGoals.length; i++) {
            const go = g.collectGoals[i];
            const have = Math.min(go.count, g.collectProgress[go.color] ?? 0);
            const done = have >= go.count;
            const lab = this.collectGoalLabels[i];
            if (lab) lab.string = `${go.color}  ${have}/${go.count}${done ? '  ✓' : ''}`;
        }
    }

    /** Tear down the previous panel (if any) and build a fresh one for
     *  the goal list of the level we just entered. */
    private rebuildCollectPanel(
        goals: ReadonlyArray<{ color: PieceType; count: number }>,
    ): void {
        if (this.collectPanel) {
            this.collectPanel.destroy();
            this.collectPanel = null;
            this.collectGoalLabels = [];
        }
        const canvasNode = director.getScene()?.getComponentInChildren(Canvas)?.node;
        if (!canvasNode) return;
        const canvasTx = canvasNode.getComponent(UITransform);
        if (!canvasTx) return;
        const w = canvasTx.width;
        const h = canvasTx.height;

        const panel = new Node('CollectPanel');
        panel.parent = canvasNode;
        panel.layer  = canvasNode.layer;
        const pTx = panel.addComponent(UITransform);
        const rowH = 32;
        const headH = 30;
        const padX = 12;
        const labelW = 200;
        const panelW = labelW + padX * 2;
        const panelH = headH + goals.length * rowH + 12;
        pTx.setContentSize(panelW, panelH);
        pTx.setAnchorPoint(0, 1);   // top-left anchor
        panel.setPosition(-w / 2 + 12, h / 2 - 12, 0);

        // Background dim panel.
        const bg = new Node('Bg');
        bg.parent = panel;
        bg.layer  = panel.layer;
        const bgTx = bg.addComponent(UITransform);
        bgTx.setContentSize(panelW, panelH);
        bgTx.setAnchorPoint(0, 1);
        bg.setPosition(0, 0, 0);
        const bgG = bg.addComponent(Graphics);
        bgG.fillColor = new Color(8, 12, 24, 200);
        bgG.fillRect(0, -panelH, panelW, panelH);
        bgG.strokeColor = new Color(120, 180, 240, 110);
        bgG.lineWidth = 2;
        bgG.rect(0, -panelH, panelW, panelH);
        bgG.stroke();

        // Header label.
        this.trackI18nLabel(
            this.makeLabel('Header', panel, padX, -16,
                t('collect.header'), 20, [0, 0.5]),
            'collect.header',
        );

        // One row per goal: colour swatch + "<COL> N/M [✓]".
        this.collectGoalLabels = [];
        for (let i = 0; i < goals.length; i++) {
            const yMid = -headH - i * rowH - rowH / 2;
            // Coloured swatch (16×16 square).
            const sw = new Node(`Swatch_${i}`);
            sw.parent = panel;
            sw.layer  = panel.layer;
            const swTx = sw.addComponent(UITransform);
            swTx.setContentSize(16, 16);
            swTx.setAnchorPoint(0, 0.5);
            sw.setPosition(padX, yMid, 0);
            const swG = sw.addComponent(Graphics);
            const hex = COLORS[goals[i].color as CellValue] ?? '#ffffff';
            const col = parseHexColour(hex);
            swG.fillColor = col;
            swG.fillRect(0, -8, 16, 16);

            // Label — populated by refreshCollectPanel.
            const lab = this.makeLabel(`Goal_${i}`, panel,
                padX + 24, yMid,
                `${goals[i].color}  0/${goals[i].count}`, 18, [0, 0.5]);
            this.collectGoalLabels.push(lab);
        }

        this.collectPanel = panel;
    }

    // ================================================================
    //  Backpack quick-use buttons (in-game bomb_block / mini_block)
    // ================================================================

    /** Snapshot of the current per-item count from the last server
     *  fetch. Drives label + button visibility. Zeros mean the button
     *  is disabled + node hidden. */
    private _backpackCounts: { bomb_block: number; mini_block: number; dryer: number; gravity_press: number } =
        { bomb_block: 0, mini_block: 0, dryer: 0, gravity_press: 0 };
    /** Prevents double-tap racing while a consume is in flight. */
    private _backpackConsuming: boolean = false;
    /** Shared cooldown across ALL backpack quick-use items. Using ANY
     *  item locks all four buttons for `_BACKPACK_COOLDOWN_MS`. Value
     *  is the `Date.now()` timestamp when the cooldown lifts; 0 = no
     *  cooldown active. Polled by `_pollBackpackButtonState` (every
     *  frame) so buttons repaint (dim / re-enable) as time elapses. */
    private _backpackCooldownUntilMs: number = 0;
    private static readonly _BACKPACK_COOLDOWN_MS = 10_000;
    /** One-shot flag — the buttons stay wired for the component's
     *  lifetime, so we only bind click listeners once. */
    private _backpackButtonsWired: boolean = false;
    /** Last-seen game-running state — used by the update() poll to
     *  detect running-flag transitions and repaint the backpack quick-
     *  use buttons (they hide on main-menu / game-over, show in-game). */
    private _backpackLastInGame: boolean = false;
    /** Barrier used by the fly-to-NEXT animation flow: the server
     *  consume callback stores a pending applyBackpackNextPieceOverride
     *  closure here; the fly animation's onArrive fires it once the
     *  icon lands in the NEXT-preview box. This gates the visual swap
     *  on arrival so the preview doesn't pre-change mid-flight. */
    private _pendingApply: (() => void) | null = null;
    private _pendingApplyOnArrive: boolean = false;

    /** Called from update() every frame — cheap boolean compare. When
     *  the game's running state flips (menu → play, or play → game-over),
     *  repaint the quick-use buttons so their visibility follows. Also
     *  re-fetches counts on menu → play so a card bought / granted
     *  since the last game surfaces on this run. */
    private _pollBackpackButtonState(): void {
        const gs = this.gameController?.gameState;
        // Match `_paintOneBackpackBtn`'s gate — tutorial hides the
        // quick-use items too, so the transition fires (and buttons
        // re-appear) the moment the tutorial ends.
        const inGame = !!(gs && gs.running && !gs.gameOver && !gs.tutorialActive);
        const stateChanged = inGame !== this._backpackLastInGame;
        if (stateChanged) {
            this._backpackLastInGame = inGame;
            // Off → on: refetch so a fresh grant / chestdrop from the
            // previous session shows up. On → off: just repaint.
            if (inGame) this._refreshBackpackQuickCounts();
            else        this._paintBackpackQuickButtons();
        }
        // Cooldown tick: while a cooldown is active, repaint every
        // frame so the disabled → enabled flip happens the instant
        // the timer elapses (without an extra tap). Clears the field
        // when the deadline passes and does a final repaint so the
        // buttons come back to interactable.
        if (inGame && this._backpackCooldownUntilMs > 0) {
            if (Date.now() >= this._backpackCooldownUntilMs) {
                this._backpackCooldownUntilMs = 0;
                this._paintBackpackQuickButtons();
            } else {
                this._paintBackpackQuickButtons();
            }
        }
    }

    /** Bind click handlers on the bomb_block / mini_block buttons.
     *  Safe to call multiple times — guarded by _backpackButtonsWired.
     *  Also suppresses the global `ui_click` SFX on these buttons —
     *  we play `item_pick` in the handler instead (matches how the
     *  in-game magic-item pick UI sounds). */
    private _wireBackpackQuickButtonsOnce(): void {
        if (this._backpackButtonsWired) return;
        this._backpackButtonsWired = true;
        if (this.authoredBombBlockButton) {
            SoundManager.suppressClickSound(this.authoredBombBlockButton);
            this.authoredBombBlockButton.node.off('click');
            this.authoredBombBlockButton.node.on('click',
                () => this._onBackpackQuickUse('bomb_block'), this);
        }
        if (this.authoredMiniBlockButton) {
            SoundManager.suppressClickSound(this.authoredMiniBlockButton);
            this.authoredMiniBlockButton.node.off('click');
            this.authoredMiniBlockButton.node.on('click',
                () => this._onBackpackQuickUse('mini_block'), this);
        }
        // Dryer + Gravity Press are IMMEDIATE-effect items (no
        // NEXT-piece override, no fly-to-NEXT animation). They go
        // through `_onBackpackImmediateUse` which just consumes then
        // fires the world-effect callback on GameController.
        if (this.authoredDryerButton) {
            SoundManager.suppressClickSound(this.authoredDryerButton);
            this.authoredDryerButton.node.off('click');
            this.authoredDryerButton.node.on('click',
                () => this._onBackpackImmediateUse('dryer'), this);
        }
        if (this.authoredGravityPressButton) {
            SoundManager.suppressClickSound(this.authoredGravityPressButton);
            this.authoredGravityPressButton.node.off('click');
            this.authoredGravityPressButton.node.on('click',
                () => this._onBackpackImmediateUse('gravity_press'), this);
        }
    }

    /** Public — refetches backpack from server and repaints the two
     *  quick-use buttons. Call whenever backpack contents may have
     *  changed (e.g. player just closed the backpack panel). Also
     *  called once from start(). */
    public refreshBackpackQuickCounts(): void {
        this._refreshBackpackQuickCounts();
    }

    /** Extract bomb_block / mini_block counts from a backpack result
     *  and paint. Shared between the cache-hit and network paths. */
    private _applyBackpackSnapshot(items: ReadonlyArray<{ id: string; count: number }>): void {
        const next = { bomb_block: 0, mini_block: 0, dryer: 0, gravity_press: 0 };
        for (const it of items) {
            if (it.id === 'bomb_block')     next.bomb_block     = it.count;
            else if (it.id === 'mini_block')    next.mini_block     = it.count;
            else if (it.id === 'dryer')         next.dryer          = it.count;
            else if (it.id === 'gravity_press') next.gravity_press  = it.count;
        }
        this._backpackCounts = next;
        this._paintBackpackQuickButtons();
    }

    private _refreshBackpackQuickCounts(): void {
        // Cache-first: LoadingController prefetches the backpack during
        // boot, so on the first game-start the cache is usually warm
        // and we can paint synchronously without waiting on the
        // network. Only skip cache if it's stale (> 60 s) — matches
        // the default in getCachedBackpack.
        const cached = getCachedBackpack();
        if (cached) {
            this._applyBackpackSnapshot(cached.items);
            return;
        }
        fetchBackpack()
            .then((r) => this._applyBackpackSnapshot(r.items))
            .catch((err) => {
                // Silent — same treatment as BackpackController.refresh.
                console.warn('[HUD] backpack fetch failed:', err?.message || err);
            });
    }

    /** Paint button visibility + count label based on the current
     *  snapshot. Hides the whole button node when count == 0 so the
     *  HUD doesn't clutter with unusable icons. */
    private _paintBackpackQuickButtons(): void {
        this._paintOneBackpackBtn(
            this.authoredBombBlockButton,
            this.authoredBombBlockCountLabel,
            this._backpackCounts.bomb_block,
        );
        this._paintOneBackpackBtn(
            this.authoredMiniBlockButton,
            this.authoredMiniBlockCountLabel,
            this._backpackCounts.mini_block,
        );
        this._paintOneBackpackBtn(
            this.authoredDryerButton,
            this.authoredDryerCountLabel,
            this._backpackCounts.dryer,
        );
        this._paintOneBackpackBtn(
            this.authoredGravityPressButton,
            this.authoredGravityPressCountLabel,
            this._backpackCounts.gravity_press,
        );
    }

    private _paintOneBackpackBtn(
        btn: Button | null,
        countLab: Label | null,
        count: number,
    ): void {
        // Gate the whole quick-use button on the game actually being
        // running: main menu / pause menu / game-over screens hide
        // the button entirely. In-game the button is always visible
        // (greyed when count == 0 — see color tint below) so the
        // player learns that the slot exists even when empty.
        const gs = this.gameController?.gameState;
        // Hide during tutorial — new players are learning the base
        // mechanics; showing quick-use items on top of that adds
        // buttons the tutorial doesn't mention and can trap them.
        const inGame = !!(gs && gs.running && !gs.gameOver && !gs.tutorialActive);
        const cooling = this._backpackCooldownActive();
        if (btn) {
            btn.node.active = inGame;
            btn.interactable = inGame && count > 0 && !this._backpackConsuming && !cooling;
            // 无卡态：中灰 tint 视觉近似脱色（Sprite.color 是乘法混
            // 色，RGB 通道压到相同值就会显得饱和度低）。有卡时恢复
            // 白色 = 原纹理色。冷却中同样压色以示"暂不可用"。
            const dim = count === 0 || cooling;
            const tint = dim
                ? new Color(120, 120, 120, 255)
                : new Color(255, 255, 255, 255);
            const sprites = btn.node.getComponentsInChildren(Sprite);
            for (const spr of sprites) spr.color = tint;
        }
        if (countLab) {
            // While a cooldown is active, show the remaining seconds
            // in-place of the count so the player has a clear countdown.
            if (cooling) {
                const remaining = Math.max(0, Math.ceil((this._backpackCooldownUntilMs - Date.now()) / 1000));
                countLab.string = `${remaining}s`;
            } else {
                countLab.string = String(count);
            }
            countLab.node.active = inGame;
            countLab.color = (count > 0 && !cooling)
                ? new Color(255, 255, 255, 255)
                : new Color(150, 150, 150, 255);
        }
    }

    /** True while the shared backpack cooldown timer hasn't elapsed. */
    private _backpackCooldownActive(): boolean {
        return this._backpackCooldownUntilMs > 0
            && Date.now() < this._backpackCooldownUntilMs;
    }

    /** Kick off (or refresh) the shared 10 s cooldown. Called on
     *  every successful `consumeBackpackItem`, whether the item was
     *  a NEXT-piece modifier (bomb/mini) or an immediate-effect
     *  world FX (dryer/gravity_press). */
    private _startBackpackCooldown(): void {
        this._backpackCooldownUntilMs = Date.now() + HudController._BACKPACK_COOLDOWN_MS;
    }

    /** Fly-to-NEXT animation for a backpack quick-use tap. Clones
     *  the tapped button node into a temp visual, pops it up at
     *  canvas centre, then shrinks + slides into the NEXT-piece
     *  preview box. Fully self-cleaning: destroys the temp node
     *  when the tween chain resolves.
     *
     *  Fails gracefully as a no-op if the source button, canvas, or
     *  next-preview box isn't wired — the consume flow still runs.
     */
    private _playItemUseAnimation(sourceBtn: Button | null, onArrive?: () => void): void {
        if (!sourceBtn || !sourceBtn.node) {
            // No source → skip animation but still fire the effect so
            // the item isn't stuck in armed-but-not-visible limbo.
            if (onArrive) onArrive();
            return;
        }
        if (!this.authoredNextPreviewBox) {
            if (onArrive) onArrive();
            return;
        }
        // Walk up until we find the Canvas — the temp node parents
        // there so it draws above everything else in the HUD.
        let canvas: Node | null = sourceBtn.node.parent;
        while (canvas && !canvas.getComponent(Canvas)) canvas = canvas.parent;
        if (!canvas) return;
        const canvasTx = canvas.getComponent(UITransform);
        if (!canvasTx) return;

        // Clone the whole button node — preserves its background +
        // icon + count label + fog so the flying visual matches
        // exactly what the player just tapped.
        const fx = instantiate(sourceBtn.node);
        // Strip anything that could re-fire the click or auto-reposition.
        const btnComp = fx.getComponent(Button);
        if (btnComp) btnComp.destroy();
        const widget = fx.getComponent(Widget);
        if (widget) widget.destroy();
        // Sanitize name so scene diffs are easier to eyeball.
        fx.name = 'BackpackUseFX';
        fx.parent = canvas;
        fx.layer = canvas.layer;
        // Top of z-order.
        fx.setSiblingIndex(canvas.children.length - 1);

        // Convert the NEXT-preview box's world position to canvas-
        // local so the tween's target position lives in the same
        // frame as fx's own transform.
        const nextBoxWorld = this.authoredNextPreviewBox.worldPosition;
        const nextBoxLocal = new Vec3();
        canvasTx.convertToNodeSpaceAR(nextBoxWorld, nextBoxLocal);

        // Start: canvas centre, hidden (scale 0). backOut easing on
        // the pop gives a nice snappy overshoot.
        fx.setPosition(0, 0, 0);
        fx.setScale(0, 0, 1);

        tween(fx)
            // Pop: 0 → 1.4 in ~150 ms, overshoot.
            .to(0.15, { scale: new Vec3(1.4, 1.4, 1) }, { easing: 'backOut' })
            // Fly: shrink to 0.25 while sliding to NEXT-preview box.
            .to(0.4, {
                scale: new Vec3(0.25, 0.25, 1),
                position: nextBoxLocal,
            }, { easing: 'quadIn' })
            .call(() => {
                // Fire the arrival hook FIRST — this is what actually
                // swaps the NEXT-preview visual to the item's effect
                // (1×1 bomb/mini). Keeping the visual swap gated on
                // arrival makes the icon "become" the next piece in
                // a single readable beat instead of the preview
                // pre-changing while the icon is still mid-flight.
                if (onArrive) onArrive();
                if (fx && fx.isValid) fx.destroy();
            })
            .start();
    }

    /** Handler for either quick-use button. Server-authoritative:
     *  consume 1 → on success arm GameState.pendingNextPieceModifier
     *  via applyBackpackNextPieceOverride so the HUD next-preview
     *  reflects the transformation. */
    private _onBackpackQuickUse(id: 'bomb_block' | 'mini_block'): void {
        if (this._backpackConsuming) return;
        if (this._backpackCooldownActive()) {
            console.log(`[HUD] backpack quick-use ${id}: cooldown active, ignored`);
            return;
        }
        const gs = this.gameController?.gameState;
        if (!gs || !gs.running || gs.gameOver) {
            // Buttons should be inactive in this case anyway, but
            // guard against a stale click.
            console.warn('[HUD] backpack quick-use: game not running');
            return;
        }
        // Play the item-pick SFX (same one the in-game magic-item
        // picker uses) instead of the default ui_click — matches
        // player expectation that "using an item" is an item action,
        // not a plain UI tap. Fires optimistically before the network
        // round-trip so the sound feels tied to the click, not the
        // response.
        SoundManager.instance?.play('item_pick');
        // Fly-to-NEXT animation runs in parallel with the server
        // consume. The applyBackpackNextPieceOverride call inside
        // the consume .then() below waits on _pendingApplyOnArrive,
        // which the animation flips once the icon lands in the
        // NEXT-preview box — this way the preview visual doesn't
        // pre-change while the icon is still mid-flight.
        this._pendingApplyOnArrive = false;
        this._playItemUseAnimation(
            id === 'bomb_block' ? this.authoredBombBlockButton : this.authoredMiniBlockButton,
            () => {
                this._pendingApplyOnArrive = true;
                if (this._pendingApply) {
                    this._pendingApply();
                    this._pendingApply = null;
                }
            },
        );
        // Optimistic UI: grey out immediately.
        this._backpackConsuming = true;
        this._paintBackpackQuickButtons();
        consumeBackpackItem(id)
            .then((r) => {
                this._backpackConsuming = false;
                // Trust the server's new count.
                this._backpackCounts[id] = r.count;
                // Start the shared cooldown — all four quick-use
                // buttons stay disabled until this deadline passes.
                this._startBackpackCooldown();
                const mod = (id === 'mini_block' ? 'mini' : 'bomb') as 'mini' | 'bomb';
                // Arm the modifier field now (game logic can react to
                // the arm — currently just cleared by
                // applyBackpackNextPieceOverride, harmless to set early).
                gs.pendingNextPieceModifier = mod;
                // Gate the VISUAL swap of the NEXT-preview on the
                // fly-to-NEXT animation reaching the preview box.
                // If the animation already arrived (short server
                // round-trip → consume returns AFTER onArrive),
                // apply immediately. Otherwise stash the closure and
                // let onArrive fire it.
                const applyOverride = () => {
                    gs.applyBackpackNextPieceOverride?.(mod);
                };
                if (this._pendingApplyOnArrive) {
                    applyOverride();
                    this._pendingApply = null;
                } else {
                    this._pendingApply = applyOverride;
                }
                this._paintBackpackQuickButtons();
            })
            .catch((err) => {
                this._backpackConsuming = false;
                console.warn('[HUD] consume', id, 'failed:', err?.message || err);
                // Clear the arrival barrier so a stale pending closure
                // from a prior tap doesn't fire later.
                this._pendingApply = null;
                // Refresh to sync the client with server's real counts —
                // maybe the item was consumed elsewhere.
                this._refreshBackpackQuickCounts();
            });
    }

    /** Immediate-effect backpack items (dryer / gravity_press) — no
     *  NEXT-piece override + no fly-to-NEXT animation. Guards against
     *  double-tap, consumes on server first, then dispatches to a
     *  GameController hook that runs the actual world effect (pause
     *  piece → animate → mutate board → resume).
     *
     *  Rejection paths:
     *    • Not in game / paused → warn + no-op.
     *    • Server consume failed → refresh counts + no effect fired
     *      (the client thought it had one but the server disagreed;
     *      wallet stays authoritative).
     *  */
    private _onBackpackImmediateUse(id: 'dryer' | 'gravity_press'): void {
        if (this._backpackConsuming) return;
        if (this._backpackCooldownActive()) {
            console.log(`[HUD] backpack immediate-use ${id}: cooldown active, ignored`);
            return;
        }
        const gc = this.gameController;
        const gs = gc?.gameState;
        if (!gc || !gs || !gs.running || gs.gameOver) {
            console.warn('[HUD] backpack immediate-use: game not running');
            return;
        }
        SoundManager.instance?.play('item_pick');
        this._backpackConsuming = true;
        this._paintBackpackQuickButtons();
        consumeBackpackItem(id)
            .then((r) => {
                this._backpackConsuming = false;
                this._backpackCounts[id] = r.count;
                // Start the shared 10 s cooldown so the player can't
                // spam multiple items back-to-back.
                this._startBackpackCooldown();
                this._paintBackpackQuickButtons();
                // Fire the actual world effect on GameController.
                if (id === 'dryer' && typeof (gc as any).applyDryerFromBackpack === 'function') {
                    (gc as any).applyDryerFromBackpack();
                } else if (id === 'gravity_press' && typeof (gc as any).applyGravityPressFromBackpack === 'function') {
                    (gc as any).applyGravityPressFromBackpack();
                } else {
                    console.warn(`[HUD] no GameController hook for ${id}`);
                }
            })
            .catch((err) => {
                this._backpackConsuming = false;
                console.warn('[HUD] consume', id, 'failed:', err?.message || err);
                this._refreshBackpackQuickCounts();
            });
    }
}

/** Tiny hex→Color util used by the collect-panel swatch. */
function parseHexColour(hex: string): Color {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return new Color(255, 255, 255, 255);
    const n = parseInt(m[1], 16);
    return new Color((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255);
}
