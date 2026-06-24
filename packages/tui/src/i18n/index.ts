/** i18n entry point — import from here for translations. */

export type { Locale, Strings } from './strings.js';
import type { Locale, Strings } from './strings.js';
import { zhCN } from './zh-CN.js';
import { en } from './en.js';
import { loadLang, saveLang } from './persist.js';

export const dicts: Record<Locale, Strings> = { 'zh-CN': zhCN, en };

let activeLocale: Locale = loadLang() ?? 'zh-CN';

/** Get the current locale's string dictionary. */
export function t(): Strings { return dicts[activeLocale]; }

export { saveLang } from './persist.js';

/** Switch the active locale at runtime and persist. */
export function setLocale(locale: Locale): void {
  activeLocale = locale;
  saveLang(locale);
}

/** Get the current active locale. */
export function getLocale(): Locale { return activeLocale; }

/** Get the other locale (for toggle). */
export function toggleLocale(): Locale {
  return activeLocale === 'zh-CN' ? 'en' : 'zh-CN';
}
