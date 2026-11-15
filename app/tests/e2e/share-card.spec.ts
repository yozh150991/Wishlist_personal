import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { CARD_HEADERS, handleCard } from '../../api/card';
import { CARD_BOTS_PATTERN, escapeHtml, isCardBot, renderCard, tokenFromPath } from '../../src/lib/shareCard';

/**
 * Картка посилання для ботів месенджерів (потік W2, ADR-060) — без браузера.
 * Що `get_share_card` віддає лише назву, дату й мову, стереже pgTAP 20.
 */

const ORIGIN = 'https://wishlist-personal.vercel.app';
const DATA = { title: 'Різдво в Кракові', event_date: '2026-12-24', locale: 'uk' };

test('ключ гостя й відписка в токен не потрапляють', () => {
  expect(tokenFromPath('/l/abcDEF_123-x')).toEqual({ prefix: 'l', token: 'abcDEF_123-x' });
  expect(tokenFromPath('/l/abcDEF_123-x/g/secretGuestKey0000000000')).toEqual({ prefix: 'l', token: 'abcDEF_123-x' });
  expect(tokenFromPath('/s/tok/u/mailToken')).toEqual({ prefix: 's', token: 'tok' });
  expect(tokenFromPath('/lists/abc')).toBeNull();
  expect(tokenFromPath('/l/<script>')).toBeNull();
});

test('картка живого посилання: назва, «Список бажань · дата», адреса без ключа', () => {
  const html = renderCard(DATA, { origin: ORIGIN, prefix: 'l', token: 'tok123' });
  expect(html).toContain('<meta property="og:title" content="Різдво в Кракові">');
  expect(html).toContain('<meta property="og:description" content="Список бажань · 24 грудня 2026 р.">');
  expect(html).toContain(`<meta property="og:url" content="${ORIGIN}/l/tok123">`);
  expect(html).toContain(`<meta property="og:image" content="${ORIGIN}/icons/icon-512.png">`);
  expect(html).toContain('noindex');
});

test('мова картки — мова власника', () => {
  const pl = renderCard({ ...DATA, locale: 'pl' }, { origin: ORIGIN, prefix: 'l', token: 't' });
  expect(pl).toContain('<html lang="pl">');
  expect(pl).toMatch(/Lista życzeń · 24 grudnia 2026/);
  const en = renderCard({ ...DATA, locale: 'en', event_date: null }, { origin: ORIGIN, prefix: 'l', token: 't' });
  expect(en).toContain('content="Wish list"');
});

test('мертве посилання — загальна картка без подробиць', () => {
  const html = renderCard(null, { origin: ORIGIN, prefix: 'l', token: 'dead' });
  expect(html).toContain('<meta property="og:title" content="Wishlist">');
  expect(html).toContain('Список бажань у Wishlist');
});

test('назва від власника екранується', () => {
  const html = renderCard({ ...DATA, title: '"><script>alert(1)</script>' }, { origin: ORIGIN, prefix: 'l', token: 't' });
  expect(html).not.toContain('<script>');
  expect(html).toContain(escapeHtml('"><script>alert(1)</script>'));
});

test('боти месенджерів — так, браузери — ні', () => {
  expect(isCardBot('TelegramBot (like TwitterBot)')).toBe(true);
  expect(isCardBot('WhatsApp/2.23.20.0 A')).toBe(true);
  expect(isCardBot('facebookexternalhit/1.1 Facebot Twitterbot/1.0')).toBe(true);
  expect(isCardBot('Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 Chrome/129 Mobile Safari/537.36')).toBe(false);
  expect(isCardBot(null)).toBe(false);
});

