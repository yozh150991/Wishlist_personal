import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Service Worker — лише для застосунку, не для гостя (ROADMAP 8.22).
 *
 * Запуск: `npx vite build && npm run test:sw` — на зібраному застосунку, бо в
 * режимі розробки Service Worker вимкнено. База не потрібна: гостьові RPC
 * підставлено нижче.
 */

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

/** Запити, яких гість робити не має: сам Service Worker і код його реєстрації. */
function watchSwRequests(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (r) => {
    const { pathname } = new URL(r.url());
    if (pathname === '/sw.js' || /workbox/.test(pathname)) seen.push(pathname);
  });
  return seen;
}

const registrations = (page: Page) => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length);

async function openGuest(page: Page, path: string) {
  await page.goto(path);
  await expect(page).toHaveURL(/\/l\/sw-test-token$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Новосілля' })).toBeVisible();
  // Реєстрація, якби вона була, стартує з першим рендером; даємо їй час зʼявитись.
  await page.waitForLoadState('networkidle');
}

for (const path of ['/l/sw-test-token', '/s/sw-test-token']) {
  test(`гостьова ${path}: Service Worker не реєструється й не завантажується`, async ({ page }) => {
    const sw = watchSwRequests(page);
    await stubGuest(page);
    await openGuest(page, path);
    await page.waitForTimeout(1500);
    expect(await registrations(page)).toBe(0);
    expect(sw).toEqual([]);
  });
}

test('/login: Service Worker реєструється на весь сайт', async ({ page }) => {
  await page.goto('/login');
  await expect.poll(() => registrations(page), { timeout: 15_000 }).toBe(1);
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.getRegistrations())[0]?.scope);
  expect(new URL(scope ?? 'http://invalid/x').pathname).toBe('/');
});

test('з гостьової в застосунок без перезавантаження — реєстрація стартує тоді', async ({ page }) => {
  await stubGuest(page);
  await openGuest(page, '/l/sw-test-token');
  expect(await registrations(page)).toBe(0);

  // Мітка у вікні переживе перехід лише тоді, коли сторінка не перезавантажилась.
  await page.evaluate(() => { (window as unknown as { swTestMark?: boolean }).swTestMark = true; });
  await page.locator('a[href="/privacy"]').click();
  await expect(page).toHaveURL(/\/privacy$/);
  expect(await page.evaluate(() => (window as unknown as { swTestMark?: boolean }).swTestMark)).toBe(true);
  await expect.poll(() => registrations(page), { timeout: 15_000 }).toBe(1);
});

test('гостьова не знімає Service Worker, який уже є (PWA власника на тому ж пристрої)', async ({ page }) => {
  await page.goto('/login');
  await expect.poll(() => registrations(page), { timeout: 15_000 }).toBe(1);
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));

  const sw = watchSwRequests(page);
  await stubGuest(page);
  await openGuest(page, '/l/sw-test-token');
  await page.waitForTimeout(1000);
  expect(await registrations(page)).toBe(1);
  // Код реєстрації гостьова не тягне й тут: смуга «Оновити» — справа застосунку.
  expect(sw.filter((p) => /workbox-window/.test(p))).toEqual([]);
});
