/**
 * ActivityWebView —— 打开活动 web 页面 + 桥接
 *
 * 客户端在 web-first 活动系统里的入口。主菜单点活动图标 →
 * `ActivityWebView.instance.open(iconInfo)`：
 *   1. 换一个 30s 有效的 session token
 *   2. 拼 URL：`${BACKEND_BASE_URL}${activityPath}?session=<token>&lang=<lang>`
 *   3. 拉 WebView 覆盖全屏，加载 URL
 *   4. 监听 web 页面通过 postMessage / URL-scheme 送回来的事件
 *      （领奖成功、返回按钮、进度刷新…）
 *   5. 关闭时 stopLoading + removeFromParent + null 引用避免泄漏
 *
 * ┌──────────────────────────────────────────────────────────────────┐
 * │  Web ↔ Native 桥（服务器 web 页面用）                             │
 * │                                                                  │
 * │  桌面浏览器（预览 / 编辑器 / iframe）：                            │
 * │      window.parent.postMessage(msg, '*')                         │
 * │      msg 是 JSON.stringify 过的 ActivityWebEvent                 │
 * │                                                                  │
 * │  Cocos 原生 WebView（iOS/Android/OneStore）：                     │
 * │      location.href = 'tetritower://activity?data=' +             │
 * │          encodeURIComponent(JSON.stringify(msg))                 │
 * │      本组件用 setOnJSCallback 解析                                │
 * └──────────────────────────────────────────────────────────────────┘
 *
 * 事件类型（暂定，服务器保持前向兼容 —— 未识别的 type 客户端忽略）：
 *   { "type": "close" }                              关闭 webview 回到游戏
 *   { "type": "claimed", "gems": 50, "items":[...] } 领奖成功；客户端刷余额
 *   { "type": "progress-changed" }                   进度变了，客户端可以更新图标角标
 *   { "type": "open-url", "url": "..." }             外链，走系统浏览器
 */

import {
    _decorator, Component, Node, WebView, UITransform, view,
    director, Canvas, sys,
} from 'cc';
import { fetchActivityWebViewSession, ActivityIcon } from '../core/ActivityApi';
import { BACKEND_BASE_URL } from '../core/BackendConfig';
import { getLang } from '../core/i18n/I18n';
import { emitBalance } from '../core/WalletApi';
import { BackKeyManager } from './BackKeyManager';

const { ccclass } = _decorator;

/** 事件模型：web 页面回给客户端的消息。 */
export type ActivityWebEvent =
    | { type: 'close' }
    | { type: 'claimed'; gems?: number; items?: Array<{ itemId: string; count: number }> }
    | { type: 'progress-changed' }
    | { type: 'open-url'; url: string }
    | { type: string; [k: string]: any };  // forward-compat

/** 单例。挂在 canvas 下的固定 Node 上，或第一次 open() 时懒创建。 */
@ccclass('ActivityWebView')
export class ActivityWebView extends Component {

    // ---- 单例 ----
    private static _instance: ActivityWebView | null = null;
    public static get instance(): ActivityWebView | null { return ActivityWebView._instance; }

    /** 懒创建单例：找不到已挂的组件就在 Canvas 下动态挂一个空 Node。 */
    public static ensure(): ActivityWebView {
        if (ActivityWebView._instance) return ActivityWebView._instance;
        const canvas = director.getScene()?.getComponentInChildren(Canvas)?.node;
        if (!canvas) throw new Error('ActivityWebView.ensure: no Canvas in scene');
        const holder = new Node('ActivityWebViewHolder');
        holder.parent = canvas;
        holder.layer  = canvas.layer;
        const c = holder.addComponent(ActivityWebView);
        ActivityWebView._instance = c;
        return c;
    }

    // ---- 运行时状态 ----
    private _webViewNode: Node | null = null;
    private _webView:     WebView | null = null;
    private _isOpen = false;
    private _onEvent: ((e: ActivityWebEvent) => void) | null = null;
    private _backHandler = () => this.close();

    onLoad(): void {
        if (!ActivityWebView._instance) ActivityWebView._instance = this;
    }

    onDestroy(): void {
        if (ActivityWebView._instance === this) ActivityWebView._instance = null;
        this._teardownWebView();
    }

    /** 打开一个活动的 web 页面。
     *  @param icon 服务器返回的 ActivityIcon（拿它的 activityPath / id）
     *  @param onEvent 可选：接收 web → native 事件的回调 */
    public async open(icon: ActivityIcon, onEvent?: (e: ActivityWebEvent) => void): Promise<void> {
        if (this._isOpen) {
            console.warn('[ActivityWebView] already open — ignoring open()');
            return;
        }
        this._isOpen = true;
        this._onEvent = onEvent ?? null;

        // 1) 换 session token（30s 有效）
        let token = '';
        try {
            const res = await fetchActivityWebViewSession();
            token = res.sessionToken;
        } catch (err: any) {
            console.warn('[ActivityWebView] session-token failed:', err?.message || err);
            this._isOpen = false;
            return;
        }

        // 2) 拼 URL —— session + lang + bridge。bridge 显式告诉 web
        //    页面用哪种回传方式：原生 WebView 用 `scheme`（location.href
        //    = 'tetritower://…'），浏览器/iframe 用 `postMessage`。
        //    页面自己也会自动判断，但显式指定更稳。
        const bridge = sys.isBrowser ? 'postMessage' : 'scheme';
        const sep = icon.activityPath.includes('?') ? '&' : '?';
        const url = `${BACKEND_BASE_URL}${icon.activityPath}`
                  + `${sep}session=${encodeURIComponent(token)}`
                  + `&lang=${encodeURIComponent(getLang())}`
                  + `&bridge=${bridge}`;

        // 3) 建 WebView 覆盖全屏
        this._spawnWebView(url);

        // 4) 注册返回键 —— Android 硬件返回键 / 编辑器 ESC 都能关掉
        BackKeyManager.push(this._backHandler);
    }

