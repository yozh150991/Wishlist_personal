/**
 * Операції черги змін і те, як вони лягають на список позицій (ROADMAP 6.5).
 *
 * Свідомо без мережі, IndexedDB і React: та сама функція міняє і те, що на
 * екрані, і знімок у кеші, а перевірити її можна тестами без браузера
 * (tests/e2e/outbox.spec.ts). Усе, що вміє відправляти й зберігати, — в
 * `outbox.ts`, і воно імпортує цей файл, а не навпаки.
 */
import type { Item, ItemInput, ItemStatus } from './types';

export type Op =
  | { kind: 'create'; listId: string; id: string; input: ItemInput }
  | { kind: 'update'; listId: string; id: string; input: ItemInput }
  | { kind: 'status'; listId: string; ids: string[]; status: ItemStatus }
  | { kind: 'delete'; listId: string; ids: string[] };

/* ── Застосування до списку позицій ─────── */

/**
 * Чиста функція: як виглядатиме список після цієї зміни.
 *
 * Одна на два призначення — миттєве оновлення екрана й підправлення знімка в
 * кеші. Саме тому вона не знає ні про React, ні про IndexedDB: її поведінку
 * можна перевірити тестами без браузера.
 */
export function applyToItems(items: Item[], op: Op, now = new Date().toISOString()): Item[] {
  switch (op.kind) {
    case 'create':
      // Усталене сортування — за датою створення, новіші зверху.
      return [draftItem(op, now), ...items];
    case 'update':
      return items.map((i) => (i.id === op.id ? { ...i, ...op.input, updated_at: now } : i));
    case 'status':
      return items.map((i) => (op.ids.includes(i.id) ? { ...i, status: op.status, updated_at: now } : i));
    case 'delete':
      return items.filter((i) => !op.ids.includes(i.id));
  }
}

/**
 * Позиція, якої ще немає на сервері.
 *
 * `owner_id` лишається порожнім: його проставляє тригер бази, і вигадувати
 * тут значення означало б показати те, чого не буде. На екран воно не йде.
 */
function draftItem(op: Extract<Op, { kind: 'create' }>, now: string): Item {
  return {
    id: op.id,
    list_id: op.listId,
    owner_id: '',
    title: op.input.title,
    url: op.input.url ?? null,
    price: op.input.price ?? null,
    quantity: op.input.quantity ?? 1,
    priority: op.input.priority ?? 'medium',
    note: op.input.note ?? null,
    image_url: op.input.image_url ?? null,
    status: op.input.status ?? 'active',
    source_site: null,
    parsed_at: null,
    created_at: now,
    updated_at: now,
  };
}

/** Випадковий `id` для нової позиції — той самий і на екрані, і в базі. */
export function newId(): string {
  return crypto.randomUUID();
}
