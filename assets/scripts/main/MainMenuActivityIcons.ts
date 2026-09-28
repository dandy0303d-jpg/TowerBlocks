/**
 * MainMenuActivityIcons —— 主菜单的活动图标区
 *
 * 每个活动一个图标，点击打开 WebView（`ActivityWebView`）。图标右上角
 * 有个可选的红点 + 数字，标记玩家有多少档可领奖；`badgeCount === 0`
 * 时不显示。
 *
 * 图标数据来自服务器 `GET /activity/icons`，客户端不知道活动 tier 细节，
 * 只知道图标 URL、活动路径、角标数。
 *
 * 自动刷新时机
 *   - 组件 `onEnable`：拉一次
 *   - `ActivityProgressReporter` 每次上报响应：重拉（`affectedActivityIds`
 *     暗示可能有档位跨过阈值）
 *   - `ActivityWebView` 事件 `claimed` / `progress-changed`：重拉
 *   - 关闭 WebView 后：重拉（玩家可能刚在 web 里领了奖）
 *
 * 场景挂接
 *   在 Cocos 里做一个空 Node 作为图标容器（挂一个 Layout 组件比如
 *   `HORIZONTAL` 自动排列），把这个组件挂到主菜单场景任意位置，把容器
 *   Node 拖到 `authoredIconContainer`。图标节点是脚本创建的，作者不用
 *   建预制。
 *
 *   如果想让图标视觉更定制（描边、光晕、动效），拖一个自定义的图标
 *   预制到 `authoredIconTemplate`，脚本会克隆它并把 Sprite 塞进去；不
 *   拖模板就用一个默认的 100×100 Sprite。
 */

import {
    _decorator, Component, Node, Sprite, SpriteFrame, Texture2D, ImageAsset,
    UITransform, UIOpacity, Color, assetManager, instantiate, EventTouch,
    tween, Tween, Vec3,
} from 'cc';
import { fetchActivityIcons, ActivityIcon } from '../core/ActivityApi';
import { ActivityProgressReporter } from '../core/ActivityProgressReporter';
import { ActivityWebView, ActivityWebEvent } from './ActivityWebView';

const { ccclass, property } = _decorator;

@ccclass('MainMenuActivityIcons')
export class MainMenuActivityIcons extends Component {

    @property({ type: Node, tooltip: '图标容器 Node（一般挂 Layout 组件自动排列）。脚本会往里 spawn 图标子节点。' })
    authoredIconContainer: Node | null = null;

    @property({ type: Node, tooltip: '（可选）图标模板 Node。留空则用默认 100×100 Sprite。模板里的子节点 "IconSprite"（Sprite）会被脚本填 SpriteFrame；"BadgeRoot" 是可选的红点根 Node（内含 Label "BadgeLabel"）。' })
    authoredIconTemplate: Node | null = null;

    @property({ type: SpriteFrame, tooltip: '有奖可领时右上角显示的红点小图（比如红底白色感叹号）。留空则不显示红点。资源建议：textures/ui/activity_badge.png' })
    badgeFrame: SpriteFrame | null = null;

    @property({ type: SpriteFrame, tooltip: '图标周围随机冒的火花小图（一颗星星）。留空则不显示粒子。资源建议：textures/ui/sparkle_star.png' })
    sparkleFrame: SpriteFrame | null = null;

    @property({ tooltip: '图标默认边长（模板为空时用）。' })
    defaultIconSize: number = 100;

    @property({ tooltip: '玩家上报进度 / 领奖后自动重拉图标。想省点请求可以关掉。' })
    autoRefresh: boolean = true;

    /** 上一次拉取到的图标列表 —— 便于外部（如别的 controller）读取。 */
    private _icons: ActivityIcon[] = [];
    private _iconNodes = new Map<string, Node>();
    private _texCache  = new Map<string, SpriteFrame>();
    private _unsubReporter: (() => void) | null = null;
    private _refreshInFlight = false;

    onLoad(): void {
        if (this.authoredIconTemplate) this.authoredIconTemplate.active = false;
    }

    onEnable(): void {
        // 打开菜单第一时间拉一次
        void this._refresh();
        // 订阅进度上报 —— 只要 delta 到了服务器，就有可能跨阈值 → 刷角标
        if (this.autoRefresh) {
            this._unsubReporter?.();
            this._unsubReporter = ActivityProgressReporter.subscribe(() => { void this._refresh(); });
        }
    }

    onDisable(): void {
        this._unsubReporter?.();
        this._unsubReporter = null;
    }

    onDestroy(): void {
        this._teardownIcons();
    }

    // ------------------------------------------------------------------
    //  Refresh cycle
    // ------------------------------------------------------------------

    private async _refresh(): Promise<void> {
        if (this._refreshInFlight) return;
        this._refreshInFlight = true;
        try {
            const res = await fetchActivityIcons();
            this._icons = [...res.icons].sort((a, b) => a.sort - b.sort);
            this._rebuild();
        } catch (err: any) {
            console.warn('[ActivityIcons] fetch failed:', err?.message || err);
        } finally {
            this._refreshInFlight = false;
        }
    }

