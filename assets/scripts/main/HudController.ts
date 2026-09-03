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
    director,
    Font,
    tween,
    log,
} from 'cc';
import { ensureDimBackdrop } from './UiHelpers';
import { GameController } from './GameController';
import { ToastManager } from './ToastManager';
// NOTE: MenuController is referenced via getComponent('MenuController')
// at runtime (string-lookup) — direct import would create a circular
// dependency (HudController → MenuController → HudController) that
// Rollup rejects at build time.
import { ITEM_KEYS, ITEM_BASE_PROBS, MagicItemKey, ENERGY_FULL_THRESHOLD, COLORS, SHAPES, PieceType, CellValue, COLS } from '../core/Constants';
import { FATE_SHAPES, fateIndexOfShape, pickFateIndex, pickFateIndex4Connected, FATE_SHAPES_4CONNECTED_INDICES, fateShapeAsCustomPiece } from '../core/FateShapes';
import { CustomPieceDef, LevelData } from '../core/Types';
import { getKeysMode, subscribe as subscribeSettings } from '../core/Settings';
import { BgmManager } from '../audio/BgmManager';
import { FontManager } from '../core/FontManager';
import { SoundManager } from '../audio/SoundManager';
import { t, subscribe as subscribeI18n } from '../core/i18n/I18n';
import { fetchRefreshCost, purchaseRefresh, RefreshType } from '../core/RefreshApi';
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

/** Rarity tier — drives the picker card's colour, border, and badge so
 *  players can read "did I roll something good?" at a glance. Thresholds
 *  align with ITEM_BASE_PROBS: utility items at the top of the pool are
 *  普通, mid-pool items are 稀有, bottom-pool family tier-3 entries are
 *  史诗. Computed at module load. */
