/**
 * BackpackController — 4×4 backpack inventory panel.
 *
 * The 16-slot grid is a FIXED-SIZE container. What items appear and in
 * what count is decided by the SERVER: on show(), we hit
 * `GET /player/backpack` (see BackpackApi.ts) and paint the first N
 * slots with the returned items in the order the server gave them.
 * Remaining slots stay empty (no icon, no count).
 *
 * BACKPACK ITEMS (3 total — the old 22 magic items are NOT shown here;
 * they stay live in the HUD quick-bar / chestdrop pipeline but the
 * backpack surface is now a separate small catalog):
 *
 *   • mini_block   — next spawned piece is forced to a 1×1 single cube
 *                    (uses GameState.pendingNextPieceModifier = 'mini')
 *   • bomb_block   — next spawned piece is forced to a 1×1 CUBE flagged
 *                    as a bomb; on lock it clears a same-layer 3×3 area
 *                    (Bombs.ts kind 'box3')
 *   • rename_card  — closes the backpack + jumps to the profile rename
 *                    entry; the rename endpoint gates on backpack card
 *                    ownership now, the 7-day cooldown is retired.
 *
 * Icon resolution is client-side art — the server returns item ids
 * (matching the 3 backpack ids above), and we look up the matching
 * SpriteFrame via the authored `iconCatalog*` parallel arrays.
 *
 * i18n:
 *   • Item name  ← `t('item.${id}')`   (item.mini_block / item.bomb_block / item.rename_card)
 *   • Item desc  ← `t('desc.${id}')`   (desc.mini_block / desc.bomb_block / desc.rename_card)
 * Add these keys in every locale dict when swapping the icon catalog.
 *
 * Suggested Inspector wiring:
 *   1. Authored Panel              = the root panel Node
 *   2. Authored Close Button       = ✕ button in the header
 *   3. Authored Slot Buttons       = 16 Button components in row-major
 *      order (top-left first, bottom-right last)
 *   4. Authored Slot Icon Sprites  = the icon Sprite child of each slot
 *   5. Authored Slot Count Labels  = the "×N" Label child of each slot
 *   6. Authored Slot Selected Nodes = per-slot highlight/frame node
 *      (hidden by default; toggled on for the currently-selected slot).
 *      Optional — leave empty for no visual selection state.
 *   7. Icon Catalog Keys           = 3 strings: mini_block / bomb_block /
 *      rename_card (order arbitrary but must match Icon Catalog Icons)
 *   8. Icon Catalog Icons          = 3 matching SpriteFrames, same order
 *      as (7) — this is the id → icon lookup table
 *   9. Authored Detail Panel       = the popup Node
 *  10. Authored Detail Icon        = big icon Sprite in the popup
 *  11. Authored Detail Name Label  = item name Label
 *  12. Authored Detail Count Label = "×N" Label
 *  13. Authored Detail Desc Label  = description Label
 *  14. Authored Detail Use Button  = "使用" button inside the popup;
 *      wired here to consume 1 copy on the server and apply the
 *      item's effect (mini_block/bomb_block → arm next-piece modifier;
 *      rename_card → close panel + open rename UI). Disabled while
 *      the consume request is in flight.
 *  15. Authored Detail Card        = the visible card container node
 *      inside the popup (the box that holds icon/name/desc/use button).
 *      Wired so BlockInputEvents is attached — clicks INSIDE the card
 *      don't leak to the dim backdrop → don't accidentally close the
 *      popup. Leave empty for old scenes; the whole popup then acts
 *      as its own click-catcher (Use button still fires OK, but ANY
 *      tap inside the card region also closes).
 *  16. Authored Detail Close Button= (DEPRECATED) popup close button.
 *      Kept for scene backward-compat. New design uses tap-outside-
 *      the-card to close (a full-screen dim backdrop is auto-added
 *      as a child of authoredDetailPanel via ensureDimBackdrop, then
 *      wired to fire close on TOUCH_END). Recommend leaving empty
 *      and hiding / removing the ✕ button from the scene.
 *
 * Opening flow: whoever owns the "open backpack" button (MenuController
 * or HudController) just calls `backpack.show()` — no arguments. The
 * component owns the fetch + repaint lifecycle.
 */

