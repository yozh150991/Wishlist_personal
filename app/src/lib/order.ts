import { num } from './format';
import type { Item, ItemQuery, Section } from './types';

/**
 * Ручний порядок і розділи (ADR-036) — чисті функції: ні клієнта бази, ні
 * React. Живуть окремо від `sections.ts`, щоб їх могли брати й тести без
 * браузера, й інші чисті модулі (`itemsView.ts`).
 */

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
