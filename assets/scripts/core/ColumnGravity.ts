/**
 * Per-column gravity. For each column we scoop every non-null cell from the top
 * of the playable region down to the floor and re-pack them flush against the
 * floor in their original top-to-bottom order. Every parallel prop array
 * follows its host cell so chests / meteors / blizzards / wreckers / hails /
 * placed-hail / rockets / bombs / stones stay attached.
 *
 * The "floor" depends on the game mode:
 *   - level   → just above the reserved zone (`board.length - levelReservedHeight`)
 *   - endless → the literal board floor (`board.length`)
 *
 * The caller passes `reservedTop` explicitly so this function stays
 * mode-agnostic and trivially testable.
 */

import { COLS, CellValue } from './Constants';
import { BoardState, BombKind, StoneHP, BoomLevel } from './Types';

/** A single cell that moved during gravity — fromR is its row BEFORE the
 *  iteration, toR is its row AFTER the iteration settled. `c` is the same
 *  in both (cells fall straight down per iteration; if you need
 *  diagonal-slide behaviour later this struct can be extended). */
export interface CellFallMove {
    fromR: number;
    toR:   number;
    c:     number;
}

/** Move one cell (and every parallel prop layer) from (fromR, fromC) to
 *  (toR, toC). Assumes the destination is null on every layer. */
function moveCellLayers(state: BoardState, fromR: number, fromC: number, toR: number, toC: number): void {
    state.board[toR][toC] = state.board[fromR][fromC];
    state.board[fromR][fromC] = null;
    const swap = (g: (unknown | null)[][] | null | undefined) => {
        if (!g) return;
        g[toR][toC] = g[fromR][fromC];
        g[fromR][fromC] = null;
    };
    swap(state.boardBombs);
    swap(state.boardStones);
    swap(state.boardChests);
    swap(state.boardMeteors);
    swap(state.boardBlizzards);
    swap(state.boardWreckers);
    swap(state.boardHails);
    swap(state.boardHailPlaced);
    swap(state.boardRockets);
    swap(state.boardGatlings);
    swap(state.boardBooms);
}

/** Diagonal-support gravity, BLOCK FLAVOUR.
 *
 *  Instead of dropping every floating cell one row at a time, we treat
 *  8-connected groups of colored cells as RIGID CLUSTERS that move as
 *  a unit. Each cluster falls until ANY of its cells would collide
 *  with the floor (`reservedTop`), a reserved 'X' anchor, a hail 'H'
 *  anchor, or a different (non-self) colored cell. This preserves the
 *  internal structure of every formation — a tower stays a tower
 *  after it lands; an L-shape stays an L.
 *
 *  Clusters are processed bottom-up so the lowest formation settles
 *  first, and we iterate until no cluster can move any further (handles
 *  stacked clusters where the upper one needs the lower one out of the
 *  way before it can drop).
 *
 *  Reserved X cells and hail H cells never move — they're anchors.
 *
 *  Returns the list of cells that moved, with their original and final
 *  rows, so the render layer can animate the fall instead of teleporting. */
