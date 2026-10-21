import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { addItem, createList, hasAccount, itemMenu, listMenu, shareLink, signIn, unique } from './helpers';

/**
 * Розділи й ручний порядок (ADR-036): власник групує й переставляє, гість
 * бачить саме цей порядок; видалений розділ віддає позиції в «Інше».
 */
test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

async function newSection(page: Page, name: string) {
  await listMenu(page, /^(новий розділ|nowy dział|new section)$/i);
  const sheet = page.getByRole('dialog', { name: /новий розділ|nowy dział|new section/i });
  await sheet.locator('input[name="section_title"]').fill(name);
  await sheet.locator('button[type="submit"]').click();
  await expect(sheet).toHaveCount(0);
}

async function moveTo(page: Page, item: string, section: string) {
  const menu = await itemMenu(page, item);
  await menu.getByRole('button', { name: /^(змінити|zmień|edit)$/i }).click();
  const sheet = page.getByRole('dialog').filter({ has: page.locator('input[name="title"]') });
  await sheet.getByLabel(/^(розділ|dział|section)$/i).selectOption({ label: section });
  await sheet.locator('button[type="submit"]').click();
  await expect(sheet).toHaveCount(0);
}

/** Назви позицій у групі власника; група названа «Назва · N». */
const ownerTitles = (page: Page, group: string) =>
  page.getByRole('region', { name: new RegExp(`^(${group}) · \\d+$`) }).locator('.v2-item__title');

const guestTitles = (page: Page, group: string | RegExp) =>
  page.getByRole('region', { name: group }).locator('.v2-gcard__title');

test('розділи й ручний порядок власника — саме їх бачить гість', async ({ page, browser }) => {
  await signIn(page);
  await createList(page, unique('Sections'));
  for (const name of ['Сковорода', 'Дошка', 'Постіль', 'Лампа']) await addItem(page, name);

  await newSection(page, 'Кухня');
  await newSection(page, 'Спальня');
  await moveTo(page, 'Сковорода', 'Кухня');
  await moveTo(page, 'Дошка', 'Кухня');
  await moveTo(page, 'Постіль', 'Спальня');

  // Кухня: нові зверху — Дошка, Сковорода. «Змінити порядок» → «Сковорода» вище.
  await expect(ownerTitles(page, 'Кухня')).toHaveText(['Дошка', 'Сковорода']);
  await listMenu(page, /^(змінити порядок|zmień kolejność|change order)$/i);
  await page.getByRole('button', { name: /Сковорода.*(вище|wyżej|up)$/i }).click();
  await page.getByRole('button', { name: /^(готово|gotowe|done)$/i }).click();
  await expect(ownerTitles(page, 'Кухня')).toHaveText(['Сковорода', 'Дошка']);

  await page.reload();
  await expect(ownerTitles(page, 'Кухня')).toHaveText(['Сковорода', 'Дошка']);

  const link = await shareLink(page, ['Сковорода', 'Дошка', 'Постіль', 'Лампа'], 'Новосілля');

  const guestCtx = await browser.newContext();
  const guest = await guestCtx.newPage();
  await guest.goto(link);
  await expect(guestTitles(guest, 'Кухня')).toHaveText(['Сковорода', 'Дошка']);
  await expect(guestTitles(guest, 'Спальня')).toHaveText(['Постіль']);
  await expect(guestTitles(guest, /^(інше|inne|other)$/i)).toHaveText(['Лампа']);
  await guestCtx.close();

  // Видалення розділу не видаляє позицій — вони переходять у «Інше».
  await page.getByRole('button', { name: /(дії з розділом|działania na dziale|actions for section).*Спальня/i }).click();
  await page.getByRole('dialog', { name: 'Спальня' }).getByRole('button', { name: /^(видалити розділ|usuń dział|delete section)$/i }).click();
  await page
    .getByRole('dialog', { name: /видалити розділ «Спальня»|usunąć dział|delete section/i })
    .getByRole('button', { name: /^(видалити розділ|usuń dział|delete section)$/i })
    .click();
  await expect(page.getByRole('region', { name: /^Спальня · / })).toHaveCount(0);
  await expect(ownerTitles(page, 'Інше|Inne|Other')).toContainText(['Постіль']);
});

test('розділи й порядок переживають експорт у JSON та імпорт (ADR-036)', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  await createList(page, unique('Sections file'));
  for (const name of ['Сковорода', 'Дошка', 'Лампа']) await addItem(page, name);
  await newSection(page, 'Кухня');
  await newSection(page, 'Балкон');
  await moveTo(page, 'Сковорода', 'Кухня');
  await moveTo(page, 'Дошка', 'Кухня');
  // Нові зверху: Дошка, Сковорода — переставляємо, щоб порядок був саме ручний.
  await listMenu(page, /^(змінити порядок|zmień kolejność|change order)$/i);
  await page.getByRole('button', { name: /Сковорода.*(вище|wyżej|up)$/i }).click();
  await page.getByRole('button', { name: /^(готово|gotowe|done)$/i }).click();
  await expect(ownerTitles(page, 'Кухня')).toHaveText(['Сковорода', 'Дошка']);

  await listMenu(page, /експортувати список|eksportuj listę|export list/i);
  const download = page.waitForEvent('download');
  await page.getByRole('dialog').getByRole('button', { name: /json/i }).click();
  const path = await (await download).path();

  await page.goto('/lists');
  await page.getByRole('button', { name: /імпорт із файлу|import z pliku|import from a file/i }).first().click();
  const sheet = page.getByRole('dialog', { name: /імпортувати список|importuj listę|import list/i });
  await sheet.locator('input[type="file"]').setInputFiles(path);
  await expect(sheet.getByText(/розділів: 2|działów: 2|sections: 2/i)).toBeVisible();
  const imported = unique('Sections imported');
  await sheet.locator('input[name="import_title"]').fill(imported);
  await sheet.getByRole('button', { name: /\(3\)/ }).click();

  await expect(page.getByRole('heading', { level: 1, name: imported })).toBeVisible();
  await expect(ownerTitles(page, 'Кухня')).toHaveText(['Сковорода', 'Дошка']);
  await expect(ownerTitles(page, 'Інше|Inne|Other')).toHaveText(['Лампа']);
  // Порожній розділ теж приїхав: JSON його зберігає.
  await expect(page.getByRole('region', { name: /^Балкон · 0$/ })).toBeVisible();
});
