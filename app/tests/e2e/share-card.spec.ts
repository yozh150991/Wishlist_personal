import { readFileSync } from 'node:fs';
import { test, expect } from '@playwright/test';
import { handleCard } from '../../api/card';
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
