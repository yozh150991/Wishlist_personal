import { test, expect } from '@playwright/test';

/**
 * Сценарії етапу 2. Реєстрація і вхід із реальним акаунтом
 * додаються на етапі 3, коли зʼявиться тестовий користувач у seed.
 */

test('захищений роут редіректить неавтентифікованого на вхід', async ({ page }) => {
  await page.goto('/lists');
  await expect(page).toHaveURL(/\/login\?next=%2Flists/);
});

test('корінь веде на списки, а звідти на вхід', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL(/\/login/);
});

test('на сторінці входу є поля пошти й пароля', async ({ page }) => {
  await page.goto('/login');
  await expect(page.getByLabel(/пошта|e-mail|email/i)).toBeVisible();
  await expect(page.getByLabel(/пароль|hasło|password/i)).toBeVisible();
});

test('перехід між входом, реєстрацією і скиданням пароля', async ({ page }) => {
  await page.goto('/login');
  await page.getByRole('link', { name: /зареєструватися|załóż|create one/i }).click();
  await expect(page).toHaveURL(/\/register/);

  await page.getByRole('link', { name: /увійти|zaloguj|sign in/i }).click();
  await expect(page).toHaveURL(/\/login/);

  await page.getByRole('link', { name: /забув пароль|nie pamiętam|forgot/i }).click();
  await expect(page).toHaveURL(/\/reset/);
});

test('реєстрація не приймає короткий пароль', async ({ page }) => {
  await page.goto('/register');
  await page.getByLabel(/пошта|e-mail|email/i).fill('test@example.com');
  await page.getByLabel(/^пароль$|^hasło$|^password$/i).fill('123');
  await page.getByLabel(/ще раз|ponownie|again/i).fill('123');
  await page.getByRole('button', { name: /створити|załóż|create/i }).click();
  await expect(page.getByRole('alert')).toBeVisible();
});

test('невідома адреса дає сторінку 404', async ({ page }) => {
  await page.goto('/такої-сторінки-немає');
  await expect(page.getByText(/сторінки немає|nie ma takiej|no such page/i)).toBeVisible();
});
