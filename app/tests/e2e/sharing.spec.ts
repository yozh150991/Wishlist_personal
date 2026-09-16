import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Найважливіші тести застосунку: перевіряють, що гість бачить рівно те,
 * чим із ним поділились, і нічого більше.
 *
 *   $env:E2E_EMAIL="ти@пошта"; $env:E2E_PASSWORD="..."
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

async function setUpList(page: Page, titles: string[]): Promise<string> {
  const listTitle = `Share ${Date.now()}`;
  await page.getByRole('button', { name: /створити список|utwórz listę|create list/i }).first().click();
  await page.getByLabel(/^назва$|^nazwa$|^title$/i).fill(listTitle);
  await page.getByRole('button', { name: /^зберегти$|^zapisz$|^save$/i }).click();
  await page.getByRole('link', { name: listTitle }).click();

  for (const name of titles) {
    await page.getByRole('button', { name: /додати позицію|dodaj pozycję|add item/i }).click();
    await page.getByLabel(/^назва$|^nazwa$|^title$/i).fill(name);
    await page.getByRole('button', { name: /^зберегти$|^zapisz$|^save$/i }).click();
  }
  return listTitle;
}

test('гість бачить тільки вибрані позиції', async ({ page, browser }) => {
  await signIn(page);
  await setUpList(page, ['Ділюсь А', 'Ділюсь Б', 'Таємна В']);

  await page.getByRole('button', { name: /^поділитися$|^udostępnij$|^share$/i }).click();
  await page.getByLabel(/вибрати «Ділюсь А»|Ділюсь А/i).check();
  await page.getByLabel(/вибрати «Ділюсь Б»|Ділюсь Б/i).check();
  await page.getByRole('button', { name: /створити посилання|utwórz link|create link/i }).click();

  await page.getByLabel(/^заголовок для гостей$|heading for guests|nagłówek/i).fill('Тест');
  await page.getByRole('button', { name: /створити посилання|utwórz link|create link/i }).click();

  const link = await page.getByLabel(/^посилання$|^link$/i).inputValue();
  expect(link).toMatch(/\/s\/[A-Za-z0-9_-]{22}/);

  // Окремий контекст = чистий браузер без сесії. Саме так це побачать рідні.
  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await guestPage.goto(link);

  await expect(guestPage.getByText('Ділюсь А')).toBeVisible();
  await expect(guestPage.getByText('Ділюсь Б')).toBeVisible();
  await expect(guestPage.getByText('Таємна В')).toHaveCount(0);
  await guest.close();
});

test('гість не відкриє головний список за прямою адресою', async ({ page, browser }) => {
  await signIn(page);
  await page.getByRole('link', { name: /Share /i }).first().click();
  const listUrl = page.url();

  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await guestPage.goto(listUrl);
  await expect(guestPage).toHaveURL(/\/login/);
  await guest.close();
});

test('бронювання видно другому гостю і не видно власнику', async ({ page, browser }) => {
  await signIn(page);
  await page.getByRole('link', { name: /Share /i }).first().click();
  await page.getByRole('link', { name: /посилання|linki|links/i }).click();
  await page.getByRole('button', { name: /^копіювати$|^kopiuj$|^copy$/i }).first().click();
  const link = await page.evaluate(() => navigator.clipboard.readText());

  const first = await browser.newContext();
  const firstPage = await first.newPage();
  await firstPage.goto(link);
  await firstPage.getByRole('button', { name: /я візьму це|biorę to|i'll take this/i }).first().click();
  await expect(firstPage.getByText(/ти береш|bierzesz|you're taking/i)).toBeVisible();

  const second = await browser.newContext();
  const secondPage = await second.newPage();
  await secondPage.goto(link);
  await expect(secondPage.getByText(/уже беруть|już zajęte|already taken/i)).toBeVisible();

  // ІНВАРІАНТ: власник відкриває власне посилання і броней не бачить.
  await page.goto(link);
  await expect(page.getByText(/це твоє посилання|to twój link|this is your own link/i)).toBeVisible();
  await expect(page.getByText(/уже беруть|już zajęte|already taken/i)).toHaveCount(0);

  await first.close();
  await second.close();
});

test('відкликане посилання перестає відкриватись', async ({ page, browser }) => {
  await signIn(page);
  await page.getByRole('link', { name: /посилання|linki|links/i }).click();
  await page.getByRole('button', { name: /^копіювати$|^kopiuj$|^copy$/i }).first().click();
  const link = await page.evaluate(() => navigator.clipboard.readText());

  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: /відкликати|unieważnij|revoke/i }).first().click();

  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await guestPage.goto(link);
  await expect(guestPage.getByText(/посилання недоступне|link niedostępny|isn't available/i)).toBeVisible();
  await guest.close();
});
