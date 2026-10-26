import { test, expect } from '@playwright/test';

/**
 * Картка «Безпека» (ADR-074): лист про вхід із нового пристрою типово
 * ввімкнений навіть без налаштувань, вибір переживає перезавантаження, а
 * «Вийти на всіх пристроях» веде на вхід.
 *
 * Вихід скрізь відкликає всі сесії акаунта — спільний тестовий акаунт так
 * не можна, тож тест реєструє свіжий. Реєстрація без листа — лише на
 * локальній базі (E2E_LOCALDB, TESTING.md).
 */

const localDb = Boolean(process.env.E2E_LOCALDB);

test('«Безпека»: лист типово так, вибір зберігається, «Вийти скрізь» — на вхід', async ({ page }) => {
  test.skip(!localDb, 'Реєстрація без підтвердження — лише на локальній базі');

  const email = `security-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@wishlist.test`;
  await page.goto('/register');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[autocomplete="new-password"]').fill('kava-z-molokom-74');
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/lists$/, { timeout: 15_000 });

  await page.goto('/settings#security');
  const card = page.locator('#security');
  await expect(card).toBeVisible();
  const mail = card.getByTestId('signin-email');
  await expect(mail).toHaveAttribute('aria-checked', 'true');

  await mail.click();
  await expect(mail).toHaveAttribute('aria-checked', 'false');
  await expect(card.getByRole('status')).toContainText(/нічого не дізнаєшся|się nie dowiesz|won.t hear/i);
  await page.reload();
  await expect(page.locator('#security').getByTestId('signin-email')).toHaveAttribute('aria-checked', 'false');
  await page.locator('#security').getByTestId('signin-email').click();
  await expect(page.locator('#security').getByTestId('signin-email')).toHaveAttribute('aria-checked', 'true');

  await expect(card.getByRole('link', { name: /змінити пароль|zmień hasło|change password/i })).toHaveAttribute('href', '/reset');

  await page.locator('#security').getByRole('button', { name: /вийти на всіх пристроях|wyloguj na wszystkich|sign out on all devices/i }).click();
  const sheet = page.getByRole('dialog', { name: /вийти на всіх пристроях|wylogować na wszystkich|sign out on all devices/i });
  await expect(sheet).toBeVisible();
  await sheet.getByRole('button', { name: /вийти скрізь|wyloguj wszędzie|sign out everywhere/i }).click();
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });

  // Сесії справді немає: захищена сторінка знову веде на вхід.
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/login/);
});
