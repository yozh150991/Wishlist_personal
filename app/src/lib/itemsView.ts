import { num } from './format';
import { groupItems, manualOrder } from './order';
import type { Item, ItemPriority, Section, Totals } from './types';

/**
 * Вигляд позицій списку на екрані власника — чисті функції без React і мережі.
 *
 * Сторінка списку v2 тримає список цілим (`useItems(…, 'all')`) і все
 * сортує й фільтрує тут, на клієнті: так зміна, що лягла в офлайн-чергу,
 * одразу видна в підсумку й у правильній групі, а перевірити правила можна
 * тестами без браузера (tests/e2e/items-view.spec.ts).
 *
 * Сортування — лише вигляд на екрані власника. Порядок, який бачить гість, —
 * ручний (ADR-036), і його тут ніхто не міняє.
 */

/** «Вручну» — той самий порядок, що в гостя; решта — лише для власника (потік O2). */
export type ViewSort = 'manual' | 'priority' | 'priceAsc' | 'priceDesc' | 'recent';
export const VIEW_SORTS: ViewSort[] = ['manual', 'priority', 'priceAsc', 'priceDesc', 'recent'];

export function isViewSort(value: unknown): value is ViewSort {
  return typeof value === 'string' && (VIEW_SORTS as string[]).includes(value);
}

/** Пошук, сортування й фільтри з'являються від стількох позицій (потік O). */
export const TOOLS_FROM = 20;

/** Межі з check-обмежень таблиці `items` — форма перевіряє їх до відправки (CLAUDE.md §4). */
export const ITEM_TITLE_MAX = 200;
export const ITEM_NOTE_MAX = 1000;
export const ITEM_URL_MAX = 2048;
export const ITEM_QTY_MAX = 999;

/** «Усі» чи «Без ціни» — чипи під пошуком (O1). Фільтра за позначками у власника немає. */
export type ViewFilter = 'all' | 'noPrice';

/** Від найбажанішого: так ідуть і групи, і сортування «Пріоритет». */
export const PRIORITY_ORDER: ItemPriority[] = ['high', 'medium', 'low'];

const RANK: Record<ItemPriority, number> = { high: 0, medium: 1, low: 2 };

/**
 * Гроші — у мінорних одиницях (копійки, гроші, центи): у JS не рахуємо
 * float (CLAUDE.md §4). У базі `numeric(12,2)`, тож двох знаків досить.
 */
export function toMinor(value: number | string | null | undefined): number | null {
  const n = num(value);
  return n === null ? null : Math.round(n * 100);
}

/**
 * Підсумок списку з того, що на екрані, — ті самі правила, що в RPC
 * `list_totals`: ціна множиться на кількість, «без ціни» — усі статуси.
 * Рахуємо самі, а не беремо з сервера, щоб видалення з «Відмінити» й зміни в
 * офлайн-черзі одразу відбивались у сумі.
 */
export function totalsOf(items: Item[]): Totals {
  let total = 0;
  let active = 0;
  const out = { items_count: items.length, active_count: 0, purchased_count: 0, gifted_count: 0, items_no_price: 0 };
  for (const i of items) {
    const price = toMinor(i.price);
    const line = price === null ? 0 : price * i.quantity;
    total += line;
    if (price === null) out.items_no_price++;
    if (i.status === 'active') {
      out.active_count++;
      active += line;
    } else if (i.status === 'purchased') out.purchased_count++;
    else out.gifted_count++;
  }
  return { ...out, total_price: total / 100, active_price: active / 100 };
}

/** Порівняння за ціною: позиції без ціни — завжди в кінці, у ручному порядку. */
function byPrice(desc: boolean) {
  return (a: Item, b: Item) => {
    const pa = toMinor(a.price);
    const pb = toMinor(b.price);
    if (pa === null && pb === null) return manualOrder(a, b);
    if (pa === null) return 1;
    if (pb === null) return -1;
    if (pa !== pb) return desc ? pb - pa : pa - pb;
    return manualOrder(a, b);
  };
}

