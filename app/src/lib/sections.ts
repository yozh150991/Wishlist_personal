import { supabase } from './supabase';
import type { Section } from './types';

/**
 * Розділи списку й ручний порядок (ADR-036).
 *
 * Розділ — одна мітка на позицію. Порядок розділів і позицій у них задає
 * власник, і саме його бачить гість. Сортування власника за ціною чи
 * пріоритетом — лише вигляд на його екрані.
 */

// Тип живе в `types.ts`, поруч зі списком і позицією: так його беруть і
// чисті модулі (`order.ts`, `itemsView.ts`), не тягнучи клієнта бази.
export type { Section } from './types';

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

/*
 * Порядок і групування — чисті функції без клієнта бази, у `order.ts`: так їх
 * можна перевіряти тестами без браузера (tests/e2e/items-view.spec.ts).
 * Звідси — лише для зворотної сумісності імпортів.
 */
export { groupItems, manualOrder, matchesQuery } from './order';
export type { Group } from './order';
