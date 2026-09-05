/**
 * LeaderboardRow — one row of the scrollable leaderboard list.
 *
 * Author ONE row Node in the scene per the mockup (rank + avatar +
 * name + score + optional top-3 badges), attach this component, wire
 * the @property slots, then save the whole thing as a **Prefab** and
 * drop the Prefab into `LeaderboardController.rowPrefab`.
 *
 * `LeaderboardController.show()` instantiates the Prefab N times
 * (one per entry, up to 500), parents them to the ScrollView's
 * Content node, and calls `populate(entry, avatarFrames)` on each.
 *
 * All slots are optional — a missing slot just gets skipped so a
 * partially-authored prefab still boots without crashing.
 */

import { _decorator, Component, Node, Label, Sprite, SpriteFrame, Button, EventTouch, Vec2 } from 'cc';
import type { LeaderboardEntry } from './LeaderboardController';

/** Drag threshold in UI-space pixels — a touch that moves more than
 *  this between TOUCH_START and TOUCH_END is treated as a scroll
 *  gesture (not a tap) so scrolling the list never selects a row.
 *  Only used by the manual-touch fallback; when the prefab has a
 *  cc.Button the Button handles drag-vs-tap itself. */
const TAP_DRAG_THRESHOLD = 10;

const { ccclass, property } = _decorator;

@ccclass('LeaderboardRow')
export class LeaderboardRow extends Component {

    @property({ type: Label, tooltip: '排名数字 Label（脚本写 "1"/"2"/...）' })
    rankLabel: Label | null = null;

    @property({ type: Sprite, tooltip: '头像 Sprite（脚本按索引从 avatarFrames 池分配 SpriteFrame）' })
    avatarSprite: Sprite | null = null;

    @property({ type: Label, tooltip: '玩家昵称 Label' })
    nameLabel: Label | null = null;

    @property({ type: Label, tooltip: '分数 Label（脚本用 toLocaleString 加千分位）' })
    scoreLabel: Label | null = null;

    /** Top-3 decoration nodes IN this row's prefab. Length 0..3.
     *  Order: [0]=gold (rank 1), [1]=silver (rank 2), [2]=bronze (rank 3).
     *  All hidden by default; `populate()` shows exactly one (or none)
     *  based on this row's rank. */
    @property({ type: [Node], tooltip: '前 3 名的徽章装饰节点（顺序：金/银/铜；可空；同一 row 只会亮 1 个）' })
    badgeNodes: Node[] = [];

    /** Optional "you" highlight node (glow / border). Toggled active
     *  when the row's entry has isYou=true. */
    @property({ type: Node, tooltip: '"我"高亮节点（可空；玩家自己的那行会 setActive(true)）' })
    youHighlight: Node | null = null;

    /** Tap callback — set by LeaderboardController per-mode. Fires when
     *  the user taps this row without dragging (scroll gestures are
     *  filtered by TAP_DRAG_THRESHOLD). null → row is non-interactive. */
    public onClick: ((entry: LeaderboardEntry) => void) | null = null;

    /** Cached last-populated entry — used by the tap handler so click
     *  callbacks receive the same entry the row is currently showing,
     *  even if the pool has been re-populated for a different tab. */
    private _entry: LeaderboardEntry | null = null;

    /** Tap-vs-scroll detection state. */
    private _touchStartPos: Vec2 = new Vec2();
    private _isTap: boolean = false;

    /** True if the prefab has a cc.Button on its root — we prefer the
     *  Button's built-in drag-vs-tap detection (which cooperates with
     *  ScrollView) over our manual TOUCH_* tracking. */
    private _hasButton: boolean = false;

