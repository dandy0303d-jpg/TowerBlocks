import { describe, it, expect } from 'vitest';
import { ITEM_KEYS, ITEM_MAX } from '../../../assets/scripts/core/Constants';
import { makeEmptyInventory } from '../../../assets/scripts/core/Inventory';
import { activateChest } from '../../../assets/scripts/core/Items/Chest';

describe('activateChest', () => {
    it('grants a magic item and increments the count', () => {
        const inv = makeEmptyInventory();
        const k = activateChest(inv, () => 0);
        expect(k).not.toBeNull();
        expect(inv[k!]).toBe(1);
    });

    it('returns null if every slot is capped', () => {
        const inv = makeEmptyInventory();
        for (const k of ITEM_KEYS) inv[k] = ITEM_MAX;
        expect(activateChest(inv)).toBeNull();
    });
});
