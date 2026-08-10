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

    /** `anchorCol` should be the column the player is currently
     *  facing — captured by the game state at trigger time.
     *  `count` defaults to `GATLING_TOTAL` (12), used by level-prop
     *  triggers; magic-item tiers pass 4 / 8 / 12 per tier. */
    activate(anchorCol: number = 0, count: number = GATLING_TOTAL): void {
        this.mode = true;
        this.anchorCol = ((anchorCol % COLS) + COLS) % COLS;
        this.pendingCount += count;
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

        // Find the topmost "solid" cell (colored OR gray reserved 'X')
        // currently sitting in liveCol. Once a bullet's y reaches this
        // row it dies — colored cells vanish 1:1 with the bullet, gray
        // cells survive but stop the bullet all the same. -1 means the
        // column is empty above reservedTop, so any bullet that gets
        // there just falls through to the floor and despawns.
        //
        // `topRowIsGray` distinguishes the two cases below so we don't
        // accidentally erase a gray brick (they're intentionally
        // bomb-proof — same rule as the level foundation).
        let topRow = -1;
        let topRowIsGray = false;
        for (let r = 0; r < reservedTop; r++) {
            const v = state.board[r][liveCol];
            if (isColoredCell(v)) { topRow = r; topRowIsGray = false; break; }
            if (v === 'X')        { topRow = r; topRowIsGray = true;  break; }
        }

        this.spawnAccum += dt;
        while (this.spawnAccum >= GATLING_SPAWN_STAGGER_MS && this.pendingCount > 0) {
            this.spawnAccum -= GATLING_SPAWN_STAGGER_MS;
            this.pendingCount--;
            this.falling.push({
                col: liveCol,
                y:   -3,
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
                if (topRowIsGray) {
                    // Gray reserved brick — bullet fizzles, cell stays.
                    // Fire onHit with the 'X' value so the renderer
                    // still plays the per-cell burst FX.
                    this.falling.splice(i, 1);
                    resolved++;
                    hooks.onHit?.(topRow, liveCol, hitColor);
                    // Target row unchanged — next bullet still hits
                    // the same gray brick.
                    continue;
                }
                // 1:1 cancel: kill the topmost cube of liveCol AND the
                // bullet at once. Fire every prop sitting on this cell
                // (chest grants item, boom detonates its diamond, etc.).
                state.board[topRow][liveCol] = null;
                triggerHitProps(state, topRow, liveCol, hooks, reservedTop);
                this.falling.splice(i, 1);
                resolved++;
                hooks.onHit?.(topRow, liveCol, hitColor);
                // Next bullet this tick should aim at whatever the new
                // topmost cell is (the cube above just disappeared).
                topRow = -1;
                topRowIsGray = false;
                for (let r = 0; r < reservedTop; r++) {
                    const v = state.board[r][liveCol];
                    if (isColoredCell(v)) { topRow = r; topRowIsGray = false; break; }
                    if (v === 'X')        { topRow = r; topRowIsGray = true;  break; }
                }
                continue;
            }
            if (bk.y >= reservedTop) {
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
