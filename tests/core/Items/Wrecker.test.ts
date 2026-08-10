import { describe, it, expect, vi } from 'vitest';
import { COLS, WRECKER_TARGETS } from '../../../assets/scripts/core/Constants';
import { emptyLevelBoardState } from '../../../assets/scripts/core/Board';
import { activateWrecker } from '../../../assets/scripts/core/Items/Wrecker';

describe('activateWrecker', () => {
    it('destroys WRECKER_TARGETS colored cells', () => {
        const s = emptyLevelBoardState();
        // Lay 30 colored cells.
        const placed: Array<[number, number]> = [];
        let counter = 0;
        for (let r = 5; r < 11 && counter < 30; r++) {
            for (let c = 0; c < 5 && counter < 30; c++) {
                s.board[r][c] = 'T';
                placed.push([r, c]);
                counter++;
            }
        }
        // Deterministic shuffle by injecting a non-random rng.
        const rng = () => 0;
        activateWrecker(s, {}, rng);

        // Count remaining colored cells.
        let remaining = 0;
        for (let r = 0; r < s.board.length; r++) {
            for (let c = 0; c < COLS; c++) {
                if (s.board[r][c]) remaining++;
            }
        }
        expect(remaining).toBe(30 - WRECKER_TARGETS);
    });

    it('does NOT touch gray X or hail H cells', () => {
        const s = emptyLevelBoardState();
        s.board[5][0] = 'X';
        s.board[5][1] = 'H';
        s.board[5][2] = 'T';
        // Only one colored cell exists → at most one gets destroyed.
        activateWrecker(s);
        expect(s.board[5][0]).toBe('X');
        expect(s.board[5][1]).toBe('H');
    });

    it('triggers chest hook for chests on destroyed cells', () => {
        const s = emptyLevelBoardState();
        s.board[5][3] = 'T';
        s.boardChests![5][3] = true;
        const onChestTriggered = vi.fn();
        // Only one candidate → it WILL be picked.
        activateWrecker(s, { onChestTriggered });
        expect(onChestTriggered).toHaveBeenCalledWith(5, 3);
    });

    it('leaves wrecker prop on destroyed cells (chain via caller)', () => {
        const s = emptyLevelBoardState();
        s.board[5][3] = 'T';
        s.boardWreckers![5][3] = true;   // wrecker prop sits on the cell
        const onWreckerTriggered = vi.fn();
        activateWrecker(s, { onWreckerTriggered });
        // Wrecker hook is NOT fired here — the wrecker prop is left on the cell
        // so that processClearedWreckers (called by the caller) can chain.
        expect(onWreckerTriggered).not.toHaveBeenCalled();
        expect(s.boardWreckers![5][3]).toBe(true);
        // Board cell IS nulled though.
        expect(s.board[5][3]).toBeNull();
    });

    it('returns true even when there are no candidates', () => {
        const s = emptyLevelBoardState();
        expect(activateWrecker(s)).toBe(true);
    });
});
