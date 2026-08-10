import { describe, it, expect } from 'vitest';
import { ITEM_KEYS, ITEM_MAX } from '../../assets/scripts/core/Constants';
import {
    makeEmptyInventory,
    pickRandomItem,
    grantRandomItem,
    consumeItem,
} from '../../assets/scripts/core/Inventory';

describe('makeEmptyInventory', () => {
    it('every key starts at 0', () => {
        const inv = makeEmptyInventory();
        for (const k of ITEM_KEYS) expect(inv[k]).toBe(0);
    });
});

describe('pickRandomItem / grantRandomItem', () => {
    it('always returns a valid key when not at cap', () => {
        const inv = makeEmptyInventory();
        for (let i = 0; i < 50; i++) {
            const k = pickRandomItem(inv);
            expect(k).not.toBeNull();
            expect(ITEM_KEYS).toContain(k!);
        }
    });

    it('returns null when everything is capped', () => {
        const inv = makeEmptyInventory();
        for (const k of ITEM_KEYS) inv[k] = ITEM_MAX;
        expect(pickRandomItem(inv)).toBeNull();
        expect(grantRandomItem(inv)).toBeNull();
    });

    it('grantRandomItem increments the chosen counter', () => {
        const inv = makeEmptyInventory();
        const k = grantRandomItem(inv, () => 0);
        expect(k).not.toBeNull();
        expect(inv[k!]).toBe(1);
    });

    it('skips full slots — distribution stays valid', () => {
        const inv = makeEmptyInventory();
        // Cap every slot except `meteor`.
        for (const k of ITEM_KEYS) if (k !== 'meteor') inv[k] = ITEM_MAX;
        for (let i = 0; i < 20; i++) {
            expect(pickRandomItem(inv)).toBe('meteor');
        }
    });
});

describe('consumeItem', () => {
    it('decrements an existing count', () => {
        const inv = makeEmptyInventory();
        inv.hourglass = 2;
        expect(consumeItem(inv, 'hourglass')).toBe(true);
        expect(inv.hourglass).toBe(1);
    });

    it('returns false when slot is empty', () => {
        const inv = makeEmptyInventory();
        expect(consumeItem(inv, 'hourglass')).toBe(false);
        expect(inv.hourglass).toBe(0);
    });
});
