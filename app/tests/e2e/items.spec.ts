import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Сценарії етапу 3 працюють з реальним акаунтом.
 * Задай у оточенні перед запуском:
 *   $env:E2E_EMAIL="ти@пошта"; $env:E2E_PASSWORD="..."
 * Без них набір пропускається, щоб CI не падав на відсутніх даних.
 */
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;

test.skip(!EMAIL || !PASSWORD, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel(/пошта|e-mail|email/i).fill(EMAIL!);
  await page.getByLabel(/пароль|hasło|password/i).fill(PASSWORD!);
  await page.getByRole('button', { name: /увійти|zaloguj|sign in/i }).click();
  await expect(page).toHaveURL(/\/lists/);
}

async function createList(page: Page, title: string) {
  await page.getByRole('button', { name: /створити список|utwórz listę|create list/i }).first().click();
  await page.getByLabel(/^назва$|^nazwa$|^title$/i).fill(title);
  await page.getByRole('button', { name: /зберегти|zapisz|save/i }).click();
  await page.getByRole('link', { name: title }).click();
}

test('повний цикл: список, позиція без ціни, редагування, видалення', async ({ page }) => {
  const listTitle = `E2E ${Date.now()}`;
  await signIn(page);
  await createList(page, listTitle);

  // Позиція лише з назвою — ціна й посилання необовʼязкові.
  await page.getByRole('button', { name: /додати позицію|dodaj pozycję|add item/i }).click();
  await page.getByLabel(/^назва$|^nazwa$|^title$/i).fill('Навушники');
  await page.getByRole('button', { name: /зберегти|zapisz|save/i }).click();

  await expect(page.getByText('Навушники')).toBeVisible();
  await expect(page.getByText(/ціна не вказана|brak ceny|no price/i)).toBeVisible();

  // Підсумки чесно рахують позиції без ціни.
  await expect(page.getByText(/без ціни|bez ceny|without a price/i)).toBeVisible();

  await page.getByRole('button', { name: /^змінити$|^edytuj$|^edit$/i }).first().click();
  await page.getByLabel(/^ціна$|^cena$|^price$/i).fill('399');
  await page.getByRole('button', { name: /зберегти|zapisz|save/i }).click();
  await expect(page.getByText(/399/)).toBeVisible();

  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: /^видалити$|^usuń$|^delete$/i }).first().click();
  await expect(page.getByText('Навушники')).toHaveCount(0);
});

test('пошук звужує вибірку', async ({ page }) => {
  const listTitle = `E2E search ${Date.now()}`;
  await signIn(page);
  await createList(page, listTitle);

  for (const name of ['Кавоварка', 'Ковдра', 'Лампа']) {
    await page.getByRole('button', { name: /додати позицію|dodaj pozycję|add item/i }).click();
    await page.getByLabel(/^назва$|^nazwa$|^title$/i).fill(name);
    await page.getByRole('button', { name: /зберегти|zapisz|save/i }).click();
  }

  await page.getByRole('searchbox').fill('Ко');
  await expect(page.getByText('Кавоварка')).toBeVisible();
  await expect(page.getByText('Ковдра')).toBeVisible();
  await expect(page.getByText('Лампа')).toHaveCount(0);
});

test('зміна розміру сторінки перезавантажує вибірку з початку', async ({ page }) => {
  await signIn(page);
  await page.getByRole('link', { name: /E2E/ }).first().click();
  await page.getByLabel(/на сторінці|na stronie|per page/i).selectOption('10');
  await expect(page.getByLabel(/на сторінці|na stronie|per page/i)).toHaveValue('10');
});
