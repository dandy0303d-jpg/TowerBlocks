/**
 * ActivityApi — thin HTTP layer for the web-first activity system.
 *
 * 客户端职责被压到最小：
 *   1. 拉活动图标列表 → 主菜单展示
 *   2. 上报游戏内事件进度（消行、通关…）
 *   3. 需要打开活动时向服务器换一个短期 session token，WebView 用它加载页面
 *
 * 所有 UI（活动详情、进度条、领奖按钮、i18n）都在服务器渲染的 web 页面里完成，
 * 客户端不知道活动 tiers / rewards 长什么样。
 *
 * Endpoints
 *   GET  /activity/icons                           —— 公开或 bearer+sig
 *   POST /player/activity/progress                 —— bearer + sig
 *   POST /player/activity/webview-session          —— bearer + sig，返回一次性 token
 *
 * 契约变更历史
 *   2026-09-28 v2 —— 从原生面板改为 web-first。删掉了 fetchActivityList /
 *                    fetchPlayerActivity / claimActivityTier；这些逻辑现在
 *                    完全在服务器的 web 页面里。见 INBOX_SERVER.md 同期消息。
 */

import { BACKEND_BASE_URL, BACKEND_TIMEOUT_MS } from './BackendConfig';
import { httpGetJson, httpPostJson } from './Http';

// ---------------------------------------------------------------------------
//  Types
// ---------------------------------------------------------------------------

export interface ActivityIcon {
    /** 活动唯一 id。用于打开 WebView 时传给服务器换 session token。 */
    id:          string;
    /** 图标图片 URL（可能是 CDN 上的静态图，也可能是服务器 serve 的路径）。
     *  客户端下载后原生渲染。 */
    iconUrl:     string;
    /** 打开活动时用的 web 页面路径（一般是相对 BACKEND_BASE_URL 的路径，
     *  比如 `/activity/clear_lines_1000/view`）。客户端 WebView 加载：
     *      `${BACKEND_BASE_URL}${activityPath}?session=<token>&lang=<lang>` */
    activityPath: string;
    /** 图标右上角红点角标数字。0 = 不显示角标。服务器根据玩家可领取档位数
     *  预算好返回，客户端不用自己算。 */
    badgeCount:  number;
    /** 排序权重，升序。同分随便。 */
    sort:        number;
}

export interface ActivityIconsResult {
    /** 当前该玩家能看到的所有活动图标（服务器已按状态 / 时间窗过滤）。
     *  空数组时主菜单不显示任何图标。 */
    icons: ActivityIcon[];
    /** ISO8601 —— 客户端可以用来展示"活动截止倒计时"，或者对时。 */
    serverTime: string;
}

export interface ProgressReportResult {
    ok:        true;
    /** 幂等：true 表示这个 clientTxnId 已经上报过一次。 */
    duplicate: boolean;
    /** 服务器可选返回受影响活动 id 列表，供客户端刷新图标角标。
     *  没有 UI 依赖时忽略也 OK。 */
    affectedActivityIds?: string[];
}

export interface WebViewSessionResult {
    /** 30 秒有效的一次性 token。用来给 WebView 加载 URL 传参，服务器
     *  拿到后换成本次会话的 cookie 或 header。 */
    sessionToken: string;
    /** 建议客户端在此毫秒内加载 WebView；超过后 token 服务端会拒。 */
    expiresInMs:  number;
}

// ---------------------------------------------------------------------------
//  API calls
// ---------------------------------------------------------------------------

/** Pull the list of activity icons for THIS player. Server has already
 *  applied all filters (live status, time window, per-player targeting,
 *  A/B bucket…). Client just paints what comes back. */
export async function fetchActivityIcons(): Promise<ActivityIconsResult> {
    const url = `${BACKEND_BASE_URL}/activity/icons`;
    // 服务器要 bearer + signature，第三参数 sign=true 让 Http 加签
    return httpGetJson<ActivityIconsResult>(url, BACKEND_TIMEOUT_MS, true);
}

/** Report a progress delta for a shared progressKey. Server fans out
 *  across every live activity subscribing to that key. Idempotent via
 *  `clientTxnId`.
 *
 *  Constraints (mirrored server-side):
 *    - `delta` MUST be an integer in [1, 500]
 *    - `clientTxnId` MUST match /^[A-Za-z0-9-]{8,64}$/ (UUID v4 fine)
 *
 *  Callers typically don't touch this directly — use
 *  `ActivityProgressReporter.report()` which handles batching + retry. */
export async function reportActivityProgress(
    progressKey: string,
    delta:       number,
    clientTxnId: string,
): Promise<ProgressReportResult> {
    if (!Number.isInteger(delta) || delta < 1 || delta > 500) {
        throw new Error(`reportActivityProgress: bad delta ${delta} (must be integer 1..500)`);
    }
    if (!/^[A-Za-z0-9-]{8,64}$/.test(clientTxnId)) {
        throw new Error(`reportActivityProgress: bad clientTxnId "${clientTxnId}"`);
    }
    const url = `${BACKEND_BASE_URL}/player/activity/progress`;
    return httpPostJson<ProgressReportResult>(
        url,
        { progressKey, delta, clientTxnId },
        BACKEND_TIMEOUT_MS,
    );
}

/** Request a short-lived session token used to authenticate the
 *  activity WebView. Client immediately loads
 *  `${activityPath}?session=<token>&lang=<lang>` — server exchanges the
 *  token for a real session cookie on first hit and the rest of the
 *  activity flow runs cookie-authed inside the webview.
 *
 *  Token expires fast (~30s) so a lost / intercepted token is
 *  short-window bounded. */
export async function fetchActivityWebViewSession(): Promise<WebViewSessionResult> {
    const url = `${BACKEND_BASE_URL}/player/activity/webview-session`;
    return httpPostJson<WebViewSessionResult>(url, {}, BACKEND_TIMEOUT_MS);
}
