/**
 * Rocket level prop — freezes normal piece spawning, then rains down
 * `ROCKET_TOTAL` (24) black 1×1 projectiles. Each rocket falls until it hits
 * a colored (non-gray, non-hail) cell; both the rocket and that cell vanish
 * (1:1 cancellation). Rockets that fall past the reserved zone without hitting
 * anything just fizzle.
 *
 *   - Spawn column is picked from "columns that currently have at least one
 *     colored cell". An all-empty board falls back to a uniformly random column
 *     so the storm always finishes.
 *   - Spawn pacing: every `ROCKET_SPAWN_STAGGER_MS` (35ms) a new rocket joins.
 *   - Collision check on each tick scans every integer row the rocket crossed
 *     this frame (defends against high `dt` skipping a cell).
 *   - After all rockets land or fizzle, `processClearedXxx` runs so any
 *     orphaned chest / meteor / blizzard / wrecker / hail / rocket props
 *     chain via their hooks.
 */

import {
    COLS,
    ROCKET_TOTAL,
    ROCKET_DROP_INTERVAL_PER_ROW_MS,
    ROCKET_SPAWN_STAGGER_MS,
} from '../Constants';
import { BoardState, RocketProjectile, BoomLevel } from '../Types';
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
    processClearedBooms,
} from '../ClearLines';
import { activateBoom } from './Boom';
import { detonateBombs, DetonateHooks } from '../Detonate';
import { applyDiagonalGravity } from '../ColumnGravity';

/** Common hit-effect for both rocket and gatling: a 1:1 cancel cleared
 *  the cell at (r, c). Fire every prop hook for what was sitting there,
 *  null the prop layers so the next bullet doesn't double-trigger, and
 *  let booms detonate their diamond on the spot. Directional bombs
 *  (rowN/colN) detonate via `detonateBombs` so the row/col blast fires
 *  and chains through neighbouring props (matches what the player sees
 *  when a piece-embed bomb lands against the stack). Stones are
 *  silently consumed. `reservedTop` is the row index at the top of
 *  the gray foundation — bomb blasts respect it the same way they do
 *  in `lockAndNext`. */
export function triggerHitProps(
    state: BoardState,
    r: number,
    c: number,
    hooks: ClearLinesHooks,
    reservedTop: number = state.board.length,
): void {
    if (state.boardBombs && state.boardBombs[r] && state.boardBombs[r][c]) {
        const kind = state.boardBombs[r][c]!;
        state.boardBombs[r][c] = null;
        detonateBombs(state, [{ r, c, kind }], reservedTop, hooks as DetonateHooks);
    }
    if (state.boardStones && state.boardStones[r]) state.boardStones[r][c] = null;
    if (state.boardChests && state.boardChests[r] && state.boardChests[r][c]) {
        state.boardChests[r][c] = null;
        hooks.onChestTriggered?.(r, c);
    }
    if (state.boardMeteors && state.boardMeteors[r] && state.boardMeteors[r][c]) {
        state.boardMeteors[r][c] = null;
        hooks.onMeteorTriggered?.(r, c);
    }
    if (state.boardBlizzards && state.boardBlizzards[r] && state.boardBlizzards[r][c]) {
        state.boardBlizzards[r][c] = null;
        hooks.onBlizzardTriggered?.(r, c);
    }
    if (state.boardWreckers && state.boardWreckers[r] && state.boardWreckers[r][c]) {
        state.boardWreckers[r][c] = null;
        hooks.onWreckerTriggered?.(r, c);
    }
    if (state.boardHails && state.boardHails[r] && state.boardHails[r][c]) {
        state.boardHails[r][c] = null;
        hooks.onHailTriggered?.(r, c);
    }
    if (state.boardRockets && state.boardRockets[r] && state.boardRockets[r][c]) {
        state.boardRockets[r][c] = null;
        hooks.onRocketTriggered?.(r, c);
    }
    if (state.boardGatlings && state.boardGatlings[r] && state.boardGatlings[r][c]) {
        state.boardGatlings[r][c] = null;
        hooks.onGatlingTriggered?.(r, c);
    }
    if (state.boardBooms && state.boardBooms[r]) {
        const lvl = state.boardBooms[r][c];
        if (lvl) {
            state.boardBooms[r][c] = null;
            const cleared = activateBoom(state, r, c, lvl as BoomLevel);
            hooks.onBoomTriggered?.(r, c, lvl as BoomLevel, cleared);
            // Boom carved a diamond out of the tower — cells above
            // that hole would sit floating until the next lock's
            // gravity pass. Rocket / gatling storms bypass the normal
            // lockAndNext pipeline, so pull the survivors down NOW.
            // Mirrors the gravity call at the tail of `detonateBombs`.
            if (cleared.length) {
                const moves = applyDiagonalGravity(state, reservedTop);
                if (moves.length && hooks.onCellsFell) hooks.onCellsFell(moves);
            }
        }
    }
}

export type RandomFn = () => number;

export interface RocketHooks extends ClearLinesHooks {
    /** Fired when the storm finishes — caller resumes normal piece spawn. */
    onFinish?(): void;
    /** Fired each time a rocket successfully erases a colored cell.
     *  `color` is the value of the cell BEFORE it was nulled — pass
     *  through so a per-cell shatter FX can spawn a matching-hued chunk. */
    onHit?(r: number, c: number, color: CellValue): void;
    /** Fired the moment a rocket is spawned (added to the falling
     *  list). Renderer uses this to play the launch SFX. */
    onFire?(col: number): void;
}