    /** 关闭 webview 回到游戏。触发路径：
     *   - 右上角原生 X 按钮（点击）
     *   - web 页面发 postMessage / scheme {type:'close'}
     *   - Android 硬件返回键 / 编辑器 ESC（BackKeyManager）
     *   - 外部调用 close()
     *  幂等：重复调用只 pop 一次返回栈。 */
    public close(): void {
        if (!this._isOpen) return;
        BackKeyManager.pop(this._backHandler);
        this._teardownWebView();
        this._isOpen = false;
        this._onEvent = null;
    }

    public get isOpen(): boolean { return this._isOpen; }

    // ------------------------------------------------------------------
    //  WebView spawn / teardown
    // ------------------------------------------------------------------

    private _spawnWebView(url: string): void {
        const canvas = director.getScene()?.getComponentInChildren(Canvas)?.node;
        if (!canvas) return;

        const node = new Node('ActivityWebViewPane');
        node.parent = canvas;
        node.layer  = canvas.layer;
        node.setSiblingIndex(99999);   // 覆盖所有 UI

        // 铺满可视区域。页面自带 ✕ 按钮 + 我这边已修好原生桥的 3 个
        // bug，close 事件在所有平台都能收到；原生兜底按钮已删掉，
        // 所以 WebView 不用给顶部让位。
        const vs = view.getVisibleSize();
        const ut = node.addComponent(UITransform);
        ut.setContentSize(vs.width, vs.height);

        const web = node.addComponent(WebView);
        web.url = url;
        this._webViewNode = node;
        this._webView = web;

        // 原生兜底关闭按钮已删掉 —— 页面自带 ✕ + 3 个原生桥 bug 修好
        // 后，close 事件所有平台都能收到；返回键还有 BackKeyManager 兜底。

        // ---- 桥接：web → native ----
        // 原生 WebView：设一个自定义 scheme，web 端 `location.href =
        // 'tetritower://...'` 会触发这个回调，URL 里带 payload。
        // Cocos 3.x 回调签名是 (url)，2.x 是 (sender, url) —— 用
        // rest args + 类型嗅探同时兼容。
        try {
            (web as any).setJavascriptInterfaceScheme?.('tetritower');
            (web as any).setOnJSCallback?.((...args: any[]) => {
                const urlFromWeb = args.find(a => typeof a === 'string');
                if (urlFromWeb) this._handleBridgeUrl(urlFromWeb);
            });
        } catch (err) {
            // Web / editor 平台没有这些 API，走 postMessage fallback
        }

        // Web / editor 平台的 postMessage fallback：iframe 里 window.parent.
        // postMessage(payload, '*') 会走全局 message 事件。
        if (sys.isBrowser && typeof window !== 'undefined') {
            window.addEventListener('message', this._onWindowMessage);
        }
    }

    private _teardownWebView(): void {
        if (sys.isBrowser && typeof window !== 'undefined') {
            window.removeEventListener('message', this._onWindowMessage);
        }
        if (this._webView) {
            try { (this._webView as any).stopLoading?.(); } catch { /* best-effort */ }
        }
        if (this._webViewNode && this._webViewNode.isValid) {
            this._webViewNode.destroy();
        }
        this._webView = null;
        this._webViewNode = null;
    }


    // ------------------------------------------------------------------
    //  Bridge event routing
    // ------------------------------------------------------------------

    private _onWindowMessage = (ev: MessageEvent): void => {
        // 只接受来自我们后端 origin 的消息，防止别的 iframe 乱发。
        try {
            const backendOrigin = new URL(BACKEND_BASE_URL).origin;
            if (ev.origin !== backendOrigin) return;
        } catch { /* URL 解析失败就宽松放过 */ }
        this._dispatchRawPayload(ev.data);
    };

    private _handleBridgeUrl(url: string): void {
        // url 形如 tetritower://activity?data=<encoded json>
        // Cocos 原生 V8/JSC 不提供 URL 类，用正则解析。
        // `searchParams.get` 在浏览器里已经 decode 一次，用正则拿原始
        // encoded 字符串再 decodeURIComponent 一次，避免重复解码。
        const m = /[?&]data=([^&#]*)/.exec(url || '');
        if (!m) return;
        try {
            this._dispatchRawPayload(JSON.parse(decodeURIComponent(m[1])));
        } catch (err) {
            console.warn('[ActivityWebView] bad bridge url:', url);
        }
    }

    private _dispatchRawPayload(payload: any): void {
        let evt: ActivityWebEvent | null = null;
        if (typeof payload === 'string') {
            try { evt = JSON.parse(payload); } catch { /* not JSON, drop */ }
        } else if (payload && typeof payload === 'object') {
            evt = payload as ActivityWebEvent;
        }
        if (!evt || !evt.type) return;

        // 内置事件处理 —— 客户端全局能反应的（余额、关闭）
        switch (evt.type) {
            case 'close':
                this.close();
                break;
            case 'claimed':
                if (typeof (evt as any).gems === 'number') {
                    // gems 是"发完后的总数"，直接广播给订阅方（HUD / 主页余额）
                    emitBalance((evt as any).gems);
                }
                // 背包 items 让上层监听决定怎么刷（BackpackController.refresh() 等）
                break;
            case 'open-url':
                if ((evt as any).url && sys.openURL) sys.openURL((evt as any).url);
                break;
            default:
                // 交给上层监听者，不识别就跳过
                break;
        }
        // 外部监听者拿全量事件
        try { this._onEvent?.(evt); } catch (e) { console.warn('[ActivityWebView] onEvent threw', e); }
    }
}
