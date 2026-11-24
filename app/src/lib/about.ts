import { supabase } from './supabase';
import { EMPTY_ABOUT, tidyAbout } from './aboutRules';
import type { AboutMe } from './aboutRules';

export { ABOUT_FIELDS, ABOUT_LIMITS, EMPTY_ABOUT, aboutIsEmpty, aboutTooLong, tidyAbout } from './aboutRules';
export type { AboutField, AboutMe } from './aboutRules';

/** «Про мене» власника в `profiles` (ROADMAP 8.10): читання й запис — лише свого рядка. */

type Row = { about_sizes: unknown; about_likes: unknown; about_avoid: unknown };

function fromRow(row: Row | null): AboutMe {
  if (!row) return { ...EMPTY_ABOUT };
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v : null);
  return { sizes: str(row.about_sizes), likes: str(row.about_likes), avoid: str(row.about_avoid) };
}

export async function fetchAbout(userId: string): Promise<AboutMe> {
  const { data, error } = await supabase
    .from('profiles')
    .select('about_sizes, about_likes, about_avoid')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return fromRow(data as Row | null);
}

/** Зберігає й повертає те, що лягло в базу (після її тригера). */
export async function saveAbout(userId: string, about: AboutMe): Promise<AboutMe> {
  const t = tidyAbout(about);
  const { data, error } = await supabase
    .from('profiles')
    .update({ about_sizes: t.sizes, about_likes: t.likes, about_avoid: t.avoid })
    .eq('id', userId)
    .select('about_sizes, about_likes, about_avoid')
    .maybeSingle();
  if (error) throw error;
  return fromRow(data as Row | null);
}