import {
    _decorator,
    Component,
    Node,
    Button,
    Sprite,
    SpriteFrame,
    Label,
    BlockInputEvents,
    Graphics,
} from 'cc';
import { t } from '../core/i18n/I18n';
import {
    fetchBackpack,
    consumeBackpackItem,
    BackpackItem,
} from '../core/BackpackApi';
import { GameController } from './GameController';
import { ensureDimBackdrop } from './UiHelpers';
import { SoundManager } from '../audio/SoundManager';

/** The 3 ids that live in the backpack. Anything else the server ever
 *  returns is treated as unknown (icon gap) and NOT usable — the
 *  『使用』 button greys out. */
export type BackpackItemId = 'mini_block' | 'bomb_block' | 'rename_card';

function isBackpackItemId(s: string): s is BackpackItemId {
    return s === 'mini_block' || s === 'bomb_block' || s === 'rename_card';
}

const { ccclass, property } = _decorator;

@ccclass('BackpackController')
export class BackpackController extends Component {

    // ─── Root panel ──────────────────────────────────────────────
    @property({ type: Node, tooltip: '背包面板根节点。show() 时激活并置顶，hide() 时隐藏。' })
    authoredPanel: Node | null = null;

    @property({ type: Button, tooltip: '背包面板右上角的关闭按钮 (✕)。' })
    authoredCloseButton: Button | null = null;

    @property({ type: GameController, tooltip: '同场景里的 GameController 组件。用于读写 gameState（『使用』mini_block/bomb_block 时 arm next-piece 改造）。留空的话使用背包只会 console.warn；rename_card 分支不需要它。' })
    gameController: GameController | null = null;

    // ─── 16 slot grid (fixed) ────────────────────────────────────
    @property({ type: [Button], tooltip: '4×4 = 16 个道具槽的 Button 组件。按行优先顺序（左上第一个，右下最后一个）。点击时打开对应槽的道具详情弹窗（空槽点击无反应）。' })
    authoredSlotButtons: Button[] = [];

    @property({ type: [Sprite], tooltip: '每个槽内显示道具图标的 Sprite 子节点（不是槽背景！槽背景永远可见，此处只拖每个槽里的图标 Sprite）。跟 authoredSlotButtons 顺序一一对应。空槽时 icon.node.active = false 隐藏。' })
    authoredSlotIconSprites: Sprite[] = [];

    @property({ type: [Label], tooltip: '每个槽右下角显示数量的 Label ("×3")。跟 authoredSlotButtons 顺序一一对应。' })
    authoredSlotCountLabels: Label[] = [];

    @property({ type: [Node], tooltip: '每个槽的"选中状态"高亮节点（一般是高亮边框 / 光晕 Sprite，作为槽的子节点）。默认全部隐藏；点击某个槽时，只显示该槽对应的高亮节点。跟 authoredSlotButtons 顺序一一对应。可留空——不拖也不会报错，就是没有选中态视觉。' })
    authoredSlotSelectedNodes: Node[] = [];

    // ─── Icon catalog (id → SpriteFrame lookup) ──────────────────
    @property({ type: [String], tooltip: '背包道具 id 目录（"mini_block" / "bomb_block" / "rename_card"，共 3 个）。服务器返回的每个 item.id 在这里查图标。跟 iconCatalogIcons 顺序一一对应；顺序无所谓，能对上就行。' })
    iconCatalogKeys: string[] = [];

    @property({ type: [SpriteFrame], tooltip: '跟 iconCatalogKeys 顺序一一对应的图标 SpriteFrame（3 张）。' })
    iconCatalogIcons: SpriteFrame[] = [];

    // ─── Detail popup ────────────────────────────────────────────
    @property({ type: Node, tooltip: '道具详情弹窗根节点。点击某个非空槽时激活。' })
    authoredDetailPanel: Node | null = null;

    @property({ type: Sprite, tooltip: '详情弹窗里的大图标 Sprite。' })
    authoredDetailIcon: Sprite | null = null;