export function sortItems(items: Item[], sort: ViewSort): Item[] {
  const out = [...items];
  switch (sort) {
    case 'priority':
      return out.sort((a, b) => RANK[a.priority] - RANK[b.priority] || manualOrder(a, b));
    case 'priceAsc':
      return out.sort(byPrice(false));
    case 'priceDesc':
      return out.sort(byPrice(true));
    case 'recent':
      return out.sort((a, b) =>
        a.created_at !== b.created_at ? (a.created_at < b.created_at ? 1 : -1) : a.id < b.id ? -1 : 1,
      );
    default:
      return out.sort(manualOrder);
  }
}

/**
 * Група на екрані: розділ (ручний порядок із розділами), рівень пріоритету
 * («Пріоритет») або одна безіменна (решта сортувань і список без розділів).
 */
export type ViewGroup =
  | { kind: 'section'; key: string; section: Section; items: Item[] }
  | { kind: 'other'; key: string; items: Item[] }
  | { kind: 'priority'; key: string; priority: ItemPriority; items: Item[] }
  | { kind: 'all'; key: string; items: Item[] };

/**
 * Позиції по групах.
 *
 * - «Пріоритет» — заголовки рівнів, не окремі екрани (O1); порожніх рівнів немає.
 * - «Вручну» зі створеними розділами — розділи в їхньому порядку, без розділу —
 *   «Інше» в кінці (ADR-036). Порожній розділ лишається, коли нічого не
 *   відфільтровано: власник має бачити розділ, який щойно створив.
 * - Решта — одна група.
 */
export function viewGroups(
  items: Item[],
  sort: ViewSort,
  sections: Section[],
  { keepEmpty }: { keepEmpty: boolean },
): ViewGroup[] {
  if (sort === 'priority') {
    return PRIORITY_ORDER.map((priority) => ({
      kind: 'priority' as const,
      key: `p:${priority}`,
      priority,
      items: items.filter((i) => i.priority === priority).sort(manualOrder),
    })).filter((g) => g.items.length > 0);
  }
  if (sort === 'manual' && sections.length > 0) {
    return groupItems(items, sections)
      .map((g): ViewGroup =>
        g.section
          ? { kind: 'section', key: `s:${g.section.id}`, section: g.section, items: g.items }
          : { kind: 'other', key: 'other', items: g.items },
      )
      .filter((g) => g.items.length > 0 || (keepEmpty && g.kind === 'section'));
  }
  return [{ kind: 'all', key: 'all', items: sortItems(items, sort) }];
}

/** Пошук у назві без регістру — те саме правило, що в `list_items_page`. */
export function matchesView(item: Item, search: string, filter: ViewFilter): boolean {
  const q = search.trim().toLowerCase();
  if (q && !item.title.toLowerCase().includes(q)) return false;
  if (filter === 'noPrice' && num(item.price) !== null) return false;
  return true;
}

/* ── Посилання на товар (потік R) ─────────────────────────── */

/**
 * Адреса сторінки з того, що вставили: `shop.ua/lampa` стає
 * `https://shop.ua/lampa`, а з тексту «Глянь: https://…» береться сама адреса
 * (так ділиться більшість застосунків магазинів). `null` — це не адреса
 * сторінки (R1): перевіряємо ще до запиту до сайту.
 */
