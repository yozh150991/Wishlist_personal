/**
 * Історія ціни й своя ціль (ROADMAP 8.16) — чисті правила без мережі, React
 * і DOM, тож перевіряються тестами без браузера (`tests/e2e/price-history.spec.ts`).
 * Запит точок — `fetchItemPrices` у `lib/db.ts`.
 *
 * Точки пише лише сервіс wishlist-jobs: одна на позицію на день, ціна, яку
 * щоденна перевірка посилання побачила на сторінці, що є (`ok`). Валюти не
 * конвертуються (ADR-051): точки іншої валюти не змішуються з валютою
 * позиції, а лише називаються окремо. Гроші — у мінорних одиницях.
 */
import { itemCurrency, parsePrice, toMinor } from './itemsView';
import type { Currency, Item, ItemPrice } from './types';

/** Скільки днів показує позиція: «найнижча за 30 днів». */
export const HISTORY_DAYS = 30;

export type PricePoint = {
  day: string;
  minor: number;
  /** Коли перевірка бачила цю ціну — для «перевірено 3 грудня». */
  checkedAt: string;
};

export type HistorySummary = {
  /** Точки у валюті позиції, від старішої до новішої. */
  points: PricePoint[];
  /** Остання точка — що перевірка бачила востаннє. */
  current: PricePoint | null;
  /** Найнижча за вікно; з однакових — найсвіжіша. */
  min: PricePoint | null;
  max: PricePoint | null;
  /** Інші валюти, що трапились у вікні, — їх не порівнюємо. */
  others: string[];
};

/** День `YYYY-MM-DD` на `days` днів раніше (UTC, як і день точки). */
export function dayBefore(today: string, days: number): string {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Сьогодні в UTC — саме так сервіс рахує день точки. */
export function utcToday(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** Перший день вікна: сьогодні й ще `days − 1` днів назад. */
export function windowStart(today: string, days: number = HISTORY_DAYS): string {
  return dayBefore(today, days - 1);
}

export function summarizeHistory(
  rows: ItemPrice[],
  currency: Currency,
  today: string,
  days: number = HISTORY_DAYS,
): HistorySummary {
  const from = windowStart(today, days);
  const points: PricePoint[] = [];
  const others = new Set<string>();
  for (const row of rows) {
    if (row.day < from || row.day > today) continue;
    const minor = toMinor(row.price);
    if (minor === null || minor <= 0) continue;
    // Валюти магазин не сказав — це валюта позиції (як `linkPriceChange`).
    if (row.currency && row.currency !== currency) {
      others.add(row.currency);
      continue;
    }
    points.push({ day: row.day, minor, checkedAt: row.checked_at });
  }
  points.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
  let min: PricePoint | null = null;
  let max: PricePoint | null = null;
  for (const p of points) {
    if (!min || p.minor <= min.minor) min = p;
    if (!max || p.minor > max.minor) max = p;
  }
  return { points, current: points[points.length - 1] ?? null, min, max, others: [...others].sort() };
}

/**
 * Лінія для маленького графіка (SVG `points`): x — день у вікні, y — ціна,
 * вище — дорожче. Одна точка — посередині висоти. Без точок — порожньо.
 */
export function sparkline(
  points: PricePoint[],
  today: string,
  width: number,
  height: number,
  days: number = HISTORY_DAYS,
): string {
  if (points.length === 0) return '';
  const from = new Date(`${windowStart(today, days)}T00:00:00Z`).getTime();
  const span = Math.max(1, days - 1);
  const lo = Math.min(...points.map((p) => p.minor));
  const hi = Math.max(...points.map((p) => p.minor));
  const pad = 2;
  return points
    .map((p) => {
      const offset = (new Date(`${p.day}T00:00:00Z`).getTime() - from) / 86_400_000;
      const x = pad + (offset / span) * (width - 2 * pad);
      const y = hi === lo ? height / 2 : pad + ((hi - p.minor) / (hi - lo)) * (height - 2 * pad);
      return `${round(x)},${round(y)}`;
    })
    .join(' ');
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/* ── Ціль ─────────────────────────────────────────────────── */

export type TargetParse = { value: number | null; error: 'format' | 'tooBig' | 'zero' | null };

/**
 * Поле «Повідомити, коли ціна ≤». Порожньо — без цілі. Межі — як у бази:
 * `items_price_target_check` (> 0) і `numeric(12,2)` (CLAUDE.md §4).
 */
export function parseTarget(input: string): TargetParse {
  const p = parsePrice(input);
  if (p.error) return { value: null, error: p.error };
  if (p.value === null) return { value: null, error: null };
  if (toMinor(p.value) === 0) return { value: null, error: 'zero' };
  return p;
}

/**
 * Ціна в магазині зараз не вища за ціль — мітка на картці й рядок у формі.
 * Лише для актуальної позиції, коли сторінка є, і в тій самій валюті.
 */
export function targetReached(
  item: Pick<Item, 'status' | 'link_status' | 'link_price' | 'link_currency' | 'price_target' | 'currency'>,
  listCurrency: Currency,
): boolean {
  if (item.status !== 'active' || item.link_status !== 'ok') return false;
  const target = toMinor(item.price_target);
  const shop = toMinor(item.link_price);
  if (!target || !shop) return false;
  if (item.link_currency && item.link_currency !== itemCurrency(item, listCurrency)) return false;
  return shop <= target;
}
