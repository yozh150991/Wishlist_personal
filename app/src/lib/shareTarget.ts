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
