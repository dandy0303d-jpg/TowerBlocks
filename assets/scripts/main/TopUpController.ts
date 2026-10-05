/**
 * TopUpController — the recharge panel.
 *
 * Wire-once + populate pattern (same as LeaderboardController):
 *   - Scene author builds the visual layout (dim + card + 6 SKU
 *     cards + close button + balance strip) and drops references
 *     into @property slots.
 *   - Script populates each card's gem count / price / tag from
 *     `WALLET_SKUS`, wires click → topupWallet(), refreshes balance.
 *
 * Purchase flow (MVP — direct buy, no confirmation step):
 *   1. Player taps a SKU card's "Buy" button
 *   2. `topupWallet(sku.id, 'mock')` fires immediately
 *   3. On success → toast "获得 N 宝石" + refresh balance
 *   4. On failure → toast the error message
 *
 * Later: swap paymentKind for real IAP (Apple/Google Billing SDK
 * or Stripe web checkout). The rest of the flow stays the same —
 * the server just changes how it validates the transaction.
 *
 * Price display is currency-aware via `formatPrice(sku)` — see
 * WalletApi for the CURRENCY_INFO table. Platform-provided
 * localized prices (StoreKit / Play Billing) override via
 * `overrideSkuDisplayPrice(id, str)` from WalletApi.
 *
 * INSPECTOR WIRING:
 *   Panel           — root Node (Widget-stretched to Canvas)
 *   Close Button    — dismisses the panel
 *   Title Label     — "充值宝石"
 *   Subtitle Label  — "选择档位快速补充"
 *   Balance Label   — "宝石: N" text at top
 *   Mock Notice Lbl — "(测试模式)" hint (optional)
 *   Sku Gem Labels  — 6 Labels for "{n} 宝石"
 *   Sku Price Labels— 6 Labels for the currency-formatted price
 *   Sku Buy Buttons — 6 Buttons ("购买" — inner Label auto-found)
 *   Toast Node/Label — optional; fades in/out on success/failure
 */

import {
    _decorator,
    Component,
    Node,
    Label,
    Button,
    Sprite,
    tween,
    UIOpacity,
    log,
} from 'cc';

import { t, subscribe as subscribeI18n, getLang } from '../core/i18n/I18n';
import {
    WALLET_SKUS,
    fetchWallet,
    topupWallet,
    formatPrice,
    overrideSkuDisplayPrice,
    WalletSku,
    ReceiptAlreadyRedeemedError,
} from '../core/WalletApi';
import { Providers } from '../core/channels/Providers';
import { AnalyticsApi } from '../core/AnalyticsApi';
import { ToastManager } from './ToastManager';
import { BackKeyManager } from './BackKeyManager';

const { ccclass, property } = _decorator;

@ccclass('TopUpController')
export class TopUpController extends Component {

    // ---- Panel shell ----
    @property({ type: Node, tooltip: '充值面板根节点（含 dim + 卡片）— 默认 active=false' })
    panel: Node | null = null;

    @property({ type: Button, tooltip: '关闭按钮' })
    closeButton: Button | null = null;

    @property({ type: Label, tooltip: '"充值宝石" 标题 Label' })
    titleLabel: Label | null = null;

    @property({ type: Sprite, tooltip: '充值面板顶部 Logo Sprite — 脚本会按当前语言 swap spriteFrame（复用 MenuController 里配好的 10 张 logo SF）— 可空' })
    logoSprite: Sprite | null = null;

    @property({ type: Node, tooltip: 'MenuController 所在节点（脚本会拿它的 getLocalizedLogoSpriteFrame 复用 10 张 logo SF）— 可空，不拖则跳过 logo 换图' })
    menuControllerNode: Node | null = null;

    @property({ type: Label, tooltip: '"宝石: N" 顶部余额 Label' })
    balanceLabel: Label | null = null;

    @property({ type: Label, tooltip: '"（测试模式，无真实扣款）" 提示 Label（可选）' })
    mockNoticeLabel: Label | null = null;

    // ---- SKU grid (6 cards; parallel arrays, order matches WALLET_SKUS) ----
    @property({ type: [Label],  tooltip: '6 个"{n} 钻石"Label（顺序：100/500/1100/2400/6200/14500 钻石）' })
    skuGemLabels: Label[] = [];

