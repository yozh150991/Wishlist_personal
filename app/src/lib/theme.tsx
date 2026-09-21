import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Дві незалежні осі вигляду.
 *
 * `theme`  — світла / темна / як у системі.
 * `scheme` — кольорова схема: Шавлія (усталена), Слива, Вугіль.
 *
 * Разом вони дають шість наборів токенів (`styles/tokens.css`). Компоненти
 * жодної з осей не читають: усе, що звідси виходить назовні, — пара атрибутів
 * `data-theme` / `data-scheme` на <html>.
 *
 * Обидва значення дублюються в localStorage навіть у власника, у якого вони
 * їдуть у профіль: інлайновий скрипт у <head> має поставити атрибути до
 * першого рендера, а профіль на той момент ще не завантажений. Профіль —
 * джерело істини між пристроями, localStorage — щоб не блимало.
 *
 * Гість акаунта не має: у нього вибір живе тільки в localStorage і на сервер
 * не їде — інакше це був би ще один сигнал про те, що хтось відкрив посилання.
 */

export type Theme = 'light' | 'dark' | 'system';
export type Scheme = 'sage' | 'slyva' | 'vuhil';

export const THEMES: readonly Theme[] = ['light', 'dark', 'system'];
export const SCHEMES: readonly Scheme[] = ['sage', 'slyva', 'vuhil'];

const THEME_KEY = 'wl.theme';
const SCHEME_KEY = 'wl.scheme';

type Value = {
  theme: Theme;
  scheme: Scheme;
  setTheme: (t: Theme) => void;
  setScheme: (s: Scheme) => void;
  /** true, якщо система просить посилений контраст, а Вугіль ще не обрано. */
  suggestsContrast: boolean;
};

const Ctx = createContext<Value | null>(null);

function isTheme(v: unknown): v is Theme {
  return v === 'light' || v === 'dark' || v === 'system';
}

function isScheme(v: unknown): v is Scheme {
  return v === 'sage' || v === 'slyva' || v === 'vuhil';
}

/** Читання зі сховища ніколи не валить застосунок: приватний режим може кинути. */
function read<T>(key: string, guard: (v: unknown) => v is T, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return guard(raw) ? raw : fallback;
  } catch {
    return fallback;
  }
}

function write(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* приватний режим або заборонене сховище — вибір просто не переживе вкладку */
  }
}

function prefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Ставить атрибути на <html> і підганяє колір системних панелей.
 *
 * Колір не задається тут літералом: він читається з уже застосованої палітри,
 * тому лишається рівно одне джерело значень — tokens.css. Без цього кожна нова
 * схема вимагала б правити ще й цей файл, і хтось колись забув би.
 */
function apply(theme: Theme, scheme: Scheme) {
  const root = document.documentElement;
  root.dataset.theme = theme === 'system' ? (prefersDark() ? 'dark' : 'light') : theme;
  root.dataset.scheme = scheme;

  const bg = getComputedStyle(root).getPropertyValue('--color-bg').trim();
  if (!bg) return;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.removeAttribute('media');
    m.setAttribute('content', bg);
  });
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => read(THEME_KEY, isTheme, 'system'));
  const [scheme, setSchemeState] = useState<Scheme>(() => read(SCHEME_KEY, isScheme, 'sage'));

  useEffect(() => {
    apply(theme, scheme);
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system', scheme);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme, scheme]);

  const setTheme = useCallback((t: Theme) => {
    write(THEME_KEY, t);
    setThemeState(t);
  }, []);

  const setScheme = useCallback((s: Scheme) => {
    write(SCHEME_KEY, s);
    setSchemeState(s);
  }, []);

  // Людина, якій система вже вмикає посилений контраст, майже напевно хоче
  // Вугілля. Пропонуємо, але не перемикаємо за неї: це її екран.
  const suggestsContrast = useMemo(() => {
    if (scheme === 'vuhil') return false;
    try {
      return window.matchMedia('(prefers-contrast: more)').matches;
    } catch {
      return false;
    }
  }, [scheme]);

  const value = useMemo(
    () => ({ theme, scheme, setTheme, setScheme, suggestsContrast }),
    [theme, scheme, setTheme, setScheme, suggestsContrast],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme використано поза ThemeProvider');
  return v;
}
