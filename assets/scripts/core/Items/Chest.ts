/**
 * Chest level prop — when its host cell is cleared, grants one random magic
 * item from the live inventory (items already at cap are excluded from the
 * roll, with their probability split proportionally between the remaining
 * slots so a roll never lands on a full slot).
 *
 * This module is a thin alias over `Inventory.grantRandomItem` to keep
 * symmetry with the other item modules and document the intent.
 */

import { MagicItemKey } from '../Constants';
import { Inventory } from '../Types';
import { grantRandomItem, RandomFn } from '../Inventory';

/** Caller invokes this when a chest's host cell is cleared. Returns the
 *  granted key, or null if the inventory was already maxed out everywhere. */
export function activateChest(inv: Inventory, rng: RandomFn = Math.random): MagicItemKey | null {
    return grantRandomItem(inv, rng);
}
