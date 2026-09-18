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
import type { Item, Totals } from './types';

const DB_NAME = 'wishlist';
const DB_VERSION = 1;
const STORE = 'snapshots';

export type Snapshot<T> = { data: T; savedAt: string };

type Record_<T> = { key: string; userId: string; savedAt: string; data: T };

/** Знімок сторінки списків. */
export const LISTS_KEY = 'lists';
/** Назва, валюта й дата події одного списку. */
export const listKey = (listId: string) => `list:${listId}`;
/** Перша партія позицій списку з підсумками — лише для запиту без фільтрів. */
export const itemsKey = (listId: string) => `items:${listId}`;

export type ItemsSnapshot = { items: Item[]; totals: Totals | null };

function open(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    // Інша вкладка тримає стару версію — без кешу, але без зависання.
    req.onblocked = () => resolve(null);
  });
}

function done(tx: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

export async function saveSnapshot<T>(key: string, userId: string, data: T): Promise<void> {
  if (!userId) return;
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    const record: Record_<T> = { key, userId, savedAt: new Date().toISOString(), data };
    tx.objectStore(STORE).put(record);
    await done(tx);
  } catch {
    // Квота вичерпана або сховище заборонене — кеш просто не працює.
  } finally {
    db.close();
  }
}

export async function readSnapshot<T>(key: string, userId: string): Promise<Snapshot<T> | null> {
  if (!userId) return null;
  const db = await open();
  if (!db) return null;
  try {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    const record = await new Promise<Record_<T> | undefined>((resolve) => {
      req.onsuccess = () => resolve(req.result as Record_<T> | undefined);
      req.onerror = () => resolve(undefined);
    });
    // Чужий знімок не показуємо навіть на мить.
    if (!record || record.userId !== userId) return null;
    return { data: record.data, savedAt: record.savedAt };
  } catch {
    return null;
  } finally {
    db.close();
  }
}

/** Стирає кеш цілком. Викликається при виході з акаунта. */
export async function clearCache(): Promise<void> {
  const db = await open();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).clear();
    await done(tx);
  } catch {
    // Немає чого стирати.
  } finally {
    db.close();
  }
}
