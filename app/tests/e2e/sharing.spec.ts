import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { addItem, createList, hasAccount, setStatus, shareLink, signIn, unique } from './helpers';

/**
 * Найважливіші тести застосунку: гість бачить рівно те, чим із ним
 * поділились, і нічого більше; власник не бачить броней (CLAUDE.md §3.2).
 *
 * Кожен сценарій створює собі список і посилання сам — тести йдуть
 * паралельно, і дані одного не мають бути передумовою іншого. Кожен гість —
 * окремий browser context: чистий браузер без сесії, як у рідних.
 */
test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

async function guest(browser: Browser, link: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return page;
}

const gcard = (page: Page, title: string) => page.locator('.v2-gcard').filter({ hasText: title });

test('гість бачить тільки вибрані позиції', async ({ page, browser }) => {
  await signIn(page);
  await createList(page, unique('Share'));
  for (const name of ['Ділюсь А', 'Ділюсь Б', 'Таємна В']) await addItem(page, name);
  const link = await shareLink(page, ['Ділюсь А', 'Ділюсь Б'], 'Тест');

  const g = await guest(browser, link);
  await g.getByRole('radio', { name: /^(усі|wszystkie|all) 2$/i }).click();
  await expect(gcard(g, 'Ділюсь А')).toBeVisible();
  await expect(gcard(g, 'Ділюсь Б')).toBeVisible();
  await expect(g.getByText('Таємна В')).toHaveCount(0);
  await g.context().close();
});

test('гість не відкриє головний список за прямою адресою', async ({ page, browser }) => {
  await signIn(page);
  await createList(page, unique('Share direct'));
  await addItem(page, 'Приватна позиція');
  const listUrl = page.url();

  const ctx = await browser.newContext();
  const g = await ctx.newPage();
  await g.goto(listUrl);
  await expect(g).toHaveURL(/\/login\?next=/);
  await expect(g.getByText('Приватна позиція')).toHaveCount(0);
  await ctx.close();
});

test('бронь видно другому гостю й не видно власнику', async ({ page, browser }) => {
  await signIn(page);
  await createList(page, unique('Share reserve'));
  await addItem(page, 'Подарунок');
  const link = await shareLink(page, ['Подарунок'], 'Бронювання');

  const first = await guest(browser, link);
  await gcard(first, 'Подарунок').getByRole('button', { name: /^(беру|biorę|take)$/i }).click();
  const sheet = first.getByRole('dialog');
  await sheet.locator('input[name="guest_name"]').fill('Тарас-e2e');
  await sheet.getByRole('button', { name: /^(забронювати|zarezerwuj|take it)$/i }).click();
  await sheet.getByRole('button', { name: /^(готово|gotowe|done)$/i }).click();
  await expect(gcard(first, 'Подарунок')).toContainText(/ви берете|bierzesz to|you're taking this/i);

  // Єдину позицію взято — другий гість бачить «Усе вже розібрали».
  const second = await guest(browser, link);
  await expect(second.getByRole('heading', { name: /усе вже розібрали|wszystko już rozebrane|everything's been taken/i })).toBeVisible();
  await expect(second.getByText('Тарас-e2e')).toHaveCount(0);

  // ІНВАРІАНТ: власник відкриває власне посилання і позначок не бачить.
  await page.goto(link);
  await expect(page.getByText(/це твоє посилання|to twój link|your own link/i)).toBeVisible();
  await expect(gcard(page, 'Подарунок')).toBeVisible();
  // Лише видиме: закриті аркуші з тими самими словами лишаються в DOM.
  await expect(page.getByText(/розібрали|уже взяли|взято|rozebrane|wzięte|taken/i).filter({ visible: true })).toHaveCount(0);
  await expect(page.getByText('Тарас-e2e').filter({ visible: true })).toHaveCount(0);

  await first.context().close();
  await second.context().close();
});

test('Enter у заголовку створює рівно одне посилання, навіть якщо натиснути двічі', async ({ page }) => {
  await signIn(page);
  await createList(page, unique('Share enter'));
  await addItem(page, 'Одна позиція');

  await page.getByRole('button', { name: /^(поділитися|udostępnij|share)$/i }).first().click();
  const sheet = page.getByRole('dialog');
  const shareTitle = unique('Enter');
  const title = sheet.locator('input[name="share_title"]');
  await title.fill(shareTitle);
  await title.press('Enter');
  // Друге натискання — саме те, що перевіряє тест. Тайм-аут обовʼязковий: якщо
  // аркуш уже показав посилання, поля заголовка немає (TESTING.md, правило 4).
  await title.press('Enter', { timeout: 1000 }).catch(() => {});
  await expect(sheet.locator('input[readonly]')).toHaveValue(/\/l\/[A-Za-z0-9_-]{16,}$/);

  await page.goto('/shares');
  await expect(page.getByRole('heading', { name: shareTitle })).toHaveCount(1);
});

test('куплене не пропонується в посилання й не доходить до гостя', async ({ page, browser }) => {
  await signIn(page);
  await createList(page, unique('Share active only'));
  await addItem(page, 'Актуальна');
  await addItem(page, 'Уже куплена');
  await setStatus(page, 'Уже куплена', /^(куплено|kupione|purchased)$/i);

  // У переліку «Обрати» лише актуальні позиції — купленої там немає зовсім.
  await page.getByRole('button', { name: /^(поділитися|udostępnij|share)$/i }).first().click();
  const sheet = page.getByRole('dialog');
  const choose = sheet.getByRole('button', { name: /^(обрати|wybierz|choose)$/i });
  if (await choose.isVisible()) await choose.click();
  await expect(sheet.getByRole('checkbox', { name: /Актуальна/ })).toBeVisible();
  await expect(sheet.getByRole('checkbox', { name: /Уже куплена/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);

  const link = await shareLink(page, ['Актуальна'], 'Лише актуальні');
  const g = await guest(browser, link);
  await expect(gcard(g, 'Актуальна')).toBeVisible();
  await expect(g.getByText('Уже куплена')).toHaveCount(0);
  await g.context().close();
});
