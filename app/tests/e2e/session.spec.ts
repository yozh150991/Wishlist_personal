import { test, expect } from '@playwright/test';
import { EMAIL, PASSWORD, hasAccount, signIn } from './helpers';

/**
 * Поведінка сесії: вхід клавішею Enter, повернення на ?next, F5 без виходу.
 */
test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

test('вхід клавішею Enter повертає на сторінку з ?next', async ({ page }) => {
  await page.goto('/shares');
  await expect(page).toHaveURL(/\/login\?next=%2Fshares/);

  await page.getByLabel(/пошта|e-mail|email/i).fill(EMAIL!);
  const password = page.getByLabel(/пароль|hasło|password/i);
  await password.fill(PASSWORD!);
  await password.press('Enter');

  await expect(page).toHaveURL(/\/shares$/);
});

test('F5 на захищеній сторінці не викидає на вхід', async ({ page }) => {
  await signIn(page);
  await page.goto('/shares');
  await expect(page).toHaveURL(/\/shares$/);

  await page.reload();
  await expect(page).toHaveURL(/\/shares$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('без мережі — зрозуміла помилка, а не «[object Object]» чи порожній стан', async ({ page, context }) => {
  await signIn(page);
  await context.setOffline(true);

  // Перехід усередині застосунку: сторінку не перевантажуємо, запит даних падає.
  await page.getByRole('link', { name: /^посилання$|^linki$|^links$/i }).click();

  await expect(page.getByText(/немає зʼєднання|немає з'єднання|brak połączenia|no internet connection/i)).toBeVisible();
  await expect(page.getByText('[object Object]')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2, name: /посилань ще немає|nie ma jeszcze linków|no links yet/i })).toHaveCount(0);

  await context.setOffline(false);
});

test('у налаштуваннях є розділ встановлення застосунку', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings');
  const section = page.getByTestId('install');
  await expect(section.getByRole('heading', { name: /застосунок на телефоні|aplikacja na telefonie|app on your phone/i })).toBeVisible();
  // У тестовому браузері подія встановлення не приходить, тож видно одну з підказок.
  await expect(section.locator('p')).not.toHaveText('');
});
