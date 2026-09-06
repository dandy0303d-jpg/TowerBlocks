/**
 * EventNewbie14Panel — "14-day newbie gift" popup controller.
 *
 * Wire this onto the popup root node in the Cocos editor. The panel
 * itself (backdrop, title art, close X, big claim button, days-left
 * label) is authored in the editor; this script just:
 *   1. Fetches server status when show() is called
 *   2. Paints the daysLeftLabel + button state (enabled / already
 *      claimed / event ended)
 *   3. Handles claim click → POST → success toast + wallet refresh
 *      → button flips to "已领取"
 *
 * Contract with MenuController:
 *   - MenuController exposes an @property authoredEventPanel (Node)
 *     that points at this panel's root, plus authoredEventButton
 *     (Button) on the main menu that triggers show().
 *   - The main-menu entry button is hidden by MenuController when
 *     the server reports `active=false` — no logic here for that.
 *
 * Never gates on client-side day arithmetic. Server status
 * (`canClaimToday` / `daysRemaining`) is the sole source of truth.
 */

import {
    _decorator,
    Component,
    Node,
    Button,
    Label,
    tween,
    UIOpacity,
    Vec3,
} from 'cc';
import { fetchNewbie14Status, claimNewbie14, Newbie14Status } from '../core/EventNewbie14Api';
import { t } from '../core/i18n/I18n';
import { ToastManager } from './ToastManager';
import { fetchWallet } from '../core/WalletApi';
import { BackKeyManager } from './BackKeyManager';

const { ccclass, property } = _decorator;

@ccclass('EventNewbie14Panel')
export class EventNewbie14Panel extends Component {

    // ---- Authored refs (drag in the editor) ----

    @property({ type: Button, tooltip: '"领取 700 钻石" 大按钮 — 脚本会按服务器状态启用/禁用' })
    claimButton: Button | null = null;

    @property({ type: Label, tooltip: '按钮上的文字 Label（"领取 X 钻石" / "今日已领取" / "活动已结束"）— 可空，脚本会 getComponentInChildren 兜底' })
    claimButtonLabel: Label | null = null;

    @property({ type: Label, tooltip: '"活动剩余 N 天" 显示' })
    daysLeftLabel: Label | null = null;

    @property({ type: Label, tooltip: '标题文字 — 可空，未拖时脚本不会碰它' })
    titleLabel: Label | null = null;

    @property({ type: Label, tooltip: '副标题 / 说明文字 — 可空' })
    subtitleLabel: Label | null = null;

    @property({ type: Button, tooltip: '关闭按钮 X — 点击隐藏面板' })
    closeButton: Button | null = null;

    @property({ type: Node, tooltip: '半透明背板 — 点击也关闭面板（可空）' })
    dimBackdrop: Node | null = null;

    // ---- Runtime state ----

    private _status: Newbie14Status | null = null;
    /** Guards against double-tap during in-flight claim. */
    private _claimBusy: boolean = false;

    onLoad(): void {
        // Panel starts hidden — MenuController shows it on button click.
        this.node.active = false;
        if (this.claimButton) {
            this.claimButton.node.on(Button.EventType.CLICK, this._onClaimClick, this);
        }
        if (this.closeButton) {
            this.closeButton.node.on(Button.EventType.CLICK, this.hide, this);
        }
        if (this.dimBackdrop) {
            // Cocos Button component isn't required — attach a raw touch
            // handler so the backdrop just needs to be a UITransform + a
            // BlockInputEvents to eat taps.
            this.dimBackdrop.on(Node.EventType.TOUCH_END, this.hide, this);
        }
    }

    onDestroy(): void {
        // Cocos may null out a component's `.node` back-ref BEFORE it
        // reaches our onDestroy (specifically when the whole subtree
        // is being torn down — child components are destroyed first
        // and their node ref is cleared). Guard with `?.` so a
        // scene close / editor stop doesn't throw.
        this.claimButton?.node?.off(Button.EventType.CLICK, this._onClaimClick, this);
        this.closeButton?.node?.off(Button.EventType.CLICK, this.hide, this);
        this.dimBackdrop?.off(Node.EventType.TOUCH_END, this.hide, this);
        // Belt-and-suspenders: if the panel was mid-show when
        // destroyed, drop its back-key handler so BackKeyManager
        // doesn't hold a dead reference. pop() is a no-op if not
        // in the stack.
        BackKeyManager.pop(this._back);
    }

    /** Android back-key handler. Bound once so push/pop use the
     *  same function ref. Returning nothing (undefined) tells
     *  BackKeyManager we consumed the key. */
    private _back = (): void => { this.hide(); };

    // ============================================================
    //  Public API
    // ============================================================

