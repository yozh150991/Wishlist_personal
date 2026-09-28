import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { EMAIL, PASSWORD, hasAccount, unique } from './helpers';

/**
 * Сторінка списку дизайну v2 (ROADMAP, «Дизайн v2», крок 3б-1; потоки C, F, O, R).
 *
 * Тег `@v2` — лише у v2-проєктах. Правила вигляду (сортування, групи, сума,
 * посилання, ціна) перевіряє без браузера items-view.spec.ts; тут — те, що
 * бачить людина: додати, відмінити, змінити статус, видалити з «Відмінити».
 */

async function signInV2(page: Page) {
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(EMAIL!);
  await page.locator('input[name="password"]').fill(PASSWORD!);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/lists$/);
}

/** Новий список через «Новий список» v2 — одразу всередині нього. */
async function newList(page: Page, title: string) {
  await page.goto('/lists/new');
  await page.locator('input[name="title"]').fill(title);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/lists\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
}

/** Запит видалення позиції дійшов до бази — перезавантажувати сторінку раніше не можна. */
const itemDeleted = (page: Page) =>
  page.waitForResponse((r) => r.url().includes('/rest/v1/items') && r.request().method() === 'DELETE', {
    timeout: 15_000,
  });

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const itemSheet = (page: Page) => page.getByRole('dialog', { name: /нова позиція|nowa pozycja|new item/i });
const addButton = (page: Page) => page.getByRole('button', { name: /^(додати позицію|dodaj pozycję|add item)$/i }).first();
const undoButton = (page: Page) => page.getByRole('button', { name: /^(відмінити|cofnij|undo)$/i });
const card = (page: Page, title: string) => page.getByRole('listitem').filter({ hasText: title });
const menuOf = (page: Page, title: string) =>
  page.getByRole('button', {
    name: new RegExp(`(дії з позицією «${escape(title)}»|działania na pozycji „${escape(title)}”|actions for “${escape(title)}”)`, 'i'),
  });

/** Позиція вручну: «Вписати вручну» → назва → «Додати». */
async function addManual(page: Page, title: string, price?: string) {
  await addButton(page).click();
  const sheet = itemSheet(page);
  await expect(sheet.locator('input[name="link"]')).toBeFocused();
  await sheet.getByRole('button', { name: /вписати вручну|wpisz ręcznie|type it in/i }).click();
  await expect(sheet.locator('input[name="title"]')).toBeFocused();
  await sheet.locator('input[name="title"]').fill(title);
  if (price) await sheet.locator('input[name="price"]').fill(price);
  await sheet.getByRole('button', { name: /^(додати|dodaj|add)$/i }).click();
  await expect(sheet).toHaveCount(0);
}

test('сторінка списку v2 без сесії веде на вхід із next', { tag: '@v2' }, async ({ page }) => {
  await page.goto('/lists/00000000-0000-4000-8000-000000000000');
  await expect(page).toHaveURL(/\/login\?next=%2Flists%2F00000000-0000-4000-8000-000000000000$/);
});

test.describe('сторінка списку v2 з акаунтом', { tag: '@v2' }, () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('новий список відкривається порожнім; додана позиція підсвічена, «Відмінити» її прибирає', async ({ page }) => {
    await signInV2(page);
    await newList(page, unique('V2 items'));
    await expect(page.getByRole('heading', { name: /жодної позиції|ani jednej pozycji|no items yet/i })).toBeVisible();

    const title = unique('Лампа');
    await addManual(page, title, '1 240,50');
    await expect(card(page, title)).toBeVisible();
    // Сума — у тексті ціни є «240»; копійки не губляться.
    await expect(card(page, title)).toContainText(/240[,.]50/);
    const toast = page.getByRole('status').filter({ hasText: /додано|dodano|added/i });
    await expect(toast).toContainText(title);

    // На сторінці немає дубльованих id — одна розмітка на обидві розкладки (CLAUDE.md §4).
    const dupes = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
      return ids.filter((id, i) => ids.indexOf(id) !== i);
    });
    expect(dupes).toEqual([]);

    const deleted = itemDeleted(page);
    await undoButton(page).click();
    await expect(card(page, title)).toHaveCount(0);
    await deleted;
    await page.reload();
    await expect(page.getByRole('heading', { name: /жодної позиції|ani jednej pozycji|no items yet/i })).toBeVisible();
  });

  test('статус з меню «⋯» переносить у «Куплене й подароване»; видалення — тостом із «Відмінити»', async ({ page }) => {
    await signInV2(page);
    await newList(page, unique('V2 status'));
    const title = unique('Плед');
    await addManual(page, title);
    await expect(card(page, title)).toBeVisible();
    // Тост додавання доживає своє — щоб наступний тост був саме про видалення.
    await expect(undoButton(page)).toHaveCount(0, { timeout: 10_000 });

    await menuOf(page, title).click();
    const menu = page.getByRole('dialog', { name: title });
    // click, а не check: вибір одразу закриває меню, і перевіряти стан радіокнопки вже нема де.
    await menu.getByRole('radio', { name: /^(куплено|kupione|purchased)$/i }).click();
    await expect(menu).toHaveCount(0);
    const done = page.locator('details').filter({ hasText: /куплене й подароване|kupione i podarowane|purchased and gifted/i });
    await expect(done).toContainText(title);

    // Видалення без діалогу: позиція зникає одразу, «Відмінити» повертає.
    await menuOf(page, title).click();
    await page.getByRole('dialog', { name: title }).getByRole('button', { name: /^(видалити|usuń|delete)$/i }).click();
    await expect(card(page, title)).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: /видалено|usunięto|deleted/i })).toBeVisible();
    await undoButton(page).click();
    await expect(card(page, title)).toBeVisible();

    // Удруге — без відкату: запит іде, коли відлік скінчився, і після F5 позиції немає.
    const deleted = itemDeleted(page);
    await menuOf(page, title).click();
    await page.getByRole('dialog', { name: title }).getByRole('button', { name: /^(видалити|usuń|delete)$/i }).click();
    await expect(undoButton(page)).toHaveCount(0, { timeout: 10_000 });
    await deleted;
    await page.reload();
    await expect(page.getByRole('heading', { name: /жодної позиції|ani jednej pozycji|no items yet/i })).toBeVisible();
  });

  test('хибне посилання — підказка під полем і «Додати без посилання» до ручної форми', async ({ page }) => {
    await signInV2(page);
    await newList(page, unique('V2 link'));
    await addButton(page).click();
    const sheet = itemSheet(page);
    await sheet.locator('input[name="link"]').fill('shopua');
    await sheet.getByRole('button', { name: /^(далі|dalej|next)$/i }).click();
    await expect(sheet.getByText(/не адреса сторінки|nie wygląda na adres strony|doesn't look like a page address/i)).toBeVisible();
    await expect(sheet.locator('input[name="link"]')).toHaveAttribute('aria-invalid', 'true');
    // Поле не очищається: людина виправляє свій текст.
    await expect(sheet.locator('input[name="link"]')).toHaveValue('shopua');

    await sheet.getByRole('button', { name: /додати без посилання|dodaj bez linku|add without a link/i }).click();
    await expect(sheet.locator('input[name="title"]')).toBeFocused();
    // Порожня назва не відправляється: підказка під полем і фокус на ньому.
    await sheet.getByRole('button', { name: /^(додати|dodaj|add)$/i }).click();
    await expect(sheet.getByText(/назви позицію|nazwij pozycję|name the item/i)).toBeVisible();
    await expect(sheet.locator('input[name="title"]')).toBeFocused();
  });
});
