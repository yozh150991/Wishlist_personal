import { supabase } from './supabase';
import type { Item, ItemInput, ItemQuery, ItemStatus, List, Totals } from './types';

/* ── Списки ─────────────────────────────── */

/**
 * Картка списку показує, скільки в ньому позицій, тому кількість береться
 * агрегатом у тому самому запиті: окремий запит на кожен список дав би N+1
 * на екрані, який відкривається найчастіше.
 *
 * PostgREST повертає агрегат масивом з одного рядка — розгортаємо тут, щоб
 * форма `List` лишалась пласкою і без змін лягала в офлайн-знімок.
 */
export async function fetchLists(): Promise<List[]> {
  const { data, error } = await supabase
    .from('lists')
    .select('*, items(count)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  type Row = Omit<List, 'item_count'> & { items?: { count: number }[] | null };
  return ((data ?? []) as Row[]).map(({ items, ...list }) => ({
    ...list,
    item_count: items?.[0]?.count ?? 0,
  }));
}

export async function fetchList(id: string): Promise<List | null> {
  const { data, error } = await supabase.from('lists').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as List | null) ?? null;
}

export type ListInput = Pick<List, 'title'> &
  Partial<Pick<List, 'description' | 'currency' | 'event_date'>>;

export async function createList(input: ListInput, ownerId: string): Promise<List> {
  const { data, error } = await supabase
    .from('lists')
    .insert({ ...input, owner_id: ownerId })
    .select()
    .single();
  if (error) throw error;
  return data as List;
}

export async function updateList(id: string, patch: Partial<ListInput>): Promise<void> {
  const { error } = await supabase.from('lists').update(patch).eq('id', id);
  if (error) throw error;
}

export async function deleteList(id: string): Promise<void> {
  const { error } = await supabase.from('lists').delete().eq('id', id);
  if (error) throw error;
}

/* ── Позиції ────────────────────────────── */

export type { ItemInput } from './types';

/**
 * `id` дозволено задати з клієнта — це основа ідемпотентності черги змін
 * (ADR-029). Повторна відправка тієї самої позиції впирається в первинний
 * ключ і повертає 23505 замість того, щоб створити дублікат.
 */
export async function createItem(listId: string, input: ItemInput, id?: string): Promise<Item> {
  // owner_id проставляє тригер items_sync_owner, з клієнта його не шлемо.
  const { data, error } = await supabase
    .from('items')
    .insert({ ...input, ...(id ? { id } : {}), list_id: listId })
    .select()
    .single();
  if (error) throw error;
  return data as Item;
}

export async function updateItem(id: string, patch: Partial<ItemInput>): Promise<Item> {
  const { data, error } = await supabase.from('items').update(patch).eq('id', id).select().single();
  if (error) throw error;
  return data as Item;
}

/**
 * Усі позиції списку — для експорту (ROADMAP 6.3).
 *
 * Сторінка списку тримає в памʼяті лише поточну партію, а вивантажити треба
 * все. Ідемо діапазонами по 1000: стільки ж стоїть у `max_rows` PostgREST,
 * тож одним запитом більшого все одно не взяти.
 */
export async function fetchAllItems(listId: string): Promise<Item[]> {
  const PAGE = 1000;
  const out: Item[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await supabase
      .from('items')
      .select('*')
      .eq('list_id', listId)
      .order('created_at', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw error;
    const rows = (data ?? []) as Item[];
    out.push(...rows);
    if (rows.length < PAGE) return out;
  }
}

export async function deleteItem(id: string): Promise<void> {
  const { error } = await supabase.from('items').delete().eq('id', id);
  if (error) throw error;
}

/* ── Масові дії ─────────────────────────── */

/**
 * Ідентифікатори їдуть у рядку запиту (`id=in.(…)`), а довжина адреси має межу.
 * Сто UUID — близько 3,7 КБ, з великим запасом до обмежень проксі.
 */
const BULK_CHUNK = 100;

function chunks<T>(xs: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Видаляє позиції за id. Чужі RLS мовчки відсіює — власник видаляє лише своє. */
export async function deleteItems(ids: string[]): Promise<void> {
  for (const part of chunks(ids, BULK_CHUNK)) {
    const { error } = await supabase.from('items').delete().in('id', part);
    if (error) throw error;
  }
}

export async function setItemsStatus(ids: string[], status: ItemStatus): Promise<void> {
  for (const part of chunks(ids, BULK_CHUNK)) {
    const { error } = await supabase.from('items').update({ status }).in('id', part);
    if (error) throw error;
  }
}

/**
 * Створює список і наповнює його позиціями (імпорт, ROADMAP 6.3).
 *
 * PostgREST не дає транзакції на кілька запитів, тож цілісність доводиться
 * тримати руками: якщо частина позицій не вставилась, щойно створений список
 * видаляємо. Краще жодного списку, ніж половина списку, про яку людина
 * дізнається лише згодом.
 */
export async function createListWithItems(
  input: ListInput,
  items: ItemInput[],
  ownerId: string,
): Promise<List> {
  const list = await createList(input, ownerId);
  try {
    for (const part of chunks(items, BULK_CHUNK)) {
      const { error } = await supabase
        .from('items')
        .insert(part.map((i) => ({ ...i, list_id: list.id })));
      if (error) throw error;
    }
  } catch (e) {
    await deleteList(list.id).catch(() => {});
    throw e;
  }
  return list;
}

/* ── Сторінка позицій (keyset) ──────────── */

export type Cursor = { key: string; id: string } | null;

/** Значення ключа сортування останнього рядка — має збігатися з виразом у SQL. */
export function cursorFrom(item: Item, sort: ItemQuery['sort']): Cursor {
  switch (sort) {
    case 'created_at':
      return { key: item.created_at, id: item.id };
    case 'title':
      return { key: item.title, id: item.id };
    case 'price':
      // У SQL ключ — coalesce(price, -1), тут те саме.
      return { key: String(item.price ?? -1), id: item.id };
    case 'priority':
      return { key: item.priority, id: item.id };
  }
}

export async function fetchItemsPage(
  listId: string,
  q: ItemQuery,
  cursor: Cursor,
): Promise<Item[]> {
  const { data, error } = await supabase.rpc('list_items_page', {
    p_list_id: listId,
    p_sort: q.sort,
    p_desc: q.desc,
    p_limit: q.pageSize,
    p_cursor_key: cursor?.key ?? null,
    p_cursor_id: cursor?.id ?? null,
    p_search: q.search.trim() || null,
    p_status: q.statuses.length ? q.statuses : null,
    p_price_min: q.priceMin === '' ? null : Number(q.priceMin),
    p_price_max: q.priceMax === '' ? null : Number(q.priceMax),
  });
  if (error) throw error;
  return (data ?? []) as Item[];
}

export async function fetchTotals(listId: string): Promise<Totals | null> {
  const { data, error } = await supabase.rpc('list_totals', { p_list_id: listId });
  if (error) throw error;
  const rows = (data ?? []) as Totals[];
  return rows[0] ?? null;
}