    @property({ type: Label, tooltip: '详情弹窗里的道具名字 Label。填 t("item.${id}")，跟随当前语言。' })
    authoredDetailNameLabel: Label | null = null;

    @property({ type: Label, tooltip: '详情弹窗里的"拥有：×N" 数量 Label。' })
    authoredDetailCountLabel: Label | null = null;

    @property({ type: Label, tooltip: '详情弹窗里的道具描述 Label。填 t("desc.${id}")，跟随当前语言。' })
    authoredDetailDescLabel: Label | null = null;

    @property({ type: Button, tooltip: '详情弹窗里的"使用"按钮。点击后先服务器 consume 1 张，成功才应用效果：mini_block/bomb_block 会设置 GameState 下一块变身标志；rename_card 会关背包并跳到"我的资料"改名入口（由 MenuController 承接）。请求飞行中会自动置灰不响应二次点击。' })
    authoredDetailUseButton: Button | null = null;

    @property({ type: Label, tooltip: '（可选）"使用"按钮内部的文字 Label。可以留空——只是用来在道具没有可用效果时改文案（e.g. "不可使用"）或成功后改成"已使用"。' })
    authoredDetailUseButtonLabel: Label | null = null;

    @property({ type: Button, tooltip: '（可选，已废弃）详情弹窗的关闭按钮。当前设计是"点弹窗外任意位置自动关闭"，这个按钮可以在 Inspector 里留空或直接把节点隐藏；如果拖了，仍会响应 click 关闭，兼容老场景。' })
    authoredDetailCloseButton: Button | null = null;

    @property({ type: Node, tooltip: '（可选）详情弹窗里的"卡片"容器节点（承载图标/文字/使用按钮的那个视觉框）。留空时自动使用 authoredDetailPanel 本身，但那样点击卡片上的文字空白也会关掉弹窗——最好拖上真正的卡片节点，控制器会给它挂 BlockInputEvents 让卡片区吃掉点击。' })
    authoredDetailCard: Node | null = null;

    // ─── Runtime state ───────────────────────────────────────────
    /** Snapshot of the last server response — paints the grid AND
     *  drives per-slot detail-popup lookups without a second fetch.
     *  Indexed by slot number (0..15). */
    private _slotItems: (BackpackItem | null)[] = [];
    /** Index of the currently-selected slot (0..15), or -1 when nothing
     *  is selected. Drives the per-slot highlight in
     *  authoredSlotSelectedNodes. Cleared on hide() and on empty-slot
     *  clicks. */
    private _selectedSlot: number = -1;
    /** One-shot click-wire flag — the panel's buttons stay wired for
     *  the component's lifetime, so we only bind listeners once. */
    private _wired: boolean = false;
    /** True while a consume POST is in flight — prevents double-tap on
     *  the 『使用』 button (network races could otherwise consume two
     *  copies for one user click). Cleared in both the resolve and
     *  reject branches. */
    private _consuming: boolean = false;
    /** Optional external hook invoked when the player uses a
     *  rename_card. If set, the backpack calls this INSTEAD of just
     *  closing itself, so the menu / HUD can open the rename UI in
     *  the right place. Wire from MenuController's onLoad:
     *      backpack.onRenameCardUsed = () => this._openNicknameEditor();
     *  Left null → backpack just hides (no UI transition). */
    public onRenameCardUsed: (() => void) | null = null;

    protected onLoad(): void {
        // NOTE: intentionally NOT touching authoredPanel.active here.
        //
        // Race we used to hit: the BackpackController node is authored
        // inactive → onLoad hasn't run yet → the first show() click
        // walks the parent chain and activates our own node → THAT
        // triggers onLoad late → onLoad blindly wrote
        // `authoredPanel.active = false`, overwriting what show() just
        // set to true → panel didn't open until the SECOND tap. Now
        // the panel's initial visibility comes purely from scene
        // authoring (panle should be authored active=false by the
        // artist so it's hidden at boot), and show() / hide() are
        // the only runtime toggles.
        if (this.authoredDetailPanel) this.authoredDetailPanel.active = false;
        // Guarantee empty default state: every authored slot starts
        // with its icon + count hidden regardless of what the artist
        // left visible in the scene. Show() will repopulate when the
        // server response comes back.
        this._paintSlots([]);
    }

