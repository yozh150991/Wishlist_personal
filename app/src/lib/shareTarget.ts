/**
 * Що прийшло з системного «Поділитися» (Web Share Target, потік L; ADR-046).
 *
 * Застосунки кладуть те саме по-різному: браузер — адресу в `url`, а назву
 * сторінки в `title`; магазини — усе в `text` («Керамічна лампа
 * https://shop.ua/lampa»). Тут це зводиться до однієї пари «адреса + назва».
 * Без мережі, React і DOM — перевіряється тестами без браузера.
 */
import { ITEM_TITLE_MAX, ITEM_URL_MAX, normalizeUrl } from './itemsView';

export type Shared = { url: string | null; title: string | null };

/** Адреса в тексті без хвостових розділових знаків: «(https://shop.ua/x).» → https://shop.ua/x. */
function urlIn(text: string): { url: string; start: number; end: number } | null {
  const m = /https?:\/\/[^\s<>"'«»]+/i.exec(text);
  if (!m) return null;
  const raw = m[0].replace(/[).,!?;:]+$/, '');
  const url = normalizeUrl(raw);
  // Вирізаємо весь збіг разом із хвостом: «(…).» не має лишитись у назві.
  return url ? { url, start: m.index, end: m.index + m[0].length } : null;
}

/** Рядок, який сам є адресою, назвою не вважаємо. */
function looksLikeUrl(s: string): boolean {
  return /^(https?:\/\/|www\.)\S+$/i.test(s);
}

export function fromShare(params: { title?: string | null; text?: string | null; url?: string | null }): Shared {
  const text = (params.text ?? '').trim();
  const fromUrl = params.url?.trim() ? normalizeUrl(params.url.trim()) : null;
  const inText = urlIn(text);
  const url = fromUrl ?? inText?.url ?? null;

  // Решта тексту без адреси — назва, якщо окремої назви не передали.
  const rest = inText ? `${text.slice(0, inText.start)} ${text.slice(inText.end)}` : text;
  let title = (params.title ?? '').trim() || rest;
  title = title.replace(/\s+/g, ' ').replace(/[\s:–—(-]+$/, '').trim();
  if (looksLikeUrl(title)) title = '';

  return {
    url: url && url.length <= ITEM_URL_MAX ? url : null,
    title: title ? title.slice(0, ITEM_TITLE_MAX) : null,
  };
}

/** Позначка Команди для iPhone (ROADMAP 8.5, ADR-077): адреса в `url` — сирим хвостом. */
export const IOS_SOURCE = 'ios';

/**
 * Початок адреси, який людина вставляє в Команду для iPhone. Одразу за ним
 * Команда дописує адресу сторінки як є, без кодування: так у Команді одна
 * дія замість трьох, а `rawSharedUrl` збирає адресу назад.
 */
export function iosShortcutPrefix(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/add?src=${IOS_SOURCE}&url=`;
}

/**
 * Адреса з Команди: усе після першого `url=` у сирому `search`, разом із
 * власними `?`, `&` і `#` сторінки магазину, які інакше розсипались би на
 * окремі параметри. Закодовану адресу (`https%3A%2F%2F…`) розкодовуємо.
 * `null` — адреса не від Команди: тоді діє звичайне `fromShare`.
 */
export function rawSharedUrl(search: string, hash = ''): string | null {
  const q = new URLSearchParams(search);
  if (q.get('src') !== IOS_SOURCE) return null;
  const at = search.indexOf('url=');
  if (at < 0) return null;
  let raw = search.slice(at + 4) + hash;
  if (/^https?%3A/i.test(raw)) {
    try {
      raw = decodeURIComponent(raw);
    } catch {
      return null;
    }
  }
  return raw.trim() || null;
}

/** Список, куди додавали востаннє, — пропонуємо його першим (L3). Id списку — не таємниця. */
const LAST_LIST_KEY = 'wl.v2.lastList';

export function readLastList(): string | null {
  try {
    return localStorage.getItem(LAST_LIST_KEY);
  } catch {
    return null;
  }
}

export function writeLastList(id: string) {
  try {
    localStorage.setItem(LAST_LIST_KEY, id);
  } catch {
    /* приватний режим — наступного разу запропонуємо перший список */
  }
}