    onLoad(): void {
        // Prefer cc.Button if the prefab carries one — Button emits a
        // 'click' event only when the tap wasn't a scroll drag, and
        // it cooperates with the parent ScrollView natively.
        const btn = this.getComponent(Button);
        if (btn) {
            this._hasButton = true;
            this.node.on('click', this._onButtonClick, this);
        } else {
            // Fallback: manual tap detection with our own drag threshold.
            // Registered once here so pool reuse across tab switches
            // doesn't re-stack handlers.
            this.node.on(Node.EventType.TOUCH_START,  this._onTouchStart,  this);
            this.node.on(Node.EventType.TOUCH_MOVE,   this._onTouchMove,   this);
            this.node.on(Node.EventType.TOUCH_END,    this._onTouchEnd,    this);
            this.node.on(Node.EventType.TOUCH_CANCEL, this._onTouchCancel, this);
        }
    }

    onDestroy(): void {
        if (this._hasButton) {
            this.node.off('click', this._onButtonClick, this);
        } else {
            this.node.off(Node.EventType.TOUCH_START,  this._onTouchStart,  this);
            this.node.off(Node.EventType.TOUCH_MOVE,   this._onTouchMove,   this);
            this.node.off(Node.EventType.TOUCH_END,    this._onTouchEnd,    this);
            this.node.off(Node.EventType.TOUCH_CANCEL, this._onTouchCancel, this);
        }
    }

    /** cc.Button click handler — Button already filtered out scroll
     *  drags, so just fire the callback with the last-populated entry. */
    private _onButtonClick(): void {
        if (this._entry && this.onClick) this.onClick(this._entry);
    }

    private _onTouchStart(e: EventTouch): void {
        this._touchStartPos.set(e.getUILocation());
        this._isTap = true;
    }

    private _onTouchMove(e: EventTouch): void {
        if (!this._isTap) return;
        const cur = e.getUILocation();
        if (Vec2.distance(cur, this._touchStartPos) > TAP_DRAG_THRESHOLD) {
            this._isTap = false;
        }
    }

    private _onTouchEnd(_e: EventTouch): void {
        const wasTap = this._isTap;
        this._isTap = false;
        if (!wasTap) return;
        if (this._entry && this.onClick) this.onClick(this._entry);
    }

    private _onTouchCancel(_e: EventTouch): void {
        this._isTap = false;
    }

    /**
     * Fill this row's Labels + avatar from `entry`. Call once per row
     * per show; no per-frame updates.
     */
    public populate(entry: LeaderboardEntry, avatarFrames: SpriteFrame[]): void {
        this._entry = entry;
        // rankLabel override lets the level tab print "关卡 1" / "Level 1"
        // (its column is a floor identifier, not a rank position).
        if (this.rankLabel)  this.rankLabel.string  = entry.rankLabel ?? String(entry.rank);
        if (this.nameLabel)  this.nameLabel.string  = entry.name;
        // Prefer the pre-formatted string when the caller provides one
        // (level-time tab wants "MM:SS", not raw ms). Otherwise fall
        // back to the default numeric-with-thousands-separator format
        // used by endless / blind ("12,340").
        if (this.scoreLabel) {
            this.scoreLabel.string = entry.scoreLabel ?? entry.score.toLocaleString();
        }

        if (this.avatarSprite && avatarFrames.length > 0) {
            const idx = entry.avatarIdx ?? ((entry.rank - 1) % avatarFrames.length);
            const frame = avatarFrames[((idx % avatarFrames.length) + avatarFrames.length) % avatarFrames.length];
            if (frame) this.avatarSprite.spriteFrame = frame;
        }

        // Top-3 badges: hide all, then show the one matching this row's
        // rank (if any). Rank 1 → badgeNodes[0], rank 2 → [1], rank 3 → [2].
        // Suppressed entirely when the entry sets hideBadges (level tab —
        // where the "rank" is a floor number, not a ranking position).
        for (let i = 0; i < this.badgeNodes.length; i++) {
            const node = this.badgeNodes[i];
            if (!node) continue;
            node.active = !entry.hideBadges && (entry.rank === i + 1);
        }

        // "You" highlight — subtle glow / border on the local player's
        // row. Reused across pooled populates, so always set explicitly.
        if (this.youHighlight) {
            this.youHighlight.active = !!entry.isYou;
        }
    }
}
