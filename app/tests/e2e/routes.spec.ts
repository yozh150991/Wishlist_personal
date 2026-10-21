import { test, expect } from '@playwright/test';

/**
 * Маршрути одного дизайну (ADR-065). Версій більше немає: старі гостьові
 * адреси `/s/…` ведуть на `/l/…` з тим самим токеном і хвостом (особисте
 * посилання, відписка), невідома адреса — сторінка «Такої сторінки немає»,
 * а старий вибір версії прибирається ще до рендера — і зі сховища, і з адреси.
 *
 * Акаунт тут не потрібен: усе це має працювати й тоді, коли бази не видно.
 */

const DEAD = 'e2e-nonexistent-token';
/** Будь-який рядок форми ключа (lib/guest.ts): 22–64 символи base64url. */
const KEY = 'e2eGuestKeyAAAAAAAAAAAAA';

test('корінь веде на списки, а звідти на вхід із next', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login\?next=%2Flists$/);
});

test('невідома адреса — «Такої сторінки немає» з дорогою до списків', async ({ page }) => {
  await page.goto('/такої-сторінки-немає');
  await expect(
    page.getByRole('heading', { level: 1, name: /такої сторінки немає|nie ma takiej strony|no such page/i }),
  ).toBeVisible();
  await page.getByRole('link', { name: /до моїх списків|do moich list|to my lists/i }).click();
  await expect(page).toHaveURL(/\/login\?next=%2Flists$/);
});

test('старий вибір версії зі сховища прибирається до рендера', async ({ page }) => {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.setItem('wl.design', 'v1'));
  await page.reload({ waitUntil: 'domcontentloaded' });
  expect(await page.evaluate(() => localStorage.getItem('wl.design'))).toBeNull();
  await expect(page.locator('html')).not.toHaveAttribute('data-design', /.*/);
  await expect(page.locator('input[name="email"]')).toBeVisible();
});

test('`?design=` зі старих листів знімається з адреси, решта параметрів лишається', async ({ page }) => {
  await page.goto('/login?design=v2&next=%2Fshares', { waitUntil: 'domcontentloaded' });
  await expect(page).toHaveURL(/\/login\?next=%2Fshares$/);
});

test.describe('стара гостьова адреса /s/', () => {
  test('веде на /l/ з тим самим токеном і параметрами', async ({ page }) => {
    await page.goto(`/s/${DEAD}?utm=e2e`);
    await expect(page).toHaveURL(new RegExp(`/l/${DEAD}\\?utm=e2e$`));
    await expect(page.getByRole('heading', { name: /більше не працює|już nie działa|no longer works/i })).toBeVisible();
  });

  test('особисте посилання /s/…/g/… — ключ лягає в браузер і зникає з адреси', async ({ page }) => {
    await page.goto(`/s/${DEAD}/g/${KEY}`);
    // Особисте посилання не лишається в адресному рядку (ADR-035).
    await expect(page).toHaveURL(new RegExp(`/l/${DEAD}$`));
    expect(await page.evaluate((tk) => localStorage.getItem(`wl.gk.${tk}`), DEAD)).toBe(KEY);
  });

  test('відписка /s/…/u/… — на /l/, а секрет зникає з адреси', async ({ page }) => {
    await page.goto(`/s/${DEAD}/u/e2eMailTokenAAAAAAAAAAA`);
    await expect(page).toHaveURL(new RegExp(`/l/${DEAD}$`));
  });
});
