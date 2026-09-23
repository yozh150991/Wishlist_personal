import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';

/**
 * Три незалежні осі вигляду.
 *
 * `theme`  — світла / темна / як у системі.
 * `scheme` — кольорова схема: Шавлія (усталена), Слива, Вугіль.
 * `design` — версія дизайну: v1 (нинішній) або v2 (наступний, ADR-032).
 *
 * Тема й схема разом дають шість наборів токенів (`styles/tokens.css`).
 * Версія дизайну стоїть над ними: v2 — це інші екрани й інший порядок кроків,
 * а не перефарбована v1. Тому вона розділяється не в компонентах, а по
 * таблиці маршрутів (`designs/`), і кожна версія працює з усіма шістьма
 * наборами токенів — осі не множаться одна на одну.
 *
 * Що версія **не** міняє — дані. Усе з `lib/` спільне для обох.
 *
 * Назовні звідси виходить трійка атрибутів `data-theme` / `data-scheme` /
 * `data-design` на <html> (за них чіпляються стилі) і значення `design`, за
 * яким `DesignRoutes` вибирає таблицю маршрутів (ADR-032).
 *
 * Тема й схема дублюються в localStorage навіть у власника, у якого вони
 * їдуть у профіль: інлайновий скрипт у <head> має поставити атрибути до
 * першого рендера, а профіль на той момент ще не завантажений. Профіль —
 * джерело істини між пристроями, localStorage — щоб не блимало.
 *
 * Версія дизайну в профіль **не** їде і лишається в браузері: поки v2 не
 * готова, вибір її на телефоні не має міняти вигляд на ноутбуці посеред
 * роботи. Коли v2 стане усталеною, це рішення переглядається (ADR-032).
 *
 * Гість акаунта не має: у нього вибір живе тільки в localStorage і на сервер
 * не їде — інакше це був би ще один сигнал про те, що хтось відкрив посилання.
 */

export type Theme = 'light' | 'dark' | 'system';
export type Scheme = 'sage' | 'slyva' | 'vuhil';
export type Design = 'v1' | 'v2';

export const THEMES: readonly Theme[] = ['light', 'dark', 'system'];
export const SCHEMES: readonly Scheme[] = ['sage', 'slyva', 'vuhil'];
export const DESIGNS: readonly Design[] = ['v1', 'v2'];

const THEME_KEY = 'wl.theme';
const SCHEME_KEY = 'wl.scheme';
const DESIGN_KEY = 'wl.design';

type Value = {
  theme: Theme;
  scheme: Scheme;
  design: Design;
  setTheme: (t: Theme) => void;
  setScheme: (s: Scheme) => void;
  setDesign: (d: Design) => void;
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

function isDesign(v: unknown): v is Design {
  return v === 'v1' || v === 'v2';
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

/**
 * Версія дизайну на старті: спершу адреса, потім сховище.
 *
 * `?design=v1` — аварійний вихід із v2. Він потрібен тому, що v2 — це інші
 * екрани, а не інші кольори: якщо вона впаде на першому ж рендері або ще не
 * матиме власних Налаштувань, перемкнутися зсередини застосунку буде нічим.
 * Адреса працює завжди, бо її читає інлайновий скрипт у `<head>` ще до React,
 * а цей код лише повторює його вибір для стану (ADR-032).
 *
 * Скрипт у `<head>` прибирає параметр з адреси одразу після читання, тож сюди
 * він доходить лише тоді, коли скрипт не відпрацював.
 */
function initialDesign(): Design {
  try {
    const q = new URLSearchParams(window.location.search).get('design');
    if (isDesign(q)) {
      write(DESIGN_KEY, q);
      return q;
    }
  } catch {
    /* адреса без параметрів або заборонене сховище — просто йдемо далі */
  }
  return read(DESIGN_KEY, isDesign, 'v1');
}

function prefersDark() {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/**
 * Ставить атрибути на <html> і підганяє колір системних панелей.
 *
 * Колір не задається тут літералом: він читається з уже застосованої палітри,
 * тому лишається рівно одне джерело значень — tokens.css. Без цього кожна нова
 * схема вимагала б правити ще й цей файл, і хтось колись забув би. Версія
 * дизайну ставиться **до** читання `--color-bg`: v2 має право переозначити
 * полотно, і панелі мусять збігтися саме з її значенням.
 */
function apply(theme: Theme, scheme: Scheme, design: Design) {
  const root = document.documentElement;
  root.dataset.theme = theme === 'system' ? (prefersDark() ? 'dark' : 'light') : theme;
  root.dataset.scheme = scheme;
  root.dataset.design = design;

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
  const [design, setDesignState] = useState<Design>(initialDesign);

  useEffect(() => {
    apply(theme, scheme, design);
    if (theme !== 'system') return;
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => apply('system', scheme, design);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [theme, scheme, design]);

  const setTheme = useCallback((t: Theme) => {
    write(THEME_KEY, t);
    setThemeState(t);
  }, []);

  const setScheme = useCallback((s: Scheme) => {
    write(SCHEME_KEY, s);
    setSchemeState(s);
  }, []);

  const setDesign = useCallback((d: Design) => {
    write(DESIGN_KEY, d);
    setDesignState(d);
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
    () => ({ theme, scheme, design, setTheme, setScheme, setDesign, suggestsContrast }),
    [theme, scheme, design, setTheme, setScheme, setDesign, suggestsContrast],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme використано поза ThemeProvider');
  return v;
}

/**
 * Версія дизайну для того, хто вибирає таблицю маршрутів.
 *
 * Окремий хук, а не поле з `useTheme()`, свідомо: так у коді видно кожне
 * місце, яке залежить від версії. Таких місць має бути рівно одне —
 * `designs/DesignRoutes.tsx`. Гілка `design === 'v2'` всередині екрана
 * означає, що екран належить обом версіям одразу; це борг, а не спосіб
 * писати нове (ADR-032).
 */
export function useDesign(): Design {
  return useTheme().design;
}
