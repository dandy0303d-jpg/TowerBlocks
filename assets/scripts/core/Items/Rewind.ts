/**
 * Time-rewind magic item — restores the board state from 4 piece-locks ago.
 * The original prototype keeps the last `HISTORY_MAX` snapshots in a FIFO and
 * the rewind activator pops index `length - 4` (i.e. the snapshot from 3
 * locks before "now"). That matches the player intuition "undo the last 3
 * moves" while still leaving room for a future undo button.
 */

import { HISTORY_MAX } from '../Constants';
import { BoardState, HistorySnapshot } from '../Types';
import { cloneBoardState, cloneBoardLike } from '../Board';

export interface SnapshotInputs {
    state:        BoardState;
    score:        number;
    lines:        number;
    level:        number;
    towerHeight:  number;
}
export interface SnapshotApplyOutputs {
    score:        number;
    lines:        number;
    level:        number;
    towerHeight:  number;
}

export class RewindHistory {
    private stack: HistorySnapshot[] = [];

    /** Push a snapshot right after a piece lock. */
    snapshot(inputs: SnapshotInputs): void {
        const s = inputs.state;
        this.stack.push({
            board:           cloneBoardLike(s.board) as HistorySnapshot['board'],
            boardBombs:      cloneBoardLike(s.boardBombs),
            boardStones:     cloneBoardLike(s.boardStones),
            boardChests:     cloneBoardLike(s.boardChests),
            boardMeteors:    cloneBoardLike(s.boardMeteors),
            boardBlizzards:  cloneBoardLike(s.boardBlizzards),
            boardWreckers:   cloneBoardLike(s.boardWreckers),
            boardHails:      cloneBoardLike(s.boardHails),
            boardHailPlaced: cloneBoardLike(s.boardHailPlaced),
            boardRockets:    cloneBoardLike(s.boardRockets),
            boardGatlings:   cloneBoardLike(s.boardGatlings),
            boardBooms:      cloneBoardLike(s.boardBooms),
            score:       inputs.score,
            lines:       inputs.lines,
            level:       inputs.level,
            towerHeight: inputs.towerHeight,
        });
        while (this.stack.length > HISTORY_MAX) this.stack.shift();
    }

    /** Reverse 3 piece-locks (i.e. restore the snapshot at depth 4 from the
     *  top of the stack). Returns null if there aren't enough snapshots yet —
     *  the caller refunds the inventory entry. */
    activate(target: BoardState): SnapshotApplyOutputs | null {
        if (this.stack.length < 4) return null;
        const idx = this.stack.length - 4;
        const snap = this.stack[idx];

        target.board           = cloneBoardLike(snap.board) as BoardState['board'];
        target.boardBombs      = cloneBoardLike(snap.boardBombs);
        target.boardStones     = cloneBoardLike(snap.boardStones);
        target.boardChests     = cloneBoardLike(snap.boardChests);
        target.boardMeteors    = cloneBoardLike(snap.boardMeteors);
        target.boardBlizzards  = cloneBoardLike(snap.boardBlizzards);
        target.boardWreckers   = cloneBoardLike(snap.boardWreckers);
        target.boardHails      = cloneBoardLike(snap.boardHails);
        target.boardHailPlaced = cloneBoardLike(snap.boardHailPlaced);
        target.boardRockets    = cloneBoardLike(snap.boardRockets);
        target.boardGatlings   = cloneBoardLike(snap.boardGatlings);
        target.boardBooms      = cloneBoardLike(snap.boardBooms);

        // Drop the restored snapshot AND every snapshot after it.
        this.stack.length = idx + 1;
        return {
            score:       snap.score,
            lines:       snap.lines,
            level:       snap.level,
            towerHeight: snap.towerHeight,
        };
    }

    reset(): void {
        this.stack.length = 0;
    }

    /** Test inspection. */
    depth(): number {
        return this.stack.length;
    }
}
