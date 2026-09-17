import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';

export type Theme = 'light' | 'dark' | 'system';

const KEY = 'wl.theme';
const Ctx = createContext<{ theme: Theme; setTheme: (t: Theme) => void } | null>(null);

function apply(theme: Theme) {
  const dark =
    theme === 'dark' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';

  // Системні панелі (адресний рядок, смуга статусу встановленого застосунку)
  // мають збігатися з фоном сторінки, а не з темою системи, якщо тему обрано вручну.
  // Значення — --surface зі styles.css: цей колір має верхня панель застосунку.
  const color = dark ? '#161b1a' : '#ffffff';
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.setAttribute('content', color);
  });
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(
    () => (localStorage.getItem(KEY) as Theme | null) ?? 'system',
  );

  useEffect(() => {
    apply(theme);
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system');
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme]);

  const setTheme = useCallback((t: Theme) => {
    localStorage.setItem(KEY, t);
    setThemeState(t);
  }, []);

  return <Ctx.Provider value={{ theme, setTheme }}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme використано поза ThemeProvider');
  return v;
}
