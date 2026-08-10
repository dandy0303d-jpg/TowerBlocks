/**
 * Wrecker level prop — picks `WRECKER_TARGETS` (10) random colored cells from
 * anywhere on the board and erases them. The picked cells' props chain via
 * the standard hooks; wrecker cells themselves are LEFT INTACT during the
 * sweep so `processClearedWreckers` can fire them after this returns
 * (preventing infinite recursion and keeping the chain bounded by the total
 * wrecker count on the board).
 *
 * Per the user's explicit design call: gravity does NOT run after a wrecker
 * sweep — floating cells stay where they are.
 *
 * **Combos** (checked on the wrecker's 4-neighbours):
 *   • adjacent **directional bomb** (rowN / colN, any tier) → every pick
 *     fires a LEVEL-1 directional blast at the pick site. The bomb's
 *     own tier doesn't propagate — row1/col1 was the design call so
 *     "10 picks × full row/col blast" doesn't wipe the entire board.
 *     The axis (row vs col) matches the adjacent bomb's axis.
 *   • adjacent **boom** (level 1/2/3) → every pick detonates a Manhattan
 *     diamond AT THE BOOM'S FULL LEVEL (no cap):
 *         boom1 → each pick a Manhattan-1 diamond
 *         boom2 → each pick a Manhattan-2 diamond
 *         boom3 → each pick a Manhattan-3 diamond
 */

import { WRECKER_TARGETS, CellValue, COLS } from '../Constants';
import { BoardState, BoomLevel, BombKind } from '../Types';
import { isColoredCell, wrap } from '../Board';
import { activateBoom } from './Boom';
import { detonateBombs, DetonateHooks } from '../Detonate';
import { applyDiagonalGravity } from '../ColumnGravity';

export type RandomFn = () => number;

/** Boom combo gate: return the HIGHEST boom level (1/2/3) found on the
 *  4-neighbours of (r, c), or 0 if no boom is adjacent. Caller passes the
 *  full level straight into the per-pick diamond — see file docstring. */
function findAdjacentBoomLevel(state: BoardState, r: number, c: number): 0 | 1 | 2 | 3 {
    if (!state.boardBooms) return 0;
    const H = state.board.length;
    const candidates: Array<[number, number]> = [
        [r - 1, c],
        [r + 1, c],
        [r, wrap(c - 1)],
        [r, wrap(c + 1)],
    ];
    let best: 0 | 1 | 2 | 3 = 0;
    for (const [nr, nc] of candidates) {
        if (nr < 0 || nr >= H) continue;
        const lvl = state.boardBooms[nr] && state.boardBooms[nr][nc];
        if (lvl && lvl > best) best = lvl as 1 | 2 | 3;
    }
    return best;
}

/** Directional bomb combo gate: return 'row' or 'col' based on the axis of
 *  the FIRST directional bomb found on the 4-neighbours of (r, c), or null.
 *  The bomb's tier (1/2/3) is intentionally discarded — per-pick blasts
 *  always fire at level 1 (see file docstring). */
function findAdjacentBombAxis(state: BoardState, r: number, c: number): 'row' | 'col' | null {
    if (!state.boardBombs) return null;
    const H = state.board.length;
    const candidates: Array<[number, number]> = [
        [r - 1, c],
        [r + 1, c],
        [r, wrap(c - 1)],
        [r, wrap(c + 1)],
    ];
    for (const [nr, nc] of candidates) {
        if (nr < 0 || nr >= H) continue;
        const kind = state.boardBombs[nr] && state.boardBombs[nr][nc];
        if (!kind) continue;
        if (typeof kind === 'string' && kind.startsWith('row')) return 'row';
        if (typeof kind === 'string' && kind.startsWith('col')) return 'col';
    }
    return null;
}

/** Snapshot of a wrecker activation — populated by `pickWreckerPlan` and
 *  later consumed by `applyWreckerPlan`. Storing the plan lets the
 *  caller insert a pre-pulse delay between PICKING the cells (which the
 *  renderer flashes) and COMMITTING the clear (which spawns shatter). */
export interface WreckerPlan {
    picks: Array<{ r: number; c: number; color: CellValue }>;
    comboBoomLevel: 0 | BoomLevel;
    comboBombAxis:  'row' | 'col' | null;
}

