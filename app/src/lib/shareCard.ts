/**
 * Картка гостьового посилання для ботів месенджерів (потік W2, ADR-060).
 *
 * Telegram, Viber, WhatsApp та інші, коли людина вставляє посилання, самі
 * відкривають його й читають метатеги. Застосунок односторінковий, тож без
 * цього всі посилання виглядали б однаково — загальним описом з `index.html`.
 * Vercel за user-agent переписує `/l/…` і `/s/…` для таких ботів на
 * `api/card.ts`, а та віддає цю сторінку.
 *
 * Що можна й чого не можна (CLAUDE.md §3):
 * - лише назва посилання (її власник сам дав гостям), дата події й мова
 *   власника — з `get_share_card`; ні позицій, ні цін, ні позначок;
 * - ключ гостя з `/l/{токен}/g/{ключ}` у картку не йде: `og:url` — без нього;
 * - мертве й неіснуюче посилання — однакова загальна картка (ADR-035, п. 7);
 * - усе, що прийшло від власника, екранується: цю сторінку може побачити й
 *   людина з підробленим user-agent.
 *
 * Модуль чистий — без DOM і без Supabase: його імпортує edge-функція, а
 * тести перевіряють без браузера.
 */

export type CardLocale = 'uk' | 'pl' | 'en';

export type CardData = {
  title: string;
  event_date: string | null;
  locale: string | null;
};

/** Боти, що будують картки посилань. Людям — звичайний застосунок. */
export const CARD_BOTS = [
  'TelegramBot',
  'Viber',
  'WhatsApp',
  'facebookexternalhit',
  'Facebot',
  'Twitterbot',
  'Slackbot',
  'Discordbot',
  'LinkedInBot',
  'SkypeUriPreview',
  'vkShare',
  'redditbot',
  'Iframely',
  'Embedly',
  'Mastodon',
] as const;

/** Регулярний вираз для `has` у vercel.json — та сама множина ботів. */
export const CARD_BOTS_PATTERN = `(.*)(${CARD_BOTS.join('|')})(.*)`;

export function isCardBot(userAgent: string | null | undefined): boolean {
  if (!userAgent) return false;
  return CARD_BOTS.some((b) => userAgent.includes(b));
}

const TEXT: Record<CardLocale, { kind: string; generic: string }> = {
  uk: { kind: 'Список бажань', generic: 'Список бажань у Wishlist' },
  pl: { kind: 'Lista życzeń', generic: 'Lista życzeń w Wishlist' },
  en: { kind: 'Wish list', generic: 'A wish list on Wishlist' },
};

const HTML_LANG: Record<CardLocale, string> = { uk: 'uk', pl: 'pl', en: 'en' };
const OG_LOCALE: Record<CardLocale, string> = { uk: 'uk_UA', pl: 'pl_PL', en: 'en_US' };

function cardLocale(value: string | null | undefined): CardLocale {
  return value === 'pl' || value === 'en' ? value : 'uk';
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Токен з адреси `/l/{токен}…` чи `/s/{токен}…`. Лише перший сегмент:
 * `/g/{ключ}` і відписка `/u/{…}` нікуди далі не йдуть.
 */
export function tokenFromPath(path: string): { prefix: 'l' | 's'; token: string } | null {
  const m = /^\/(l|s)\/([A-Za-z0-9_-]{1,128})(?:\/|$)/.exec(path);
  return m ? { prefix: m[1] as 'l' | 's', token: m[2]! } : null;
}

/** День події словом мовою власника: «24 грудня 2026 р.» — для бота рік завжди. */
function eventDay(isoDate: string | null, locale: CardLocale): string | null {
  const m = isoDate ? /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate) : null;
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat(HTML_LANG[locale], {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(d);
}

/**
 * Сторінка з метатегами. `data` — null для мертвого чи неіснуючого
 * посилання: тоді загальна картка без жодних подробиць.
 */
export function renderCard(
  data: CardData | null,
  opts: { origin: string; prefix: 'l' | 's'; token: string },
): string {
  const locale = cardLocale(data?.locale);
  const t = TEXT[locale];
  const title = data?.title?.trim() || 'Wishlist';
  const day = data ? eventDay(data.event_date, locale) : null;
  const description = data ? [t.kind, day].filter(Boolean).join(' · ') : t.generic;
  const origin = opts.origin.replace(/\/+$/, '');
  // Без ключа гостя: у картці лише спільна адреса посилання.
  const url = `${origin}/${opts.prefix}/${opts.token}`;
  const image = `${origin}/icons/icon-512.png`;
  const e = escapeHtml;

  return [
    '<!doctype html>',
    `<html lang="${HTML_LANG[locale]}">`,
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="robots" content="noindex, nofollow, noarchive">',
    `<title>${e(title)}</title>`,
    `<meta name="description" content="${e(description)}">`,
    '<meta property="og:type" content="website">',
    '<meta property="og:site_name" content="Wishlist">',
    `<meta property="og:locale" content="${OG_LOCALE[locale]}">`,
    `<meta property="og:title" content="${e(title)}">`,
    `<meta property="og:description" content="${e(description)}">`,
    `<meta property="og:url" content="${e(url)}">`,
    `<meta property="og:image" content="${e(image)}">`,
    '<meta property="og:image:width" content="512">',
    '<meta property="og:image:height" content="512">',
    '<meta name="twitter:card" content="summary">',
    `<meta name="twitter:title" content="${e(title)}">`,
    `<meta name="twitter:description" content="${e(description)}">`,
    '</head>',
    '<body>',
    `<h1>${e(title)}</h1>`,
    `<p>${e(description)}</p>`,
    `<p><a href="${e(url)}">${e(url)}</a></p>`,
    '</body>',
    '</html>',
  ].join('\n');
}