export function applyDiagonalGravity(state: BoardState, reservedTop: number): CellFallMove[] {
    // Track each falling cell's ORIGINAL row so the animation knows where
    // it started. Key is the cell's CURRENT position; we re-key whenever
    // the cell moves.
    const origR = new Map<string, number>();
    for (let r = 0; r < reservedTop; r++) {
        for (let c = 0; c < COLS; c++) {
            const v = state.board[r][c];
            if (v && v !== 'X' && v !== 'H') origR.set(`${r}-${c}`, r);
        }
    }

    // The 8 neighbour deltas (column wraps on the cylinder).
    const DR = [-1, -1, -1, 0, 0, 1, 1, 1];
    const DC = [-1,  0,  1, -1, 1, -1, 0, 1];

    while (true) {
        // ---- Step 1: BFS-flood-fill every 8-connected cluster of movable cells. ----
        const visited = new Set<string>();
        const clusters: Array<Array<{ r: number; c: number }>> = [];
        for (let r = 0; r < reservedTop; r++) {
            for (let c = 0; c < COLS; c++) {
                const key = `${r}-${c}`;
                if (visited.has(key)) continue;
                const v = state.board[r][c];
                if (!v || v === 'X' || v === 'H') continue;
                visited.add(key);
                const cluster: Array<{ r: number; c: number }> = [{ r, c }];
                const queue: Array<{ r: number; c: number }> = [{ r, c }];
                while (queue.length) {
                    const cur = queue.shift()!;
                    for (let d = 0; d < 8; d++) {
                        const nr = cur.r + DR[d];
                        const nc = (cur.c + DC[d] + COLS) % COLS;
                        if (nr < 0 || nr >= reservedTop) continue;
                        const nKey = `${nr}-${nc}`;
                        if (visited.has(nKey)) continue;
                        const nv = state.board[nr][nc];
                        if (!nv || nv === 'X' || nv === 'H') continue;
                        visited.add(nKey);
                        cluster.push({ r: nr, c: nc });
                        queue.push({ r: nr, c: nc });
                    }
                }
                clusters.push(cluster);
            }
        }

        // ---- Step 2: process clusters bottom-up. ----
        // Sorting by the cluster's LOWEST row (largest r) descending lets
        // a stack of clusters settle floor-up in one pass.
        clusters.sort((a, b) => {
            let aBottom = -1, bBottom = -1;
            for (const cell of a) if (cell.r > aBottom) aBottom = cell.r;
            for (const cell of b) if (cell.r > bBottom) bBottom = cell.r;
            return bBottom - aBottom;
        });

        let anyMoved = false;
        const clusterMembership = new Set<string>(); // reused per cluster
        for (const cluster of clusters) {
            clusterMembership.clear();
            for (const cell of cluster) clusterMembership.add(`${cell.r}-${cell.c}`);

            // Compute the maximum number of rows the WHOLE cluster can
            // descend together. For each cell, walk down until we hit
            // either reservedTop, end-of-board, or a non-self obstacle.
            // The cluster's drop is the minimum over all cells.
            let clusterDrop = Number.POSITIVE_INFINITY;
            for (const cell of cluster) {
                let drop = 0;
                while (true) {
                    const targetR = cell.r + drop + 1;
                    if (targetR >= reservedTop) break;
                    if (clusterMembership.has(`${targetR}-${cell.c}`)) {
                        drop++; continue;
                    }
                    const occupant = state.board[targetR][cell.c];
                    if (occupant) break; // anchor or other cluster
                    drop++;
                }
                if (drop < clusterDrop) clusterDrop = drop;
                if (clusterDrop === 0) break;
            }
            if (clusterDrop <= 0 || clusterDrop === Number.POSITIVE_INFINITY) continue;

            // Apply the move. Sort cluster cells by row DESCENDING so we
            // never overwrite our own cells when copying down — a cell at
            // r → r+drop only happens after the cell at r+1 → r+1+drop.
            const ordered = cluster.slice().sort((a, b) => b.r - a.r);
            for (const cell of ordered) {
                const newR = cell.r + clusterDrop;
                moveCellLayers(state, cell.r, cell.c, newR, cell.c);
                const oldKey = `${cell.r}-${cell.c}`;
                const newKey = `${newR}-${cell.c}`;
                const origin = origR.get(oldKey);
                if (origin !== undefined) {
                    origR.delete(oldKey);
                    origR.set(newKey, origin);
                }
            }
            anyMoved = true;
        }

        if (!anyMoved) break;
    }

    // Build the moves list from origR snapshots — each entry's value is
    // the original row at the start of this gravity pass, the key holds
    // the final position.
    const moves: CellFallMove[] = [];
    for (const [key, origin] of origR) {
        const dash = key.indexOf('-');
        const r = parseInt(key.substring(0, dash), 10);
        const c = parseInt(key.substring(dash + 1), 10);
        if (r !== origin) moves.push({ fromR: origin, toR: r, c });
    }
    return moves;
}

