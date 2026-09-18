/**
 * Останній бачений стан списків у IndexedDB (ROADMAP 6.4).
 *
 * Мета вузька: показати щось осмислене, коли мережі немає. Це **не**
 * синхронізація і не джерело правди — щойно мережа є, дані беруться з бази, а
 * знімок просто перезаписується.
 *
 * Що сюди НЕ потрапляє:
 * - **токени спільних посилань і сторінка `/shares`** — токен у кеші пристрою
 *   порушив би CLAUDE.md §3.5 так само, як токен у кеші Service Worker;
 * - **броні** — власник їх не бачить ніде (§3.2);
 * - **вибірки з пошуком чи фільтрами** — інакше офлайн людина побачила б
 *   частину списку, не знаючи, що це частина.
 *
 * Кожен запис підписаний `userId`. Читання під іншим акаунтом промахується, а
 * вихід із застосунку стирає базу цілком: на спільному компʼютері чужі списки
 * не мають лишатися навіть на мить.
 *
 * Будь-який збій IndexedDB (приватний режим, заборонене сховище, перевищена
 * квота) не вважається помилкою застосунку: кеш просто не працює.
 */
import { OUTBOX, SNAPSHOTS, openDb, req, txDone } from './idb';
import type { Item, Totals } from './types';

export type Snapshot<T> = { data: T; savedAt: string };

type Record_<T> = { key: string; userId: string; savedAt: string; data: T };

/** Знімок сторінки списків. */
export const LISTS_KEY = 'lists';
/** Назва, валюта й дата події одного списку. */
export const listKey = (listId: string) => `list:${listId}`;
/** Перша партія позицій списку з підсумками — лише для запиту без фільтрів. */
export const itemsKey = (listId: string) => `items:${listId}`;

export type ItemsSnapshot = { items: Item[]; totals: Totals | null };

export async function saveSnapshot<T>(key: string, userId: string, data: T): Promise<void> {
  if (!userId) return;
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(SNAPSHOTS, 'readwrite');
    const record: Record_<T> = { key, userId, savedAt: new Date().toISOString(), data };
    tx.objectStore(SNAPSHOTS).put(record);
    await txDone(tx);
  } catch {
    // Квота вичерпана або сховище заборонене — кеш просто не працює.
  } finally {
    db.close();
  }
}

export async function readSnapshot<T>(key: string, userId: string): Promise<Snapshot<T> | null> {
  if (!userId) return null;
  const db = await openDb();
  if (!db) return null;
  try {
    const tx = db.transaction(SNAPSHOTS, 'readonly');
    const record = (await req(tx.objectStore(SNAPSHOTS).get(key))) as Record_<T> | undefined;
    // Чужий знімок не показуємо навіть на мить.
    if (!record || record.userId !== userId) return null;
    return { data: record.data, savedAt: record.savedAt };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/**
 * Змінює збережений знімок на місці, не чіпаючи час збереження.
 *
 * Потрібно черзі змін (етап 6.5): позначку «подаровано», зроблену офлайн, має
 * бути видно й після перезавантаження сторінки, поки мережі все ще немає.
 * Час збереження лишається старим навмисне — дані в знімку й далі з тієї
 * самої давньої вибірки, підправлено лише те, що людина щойно зробила.
 */
export async function patchSnapshot<T>(
  key: string,
  userId: string,
  change: (data: T) => T,
): Promise<void> {
  if (!userId) return;
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(SNAPSHOTS, 'readwrite');
    const store = tx.objectStore(SNAPSHOTS);
    const record = (await req(store.get(key))) as Record_<T> | undefined;
    if (record && record.userId === userId) {
      store.put({ ...record, data: change(record.data) });
    }
    await txDone(tx);
  } catch {
    // Немає знімка або сховище недоступне — нічого підправляти.
  } finally {
    db.close();
  }
}

/**
 * Стирає кеш і чергу цілком. Викликається при виході з акаунта.
 *
 * Черга йде разом із кешем навмисне: у ній лежать назви позицій, тобто ті самі
 * особисті дані. Незакінчену чергу застосунок не викидає мовчки — перед
 * виходом він попереджає, що зміни ще не відправлені (ADR-029).
 */
export async function clearCache(): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction([SNAPSHOTS, OUTBOX], 'readwrite');
    tx.objectStore(SNAPSHOTS).clear();
    tx.objectStore(OUTBOX).clear();
    await txDone(tx);
  } catch {
    // Немає чого стирати.
  } finally {
    db.close();
  }
}