    // ─── Public API ──────────────────────────────────────────────
    /** Open the backpack panel. Fetches the player's server-side
     *  inventory and populates the grid. Callable with no arguments. */
    public show(): void {
        if (!this.authoredPanel) {
            console.warn('[Backpack] authoredPanel not wired — cannot show');
            return;
        }
        this._wireOnce();
        this.authoredPanel.active = true;
        // Defensive: walk up the parent chain and activate anything
        // that got left inactive (common footgun — artist hides the
        // BackpackController node itself in the editor to declutter
        // the scene, then the panel never shows even though we set
        // authoredPanel.active = true). Stop at the first Canvas we
        // hit so we don't accidentally re-enable something outside
        // our subtree.
        let cur: Node | null = this.authoredPanel.parent;
        while (cur) {
            if (!cur.active) cur.active = true;
            // Heuristic stop: if we've reached a node with no parent,
            // we're at the scene root. Also cheap: cap at 10 levels
            // so a malformed hierarchy can't burn CPU.
            if (!cur.parent) break;
            cur = cur.parent;
        }
        // Bump to top-of-parent so nothing else in the HUD paints over
        // the panel — same trick MenuController / LeaderboardController
        // use for their panels.
        if (this.authoredPanel.parent) {
            this.authoredPanel.setSiblingIndex(
                this.authoredPanel.parent.children.length - 1,
            );
        }
        // Paint empty state first so the panel isn't blank while the
        // network fetch is in flight, then repaint on resolve.
        this._paintSlots([]);
        this.refresh();
        // Diagnostic — walk ancestor chain and log each one's active
        // state. If any of them are false AFTER this call, the auto-
        // activate walk above is not being reached (stale code build)
        // or the parent chain is longer than expected.
        const chain: string[] = [];
        let n: Node | null = this.authoredPanel;
        while (n) {
            chain.push(`${n.name}(a=${n.active})`);
            n = n.parent;
        }
        console.log('[Backpack] show() chain=', chain.reverse().join(' > '));
    }

    /** Close both the panel AND any open detail popup. Safe to call
     *  when already hidden. */
    public hide(): void {
        if (this.authoredDetailPanel) this.authoredDetailPanel.active = false;
        if (this.authoredPanel) this.authoredPanel.active = false;
        // Clear selection so reopening starts with no highlight.
        this._setSelected(-1);
    }

    /** Re-fetch the inventory from the server and repaint. Call this
     *  after any operation that would mutate the server-side inventory
     *  (e.g. purchase / gift / mid-session use) while the panel is
     *  visible. */
    public refresh(): void {
        fetchBackpack()
            .then((r) => this._paintSlots(r.items))
            .catch((err) => {
                console.warn('[Backpack] fetchBackpack failed:', err?.message || err);
                // Leave whatever's on screen (empty state or prior
                // snapshot). No toast for now — fits the existing
                // silent-network-fail pattern of LeaderboardController.
            });
    }

