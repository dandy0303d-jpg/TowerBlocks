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

import { _decorator, Component, Node, Label, Sprite, SpriteFrame } from 'cc';
import type { LeaderboardEntry } from './LeaderboardController';

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

    /**
     * Fill this row's Labels + avatar from `entry`. Call once per row
     * per show; no per-frame updates.
     */
    public populate(entry: LeaderboardEntry, avatarFrames: SpriteFrame[]): void {
        if (this.rankLabel)  this.rankLabel.string  = String(entry.rank);
        if (this.nameLabel)  this.nameLabel.string  = entry.name;
        if (this.scoreLabel) this.scoreLabel.string = entry.score.toLocaleString();

        if (this.avatarSprite && avatarFrames.length > 0) {
            const idx = entry.avatarIdx ?? ((entry.rank - 1) % avatarFrames.length);
            const frame = avatarFrames[((idx % avatarFrames.length) + avatarFrames.length) % avatarFrames.length];
            if (frame) this.avatarSprite.spriteFrame = frame;
        }

        // Top-3 badges: hide all, then show the one matching this row's
        // rank (if any). Rank 1 → badgeNodes[0], rank 2 → [1], rank 3 → [2].
        for (let i = 0; i < this.badgeNodes.length; i++) {
            const node = this.badgeNodes[i];
            if (!node) continue;
            node.active = (entry.rank === i + 1);
        }

        // "You" highlight — subtle glow / border on the local player's
        // row. Reused across pooled populates, so always set explicitly.
        if (this.youHighlight) {
            this.youHighlight.active = !!entry.isYou;
        }
    }
}
