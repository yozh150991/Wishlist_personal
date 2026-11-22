import { supabase } from './supabase';
import { CURRENCIES } from './types';
import type { Currency, Item, ItemInput, ItemQuery, ItemStatus, List, Totals } from './types';
import type { TransferItem, TransferList } from './transfer';
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
  Partial<Pick<List, 'description' | 'currency' | 'event_date' | 'is_archived' | 'repeats_yearly'>>;

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
/**
 * Подяка гостям (ADR-059). Порожній текст — прибрати подяку. Перше збереження
 * ставить у базі `thanks_sent_at` і листи гостям; повертаємо обидва поля, щоб
 * екран знав, чи лист уже пішов.
 */
export async function setListThanks(
  id: string,
  message: string | null,
): Promise<Pick<List, 'thanks_message' | 'thanks_sent_at'>> {
  const text = message?.trim() || null;
  const { data, error } = await supabase
    .from('lists')
    .update({ thanks_message: text })
    .eq('id', id)
    .select('thanks_message, thanks_sent_at')
    .single();
  if (error) throw error;
  return data as Pick<List, 'thanks_message' | 'thanks_sent_at'>;
}

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

/* ── Масові дії ─────────────────────────── */

/*
 * Кожна масова дія — один виклик RPC, тіло якого — одна транзакція в базі
 * (ROADMAP 8.26): обрив мережі посередині не лишає ні половини списку, ні
 * половини видалених позицій. Раніше це були серії запитів PostgREST із
 * ручним відкотом, який сам міг не дійти. Функції — SECURITY INVOKER: RLS,
 * `check`-обмеження й тригери діють так само, як для одиночних запитів
 * (docs/API.md, «Масові дії»).
 */

/**
 * Позиція в тілі RPC. Розділ — міткою `section_key` з `p_sections` (новий
 * список ще не має id розділів); `section_id` база з payload не бере.
 */
type ItemPayload = Omit<ItemInput, 'section_id'> & { section_key: string | null };

type SectionPayload = { key: string; title: string; position: number };

function payload(item: ItemInput, sectionKey: string | null): ItemPayload {
  const { section_id: _sectionId, ...rest } = item;
  return { ...rest, section_key: sectionKey };
}

/**
 * Видаляє позиції списку. Позиції, яких у списку вже немає, база пропускає
 * мовчки — так повтор із черги змін лишається ідемпотентним (ADR-029).
 * Позначки гостей зникають лише каскадом і тригерами, відповідь від них не
 * залежить (CLAUDE.md §3.2).
 */
export async function deleteItems(listId: string, ids: string[]): Promise<void> {
  const { error } = await supabase.rpc('delete_items', { p_list_id: listId, p_item_ids: ids });
  if (error) throw error;
}

export async function setItemsStatus(listId: string, ids: string[], status: ItemStatus): Promise<void> {
  const { error } = await supabase.rpc('set_items_status', { p_list_id: listId, p_item_ids: ids, p_status: status });
  if (error) throw error;
}

/**
 * Новий список із копіями позицій — «Ще хочу» в новий список (M4, ADR-045).
 * Список і позиції лягають однією транзакцією (`copy_items`).
 */
export async function createListWithItems(input: ListInput, items: ItemInput[]): Promise<List> {
  const currency = input.currency ?? 'PLN';
  const { data, error } = await supabase.rpc('copy_items', {
    p_list_id: null,
    p_items: ownCurrency(items, currency).map((i) => payload(i, null)),
    p_new_list: { ...input, title: input.title.trim(), currency },
  });
  if (error) throw error;
  return data as List;
}

/**
 * Імпорт файлу (ROADMAP 6.3, ADR-036): список, його розділи в порядку з файлу
 * й позиції — у своїх розділах, на місцях за порядком у файлі. Наш експорт
 * пише позиції в порядку гостя (`exportItems`), тож місця 1…n у кожному
 * розділі відтворюють ручний порядок; чужий файл — порядок своїх рядків.
 *
 * Одним викликом `import_list`: не вдалося — у базі немає нічого.
 */