    // ─── Private ─────────────────────────────────────────────────
    private _wireOnce(): void {
        if (this._wired) return;
        this._wired = true;
        // Close button.
        if (this.authoredCloseButton) {
            this.authoredCloseButton.node.off('click');
            this.authoredCloseButton.node.on('click', () => this.hide(), this);
        }
        // Every slot Button → click opens detail. Wire once per Button
        // node; the same Button stays active across show/hide, so we
        // don't need to re-wire on every open.
        for (let i = 0; i < this.authoredSlotButtons.length; i++) {
            const btn = this.authoredSlotButtons[i];
            if (!btn) continue;
            const slotIdx = i;   // capture per-slot index
            btn.node.off('click');
            btn.node.on('click', () => this._onSlotClicked(slotIdx), this);
        }
        // Detail popup's own close button — kept for backward compat
        // with older scenes that still wire it. New design uses
        // click-outside-to-close (see _wireDetailBackdropOnce), so
        // most scenes should leave this field empty.
        if (this.authoredDetailCloseButton) {
            this.authoredDetailCloseButton.node.off('click');
            this.authoredDetailCloseButton.node.on('click', () => this._closeDetail(), this);
        }
        // Use button (使用) — consumes the currently-selected item.
        // Suppress the global ui_click SFX and play `item_pick` in the
        // handler instead (same pattern as HudController's in-game
        // quick-use buttons — "使用道具" reads as an item action, not
        // a plain UI tap).
        if (this.authoredDetailUseButton) {
            SoundManager.suppressClickSound(this.authoredDetailUseButton);
            this.authoredDetailUseButton.node.off('click');
            this.authoredDetailUseButton.node.on('click', () => this._onUseClicked(), this);
        }
        // Click-outside-to-close for the detail popup. Adds a
        // full-screen dim backdrop as child of authoredDetailPanel
        // (via ensureDimBackdrop) and wires TOUCH_END on that dim
        // to close. The card node gets BlockInputEvents so clicks
        // on the card (Use button, icon, text) don't bubble to
        // the dim and accidentally close.
        this._wireDetailBackdropOnce();
    }

    /** Idempotent: attach a full-screen dim backdrop under the detail
     *  card and wire it to close on tap. Also stamps BlockInputEvents
     *  on authoredDetailCard so taps inside the card DON'T close
     *  (they hit the card node instead of the dim node). Safe to
     *  call multiple times — ensureDimBackdrop dedupes and we track
     *  the wiring with an internal flag. */
    private _detailBackdropWired: boolean = false;
    private _wireDetailBackdropOnce(): void {
        if (this._detailBackdropWired) return;
        if (!this.authoredDetailPanel) return;
        // 1) Add / find the dim child (full-screen, BlockInputEvents,
        //    sibling index 0 so it draws BEHIND the card).
        ensureDimBackdrop(this.authoredDetailPanel);
        const dim = this.authoredDetailPanel.getChildByName('Dim')
                 ?? this.authoredDetailPanel.getChildByName('FateDim')
                 ?? this.authoredDetailPanel.getChildByName('Backdrop');
        if (dim) {
            dim.off(Node.EventType.TOUCH_END);
            dim.on(Node.EventType.TOUCH_END, () => this._closeDetail(), this);
            // 让 Dim 变透明：只保留点击拦截功能，不再画那层半透明黑。
            // 直接 .clear() Graphics — 不重画就等于不出像素。既覆盖
            // 手动挂在场景里的 Dim（如你 Inspector 里那个 Fill Color
            // 000000C8 的 Graphics），也覆盖 ensureDimBackdrop 自动
            // 合成的 Dim。BlockInputEvents 保留，点击穿透仍然被拦。
            const g = dim.getComponent(Graphics);
            if (g) g.clear();
        }
        // 2) The card node eats its own touches so clicks on the card
        //    (Use button area, description, icon) don't fall through
        //    to the dim. Use BlockInputEvents — designed for this.
        //    Fallback: if no card node was wired, we skip; then the
        //    click-outside-to-close area is the ENTIRE detail panel,
        //    including the visible card, which is likely surprising
        //    but not broken (Use button still fires because Cocos
        //    processes button clicks before propagation resolves).
        const card = this.authoredDetailCard;
        if (card && !card.getComponent(BlockInputEvents)) {
            card.addComponent(BlockInputEvents);
        }
        this._detailBackdropWired = true;
    }

    private _closeDetail(): void {
        if (this.authoredDetailPanel) this.authoredDetailPanel.active = false;
        this._setSelected(-1);
    }

    /** Look up an item id's icon in the authored catalog. Returns null
     *  when the id has no icon registered — the caller should treat
     *  that as "hide the icon" (still shows the count badge so the
     *  player can at least see they own the item; art gap). */
    private _iconFor(id: string): SpriteFrame | null {
        if (!id) return null;
        for (let i = 0; i < this.iconCatalogKeys.length; i++) {
            if (this.iconCatalogKeys[i] === id) {
                return this.iconCatalogIcons[i] || null;
            }
        }
        return null;
    }