export function applyColumnGravity(state: BoardState, reservedTop: number): void {
    const cols = state.board[0]?.length ?? 0;
    for (let c = 0; c < cols; c++) {
        // Scoop non-null cells from rows [0, reservedTop).
        const cells:      (CellValue | null)[] = [];
        const bombs:      (BombKind | null)[]  = [];
        const stones:     (StoneHP | null)[]   = [];
        const chests:     (true | null)[]      = [];
        const meteors:    (true | null)[]      = [];
        const blizzards:  (true | null)[]      = [];
        const wreckers:   (true | null)[]      = [];
        const hails:      (true | null)[]      = [];
        const hailPlaced: (true | null)[]      = [];
        const rockets:    (true | null)[]      = [];
        const gatlings:   (true | null)[]      = [];
        const booms:      (BoomLevel | null)[] = [];

        for (let r = 0; r < reservedTop; r++) {
            if (state.board[r][c]) {
                cells.push(state.board[r][c]);
                bombs.push(state.boardBombs && state.boardBombs[r] ? state.boardBombs[r][c] : null);
                stones.push(state.boardStones && state.boardStones[r] ? state.boardStones[r][c] : null);
                chests.push(state.boardChests && state.boardChests[r] ? state.boardChests[r][c] : null);
                meteors.push(state.boardMeteors && state.boardMeteors[r] ? state.boardMeteors[r][c] : null);
                blizzards.push(state.boardBlizzards && state.boardBlizzards[r] ? state.boardBlizzards[r][c] : null);
                wreckers.push(state.boardWreckers && state.boardWreckers[r] ? state.boardWreckers[r][c] : null);
                hails.push(state.boardHails && state.boardHails[r] ? state.boardHails[r][c] : null);
                hailPlaced.push(state.boardHailPlaced && state.boardHailPlaced[r] ? state.boardHailPlaced[r][c] : null);
                rockets.push(state.boardRockets && state.boardRockets[r] ? state.boardRockets[r][c] : null);
                gatlings.push(state.boardGatlings && state.boardGatlings[r] ? state.boardGatlings[r][c] : null);
                booms.push(state.boardBooms && state.boardBooms[r] ? state.boardBooms[r][c] : null);

                state.board[r][c] = null;
                if (state.boardBombs)      state.boardBombs[r][c]      = null;
                if (state.boardStones)     state.boardStones[r][c]     = null;
                if (state.boardChests)     state.boardChests[r][c]     = null;
                if (state.boardMeteors)    state.boardMeteors[r][c]    = null;
                if (state.boardBlizzards)  state.boardBlizzards[r][c]  = null;
                if (state.boardWreckers)   state.boardWreckers[r][c]   = null;
                if (state.boardHails)      state.boardHails[r][c]      = null;
                if (state.boardHailPlaced) state.boardHailPlaced[r][c] = null;
                if (state.boardRockets)    state.boardRockets[r][c]    = null;
                if (state.boardGatlings)   state.boardGatlings[r][c]   = null;
                if (state.boardBooms)      state.boardBooms[r][c]      = null;
            }
        }

        // Repack from `reservedTop - 1` upward, preserving the bottom-to-top
        // order in `cells` (the deepest scooped cell lands at the bottom).
        let pr = reservedTop - 1;
        for (let i = cells.length - 1; i >= 0; i--) {
            if (pr < 0) break;
            state.board[pr][c] = cells[i];
            if (state.boardBombs)      state.boardBombs[pr][c]      = bombs[i];
            if (state.boardStones)     state.boardStones[pr][c]     = stones[i];
            if (state.boardChests)     state.boardChests[pr][c]     = chests[i];
            if (state.boardMeteors)    state.boardMeteors[pr][c]    = meteors[i];
            if (state.boardBlizzards)  state.boardBlizzards[pr][c]  = blizzards[i];
            if (state.boardWreckers)   state.boardWreckers[pr][c]   = wreckers[i];
            if (state.boardHails)      state.boardHails[pr][c]      = hails[i];
            if (state.boardHailPlaced) state.boardHailPlaced[pr][c] = hailPlaced[i];
            if (state.boardRockets)    state.boardRockets[pr][c]    = rockets[i];
            if (state.boardGatlings)   state.boardGatlings[pr][c]   = gatlings[i];
            if (state.boardBooms)      state.boardBooms[pr][c]      = booms[i];
            pr--;
        }
    }
}

/**
 * Hail-only "local" gravity used when the 3-piece life timer expires. For
 * each column we find the BOTTOM-MOST hail row; everything in rows
 * `[0, maxHailR]` of that column gets repacked at `maxHailR` going up,
 * dropping the colored cells above the evaporated hail block. Cells in rows
 * `> maxHailR` are left untouched (the user explicitly requested this).
 */
