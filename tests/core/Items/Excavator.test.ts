import { describe, it, expect, vi } from 'vitest';
import { COLS } from '../../../assets/scripts/core/Constants';
import { emptyLevelBoardState } from '../../../assets/scripts/core/Board';
import { activateExcavator } from '../../../assets/scripts/core/Items/Excavator';

describe('activateExcavator', () => {
    it('returns false when there are no colored cells', () => {
        const s = emptyLevelBoardState();
        // Reserved zone only (gray X).
        for (let r = s.board.length - 4; r < s.board.length; r++) {
            for (let c = 0; c < COLS; c++) s.board[r][c] = 'X';
        }
        const result = activateExcavator(s, s.board.length - 4);
        expect(result).toBe(false);
    });

    it('clears the bottom 3 colored rows', () => {
        const s = emptyLevelBoardState();
        // Lay down 5 rows of colored cells in the task zone.
        for (let r = 10; r <= 14; r++) {
            for (let c = 0; c < COLS; c++) s.board[r][c] = 'T';
        }
        const result = activateExcavator(s, s.board.length - 4);
        expect(result).toBe(true);
        // The bottom 3 (rows 12, 13, 14) should be cleared. After applyColumnGravity,
        // rows 10-11 fall to 13-14. So we expect rows 12 to be the highest non-empty.
        let topFilled = -1;
        for (let r = 0; r < s.board.length; r++) {
            for (let c = 0; c < COLS; c++) {
                if (s.board[r][c]) { topFilled = r; break; }
            }
            if (topFilled >= 0) break;
        }
        // 5 original − 3 dug = 2 rows remaining. Gravity packs them flush against
        // the reserved zone (rows 14 & 15 — reservedTop = 16, so the floor is 15).
        // The top non-empty row is therefore 14.
        expect(topFilled).toBe(14);
    });

    it('skips gray reserved (X) cells', () => {
        const s = emptyLevelBoardState();
        for (let r = s.board.length - 4; r < s.board.length; r++) {
            for (let c = 0; c < COLS; c++) s.board[r][c] = 'X';
        }
        // No colored content above. Should fail.
        expect(activateExcavator(s, s.board.length - 4)).toBe(false);
    });

    it('triggers chest hooks on excavated chest cells', () => {
        const s = emptyLevelBoardState();
        s.board[14][5] = 'T';
        s.boardChests![14][5] = true;
        const onChestTriggered = vi.fn();
        activateExcavator(s, s.board.length - 4, { onChestTriggered });
        expect(onChestTriggered).toHaveBeenCalledTimes(1);
    });
});