    /** Fill the 16-slot grid from a server-returned items list. Extra
     *  items past 16 are dropped silently (server should page or cap;
     *  the grid can't grow). Missing items → empty slots. */
    private _paintSlots(items: ReadonlyArray<BackpackItem>): void {
        const nSlots = this.authoredSlotButtons.length;
        const nItems = Math.min(items.length, nSlots);
        // Save the snapshot for detail-popup lookups.
        this._slotItems = new Array(nSlots).fill(null);
        for (let i = 0; i < nItems; i++) this._slotItems[i] = items[i];
        // Repaint clears any existing selection — the slot that was
        // selected may now hold a different item (or nothing), so any
        // stale highlight would be misleading.
        this._setSelected(-1);
        // Paint every slot.
        for (let i = 0; i < nSlots; i++) {
            const iconSpr = this.authoredSlotIconSprites[i] || null;
            const countLab = this.authoredSlotCountLabels[i] || null;
            const item = this._slotItems[i];
            if (!item) {
                // Empty slot — hide icon and count.
                if (iconSpr) iconSpr.node.active = false;
                if (countLab) countLab.node.active = false;
                continue;
            }
            const icon = this._iconFor(item.id);
            if (iconSpr) {
                iconSpr.spriteFrame = icon;
                iconSpr.node.active = !!icon;
            }
            if (countLab) {
                if (item.count > 0) {
                    countLab.string = String(item.count);
                    countLab.node.active = true;
                } else {
                    // Server sent 0 — server shouldn't do this, but
                    // guard the render.
                    countLab.node.active = false;
                }
            }
        }
    }

    private _onSlotClicked(slotIdx: number): void {
        const item = this._slotItems[slotIdx];
        // Empty slot → no-op (don't pop the detail panel for a blank
        // cell — feels broken). Also clear any prior selection so the
        // highlight doesn't linger on a slot the user just clicked
        // past.
        if (!item) {
            this._setSelected(-1);
            return;
        }
        this._setSelected(slotIdx);
        this._showDetail(item);
    }

    /** Show ONLY the given slot's highlight node; hide every other.
     *  Pass -1 to clear all highlights. Silently no-ops for slots
     *  without an authored selected node (partial wiring is fine —
     *  those slots just won't visually indicate selection). */
    private _setSelected(slotIdx: number): void {
        this._selectedSlot = slotIdx;
        for (let i = 0; i < this.authoredSlotSelectedNodes.length; i++) {
            const n = this.authoredSlotSelectedNodes[i];
            if (!n) continue;
            n.active = (i === slotIdx);
        }
    }

    private _showDetail(item: BackpackItem): void {
        if (!this.authoredDetailPanel) return;
        this.authoredDetailPanel.active = true;
        if (this.authoredDetailPanel.parent) {
            this.authoredDetailPanel.setSiblingIndex(
                this.authoredDetailPanel.parent.children.length - 1,
            );
        }
        // Icon — same catalog lookup as the grid.
        if (this.authoredDetailIcon) {
            const icon = this._iconFor(item.id);
            this.authoredDetailIcon.spriteFrame = icon;
            this.authoredDetailIcon.node.active = !!icon;
        }
        // Name via i18n. Falls back to the raw id when the translation
        // is missing so the popup still shows SOMETHING useful.
        if (this.authoredDetailNameLabel) {
            const name = t(`item.${item.id}`);
            this.authoredDetailNameLabel.string = name || item.id;
        }
        // Count comes straight from the fetch — no separate lookup.
        if (this.authoredDetailCountLabel) {
            this.authoredDetailCountLabel.string = `×${item.count}`;
        }
        // Description via i18n. Empty string when missing so the label
        // just collapses if unauthored.
        if (this.authoredDetailDescLabel) {
            this.authoredDetailDescLabel.string = t(`desc.${item.id}`) || '';
        }
        // Use button — only enable if the id is one of the 3 known
        // backpack items AND count > 0. Unknown ids (server sent an
        // id we don't recognize) grey out — no gameplay effect
        // available so consuming it would just burn a copy.
        this._refreshUseButton(item);
    }

