/**
 * Черга змін, зроблених без мережі (ROADMAP 6.5, ADR-029).
 *
 * Правило одне: якщо запит не дійшов **через мережу**, зміна лягає в чергу і
 * застосовується на екрані одразу. Якщо сервер відповів і відмовив — черга ні
 * до чого, людина бачить помилку негайно.
 *
 * Черга охоплює лише позиції всередині наявного списку: створення, редагування,
 * зміну статусу й видалення. Створення самого списку, спільні посилання та
 * імпорт офлайн не працюють і чесно про це кажуть — посилання потребує токена
 * від сервера, а решта офлайн трапляється надто рідко, щоб платити за неї
 * складністю злиття (ADR-029).
 *
 * Ідемпотентність — не дрібниця, бо відправка може обірватись після того, як
 * сервер уже застосував зміну:
 * - **створення** йде з `id`, згенерованим на клієнті: повтор впирається в
 *   первинний ключ (`23505`) і вважається успіхом;
 * - **зміна** й **зміна статусу** — за `id`, тож повтор просто записує те саме;
 * - **видалення** — за `id`; нуль видалених рядків означає «уже немає».
 *
 * Конфлікти вирішуються останнім записом: черга відправляється в тому порядку,
 * у якому людина робила зміни, і перезаписує те, що на сервері.
 */
import { OUTBOX, openDb, req, txDone } from './idb';
import { createItem, deleteItems, setItemsStatus, updateItem } from './db';
import { isNetworkError } from './errors';
import { itemsKey, patchSnapshot } from './cache';
import type { ItemsSnapshot } from './cache';
import { applyToItems } from './outboxOps';
export type { Op } from './outboxOps';
export { applyToItems, newId } from './outboxOps';
import type { Op } from './outboxOps';

export type Entry = { seq: number; userId: string; queuedAt: string; op: Op };

/** Зміна, яку сервер відхилив: у черзі їй не місце, але людина має знати. */
export type Dropped = { op: Op; message: string };

/* ── Сховище ────────────────────────────── */

const listeners = new Set<() => void>();

/** Підписка для інтерфейсу: скільки змін чекає на мережу. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function notify(): void {
  for (const fn of listeners) fn();
}

export async function enqueue(userId: string, op: Op): Promise<void> {
  if (!userId) return;
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(OUTBOX, 'readwrite');
    tx.objectStore(OUTBOX).add({ userId, queuedAt: new Date().toISOString(), op });
    await txDone(tx);
    // Знімок підправляємо, щоб зміна пережила перезавантаження сторінки.
    await patchSnapshot<ItemsSnapshot>(itemsKey(op.listId), userId, (snap) => ({
      ...snap,
      items: applyToItems(snap.items, op),
    }));
  } catch {
    // Сховище недоступне: зміна втрачена, і викликач уже показав помилку.
  } finally {
    db.close();
    notify();
  }
}

export async function pending(userId: string): Promise<Entry[]> {
  if (!userId) return [];
  const db = await openDb();
  if (!db) return [];
  try {
    const tx = db.transaction(OUTBOX, 'readonly');
    const all = ((await req(tx.objectStore(OUTBOX).getAll())) ?? []) as Entry[];
    return all.filter((e) => e.userId === userId);
  } catch {
    return [];
  } finally {
    db.close();
  }
}

export async function pendingCount(userId: string): Promise<number> {
  return (await pending(userId)).length;
}

async function remove(seq: number): Promise<void> {
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(OUTBOX, 'readwrite');
    tx.objectStore(OUTBOX).delete(seq);
    await txDone(tx);
  } catch {
    // Наступна відправка спробує ще раз — операції ідемпотентні.
  } finally {
    db.close();
  }
}

/* ── Відправлення ───────────────────────── */

/** Помилка первинного ключа: позиція вже створена попередньою спробою. */
function alreadyApplied(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === '23505';
}

async function send(op: Op): Promise<void> {
  switch (op.kind) {
    case 'create':
      try {
        await createItem(op.listId, op.input, op.id);
      } catch (e) {
        if (!alreadyApplied(e)) throw e;
      }
      return;
    case 'update':
      await updateItem(op.id, op.input);
      return;
    case 'status':
      await setItemsStatus(op.ids, op.status);
      return;
    case 'delete':
      await deleteItems(op.ids);
      return;
  }
}

let flushing = false;

/**
 * Відправляє чергу по порядку.
 *
 * Мережевий збій зупиняє відправку: решта змін лишається чекати, а порядок не
 * ламається. Відмова сервера (валідація, права, видалений список) не зникне
 * від повторів — така зміна викидається з черги й повертається викликачеві,
 * щоб той сказав про це людині.
 */
export async function flush(userId: string): Promise<{ sent: number; dropped: Dropped[] }> {
  const result = { sent: 0, dropped: [] as Dropped[] };
  if (!userId || flushing) return result;
  flushing = true;
  try {
    for (const entry of await pending(userId)) {
      try {
        await send(entry.op);
        await remove(entry.seq);
        result.sent += 1;
      } catch (e) {
        if (isNetworkError(e)) break;
        await remove(entry.seq);
        result.dropped.push({ op: entry.op, message: messageOf(e) });
      }
    }
  } finally {
    flushing = false;
    notify();
  }
  return result;
}

function messageOf(e: unknown): string {
  if (e && typeof e === 'object' && 'message' in e) {
    const m = (e as { message: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return '';
}

/* ── Точка входу для змін ───────────────── */

/**
 * Виконує зміну: мережею, а якщо мережі немає — у чергу.
 *
 * Повертає `'queued'`, коли зміна чекає на мережу, — щоб сторінка застосувала
 * її до себе сама й не намагалась перечитати дані з сервера.
 */
export async function run(userId: string, op: Op): Promise<'sent' | 'queued'> {
  try {
    await send(op);
    return 'sent';
  } catch (e) {
    if (!isNetworkError(e) || !userId) throw e;
    await enqueue(userId, op);
    return 'queued';
  }
}
