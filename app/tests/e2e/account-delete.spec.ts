import { test, expect } from '@playwright/test';
import { createList, unique } from './helpers';

/**
 * Видалення акаунта (ADR-072): хибний пароль нічого не стирає, правильний —
 * видаляє акаунт, екран входу каже «Акаунт видалено», а увійти тими самими
 * даними вже не можна.
 *
 * Акаунт кожен тест реєструє собі сам: видаляти спільний тестовий акаунт
 * не можна. Реєстрація без листа працює лише на локальній базі, де
 * підтвердження пошти вимкнене (supabase/config.toml), — тому тест лише
 * проти неї (E2E_LOCALDB, TESTING.md).
 */

const localDb = Boolean(process.env.E2E_LOCALDB);

test('видалення акаунта: хибний пароль — ні, правильний — акаунт зник', async ({ page }) => {
  test.skip(!localDb, 'Реєстрація без підтвердження — лише на локальній базі');

  const email = `delete-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@wishlist.test`;
  const password = 'kava-z-molokom-72';

  await page.goto('/register');
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[autocomplete="new-password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/lists$/, { timeout: 15_000 });

  await createList(page, unique('Зникне'));

  await page.goto('/settings');
  await page.getByRole('button', { name: /видалити акаунт|usuń konto|delete account/i }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();

  // Порожній пароль — підказка біля поля, без запиту.
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog.locator('input[name="password"]')).toBeFocused();

  // Хибний — повідомлення, акаунт на місці.
  await dialog.locator('input[name="password"]').fill('not-my-password');
  await dialog.locator('button[type="submit"]').click();
  await expect(dialog.getByText(/пароль не підходить|hasło się nie zgadza|password doesn.t match/i)).toBeVisible({
    timeout: 10_000,
  });
  await expect(page).toHaveURL(/\/settings$/);

  // Правильний — вихід на екран входу з повідомленням.
  await dialog.locator('input[name="password"]').fill(password);
  await dialog.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 });
  await expect(page.getByText(/акаунт видалено|konto usunięte|account deleted/i)).toBeVisible();

  // Тими самими даними більше не увійти.
  await page.locator('input[name="email"]').fill(email);
  await page.locator('input[name="password"]').fill(password);
  await page.locator('button[type="submit"]').click();
  await expect(page.getByRole('alert')).toContainText(/не підходять|nie zgadzają|don.t match/i, { timeout: 10_000 });
  await expect(page).toHaveURL(/\/login/);
});