    /** Set the 『使用』 button's interactable state + label based on
     *  the currently-shown item + current game state.
     *
     *  bomb_block / mini_block are ONLY consumable during an active
     *  match — they arm the "next piece" modifier, which is
     *  meaningless from the main menu (no game running, no next piece
     *  to transform). In the main menu, the button greys out and
     *  the label switches to "只能在游戏中使用".
     *
     *  rename_card is available everywhere — the effect is a UI
     *  handoff (open the rename dialog), which works from anywhere.
     */
    private _refreshUseButton(item: BackpackItem): void {
        const btn = this.authoredDetailUseButton;
        if (!btn) return;
        const id = item.id;
        const known = isBackpackItemId(id);
        const isInGameOnly = known && (id === 'bomb_block' || id === 'mini_block');
        const gameRunning = !!(this.gameController?.gameState?.running
                            && !this.gameController.gameState.gameOver);
        const outOfGameContext = isInGameOnly && !gameRunning;
        const usable = known
                     && item.count > 0
                     && !this._consuming
                     && !outOfGameContext;
        btn.interactable = usable;
        if (this.authoredDetailUseButtonLabel) {
            if (this._consuming) {
                this.authoredDetailUseButtonLabel.string =
                    t('backpack.using') || '使用中...';
            } else if (!known) {
                this.authoredDetailUseButtonLabel.string =
                    t('backpack.useDisabled') || '不可使用';
            } else if (outOfGameContext) {
                this.authoredDetailUseButtonLabel.string =
                    t('backpack.useIngameOnly') || '只能在游戏中使用';
            } else {
                this.authoredDetailUseButtonLabel.string =
                    t('backpack.use') || '使用';
            }
        }
    }

    /** Handler for the 『使用』 button. Consumes ONE copy on the server
     *  first; only applies the local effect on 200 OK. Errors surface
     *  as a console warn — replace with a toast when a toast helper
     *  is available in this scene. Prevents concurrent taps via the
     *  _consuming flag (also drives the button greying).
     *
     *  Effects:
     *    • mini_block  → GameState.pendingNextPieceModifier = 'mini'
     *    • bomb_block  → GameState.pendingNextPieceModifier = 'bomb'
     *    • rename_card → hide backpack + call onRenameCardUsed hook
     *                    (MenuController wires this to open the
     *                    nickname editor). The server's rename
     *                    endpoint gates on card ownership now, so
     *                    even if the player skips using it up front,
     *                    they still can't rename without one — this
     *                    just makes the discovery flow obvious.
     */
    private _onUseClicked(): void {
        if (this._consuming) return;
        const slot = this._selectedSlot;
        if (slot < 0) return;
        const item = this._slotItems[slot];
        if (!item || !isBackpackItemId(item.id) || item.count <= 0) return;

        const id: BackpackItemId = item.id;

        // Belt-and-braces: bomb/mini can only be used during an active
        // match. The button greys out via _refreshUseButton but a
        // race (e.g. game ends while popup open) could still allow a
        // stale click. Fail loud and refresh the button state.
        if (id === 'bomb_block' || id === 'mini_block') {
            const running = !!(this.gameController?.gameState?.running
                            && !this.gameController.gameState.gameOver);
            if (!running) {
                console.warn('[Backpack] 只能在游戏中使用', id);
                this._refreshUseButton(item);
                return;
            }
        }

        // Special case: rename_card is CONSUMED BY THE SERVER as part
        // of the /profile PUT (see updatePlayerProfile useRenameCard).
        // If we consume it here in the backpack too, the server-side
        // second consume 409s — the player types a name, submits, and
        // sees "no card" because their own tap just spent the only one.
        // So for rename_card we skip the client-side consume: just close
        // the backpack + open the rename UI, and let the rename endpoint
        // handle the atomic debit. This also means canceling the rename
        // dialog is FREE — the card stays in the backpack.
        if (id === 'rename_card') {
            this._applyEffect(id);
            return;
        }

        // Item-pick SFX for bomb_block / mini_block — replaces the
        // suppressed ui_click. Fires up-front so audio feels tied to
        // the tap, not the server response.
        SoundManager.instance?.play('item_pick');
        this._consuming = true;
        this._refreshUseButton(item);   // grey out immediately
        consumeBackpackItem(id)
            .then((r) => {
                this._consuming = false;
                // Locally decrement so the UI reflects the server
                // debit without waiting for the next refresh (also
                // guards against the network fetch racing another
                // consume). The server response's `count` is the
                // authoritative new remainder — trust it.
                item.count = r.count;
                // Repaint the slot + detail popup for the new count.
                this._paintSlots(this._slotItems.filter((x) => x !== null) as BackpackItem[]);
                // Re-select the same slot if the item still has copies
                // (so the popup stays open on the same item); close
                // otherwise.
                if (r.count > 0) {
                    // Find the slot the item lives in after repaint —
                    // _paintSlots re-packs the array so the index may
                    // shift. Look up by id.
                    let newSlot = -1;
                    for (let i = 0; i < this._slotItems.length; i++) {
                        const x = this._slotItems[i];
                        if (x && x.id === id) { newSlot = i; break; }
                    }
                    if (newSlot >= 0) {
                        this._setSelected(newSlot);
                        this._showDetail(this._slotItems[newSlot]!);
                    } else if (this.authoredDetailPanel) {
                        this.authoredDetailPanel.active = false;
                    }
                } else if (this.authoredDetailPanel) {
                    // Ran out — close the popup.
                    this.authoredDetailPanel.active = false;
                    this._setSelected(-1);
                }
                // Now apply the gameplay effect. Do this AFTER the
                // repaint so the UI is settled before we potentially
                // hide the whole panel (rename_card branch).
                this._applyEffect(id);
            })
            .catch((err) => {
                this._consuming = false;
                console.warn('[Backpack] consume failed:', err?.message || err);
                // Re-enable the button first (in case the refresh
                // network call takes a while), then re-fetch to
                // sync the client with the server's authoritative
                // counts — the local view may be stale (item
                // consumed elsewhere / admin revoked / rate limit).
                const cur = this._slotItems[this._selectedSlot];
                if (cur) this._refreshUseButton(cur);
                this.refresh();
            });
    }

