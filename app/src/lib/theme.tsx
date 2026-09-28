import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { isScheme, isTheme, resolveAppearance, SCHEMES, THEMES } from './appearance';
import type { Resolved, Scheme, Surface, Theme } from './appearance';
import { OVERLAY_VARS, overlayVars } from './hue-ramp.js';

export { SCHEMES, THEMES };
export type { Scheme, Theme };

/**
 * Осі вигляду й те, що з них виходить на <html>.
 *
 * `theme`        — світла / темна / як у системі; завжди глядача.
 * `scheme`       — схема смаку: Шавлія (усталена), Слива, Полотно, Цитрус, Ніч.
 * `highContrast` — тумблер доступності, єдиний вхід у Вугіль. Не перезаписує
 *                  `scheme`: вимкнув — повернувся до свого смаку.
 * `design`       — версія дизайну: v1 (нинішній) або v2 (наступний, ADR-032).
 * `surface`      — де глядач зараз: свої екрани, гостьова чи превʼю гостьової.
 *
 * Що з цього стане атрибутами `data-scheme` / `data-theme` / `data-appearance`,
 * вирішує одна функція — `resolveAppearance()` (lib/appearance.ts, ADR-033).
 * Вона викликається тут і більше ніде.
 *
 * Тема, схема й контраст дублюються в localStorage навіть у власника, у якого
 * вони їдуть у профіль: інлайновий скрипт у <head> має поставити атрибути до
 * першого рендера, а профіль на той момент ще не завантажений. Профіль —
 * джерело істини між пристроями, localStorage — щоб не блимало.
 *
 * Гість акаунта не має: у нього в localStorage живуть **лише** тема й контраст.
 * Схеми гість не обирає — він бачить схему власника й оформлення списку, і
 * жодного ендпоінта, що писав би вигляд від гостя, не існує.
 *
 * Версія дизайну в профіль не їде і лишається в браузері (ADR-032).
 */

export type Design = 'v1' | 'v2';
export const DESIGNS: readonly Design[] = ['v1', 'v2'];

const THEME_KEY = 'wl.theme';
const SCHEME_KEY = 'wl.scheme';
const CONTRAST_KEY = 'wl.contrast';
const DESIGN_KEY = 'wl.design';

type Value = {
  theme: Theme;
  scheme: Scheme;
  highContrast: boolean;
  /** Система просить посилений контраст — Вугіль увімкнено за неї. */
  systemContrast: boolean;
  design: Design;
  /** Що зараз стоїть на <html>. */
  resolved: Resolved;
  setTheme: (t: Theme) => void;
  setScheme: (s: Scheme) => void;
  /**
   * Вибір схеми людиною в Налаштуваннях. Відрізняється від `setScheme` одним:
   * Ніч — єдина схема, чия типова тема темна. Хто обирає її, не чіпавши тему
   * («як у системі» — усталене), отримує темну; ручний вибір теми потім її
   * перекриває. Профіль, що приїхав із сервера, йде через `setScheme` і тему не
   * рухає.
   */
  chooseScheme: (s: Scheme) => void;
  setHighContrast: (on: boolean) => void;
  setDesign: (d: Design) => void;
  setSurface: (s: Surface) => void;
};

const Ctx = createContext<Value | null>(null);

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
 * Схема й контраст на старті.
 *
 * До ADR-033 Вугіль був четвертою схемою в тому самому переліку, і в сховищі
 * міг лишитися `wl.scheme = vuhil`. Людина, яка його обрала, обирала контраст —
 * тож це стає увімкненим тумблером, а смак повертається до усталеного.
 */
function initialSchemeAndContrast(): { scheme: Scheme; highContrast: boolean } {
  let legacy = false;
  try {
    legacy = localStorage.getItem(SCHEME_KEY) === 'vuhil';
  } catch {
    /* немає сховища — немає й старого значення */
  }
  if (legacy) {
    write(SCHEME_KEY, 'sage');
    write(CONTRAST_KEY, '1');
    return { scheme: 'sage', highContrast: true };
  }
  return {
    scheme: read(SCHEME_KEY, isScheme, 'sage'),
    highContrast: read(CONTRAST_KEY, (v): v is string => v === '1' || v === '0', '0') === '1',
  };
}

