import { createContext, useContext, useCallback } from 'react';
import type { Locale, Strings } from './strings.js';
import { dicts, setLocale as setGlobalLocale, saveLang } from './index.js';
import { getLocale } from './index.js';

interface LocaleContextValue {
  locale: Locale;
  t: () => Strings;
  setLocale: (next: Locale) => void;
}

const LocaleContext = createContext<LocaleContextValue>({
  locale: getLocale(),
  t: () => dicts[getLocale()],
  setLocale: () => {},
});

export function useLocale(): LocaleContextValue {
  return useContext(LocaleContext);
}

export function useT(): () => Strings {
  const { t } = useLocale();
  return t;
}

export function useSetLocale(): (next: Locale) => void {
  const { setLocale: setCtx } = useLocale();
  return setCtx;
}

export interface LocaleProviderProps {
  locale: Locale;
  onLocaleChange: (next: Locale) => void;
  children: React.ReactNode;
}

export function LocaleProvider({ locale, onLocaleChange, children }: LocaleProviderProps) {
  const setLocale = useCallback((next: Locale) => {
    setGlobalLocale(next);
    onLocaleChange(next);
  }, [onLocaleChange]);

  const value: LocaleContextValue = {
    locale,
    t: () => dicts[locale],
    setLocale,
  };

  return (
    <LocaleContext.Provider value={value}>
      {children}
    </LocaleContext.Provider>
  );
}
