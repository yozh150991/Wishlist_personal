import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { addItem, createList, createShare, hasAccount, settledDialog, signIn, unique } from './helpers';

/**
 * Розділи й ручний порядок (ADR-036): власник групує й переставляє, гість
 * бачить саме цей порядок. «Вільних» у власника немає — і це пояснено.
 */
test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

async function newSection(page: Page, name: string) {
  await page.getByRole('button', { name: /^(\+\s*)?(новий розділ|nowy dział|new section)$/i }).first().click();
  const dialog = await settledDialog(page);
  await dialog.getByLabel(/назва розділу|nazwa działu|section name/i).fill(name);
  await dialog.getByRole('button', { name: /створити розділ|utwórz dział|create section/i }).click();
  await expect(dialog).toHaveCount(0);
}

async function moveTo(page: Page, item: string, section: string) {
  await page.getByRole('button', { name: new RegExp(`(змінити|zmień|edit).*${item}`, 'i') }).click();
  const dialog = await settledDialog(page);
  await dialog.getByLabel(/^розділ$|^dział$|^section$/i).selectOption({ label: section });
  await dialog.getByRole('button', { name: /^зберегти$|^zapisz$|^save$/i }).click();
  await expect(dialog).toHaveCount(0);
}

const titlesIn = (page: Page, region: string | RegExp) =>
  page.getByRole('region', { name: region }).locator('.item__title');

test('розділи й ручний порядок власника — саме їх бачить гість', async ({ page, browser }) => {
  await signIn(page);
  await createList(page, unique('Sections'));
  for (const name of ['Сковорода', 'Дошка', 'Постіль', 'Лампа']) await addItem(page, name);

  // Менше 12 позицій і жодного розділу — плаский список; перший розділ його вмикає.
  await expect(page.getByRole('radiogroup', { name: /вигляд списку|widok listy|list view/i })).toHaveCount(0);
  await newSection(page, 'Кухня');
  await newSection(page, 'Спальня');
  await expect(page.getByRole('radio', { name: /^розділи$|^działy$|^sections$/i })).toHaveAttribute('aria-checked', 'true');

  // «Вільних» у власника немає — і це пояснено, а не сховано.
  await expect(page.getByText(/тут немає фільтра «вільні»|nie ma filtra „wolne”|no “available” filter/i)).toBeVisible();

  await moveTo(page, 'Сковорода', 'Кухня');
  await moveTo(page, 'Дошка', 'Кухня');
  await moveTo(page, 'Постіль', 'Спальня');

  // Кухня: нові зверху — Дошка, Сковорода. Переставляємо клавіатурою.
  await expect(titlesIn(page, 'Кухня')).toHaveText(['Дошка', 'Сковорода']);
  const handle = page.getByRole('region', { name: 'Кухня' })
    .getByRole('button', { name: /(перетягнути|przeciągnij|drag).*Сковорода/i });
  // Кожен крок чекає на оголошення для зчитувача екрана: так тест іде темпом
  // людини й заодно перевіряє, що перетягування клавіатурою озвучується.
  await handle.press('Space');
  await expect(page.getByText(/«Сковорода» на місці 2|„Сковорода” na miejscu 2|“Сковорода” at position 2/i)).toBeAttached();
  await page.keyboard.press('ArrowUp');
  await expect(page.getByText(/«Сковорода» на місці 1|„Сковорода” na miejscu 1|“Сковорода” at position 1/i)).toBeAttached();
  await page.keyboard.press('Space');
  await expect(titlesIn(page, 'Кухня')).toHaveText(['Сковорода', 'Дошка']);

  await page.reload();
  await expect(titlesIn(page, 'Кухня')).toHaveText(['Сковорода', 'Дошка']);

  const link = await createShare(page, ['Сковорода', 'Дошка', 'Постіль', 'Лампа'], 'Новосілля');
  await page.keyboard.press('Escape');

  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  await guest.goto(link);
  await expect(guest.getByRole('region', { name: 'Кухня' }).locator('.gcard__title')).toHaveText(['Сковорода', 'Дошка']);
  await expect(guest.getByRole('region', { name: 'Спальня' }).locator('.gcard__title')).toHaveText(['Постіль']);
  await expect(guest.getByRole('region', { name: /^інше$|^inne$|^other$/i }).locator('.gcard__title')).toHaveText(['Лампа']);
  await guestCtx.close();

  // Видалення розділу не видаляє позицій — вони переходять у «Інше».
  await page.getByRole('button', { name: /(видалити розділ|usuń dział|delete section).*Спальня/i }).click();
  await page.getByRole('dialog').filter({ hasText: /«Інше»|„Inne”|“Other”/ })
    .getByRole('button', { name: /^видалити розділ$|^usuń dział$|^delete section$/i }).click();
  await expect(page.getByRole('region', { name: 'Спальня' })).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: /^інше$|^inne$|^other$/i }).locator('.item__title'),
  ).toContainText(['Постіль']);
});

test('«За ціною» — лише вигляд власника, а порядок гостя не змінює', async ({ page }) => {
  await signIn(page);
  await createList(page, unique('Sections view'));
  for (const name of ['Перша', 'Друга']) await addItem(page, name);
  await newSection(page, 'Усе');
  await page.getByRole('radio', { name: /^за ціною$|^według ceny$|^by price$/i }).click();
  await expect(page.getByText(/лише вигляд на твоєму екрані|tylko widok na twoim ekranie|only your view/i)).toBeVisible();
  // Ручок перетягування в плаcкому вигляді немає: переставляти можна лише в «Розділах».
  await expect(page.getByRole('button', { name: /перетягнути|przeciągnij|drag/i })).toHaveCount(0);
});
