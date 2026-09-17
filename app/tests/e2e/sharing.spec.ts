import { test, expect } from '@playwright/test';
import { addItem, createList, createShare, hasAccount, signIn, unique } from './helpers';

/**
 * Найважливіші тести застосунку: перевіряють, що гість бачить рівно те,
 * чим із ним поділились, і нічого більше.
 *
 * Кожен сценарій створює собі список і посилання сам — тести йдуть
 * паралельно, і дані одного не мають бути передумовою іншого.
 */
test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

test('гість бачить тільки вибрані позиції', async ({ page, browser }) => {
  await signIn(page);
  await createList(page, unique('Share'));
  for (const name of ['Ділюсь А', 'Ділюсь Б', 'Таємна В']) await addItem(page, name);

  const link = await createShare(page, ['Ділюсь А', 'Ділюсь Б'], 'Тест');

  // Окремий контекст = чистий браузер без сесії. Саме так це побачать рідні.
  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await guestPage.goto(link);

  await expect(guestPage.getByText('Ділюсь А', { exact: true })).toBeVisible();
  await expect(guestPage.getByText('Ділюсь Б', { exact: true })).toBeVisible();
  await expect(guestPage.getByText('Таємна В', { exact: true })).toHaveCount(0);
  await guest.close();
});

test('гість не відкриє головний список за прямою адресою', async ({ page, browser }) => {
  await signIn(page);
  await createList(page, unique('Share direct'));
  await addItem(page, 'Приватна позиція');
  const listUrl = page.url();

  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await guestPage.goto(listUrl);
  await expect(guestPage).toHaveURL(/\/login/);
  await expect(guestPage.getByText('Приватна позиція')).toHaveCount(0);
  await guest.close();
});

test('бронювання видно другому гостю і не видно власнику', async ({ page, browser }) => {
  await signIn(page);
  await createList(page, unique('Share reserve'));
  await addItem(page, 'Подарунок');
  const link = await createShare(page, ['Подарунок'], 'Бронювання');

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
  await expect(page.getByText('Подарунок', { exact: true })).toBeVisible();
  await expect(page.getByText(/уже беруть|już zajęte|already taken/i)).toHaveCount(0);

  await first.close();
  await second.close();
});

test('відкликане посилання перестає відкриватись', async ({ page, browser }) => {
  await signIn(page);
  await createList(page, unique('Share revoke'));
  await addItem(page, 'Тимчасове');
  const shareTitle = unique('Відкликати');
  const link = await createShare(page, ['Тимчасове'], shareTitle);

  await page.goto('/shares');
  const card = page.getByRole('listitem').filter({ has: page.getByRole('heading', { name: shareTitle }) });
  page.once('dialog', (d) => void d.accept());
  await card.getByRole('button', { name: /відкликати|unieważnij|revoke/i }).click();
  await expect(card.getByRole('button', { name: /відкликати|unieważnij|revoke/i })).toHaveCount(0);

  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await guestPage.goto(link);
  await expect(guestPage.getByText(/посилання недоступне|link niedostępny|isn't available/i)).toBeVisible();
  await guest.close();
});
