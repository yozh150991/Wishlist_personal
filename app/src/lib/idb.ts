/**
 * Спільне зʼєднання з IndexedDB для офлайн-кешу (`cache.ts`) і черги змін
 * (`outbox.ts`).
 *
 * Обидва сховища живуть в одній базі навмисне: версія бази одна, тож
 * оновлення схеми відбувається за один `onupgradeneeded`. Якби кожен модуль
 * відкривав власну базу, друге відкриття чекало б на перше, і на слабкому
 * пристрої це давало б `onblocked` на рівному місці.
 *
 * Будь-який збій сховища (приватний режим, заборонений доступ, вичерпана
 * квота) не є помилкою застосунку: офлайн-можливості просто вимикаються.
 * Тому `open` повертає `null` замість того, щоб кидати виняток.
 */
const DB_NAME = 'wishlist';

/**
 * 1 — сховище `snapshots` (етап 6.4).
 * 2 — додано `outbox` (етап 6.5).
 */
const DB_VERSION = 2;

export const SNAPSHOTS = 'snapshots';
export const OUTBOX = 'outbox';

export function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SNAPSHOTS)) {
        db.createObjectStore(SNAPSHOTS, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(OUTBOX)) {
        // autoIncrement: порядок ключів — це порядок, у якому людина робила
        // зміни, і саме в ньому їх треба відправляти.
        db.createObjectStore(OUTBOX, { keyPath: 'seq', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
    // Інша вкладка тримає стару версію: без офлайну, але без зависання.
    req.onblocked = () => resolve(null);
  });
}

export function txDone(tx: IDBTransaction): Promise<boolean> {
  return new Promise((resolve) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => resolve(false);
    tx.onabort = () => resolve(false);
  });
}

/** `IDBRequest` як проміс, який ніколи не відхиляється. */
export function req<T>(request: IDBRequest<T>): Promise<T | undefined> {
  return new Promise((resolve) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(undefined);
  });
}