    private _rebuild(): void {
        if (!this.authoredIconContainer) return;
        this._teardownIcons();
        for (const icon of this._icons) {
            const node = this._spawnIconNode(icon);
            if (!node) continue;
            this._iconNodes.set(icon.id, node);
        }
    }

    private _teardownIcons(): void {
        // 清掉 spawn sparkle 的定时回调，避免每次 rebuild 叠加
        this.unscheduleAllCallbacks();
        for (const n of this._iconNodes.values()) {
            if (n && n.isValid) {
                Tween.stopAllByTarget(n);
                n.destroy();
            }
        }
        this._iconNodes.clear();
    }

    // ------------------------------------------------------------------
    //  Icon spawn
    // ------------------------------------------------------------------

    private _spawnIconNode(icon: ActivityIcon): Node | null {
        if (!this.authoredIconContainer) return null;
        const node = this.authoredIconTemplate
            ? instantiate(this.authoredIconTemplate)
            : this._makeDefaultIconNode();
        node.active = true;
        node.parent = this.authoredIconContainer;
        node.layer  = this.authoredIconContainer.layer;

        // ---- 主图：优先用模板里名叫 "IconSprite" 的子节点，找不到就取
        //      根节点上的 Sprite（默认模板就一个 Sprite）
        const sprNode = node.getChildByName('IconSprite') || node;
        const spr = sprNode.getComponent(Sprite) || sprNode.addComponent(Sprite);
        spr.sizeMode = Sprite.SizeMode.CUSTOM;
        this._loadSpriteFrame(icon.iconUrl).then(sf => {
            if (sf && spr && spr.node && spr.node.isValid) spr.spriteFrame = sf;
        });

        // ---- 角标
        this._paintBadge(node, icon.badgeCount);

        // ---- 粒子特效
        this._startIconSparkles(node);

        // ---- 点击
        node.off(Node.EventType.TOUCH_END);
        node.on(Node.EventType.TOUCH_END, (_e: EventTouch) => this._onIconTap(icon), this);

        return node;
    }

    /** 活动图标周围随机冒星星 —— 每 ~0.6 秒 spawn 一颗小星星，
     *  淡入 + scale 长大再回缩，同时轻微自转，最后自 destroy。
     *  用独立的 sparkleFrame（星星贴图），不复用 badgeFrame。
     *  没 sparkleFrame 就跳过。 */
    private _startIconSparkles(iconNode: Node): void {
        if (!this.sparkleFrame) return;
        const parentUT = iconNode.getComponent(UITransform);
        if (!parentUT) return;
        const hw = parentUT.width  / 2;
        const hh = parentUT.height / 2;
        const spawn = () => {
            if (!iconNode.isValid) return;
            const sp = new Node('Sparkle');
            sp.parent = iconNode;
            sp.layer  = iconNode.layer;
            const size = 14 + Math.random() * 10;
            sp.addComponent(UITransform).setContentSize(size, size);
            const spr = sp.addComponent(Sprite);
            spr.sizeMode    = Sprite.SizeMode.CUSTOM;
            spr.spriteFrame = this.sparkleFrame;
            // 微微冷/暖偏色，让每颗看起来不一样
            const warm = Math.random() < 0.5;
            spr.color = warm
                ? new Color(255, 240, 180, 255)
                : new Color(220, 240, 255, 255);
            // 图标边界内偏外一点，纯装饰
            const rx = (Math.random() - 0.5) * (hw * 1.7);
            const ry = (Math.random() - 0.5) * (hh * 1.7);
            sp.setPosition(rx, ry, 0);
            sp.setScale(0.1, 0.1, 1);
            sp.angle = Math.random() * 360;
            const op = sp.addComponent(UIOpacity);
            op.opacity = 0;
            tween(op)
                .to(0.15, { opacity: 240 })
                .delay(0.25)
                .to(0.25, { opacity: 0 })
                .start();
            const spin = (Math.random() < 0.5 ? -1 : 1) * (90 + Math.random() * 90);
            tween(sp)
                .to(0.25, { scale: new Vec3(1.35, 1.35, 1), angle: sp.angle + spin }, { easing: 'quadOut' })
                .to(0.40, { scale: new Vec3(0.1,  0.1,  1), angle: sp.angle + spin * 1.5 }, { easing: 'quadIn' })
                .call(() => { if (sp.isValid) sp.destroy(); })
                .start();
        };
        // 用 Component.schedule 挂周期，rebuild 时 unscheduleAll 会清掉
        this.schedule(spawn, 0.6, Number.POSITIVE_INFINITY, 0.2);
    }

