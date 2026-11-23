import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { addItem, createList, escapeRegExp, hasAccount, itemCard, shareLink, signIn, unique } from './helpers';

/**
 * Пошук по всіх списках (ROADMAP 8.11) — на справжній базі, з акаунтом.
 *
 * Готово, коли позиція з архіву минулого року знаходиться за словом із
 * нотатки; копія в інший список з'являється там без позначок гостей і поза
 * посиланнями. Правила збігу без браузера — search.spec.ts, у базі — pgTAP
 * 33_search_my_items.
 */

const searchLink = (page: Page) =>
  page.getByRole('link', { name: /^(пошук по всіх списках|szukaj we wszystkich listach|search all lists)$/i });
const searchInput = (page: Page) => page.locator('input[name="search_all"]');
const result = (page: Page, title: string) => page.locator('.v2-result').filter({ hasText: title });
const listMenuButton = (page: Page) =>
  page.getByRole('button', { name: /^(дії зі списком|działania na liście|list actions)$/i });
const archivedNote = (page: Page) => page.getByText(/список в архіві|lista w archiwum|this list is archived/i);

/** 24 грудня минулого року — «архів минулого року». */
function lastYearXmas(): string {
  return `${new Date().getFullYear() - 1}-12-24`;
}

/** Дата події через «Налаштування списку», потім «Архівувати». */
async function archiveAsLastYear(page: Page) {
  await listMenuButton(page).click();
  await page.getByRole('dialog').getByRole('button', { name: /налаштування списку|ustawienia listy|list settings/i }).click();
  const settings = page.getByRole('dialog', { name: /налаштування списку|ustawienia listy|list settings/i });
  await settings.locator('input[name="list_date"]').fill(lastYearXmas());
  await settings.getByRole('button', { name: /^(зберегти|zapisz|save)$/i }).click();
  await expect(settings).toHaveCount(0);
  await listMenuButton(page).click();
  await page.getByRole('dialog').getByRole('button', { name: /^(архівувати|zarchiwizuj|archive)$/i }).click();
  await expect(archivedNote(page)).toBeVisible();
}

async function setNote(page: Page, title: string, note: string) {
  await itemCard(page, title).getByRole('button', { name: new RegExp(escapeRegExp(title)) }).first().click();
  const edit = page.getByRole('dialog', { name: /^(позиція|pozycja|item)$/i });
  await edit.locator('textarea[name="note"]').fill(note);
  await edit.getByRole('button', { name: /^(зберегти|zapisz|save)$/i }).click();
  await expect(edit).toHaveCount(0);
}

async function guest(browser: Browser, link: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return page;
}

const gcard = (page: Page, title: string) => page.locator('.v2-gcard').filter({ hasText: title });
const takeBtn = /^(беру|biorę|take)$/i;

async function search(page: Page, q: string) {
  await page.goto('/lists');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await searchLink(page).click();
  await expect(searchInput(page)).toBeFocused();
  await searchInput(page).fill(q);
}

test.describe('пошук по всіх списках', () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('позиція з архіву минулого року знаходиться за словом із нотатки й веде до себе', async ({ page }) => {
    await signIn(page);
    const listTitle = unique('S811 Різдво');
    await createList(page, listTitle);
    const lamp = unique('Лампа');
    await addItem(page, lamp);
    // Слово лише в нотатці; велика літера й «ż» — пошук їх не помічає.
    const word = `Сніжинка${Date.now().toString(36)}`;
    await setNote(page, lamp, `Як у бабусі — ${word}, та сама, що й торік (Łódź)`);
    await archiveAsLastYear(page);

    await search(page, word.toLowerCase());
    const hit = result(page, lamp);
    await expect(hit).toHaveCount(1);
    await expect(hit).toContainText(listTitle);
    await expect(hit.locator('.v2-tag')).toContainText(/архів|archiwum|archive/i);
    await expect(hit.locator('mark').first()).toHaveText(word);

    await hit.getByRole('link').click();
    await expect(page).toHaveURL(/\/lists\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: listTitle })).toBeVisible();
    await expect(itemCard(page, lamp)).toBeInViewport();

    // «Назад» — той самий пошук, без повторного набору.
    await page.goBack();
    await expect(searchInput(page)).toHaveValue(word.toLowerCase());
    await expect(result(page, lamp)).toHaveCount(1);

    // Діакритика: «lodz» знаходить «Łódź» у тій самій нотатці.
    await searchInput(page).fill(`lodz ${word}`);
    await expect(result(page, lamp)).toHaveCount(1);
  });

  test('«Скопіювати в список…»: копія без позначок гостей і поза посиланнями', async ({ page, browser }) => {
    await signIn(page);
    const sourceTitle = unique('S811 Джерело');
    await createList(page, sourceTitle);
    const plaid = unique('Плед');
    await addItem(page, plaid);
    const sourceLink = await shareLink(page, [plaid], unique('Гостям'));

    // Гість бере плед на старому списку.
    const a = await guest(browser, sourceLink);
    await gcard(a, plaid).getByRole('button', { name: takeBtn }).click();
    const sheet = a.getByRole('dialog');
    await sheet.locator('input[name="guest_name"]').fill('Оля-e2e');
    await sheet.locator('input[name="guest_email"]').fill('guest-e2e@example.com');
    await sheet.getByRole('button', { name: /^(забронювати|zarezerwuj|take it)$/i }).click();
    await expect(sheet.getByRole('heading', { name: /за вами|twoje|is yours/i })).toBeVisible();
    await a.context().close();
    await archiveAsLastYear(page);

    const targetTitle = unique('S811 Ціль');
    await createList(page, targetTitle);
    const cup = unique('Чашка');
    await addItem(page, cup);
    const targetLink = await shareLink(page, [cup], unique('Гостям'));

    await search(page, plaid);
    await result(page, plaid)
      .getByRole('button', { name: new RegExp(`${escapeRegExp(plaid)}`) })
      .click();
    const copy = page.getByRole('dialog', { name: /скопіювати в список|skopiuj do listy|copy to a list/i });
    // Куди — лише живі списки: свого (він же архівний) серед них немає.
    await expect(copy.getByRole('radio', { name: sourceTitle })).toHaveCount(0);
    await copy.getByRole('radio', { name: targetTitle }).check();
    await copy.getByRole('button', { name: /^(скопіювати|skopiuj|copy)$/i }).click();
    await expect(copy).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: targetTitle })).toBeVisible();

    // Наявне посилання цілі копії не показує: склад посилання змінюється лише вручну.
    const b = await guest(browser, targetLink);
    await expect(gcard(b, cup)).toBeVisible();
    await expect(gcard(b, plaid)).toHaveCount(0);
    await b.context().close();

    // У списку-цілі копія — актуальна, без «Подаровано».
    await page.getByRole('status').filter({ hasText: targetTitle }).getByRole('link').click();
    await expect(page.getByRole('heading', { level: 1, name: targetTitle })).toBeVisible();
    await expect(itemCard(page, plaid)).toBeVisible();
    await expect(itemCard(page, plaid).locator('.v2-tag')).toHaveCount(0);

    // Нове посилання з копією: гість бачить її вільною — позначка лишилась на оригіналі.
    const copyLink = await shareLink(page, [plaid], unique('Гостям копія'));
    const c = await guest(browser, copyLink);
    await expect(gcard(c, plaid).getByRole('button', { name: takeBtn })).toBeVisible();
    await c.context().close();
  });
});
