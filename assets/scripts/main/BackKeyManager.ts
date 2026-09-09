/**
 * BackKeyManager — global handler for the Android hardware / gesture
 * back key (and desktop Escape, for parity in editor / web preview).
 *
 * Contract
 * ========
 *   push(handler) — add a handler to the top of a LIFO stack. Called
 *                   FIRST when the back key fires. Return true to
 *                   consume; false to bubble down the stack.
 *   pop(handler)  — remove a specific handler from the stack. Safe
 *                   to call even if the handler isn't in the stack.
 *   setDefault(fn)— bottom-of-stack fallback fired ONLY when every
 *                   push()ed handler returned false OR the stack was
 *                   empty. Typically registered ONCE by MenuController
 *                   ("main menu → show exit-confirm modal").
 *
 * Wiring a popup — the standard pattern:
 *   private _back = () => { this.hide(); return true; };
 *   show()  { …; BackKeyManager.push(this._back); }
 *   hide()  { …; BackKeyManager.pop(this._back); }
 *
 * Idempotency notes
 * -----------------
 *   - push() is a no-op if the same handler ref is already at the top
 *     (prevents double-push during re-show flicker).
 *   - Handler returning `undefined` is treated as `true` (most panels
 *     just want "close me, done").
 *   - Async handlers: return a Promise<boolean>; the manager awaits
 *     before falling through to the next entry (guards against races
 *     where the player rapid-taps back through a network-bound close).
 *
 * The Cocos native runtime maps Android's back key to
 * `KeyCode.MOBILE_BACK`. Editor / web / desktop also fire `ESCAPE`
 * on the Esc key, which we accept as a convenience so the same UX
 * works during dev without a real Android device.
 */

import { input, Input, EventKeyboard, KeyCode, native, sys } from 'cc';

type BackHandler = () => boolean | void | Promise<boolean | void>;

class _BackKeyManager {
    private _stack:   BackHandler[] = [];
    private _default: BackHandler | null = null;
    /** Guard so an async handler can't be re-entered by a second key
     *  event mid-flight (common on Android where a fast double-tap
     *  fires two KEY_UP events before the first hide() resolves). */
    private _busy: boolean = false;
    private _installed: boolean = false;

    /** Call once at boot. Idempotent — safe if called multiple times
     *  by different scenes. MenuController wires this in onLoad. */
    public install(): void {
        if (this._installed) return;
        console.log('[BackKeyManager] install() called — native=' + sys.isNative + ' os=' + sys.os);
        // Editor / web / desktop preview path: Cocos delivers Escape
        // (and MOBILE_BACK where it works) through the normal input
        // dispatcher, so we keep this hookup for dev parity.
        input.on(Input.EventType.KEY_UP, this._onKeyUp, this);
        // Android device path: Cocos 3.8's CocosActivity swallows the
        // hardware back key and never fires KeyCode.MOBILE_BACK through
        // input.on. AppActivity.onBackPressed() forwards the press to
        // JS via JsbBridgeWrapper.dispatchEventToScript("androidBack", "")
        // — subscribe here so BackKeyManager fires exactly the same
        // dispatch path as an Escape key would.
        if (sys.isNative && sys.os === sys.OS.ANDROID) {
            try {
                // Mirror GoogleWebOAuth's bridge-accessor pattern —
                // stock Cocos 3.8 exposes `native.jsbBridgeWrapper`,
                // some template builds only hoist it as
                // `jsb.JsbBridgeWrapper.getInstance()`.
                const n: any = native as any;
                const g: any = (globalThis as any);
                let jbw: any = n?.jsbBridgeWrapper;
                if (!jbw || typeof jbw.addNativeEventListener !== 'function') {
                    const legacy: any = g?.jsb?.JsbBridgeWrapper;
                    if (legacy) {
                        jbw = typeof legacy.getInstance === 'function'
                            ? legacy.getInstance()
                            : legacy;
                    }
                }
                console.log('[BackKeyManager] bridge lookup — native.jsbBridgeWrapper='
                    + !!n?.jsbBridgeWrapper
                    + ' jsb.JsbBridgeWrapper=' + !!g?.jsb?.JsbBridgeWrapper
                    + ' resolved=' + (!!jbw && typeof jbw.addNativeEventListener === 'function'));
                if (jbw && typeof jbw.addNativeEventListener === 'function') {
                    jbw.addNativeEventListener('androidBack', (arg: string) => {
                        console.log('[BackKeyManager] androidBack received via wrapper (arg=' + arg + '), stack=' + this._stack.length + ' default=' + !!this._default);
                        void this._dispatch();
                    });
                    console.log('[BackKeyManager] wrapper listener installed OK');
                } else {
                    console.warn('[BackKeyManager] jsbBridgeWrapper unavailable — falling back to raw native.bridge.onNative');
                }

                // ── Low-level fallback: hook `native.bridge.onNative`
                // directly. In Cocos 3.8 the wrapper is *supposed* to
                // install this hook itself and fan out to per-event
                // listeners, but on this device+build the fan-out
                // never fires for `androidBack` even though
                // `dispatchEventToScript("androidBack", "")` is called
                // from AppActivity.dispatchKeyEvent (verified in
                // logcat). Overriding onNative directly gives us a
                // guaranteed pipe. We chain-preserve any pre-existing
                // handler so other subscribers (e.g. the wrapper
                // itself) keep working; anything installed AFTER us
                // (e.g. GoogleBillingProvider.wire()) has to chain in
                // the same way or it'll clobber us — that's a
                // separate bug to fix in whichever provider does so.
                const nb: any = (native as any).bridge;
                if (nb) {
                    const prev = typeof nb.onNative === 'function' ? nb.onNative : null;
                    console.log('[BackKeyManager] hooking native.bridge.onNative — prev existed=' + !!prev);
                    nb.onNative = (event: string, arg: string) => {
                        if (event === 'androidBack') {
                            void this._dispatch();
                            // Also forward to prev so the wrapper's
                            // own subscribers (if any) still hear it.
                        }
                        if (prev) {
                            try { prev(event, arg); }
                            catch (e) { console.warn('[BackKeyManager] prev onNative threw:', (e as Error)?.message); }
                        }
                    };
                } else {
                    console.warn('[BackKeyManager] native.bridge missing — cannot install raw fallback');
                }
            } catch (e) {
                console.warn('[BackKeyManager] bridge install failed:', (e as Error)?.message);
            }
        }
        this._installed = true;
    }

