import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/**
 * Словник лише активної мови (ROADMAP 8.24).
 *
 * Запуск: `npx vite build && npm run test:sw` — на зібраному застосунку: лише
 * там словники лежать окремими чанками `locale-<мова>-*.js` і є Service
 * Worker для перемикання без мережі. База не потрібна: гостьові RPC
 * підставлено нижче, а `/login` до бази не ходить, поки не натиснути «Увійти».
 */

type Dict = Record<string, unknown>;
const dict = (l: string) => JSON.parse(readFileSync(new URL(`../../src/i18n/${l}.json`, import.meta.url), 'utf8')) as Dict;
const DICTS = { uk: dict('uk'), pl: dict('pl'), en: dict('en') };
type Locale = keyof typeof DICTS;

function text(locale: Locale, path: string): string {
  let node: unknown = DICTS[locale];
  for (const part of path.split('.')) node = (node as Dict)[part];
  if (typeof node !== 'string') throw new Error(`немає ключа ${path}`);
  return node;
}

const guestList = {
  title: 'Новосілля', message: null, currency: 'PLN', event_date: '2026-10-10',
  expires_at: null, expires_tz: null, owner_scheme: null, appearance_hue: null,
  hide_prices: false, allow_reservations: false, archived: false, viewer_is_owner: false,
  guest: null, sections: [], items: [],
};

async function stubGuest(page: Page) {
  await page.route('**/rpc/get_guest_list', (route) => route.fulfill({ json: guestList }));
  await page.route('**/rpc/register_share_view', (route) => route.fulfill({ status: 204, body: '' }));
}

/** Мови, чиї словники сторінка попросила (з мережі чи з кешу Service Worker). */
function watchLocales(page: Page): Locale[] {
  const seen: Locale[] = [];
  page.on('request', (r) => {
    const m = /\/assets\/locale-(uk|pl|en)-[^/]+\.js$/.exec(new URL(r.url()).pathname);
    if (m) seen.push(m[1] as Locale);
  });
  return seen;
}

const htmlLang = (page: Page) => page.evaluate(() => document.documentElement.lang);
const langSelect = (page: Page) => page.locator('select.v2-lang__select');

test.describe('польська з першого відкриття', () => {
  test.use({ locale: 'pl-PL' });

  test('/login: качає лише польський словник', async ({ page }) => {
    const seen = watchLocales(page);
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1, name: text('pl', 'v2auth.login.title') })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(seen).toEqual(['pl']);
    expect(await htmlLang(page)).toBe('pl');
    await expect(page).toHaveTitle(`${text('pl', 'auth.login.title')} · Wishlist`);
  });

  test('/login: перемикання на англійську довантажує її й перекладає вхід', async ({ page }) => {
    const seen = watchLocales(page);
    await page.goto('/login');
    await expect(page.getByRole('heading', { level: 1, name: text('pl', 'v2auth.login.title') })).toBeVisible();

    await langSelect(page).selectOption('en');
    await expect(page.getByRole('heading', { level: 1, name: text('en', 'v2auth.login.title') })).toBeVisible();
    await expect(langSelect(page)).toHaveValue('en');
    expect(await htmlLang(page)).toBe('en');
    await expect(page).toHaveTitle(`${text('en', 'auth.login.title')} · Wishlist`);
    expect(await page.evaluate(() => localStorage.getItem('wl.locale'))).toBe('en');
    expect(seen).toEqual(['pl', 'en']);

    // Вибір запамʼятовано: після перезавантаження — одразу англійська, без польської.
    seen.length = 0;
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: text('en', 'v2auth.login.title') })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(seen).toEqual(['en']);
  });

  test('гостьова: лише польський словник, перемикач у підвалі перекладає сторінку', async ({ page }) => {
    const seen = watchLocales(page);
    await stubGuest(page);
    await page.goto('/l/locale-test-token');
    await expect(page.getByRole('heading', { level: 1, name: 'Новосілля' })).toBeVisible();
    await page.waitForLoadState('networkidle');
    expect(seen).toEqual(['pl']);
    expect(await htmlLang(page)).toBe('pl');
    await expect(page.getByLabel(text('pl', 'v2guest.language'))).toHaveValue('pl');

    await langSelect(page).selectOption('uk');
    await expect(page.getByLabel(text('uk', 'v2guest.language'))).toHaveValue('uk');
    expect(await htmlLang(page)).toBe('uk');
    expect(seen).toEqual(['pl', 'uk']);
    // Гостьова Service Worker не отримує й після перемикання (ADR-084).
    expect(await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0);
  });

  test('гостьова без мережі: мова, якої ще не качали, не вмикається — сторінка лишається польською', async ({ page, context }) => {
    const seen = watchLocales(page);
    await stubGuest(page);
    await page.goto('/l/locale-test-token');
    await expect(page.getByRole('heading', { level: 1, name: 'Новосілля' })).toBeVisible();
    await page.waitForLoadState('networkidle');

    await context.setOffline(true);
    await langSelect(page).selectOption('en');
    await expect.poll(() => seen.filter((l) => l === 'en').length).toBe(1);
    await page.waitForTimeout(300);
    await expect(langSelect(page)).toHaveValue('pl');
    expect(await htmlLang(page)).toBe('pl');
    await expect(page.getByRole('heading', { level: 1, name: 'Новосілля' })).toBeVisible();
    await expect(page.getByLabel(text('pl', 'v2guest.language'))).toBeVisible();
    // Невдалий вибір не запамʼятовано: наступне відкриття не почнеться з мови, якої немає.
    expect(await page.evaluate(() => localStorage.getItem('wl.locale'))).toBeNull();

    // Мережа повернулась. Невдалий `import()` браузер памʼятає до кінця життя
    // сторінки (Chrome не повторює запит), тож мова вмикається після
    // перезавантаження — і стан після невдачі цьому не заважає.
    await context.setOffline(false);
    await page.reload();
    await expect(page.getByLabel(text('pl', 'v2guest.language'))).toHaveValue('pl');
    await langSelect(page).selectOption('en');
    await expect(page.getByLabel(text('en', 'v2guest.language'))).toHaveValue('en');
    expect(await htmlLang(page)).toBe('en');
  });
});

test('застосунок без мережі: інша мова вмикається з кешу Service Worker', async ({ page, context }) => {
  await page.goto('/login');
  // Перший візит ставить Service Worker і кладе оболонку в кеш; сторінку він
  // бере під контроль із наступного завантаження.
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload();
  await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 15_000 }).toBe(true);
  const fromSw: Locale[] = [];
  page.on('response', (r) => {
    const m = /\/assets\/locale-(uk|pl|en)-[^/]+\.js$/.exec(new URL(r.url()).pathname);
    if (m && r.fromServiceWorker()) fromSw.push(m[1] as Locale);
  });

  await context.setOffline(true);
  const start = (await htmlLang(page)) as Locale;
  const target: Locale = start === 'pl' ? 'en' : 'pl';
  await langSelect(page).selectOption(target);
  await expect(page.getByRole('heading', { level: 1, name: text(target, 'v2auth.login.title') })).toBeVisible();
  expect(await htmlLang(page)).toBe(target);
  expect(fromSw).toContain(target);
});
