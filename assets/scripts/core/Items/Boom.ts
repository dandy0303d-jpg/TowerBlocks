/**
 * Diamond-blast prop ("boom") — radius 1 (5 cells, plus), 2 (13 cells), or
 * 3 (25 cells). Triggers like wrecker / chest / meteor: when the host cell
 * is cleared (natural row clear, bomb chain, or another boom's blast), the
 * boom fires its diamond.
 *
 * Effect: every cell within Manhattan distance `level` of the host gets
 * cleared. Stones take 1 HP. Gray reserved cells ('X') are also cleared
 * (the foundation-is-bomb-proof rule was lifted so magic + embedded
 * props can chew through the gray zone). Other props (chest / meteor /
 * wrecker / hail / rocket / gatling / other booms) sitting in the blast
 * zone get orphaned when their host clears — the caller's
 * `processClearedXxx` chain catches them.
 */

import { COLS, CellValue } from '../Constants';
import { BoardState, StoneHP, BoomLevel } from '../Types';
import { wrap } from '../Board';

/**
 * Wipe a Manhattan-distance ≤ `level` diamond around (centerR, centerC).
 * Mutates `state` in place. Returns the list of cells that were actually
 * cleared (useful for renderer FX).
 *
 * `reservedTop` (optional) guards the gray foundation from magic +
 * embedded props: any cell at row >= reservedTop is left alone. The
 * mortar path is the sole exception — it omits `reservedTop` (or
 * passes `state.board.length`) so its blasts still chew the gray zone.
 */
export function activateBoom(
    state: BoardState,
    centerR: number,
    centerC: number,
    level: BoomLevel,
    reservedTop: number = state.board.length,
): Array<{ r: number; c: number }> {
    const cleared: Array<{ r: number; c: number }> = [];
    const radius = Math.max(1, Math.min(3, level)) as BoomLevel;
    const H = state.board.length;

    for (let dr = -radius; dr <= radius; dr++) {
        const r = centerR + dr;
        if (r < 0 || r >= H) continue;
        // Reserved-zone guard: magic + embedded props skip rows in the
        // gray foundation. Mortar callers pass `state.board.length` to
        // bypass this and clear reserved cells as before.
        if (r >= reservedTop) continue;
        const w = radius - Math.abs(dr);
        for (let dc = -w; dc <= w; dc++) {
            const c = wrap(centerC + dc);
            // Stone HP decrement — surviving stones keep their host cell.
            const hp = state.boardStones && state.boardStones[r] ? state.boardStones[r][c] : null;
            if (hp !== null && hp > 0) {
                const next = (hp - 1) as 0 | StoneHP;
                if (next > 0) {
                    state.boardStones![r][c] = next as StoneHP;
                    continue;
                }
                state.boardStones![r][c] = null;
                // fall through to clear the cell
            }
            if (state.board[r][c] === null) continue;
            const had: CellValue | null = state.board[r][c];
            state.board[r][c] = null;
            if (state.boardBombs && state.boardBombs[r]) state.boardBombs[r][c] = null;
            // Other prop layers are NOT touched here — `processClearedXxx`
            // catches them once their host cell turns null.
            if (had !== null) cleared.push({ r, c });
        }
    }
    return cleared;
}

/**
 * Orphan-prop pass — any boom whose host cell got cleared fires its blast.
 * Chains via inner do-while loop (a boom's blast may clear other boom hosts,
 * which fire on the next pass).
 */
export function processClearedBooms(
    state: BoardState,
    hooks?: BoomHooks,
    reservedTop: number = state.board.length,
): void {
    if (!state.boardBooms) return;
    let progress = true;
    while (progress) {
        progress = false;
        for (let r = 0; r < state.board.length; r++) {
            if (!state.boardBooms[r]) continue;
            for (let c = 0; c < COLS; c++) {
                const lvl = state.boardBooms[r][c];
                if (lvl && state.board[r][c] === null) {
                    state.boardBooms[r][c] = null;
                    const cleared = activateBoom(state, r, c, lvl, reservedTop);
                    hooks?.onBoomActivated?.(r, c, lvl, cleared);
                    progress = true;
                }
            }
        }
    }
}

export interface BoomHooks {
    onBoomActivated?(
        r: number,
        c: number,
        level: BoomLevel,
        cleared: Array<{ r: number; c: number }>,
    ): void;
}