    private _makeDefaultIconNode(): Node {
        const n = new Node('ActivityIcon');
        const ut = n.addComponent(UITransform);
        ut.setContentSize(this.defaultIconSize, this.defaultIconSize);
        const spr = n.addComponent(Sprite);
        spr.sizeMode = Sprite.SizeMode.CUSTOM;
        return n;
    }

    /** 红点：优先用模板里名叫 "BadgeRoot" 的子节点（作者可以美化）；
     *  找不到就用 badgeFrame SpriteFrame 建一个默认的小图标。
     *  `count === 0` 时整个隐藏。设计要求只显示图标不显示数字。 */
    private _paintBadge(iconNode: Node, count: number): void {
        let badge = iconNode.getChildByName('BadgeRoot');
        if (!badge) {
            badge = this._makeDefaultBadge();
            if (!badge) return;   // badgeFrame 没配就跳过（不建空节点）
            badge.parent = iconNode;
            badge.layer  = iconNode.layer;
            // 摆到右上角，稍微压在图标边框上
            const parentUT = iconNode.getComponent(UITransform);
            if (parentUT) {
                badge.setPosition(parentUT.width / 2 - 10, parentUT.height / 2 - 10, 0);
            }
        }
        badge.active = count > 0;
        if (badge.active) this._startBadgeBounce(badge);
        else Tween.stopAllByTarget(badge);
    }

    /** 红点定期蹦跶 —— 缩放 1 → 1.35 → 0.9 → 1.15 → 1，做两次弹跳，
     *  然后停 2.4 秒，循环。用 tween 链 + repeatForever。停手：
     *  `Tween.stopAllByTarget(badge)`（隐藏时 / rebuild 时）。
     *  同一个 badge 已经在动就不再叠加。 */
    private _startBadgeBounce(badge: Node): void {
        Tween.stopAllByTarget(badge);
        badge.setScale(1, 1, 1);
        const one = new Vec3(1, 1, 1);
        const big = new Vec3(1.35, 1.35, 1);
        const dip = new Vec3(0.9, 0.9, 1);
        const mid = new Vec3(1.15, 1.15, 1);
        tween(badge)
            .repeatForever(
                tween(badge)
                    .to(0.12, { scale: big }, { easing: 'quadOut' })
                    .to(0.10, { scale: dip }, { easing: 'quadIn'  })
                    .to(0.10, { scale: mid }, { easing: 'quadOut' })
                    .to(0.12, { scale: one }, { easing: 'quadIn'  })
                    .delay(0.15)
                    .to(0.10, { scale: mid }, { easing: 'quadOut' })
                    .to(0.14, { scale: one }, { easing: 'backOut' })
                    .delay(2.4),
            )
            .start();
    }

    private _makeDefaultBadge(): Node | null {
        if (!this.badgeFrame) return null;
        const badge = new Node('BadgeRoot');
        badge.addComponent(UITransform).setContentSize(34, 35);   // 图标 100×100 时的建议大小
        const spr = badge.addComponent(Sprite);
        spr.sizeMode    = Sprite.SizeMode.CUSTOM;
        spr.spriteFrame = this.badgeFrame;
        return badge;
    }

    // ------------------------------------------------------------------
    //  Remote image loader
    // ------------------------------------------------------------------

    private _loadSpriteFrame(url: string): Promise<SpriteFrame | null> {
        const cached = this._texCache.get(url);
        if (cached) return Promise.resolve(cached);
        return new Promise((resolve) => {
            // 简单 URL 后缀嗅探 —— Cocos assetManager.loadRemote 需要
            // 显式 ext（url 里没扩展名的话）。默认按 png 处理。
            const ext = /\.(png|jpg|jpeg|webp)($|\?)/i.exec(url)?.[1] || 'png';
            assetManager.loadRemote<ImageAsset>(url, { ext: '.' + ext }, (err, asset) => {
                if (err || !asset) {
                    console.warn('[ActivityIcons] loadRemote fail:', url, err?.message);
                    resolve(null);
                    return;
                }
                const tex = new Texture2D();
                tex.image = asset as ImageAsset;
                const sf = new SpriteFrame();
                sf.texture = tex;
                this._texCache.set(url, sf);
                resolve(sf);
            });
        });
    }

    // ------------------------------------------------------------------
    //  Tap handler
    // ------------------------------------------------------------------

    private _onIconTap(icon: ActivityIcon): void {
        // 小反馈：按下时缩一下再打开 WebView
        const node = this._iconNodes.get(icon.id);
        if (node && node.isValid) {
            tween(node)
                .to(0.06, { scale: new Vec3(0.92, 0.92, 1) })
                .to(0.08, { scale: new Vec3(1,    1,    1) })
                .start();
        }
        const web = ActivityWebView.ensure();
        void web.open(icon, (evt: ActivityWebEvent) => {
            // WebView 里领了奖 / 进度变了 → 刷图标角标；关闭时也刷一次
            if (evt.type === 'claimed' || evt.type === 'progress-changed' || evt.type === 'close') {
                void this._refresh();
            }
        });
    }
}