/**
 * Версія дизайну на старті: спершу адреса, потім сховище.
 *
 * `?design=v1` — аварійний вихід із v2 (ADR-032). Скрипт у `<head>` прибирає
 * параметр з адреси одразу після читання, тож сюди він доходить лише тоді,
 * коли скрипт не відпрацював.
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

/** Живий медіазапит: значення й підписка на зміну. */
function useMedia(query: string): boolean {
  const get = () => {
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  };
  const [value, setValue] = useState(get);
  useEffect(() => {
    let mq: MediaQueryList;
    try {
      mq = window.matchMedia(query);
    } catch {
      return;
    }
    const onChange = () => setValue(mq.matches);
    onChange();
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [query]);
  return value;
}

/**
 * Ставить атрибути на <html>, накладає або знімає оформлення і підганяє колір
 * системних панелей.
 *
 * Оформлення — це змінні акцентної рампи, пораховані з одного відтінку
 * (lib/hue-ramp.js), а не набір із tokens.css: оформлень може бути скільки
 * завгодно. Ставляться вони інлайном на <html>, тобто поверх
 * `[data-scheme][data-theme]`, і знімаються разом, коли відтінку немає.
 * Змінювати CSS-змінні через CSSOM CSP дозволяє — забороняє лише атрибут
 * `style` у розмітці.
 *
 * Колір панелей не задається тут літералом: він читається з уже застосованої
 * палітри, тож лишається одне джерело значень — tokens.css. Оформлення полотна
 * не чіпає, тому панелі від нього не залежать.
 */
function apply(r: Resolved, design: Design) {
  const root = document.documentElement;
  // Перемикання — без анімації переходу кольорів: інакше кнопки й картки
  // пів секунди перетікали б зі старої палітри в нову. Переходи вимикаються
  // на два кадри, поки браузер перераховує стилі.
  root.classList.add('appearance-switching');
  requestAnimationFrame(() =>
    requestAnimationFrame(() => root.classList.remove('appearance-switching')),
  );
  root.dataset.theme = r.theme;
  root.dataset.scheme = r.scheme;
  root.dataset.design = design;

  if (r.hue === null) {
    delete root.dataset.appearance;
    for (const name of OVERLAY_VARS) root.style.removeProperty(name);
  } else {
    root.dataset.appearance = String(r.hue);
    for (const [name, value] of Object.entries(overlayVars(r.hue, r.theme))) {
      root.style.setProperty(name, value);
    }
  }

  const bg = getComputedStyle(root).getPropertyValue('--color-bg').trim();
  if (!bg) return;
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    m.removeAttribute('media');
    m.setAttribute('content', bg);
  });
}

const OWN: Surface = { kind: 'own' };

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<Theme>(() => read(THEME_KEY, isTheme, 'system'));
  const [start] = useState(initialSchemeAndContrast);
  const [scheme, setSchemeState] = useState<Scheme>(start.scheme);
  const [highContrast, setContrastState] = useState<boolean>(start.highContrast);
  const [design, setDesignState] = useState<Design>(initialDesign);
  const [surface, setSurfaceState] = useState<Surface>(OWN);

  const systemDark = useMedia('(prefers-color-scheme: dark)');
  const systemContrast = useMedia('(prefers-contrast: more)');

  const resolved = useMemo(
    () => resolveAppearance({ theme, scheme, highContrast, systemContrast, systemDark }, surface),
    [theme, scheme, highContrast, systemContrast, systemDark, surface],
  );

  useEffect(() => {
    apply(resolved, design);
  }, [resolved, design]);

  const setTheme = useCallback((t: Theme) => {
    write(THEME_KEY, t);
    setThemeState(t);
  }, []);

  const setScheme = useCallback((s: Scheme) => {
    write(SCHEME_KEY, s);
    setSchemeState(s);
  }, []);

  const chooseScheme = useCallback(
    (s: Scheme) => {
      setScheme(s);
      if (s === 'nich' && theme === 'system') setTheme('dark');
    },
    [setScheme, setTheme, theme],
  );

  const setHighContrast = useCallback((on: boolean) => {
    write(CONTRAST_KEY, on ? '1' : '0');
    setContrastState(on);
  }, []);

  const setDesign = useCallback((d: Design) => {
    write(DESIGN_KEY, d);
    setDesignState(d);
  }, []);

  /** Порівняння за значенням: інакше кожен рендер сторінки давав би новий обʼєкт і цикл. */
  const setSurface = useCallback((s: Surface) => {
    setSurfaceState((prev) => (JSON.stringify(prev) === JSON.stringify(s) ? prev : s));
  }, []);

  const value = useMemo(
    () => ({
      theme,
      scheme,
      highContrast,
      systemContrast,
      design,
      resolved,
      setTheme,
      setScheme,
      chooseScheme,
      setHighContrast,
      setDesign,
      setSurface,
    }),
    [
      theme,
      scheme,
      highContrast,
      systemContrast,
      design,
      resolved,
      setTheme,
      setScheme,
      chooseScheme,
      setHighContrast,
      setDesign,
      setSurface,
    ],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useTheme() {
  const v = useContext(Ctx);
  if (!v) throw new Error('useTheme використано поза ThemeProvider');
  return v;
}

/**
 * Сторінка каже, яка вона поверхня. Поки вона змонтована, діє її поверхня;
 * пішла — застосунок повертається до своїх екранів і своєї схеми.
 *
 * `null` — ще нічого не відомо (гостьова вантажиться): лишається поточний
 * вигляд, щоб не блимнути своєю схемою між двома чужими.
 */
export function useSurface(surface: Surface | null) {
  const { setSurface } = useTheme();
  const key = surface ? JSON.stringify(surface) : null;
  useEffect(() => {
    if (!key) return;
    setSurface(JSON.parse(key) as Surface);
  }, [key, setSurface]);
  useEffect(() => () => setSurface(OWN), [setSurface]);
}

/**
 * Версія дизайну для того, хто вибирає таблицю маршрутів.
 *
 * Окремий хук, а не поле з `useTheme()`, свідомо: так у коді видно кожне
 * місце, яке залежить від версії. Таких місць має бути рівно одне —
 * `designs/DesignRoutes.tsx` (ADR-032).
 */
export function useDesign(): Design {
  return useTheme().design;
}