export function normalizeUrl(input: string): string | null {
  let s = input.trim();
  if (!s) return null;
  if (/\s/.test(s)) {
    const found = s.match(/https?:\/\/[^\s<>"']+/i);
    if (!found) return null;
    s = found[0];
  }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `https://${s}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  const host = url.hostname;
  // «shopua» без крапки — найчастіша помилка при наборі вручну (R1).
  if (!host.includes('.') || host.startsWith('.') || host.endsWith('.')) return null;
  return url.href;
}

/**
 * Рекламні мітки, що не міняють сторінки (ADR-020): без них та сама річ із
 * розсилки й із пошуку — одне посилання.
 */
const TRACKING = /^(utm_[a-z]+|fbclid|gclid|dclid|gbraid|wbraid|yclid|msclkid|mc_cid|mc_eid|_ga|igshid|ref|ref_src|spm)$/i;

/** Ключ для порівняння: без протоколу, `www.`, якоря, рекламних міток і кінцевої `/`. */
export function urlKey(href: string): string | null {
  const normal = normalizeUrl(href);
  if (!normal) return null;
  const url = new URL(normal);
  const params = [...url.searchParams.entries()].filter(([k]) => !TRACKING.test(k));
  const query = params.length ? `?${new URLSearchParams(params).toString()}` : '';
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.hostname.replace(/^www\./, '').toLowerCase()}${path}${query}`;
}

/**
 * Назва чернетки (ADR-046): адреса без протоколу, `www.`, параметрів і якоря —
 * «shop.ua/lampa-keramika». Її бачить v1, яка про чернетки не знає; v2 поруч
 * пише «Потрібна назва».
 */
export function draftTitle(href: string): string {
  const normal = normalizeUrl(href);
  if (!normal) return href.trim().slice(0, ITEM_TITLE_MAX);
  const url = new URL(normal);
  let path = url.pathname.replace(/\/+$/, '');
  try {
    path = decodeURI(path);
  } catch {
    /* кривий відсоток — лишаємо як є */
  }
  return `${url.hostname.replace(/^www\./, '')}${path}`.slice(0, ITEM_TITLE_MAX);
}

/** Від якої різниці ціна в магазині — «Ціна змінилась» на картці (P: «>15 %»). */
export const PRICE_CHANGE_RATIO = 0.15;

/**
 * Ціна, яку перевірка побачила в магазині (ADR-048), якщо вона інша, ніж у
 * списку. Іншу валюту не порівнюємо: курсів застосунок не знає (ADR-005).
 * `notable` — різниця від 15 % зі своєю ціною в списку: це мітка на картці.
 * У формі позиції показуємо будь-яку різницю, зокрема коли своєї ціни ще немає.
 */
export function linkPriceChange(
  item: Pick<Item, 'price' | 'link_price' | 'link_currency' | 'link_status'>,
  currency: string,
): { price: number; notable: boolean } | null {
  if (item.link_status !== 'ok' && item.link_status !== 'out') return null;
  const shop = toMinor(item.link_price);
  if (shop === null || shop === 0) return null;
  if (item.link_currency && item.link_currency !== currency) return null;
  const own = toMinor(item.price);
  if (own === shop) return null;
  // Без своєї ціни різниці немає: лише підказка в діалозі, без мітки на картці.
  const notable = own !== null && own !== 0 && Math.abs(shop - own) / own >= PRICE_CHANGE_RATIO;
  return { price: shop / 100, notable };
}

/** Чернетка без назви — гостям невидима, у списку з міткою «Потрібна назва». */
export function isDraft(item: Pick<Item, 'needs_title'>): boolean {
  return Boolean(item.needs_title);
}

/** Позиція з тим самим посиланням (R2) — крім тієї, яку редагують. */
export function findSameUrl(items: Item[], href: string, exceptId?: string): Item | undefined {
  const key = urlKey(href);
  if (!key) return undefined;
  return items.find((i) => i.id !== exceptId && i.url && urlKey(i.url) === key);
}

/** Позиція з тією самою назвою (тихий рядок під полем, R2). */
export function findSameTitle(items: Item[], title: string, exceptId?: string): Item | undefined {
  const t = title.trim().toLowerCase();
  if (!t) return undefined;
  return items.find((i) => i.id !== exceptId && i.title.trim().toLowerCase() === t);
}

/* ── Ціна з поля ─────────────────────────────────────────── */

/** Межа `numeric(12,2)`: десять цифр до коми (README, «Обмеження полів»). */
export const PRICE_MAX = 9_999_999_999;

export type PriceParse = { value: number | null; error: 'format' | 'tooBig' | null };

/**
 * Ціна, як її пишуть люди: «1 240», «1240,50», «1.240,50», «1,240.50».
 * Роздільник дробу — останній із крапки чи коми, якщо після нього одна чи дві
 * цифри; решта — розряди. Порожнє поле — «без ціни», не помилка.
 */
export function parsePrice(input: string): PriceParse {
  let s = input.replace(/[\s  ']/g, '');
  if (!s) return { value: null, error: null };
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  const sep = Math.max(lastDot, lastComma);
  if (sep >= 0) {
    const whole = s.slice(0, sep).replace(/[.,]/g, '');
    const tail = s.slice(sep + 1);
    // Три цифри після роздільника — це розряди («1,240», «1.240»), а не дріб:
    // копійок буває щонайбільше дві.
    s = tail.length === 3 ? `${whole}${tail}` : `${whole}.${tail}`;
  }
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return { value: null, error: 'format' };
  const value = Number(s);
  if (value > PRICE_MAX) return { value: null, error: 'tooBig' };
  return { value, error: null };
}