    /** Optional teardown for hot-reload / tests. Not needed in prod
     *  since the manager is a module singleton. */
    public uninstall(): void {
        if (!this._installed) return;
        input.off(Input.EventType.KEY_UP, this._onKeyUp, this);
        this._installed = false;
    }

    public push(h: BackHandler): void {
        // Skip if already at the top — prevents duplicate registration
        // when a panel's show() runs more than once without a matching
        // hide() (e.g. status refresh reopening the same panel).
        if (this._stack[this._stack.length - 1] === h) return;
        // Also strip any older duplicate so pop() cleans up correctly.
        const idx = this._stack.indexOf(h);
        if (idx >= 0) this._stack.splice(idx, 1);
        this._stack.push(h);
    }

    public pop(h: BackHandler): void {
        const idx = this._stack.lastIndexOf(h);
        if (idx >= 0) this._stack.splice(idx, 1);
    }

    public setDefault(fn: BackHandler | null): void {
        this._default = fn;
    }

    /** For debugging / tests only. */
    public get stackDepth(): number { return this._stack.length; }

    // ----------------------------------------------------------

    private _onKeyUp(evt: EventKeyboard): void {
        if (evt.keyCode !== KeyCode.MOBILE_BACK
         && evt.keyCode !== KeyCode.ESCAPE) return;
        void this._dispatch();
    }

    private async _dispatch(): Promise<void> {
        if (this._busy) return;
        this._busy = true;
        try {
            // Walk the stack top-down; first handler to consume wins.
            // Splice while iterating so a handler that pops itself
            // (typical: hide()) doesn't get re-fired.
            while (this._stack.length > 0) {
                const h = this._stack[this._stack.length - 1];
                let consumed: boolean | void;
                try {
                    consumed = await h();
                } catch (e) {
                    console.warn('[BackKeyManager] handler threw:', (e as Error)?.message);
                    consumed = true;   // treat throws as "consumed" — don't cascade
                }
                // Remove the handler if it's still at the top and
                // didn't remove itself. Normal panels call pop() from
                // inside hide(), so this is usually already gone.
                if (this._stack[this._stack.length - 1] === h) {
                    this._stack.pop();
                }
                if (consumed !== false) return;
            }
            if (this._default) {
                try { await this._default(); }
                catch (e) { console.warn('[BackKeyManager] default handler threw:', (e as Error)?.message); }
            }
        } finally {
            this._busy = false;
        }
    }
}

export const BackKeyManager = new _BackKeyManager();
