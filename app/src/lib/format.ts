import type { Currency } from './types';

/** PostgREST може віддати numeric і числом, і рядком — нормалізуємо в одному місці. */
export function num(value: number | string | null | undefined): number | null {
  if (value === null || value === undefined || value === '') return null;
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n : null;
}

export function money(
  value: number | string | null | undefined,
  currency: Currency,
  locale: string,
): string | null {
  const n = num(value);
  if (n === null) return null;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency,
    maximumFractionDigits: 2,
  }).format(n);
}

export function formatDate(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(new Date(iso));
}

/**
 * Календарний день словом: «14 червня», а якщо рік не поточний — «14 червня
 * 2027 р.». Числовий формат читається протилежно в en-US і uk-UA.
 *
 * Дата без часу (`YYYY-MM-DD`) розбирається як місцевий день, а не як північ
 * UTC: інакше в Америці 14 червня показувалось би як 13-те.
 */
export function formatDay(isoDate: string | null, locale: string): string | null {
  if (!isoDate) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(isoDate);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'long',
    ...(sameYear ? {} : { year: 'numeric' }),
  }).format(d);
}

/** Дата з часом — для позначки «коли це збережено». */
export function formatDateTime(iso: string | null, locale: string): string | null {
  if (!iso) return null;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'short', timeStyle: 'short' }).format(
    new Date(iso),
  );
}

/** Домен без www — показуємо на картці замість довгого URL. */
export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

/**
 * Поріг ціни «до …» для гостя — з даних, а не фіксований (ADR-036): на
 * списку з цінами 2–20 тис. «до 500» марне. Терцилі цін, округлені вгору до
 * «круглого» числа, щоб на кнопці стояло «до 500», а не «до 487,35».
 */
export function priceThresholds(prices: number[]): number[] {
  const sorted = prices.filter((p) => Number.isFinite(p) && p > 0).sort((a, b) => a - b);
  if (sorted.length < 6) return [];
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!;
  const out: number[] = [];
  for (const q of [1 / 3, 2 / 3]) {
    const v = niceCeil(at(q));
    // Поріг, під який не підпадає нічого або підпадає все, — не поріг.
    if (v >= sorted[sorted.length - 1]!) continue;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

function niceCeil(x: number): number {
  const p = 10 ** Math.floor(Math.log10(x));
  for (const f of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10]) {
    if (f * p >= x) return Math.round(f * p * 100) / 100;
  }
  return 10 * p;
}
