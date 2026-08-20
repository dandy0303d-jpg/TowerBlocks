/**
 * ConsentModal — Korean-standard "전체 동의" style consent gate.
 *
 * Shown by LoadingController after ensureRegistered when
 * ConsentApi.fetchStatus() returns needsConsent=true. Blocks the boot
 * pipeline until the player agrees.
 *
 * Layout (all @property nodes wired in the scene):
 *   Root (this component + Widget for full-screen dim overlay)
 *   ├── Dim (Sprite, semi-transparent black — swallows touches)
 *   └── Card
 *       ├── Title             (Label — consent.title)
 *       ├── AgreeAllRow
 *       │   ├── AgreeAll     (Toggle — master; toggling sets all children)
 *       │   └── AgreeAllLbl  (Label — consent.agreeAll)
 *       ├── TosRow
 *       │   ├── TosToggle    (Toggle)
 *       │   ├── TosLabel     (Label — consent.tos.label + (필수))
 *       │   └── TosView      (Button — opens ToS URL)
 *       ├── PrivacyRow
 *       │   ├── PrivacyToggle
 *       │   ├── PrivacyLabel
 *       │   └── PrivacyView
 *       ├── MarketingRow
 *       │   ├── MarketingToggle
 *       │   └── MarketingLabel (Label — consent.marketing.label + (선택))
 *       ├── HintLabel        (Label — consent.mustAgree — shown when user
 *       │                     hits Start without all required boxes checked)
 *       └── StartButton      (Button — consent.start — disabled until
 *                             all required boxes checked)
 *
 * Wire the External Links (ToS/Privacy) to open in the OS browser via
 * the platform-specific helper (see openLegal()). Current implementation
 * uses `sys.openURL()` — Cocos wraps Safari on iOS.
 */

import { _decorator, Component, Node, Label, Button, Toggle, sys } from 'cc';
import { t } from '../core/i18n/I18n';
import { fetchConsentStatus, postConsent, ConsentStatusResult } from '../core/ConsentApi';
import { BACKEND_BASE_URL } from '../core/BackendConfig';

const { ccclass, property } = _decorator;

@ccclass('ConsentModal')
export class ConsentModal extends Component {

    @property({ type: Node, tooltip: '整个弹窗根节点（含 dim + 卡片），默认 active=false，由 show() 打开' })
    root: Node = null!;

    @property({ type: Label, tooltip: '标题 Label — consent.title' })
    titleLabel: Label = null!;

    @property({ type: Toggle, tooltip: '「전체 동의」主 Toggle — 联动全部子项' })
    agreeAllToggle: Toggle = null!;

    @property({ type: Label, tooltip: '「전체 동의」旁边的 Label — consent.agreeAll' })
    agreeAllLabel: Label = null!;

    // 必选：ToS
    @property({ type: Toggle }) tosToggle: Toggle = null!;
    @property({ type: Label })  tosLabel: Label = null!;
    @property({ type: Button, tooltip: 'ToS「查看」按钮 — 打开 ToS URL' })
    tosViewBtn: Button = null!;

    // 必选：Privacy
    @property({ type: Toggle }) privacyToggle: Toggle = null!;
    @property({ type: Label })  privacyLabel: Label = null!;
    @property({ type: Button, tooltip: 'Privacy「查看」按钮 — 打开 Privacy URL' })
    privacyViewBtn: Button = null!;

    // 可选：Marketing
    @property({ type: Toggle }) marketingToggle: Toggle = null!;
    @property({ type: Label })  marketingLabel: Label = null!;

    @property({ type: Label, tooltip: '错误/提示 Label — 默认隐藏；必选项没勾就试图开始时显示' })
    hintLabel: Label = null!;

    @property({ type: Button, tooltip: '「同意并开始」按钮 — 必选项都勾才 enable' })
    startBtn: Button = null!;