export function evaporateHailPerColumn(state: BoardState): void {
    if (!state.boardHailPlaced) return;
    const cols = state.board[0]?.length ?? 0;
    for (let c = 0; c < cols; c++) {
        const hailRows: number[] = [];
        for (let r = 0; r < state.board.length; r++) {
            if (state.boardHailPlaced[r] && state.boardHailPlaced[r][c]) hailRows.push(r);
        }
        if (!hailRows.length) continue;
        const maxHailR = Math.max(...hailRows);

        const cells:     (CellValue | null)[] = [];
        const bombs:     (BombKind | null)[]  = [];
        const stones:    (StoneHP | null)[]   = [];
        const chests:    (true | null)[]      = [];
        const meteors:   (true | null)[]      = [];
        const blizzards: (true | null)[]      = [];
        const wreckers:  (true | null)[]      = [];
        const hails:     (true | null)[]      = [];
        const rockets:   (true | null)[]      = [];
        const booms:     (BoomLevel | null)[] = [];

        for (let r = 0; r <= maxHailR; r++) {
            const isHail = !!(state.boardHailPlaced[r] && state.boardHailPlaced[r][c]);
            if (state.board[r][c] && !isHail) {
                cells.push(state.board[r][c]);
                bombs.push(state.boardBombs && state.boardBombs[r] ? state.boardBombs[r][c] : null);
                stones.push(state.boardStones && state.boardStones[r] ? state.boardStones[r][c] : null);
                chests.push(state.boardChests && state.boardChests[r] ? state.boardChests[r][c] : null);
                meteors.push(state.boardMeteors && state.boardMeteors[r] ? state.boardMeteors[r][c] : null);
                blizzards.push(state.boardBlizzards && state.boardBlizzards[r] ? state.boardBlizzards[r][c] : null);
                wreckers.push(state.boardWreckers && state.boardWreckers[r] ? state.boardWreckers[r][c] : null);
                hails.push(state.boardHails && state.boardHails[r] ? state.boardHails[r][c] : null);
                rockets.push(state.boardRockets && state.boardRockets[r] ? state.boardRockets[r][c] : null);
                booms.push(state.boardBooms && state.boardBooms[r] ? state.boardBooms[r][c] : null);
            }
            // Wipe every slot in [0, maxHailR] including hail.
            state.board[r][c] = null;
            if (state.boardBombs)      state.boardBombs[r][c]      = null;
            if (state.boardStones)     state.boardStones[r][c]     = null;
            if (state.boardChests)     state.boardChests[r][c]     = null;
            if (state.boardMeteors)    state.boardMeteors[r][c]    = null;
            if (state.boardBlizzards)  state.boardBlizzards[r][c]  = null;
            if (state.boardWreckers)   state.boardWreckers[r][c]   = null;
            if (state.boardHails)      state.boardHails[r][c]      = null;
            if (state.boardHailPlaced) state.boardHailPlaced[r][c] = null;
            if (state.boardRockets)    state.boardRockets[r][c]    = null;
            if (state.boardBooms)      state.boardBooms[r][c]      = null;
        }

        let pr = maxHailR;
        for (let i = cells.length - 1; i >= 0; i--) {
            if (pr < 0) break;
            state.board[pr][c] = cells[i];
            if (state.boardBombs)     state.boardBombs[pr][c]     = bombs[i];
            if (state.boardStones)    state.boardStones[pr][c]    = stones[i];
            if (state.boardChests)    state.boardChests[pr][c]    = chests[i];
            if (state.boardMeteors)   state.boardMeteors[pr][c]   = meteors[i];
            if (state.boardBlizzards) state.boardBlizzards[pr][c] = blizzards[i];
            if (state.boardWreckers)  state.boardWreckers[pr][c]  = wreckers[i];
            if (state.boardHails)     state.boardHails[pr][c]     = hails[i];
            if (state.boardRockets)   state.boardRockets[pr][c]   = rockets[i];
            if (state.boardBooms)     state.boardBooms[pr][c]     = booms[i];
            pr--;
        }
    }
}
