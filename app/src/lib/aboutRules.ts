/**
 * Правила «Про мене» без мережі — їх читають і форма, і експорт «Мої дані»,
 * і логічні тести (як `photoRules.ts`, `notifyRules.ts`).
 *
 * «Про мене» (ROADMAP 8.10): розміри, що людина любить і чого не дарувати.
 *
 * Живе в `profiles` (`about_sizes`, `about_likes`, `about_avoid`) і належить
 * лише власнику. Гість бачить його тільки на посиланні, де власник увімкнув
 * `shares.show_about`; інакше `get_guest_list` ключа `about` не віддає зовсім.
 *
 * Межі — ті самі, що в перевірках `profiles_about_*_check` міграції
 * `20261124015413_about_me.sql`: на тексті без пробілів по краях, у символах.
 */
export type AboutMe = {
  sizes: string | null;
  likes: string | null;
  avoid: string | null;
};

export type AboutField = keyof AboutMe;

export const ABOUT_FIELDS: readonly AboutField[] = ['sizes', 'likes', 'avoid'];

export const ABOUT_LIMITS: Record<AboutField, number> = { sizes: 120, likes: 500, avoid: 500 };

export const EMPTY_ABOUT: AboutMe = { sizes: null, likes: null, avoid: null };

/** Довжина так, як її рахує `char_length` у Postgres: у символах, не в UTF-16. */
function chars(s: string): number {
  return Array.from(s).length;
}

/** Пробіли по краях геть; порожнє — null. Те саме робить тригер `profiles_about_tidy`. */
export function tidyAbout(about: AboutMe): AboutMe {
  const one = (v: string | null) => {
    const s = (v ?? '').trim();
    return s ? s : null;
  };
  return { sizes: one(about.sizes), likes: one(about.likes), avoid: one(about.avoid) };
}

export function aboutIsEmpty(about: AboutMe | null | undefined): boolean {
  if (!about) return true;
  const t = tidyAbout(about);
  return !t.sizes && !t.likes && !t.avoid;
}

/** Поля, що задовгі для бази, — перевірка перед відправкою (CLAUDE.md §4). */
export function aboutTooLong(about: AboutMe): AboutField[] {
  const t = tidyAbout(about);
  return ABOUT_FIELDS.filter((f) => {
    const v = t[f];
    return v !== null && chars(v) > ABOUT_LIMITS[f];
  });
}
