/**
 * Gatling level prop — like the rocket storm, fires `GATLING_TOTAL`
 * (30) small projectiles that cancel 1:1 against any colored cell they
 * touch. Faster fall + denser spawn than rockets — reads as a "machine
 * gun" sweep rather than a barrage of single missiles.
 *
 * Identical control flow to `RocketState` (see that file for the rules
 * commentary) — only the constants and the field key differ. Kept as a
 * separate state object so renderers can distinguish "rocket trail"
 * from "gatling stream".
 */

import {
    COLS,
    GATLING_TOTAL,
    GATLING_DROP_INTERVAL_PER_ROW_MS,
    GATLING_SPAWN_STAGGER_MS,
} from '../Constants';
import { BoardState, RocketProjectile } from '../Types';
import { CellValue } from '../Constants';
import { isColoredCell } from '../Board';
import {
    ClearLinesHooks,
    processClearedChests,
    processClearedMeteors,
    processClearedBlizzards,
    processClearedWreckers,
    processClearedHails,
    processClearedRockets,
    processClearedGatlings,
    processClearedBooms,
} from '../ClearLines';
import { triggerHitProps } from './Rocket';

export type RandomFn = () => number;

export interface GatlingHooks extends ClearLinesHooks {
    onFinish?(): void;
    /** Fired each time a bullet 1:1-cancels a colored cell. `color` is
     *  the cell value BEFORE it was nulled — pass through so a per-cell
     *  shatter FX can spawn a matching-hued chunk. */
    onHit?(r: number, c: number, color: CellValue): void;
    /** Fired the moment a gatling bullet is spawned. Renderer uses
     *  this to play the launch SFX. */
    onFire?(col: number): void;
}

export class GatlingState {
    mode = false;
    /** Board column the bullets target. Captured at activation from
     *  the camera's current centre column so every bullet hits cells
     *  in that ONE column, regardless of any tower rotation the
     *  player does mid-storm. */
    anchorCol = 0;

    private pendingCount = 0;
    private falling: RocketProjectile[] = [];
    private spawnAccum = 0;

    constructor(private rng: RandomFn = Math.random) {}

    /** Total unresolved bullets = queued (waiting to spawn) + in-flight
     *  (falling toward target). Used by the HUD countdown so both the
     *  first bullet (not yet spawned) and the last bullet (still mid-
     *  flight) count as "remaining". Zero when the storm is over. */
    public unresolvedCount(): number {
        return this.pendingCount + this.falling.length;
    }

    /** Row coordinate where new bullets materialise. Set by
     *  `activate()` — the caller passes the CURRENT piece.y so bullets
     *  spawn at the same on-screen height as a meteor DOT would (both
     *  enter from `visibleTopRow + 1`, i.e. one row below the camera's
     *  top edge). Defaults to 0 for safety on boards with no active
     *  piece. */
    private spawnY = 0;

    /** `anchorCol` should be the column the player is currently
     *  facing — captured by the game state at trigger time.
     *  `count` defaults to `GATLING_TOTAL` (12), used by level-prop
     *  triggers; magic-item tiers pass 4 / 8 / 12 per tier.
     *  `spawnY` should be the current live piece's row (usually
     *  visibleTopRow + 1) so bullets appear at the same height as a
     *  meteor DOT. Defaults to 0. */
    activate(anchorCol: number = 0, count: number = GATLING_TOTAL, spawnY: number = 0): void {
        this.mode = true;
        this.anchorCol = ((anchorCol % COLS) + COLS) % COLS;
        this.pendingCount += count;
        this.spawnY = spawnY;
    }

