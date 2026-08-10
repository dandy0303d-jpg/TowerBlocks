import { describe, it, expect } from 'vitest';
import { ROWS, COLS } from '../../assets/scripts/core/Constants';
import { loadLevel, validateLevelData } from '../../assets/scripts/core/LevelData';
import { LevelData } from '../../assets/scripts/core/Types';

function emptyGrid<T>(rows: number, cols: number = COLS): (T | null)[][] {
    const g: (T | null)[][] = [];
    for (let r = 0; r < rows; r++) g.push(new Array<T | null>(cols).fill(null));
    return g;
}

function baseLevel(taskHeight = 6, reservedHeight = 4): LevelData {
    return {
        id: 'L_test', order: 1, name: 'Test', author: 'Tester',
        taskHeight, reservedHeight,
        taskZone:        emptyGrid(taskHeight),
        reservedZone:    emptyGrid(reservedHeight),
        taskBombs:       emptyGrid(taskHeight),    reservedBombs:    emptyGrid(reservedHeight),
        taskStones:      emptyGrid(taskHeight),    reservedStones:   emptyGrid(reservedHeight),
        taskChests:      emptyGrid(taskHeight),    reservedChests:   emptyGrid(reservedHeight),
        taskMeteors:     emptyGrid(taskHeight),    reservedMeteors:  emptyGrid(reservedHeight),
        taskBlizzards:   emptyGrid(taskHeight),    reservedBlizzards:emptyGrid(reservedHeight),
        taskWreckers:    emptyGrid(taskHeight),    reservedWreckers: emptyGrid(reservedHeight),
        taskHails:       emptyGrid(taskHeight),    reservedHails:    emptyGrid(reservedHeight),
        taskRockets:     emptyGrid(taskHeight),    reservedRockets:  emptyGrid(reservedHeight),
    };
}

describe('loadLevel', () => {
    it('places task cells at the right offset', () => {
        const lvl = baseLevel(6, 4);
        lvl.taskZone[0][3] = 'T';
        const { state, taskHeight, reservedHeight } = loadLevel(lvl);
        // task[0] lands at ROWS - (taskHeight + reservedHeight) = ROWS - 10.
        const startRow = ROWS - taskHeight - reservedHeight;
        expect(state.board[startRow][3]).toBe('T');
        expect(reservedHeight).toBe(4);
    });

    it('places reserved cells at the bottom', () => {
        const lvl = baseLevel(6, 4);
        lvl.reservedZone[3][12] = 'X';   // bottom-right of reserved
        const { state } = loadLevel(lvl);
        expect(state.board[ROWS - 1][12]).toBe('X');
    });

    it('rejects levels taller than the board', () => {
        const lvl = baseLevel(30, 0);
        expect(() => loadLevel(lvl)).toThrow();
    });

    it('normalises legacy bomb kinds', () => {
        const lvl = baseLevel();
        lvl.taskBombs[2][5] = 'row' as never;
        const { state } = loadLevel(lvl);
        const startRow = ROWS - lvl.taskHeight - lvl.reservedHeight;
        expect(state.boardBombs![startRow + 2][5]).toBe('row1');
    });

    it('passes through valid props', () => {
        const lvl = baseLevel();
        lvl.taskChests[1][7]   = true;
        lvl.taskMeteors[2][3]  = true;
        lvl.taskHails[3][9]    = true;
        lvl.taskRockets[4][1]  = true;
        const { state } = loadLevel(lvl);
        const startRow = ROWS - lvl.taskHeight - lvl.reservedHeight;
        expect(state.boardChests![startRow + 1][7]).toBe(true);
        expect(state.boardMeteors![startRow + 2][3]).toBe(true);
        expect(state.boardHails![startRow + 3][9]).toBe(true);
        expect(state.boardRockets![startRow + 4][1]).toBe(true);
    });

    it('clamps startingItems and ignores invalid keys', () => {
        const lvl = baseLevel();
        lvl.startingItems = { hourglass: 5, excavator: 0, rewind: 1 } as never;
        const { startingItems } = loadLevel(lvl);
        expect(startingItems.hourglass).toBe(5);
        expect(startingItems.excavator).toBeUndefined();
        expect(startingItems.rewind).toBe(1);
    });
});

describe('validateLevelData', () => {
    it('accepts a well-formed level', () => {
        const lvl = baseLevel();
        expect(() => validateLevelData(lvl)).not.toThrow();
    });
    it('rejects non-object input', () => {
        expect(() => validateLevelData(null)).toThrow();
        expect(() => validateLevelData('garbage')).toThrow();
    });
    it('rejects missing fields', () => {
        const lvl = baseLevel() as Partial<LevelData>;
        delete lvl.taskHeight;
        expect(() => validateLevelData(lvl)).toThrow(/taskHeight/);
    });
    it('rejects taskHeight < 1', () => {
        const lvl = baseLevel(0, 4);
        expect(() => validateLevelData(lvl)).toThrow();
    });
});
