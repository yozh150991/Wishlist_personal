import { supabase } from './supabase';
import type { Item, ItemQuery } from './types';
import { num } from './format';

/**
 * Розділи списку й ручний порядок (ADR-036).
 *
 * Розділ — одна мітка на позицію. Порядок розділів і позицій у них задає
 * власник, і саме його бачить гість. Сортування власника за ціною чи
 * пріоритетом — лише вигляд на його екрані.
 */

export type Section = {
  id: string;
  list_id: string;
  title: string;
  position: number;
  created_at: string;
};

/** Межа з `sections.title` (CLAUDE.md §4). */
export const SECTION_TITLE_MAX = 60;

/** Від скількох позицій розділи вмикаються самі — навіть якщо жодного ще немає. */
export const SECTIONS_FROM = 12;

export async function fetchSections(listId: string): Promise<Section[]> {
  const { data, error } = await supabase
    .from('sections')
    .select('id, list_id, title, position, created_at')
    .eq('list_id', listId)
    .order('position', { ascending: true })
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data ?? []) as Section[];
}

export async function createSection(listId: string, title: string, position: number): Promise<Section> {
  // owner_id проставляє тригер sections_sync_owner.
  const { data, error } = await supabase
    .from('sections')
    .insert({ list_id: listId, title: title.trim(), position })
    .select('id, list_id, title, position, created_at')
    .single();
  if (error) throw error;
  return data as Section;
}

export async function renameSection(id: string, title: string): Promise<void> {
  const { error } = await supabase.from('sections').update({ title: title.trim() }).eq('id', id);
  if (error) throw error;
}

/** Позиції розділу переходять у «Інше» (`on delete set null`), а не зникають. */
export async function deleteSection(id: string): Promise<void> {
  const { error } = await supabase.from('sections').delete().eq('id', id);
  if (error) throw error;
}

/** Новий порядок і розділ для групи позицій — одним викликом. */
export async function reorderItems(listId: string, sectionId: string | null, itemIds: string[]): Promise<void> {
  const { error } = await supabase.rpc('reorder_items', {
    p_list_id: listId,
    p_section_id: sectionId,
    p_item_ids: itemIds,
  });
  if (error) throw error;
}

export async function reorderSections(listId: string, sectionIds: string[]): Promise<void> {
  const { error } = await supabase.rpc('reorder_sections', { p_list_id: listId, p_section_ids: sectionIds });
  if (error) throw error;
}

/**
 * Порядок, який бачить гість: `position` за зростанням, неупорядковані
 * (щойно додані) зверху, новіші першими. Те саме, що `row_number()` у
 * `get_shared_list`.
 */
export function manualOrder(a: Item, b: Item): number {
  const pa = a.position ?? null;
  const pb = b.position ?? null;
  if (pa === null && pb !== null) return -1;
  if (pa !== null && pb === null) return 1;
  if (pa !== null && pb !== null && pa !== pb) return pa - pb;
  if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
  return a.id < b.id ? -1 : 1;
}

export type Group = { section: Section | null; items: Item[] };

/**
 * Позиції по розділах у ручному порядку; без розділу — у «Інше» в кінці.
 * Порожні розділи лишаються: власник має бачити, куди перетягувати.
 */
export function groupItems(items: Item[], sections: Section[]): Group[] {
  const known = new Set(sections.map((s) => s.id));
  const groups: Group[] = sections.map((s) => ({
    section: s,
    items: items.filter((i) => i.section_id === s.id).sort(manualOrder),
  }));
  const other = items.filter((i) => !i.section_id || !known.has(i.section_id)).sort(manualOrder);
  groups.push({ section: null, items: other });
  return groups;
}

/**
 * Фільтри сторінки списку, застосовані на клієнті — для режиму «Розділи», де
 * список завантажено цілком. Ті самі правила, що в `list_items_page`: пошук
 * без регістру в назві, статуси, діапазон ціни (позиції без ціни діапазон
 * відсіює).
 */
export function matchesQuery(item: Item, q: ItemQuery): boolean {
  const search = q.search.trim().toLowerCase();
  if (search && !item.title.toLowerCase().includes(search)) return false;
  if (q.statuses.length && !q.statuses.includes(item.status)) return false;
  const price = num(item.price);
  if (q.priceMin !== '' && (price === null || price < Number(q.priceMin))) return false;
  if (q.priceMax !== '' && (price === null || price > Number(q.priceMax))) return false;
  return true;
}
