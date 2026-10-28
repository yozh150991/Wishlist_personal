/**
 * Кнопка «У вішліст» на панелі закладок браузера (букмарклет; ROADMAP 8.4,
 * ADR-076).
 *
 * Allegro, Amazon й OLX часто не пускають наш парсер: сторінку бачить людина,
 * а сервер — захист від ботів. Букмарклет читає вже відкриту сторінку в
 * браузері людини тими ж загальними джерелами, що й парсер (опис товару
 * JSON-LD `Product`, далі Open Graph і `<title>`), і відкриває `/add` з
 * назвою, ціною, валютою й фото в адресі. Правил під окремі магазини немає.
 *
 * Дві половини:
 * - `pageGrab` виконується **на сторінці магазину**, тож не має права ні на
 *   що з цього модуля: лише власні змінні й API браузера. Текст функції
 *   (`toString`) і є кодом закладки — її не можна розбивати на помічники;
 * - `fromPage` виконується **в застосунку**: усе з адреси — дані чужої
 *   сторінки, тож кожне поле проходить ті самі межі, що й ручне введення.
 */
import { CURRENCIES } from './types';
import type { Currency } from './types';
import { ITEM_TITLE_MAX, ITEM_URL_MAX, normalizeUrl, parsePrice } from './itemsView';

/** Позначка в адресі `/add`: поля прийшли з відкритої сторінки, а не з «Поділитися». */
export const PAGE_SOURCE = 'page';

/**
 * Код закладки. Виконується на сторінці магазину: збирає назву, ціну, валюту
 * й фото і відкриває `{origin}/add?src=page&…` у новій вкладці (браузер
 * заблокував — у цій же). Нічого не надсилає нікуди, крім адреси вкладки.
 */
