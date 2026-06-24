/** Language preference persistence — reads/writes .deepreef/lang.json */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Locale } from './strings.js';
import { LangConfigSchema } from '../settings-schema.js';

const LANG_FILE = '.deepreef/lang.json';

function getConfigDir(): string {
  return join(process.cwd(), '.deepreef');
}

export function loadLang(): Locale | null {
  try {
    const dir = getConfigDir();
    const raw = readFileSync(join(dir, 'lang.json'), 'utf8');
    const parsed = JSON.parse(raw);
    const result = LangConfigSchema.safeParse(parsed);
    if (result.success) {
      return result.data.lang;
    }
    return null
  } catch {}
  return null;
}

export function saveLang(locale: Locale): void {
  const dir = getConfigDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'lang.json'), JSON.stringify({ lang: locale }, null, 2), 'utf8');
}
