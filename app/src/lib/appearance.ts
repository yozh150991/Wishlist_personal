/**
 * Правило вирішення вигляду — одне на весь застосунок (дизайн, файл 08).
 *
 * Два шари, які не змішуються:
 *  1. **схема глядача** — смак, п'ять варіантів, живе в профілі власника;
 *  2. **оформлення списку** — відтінок події, його задає власник у списку.
 *
 * Порядок — перший спрацьований виграє:
 *  1. Доступність. Висока контрастність у глядача (власника **або** гостя) чи
 *     системне `prefers-contrast: more` → Вугіль, оверлей не застосовується
 *     взагалі. Контраст — не питання смаку, і чужа людина його не вирішує.
 *  2. Свої екрани — своя схема. Власник бачить застосунок у схемі з профілю,
 *     оверлей на власні екрани не лізе. Виняток один — «Показати, як бачить
 *     гість».
 *  3. Гість — схема власника + оверлей списку, якщо власник його обрав.
 *  4. Тема — завжди від пристрою глядача, у будь-якій ролі. Схема каже, *які*
 *     кольори, тема — *наскільки темні*.
 *
 * Викликається рівно в одному місці — `ThemeProvider` (lib/theme.tsx), який
 * пише результат у `data-scheme` / `data-theme` / `data-appearance` на <html>.
 * Жоден компонент не читає ці атрибути й не звіряє імені схеми.
 */

export type Theme = 'light' | 'dark' | 'system';

/** Схеми смаку. Вугля тут немає: у нього один вхід — тумблер доступності. */
export type Scheme = 'sage' | 'slyva' | 'polotno' | 'cytrus' | 'nich';

/** Те, що реально стоїть у `data-scheme`. */
export type ResolvedScheme = Scheme | 'vuhil';

export const SCHEMES: readonly Scheme[] = ['sage', 'slyva', 'polotno', 'cytrus', 'nich'];
export const THEMES: readonly Theme[] = ['light', 'dark', 'system'];

export function isScheme(v: unknown): v is Scheme {
  return typeof v === 'string' && (SCHEMES as readonly string[]).includes(v);
}

export function isTheme(v: unknown): v is Theme {
  return v === 'light' || v === 'dark' || v === 'system';
}

/** Що знає про себе глядач — на цьому пристрої. */
export type Viewer = {
  theme: Theme;
  /** Власний вибір: тумблер «Висока контрастність». */
  highContrast: boolean;
  /** Система просить посилений контраст (`prefers-contrast: more`). */
  systemContrast: boolean;
  /** Система в темному режимі — для теми «як у системі». */
  systemDark: boolean;
  /** Схема з профілю власника або з його браузера. */
  scheme: Scheme;
};

/**
 * На якій поверхні глядач зараз.
 *
 * `own`     — свої екрани: списки, налаштування, діалоги.
 * `guest`   — гостьова сторінка чужого списку: схема власника + оформлення.
 * `preview` — «Показати, як бачить гість» і власник на власному посиланні:
 *             своя схема (він і є власник) + оформлення списку.
 */
export type Surface =
  | { kind: 'own' }
  | { kind: 'guest'; ownerScheme: Scheme; hue: number | null }
  | { kind: 'preview'; hue: number | null };

export type Resolved = {
  scheme: ResolvedScheme;
  theme: 'light' | 'dark';
  /** Відтінок оформлення або null — без оверлею. */
  hue: number | null;
  /** 'a11y' — схему зафіксувала доступність; решта шарів не діє. */
  locked: 'a11y' | null;
};

export function resolveAppearance(viewer: Viewer, surface: Surface): Resolved {
  // Правило 4 — тема завжди глядача.
  const theme =
    viewer.theme === 'system' ? (viewer.systemDark ? 'dark' : 'light') : viewer.theme;

  // Правило 1 — доступність перемагає все, що нижче.
  if (viewer.highContrast || viewer.systemContrast) {
    return { scheme: 'vuhil', theme, hue: null, locked: 'a11y' };
  }

  switch (surface.kind) {
    // Правило 2 — свої екрани, своя схема, без оверлею.
    case 'own':
      return { scheme: viewer.scheme, theme, hue: null, locked: null };
    // Виняток із правила 2: превʼю гостьової показує справжнє оформлення.
    case 'preview':
      return { scheme: viewer.scheme, theme, hue: surface.hue, locked: null };
    // Правило 3 — гість бачить схему власника й оформлення списку.
    case 'guest':
      return { scheme: surface.ownerScheme, theme, hue: surface.hue, locked: null };
  }
}