export function pageGrab(origin: string): void {
  var d = document;
  var name = '';
  var price = '';
  var cur = '';
  var img = '';
  var steps = 0;
  var str = function (v: unknown): string {
    return typeof v === 'string' ? v.trim() : typeof v === 'number' && isFinite(v) ? String(v) : '';
  };
  var imgOf = function (v: unknown): string {
    if (Array.isArray(v)) return v.length ? imgOf(v[0]) : '';
    if (v && typeof v === 'object') {
      var o = v as { url?: unknown; contentUrl?: unknown };
      return str(o.url) || str(o.contentUrl);
    }
    return str(v);
  };
  var offerOf = function (v: unknown): void {
    var list = ([] as unknown[]).concat(v || []);
    for (var j = 0; j < list.length && !price; j++) {
      var of = list[j] as Record<string, unknown> | null;
      if (!of || typeof of !== 'object') continue;
      var spec = of.priceSpecification as Record<string, unknown> | undefined;
      var p = str(of.price) || str(of.lowPrice) || (spec && typeof spec === 'object' ? str(spec.price) : '');
      if (p) {
        price = p;
        cur = str(of.priceCurrency) || (spec && typeof spec === 'object' ? str(spec.priceCurrency) : '');
      }
    }
  };
  var walk = function (n: unknown): void {
    if (!n || typeof n !== 'object' || name || steps++ > 500) return;
    if (Array.isArray(n)) {
      for (var i = 0; i < n.length; i++) walk(n[i]);
      return;
    }
    var o = n as Record<string, unknown>;
    var types = ([] as unknown[]).concat(o['@type'] || []);
    if (types.indexOf('Product') >= 0 || types.indexOf('ProductGroup') >= 0) {
      name = str(o.name);
      img = imgOf(o.image);
      offerOf(o.offers);
      // Група варіантів: ціна — у першого варіанта з пропозицією.
      var variants = ([] as unknown[]).concat(o.hasVariant || []);
      for (var k = 0; k < variants.length && !price; k++) {
        var vr = variants[k] as Record<string, unknown> | null;
        if (vr && typeof vr === 'object') {
          offerOf(vr.offers);
          if (!img) img = imgOf(vr.image);
        }
      }
      return;
    }
    walk(o['@graph']);
    walk(o.mainEntity);
  };
  var meta = function (k: string): string {
    var e = d.querySelector('meta[property="' + k + '"],meta[name="' + k + '"],meta[itemprop="' + k + '"]');
    return e ? (e.getAttribute('content') || '').trim() : '';
  };

  var blocks = d.querySelectorAll('script[type="application/ld+json"]');
  for (var b = 0; b < blocks.length && !name; b++) {
    try {
      walk(JSON.parse(blocks[b]!.textContent || ''));
    } catch (e) {
      /* зіпсований блок — беремо наступний */
    }
  }
  // Назва з JSON-LD — текст скрипта, сутностей браузер у ньому не розкодовує
  // (Amazon: «M&eogon;ska»). textarea розкодовує їх без розбору тегів; на
  // сторінках із Trusted Types присвоєння кидає — тоді лишаємо як є.
  if (name && /&[#a-z0-9]+;/i.test(name)) {
    try {
      var ta = d.createElement('textarea');
      ta.innerHTML = name;
      name = ta.value;
    } catch (e) {
      /* лишаємо як є */
    }
  }
  // Без розмітки (Amazon, Decathlon у браузері людини, 28 жовтня) — заголовок
  // сторінки `h1`: у `<title>` магазини дописують хвіст («: Amazon.pl: …»).
  var h1 = d.querySelector('h1');
  var h1Text = h1 ? (h1.textContent || '').replace(/\s+/g, ' ').trim() : '';
  name = name || meta('og:title') || meta('twitter:title') || (h1Text.length <= 300 ? h1Text : '') || d.title.trim();
  if (!price) {
    price = meta('product:price:amount') || meta('og:price:amount') || meta('price');
    cur = meta('product:price:currency') || meta('og:price:currency') || meta('priceCurrency');
  }
  img = img || meta('og:image:secure_url') || meta('og:image') || meta('twitter:image');

  // Остання надія — те, що бачить людина (ADR-078). Без правил під магазини:
  // ціна — найбільша видима ціна у верхній частині сторінки (головна ціна
  // товару найпомітніша, ціни рекомендацій дрібніші й нижче; закреслені —
  // стара ціна — не беремо); фото — найбільше видиме зображення там само.
  // Людина бачить обидва у формі й може виправити.
  var view = (window.innerHeight || 800) * 2;
  var scrollTop = window.scrollY || 0;
  if (!price) {
    var SIGNS = [['zł', 'PLN'], ['pln', 'PLN'], ['₴', 'UAH'], ['грн', 'UAH'], ['uah', 'UAH'], ['€', 'EUR'], ['eur', 'EUR'], ['$', 'USD'], ['usd', 'USD']];
    var NUM = /\d{1,3}(?:[ \u00a0\u202f.]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d{1,2})?/;
    var best = 0;
    var bestTop = 0;
    var cands = d.querySelectorAll('[itemprop="price"],[class*="price" i],[id*="price" i],[data-testid*="price" i]');
    for (var c = 0; c < cands.length && c < 400; c++) {
      var el = cands[c] as HTMLElement;
      if (el.closest('s,del,strike')) continue;
      var cs = getComputedStyle(el);
      if ((cs.textDecorationLine || '').indexOf('line-through') >= 0) continue;
      var r = el.getBoundingClientRect();
      var top = r.top + scrollTop;
      if (r.width < 2 || r.height < 2 || top > view || r.right < 0) continue;
      var tx = ((el.getAttribute('itemprop') === 'price' && el.getAttribute('content')) || el.innerText || '').replace(/\s+/g, ' ').trim();
      if (!tx || tx.length > 60) continue;
      var m = tx.match(NUM);
      if (!m) continue;
      var low = tx.toLowerCase();
      var sign = '';
      for (var s = 0; s < SIGNS.length && !sign; s++) if (low.indexOf(SIGNS[s]![0]!) >= 0) sign = SIGNS[s]![1]!;
      // Число без знака валюти й без копійок — це, найімовірніше, не ціна («365+»).
      if (!sign && !/\d[.,]\d{2}(?!\d)/.test(m[0]) && el.getAttribute('itemprop') !== 'price') continue;
      var size = parseFloat(cs.fontSize) || 0;
      var struck = false;
      var kids = el.querySelectorAll('*');
      for (var k2 = 0; k2 < kids.length && k2 < 20; k2++) {
        var ks = getComputedStyle(kids[k2]!);
        // Блок зі старою (закресленою) ціною всередині — не наш: нова ціна має свій елемент.
        if ((ks.textDecorationLine || '').indexOf('line-through') >= 0 || kids[k2]!.matches('s,del,strike')) struck = true;
        size = Math.max(size, parseFloat(ks.fontSize) || 0);
      }
      if (struck) continue;
      if (size > best || (size === best && top < bestTop)) {
        best = size;
        bestTop = top;
        price = m[0];
        cur = sign;
      }
    }
  }
  if (!img) {
    var area = 0;
    for (var g = 0; g < d.images.length && g < 300; g++) {
      var im = d.images[g]!;
      var ir = im.getBoundingClientRect();
      var src = im.currentSrc || im.src;
      if (ir.width < 120 || ir.height < 120 || ir.top + scrollTop > view || !/^https:/.test(src)) continue;
      if (ir.width * ir.height > area) {
        area = ir.width * ir.height;
        img = src;
      }
    }
  }
  try {
    img = img ? new URL(img, location.href).href : '';
  } catch (e) {
    img = '';
  }

  var q = new URLSearchParams();
  q.set('src', 'page');
  q.set('url', location.href.split('#')[0]!);
  if (name) q.set('title', name.replace(/\s+/g, ' ').slice(0, 300));
  if (price) q.set('price', price.slice(0, 40));
  if (cur) q.set('currency', cur.slice(0, 8));
  if (img && img.length <= 2048) q.set('image', img);
  var target = origin.replace(/\/+$/, '') + '/add?' + q.toString();
  var w = window.open(target, '_blank');
  if (!w) location.href = target;
}

/** Адреса закладки: `javascript:` з кодом `pageGrab` і адресою застосунку. */
export function bookmarkletHref(origin: string): string {
  const code = `(${pageGrab.toString()})(${JSON.stringify(origin)});void 0`;
  return `javascript:${encodeURIComponent(code)}`;
}

export type FromPage = {
  title: string | null;
  price: number | null;
  /** Лише знайома валюта; незнайома — ціни немає зовсім (як у парсера, ADR-051). */
  currency: Currency | null;
  image: string | null;
};

/**
 * Поля з адреси `/add?src=page&…`. `null` — адреса не від букмарклета (тоді
 * це звичайне «Поділитися»). Назва й ціна проходять ті самі межі, що й форма;
 * фото — лише `https:` (інакше браузер заблокує змішаний вміст) у межах
 * довжини поля.
 */
export function fromPage(q: URLSearchParams): FromPage | null {
  if (q.get('src') !== PAGE_SOURCE) return null;
  const title = (q.get('title') ?? '').replace(/\s+/g, ' ').trim().slice(0, ITEM_TITLE_MAX) || null;

  const currencyRaw = (q.get('currency') ?? '').trim().toUpperCase();
  const known = CURRENCIES.find((c) => c === currencyRaw) ?? null;
  const parsed = parsePrice((q.get('price') ?? '').trim());
  // Ціна в чужій валюті без курсу нічого не варта: 25 £ не стануть злотими.
  const usable = parsed.value !== null && parsed.value > 0 && (currencyRaw === '' || known !== null);

  const imageRaw = (q.get('image') ?? '').trim();
  const imageUrl = imageRaw ? normalizeUrl(imageRaw) : null;
  const image = imageUrl && imageUrl.startsWith('https://') && imageUrl.length <= ITEM_URL_MAX ? imageUrl : null;

  return {
    title,
    price: usable ? parsed.value : null,
    currency: usable ? known : null,
    image,
  };
}