    /** Apply the item's gameplay effect. Called ONLY after server
     *  confirmation. Split out so future items just need a new
     *  switch arm and a corresponding GameState field / hook. */
    private _applyEffect(id: BackpackItemId): void {
        switch (id) {
            case 'mini_block': {
                const gs = this.gameController?.gameState;
                if (!gs) {
                    console.warn('[Backpack] mini_block used but no gameController wired — effect dropped');
                    return;
                }
                // Arm the next-spawned piece to be a 1×1 cube.
                // GameController drains this flag when generating
                // the next piece (see GameState.pendingNextPieceModifier).
                // ALSO immediately override the currently-shown next
                // preview via applyBackpackNextPieceOverride so the
                // HUD confirms the arm.
                gs.pendingNextPieceModifier = 'mini';
                gs.applyBackpackNextPieceOverride?.('mini');
                console.log('[Backpack] armed pendingNextPieceModifier = mini');
                break;
            }
            case 'bomb_block': {
                const gs = this.gameController?.gameState;
                if (!gs) {
                    console.warn('[Backpack] bomb_block used but no gameController wired — effect dropped');
                    return;
                }
                // Arm the next-spawned piece to be a 1×1 cube tagged
                // as a 3×3 box bomb. GameController + Bombs.ts kind
                // 'box3' handle the fall + lock + 3×3 same-layer clear.
                gs.pendingNextPieceModifier = 'bomb';
                gs.applyBackpackNextPieceOverride?.('bomb');
                console.log('[Backpack] armed pendingNextPieceModifier = bomb');
                break;
            }
            case 'rename_card':
                // Hand off to the menu — it owns the rename UI.
                // Hide the backpack first so the player sees the
                // rename dialog cleanly.
                this.hide();
                if (this.onRenameCardUsed) this.onRenameCardUsed();
                else console.log('[Backpack] rename_card consumed — no onRenameCardUsed hook wired');
                break;
        }
    }
}
