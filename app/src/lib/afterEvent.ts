/**
 * «Після події», «Ще хочу» й «Повторити на наступний рік» (потоки M, S3, U;
 * ADR-045) — правила без мережі й React, тож перевіряються тестами без
 * браузера (`tests/e2e/after-event.spec.ts`).
 *
 * Жодне правило тут не знає про позначки гостей і не може знати (ADR-040):
 * «не розібрано» й «неподароване» — це статуси самого власника.
 */
import type { Item, ItemInput, List } from './types';

/** «Пізніше» ховає картку «Свято минуло» на три дні (M1). */
export const SNOOZE_DAYS = 3;

/**
 * Відкладена картка: для якої дати події, до якого дня й удруге чи вперше.
 * Дата потрібна, щоб перенесене свято почало все спочатку — як у v1
 * (`EventSummary`).
 */
export type Snooze = { date: string; until: string; count: number };

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** Календарний день `YYYY-MM-DD` плюс `n` днів — без годинника й поясів. */
export function addDays(day: string, n: number): string {
  const [y, m, d] = day.slice(0, 10).split('-').map(Number);
  const dt = new Date(Date.UTC(y!, m! - 1, d! + n));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** Та сама дата наступного року; 29 лютого стає 28-м. */
export function nextYear(day: string): string {
  const [y, m, d] = day.slice(0, 10).split('-').map(Number);
  const year = y! + 1;
  const last = new Date(Date.UTC(year, m!, 0)).getUTCDate();
  return `${year}-${pad(m!)}-${pad(Math.min(d!, last))}`;
}

/** Рік події або `null`, якщо дати немає. */
export function eventYear(list: Pick<List, 'event_date'>): number | null {
  const m = /^(\d{4})-/.exec(list.event_date ?? '');
  return m ? Number(m[1]) : null;
}

/** День події вже позаду за годинником власника (сьогодні — `localToday()`). */
export function isPastEvent(list: Pick<List, 'event_date'>, today: string): boolean {
  return Boolean(list.event_date) && list.event_date!.slice(0, 10) < today;
}

/**
 * Чи показувати картку «Свято минуло» (M1): наступного дня після події, поки
 * список не в архіві. «Пізніше» ховає її на три дні, потім вона повертається
 * один раз; друге «Пізніше» — назовсім, і лишається тихий рядок «не розібрано»
 * на головній. Перенесли дату — відлік спочатку.
 */
export function afterEventDue(
  list: Pick<List, 'event_date' | 'is_archived'>,
  today: string,
  snooze: Snooze | null,
): boolean {
  if (list.is_archived || !isPastEvent(list, today)) return false;
  if (!snooze || snooze.date !== list.event_date!.slice(0, 10)) return true;
  if (snooze.count >= 2) return false;
  return today >= snooze.until;
}

/** Наступне «Пізніше» для цієї дати події. */
export function snoozeNext(prev: Snooze | null, eventDate: string, today: string): Snooze {
  const date = eventDate.slice(0, 10);
  const count = prev && prev.date === date ? prev.count + 1 : 1;
  return { date, until: addDays(today, SNOOZE_DAYS), count };
}

/**
 * Назва на наступний рік: рік події, якщо він є в назві окремим числом,
 * посувається («Новий рік 2026» → «Новий рік 2027»). Решта назви — як була.
 */
export function repeatTitle(title: string, fromYear: number | null): string {
  if (fromYear === null) return title;
  return title.replace(new RegExp(`(^|\\D)${fromYear}(?!\\d)`, 'g'), (_m, pre: string) => `${pre}${fromYear + 1}`);
}

/**
 * Копія позиції для іншого списку: те, що людина хоче, — без статусу, бо це
 * знову бажання, і без позначок, які живуть окремо й не копіюються ніколи.
 * Розділ і місце — лише якщо їх передано (повтор списку переносить розділи).
 */
export function copyInput(
  item: Item,
  place: { section_id: string | null; position: number | null } = {
    section_id: null,
    position: null,
  },
): ItemInput {
  return {
    title: item.title,
    url: item.url,
    price: item.price,
    quantity: item.quantity,
    priority: item.priority,
    note: item.note,
    variants: item.variants,
    image_url: item.image_url,
    status: 'active',
    section_id: place.section_id,
    position: place.position,
  };
}

/** Що ще не розібрано: актуальні позиції — лише їх пропонуємо перенести (M4, S3). */
export function openItems(items: Item[]): Item[] {
  return items.filter((i) => i.status === 'active');
}

/* ── «Пізніше» на цьому пристрої ─────────── */

/** Id списку — не таємниця; позначок тут немає й бути не може. */
const snoozeKey = (listId: string) => `wl.v2.afterEvent.${listId}`;

export function readSnooze(listId: string): Snooze | null {
  try {
    const raw = localStorage.getItem(snoozeKey(listId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<Snooze>;
    if (typeof v.date !== 'string' || typeof v.until !== 'string' || typeof v.count !== 'number') return null;
    return { date: v.date, until: v.until, count: v.count };
  } catch {
    return null;
  }
}

export function writeSnooze(listId: string, snooze: Snooze) {
  try {
    localStorage.setItem(snoozeKey(listId), JSON.stringify(snooze));
  } catch {
    /* приватний режим — картка просто повернеться наступного разу */
  }
}
