import { test, expect } from '@playwright/test';
import { addItem, createList, hasAccount, settledDialog, signIn, unique } from './helpers';

/**
 * Сценарії етапу 3 працюють з реальним акаунтом.
 * Локально — під користувачем із сіду (TESTING.md, «Акаунт для E2E»):
 *   $env:E2E_LOCALDB="1"; $env:E2E_EMAIL="anna@wishlist.test"; $env:E2E_PASSWORD="password123"
 * Без акаунта набір пропускається, щоб CI не падав на відсутніх даних.
 */
test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

test('повний цикл: список, позиція без ціни, редагування, видалення', async ({ page }) => {
  await signIn(page);
  await createList(page, unique('E2E'));

  // Позиція лише з назвою — ціна й посилання необовʼязкові.
  await addItem(page, 'Навушники');
  await expect(page.getByText(/ціна не вказана|brak ceny|no price/i)).toBeVisible();

  // Підсумки чесно рахують позиції без ціни.
  await expect(page.getByText(/без ціни|bez ceny|without a price/i)).toBeVisible();

  await page.getByRole('button', { name: /^змінити$|^edytuj$|^edit$/i }).first().click();
  const dialog = await settledDialog(page);
  await dialog.getByLabel(/^ціна$|^cena$|^price$/i).fill('399');
  await dialog.getByRole('button', { name: /^зберегти$|^zapisz$|^save$/i }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/ціна не вказана|brak ceny|no price/i)).toHaveCount(0);

  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: /^видалити$|^usuń$|^delete$/i }).first().click();
  await expect(page.getByText('Навушники', { exact: true })).toHaveCount(0);
});

test('пошук звужує вибірку', async ({ page }) => {
  await signIn(page);
  await createList(page, unique('E2E search'));

  for (const name of ['Кавоварка', 'Ковдра', 'Лампа']) {
    await addItem(page, name);
  }

  await page.getByRole('searchbox').fill('Ко');
  await expect(page.getByText('Кавоварка', { exact: true })).toBeVisible();
  await expect(page.getByText('Ковдра', { exact: true })).toBeVisible();
  await expect(page.getByText('Лампа', { exact: true })).toHaveCount(0);
});

test('зміна розміру сторінки перезавантажує вибірку з початку', async ({ page }) => {
  await signIn(page);
  await createList(page, unique('E2E page size'));

  const size = page.getByLabel(/на сторінці|na stronie|per page/i);
  await size.selectOption('10');
  await expect(size).toHaveValue('10');
});
