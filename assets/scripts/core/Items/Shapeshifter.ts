/**
 * Shapeshifter magic item — opens a picker UI where the player chooses what
 * the active piece becomes. The actual UI overlay lives in the render / UI
 * layer; this module just owns the "request" + "apply" calls.
 *
 * Lifecycle:
 *   1. Player activates → `requestPick()` returns true (start the UI countdown)
 *   2. UI calls `applyPick(currentPiece, newType)` with the player's choice
 *      → returns the mutated `Piece` (caller swaps it into the live slot)
 *   3. If the timeout fires without a pick, caller simply ignores the request
 */

import { PieceType, SHAPES } from '../Constants';
import { Piece } from '../Types';
import { makeEmptyBombs, makeEmptyBooms, makeEmptyWreckers } from '../Bombs';
import { pieceCenter } from '../Pieces';
import { wrap } from '../Board';

/** All non-DOT types the picker offers. */
export const SHAPESHIFTER_OPTIONS: PieceType[] = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];

/**
 * Apply the player's pick. The piece's TYPE (i.e., colour) changes to the
 * player's chosen tetromino. The SHAPE either:
 *   • follows the new type when the current piece had the standard tetromino
 *     shape — this is the regular "any tetromino → any other tetromino"
 *     transformation, or
 *   • stays put when the current piece had a CUSTOM shape (the fate piece
 *     in endless mode, or a level-editor custom shape). The hand-authored
 *     geometry is preserved so the shapeshifter only recolours the piece.
 *     This honours the player's expectation that the fate piece is
 *     "special" and shouldn't morph into a vanilla tetromino.
 *
 * Custom-shape detection uses the explicit `isCustomShape` flag set by
 * `spawn()` — structural shape comparison was too fragile (rotated
 * standard pieces could be misclassified, and fate shapes that happen
 * to mirror a standard tetromino orientation could be misclassified the
 * other way). */
export function applyShapeshifterPick(current: Piece, newType: PieceType): Piece {
    const center = pieceCenter(current);
    const isCustomShape = current.isCustomShape === true;
    const newShape = (isCustomShape ? current.shape : SHAPES[newType]).map(r => r.slice());
    // Recompute x so the new shape's center sits at the same world column.
    let minX = newShape[0].length, maxX = -1;
    for (let r = 0; r < newShape.length; r++) {
        for (let c = 0; c < newShape[r].length; c++) {
            if (newShape[r][c]) {
                if (c < minX) minX = c;
                if (c > maxX) maxX = c;
            }
        }
    }
    const offset = maxX < 0 ? 0 : (minX + maxX + 1) / 2;
    return {
        type:     newType,
        shape:    newShape,
        bombs:    makeEmptyBombs(newShape),
        booms:    makeEmptyBooms(newShape),
        wreckers: makeEmptyWreckers(newShape),
        x:        wrap(Math.round(center - offset)),
        y:        current.y,
        // Custom pieces stay custom across recolouring — the next
        // shapeshifter activation on the result still preserves shape.
        isCustomShape: isCustomShape,
    };
}