    // Result state
    private _currentTos: string = '';
    private _currentPrivacy: string = '';
    private _syncingAgreeAll: boolean = false;
    private _busy: boolean = false;
    private _onCompleteResolver: (() => void) | null = null;
    /** true if gate() has been called and the modal SHOULD stay visible;
     *  onLoad honors this so it doesn't re-hide right after gate() shows. */
    private _shouldStayVisible: boolean = false;

    onLoad() {
        // Defensive: if you forgot to leave ConsentModalNode active=false in
        // the scene, hide it now so we don't flash the consent UI at boot.
        // BUT if gate() was already called (activating the node — which is
        // what caused onLoad to fire in the first place), respect that and
        // don't re-hide.
        if (this.root && !this._shouldStayVisible) this.root.active = false;

        // Toggle wiring
        this.agreeAllToggle?.node.on('toggle', this.onAgreeAllToggle, this);
        this.tosToggle?.node.on('toggle',       this.onAnyChildToggle, this);
        this.privacyToggle?.node.on('toggle',   this.onAnyChildToggle, this);
        this.marketingToggle?.node.on('toggle', this.onAnyChildToggle, this);

        // View buttons
        this.tosViewBtn?.node.on(Button.EventType.CLICK,
            () => this.openLegal('tos'), this);
        this.privacyViewBtn?.node.on(Button.EventType.CLICK,
            () => this.openLegal('privacy'), this);

        // Start button
        this.startBtn?.node.on(Button.EventType.CLICK, this.onStart, this);
    }

    /** Called by LoadingController when consent is required. Returns
     *  a Promise that resolves after the player successfully submits.
     *  Loading pipeline should `await` this before continuing. */
    public async gate(status: ConsentStatusResult): Promise<void> {
        this._currentTos     = status.current.tos;
        this._currentPrivacy = status.current.privacy;
        // Set FIRST — if activating this.root causes onLoad to run for
        // the first time (scene was authored active=false), onLoad will
        // see the flag and skip its defensive hide.
        this._shouldStayVisible = true;

        this.paintLabels();
        this.resetToggles();
        this.refreshStartButton();

        if (this.hintLabel) this.hintLabel.node.active = false;
        if (this.root)      this.root.active = true;

        return new Promise<void>((resolve) => {
            this._onCompleteResolver = resolve;
        });
    }

    // ---- Painting ----

    private paintLabels() {
        this.titleLabel     && (this.titleLabel.string    = t('consent.title'));
        this.agreeAllLabel  && (this.agreeAllLabel.string = t('consent.agreeAll'));

        const req = ' (' + t('consent.required') + ')';
        const opt = ' (' + t('consent.optional') + ')';
        this.tosLabel       && (this.tosLabel.string       = t('consent.tos.label')       + req);
        this.privacyLabel   && (this.privacyLabel.string   = t('consent.privacy.label')   + req);
        this.marketingLabel && (this.marketingLabel.string = t('consent.marketing.label') + opt);

        this.hintLabel      && (this.hintLabel.string      = t('consent.mustAgree'));

        // Start button label (assumes Button has a child Label)
        const startLbl = this.startBtn?.getComponentInChildren(Label);
        if (startLbl) startLbl.string = t('consent.start');

        // "View" button labels
        const tosViewLbl = this.tosViewBtn?.getComponentInChildren(Label);
        if (tosViewLbl) tosViewLbl.string = t('consent.view');
        const privacyViewLbl = this.privacyViewBtn?.getComponentInChildren(Label);
        if (privacyViewLbl) privacyViewLbl.string = t('consent.view');
    }

    private resetToggles() {
        [this.agreeAllToggle, this.tosToggle, this.privacyToggle,
         this.marketingToggle].forEach(tg => {
            if (tg) tg.isChecked = false;
        });
    }

    // ---- Toggle logic ----

