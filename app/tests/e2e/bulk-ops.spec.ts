import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { hasAccount, itemCard, signIn, unique } from './helpers';

/**
 * Імпорт однією транзакцією (ROADMAP 8.26): обрив мережі посеред імпорту не
 * лишає половини списку — у базі або нічого, або все. А повторне натискання
 * після загубленої відповіді не створює другого списку: id нового списку
 * задає клієнт, один на дію.
 *
 * Обрив — `page.route` на RPC `import_list`: або запит не доходить до бази
 * зовсім, або доходить, а відповідь до сторінки — ні. «Усе або нічого» на
 * рівні бази (помилка в середині, чужий список, позначки гостей) перевіряє
 * pgTAP — supabase/tests/database/32_bulk_ops.test.sql.
 */

const N = 30;

/** Файл експорту з двома розділами й N позиціями, що йдуть по черзі. */
function bigFile(prefix: string): { name: string; mimeType: string; buffer: Buffer } {
  const sections = ['Кухня', 'Балкон'];
  const body = {
    format: 'wishlist-personal',
    version: 1,
    list: { title: prefix, currency: 'PLN', sections },
    items: Array.from({ length: N }, (_, k) => ({
      title: `${prefix} · річ ${k + 1}`,
      price: k + 1,
      section: k % 3 === 0 ? null : sections[k % 2],
    })),
  };
  return { name: 'big.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(body)) };
}

const importSheet = (page: Page) => page.getByRole('dialog', { name: /імпортувати список|importuj listę|import list/i });
const offline = /немає з.єднання|brak połączenia|no internet connection/i;

async function startImport(page: Page, title: string) {
  await page.goto('/lists');
  await page.getByRole('button', { name: /імпорт із файлу|import z pliku|import from a file/i }).first().click();
  const sheet = importSheet(page);
  await sheet.locator('input[type="file"]').setInputFiles(bigFile(title));
  await expect(sheet.getByText(`${title} · річ 1`, { exact: true })).toBeVisible();
  await sheet.locator('input[name="import_title"]').fill(title);
  return sheet;
}

/** Чи є на «Моїх списках» список із такою назвою — після свіжого завантаження. */
function listCard(page: Page, title: string) {
  return page.getByRole('link').filter({ hasText: title });
}

test.describe('масові дії однією транзакцією (ROADMAP 8.26)', () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('запит імпорту не дійшов — у базі нічого, і жодних інших запитів на запис', async ({ page }) => {
    await signIn(page);
    const title = unique('Bulk import lost');
    const sheet = await startImport(page, title);

    // Будь-який запис поза RPC означав би серію запитів, яку можна обірвати посередині.
    const writes: string[] = [];
    page.on('request', (r) => {
      if (r.method() !== 'GET' && /\/rest\/v1\/(lists|items|sections)\b/.test(r.url())) writes.push(r.url());
    });
    await page.route('**/rest/v1/rpc/import_list', (route) => route.abort('failed'));

    await sheet.getByRole('button', { name: new RegExp(`\\(${N}\\)`) }).click();
    await expect(sheet.getByText(offline)).toBeVisible();
    expect(writes).toEqual([]);

    await page.unroute('**/rest/v1/rpc/import_list');
    await page.goto('/lists');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(listCard(page, title)).toHaveCount(0);
  });

  test('імпорт дійшов, а відповідь — ні: повторне «Імпортувати» не створює другого списку', async ({ page }) => {
    await signIn(page);
    const title = unique('Bulk import cut');
    const sheet = await startImport(page, title);

    // Перший виклик доходить до бази, але відповідь до сторінки — ні; далі мережа є.
    const ids: string[] = [];
    await page.route('**/rest/v1/rpc/import_list', async (route) => {
      ids.push((route.request().postDataJSON() as { p_list_id: string }).p_list_id);
      if (ids.length === 1) {
        await route.fetch();
        await route.abort('failed');
        return;
      }
      await route.continue();
    });

    const submit = sheet.getByRole('button', { name: new RegExp(`\\(${N}\\)`) });
    await submit.click();
    await expect(sheet.getByText(offline)).toBeVisible();

    // Людина бачить «немає з'єднання» й натискає ще раз — у тому самому аркуші.
    await submit.click();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(ids[1]).toBe(ids[0]);
    // Список цілий — усі позиції й обидва розділи, а не половина.
    await expect(itemCard(page, `${title} · річ`)).toHaveCount(N);
    await expect(page.getByRole('region', { name: /^Кухня · \d+$/ })).toBeVisible();
    await expect(page.getByRole('region', { name: /^Балкон · \d+$/ })).toBeVisible();

    await page.unroute('**/rest/v1/rpc/import_list');
    await page.goto('/lists');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(listCard(page, title)).toHaveCount(1);
  });
});
