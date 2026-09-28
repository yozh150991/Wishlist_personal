import { supabase } from './supabase';
import { CURRENCIES } from './types';
import type { Currency, Item, ItemInput, ItemQuery, ItemStatus, List, Totals } from './types';
import { isNetworkError } from './errors';
import { copyInput } from './afterEvent';

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

/**
 * Список із кількістю позицій: від неї залежить, чи вмикати розділи ще до
 * того, як приїдуть самі позиції (ADR-036) — інакше сторінка спершу
 * вантажила б першу партію, а потім увесь список удруге.
 */
export async function fetchList(id: string): Promise<List | null> {
  const { data, error } = await supabase.from('lists').select('*, items(count)').eq('id', id).maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const { items, ...list } = data as Omit<List, 'item_count'> & { items?: { count: number }[] | null };
  return { ...list, item_count: items?.[0]?.count ?? 0 };
}

/**
 * Списки для головної v2: разом із кількістю позицій — скільки з них ще
 * «актуальні» (`status = active`). Минулий список підписано «4 не розібрано»
 * (потік U): це статуси самого власника, не позначки гостей, тож інваріант
 * §3.2 тут ні до чого.
 *
 * Два агрегати одного вкладення розрізняє псевдонім, а фільтр на псевдонімі
 * рахує лише активні. Якщо сервер такого запиту не прийме, картки просто
 * лишаються без «не розібрано»: помилка мережі йде нагору, решта — у
 * запасний `fetchLists()`.
 */
export async function fetchListsOverview(): Promise<List[]> {
  const { data, error } = await supabase
    .from('lists')
    .select('*, all_items:items(count), active_items:items(count)')
    .eq('active_items.status', 'active')
    .order('created_at', { ascending: false });
  if (error) {
    if (isNetworkError(error)) throw error;
    return fetchLists();
  }
  type Agg = { count: number }[] | null | undefined;
  type Row = Omit<List, 'item_count' | 'active_count'> & { all_items?: Agg; active_items?: Agg };
  return ((data ?? []) as Row[]).map(({ all_items, active_items, ...list }) => ({
    ...list,
    item_count: all_items?.[0]?.count ?? 0,
    active_count: active_items?.[0]?.count ?? 0,
  }));
}

/** Валюта нового списку — з профілю, якщо людина її колись задала. */
export async function fetchDefaultCurrency(userId: string): Promise<Currency | null> {
  const { data, error } = await supabase.from('profiles').select('default_currency').eq('id', userId).maybeSingle();
  if (error || !data) return null;
  const c = (data as { default_currency: string | null }).default_currency;
  return c && (CURRENCIES as string[]).includes(c) ? (c as Currency) : null;
}

export type ListInput = Pick<List, 'title'> &
  Partial<Pick<List, 'description' | 'currency' | 'event_date' | 'is_archived'>>;

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

/**
 * Архів (ADR-045) — полиця власника: список лишається цілим, наявні посилання
 * працюють як і раніше, а нове v2 створити не дає. v1 прапорця не знає й
 * показує такий список серед звичайних.
 */
export async function setListArchived(id: string, archived: boolean): Promise<void> {
  const { error } = await supabase.from('lists').update({ is_archived: archived }).eq('id', id);
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
 *
 * `onProgress` потрібен саме експорту: він перечитує весь список, і на
 * великому це помітна пауза. Кнопка в цей час показує «Експортую… 18 з 34»,
 * а не просто гасне.
 */
export async function fetchAllItems(
  listId: string,
  onProgress?: (done: number) => void,
): Promise<Item[]> {
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
    onProgress?.(out.length);
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

/**
 * Копії позицій в інший список — «Ще хочу» після свята (M4, ADR-045).
 * Оригінали не чіпаємо: архів лишається правдивим знімком свята, а позначки
 * гостей не переїжджають — вони належать оригіналам.
 */
export async function copyItems(listId: string, items: ItemInput[]): Promise<void> {
  for (const part of chunks(items, BULK_CHUNK)) {
    const { error } = await supabase.from('items').insert(part.map((i) => ({ ...i, list_id: listId })));
    if (error) throw error;
  }
}

/**
 * «Повторити на наступний рік» (S3, ADR-045): новий список із тими самими
 * налаштуваннями — повідомлення гостям, валюта, оформлення, розділи в тому ж
 * порядку — і копіями вибраних позицій на тих самих місцях. Позначки й
 * посилання не переносяться ніколи.
 *
 * Як і в імпорті, транзакції на кілька запитів немає: не вдалося — щойно
 * створений список видаляємо, щоб не лишити половину.
 */
export async function repeatList(
  source: { list: List; sections: { id: string; title: string; position: number }[]; items: Item[] },
  next: { title: string; event_date: string | null },
  ownerId: string,
): Promise<List> {
  const { data, error } = await supabase
    .from('lists')
    .insert({
      owner_id: ownerId,
      title: next.title,
      event_date: next.event_date,
      description: source.list.description,
      currency: source.list.currency,
      appearance_id: source.list.appearance_id ?? null,
    })
    .select()
    .single();
  if (error) throw error;
  const list = data as List;
  try {
    // Розділи — по одному: так id нового точно відповідає старому.
    const sectionIds = new Map<string, string>();
    for (const s of source.sections) {
      const { data: row, error: sErr } = await supabase
        .from('sections')
        .insert({ list_id: list.id, title: s.title, position: s.position })
        .select('id')
        .single();
      if (sErr) throw sErr;
      sectionIds.set(s.id, (row as { id: string }).id);
    }
    // Позиція з розділу, якого вже немає, стає в «Інше» без місця — як і в самому списку.
    const inputs = source.items.map((i) => {
      const section = i.section_id ? (sectionIds.get(i.section_id) ?? null) : null;
      const lost = Boolean(i.section_id) && section === null;
      return copyInput(i, { section_id: section, position: lost ? null : (i.position ?? null) });
    });
    await copyItems(list.id, inputs);
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
