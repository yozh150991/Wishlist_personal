import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';

export const LOCALES = ['uk', 'pl', 'en'] as const;
export type Locale = (typeof LOCALES)[number];

type Dict = Record<string, unknown>;

/**
 * Словник — лише активної мови (ROADMAP 8.24). Кожна мова — свій чанк
 * `locale-<мова>-*.js` (`manualChunks` у `vite.config.ts`): раніше всі три
 * (193 КБ, 61 КБ у gzip) лежали в головному пакеті, хоча людині потрібна одна.
 * Шляхи записано явно, а не шаблоном: так Vite бачить рівно три чанки.
 *
 * Без мережі перемикання працює з кешу Service Worker: чанки словників
 * лежать у precache разом з рештою оболонки (`globPatterns`), це стереже
 * `npm run check:pwa`. Гість Service Worker не має (ADR-084) — йому чанк,
 * качнутий раз, віддає кеш браузера (`/assets/*` — `immutable`).
 */
const LOADERS: Record<Locale, () => Promise<{ default: Dict }>> = {
  uk: () => import('../i18n/uk.json'),
  pl: () => import('../i18n/pl.json'),
  en: () => import('../i18n/en.json'),
};

const KEY = 'wl.locale';

/** Словники, що вже приїхали, — на все життя вкладки. */
const loaded = new Map<Locale, Dict>();
/** Запити, що ще в дорозі: подвійний натиск не качає мову двічі. */
const inflight = new Map<Locale, Promise<Dict>>();
/** Мова, з якою стартує перший рендер (`prepareI18n`). */
let initial: Locale | null = null;

const isLocale = (v: unknown): v is Locale => typeof v === 'string' && (LOCALES as readonly string[]).includes(v);

function detect(): Locale {
  const saved = localStorage.getItem(KEY);
  if (isLocale(saved)) return saved;
  for (const lang of navigator.languages ?? []) {
    const short = lang.slice(0, 2);
    if (isLocale(short)) return short;
  }
  return 'uk';
}

/** Завантажує словник мови; невдалий запит забувається, тож наступна спроба піде в мережу знову. */
function loadDictionary(locale: Locale): Promise<Dict> {
  const ready = loaded.get(locale);
  if (ready) return Promise.resolve(ready);
  let pending = inflight.get(locale);
  if (!pending) {
    pending = LOADERS[locale]()
      .then((m) => {
        loaded.set(locale, m.default);
        return m.default;
      })
      .finally(() => inflight.delete(locale));
    inflight.set(locale, pending);
  }
  return pending;
}

/**
 * Словник до першого рендера: `main.tsx` чекає на нього, перш ніж малювати.
 *
 * Поки він їде, на екрані те саме, що й під час будь-якого завантаження
 * застосунку, — порожній фон теми (`body` і `.v2-boot` мають однаковий
 * `--color-bg`, тему ставить скрипт в `index.html`). Тож ні ключів, ні
 * тексту чужою мовою, який за мить зміниться. Запит стартує, щойно виконався
 * вхідний файл; лінивий чанк гостьової `main.tsx` просить паралельно, тож
 * гостьова чекає на довший із двох, а не на обидва поспіль.
 *
 * Не приїхала визначена мова — пробуємо решту (українську першою): краще
 * інтерфейс іншою мовою, ніж порожній екран. Не приїхала жодна — рендер
 * однаково відбудеться, з ключами замість тексту (запасний `t`).
 */
export async function prepareI18n(): Promise<void> {
  const first = detect();
  const order = [first, ...(['uk', 'en', 'pl'] as const).filter((l) => l !== first)];
  for (const locale of order) {
    try {
      await loadDictionary(locale);
      initial = locale;
      return;
    } catch (e) {
      console.warn('[i18n] словник не завантажився:', locale, e instanceof Error ? e.message : String(e));
    }
  }
}

/** Дістає значення за ключем виду 'auth.login.title'. */
function lookup(dict: Dict | undefined, path: string): string | undefined {
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

type State = { locale: Locale; dict: Dict | null };

function initialState(): State {
  const locale = initial ?? detect();
  return { locale, dict: loaded.get(locale) ?? null };
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<State>(initialState);
  const { locale, dict } = state;
  /** Остання мова, яку попросили: з двох швидких перемикань перемагає друге. */
  const wanted = useRef<Locale>(locale);

  // Запобіжник на випадок рендера без `prepareI18n` (або коли не приїхала
  // жодна мова): довантажити й лише тоді показати дерево.
  useEffect(() => {
    if (dict) return;
    let live = true;
    loadDictionary(locale).then(
      (d) => live && setState((s) => (s.locale === locale ? { locale, dict: d } : s)),
      () => live && setState((s) => (s.dict ? s : { ...s, dict: {} })),
    );
    return () => {
      live = false;
    };
  }, [locale, dict]);

  // Мова міняється, коли її словник уже тут: до того екран лишається
  // попередньою мовою — без ключів і без порожнього кадру. Без мережі й без
  // кешу словник не приїде, і мова лишиться попередньою (перемикач повернеться
  // до неї). Вибір запамʼятовується лише тоді, коли мова справді ввімкнулась:
  // інакше наступне відкриття почалося б зі словника, якого немає.
  const setLocale = useCallback((l: Locale) => {
    wanted.current = l;
    loadDictionary(l).then(
      (d) => {
        if (wanted.current !== l) return;
        localStorage.setItem(KEY, l);
        setState({ locale: l, dict: d });
      },
      (e: unknown) => {
        console.warn('[i18n] словник не завантажився:', l, e instanceof Error ? e.message : String(e));
      },
    );
  }, []);

  // `<html lang>` — завжди активна мова, звідки б вона не взялась: мова
  // браузера при першому відкритті, збережений вибір, перемикач у
  // Налаштуваннях, на вході чи в підвалі гостьової. Раніше атрибут ставив лише
  // ручний вибір, і польський інтерфейс зчитувач екрана читав українським
  // голосом (аудит A-6). Єдине місце, де він пишеться: `index.html` має
  // статичне `lang="uk"` до першого рендера, інлайновий скрипт CSP не пускає.
  useEffect(() => {
    document.documentElement.lang = locale;
  }, [locale]);

  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      // Запасна — українська, але лише якщо її словник уже в памʼяті (людина
      // перемкнулась з неї): тягнути 91 КБ заради запасу не варто, бо
      // `npm run check:i18n` гарантує однаковий набір ключів у трьох мовах.
      // Інакше — сам ключ: краще технічний ключ, ніж порожнє місце.
      const raw = lookup(dict ?? undefined, key) ?? lookup(loaded.get('uk'), key) ?? key;
      if (!vars) return raw;
      return raw.replace(/\{(\w+)\}/g, (m, name: string) => String(vars[name] ?? m));
    },
    [dict],
  );

  const value = useMemo(() => ({ locale, setLocale, t }), [locale, setLocale, t]);
  // Поки словника немає — нічого: фон теми, як і до першого рендера.
  if (!dict) return null;
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18n {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n використано поза I18nProvider');
  return v;
}