export class RocketState {
    mode = false;

    private pendingCount = 0;
    private falling: RocketProjectile[] = [];
    private spawnAccum = 0;
    private _nextRocketId = 1;

    constructor(private rng: RandomFn = Math.random) {}

    /** Activate (or re-activate) a rocket storm. Adds another wave of
     *  pending rockets — they spawn gradually via `tick`. `count`
     *  defaults to `ROCKET_TOTAL` (24), used by level-prop triggers;
     *  magic-item tiers pass 8 / 16 / 24 per tier. */
    activate(count: number = ROCKET_TOTAL): void {
        this.mode = true;
        this.pendingCount += count;
    }

    /** Frame tick. `dt` in ms. Returns the number of rockets that resolved
     *  (either hit a cell or fizzled) this frame.
     *
     *  `preserveGray` (default false): when true, rockets PASS THROUGH
     *  gray 'X' cells without stopping or clearing them — used in
     *  endless / blind modes so the accumulated foundation can't be
     *  eroded by magic-item storms. Colored cells still stop + clear
     *  the rocket as normal. */
    tick(dt: number, state: BoardState, reservedTop: number, hooks: RocketHooks = {}, preserveGray: boolean = false): number {
        if (!this.mode) return 0;
        let resolved = 0;

        // Spawn rockets at a steady pace.
        this.spawnAccum += dt;
        while (this.spawnAccum >= ROCKET_SPAWN_STAGGER_MS && this.pendingCount > 0) {
            this.spawnAccum -= ROCKET_SPAWN_STAGGER_MS;
            this.pendingCount--;
            const col = this.pickColumn(state);
            this.falling.push({
                col,
                y:   -3 - this.rng() * 18,
                id:  this._nextRocketId++,
            });
            hooks.onFire?.(col);
        }

        // Advance each rocket — and scan every integer row it crossed this
        // frame for a colored target.
        for (let i = this.falling.length - 1; i >= 0; i--) {
            const rk = this.falling[i];
            const prevIntY = Math.floor(rk.y);
            rk.y += dt / ROCKET_DROP_INTERVAL_PER_ROW_MS;
            const newIntY = Math.floor(rk.y);

            let consumed = false;
            const H = state.board.length;
            const scanFrom = Math.max(0, prevIntY);
            const scanTo   = Math.min(H - 1, newIntY);
            for (let r = scanFrom; r <= scanTo; r++) {
                const v = state.board[r][rk.col];
                if (v === null) continue;
                // Gray-preserve mode (endless / blind): pass through
                // 'X' cells like they weren't there — no clear, no
                // rocket stop. Level modes still let rockets chew
                // through gray so item combos can breach the reserved
                // zone as intended.
                if (v === 'X' && preserveGray) continue;
                if (isColoredCell(v) || v === 'X') {
                    state.board[r][rk.col] = null;
                    triggerHitProps(state, r, rk.col, hooks, reservedTop);
                }
                this.falling.splice(i, 1);
                consumed = true;
                resolved++;
                hooks.onHit?.(r, rk.col, v);
                break;
            }
            if (consumed) continue;
            // Off the bottom without hitting anything → fizzle.
            if (rk.y >= H) {
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

    // ---------- internal ----------

    private pickColumn(state: BoardState): number {
        const live: number[] = [];
        for (let c = 0; c < COLS; c++) {
            for (let r = 0; r < state.board.length; r++) {
                if (isColoredCell(state.board[r][c])) { live.push(c); break; }
            }
        }
        if (!live.length) return Math.floor(this.rng() * COLS);
        return live[Math.floor(this.rng() * live.length)];
    }

    private finish(state: BoardState, hooks: RocketHooks): void {
        this.mode = false;
        this.pendingCount = 0;
        this.falling.length = 0;
        this.spawnAccum = 0;
        // Belt-and-braces orphan pass — `triggerHitProps` already fires the
        // hook for cells the bullets eat directly, but a chained clear
        // (e.g. an in-storm boom diamond) can still leave orphaned props.
        processClearedChests(state, hooks);
        processClearedMeteors(state, hooks);
        processClearedBlizzards(state, hooks);
        processClearedWreckers(state, hooks);
        processClearedHails(state, hooks);
        processClearedRockets(state, hooks);
        processClearedBooms(state, {
            onBoomActivated: (r, c, level, cleared) =>
                hooks.onBoomTriggered?.(r, c, level, cleared),
        });
        // Gravity settle — 1:1 rocket cancels null a single cell each
        // without touching the cells above, so anything sitting on top
        // of a hit was left floating in mid-air until the next piece
        // lock (which is the earliest normal gravity pass). Bomb path
        // (detonateBombs) already does this at its tail — mirror it
        // here for the rocket storm end. Cheap when nothing floats
        // (returns [] immediately).
        //
        // Pass `state.board.length` (not the true reservedTop) so
        // falling cells drop THROUGH any holes the storm carved
        // into the gray foundation and land at the real bottom —
        // matches the ClearLines / bomb boom-diamond convention.
        const fellMoves = applyDiagonalGravity(state, state.board.length);
        if (fellMoves.length && hooks.onCellsFell) hooks.onCellsFell(fellMoves);
        hooks.onFinish?.();
    }
}
