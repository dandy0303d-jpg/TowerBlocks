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
    // Wrecker×wrecker adjacency combo: the "leader" of an adjacent
    // wrecker pair picks 2×WRECKER_TARGETS cells, the "passive" picks
    // zero (its counterpart already handled the whole combo pool).
    // Standalone wreckers use the default WRECKER_TARGETS. Pass a
    // custom count to override; pass 0 to skip picking entirely.
    pickCount: number = WRECKER_TARGETS,
    // Reserved-zone guard: only rows < reservedTop are eligible.
    // Wrecker is an embed prop, and per the "magic + embed props
    // should not touch the gray foundation (except mortar)" rule we
    // never pick or backfill into the reserved zone.
    reservedTop: number = state.board.length,
): WreckerPlan | null {
    if (pickCount <= 0) return null;
    const topRow = Math.min(reservedTop, state.board.length);
    // Split into two pools so the wrecker PREFERS colored (target) cells
    // and only starts eating into the gray tower cells when the colored
    // supply runs short. Rationale: gray cells are level-scaffold blocks
    // the player wants to KEEP; colored cells are the goals. A pure
    // uniform random pick was routinely wasting picks on gray, which
    // felt bad ("拆迁队要优选选择彩色方块儿").
    const coloredCandidates: Array<{ r: number; c: number }> = [];
    const grayCandidates:    Array<{ r: number; c: number }> = [];
    for (let r = 0; r < topRow; r++) {
        for (let c = 0; c < COLS; c++) {
            const v = state.board[r][c];
            const isColored = isColoredCell(v);
            const isGray    = v === 'X';
            if (!isColored && !isGray) continue;
            if (state.boardBombs     && state.boardBombs[r]     && state.boardBombs[r][c])     continue;
            if (state.boardBooms     && state.boardBooms[r]     && state.boardBooms[r][c])     continue;
            if (state.boardChests    && state.boardChests[r]    && state.boardChests[r][c])    continue;
            if (state.boardMeteors   && state.boardMeteors[r]   && state.boardMeteors[r][c])   continue;
            if (state.boardBlizzards && state.boardBlizzards[r] && state.boardBlizzards[r][c]) continue;
            if (state.boardWreckers  && state.boardWreckers[r]  && state.boardWreckers[r][c])  continue;
            if (state.boardHails     && state.boardHails[r]     && state.boardHails[r][c])     continue;
            if (state.boardRockets   && state.boardRockets[r]   && state.boardRockets[r][c])   continue;
            if (state.boardGatlings  && state.boardGatlings[r]  && state.boardGatlings[r][c])  continue;
            (isColored ? coloredCandidates : grayCandidates).push({ r, c });
        }
    }
    if (!coloredCandidates.length && !grayCandidates.length) return null;
    // Fisher–Yates on each pool independently — we don't want the sort
    // order (row-major) leaking into which cells get picked when the
    // pool is bigger than pickCount.
    const shuffle = (arr: Array<{ r: number; c: number }>) => {
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(rng() * (i + 1));
            [arr[i], arr[j]] = [arr[j], arr[i]];
        }
    };
    shuffle(coloredCandidates);
    shuffle(grayCandidates);
    // Take from the colored pool first; if it can't cover pickCount,
    // top up with grays. Matches the Excavator's two-pass semantics
    // (colored rows before gray rows) so both demolition items feel
    // consistent to the player.
    const chosen = coloredCandidates.slice(0, pickCount);
    if (chosen.length < pickCount) {
        chosen.push(...grayCandidates.slice(0, pickCount - chosen.length));
    }
    const picks = chosen.map(({ r, c }) => ({
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
    const { comboBoomLevel, comboBombAxis } = plan;
    // Prune picks whose host cell was cleared BETWEEN the pick
    // (`pickWreckerPlan`, fires at trigger time) and this commit call
    // (`applyWreckerPlan`, fires after the renderer's pre-pulse
    // window elapses — typically 200-400 ms later). Any other prop
    // that ran in the same detonation chain (row/col bomb, boom,
    // rocket, gatling, another wrecker) may have nulled those
    // cells in the meantime, and firing shatter on a null cell is
    // both visually silent AND wastes the wrecker's "N cells"
    // budget on nothing.
    //
    // Once we've dropped the dead picks, backfill from cells that
    // are STILL alive right now, up to the original pick count.
    // Skip cells that survive but are already in the pick list.
    // Reserved-zone guard: drop any pre-existing pick that landed in
    // the gray foundation (the pickWreckerPlan pass now respects
    // reservedTop, but be defensive in case an older plan is committed).
    let picks = plan.picks.filter(p => {
        if (p.r >= reservedTop) return false;
        const row = state.board[p.r];
        return row && row[p.c] != null;
    });
    const missing = plan.picks.length - picks.length;
    if (missing > 0) {
        const taken = new Set<number>();
        for (const p of picks) taken.add(p.r * COLS + p.c);
        const coloredPool: Array<{ r: number; c: number }> = [];
        const grayPool:    Array<{ r: number; c: number }> = [];
        const backfillTop = Math.min(reservedTop, state.board.length);
        for (let r = 0; r < backfillTop; r++) {
            const row = state.board[r];
            if (!row) continue;
            for (let c = 0; c < COLS; c++) {
                if (taken.has(r * COLS + c)) continue;
                const v = row[c];
                const isColored = isColoredCell(v);
                const isGray    = v === 'X';
                if (!isColored && !isGray) continue;
                // Same skip-list as `pickWreckerPlan` — don't backfill
                // onto prop-hosting cells since the wrecker sweep is
                // meant to eat plain cubes only.
                if (state.boardBombs?.[r]?.[c])     continue;
                if (state.boardBooms?.[r]?.[c])     continue;
                if (state.boardChests?.[r]?.[c])    continue;
                if (state.boardMeteors?.[r]?.[c])   continue;
                if (state.boardBlizzards?.[r]?.[c]) continue;
                if (state.boardWreckers?.[r]?.[c])  continue;
                if (state.boardHails?.[r]?.[c])     continue;
                if (state.boardRockets?.[r]?.[c])   continue;
                if (state.boardGatlings?.[r]?.[c])  continue;
                (isColored ? coloredPool : grayPool).push({ r, c });
            }
        }
        // Fisher-Yates shuffle each pool so backfill order is random.
        const shuffle = (arr: Array<{ r: number; c: number }>) => {
            for (let i = arr.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [arr[i], arr[j]] = [arr[j], arr[i]];
            }
        };
        shuffle(coloredPool);
        shuffle(grayPool);
        const backfill = coloredPool.slice(0, missing);
        if (backfill.length < missing) {
            backfill.push(...grayPool.slice(0, missing - backfill.length));
        }
        for (const { r, c } of backfill) {
            picks.push({ r, c, color: state.board[r][c] as CellValue });
        }
    }
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
            const cleared = activateBoom(state, r, c, comboBoomLevel, reservedTop);
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
    pickCount: number = WRECKER_TARGETS,
): boolean {
    const plan = pickWreckerPlan(state, rng, triggerR, triggerC, cachedBoomLevel, cachedBombAxis, pickCount);
    if (!plan) return true;
    return applyWreckerPlan(state, plan, hooks, reservedTop);
}