    @property({ type: [Label],  tooltip: '6 个价格 Label（顺序同上：$0.99/$4.99/$9.99/$19.99/$49.99/$99.99）；formatPrice 输出带币种符号的字符串' })
    skuPriceLabels: Label[] = [];

    @property({ type: [Button], tooltip: '6 个"购买"按钮（顺序同上）；内部 Label 脚本自动 getComponentInChildren 找' })
    skuBuyButtons: Button[] = [];

    // ---- Toast (optional; fades in/out) ----
    @property({ type: Node, tooltip: '一次性提示 toast 根节点（可空；有的话会用 tween 淡入淡出）' })
    toastNode: Node | null = null;

    @property({ type: Label, tooltip: 'Toast 内文字 Label' })
    toastLabel: Label | null = null;

    // ============================================================
    //  Internal state
    // ============================================================

    private i18nUnsub: (() => void) | null = null;
    private wired: boolean = false;

    /** Cached balance so a re-open feels instant while the network
     *  fetch runs in the background. */
    private cachedBalance: number = 0;

    // ============================================================
    //  Lifecycle
    // ============================================================

    onLoad(): void {
        if (this.panel)     this.panel.active = false;
        if (this.toastNode) this.toastNode.active = false;
        // Prime the localized logo (panel is hidden until show(); this
        // just makes sure the SF is ready when the panel activates).
        this._refreshLocalizedLogo();
        this._langUnsub = subscribeI18n(() => this._refreshLocalizedLogo());
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

    /** Show the top-up panel. Paints cached balance immediately, then
     *  refreshes from server in the background. */
    private _back = (): void => { this.hide(); };
    public show(): void {
        if (!this.panel) {
            log('[TopUp] panel not wired — cannot show');
            return;
        }
        BackKeyManager.push(this._back);
        // Activate the tree FIRST — same lesson learned from
        // LeaderboardController: some Cocos UI wiring (label writes,
        // click handler registration on button children) is only
        // guaranteed to take effect on the initial paint when the
        // parent tree is already active. Doing wire+paint on an
        // inactive tree causes the "first click shows nothing,
        // second click shows the panel" symptom.
        this.panel.active = true;
        this.panel.setSiblingIndex(999);
        // Refresh localized logo every open — covers first-boot ordering
        // where MenuController's SF slots may not have been populated
        // in onLoad but ARE ready by the time the player opens topup.
        this._refreshLocalizedLogo();
        this.wire();
        this.paintBalance(this.cachedBalance);
        // Background refresh; paint updates when it lands.
        this.refreshBalance();
        // Also re-fetch localized prices in case the player switched
        // Apple ID / storefront since the last preload. Cheap — Apple
        // caches products at the OS level.
        void this.refreshLocalizedPrices();
    }

    /** Ask the active purchase provider for real localized prices +
     *  overwrite the hard-coded WALLET_SKUS entries so the display
     *  string matches what StoreKit will actually charge. On non-Apple
     *  channels (MockPurchaseProvider) this is a no-op — the mock
     *  returns the input array unchanged. Fire-and-forget; on
     *  completion we re-paint if anything changed. */
    private async refreshLocalizedPrices(): Promise<void> {
        try {
            const localized = await Providers.purchase.fetchLocalizedPrices(WALLET_SKUS);
            let changed = false;
            for (const s of localized) {
                if (s.displayPrice) {
                    // Persist onto the shared WALLET_SKUS entry so the
                    // next paint (or any other consumer of formatPrice)
                    // sees the localized string. `overrideSkuDisplayPrice`
                    // is a no-op when the value already matches.
                    const idx = WALLET_SKUS.findIndex((x) => x.id === s.id);
                    if (idx >= 0 && WALLET_SKUS[idx].displayPrice !== s.displayPrice) {
                        overrideSkuDisplayPrice(s.id, s.displayPrice);
                        changed = true;
                    }
                }
            }
            if (changed) {
                log('[TopUp] localized prices updated — repainting');
                this.paintSkuCards();
            }
        } catch (err) {
            console.warn('[TopUp] refreshLocalizedPrices failed (falling back to defaults):', (err as Error).message);
        }
    }

    public hide(): void {
        if (this.panel) this.panel.active = false;
        BackKeyManager.pop(this._back);
    }

    public isOpen(): boolean {
        return !!this.panel?.active;
    }

    /**
     * Boot-time preload — called by LoadingController before the
     * main menu shows. Runs the one-time wiring (i18n on static
     * labels, click handlers on 6 buy buttons) and kicks off the
     * initial wallet fetch so the balance is ready when the player
     * first taps to open the panel.
     *
     * Idempotent: safe if it happens to run twice (wire() guards
     * itself via `wired` flag; fetchWallet is a fresh network call
     * each time, which is fine).
     *
     * Unlike LeaderboardController we don't need to flip the panel
     * active/inactive here — TopUp has no dynamically-instantiated
     * children whose Layout needs computing. The scene-authored
     * 6 cards are laid out at author time by whatever Layout you
     * put on the grid container.
     */
    public preload(): void {
        if (!this.panel) {
            log('[TopUp] preload skipped — panel not wired');
            return;
        }
        // Boot the purchase provider so channel implementations
        // (Google Play Billing, StoreKit) can bind their native
        // services during the loading screen instead of on the first
        // click. `MockPurchaseProvider.init()` is a no-op, so this is
        // free on the main branch. Errors are logged but don't block
        // preload — a broken IAP layer shouldn't prevent the game
        // from booting; the purchase will just fail on click.
        Providers.purchase.init().then(() => {
            // Once StoreKit is ready, pull the real localized prices
            // from Apple (bakes in the player's App Store storefront
            // currency + tax + regional pricing). Overrides the
            // hard-coded $-USD defaults in WALLET_SKUS so the UI
            // matches what actually gets charged.
            void this.refreshLocalizedPrices();
        }).catch((err) => {
            console.warn('[TopUp] purchase provider init failed:', err && err.message);
        });
        // Same trick as LeaderboardController — briefly activate the
        // panel so wire() has a live tree to hang labels + click
        // handlers on. Loading overlay covers this so the flash is
        // invisible. Restore prior state (typically inactive) after.
        const wasActive = this.panel.active;
        this.panel.active = true;
        try {
            this.wire();
        } finally {
            this.panel.active = wasActive;
        }
        // Prime the balance cache. If it fails (network down at boot),
        // the cache stays at 0 and the panel opens with "宝石: 0" until
        // the next fetch. First real show() triggers another fetch anyway.
        fetchWallet()
            .then((w) => {
                this.cachedBalance = w.gems;
                log(`[TopUp] preload — cached balance ${w.gems}`);
            })
            .catch((err) => {
                console.warn('[TopUp] preload fetchWallet failed (non-fatal):', err.message);
            });
    }

    // ============================================================
    //  Setup
    // ============================================================

    private wire(): void {
        if (this.wired) return;
        this.wired = true;

        // ---- Static labels ----
        if (this.titleLabel)      this.titleLabel.string      = t('topup.title');
        if (this.mockNoticeLabel) this.mockNoticeLabel.string = t('topup.mockNotice');

        // ---- Close button ----
        // Guard against a Button reference whose backing Node was
        // destroyed (Cocos leaves the component reference truthy but
        // .node becomes null → `.off()` on null throws).
        if (this.closeButton && this.closeButton.node) {
            this.closeButton.node.off('click');
            this.closeButton.node.on('click', () => this.hide(), this);
            const lab = this.closeButton.getComponentInChildren(Label);
            if (lab) lab.string = t('topup.close');
        }

        // ---- SKU cards ----
        this.paintSkuCards();

        // ---- i18n retranslate on lang change ----
        this.i18nUnsub = subscribeI18n(() => {
            if (!this.panel?.active) return;
            if (this.titleLabel)      this.titleLabel.string      = t('topup.title');
            if (this.mockNoticeLabel) this.mockNoticeLabel.string = t('topup.mockNotice');
            if (this.closeButton) {
                const lab = this.closeButton.getComponentInChildren(Label);
                if (lab) lab.string = t('topup.close');
            }
            this.paintBalance(this.cachedBalance);
            this.paintSkuCards();
        });
    }

    /** Populate the SKU cards from the catalog. Iterates up to the
     *  shortest of (catalog, wired label array) so a partially-wired
     *  editor build renders however many cards are ready. */
    private paintSkuCards(): void {
        const N = Math.min(
            WALLET_SKUS.length,
            this.skuGemLabels.length,
            this.skuPriceLabels.length,
            this.skuBuyButtons.length,
        );
        for (let i = 0; i < N; i++) {
            const sku = WALLET_SKUS[i];
            if (this.skuGemLabels[i]) {
                // Just the number — no "宝石" suffix. If the visual
                // needs a suffix (icon or unit label), it's authored
                // as a sibling in the scene, not part of this string.
                this.skuGemLabels[i].string = sku.gems.toString();
            }
            if (this.skuPriceLabels[i]) {
                // formatPrice includes the currency symbol — the i18n
                // template just passes it through, no hardcoded $ / ¥.
                this.skuPriceLabels[i].string = t('topup.price', { price: formatPrice(sku) });
            }
            // Buy button + inner label — the label IS the price now
            // (per design: player taps the price to buy).
            if (this.skuBuyButtons[i] && this.skuBuyButtons[i].node) {
                const btn = this.skuBuyButtons[i];
                btn.node.off('click');
                // Capture SKU so the click handler knows what to buy.
                btn.node.on('click', () => this.doPurchase(sku, btn.node), this);
                const lab = btn.getComponentInChildren(Label);
                if (lab) lab.string = formatPrice(sku);
            }
        }
    }

    // ============================================================
    //  Balance
    // ============================================================

    private paintBalance(gems: number): void {
        if (this.balanceLabel) this.balanceLabel.string = t('topup.balance', { n: gems.toString() });
    }

    private refreshBalance(): void {
        fetchWallet()
            .then((w) => {
                this.cachedBalance = w.gems;
                this.paintBalance(w.gems);
                log(`[TopUp] balance refreshed: ${w.gems} gems`);
            })
            .catch((err) => {
                console.warn('[TopUp] fetchWallet failed:', err.message);
            });
    }

    // ============================================================
    //  Purchase (channel-agnostic — goes through Providers.purchase)
    // ============================================================

    /** Full purchase pipeline. Order matters — see the "correct
     *  sequence" comment at the top of `IPurchaseProvider.ts`:
     *
     *    1. `purchase.buy()`      — native billing UI, returns receipt
     *    2. `topupWallet(receipt)` — server verifies + credits gems
     *    3. `purchase.consume()`  — mark receipt used so the player
     *                                can buy the same SKU again
     *
     *  Step 3 fires ONLY after step 2 succeeds — losing a receipt
     *  before the server credits gems means the player paid for
     *  nothing (Play won't reissue the token). If step 3 fails after
     *  step 2 succeeded, log it but treat the purchase as successful
     *  — the gems are in the wallet; the platform will eventually
     *  re-deliver the pending consume on next `buy()` acknowledgment. */
    private doPurchase(sku: WalletSku, fromNode: Node | null = null): void {
        this.showToast(t('topup.processing'));
        // Firebase predefined event — signals intent to purchase.
        // Value is priceCents/100 to match Firebase's expected major
        // units. The eventual `purchase` event uses the same value.
        AnalyticsApi.logBeginCheckout({
            currency: sku.currency,
            value:    sku.priceCents / 100,
            sku:      sku.id,
        });
        Providers.purchase.buy(sku.id)
            .then((receipt) => {
                // Step 2: send receipt to server for validation + credit.
                return topupWallet(
                    receipt.sku,
                    receipt.paymentKind,
                    receipt.transactionId,
                    receipt.platformReceipt,
                ).then((res) => {
                    const gemsBefore = this.cachedBalance;
                    this.cachedBalance = res.balance;
                    this.paintBalance(res.balance);
                    this.showToast(
                        t('topup.successBody', { n: res.gemsAdded.toString() }),
                        'info',
                    );
                    log(`[TopUp] purchase ok — sku=${sku.id} +${res.gemsAdded} gems, balance=${res.balance}, kind=${receipt.paymentKind}`);
                    // Gem-arrival FX + sound: shower from the tapped SKU
                    // card to the main-menu balance chip. Also rolls the
                    // topup panel's own balanceLabel so the number updates
                    // on both the panel AND the main chip.
                    if (this.menuControllerNode) {
                        const menu = this.menuControllerNode.getComponent('MenuController') as any;
                        menu?.playGemClaimFx?.(fromNode, res.gemsAdded, gemsBefore, this.balanceLabel);
                    }
                    // Firebase predefined `purchase` event — flows into
                    // Revenue / ARPU / LTV reports automatically.
                    AnalyticsApi.logPurchase({
                        currency:      sku.currency,
                        value:         sku.priceCents / 100,
                        transactionId: receipt.transactionId,
                        sku:           sku.id,
                    });
                    // Step 3: acknowledge / consume — best-effort, don't
                    // roll back on failure. Server has already credited.
                    Providers.purchase
                        .consume(receipt.platformReceipt)
                        .catch((consumeErr) => {
                            console.warn(`[TopUp] consume failed (gems already credited): ${consumeErr.message}`);
                        });
                }).catch((topupErr) => {
                    // Server rejected the receipt. Only the "already
                    // redeemed on another account" case gets special
                    // handling: we still MUST consume the receipt (per
                    // claude-5d's note — otherwise Play Store keeps
                    // redelivering it on every launch, and the player
                    // sees "pending purchase" forever) and show a
                    // specific toast so the player understands why no
                    // gems appeared. Any other topup error re-throws to
                    // the outer catch which shows the generic failure
                    // toast and does NOT consume (receipt stays live for
                    // a retry on the next launch).
                    if (topupErr instanceof ReceiptAlreadyRedeemedError) {
                        console.warn(`[TopUp] receipt already redeemed — consuming anyway to clear queue: sku=${sku.id} txn=${topupErr.transactionId}`);
                        this.showToast(t('topup.receiptAlreadyRedeemed'), 'error');
                        AnalyticsApi.logCustom('purchase_already_redeemed', {
                            sku:            sku.id,
                            transaction_id: topupErr.transactionId ?? '',
                        });
                        Providers.purchase
                            .consume(receipt.platformReceipt)
                            .catch((consumeErr) => {
                                console.warn(`[TopUp] consume after redeemed-elsewhere failed: ${consumeErr.message}`);
                            });
                        return;   // handled — don't re-throw to outer catch
                    }
                    throw topupErr;
                });
            })
            .catch((err) => {
                // Distinguish user-cancelled from real errors — no toast
                // for cancel (the native sheet already showed).
                if (err && typeof err.message === 'string'
                    && err.message.startsWith('user-cancelled')) {
                    log(`[TopUp] purchase cancelled by user (sku=${sku.id})`);
                    AnalyticsApi.logCustom('purchase_cancelled', { sku: sku.id });
                    return;
                }
                this.showToast(t('topup.failBody', { reason: err.message }), 'error');
                console.warn('[TopUp] purchase failed:', err.message);
                AnalyticsApi.logCustom('purchase_failed', {
                    sku:    sku.id,
                    reason: String(err?.message ?? 'unknown'),
                });
                AnalyticsApi.logError(err instanceof Error ? err : String(err), {
                    where: 'TopUpController.doPurchase',
                    sku:   sku.id,
                });
            });
    }

    // ============================================================
    //  Toast (transient message)
    // ============================================================

    /** Fade-in + auto-hide toast for success/error/in-flight messages.
     *  Preferred path is the unified ToastManager (drop one component
     *  into the scene and it handles all in-game toasts). Falls back
     *  to the legacy per-panel toastNode / toastLabel when ToastManager
     *  isn't wired. */
    private showToast(text: string, kind: 'info' | 'error' = 'info'): void {
        if (ToastManager.instance) {
            ToastManager.instance.show(text, kind);
            return;
        }
        if (!this.toastNode || !this.toastLabel) return;
        this.toastLabel.string = text;
        this.toastNode.active = true;
        this.toastNode.setSiblingIndex(999);
        let op = this.toastNode.getComponent(UIOpacity);
        if (!op) op = this.toastNode.addComponent(UIOpacity);
        op.opacity = 0;
        tween<UIOpacity>(op)
            .to(0.15, { opacity: 255 })
            .delay(1.5)
            .to(0.3, { opacity: 0 })
            .call(() => { if (this.toastNode) this.toastNode.active = false; })
            .start();
    }
}