test('vercel.json переписує /l/ і /s/ для тих самих ботів, що й CARD_BOTS', () => {
  const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8'));
  const cards = vercel.rewrites.filter((r: { destination: string }) => r.destination.startsWith('/api/card'));
  expect(cards.map((r: { source: string }) => r.source).sort()).toEqual(['/l/:token/:rest*', '/s/:token/:rest*']);
  for (const r of cards) expect(r.has).toEqual([{ type: 'header', key: 'user-agent', value: CARD_BOTS_PATTERN }]);
  // Переписування для ботів — раніше за загальне на index.html, і /api/ туди не потрапляє.
  const last = vercel.rewrites.at(-1);
  expect(last.destination).toBe('/index.html');
  expect(new RegExp(`^${last.source.replace('/(', '/(?:')}$`).test('/api/card')).toBe(false);
});

test('функція: бере дані з get_share_card і віддає HTML; збій бази — загальна картка', async () => {
  const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
  const ok = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body), headers: init.headers as Record<string, string> });
    return new Response(JSON.stringify(DATA), { status: 200 });
  }) as unknown as typeof fetch;
  const env = { url: 'https://ref.supabase.co/', key: 'sb_publishable_x' };

  const res = await handleCard(new Request(`${ORIGIN}/api/card?p=l&t=tok123`), env, ok);
  expect(res.headers.get('content-type')).toContain('text/html');
  expect(res.headers.get('x-robots-tag')).toContain('noindex');
  expect(await res.text()).toContain('og:title" content="Різдво в Кракові"');
  expect(calls[0]!.url).toBe('https://ref.supabase.co/rest/v1/rpc/get_share_card');
  expect(JSON.parse(calls[0]!.body)).toEqual({ p_token: 'tok123' });
  expect(calls[0]!.headers.apikey).toBe('sb_publishable_x');

  const broken = (async () => new Response('oops', { status: 500 })) as unknown as typeof fetch;
  const fallback = await handleCard(new Request(`${ORIGIN}/api/card?p=s&t=tok123`), env, broken);
  expect(await fallback.text()).toContain('og:title" content="Wishlist"');

  const noToken = await handleCard(new Request(`${ORIGIN}/api/card?t=%3Cbad%3E`), env, ok);
  expect(await noToken.text()).toContain('og:title" content="Wishlist"');
  expect(calls).toHaveLength(1);
});

/**
 * Картка не кешується (доповнення до ADR-060). Бот і людина питають ту саму
 * адресу `/l/{токен}`; якби відповідь бота лягла в спільний кеш Vercel під цією
 * адресою, людина слідом за ботом побачила б картку замість застосунку.
 */
const SHARED_CACHE = /s-maxage|public|stale-while-revalidate|stale-if-error/i;

function expectNoSharedCache(res: Response, branch: string) {
  expect(res.status, branch).toBe(200);
  expect(res.headers.get('cache-control'), branch).toBe('private, no-store');
  expect(res.headers.get('cache-control') ?? '', branch).not.toMatch(SHARED_CACHE);
  // Сильніші за `private`: з ними Vercel кешував би попри Cache-Control.
  expect(res.headers.get('cdn-cache-control'), branch).toBeNull();
  expect(res.headers.get('vercel-cdn-cache-control'), branch).toBeNull();
  expect((res.headers.get('vary') ?? '').toLowerCase(), branch).toContain('user-agent');
  expect(res.headers.get('x-robots-tag'), branch).toContain('noindex');
  expect(res.headers.get('content-type'), branch).toContain('text/html');
}

