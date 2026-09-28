import { supabase } from './supabase';

/**
 * Оформлення списку — подія як іменований відтінок (ADR-034).
 *
 * Відкритий параметр один — відтінок H. Світлість і насиченість кожного кроку
 * задає `hue-ramp.js`, тож людина не може обрати непридатне: блідо-жовтий із
 * білим підписом (1,4:1) з конструкції не виходить.
 *
 * Три вбудовані події — рядки тієї самої таблиці з `owner_id = null`, їхні
 * підписи перекладає застосунок за `builtin_key`. Назва свого оформлення
 * приватна: потрібна власникові в переліку й нікуди більше не йде — гість
 * отримує лише відтінок.
 */

export type BuiltinKey = 'birthday' | 'wedding' | 'housewarming';

export type Appearance = {
  id: string;
  owner_id: string | null;
  name: string;
  hue: number;
  source: 'builtin' | 'manual' | 'cover';
  builtin_key: BuiltinKey | null;
  created_at: string;
  /** Скільки списків власника носять це оформлення — для підпису «2 списки». */
  list_count: number;
};

/** Межа з `appearances.name` (CLAUDE.md §4: кожен check має відповідник у формі). */
export const APPEARANCE_NAME_MAX = 24;

/**
 * Ті самі діапазони, що в `appearances_name_no_emoji`: перелік набраний Rubik,
 * і емодзі в ньому читається як чужа наліпка.
 */
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/u;

export type NameProblem = 'empty' | 'tooLong' | 'emoji' | null;

export function checkAppearanceName(name: string): NameProblem {
  const trimmed = name.trim();
  if (!trimmed) return 'empty';
  if (trimmed.length > APPEARANCE_NAME_MAX) return 'tooLong';
  if (EMOJI.test(trimmed)) return 'emoji';
  return null;
}

const BUILTIN_ORDER: BuiltinKey[] = ['birthday', 'wedding', 'housewarming'];

/** Вбудовані — першими й у сталому порядку, свої — за датою створення. */
export async function fetchAppearances(): Promise<Appearance[]> {
  const { data, error } = await supabase
    .from('appearances')
    .select('id, owner_id, name, hue, source, builtin_key, created_at, lists(count)')
    .order('created_at', { ascending: true });
  if (error) throw error;
  type Row = Omit<Appearance, 'list_count'> & { lists?: { count: number }[] | null };
  const rows = ((data ?? []) as Row[]).map(({ lists, ...a }) => ({
    ...a,
    list_count: lists?.[0]?.count ?? 0,
  }));
  const builtin = rows
    .filter((a) => a.builtin_key)
    .sort((a, b) => BUILTIN_ORDER.indexOf(a.builtin_key!) - BUILTIN_ORDER.indexOf(b.builtin_key!));
  return [...builtin, ...rows.filter((a) => !a.builtin_key)];
}

export async function createAppearance(ownerId: string, name: string, hue: number): Promise<Appearance> {
  const { data, error } = await supabase
    .from('appearances')
    .insert({ owner_id: ownerId, name: name.trim(), hue, source: 'manual' })
    .select('id, owner_id, name, hue, source, builtin_key, created_at')
    .single();
  if (error) throw error;
  return { ...(data as Omit<Appearance, 'list_count'>), list_count: 0 };
}

/** Спискам із цим оформленням база ставить null — вони повертаються до схеми глядача. */
export async function deleteAppearance(id: string): Promise<void> {
  const { error } = await supabase.from('appearances').delete().eq('id', id);
  if (error) throw error;
}

export async function setListAppearance(listId: string, appearanceId: string | null): Promise<void> {
  const { error } = await supabase.from('lists').update({ appearance_id: appearanceId }).eq('id', listId);
  if (error) throw error;
}

export async function fetchAppearanceHue(id: string | null): Promise<number | null> {
  if (!id) return null;
  const { data, error } = await supabase.from('appearances').select('hue').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as { hue: number } | null)?.hue ?? null;
}
