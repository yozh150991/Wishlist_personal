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
