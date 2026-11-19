/**
 * Гостьові адреси: `/l/…` — гостьова сторінка (ADR-041), `/s/…` — старі
 * роздані посилання, які ведуть на неї ж (ADR-065).
 *
 * Список один на застосунок і має збігатися з `navigateFallbackDenylist` у
 * `vite.config.ts` та з `GUEST_PREFIXES` у `scripts/check-pwa.mjs` (той звіряє
 * це сам). Новий гостьовий префікс — у всі три місця одним комітом
 * (CLAUDE.md §3, інваріант 5).
 */
export const GUEST_PATH_PREFIXES = ['/l/', '/s/'] as const;

/**
 * Чи це адреса гостя. На таких сторінках Service Worker не реєструється
 * (`components/UpdatePrompt.tsx`): гостю не потрібна офлайн-оболонка
 * застосунку, а разом із нею він качав би й екрани власника.
 */
export function isGuestPath(pathname: string): boolean {
  return GUEST_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}