test('жодна гілка функції не кладе картку в спільний кеш', async () => {
  const env = { url: 'https://ref.supabase.co', key: 'sb_publishable_x' };
  const live = (async () => new Response(JSON.stringify(DATA), { status: 200 })) as unknown as typeof fetch;
  // Мертве, відкликане й неіснуюче посилання для функції однакові: `null` від get_share_card.
  const dead = (async () => new Response('null', { status: 200 })) as unknown as typeof fetch;
  const broken = (async () => new Response('oops', { status: 500 })) as unknown as typeof fetch;
  const hangs = (async () => {
    throw new DOMException('timeout', 'TimeoutError');
  }) as unknown as typeof fetch;
  const bot = { 'user-agent': 'TelegramBot (like TwitterBot)' };
  const human = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1' };
  const card = `${ORIGIN}/api/card?p=l&t=tok123`;

  const branches: [string, Response][] = [
    ['живе посилання', await handleCard(new Request(card, { headers: bot }), env, live)],
    ['мертве посилання', await handleCard(new Request(card, { headers: bot }), env, dead)],
    ['збій бази', await handleCard(new Request(card, { headers: bot }), env, broken)],
    ['база не відповіла', await handleCard(new Request(card, { headers: bot }), env, hangs)],
    ['немає змінних оточення', await handleCard(new Request(card, { headers: bot }), {}, live)],
    ['зіпсований токен', await handleCard(new Request(`${ORIGIN}/api/card?t=%3Cbad%3E`, { headers: bot }), env, live)],
    ['без токена', await handleCard(new Request(`${ORIGIN}/api/card`, { headers: bot }), env, live)],
    ['старий префікс /s/', await handleCard(new Request(`${ORIGIN}/api/card?p=s&t=tok123`, { headers: bot }), env, live)],
    ['людина прямо на /api/card', await handleCard(new Request(card, { headers: human }), env, live)],
    ['людина на /api/card з мертвим токеном', await handleCard(new Request(card, { headers: human }), env, dead)],
  ];
  for (const [branch, res] of branches) expectNoSharedCache(res, branch);

  // Заголовки — ті самі в кожній гілці, і це рівно CARD_HEADERS: нової гілки з власним кешем немає.
  for (const [branch, res] of branches) {
    expect(Object.fromEntries(res.headers), branch).toEqual({ ...CARD_HEADERS });
  }
});

test('мертве посилання не відрізнити від збою бази чи тиші: та сама відповідь до байта', async () => {
  const env = { url: 'https://ref.supabase.co', key: 'sb_publishable_x' };
  const req = () => new Request(`${ORIGIN}/api/card?p=l&t=tok123`);
  const answers = [
    (async () => new Response('null', { status: 200 })) as unknown as typeof fetch,
    (async () => new Response('oops', { status: 500 })) as unknown as typeof fetch,
    (async () => new Response(JSON.stringify({ message: 'not_found' }), { status: 404 })) as unknown as typeof fetch,
    (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch,
  ];
  const seen = new Set<string>();
  for (const answer of answers) {
    const res = await handleCard(req(), env, answer);
    seen.add(JSON.stringify([res.status, [...res.headers].sort(), await res.text()]));
  }
  expect(seen.size).toBe(1);
  expect([...seen][0]).toContain('og:title\\" content=\\"Wishlist\\"');
});

test('vercel.json не вмикає спільний кеш ні гостьовим адресам, ні функції картки', () => {
  const vercel = JSON.parse(readFileSync(new URL('../../vercel.json', import.meta.url), 'utf8')) as {
    headers: { source: string; headers: { key: string; value: string }[] }[];
  };
  // Джерела в vercel.json — синтаксис path-to-regexp; тут вистачає груп і `:назва`.
  const matches = (source: string, path: string) =>
    new RegExp(`^${source.replace(/:\w+\*/g, '.*').replace(/:\w+/g, '[^/]+')}$`).test(path);
  const paths = ['/l/tok123', '/l/tok123/g/key', '/l/tok123/u/mail', '/s/tok123', '/s/tok123/g/key', '/api/card'];
  for (const rule of vercel.headers) {
    const hit = paths.filter((p) => matches(rule.source, p));
    if (!hit.length) continue;
    for (const h of rule.headers) {
      const key = h.key.toLowerCase();
      const where = `${rule.source} → ${h.key}`;
      expect(['cdn-cache-control', 'vercel-cdn-cache-control'], where).not.toContain(key);
      if (key === 'cache-control') expect(h.value, where).not.toMatch(SHARED_CACHE);
    }
  }
  // Сама перевірка бачить правила: загальне `/(.*)` і обидва гостьові префікси.
  expect(vercel.headers.filter((r) => paths.some((p) => matches(r.source, p))).map((r) => r.source).sort()).toEqual(
    ['/(.*)', '/l/(.*)', '/s/(.*)'],
  );
});