type Rarity = 'common' | 'uncommon' | 'rare' | 'epic';
function rarityForKey(key: MagicItemKey): Rarity {
    const p = ITEM_BASE_PROBS[key] ?? 0;
    if (p >= 0.10) return 'common';
    if (p >= 0.05) return 'uncommon';
    if (p >= 0.02) return 'rare';
    return 'epic';
}
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

    @property({ type: Button, tooltip: '直接开始按钮（点击 → 确认当前形状进入游戏）' })
    authoredFateStartButton: Button | null = null;

    @property({ type: Button, tooltip: '"消耗宝石刷新"按钮（本命方块弹窗）— 点击 → 服务器扣宝石 + 客户端重新 roll。可空。' })
    authoredFatePaidRefreshButton: Button | null = null;

    @property({ type: Label, tooltip: '"消耗宝石刷新"按钮上的 Label（脚本会写"💎 N"）— 可空，会自动 getComponentInChildren 找。' })
    authoredFatePaidRefreshLabel: Label | null = null;

    @property({ type: Label, tooltip: '按钮下面的提示文字（可选）' })
    authoredFateHintLabel: Label | null = null;

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
    private refreshesUsedThisFull = 0;       // resets when picker closes
    private hooksWired = false;

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
    private fateLevelOrder = 0;
    /** Set by showFateModal when the entry is endless (no level-assigned
     *  fate piece). Restricts the reroll button to the 4-connected
     *  subset so the player never ends up with a dead-lock shape. */
    private fateIsEndlessEntry = false;
    private fateButtonsGroup!: Node;
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
    }

    start(): void {
        if (!this.gameController) {
            log('[TowerBlocks] HudController ERROR — gameController not assigned.');
            return;
        }
        this.buildUi();
        this.wireGameStateHooks();
        // Subscribe to language changes so static labels re-translate
        // and open modals repaint their dynamic content (item names,
        // rarity badges, etc.).
        this.i18nUnsub = subscribeI18n(() => this.onLangChanged());
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
        // Debug win button follows HUD visibility, but only if this is
        // a dev build. Release builds keep it forever-hidden.
        if (this.authoredDebugWinButton) {
            this.authoredDebugWinButton.node.active = on && IS_DEV_BUILD;
        }
        // Score container / label — respect the endless-only rule.
        // When on=true, only show if we're in endless mode; otherwise
        // keep hidden so it doesn't flash visible for one frame before
        // refreshHud fires. When on=false (going to menu), always hide.
        const scoreTarget = this.authoredScoreLabel?.node ?? null;
        if (scoreTarget) {
            const mode = this.gameController?.gameState?.mode;
            // Endless AND blind mode both use the height-based scoring
            // display — both should show 层高 in the top-right.
            const showsHeight = mode === 'endless' || mode === 'blind';
            scoreTarget.active = on && showsHeight;
        }
        if (this.authoredNextPreviewBox) this.authoredNextPreviewBox.active = on;
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
                this.refreshesUsedThisFull = 0;
                this.showPicker(choices);
            },
            onEnergyPickerClose: () => {
                prev.onEnergyPickerClose?.();
                this.hidePicker();
            },
        };
        this.hooksWired = true;
    }

    update(_dt: number): void {
        if (!this.gameController || !this.gameController.gameState) return;
        // Subscribe lazily — GameController may build gameState after our start().
        if (!this.hooksWired) this.wireGameStateHooks();
        const g = this.gameController.gameState;

        // Keep the pause button glyph + overlay in sync with the actual
        // gameState.paused. External code (energy picker, fate modal)
        // can toggle `paused` outside our button handler, and we want
        // the UI to reflect that immediately. Cheap early exit when
        // nothing changed keeps this from thrashing.
        this.syncPauseUi();

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
        //   • Endless — shows 层高 (cumulative full rows = tower height)
        //   • Level / Collect — hidden (the mode label + lines tell the story)
        // The score field still exists internally so item snapshots /
        // rewind don't churn; it just isn't rendered.
        if (this.scoreLabel) {
            const scoreTarget = this.scoreLabel.node;
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
        // (assets/scripts/core/BuildConfig.ts).
        if (this.authoredDebugWinButton) {
            if (!IS_DEV_BUILD) {
                this.authoredDebugWinButton.node.active = false;
            } else {
                this.authoredDebugWinButton.node.off('click');
                this.authoredDebugWinButton.node.on('click', () => this.onDebugWinClicked(), this);
                this.debugWinButtonNode = this.authoredDebugWinButton.node;
                const lab = this.authoredDebugWinButton.getComponentInChildren(Label);
                if (lab) this.trackI18nLabel(lab, 'debug.forceWin');
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
        const nextBoxTx = nextBox.getComponent(UITransform);
        const ROW_GAP = 8;
        const HG_WRAP_WIDTH  = 180;     // matches gatling/meteor readouts
        const HG_WRAP_HEIGHT = 80;      // matches gatling/meteor readouts (12px digits)
        const bottomY = nextBoxTx
            ? -nextBoxTx.contentSize.height * nextBoxTx.anchorPoint.y
            : 0;
        const hgTopY = bottomY - ROW_GAP;

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

    private updateRefreshButtonLabel(): void {
        // 1st refresh is free; subsequent ones cost an ad watch (UI gate
        // not implemented yet — we just keep refreshing for now and the
        // label communicates the future cost).
        const txt = this.refreshesUsedThisFull === 0
            ? t('picker.refresh')
            : t('picker.adRefresh');
        if (this.authoredPickerRefreshLabel) this.authoredPickerRefreshLabel.string = txt;
        if (this.refreshBtnLabel) this.refreshBtnLabel.string = txt;
    }

    // ---- Authored (Sprite-based) picker path ----
    private _pickerAuthoredWired: boolean = false;
    /** Cached keys for the 2 authored slots — used by onSlotClicked (which
     *  reads pickerSlotKeys). Same array as the legacy path (both fill it),
     *  so slot-click routing already works without duplicating fields. */
    private wireAuthoredPicker(): void {
        if (this._pickerAuthoredWired) return;
        // Slot buttons + inject icon/star children lazily on first show.
        // The scene has authored bg + labels but no PNG icon or tier stars
        // — we build those at runtime so no editor rewiring is needed.
        for (let i = 0; i < this.authoredPickerSlotButtons.length; i++) {
            const btn = this.authoredPickerSlotButtons[i];
            if (!btn) continue;
            btn.node.off('click');
            btn.node.on('click', () => this.onSlotClicked(i), this);
            this._injectPickerIconAndStars(btn.node, i);
        }
        // Refresh button.
        if (this.authoredPickerRefreshButton) {
            const rb = this.authoredPickerRefreshButton;
            rb.node.off('click');
            rb.node.on('click', () => this.onRefreshClicked(), this);
        }
        // Paid refresh (spend gems). Cost fetched from server on every
        // picker-open (see `refreshPickerPaidCost`).
        if (this.authoredPickerPaidRefreshButton) {
            this.authoredPickerPaidRefreshButton.node.off('click');
            this.authoredPickerPaidRefreshButton.node.on('click',
                () => this.onPickerPaidRefreshClicked(), this);
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
        // Fetch + paint the paid-refresh cost every time the picker
        // opens (server may have rebalanced).
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
        // TODO(ads): when refreshesUsedThisFull > 0, gate behind a successful
        // ad-watch callback. For now we always allow the refresh.
        g.refreshEnergyPicker();
        this.refreshesUsedThisFull++;
        this.updateRefreshButtonLabel();
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
                this.onFateReroll();
            }, this);
            const lab = this.authoredFateRerollButton.getComponentInChildren(Label);
            if (lab) this.trackI18nLabel(lab, 'fate.reroll');
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
        const w = shape[0].length;
        let minR = h, maxR = -1, minC = w, maxC = -1;
        for (let r = 0; r < h; r++) {
            for (let c = 0; c < w; c++) {
                if (shape[r][c]) {
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
        // Canvas dimensions match the NextShape node (PREVIEW_W - 16, PREVIEW_H - 30).
        const CANV_W = 124;
        const CANV_H = 60;
        const cell = Math.floor(Math.min((CANV_W - 8) / bw, (CANV_H - 8) / bh));
        const totalW = cell * bw, totalH = cell * bh;
        const offX = -totalW / 2;
        const offY =  totalH / 2 - cell;
        const base = this.hexToCcColor(COLORS[type as CellValue] || '#6dd5ff');
        const tileSf = this.authoredSmallBlockSprite;
        for (let r = 0; r < h; r++) {
            for (let c = 0; c < w; c++) {
                if (!shape[r][c]) continue;
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

        const shape = FATE_SHAPES[this.fateCurrentIdx];
        if (!shape || !shape.length) return;
        const h = shape.length, w = shape[0].length;
        const PREV = 240;
        // Fixed reference bbox — all 99 fate shapes cap at 4×4. Divide
        // by the ref (not the per-shape w/h) so every shape uses the
        // SAME unit cell size. Smaller shapes get centered with unused
        // space around them instead of blowing up their cells to fill.
        const REF_W = 4, REF_H = 4;
        const cell = Math.floor(Math.min(PREV / REF_W, PREV / REF_H));
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
            for (let c = 0; c < w; c++) {
                if (!shape[r][c]) continue;
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
        // No pre-assigned shape (endless mode passes `customPiece: null`)
        // → roll a random fate piece from the 4-connected subset only.
        // 8-connected shapes (diagonals like ▞) leave tiny isolated
        // holes when they land on an uneven stack — almost guaranteed
        // dead-locks in the long-haul endless mode. The full 8-connected
        // pool stays available for level mode (where the designer hand-
        // picks the piece) via the index already resolved above.
        if (idx < 0) {
            const pool = FATE_SHAPES_4CONNECTED_INDICES;
            idx = pool.length > 0
                ? pool[Math.floor(Math.random() * pool.length)]
                : Math.floor(Math.random() * FATE_SHAPES.length);
        }
        this.fateCurrentIdx  = idx;
        this.fateCurrentBase = (cp && cp.baseType) || (['I','O','T','S','Z','J','L'] as PieceType[])[idx % 7];
        this.fateLevelOrder  = level.order || 0;
        // Track whether this modal was opened as an endless entry (no
        // pre-assigned shape) — affects the reroll button's pool.
        this.fateIsEndlessEntry = !cp;
        this.fateResolve = onStart;
        this.fateCancel  = onCancel || null;
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
        // Async: fetch the current gem cost + paint the paid-refresh
        // button label. Runs after the modal is on screen so the user
        // sees a placeholder ("💎 …") until the number lands.
        this.refreshPaidRefreshLabel('fate');
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

    private refreshFateSubtitle(): void {
        if (!this.fateSubLab) return;
        let cellCount = 0;
        const s = FATE_SHAPES[this.fateCurrentIdx];
        for (let r = 0; r < s.length; r++) {
            for (let c = 0; c < s[r].length; c++) {
                if (s[r][c]) cellCount++;
            }
        }
        // Level mode: show the floor number instead of the level order.
        // Game convention — no "levels", only "floors": level order 1 is
        // the TOP of the 99-floor tower (floor 99), level order 99 is the
        // bottom (floor 1). Hardcode 100 (= totalLevels + 1) since
        // HudController doesn't have flatLevels; if you ever change the
        // total level count away from 99, update the 100 below.
        const prefix = this.fateIsEndlessEntry
            ? t('fate.endlessSub')
            : t('level.floor', { n: this.fateLevelOrder ? (100 - this.fateLevelOrder) : '?' });
        this.fateSubLab.string = t('fate.subtitle', { tag: prefix, n: cellCount });
    }

    // ============================================================
    //  Paid refresh (spend gems to re-roll)
    // ============================================================
    /** Cost cache — set from server on modal open, read on button click.
     *  Kept as `null` when the fetch is in flight or failed so the
     *  click handler can bail rather than firing a purchase with a
     *  stale/zero cost. */
    private _paidRefreshCost: Partial<Record<RefreshType, number>> = {};

    /** Fetch the server-configured cost for `type` and paint it onto
     *  the corresponding button label. Called from showFateModal /
     *  showAuthoredPicker. Silent no-op if the button isn't wired. */
    private refreshPaidRefreshLabel(type: RefreshType): void {
        const btn = type === 'fate'
            ? this.authoredFatePaidRefreshButton
            : this.authoredPickerPaidRefreshButton;
        const lab = type === 'fate'
            ? (this.authoredFatePaidRefreshLabel ?? btn?.getComponentInChildren(Label) ?? null)
            : (this.authoredPickerPaidRefreshLabel ?? btn?.getComponentInChildren(Label) ?? null);
        if (!btn) return;
        // Placeholder text while fetch is in flight. Just the number,
        // no gem icon — icon should live on the button prefab as a
        // separate Sprite child, not baked into the label.
        if (lab) lab.string = '…';
        this._paidRefreshCost[type] = undefined;
        fetchRefreshCost(type)
            .then((r) => {
                this._paidRefreshCost[type] = r.gems;
                if (lab) lab.string = `${r.gems}`;
            })
            .catch((err) => {
                console.warn(`[HUD] fetchRefreshCost(${type}) failed:`, err?.message);
                if (lab) lab.string = '?';
            });
    }

    /** Fate paid refresh click — spend gems on the server, then trigger
     *  the local re-roll on success. Toast the error on failure. */
    private onFatePaidRefreshClicked(): void {
        const cost = this._paidRefreshCost.fate;
        if (cost === undefined) {
            console.warn('[FateModal] paid refresh clicked before cost loaded');
            return;
        }
        purchaseRefresh('fate')
            .then((r) => {
                console.log(`[FateModal] paid refresh OK — spent=${r.gemsSpent} balance=${r.balance}`);
                this.onFateReroll();
            })
            .catch((err) => this.handlePaidRefreshError(err, cost));
    }

    /** Picker paid refresh click — spend gems, then re-roll the two
     *  choices via GameState.refreshEnergyPicker (bypasses the free /
     *  ad-gated path). */
    private onPickerPaidRefreshClicked(): void {
        const cost = this._paidRefreshCost.magic;
        if (cost === undefined) {
            console.warn('[Picker] paid refresh clicked before cost loaded');
            return;
        }
        purchaseRefresh('magic')
            .then((r) => {
                console.log(`[Picker] paid refresh OK — spent=${r.gemsSpent} balance=${r.balance}`);
                this.gameController?.gameState?.refreshEnergyPicker();
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
        this.refreshFateSubtitle();
        this.drawFateShape();
    }

    private onFateConfirm(): void {
        const resolve = this.fateResolve;
        const picked  = fateShapeAsCustomPiece(this.fateCurrentIdx, this.fateCurrentBase);
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

    /** Compute effective speed multiplier and gate button visibility. */
    private syncDebugSpeedButton(g: any): void {
        if (!this.debugSpeedButtonNode) return;
        const showable = IS_DEV_BUILD && (g.mode === 'endless' || g.mode === 'blind');
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
}

/** Tiny hex→Color util used by the collect-panel swatch. */
function parseHexColour(hex: string): Color {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex);
    if (!m) return new Color(255, 255, 255, 255);
    const n = parseInt(m[1], 16);
    return new Color((n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff, 255);
}