    /** Show the panel and refresh from server. Safe to call multiple
     *  times; each call re-fetches so the daily state stays current
     *  if the player leaves the app open past UTC midnight. */
    public async show(): Promise<void> {
        this.node.active = true;
        // Register with the global back-key stack so Android's
        // hardware back closes this popup before anything else.
        BackKeyManager.push(this._back);
        // Simple opacity fade-in — feels nicer than a hard snap and
        // matches the other menu popups.
        const op = this.node.getComponent(UIOpacity) ?? this.node.addComponent(UIOpacity);
        op.opacity = 0;
        tween(op).to(0.18, { opacity: 255 }).start();
        this.node.setScale(new Vec3(0.9, 0.9, 1));
        tween(this.node).to(0.18, { scale: new Vec3(1, 1, 1) }).start();

        // Paint stale state immediately (if we've fetched before) so
        // there's no blank frame while the network call flies.
        this._paint();
        try {
            this._status = await fetchNewbie14Status();
            this._paint();
        } catch (err) {
            console.warn('[EventNewbie14] status fetch failed:', (err as Error).message);
            // Fall back to a disabled button + error subtitle so the
            // player sees why the panel opened but can't do anything.
            this._paintError();
        }
    }

    public hide(): void {
        this.node.active = false;
        BackKeyManager.pop(this._back);
    }

    // ============================================================
    //  Rendering
    // ============================================================

    private _paint(): void {
        if (this.titleLabel)    this.titleLabel.string    = t('event.newbie14.title');
        if (this.subtitleLabel) this.subtitleLabel.string = t('event.newbie14.subtitle');

        const s = this._status;
        if (!s) {
            // First open, network still in flight — leave button in a
            // safe disabled state until status arrives.
            this._setClaimButton(false, t('event.newbie14.loading'));
            if (this.daysLeftLabel) this.daysLeftLabel.string = '';
            return;
        }

        if (!s.active) {
            this._setClaimButton(false, t('event.newbie14.ended'));
            if (this.daysLeftLabel) this.daysLeftLabel.string = t('event.newbie14.ended');
            return;
        }

        if (this.daysLeftLabel) {
            this.daysLeftLabel.string = t('event.newbie14.daysLeft', { days: s.daysRemaining });
        }

        if (s.claimedToday) {
            this._setClaimButton(false, t('event.newbie14.claimed'));
        } else if (s.canClaimToday) {
            this._setClaimButton(true, t('event.newbie14.claim', { gems: s.dailyReward }));
        } else {
            // active + !canClaimToday + !claimedToday — shouldn't
            // happen per the server contract, but degrade gracefully.
            this._setClaimButton(false, t('event.newbie14.claimed'));
        }
    }

    private _paintError(): void {
        this._setClaimButton(false, t('event.newbie14.error'));
        if (this.daysLeftLabel) this.daysLeftLabel.string = '';
    }

    /** Toggle the claim button's interactability + label text. Falls
     *  back to `getComponentInChildren(Label)` when `claimButtonLabel`
     *  wasn't dragged, matching the Google-bind pattern. */
    private _setClaimButton(enabled: boolean, text: string): void {
        if (this.claimButton) {
            this.claimButton.interactable = enabled;
        }
        const lab = this.claimButtonLabel
            ?? this.claimButton?.node.getComponentInChildren(Label)
            ?? null;
        if (lab) lab.string = text;
    }

    // ============================================================
    //  Claim
    // ============================================================

    private async _onClaimClick(): Promise<void> {
        if (this._claimBusy) return;
        this._claimBusy = true;
        // Disable during flight so a double-tap can't fire two POSTs
        // in the ~200ms before the server responds.
        this._setClaimButton(false, t('event.newbie14.claiming'));
        try {
            const r = await claimNewbie14();
            // Flip button to "已领取" immediately — the server
            // already recorded the row, so a follow-up status fetch
            // isn't strictly needed to update this popup. We still
            // refresh the wallet so the main-menu balance chip
            // updates the moment the popup closes.
            if (this._status) {
                this._status = {
                    ...this._status,
                    claimedToday:  true,
                    canClaimToday: false,
                    totalClaimed:  this._status.totalClaimed + 1,
                };
            }
            this._paint();
            ToastManager.instance?.info(
                t('event.newbie14.grantedToast', { gems: r.granted }),
            );
            // Fire-and-forget wallet refresh so the main-menu balance
            // updates. Errors here are non-fatal — the reward is
            // credited server-side regardless.
            fetchWallet().catch((e) => {
                console.warn('[EventNewbie14] wallet refresh failed:', e?.message);
            });
        } catch (err: any) {
            const msg: string = err?.message ?? String(err);
            console.warn('[EventNewbie14] claim failed:', msg);
            // Race path: player tapped between two device tabs, or
            // reopened during the same day. Refresh status so the UI
            // resyncs.
            if (msg.startsWith('HTTP 409')) {
                if (this._status) {
                    this._status = { ...this._status, claimedToday: true, canClaimToday: false };
                }
                this._paint();
                ToastManager.instance?.info(t('event.newbie14.alreadyClaimed'));
            } else if (msg.startsWith('HTTP 410')) {
                if (this._status) {
                    this._status = { ...this._status, active: false, daysRemaining: 0 };
                }
                this._paint();
                ToastManager.instance?.info(t('event.newbie14.ended'));
            } else {
                this._paint(); // restore whatever the correct button state was
                ToastManager.instance?.error(t('event.newbie14.error'));
            }
        } finally {
            this._claimBusy = false;
        }
    }
}
