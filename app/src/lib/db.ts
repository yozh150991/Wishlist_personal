import { supabase } from './supabase';
import type { Item, ItemQuery, ItemStatus, List, Totals } from './types';

/* ── Списки ─────────────────────────────── */

export async function fetchLists(): Promise<List[]> {
  const { data, error } = await supabase
    .from('lists')
    .select('*')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as List[];
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

export type ItemInput = Pick<Item, 'title'> &
  Partial<Pick<Item, 'url' | 'price' | 'quantity' | 'priority' | 'note' | 'image_url' | 'status'>>;

export async function createItem(listId: string, input: ItemInput): Promise<Item> {
  // owner_id проставляє тригер items_sync_owner, з клієнта його не шлемо.
  const { data, error } = await supabase
    .from('items')
    .insert({ ...input, list_id: listId })
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
