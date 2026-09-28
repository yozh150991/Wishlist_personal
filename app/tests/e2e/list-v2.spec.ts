import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { EMAIL, PASSWORD, hasAccount, unique } from './helpers';

/**
 * Сторінка списку дизайну v2 (ROADMAP, «Дизайн v2», кроки 3б-1 і 3б-2; потоки
 * C, D, F, O, R, V3).
 *
 * Тег `@v2` — лише у v2-проєктах. Правила вигляду (сортування, групи, сума,
 * посилання, ціна) перевіряє без браузера items-view.spec.ts; тут — те, що
 * бачить людина: додати, відмінити, змінити статус, видалити з «Відмінити»,
 * поділитися вибраним, змінити порядок, видалити список.
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

/** Запит видалення списку дійшов до бази. */
const listDeleted = (page: Page) =>
  page.waitForResponse((r) => r.url().includes('/rest/v1/lists') && r.request().method() === 'DELETE', {
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

/** Пункт меню «⋯» списку. */
async function listMenu(page: Page, item: RegExp) {
  await page.getByRole('button', { name: /^(дії зі списком|działania na liście|list actions)$/i }).click();
  await page.getByRole('dialog').getByRole('button', { name: item }).click();
}

test.describe('сторінка списку v2: поділитися, порядок, видалення', { tag: '@v2' }, () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('«Поділитися»: прихована позиція не доходить до гостя; відкритий список видаляється лише з назвою', async ({
    page,
    browser,
  }) => {
    await signInV2(page);
    const listTitle = unique('V2 share');
    await newList(page, listTitle);
    const shown = unique('Лампа');
    const secret = unique('Сюрприз');
    await addManual(page, shown);
    await addManual(page, secret);

    await page.getByRole('button', { name: /^(поділитися|udostępnij|share)$/i }).first().click();
    const sheet = page.getByRole('dialog');
    // На телефоні вибір — окремий крок «Обрати», на десктопі — поруч із превʼю.
    const box = sheet.getByRole('checkbox', { name: new RegExp(escape(secret)) });
    if (!(await box.isVisible())) await sheet.getByRole('button', { name: /^(обрати|wybierz|choose)$/i }).click();
    await box.uncheck();
    await expect(sheet.getByText(/1 з 2|1 z 2|1 of 2/)).toBeVisible();
    const done = sheet.getByRole('button', { name: /^(готово|gotowe|done)$/i });
    if (await done.isVisible()) await done.click();
    await sheet.getByRole('button', { name: /^(створити посилання|utwórz link|create link)$/i }).click();

    await expect(sheet.getByRole('heading', { name: /посилання готове|link gotowy|link is ready/i })).toBeVisible();
    const link = await sheet.locator('input[readonly]').inputValue();
    expect(link).toMatch(/\/s\/[A-Za-z0-9_-]{16,}$/);

    // Гість без сесії бачить лише вибране. Перегляд реєструється — список «відкривали».
    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    const viewed = guest.waitForResponse((r) => r.url().includes('/rpc/register_share_view'));
    await guest.goto(link);
    await expect(guest.getByText(shown)).toBeVisible();
    await expect(guest.getByText(secret)).toHaveCount(0);
    await viewed;

    // «Відкликати доступ» — з підтвердженням; посилання гасне.
    await sheet.getByRole('button', { name: /^(відкликати доступ|cofnij dostęp|revoke access)$/i }).click();
    await page
      .getByRole('dialog', { name: /відкликати доступ|cofnąć dostęp|revoke access/i })
      .getByRole('button', { name: /^(відкликати|cofnij|revoke)$/i })
      .click();
    await expect(sheet.getByRole('heading', { name: /доступ відкликано|dostęp cofnięty|access revoked/i })).toBeVisible();
    await guest.reload();
    await expect(guest.getByText(shown)).toHaveCount(0);
    await guestContext.close();
    await sheet.getByRole('button', { name: /^(готово|gotowe|done)$/i }).first().click();

    // Список відкривали — видалити можна, лише вписавши назву (F3).
    await listMenu(page, /^(налаштування списку|ustawienia listy|list settings)$/i);
    await page.getByRole('dialog').getByRole('button', { name: /^(видалити список|usuń listę|delete list)$/i }).click();
    const confirm = page.getByRole('dialog', { name: new RegExp(escape(listTitle)) });
    await expect(confirm.getByText(/відкривали|otwierano|opened/i)).toBeVisible();
    // Кнопка приглушена, поки назву не вписано; вписали — ожила.
    const forGood = confirm.getByRole('button', { name: /видалити назавжди|usuń na zawsze|delete for good/i });
    await expect(forGood).toHaveAttribute('aria-disabled', 'true');
    await confirm.locator('input[name="confirm_title"]').fill(listTitle);
    await expect(forGood).not.toHaveAttribute('aria-disabled', 'true');
    await forGood.click();
    await expect(page).toHaveURL(/\/lists$/);
    await expect(page.getByRole('status').filter({ hasText: /видалено|usunięta|deleted/i })).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(escape(listTitle)) })).toHaveCount(0);
  });

  test('«Змінити порядок»: «Вище» переставляє позицію, і порядок переживає F5', async ({ page }) => {
    await signInV2(page);
    await newList(page, unique('V2 order'));
    const first = unique('Перша');
    const second = unique('Друга');
    await addManual(page, first);
    await addManual(page, second);
    // Щойно додані — зверху, новіші першими: «Друга», потім «Перша».
    const titles = () => page.locator('.v2-item__title, .v2-order .v2-item__title').allTextContents();
    await expect.poll(titles).toEqual([second, first]);

    await listMenu(page, /^(змінити порядок|zmień kolejność|change order)$/i);
    // «Перша» вище / „Перша” wyżej / Move “Перша” up.
    await page.getByRole('button', { name: new RegExp(`${escape(first)}.*(вище|wyżej|up)$`, 'i') }).click();
    await expect.poll(titles).toEqual([first, second]);
    await page.getByRole('button', { name: /^(готово|gotowe|done)$/i }).click();

    await page.reload();
    await expect.poll(titles).toEqual([first, second]);
  });

  test('список, який ніхто не відкривав, видаляється тостом «Відмінити» на головній', async ({ page }) => {
    await signInV2(page);
    const listTitle = unique('V2 delete');
    await newList(page, listTitle);

    // Налаштування: нова назва зберігається.
    const renamed = `${listTitle} ✓`;
    await listMenu(page, /^(налаштування списку|ustawienia listy|list settings)$/i);
    await page.getByRole('dialog').locator('input[name="list_title"]').fill(renamed);
    await page.getByRole('dialog').getByRole('button', { name: /^(зберегти|zapisz|save)$/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: renamed })).toBeVisible();

    await listMenu(page, /^(налаштування списку|ustawienia listy|list settings)$/i);
    await page.getByRole('dialog').getByRole('button', { name: /^(видалити список|usuń listę|delete list)$/i }).click();
    await expect(page).toHaveURL(/\/lists$/);
    await expect(page.getByRole('link', { name: new RegExp(escape(renamed)) })).toHaveCount(0);

    // «Відмінити» повертає список, а без відкату він зникає після відліку.
    await undoButton(page).click();
    await expect(page.getByRole('link', { name: new RegExp(escape(renamed)) })).toBeVisible();

    await page.getByRole('link', { name: new RegExp(escape(renamed)) }).click();
    const deleted = listDeleted(page);
    await listMenu(page, /^(налаштування списку|ustawienia listy|list settings)$/i);
    await page.getByRole('dialog').getByRole('button', { name: /^(видалити список|usuń listę|delete list)$/i }).click();
    await expect(page).toHaveURL(/\/lists$/);
    await deleted;
    await page.reload();
    await expect(page.getByRole('link', { name: new RegExp(escape(renamed)) })).toHaveCount(0);
  });
});