/** Phase 1: pick the cells, decide the combo gates. Does NOT mutate the
 *  board, so the renderer can play a pre-pulse flash on the picks while
 *  they're still visible. Returns null if there's nothing to demolish. */
export function pickWreckerPlan(
    state: BoardState,
    rng: RandomFn = Math.random,
    triggerR: number = -1,
    triggerC: number = -1,
    cachedBoomLevel: 0 | 1 | 2 | 3 = 0,
    cachedBombAxis: 'row' | 'col' | null = null,
): WreckerPlan | null {
    const candidates: Array<{ r: number; c: number }> = [];
    for (let r = 0; r < state.board.length; r++) {
        for (let c = 0; c < COLS; c++) {
            if (!isColoredCell(state.board[r][c])) continue;
            if (state.boardBombs     && state.boardBombs[r]     && state.boardBombs[r][c])     continue;
            if (state.boardBooms     && state.boardBooms[r]     && state.boardBooms[r][c])     continue;
            if (state.boardChests    && state.boardChests[r]    && state.boardChests[r][c])    continue;
            if (state.boardMeteors   && state.boardMeteors[r]   && state.boardMeteors[r][c])   continue;
            if (state.boardBlizzards && state.boardBlizzards[r] && state.boardBlizzards[r][c]) continue;
            if (state.boardWreckers  && state.boardWreckers[r]  && state.boardWreckers[r][c])  continue;
            if (state.boardHails     && state.boardHails[r]     && state.boardHails[r][c])     continue;
            if (state.boardRockets   && state.boardRockets[r]   && state.boardRockets[r][c])   continue;
            if (state.boardGatlings  && state.boardGatlings[r]  && state.boardGatlings[r][c])  continue;
            candidates.push({ r, c });
        }
    }
    if (!candidates.length) return null;
    // Fisher–Yates shuffle, take the first N.
    for (let i = candidates.length - 1; i > 0; i--) {
        const j = Math.floor(rng() * (i + 1));
        [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const picks = candidates.slice(0, WRECKER_TARGETS).map(({ r, c }) => ({
        r, c, color: state.board[r][c] as CellValue,
    }));
    // Combo gates. Both prefer the caller's pre-fire snapshot since the
    // boom/bomb-side firing loops may have already wiped the live board
    // entries by the time we get here.
    const rawBoomLevel = cachedBoomLevel || (
        triggerR >= 0 && triggerC >= 0
            ? findAdjacentBoomLevel(state, triggerR, triggerC)
            : 0
    );
    const comboBoomLevel: 0 | BoomLevel = (rawBoomLevel || 0) as 0 | BoomLevel;
    const comboBombAxis = cachedBombAxis ?? (
        triggerR >= 0 && triggerC >= 0
            ? findAdjacentBombAxis(state, triggerR, triggerC)
            : null
    );
    return { picks, comboBoomLevel, comboBombAxis };
}

/** Phase 2: actually demolish the picked cells, fire shatter & combo
 *  bombs. Caller invokes this AFTER the renderer has finished playing
 *  the pre-pulse flash on the plan's picks. */
export function applyWreckerPlan(
    state: BoardState,
    plan: WreckerPlan,
    hooks: DetonateHooks = {},
    reservedTop: number = state.board.length,
): boolean {
    const { picks, comboBoomLevel, comboBombAxis } = plan;
    if (!picks.length) return true;
    // FX dispatch — three routes depending on the combo:
    //   • directional bomb   → skip wrecker FX, `detonateBombs` plays
    //     the row/col blast visuals at each pick.
    //   • boom (1/2/3)       → boom's `onBoomTriggered` covers its
    //     diamonds; we ALSO fire the PER-CELL shatter hook for the
    //     source picks so each host cube pops individually before its
    //     diamond blast fans out. (Previously used `onPartialShatter`,
    //     which lights the whole row's ring — reads as "row blast",
    //     wrong for a wrecker+boom combo where each source cell should
    //     read as a discrete pop.)
    //   • plain sweep        → fire the dedicated PER-CELL shatter
    //     hook so each of the 10 picks pops individually, not a
    //     "row blast" lighting up the whole ring at 10 rows.
    if (comboBoomLevel) {
        const cells = picks.map(({ r, c, color }) => ({
            r, c,
            color: (state.board[r][c] ?? color) as CellValue,
        }));
        if (hooks.onWreckerPicksShatter) {
            hooks.onWreckerPicksShatter(cells);
        } else {
            // Renderer doesn't implement the per-cell hook — fall back
            // to per-row shatter so the source picks still visibly clear.
            const rowMap = new Map<number, (CellValue | null)[]>();
            for (const { r, c } of cells) {
                let content = rowMap.get(r);
                if (!content) { content = new Array(COLS).fill(null); rowMap.set(r, content); }
                content[c] = state.board[r][c];
            }
            for (const [r, content] of rowMap) hooks.onPartialShatter?.(r, content);
        }
    } else if (!comboBombAxis) {
        // Plain sweep — per-cell shatter, no row-wide flash.
        const cells = picks.map(({ r, c, color }) => ({
            r, c,
            color: (state.board[r][c] ?? color) as CellValue,
        }));
        if (hooks.onWreckerPicksShatter) {
            hooks.onWreckerPicksShatter(cells);
        } else {
            // Renderer doesn't implement the per-cell hook — fall back
            // to the per-row shatter so the cells still visibly clear.
            const rowMap = new Map<number, (CellValue | null)[]>();
            for (const { r, c } of cells) {
                let content = rowMap.get(r);
                if (!content) { content = new Array(COLS).fill(null); rowMap.set(r, content); }
                content[c] = state.board[r][c];
            }
            for (const [r, content] of rowMap) hooks.onPartialShatter?.(r, content);
        }
    }
    // Seeds collected during the pick loop; detonated as ONE batch at
    // the end so a mid-loop splice doesn't shift picks that haven't fired.
    const bombSeeds: Array<{ r: number; c: number; kind: BombKind }> = [];
    // Demolish each cell.
    for (const { r, c } of picks) {
        if (comboBoomLevel) {
            const cleared = activateBoom(state, r, c, comboBoomLevel);
            hooks.onBoomTriggered?.(r, c, comboBoomLevel, cleared);
            continue;
        }
        if (comboBombAxis) {
            bombSeeds.push({ r, c, kind: comboBombAxis === 'row' ? 'row1' : 'col1' });
        }
        state.board[r][c] = null;
        if (state.boardBombs && state.boardBombs[r])   state.boardBombs[r][c]   = null;
        if (state.boardStones && state.boardStones[r]) state.boardStones[r][c]  = null;
        if (state.boardBooms && state.boardBooms[r])   state.boardBooms[r][c]   = null;
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
        if (state.boardHails && state.boardHails[r] && state.boardHails[r][c]) {
            state.boardHails[r][c] = null;
            hooks.onHailTriggered?.(r, c);
        }
        if (state.boardRockets && state.boardRockets[r] && state.boardRockets[r][c]) {
            state.boardRockets[r][c] = null;
            hooks.onRocketTriggered?.(r, c);
        }
    }
    hooks.onClearSound?.(1);
    if (bombSeeds.length) {
        detonateBombs(state, bombSeeds, reservedTop, hooks);
    } else {
        const fellMoves = applyDiagonalGravity(state, reservedTop);
        if (fellMoves.length && hooks.onCellsFell) hooks.onCellsFell(fellMoves);
    }
    return true;
}

/** Legacy combined entry point. Pick + apply in one shot, no pre-pulse
 *  delay. Useful for chains that don't go through GameState's pulse
 *  scheduling (e.g., tests). */
export function activateWrecker(
    state: BoardState,
    hooks: DetonateHooks = {},
    rng: RandomFn = Math.random,
    triggerR: number = -1,
    triggerC: number = -1,
    reservedTop: number = state.board.length,
    cachedBoomLevel: 0 | 1 | 2 | 3 = 0,
    cachedBombAxis: 'row' | 'col' | null = null,
): boolean {
    const plan = pickWreckerPlan(state, rng, triggerR, triggerC, cachedBoomLevel, cachedBombAxis);
    if (!plan) return true;
    return applyWreckerPlan(state, plan, hooks, reservedTop);
}
