/**
 * Lightweight i18n core.
 *
 *   • Strings live in per-language tables under `./strings/<lang>.ts`.
 *   • `t(key, params?)` reads from the currently-selected language and
 *     falls back to Chinese when a key is missing (zh is the source of
 *     truth — translators copy from there).
 *   • `setLang(lang)` switches the active language at runtime,
 *     persists the choice to `localStorage`, and notifies subscribers
 *     so UI can re-render.
 *   • `subscribe(cb)` lets UI components register for change events.
 *     They typically call a "rebuild labels" helper from the callback.
 *
 * The module is dependency-free (no Cocos imports), so it's safe to
 * use from anywhere in `core/` or `main/`.
 */

import { ZH } from './strings/zh';
import { EN } from './strings/en';
import { KO } from './strings/ko';

export type Lang = 'zh' | 'en' | 'ko';

/** All language packs keyed by lang code. Order here also drives the
 *  rotation used by `cycleLang()`. */
const LANG_ORDER: Lang[] = ['zh', 'en', 'ko'];
const PACKS: Record<Lang, Record<string, string>> = {
    zh: ZH,
    en: EN,
    ko: KO,
};

const STORAGE_KEY = 'tetritower.lang';

/** Source of truth — defaults to Chinese, loaded from localStorage on
 *  first import if the key is set. */
let currentLang: Lang = (() => {
    try {
        const saved = (typeof localStorage !== 'undefined') ? localStorage.getItem(STORAGE_KEY) : null;
        if (saved && (LANG_ORDER as string[]).indexOf(saved) >= 0) return saved as Lang;
    } catch (_) { /* SSR / private mode — ignore */ }
    return 'zh';
})();

type Subscriber = () => void;
const subscribers: Subscriber[] = [];

/** Subscribe to language-change events. Returns an unsubscribe fn. */
export function subscribe(cb: Subscriber): () => void {
    subscribers.push(cb);
    return () => {
        const i = subscribers.indexOf(cb);
        if (i >= 0) subscribers.splice(i, 1);
    };
}

/** Get the current language code. */
export function getLang(): Lang {
    return currentLang;
}

/** Change the active language. Persists to localStorage and broadcasts. */
export function setLang(lang: Lang): void {
    if (lang === currentLang) return;
    currentLang = lang;
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, lang);
    } catch (_) { /* ignore storage errors */ }
    for (const cb of subscribers) {
        try { cb(); } catch (e) { console.warn('[i18n] subscriber threw', e); }
    }
}

/** Cycle to the next language in `LANG_ORDER` — used by the toggle
 *  button. Wraps around so a single button covers any number of
 *  languages. */
export function cycleLang(): Lang {
    const idx = LANG_ORDER.indexOf(currentLang);
    const next = LANG_ORDER[(idx + 1) % LANG_ORDER.length];
    setLang(next);
    return currentLang;
}

/** All registered language codes — handy for building dropdowns etc. */
export const SUPPORTED_LANGS: ReadonlyArray<Lang> = LANG_ORDER;

/** Translate a key. `params` substitutes `{name}` placeholders in the
 *  string. Falls back to Chinese, then to the raw key, when missing. */
export function t(key: string, params?: Record<string, string | number>): string {
    const pack = PACKS[currentLang];
    let s = pack[key];
    if (s === undefined) {
        // Fallback: zh is the source of truth.
        s = PACKS.zh[key];
        if (s === undefined) return key;       // last-ditch: raw key
    }
    if (!params) return s;
    return s.replace(/\{(\w+)\}/g, (_m, name) => {
        const v = params[name];
        return v === undefined || v === null ? `{${name}}` : String(v);
    });
}
