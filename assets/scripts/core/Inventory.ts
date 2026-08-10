/**
 * Magic-item inventory. Five item types, each capped at `ITEM_MAX`. The
 * inventory itself is just a `Record<MagicItemKey, number>` — this module
 * provides factories, mutation helpers, and the weighted random picker used
 * by chest drops (the only legitimate way to gain items mid-game).
 */

import { ITEM_KEYS, ITEM_BASE_PROBS, ITEM_MAX, MagicItemKey } from './Constants';
import { Inventory } from './Types';

export type RandomFn = () => number;

/** Create a fresh inventory with all counts at 0. */
export function makeEmptyInventory(): Inventory {
    const inv = {} as Inventory;
    for (const k of ITEM_KEYS) inv[k] = 0;
    return inv;
}

/** Pick a magic item to award. Items at cap have their probability split
 *  proportionally between the others, so a roll never lands on a full slot.
 *  Returns `null` only when every slot is full. */
export function pickRandomItem(inv: Inventory, rng: RandomFn = Math.random): MagicItemKey | null {
    const live = ITEM_KEYS.filter(k => inv[k] < ITEM_MAX);
    if (!live.length) return null;
    const liveTotal = live.reduce((s, k) => s + ITEM_BASE_PROBS[k], 0);
    if (liveTotal <= 0) return null;
    let r = rng();
    for (const k of live) {
        const p = ITEM_BASE_PROBS[k] / liveTotal;
        if (r < p) return k;
        r -= p;
    }
    return live[live.length - 1];
}

/** Grant the player one random item. Returns the granted key, or `null` if
 *  every slot was already at the cap. Mutates `inv` in place. */
export function grantRandomItem(inv: Inventory, rng: RandomFn = Math.random): MagicItemKey | null {
    const k = pickRandomItem(inv, rng);
    if (k === null) return null;
    inv[k]++;
    return k;
}

/** Spend one of `key`. Returns true if the spend succeeded. */
export function consumeItem(inv: Inventory, key: MagicItemKey): boolean {
    if (inv[key] <= 0) return false;
    inv[key]--;
    return true;
}
