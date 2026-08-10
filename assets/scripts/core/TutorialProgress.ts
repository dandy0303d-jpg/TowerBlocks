/**
 * TutorialProgress — persistent "which tutorials the player has seen" store.
 *
 * MVP has one key (`operations`) covering the 4-gesture intro. Add more
 * keys later for feature-specific tutorials (e.g. `magic-items`,
 * `blind-mode-cues`) without changing this API.
 *
 * Storage: Cocos `sys.localStorage` — the same key survives app updates
 * as long as the OS keeps the data.
 */

import { sys } from 'cc';

/** Prefix so all tutorial flags live under one namespace and don't
 *  collide with other localStorage keys. */
const KEY_PREFIX = 'tt.tutorial.seen.';

class Store {
    /** True if the given tutorial has been marked complete on this device. */
    hasSeen(key: string): boolean {
        return sys.localStorage.getItem(KEY_PREFIX + key) === '1';
    }

    /** Mark a tutorial complete. Called by TutorialController when the
     *  player either finishes all steps OR taps the skip button. */
    markSeen(key: string): void {
        sys.localStorage.setItem(KEY_PREFIX + key, '1');
    }

    /** Wipe all tutorial flags. For debug / a "重看引导" settings option. */
    reset(): void {
        // Enumerate keys and remove ones starting with our prefix.
        // `sys.localStorage` doesn't expose a clear-by-prefix, so we
        // walk the flags we know about — currently just one.
        this.forget('operations');
    }

    /** Wipe one specific tutorial flag. */
    forget(key: string): void {
        sys.localStorage.removeItem(KEY_PREFIX + key);
    }
}

/** Module-singleton. */
export const TutorialProgress = new Store();