    tick(
        dt: number,
        state: BoardState,
        reservedTop: number,
        liveTargetCol: number,
        hooks: GatlingHooks = {},
    ): number {
        if (!this.mode) return 0;
        let resolved = 0;

        // Live target column = whatever column the camera faces THIS
        // tick. Bullets behave like the meteor shower's DOT pieces:
        // they fall down the screen-fixed centre. Rotation of the
        // tower changes which column is *under* the stream, and
        // future bullets + any in-flight bullets all aim at that
        // column. The visual column they render at is always the
        // screen centre — see `renderFallingGatling`.
        const liveCol = ((Math.round(liveTargetCol) % COLS) + COLS) % COLS;

        // Find the topmost "solid" cell (colored OR gray 'X') in liveCol.
        // Once a bullet's y reaches this row it dies — both colored and
        // gray cells now vanish 1:1 with the bullet (gray-is-bomb-proof
        // was lifted). -1 means the column is entirely empty; the bullet
        // falls all the way to the true bottom and despawns.
        const H = state.board.length;
        let topRow = -1;
        for (let r = 0; r < H; r++) {
            const v = state.board[r][liveCol];
            if (isColoredCell(v) || v === 'X') { topRow = r; break; }
        }

        this.spawnAccum += dt;
        while (this.spawnAccum >= GATLING_SPAWN_STAGGER_MS && this.pendingCount > 0) {
            this.spawnAccum -= GATLING_SPAWN_STAGGER_MS;
            this.pendingCount--;
            this.falling.push({
                col: liveCol,
                // Spawn at the same Y as a meteor DOT so both projectiles
                // enter the play area at the same visual height. Value
                // comes from `spawnY` captured at activate() — normally
                // the current piece's row (visibleTopRow + 1 for a mature
                // board), NOT hardcoded 0 which would place bullets far
                // above the visible camera window on tall endless boards
                // (row 0 is the absolute top of the board, not the top
                // of the camera view — those differ by ~15-20 rows).
                y:   this.spawnY,
            });
            hooks.onFire?.(liveCol);
        }

        for (let i = this.falling.length - 1; i >= 0; i--) {
            const bk = this.falling[i];
            bk.y += dt / GATLING_DROP_INTERVAL_PER_ROW_MS;
            // Re-aim every in-flight bullet to the current liveCol —
            // they're all visually at screen centre anyway, so they
            // share the same target.
            bk.col = liveCol;

            if (topRow >= 0 && bk.y >= topRow) {
                // Snap the bullet's visual y down to the target row so
                // the explosion FX lines up regardless of whether the
                // cell survives or vanishes.
                bk.y = topRow;
                const hitColor = state.board[topRow][liveCol];
                // 1:1 cancel: kill the topmost cube of liveCol AND the
                // bullet at once. Applies to gray 'X' cells too — the
                // gray-is-bomb-proof rule was lifted. Fire every prop
                // sitting on this cell (chest grants item, boom
                // detonates its diamond, etc.).
                state.board[topRow][liveCol] = null;
                triggerHitProps(state, topRow, liveCol, hooks, reservedTop);
                this.falling.splice(i, 1);
                resolved++;
                hooks.onHit?.(topRow, liveCol, hitColor);
                // Next bullet this tick should aim at whatever the new
                // topmost cell is (the cube above just disappeared).
                topRow = -1;
                for (let r = 0; r < H; r++) {
                    const v = state.board[r][liveCol];
                    if (isColoredCell(v) || v === 'X') { topRow = r; break; }
                }
                continue;
            }
            if (bk.y >= H) {
                this.falling.splice(i, 1);
                resolved++;
            }
        }

        if (this.pendingCount === 0 && this.falling.length === 0) {
            this.finish(state, hooks);
        }
        return resolved;
    }

    reset(): void {
        this.mode = false;
        this.pendingCount = 0;
        this.falling.length = 0;
        this.spawnAccum = 0;
    }

    getFalling(): ReadonlyArray<RocketProjectile> {
        return this.falling;
    }

    private finish(state: BoardState, hooks: GatlingHooks): void {
        this.mode = false;
        this.pendingCount = 0;
        this.falling.length = 0;
        this.spawnAccum = 0;
        processClearedChests(state, hooks);
        processClearedMeteors(state, hooks);
        processClearedBlizzards(state, hooks);
        processClearedWreckers(state, hooks);
        processClearedHails(state, hooks);
        processClearedRockets(state, hooks);
        processClearedGatlings(state, hooks);
        processClearedBooms(state, {
            onBoomActivated: (r, c, level, cleared) =>
                hooks.onBoomTriggered?.(r, c, level, cleared),
        });
        hooks.onFinish?.();
    }
}
