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
import { ZH_HANT } from './strings/zh-Hant';
import { EN } from './strings/en';
import { JA } from './strings/ja';
import { KO } from './strings/ko';
import { ES } from './strings/es';
import { PT_BR } from './strings/pt-BR';
import { FR } from './strings/fr';
import { DE } from './strings/de';
import { RU } from './strings/ru';

/** All 10 supported languages — global coverage of top mobile-gaming
 *  markets. Any missing key falls back to Chinese (source of truth). */
export type Lang =
    | 'zh' | 'zh-Hant'         // Chinese: Mainland + Traditional
    | 'en'                      // English (global)
    | 'ja' | 'ko'               // East Asia
    | 'es' | 'pt-BR'            // LATAM + Spain + Brazil
    | 'fr' | 'de'               // Western Europe
    | 'ru';                     // Russia + CIS

/** Rotation order for cycleLang() — grouped by writing system so the
 *  toggle feels intentional: Chinese → English → East Asian → Latin →
 *  Cyrillic. */
const LANG_ORDER: Lang[] = [
    'zh', 'zh-Hant', 'en', 'ja', 'ko',
    'es', 'pt-BR', 'fr', 'de', 'ru',
];
const PACKS: Record<Lang, Record<string, string>> = {
    zh: ZH,
    'zh-Hant': ZH_HANT,
    en: EN,
    ja: JA,
    ko: KO,
    es: ES,
    'pt-BR': PT_BR,
    fr: FR,
    de: DE,
    ru: RU,
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

/**
 * Map an OS-level language code (e.g. from `sys.languageCode`) to one
 * of our supported Lang codes. Fallback for unsupported languages is
 * 'en' (universal reach — most players understand basic English UI
 * better than random Chinese fallback).
 *
 * Case-insensitive. Handles both short codes ('zh') and full locales
 * ('zh-CN', 'pt-BR', 'en-US'). If the input has a region tag that
 * matters (like zh-TW → zh-Hant, pt-BR/pt-PT differences), we route
 * accordingly; otherwise the language prefix is enough.
 */
export function mapSystemLangToLang(sysLangCode: string): Lang {
    if (!sysLangCode) return 'en';
    const s = sysLangCode.toLowerCase().replace(/_/g, '-');
    // Chinese variants — key on region (TW / HK use Traditional).
    if (s === 'zh-tw' || s === 'zh-hk' || s === 'zh-mo' || s.startsWith('zh-hant')) return 'zh-Hant';
    if (s === 'zh' || s.startsWith('zh-')) return 'zh';   // Mainland Simplified default
    // Portuguese: we only ship pt-BR; pt-PT users get pt-BR too (closer than English).
    if (s.startsWith('pt')) return 'pt-BR';
    // Simple prefix maps for the rest.
    if (s.startsWith('en')) return 'en';
    if (s.startsWith('ja')) return 'ja';
    if (s.startsWith('ko')) return 'ko';
    if (s.startsWith('es')) return 'es';
    if (s.startsWith('fr')) return 'fr';
    if (s.startsWith('de')) return 'de';
    if (s.startsWith('ru')) return 'ru';
    // Unsupported (hi, vi, id, ar, tr, ...) — default to English.
    return 'en';
}

/**
 * First-launch auto-detect: if the player has never picked a language
 * (localStorage empty), pick one based on the OS language. If they
 * HAVE picked, respect their choice — don't override.
 *
 * Call this ONCE at boot (from LoadingController) BEFORE any UI
 * renders. Passing in `sysLangCode` keeps this module free of Cocos
 * imports — caller supplies `sys.languageCode` (or the web equivalent).
 *
 * Returns the language that ended up active (either the saved one or
 * the newly-detected one) so the caller can log for debugging.
 */
export function initFromSystemLang(sysLangCode: string): Lang {
    // Respect prior explicit choice — never override.
    try {
        if (typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY)) {
            return currentLang;
        }
    } catch (_) { /* ignore */ }
    const detected = mapSystemLangToLang(sysLangCode);
    if (detected !== currentLang) {
        setLang(detected);
    }
    return currentLang;
}

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
