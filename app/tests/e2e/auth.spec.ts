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

test('мову можна перемкнути до входу, і вибір запамʼятовується', async ({ page }) => {
  await page.goto('/register');
  const picker = page.getByRole('group', { name: /мова|język|language/i });

  await picker.getByRole('button', { name: /^Polski/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Rejestracja' })).toBeVisible();
  await expect(picker.getByRole('button', { name: /^Polski/ })).toHaveAttribute('aria-pressed', 'true');

  // Вибір переживає перехід на іншу сторінку і перезавантаження.
  await page.goto('/login');
  await expect(page.getByRole('heading', { level: 1, name: 'Logowanie' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Logowanie' })).toBeVisible();
});

test('форми входу й реєстрації впізнає менеджер паролів', async ({ page }) => {
  // Менеджер паролів шукає <form> із полями username і current-password
  // (або new-password) та кнопкою submit. Без цього він не пропонує зберегти пароль.
  await page.goto('/login');
  const login = page.locator('form').filter({ has: page.locator('input[autocomplete="current-password"]') });
  await expect(login).toHaveCount(1);
  await expect(login.locator('input[autocomplete="username"]')).toHaveCount(1);
  await expect(login.locator('button[type="submit"]')).toHaveCount(1);

  await page.goto('/register');
  const register = page.locator('form').filter({ has: page.locator('input[autocomplete="new-password"]') });
  await expect(register).toHaveCount(1);
  await expect(register.locator('input[autocomplete="username"]')).toHaveCount(1);
  await expect(register.locator('input[autocomplete="new-password"]')).toHaveCount(2);
  await expect(register.locator('button[type="submit"]')).toHaveCount(1);
});

test('Enter у будь-якому полі реєстрації відправляє форму', async ({ page }) => {
  // Раніше Enter спрацьовував лише в полі «Пароль ще раз».
  await page.goto('/register');
  await page.getByLabel(/пошта|e-mail|email/i).fill('test@example.com');
  const password = page.getByLabel(/^пароль$|^hasło$|^password$/i);
  await password.fill('123');
  await password.press('Enter');
  // Шукаємо саме помилку (role=alert): підказка про 8 символів видна під полем і без відправки.
  await expect(page.getByRole('alert')).toContainText(/щонайменше 8|co najmniej 8|at least 8/i);
});

test('Enter у формі скидання пароля відправляє форму', async ({ page }) => {
  await page.goto('/reset');
  await page.getByLabel(/пошта|e-mail|email/i).press('Enter');
  await expect(page.getByRole('alert')).toBeVisible();
});
