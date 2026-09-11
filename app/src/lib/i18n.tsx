import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import uk from '../i18n/uk.json';
import pl from '../i18n/pl.json';
import en from '../i18n/en.json';

export const LOCALES = ['uk', 'pl', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

const DICTS: Record<Locale, Record<string, unknown>> = { uk, pl, en };
const KEY = 'wl.locale';

function detect(): Locale {
  const saved = localStorage.getItem(KEY) as Locale | null;
  if (saved && LOCALES.includes(saved)) return saved;
  for (const lang of navigator.languages ?? []) {
    const short = lang.slice(0, 2) as Locale;
    if (LOCALES.includes(short)) return short;
  }
  return 'uk';
}

/** Дістає значення за ключем виду 'auth.login.title'. */
function lookup(dict: Record<string, unknown>, path: string): string | undefined {
  let node: unknown = dict;
  for (const part of path.split('.')) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === 'string' ? node : undefined;
}

type I18n = {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
};

const Ctx = createContext<I18n | null>(null);

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(detect);

  const setLocale = useCallback((l: Locale) => {
    localStorage.setItem(KEY, l);
    document.documentElement.lang = l;
    setLocaleState(l);
  }, []);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      // Українська — запасний варіант: краще показати чужою мовою, ніж технічний ключ.
      const raw = lookup(DICTS[locale], key) ?? lookup(DICTS.uk, key) ?? key;
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (m, name: string) => String(vars[name] ?? m));
    },
    [locale],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n використано поза I18nProvider');
  return v;
}