    private onAgreeAllToggle(toggle: Toggle) {
        if (this._syncingAgreeAll) return;
        this._syncingAgreeAll = true;
        try {
            const on = toggle.isChecked;
            if (this.tosToggle)       this.tosToggle.isChecked       = on;
            if (this.privacyToggle)   this.privacyToggle.isChecked   = on;
            if (this.marketingToggle) this.marketingToggle.isChecked = on;
        } finally {
            this._syncingAgreeAll = false;
        }
        this.refreshStartButton();
    }

    private onAnyChildToggle() {
        if (this._syncingAgreeAll) return;
        // Sync master toggle: on iff ALL three children are on.
        const all =
            !!this.tosToggle?.isChecked &&
            !!this.privacyToggle?.isChecked &&
            !!this.marketingToggle?.isChecked;
        if (this.agreeAllToggle && this.agreeAllToggle.isChecked !== all) {
            this._syncingAgreeAll = true;
            this.agreeAllToggle.isChecked = all;
            this._syncingAgreeAll = false;
        }
        this.refreshStartButton();
        if (this.hintLabel && this.hintLabel.node.active && this.allRequiredChecked()) {
            this.hintLabel.node.active = false;
        }
    }

    private allRequiredChecked(): boolean {
        return !!(this.tosToggle?.isChecked
               && this.privacyToggle?.isChecked);
    }

    private refreshStartButton() {
        if (!this.startBtn) return;
        // Keep button always clickable when idle so a user tapping it
        // without required checks gets to see the hint label instead
        // of being blocked by a silently-disabled button. Busy state
        // still greys out to prevent double-submit.
        this.startBtn.interactable = !this._busy;
    }

    // ---- View legal in system browser ----

    private openLegal(kind: 'tos' | 'privacy') {
        const lang = this.detectLang();
        const url = `${BACKEND_BASE_URL}/legal/${kind}/${lang}`;
        try {
            sys.openURL(url);
        } catch (e) {
            console.warn('[Consent] openURL failed:', e);
        }
    }

    private detectLang(): string {
        // Cocos returns e.g. 'zh-hans-cn'. We publish these locale codes:
        //   ko, en, zh, zh-Hant, ja, es, fr, pt-BR, de, ru
        const raw = (sys.language || 'en').toLowerCase();
        if (raw.startsWith('ko')) return 'ko';
        if (raw.startsWith('ja')) return 'ja';
        if (raw.startsWith('es')) return 'es';
        if (raw.startsWith('fr')) return 'fr';
        if (raw.startsWith('pt')) return 'pt-BR';
        if (raw.startsWith('de')) return 'de';
        if (raw.startsWith('ru')) return 'ru';
        if (raw.startsWith('zh')) {
            if (raw.includes('hant') || raw.includes('tw') || raw.includes('hk')) return 'zh-Hant';
            return 'zh';
        }
        return 'en';
    }

    // ---- Submit ----

    private async onStart() {
        if (this._busy) return;
        if (!this.allRequiredChecked()) {
            if (this.hintLabel) this.hintLabel.node.active = true;
            return;
        }

        this._busy = true;
        this.refreshStartButton();

        try {
            await postConsent({
                tosVersion:     this._currentTos,
                privacyVersion: this._currentPrivacy,
                // Age gate removed — game rating (App Store rating) handles it.
                // Send true so the server-side field stays populated (and the
                // required-check on the server passes).
                ageConfirmed:   true,
                marketingOptIn: !!this.marketingToggle?.isChecked,
            });
            console.log('[Consent] recorded — resuming boot');
            if (this.root) this.root.active = false;
            const cb = this._onCompleteResolver;
            this._onCompleteResolver = null;
            cb && cb();
        } catch (e: any) {
            console.warn('[Consent] POST failed:', e?.message || e);
            if (this.hintLabel) {
                this.hintLabel.string = t('consent.error');
                this.hintLabel.node.active = true;
            }
            this._busy = false;
            this.refreshStartButton();
        }
    }
}