export async function importList(file: { list: TransferList; items: TransferItem[] }): Promise<List> {
  const { sections: titles, ...input } = file.list;
  const sections: SectionPayload[] = titles.map((title, at) => ({ key: title, title, position: at + 1 }));
  const known = new Set(titles);
  const next = new Map<string, number>();
  const items: ItemPayload[] = file.items.map(({ section, ...item }) => {
    const key = section && known.has(section) ? section : null;
    // Місця — і в пласкому списку: без них позиції, вставлені однією
    // транзакцією з однаковим created_at, стали б у випадковому порядку.
    const position = (next.get(key ?? '') ?? 0) + 1;
    next.set(key ?? '', position);
    return { ...item, position, section_key: key };
  });
  const { data, error } = await supabase.rpc('import_list', {
    p_list: input,
    p_sections: sections,
    p_items: ownCurrency(items, input.currency),
  });
  if (error) throw error;
  return data as List;
}

/**
 * Валюта позиції, що збігається з валютою списку, зберігається як NULL
 * (ADR-051): так позиція й далі йде за валютою списку, як у v1, і не
 * лишається «євровою», якщо список потім переведуть в євро й назад.
 */
export function ownCurrency<T extends { currency?: Currency | null }>(items: T[], listCurrency: Currency): T[] {
  return items.map((i) => (i.currency && i.currency === listCurrency ? { ...i, currency: null } : i));
}

/**
 * Копії позицій в інший список — «Ще хочу» після свята (M4, ADR-045).
 * Оригінали не чіпаємо: архів лишається правдивим знімком свята, а позначки
 * гостей не переїжджають — вони належать оригіналам. Копії стають в «Інше»:
 * розділи цілі — інші. Одним викликом `copy_items`.
 */
export async function copyItems(listId: string, items: ItemInput[], listCurrency?: Currency): Promise<void> {
  const { error } = await supabase.rpc('copy_items', {
    p_list_id: listId,
    p_items: (listCurrency ? ownCurrency(items, listCurrency) : items).map((i) => payload(i, null)),
  });
  if (error) throw error;
}

/**
 * «Повторити на наступний рік» (S3, ADR-045): новий список із тими самими
 * налаштуваннями — повідомлення гостям, валюта, оформлення, розділи в тому ж
 * порядку — і копіями вибраних позицій на тих самих місцях. Позначки й
 * посилання не переносяться ніколи.
 *
 * Одним викликом `repeat_list`: список, розділи, позиції й перенесення
 * щорічної позначки (ADR-047) — у одній транзакції. Раніше позначка
 * знімалась окремим запитом після створення і могла не дійти.
 */
export async function repeatList(
  source: { list: List; sections: { id: string; title: string; position: number }[]; items: Item[] },
  next: { title: string; event_date: string | null; repeats_yearly: boolean },
): Promise<List> {
  const sections: SectionPayload[] = source.sections.map((s) => ({ key: s.id, title: s.title, position: s.position }));
  const known = new Set(source.sections.map((s) => s.id));
  // Позиція з розділу, якого вже немає, стає в «Інше» без місця — як і в самому списку.
  const items = source.items.map((i) => {
    const key = i.section_id && known.has(i.section_id) ? i.section_id : null;
    const lost = Boolean(i.section_id) && key === null;
    return payload(
      copyInput(i, { section_id: null, position: lost ? null : (i.position ?? null) }, source.list.currency),
      key,
    );
  });
  const { data, error } = await supabase.rpc('repeat_list', {
    p_source_list_id: source.list.id,
    p_list: {
      title: next.title,
      event_date: next.event_date,
      description: source.list.description,
      currency: source.list.currency,
      appearance_id: source.list.appearance_id ?? null,
      repeats_yearly: next.repeats_yearly,
    },
    p_sections: sections,
    p_items: ownCurrency(items, source.list.currency),
  });
  if (error) throw error;
  return data as List;
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
