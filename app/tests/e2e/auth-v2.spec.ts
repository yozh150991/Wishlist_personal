import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { EMAIL, PASSWORD, hasAccount } from './helpers';

/**
 * Вхід, реєстрація й пароль дизайну v2 (ROADMAP, «Дизайн v2», крок 2).
 *
 * Тег `@v2` — ці тести йдуть лише у v2-проєктах (`chromium-v2`, `mobile-v2`),
 * де `wl.design = v2` уже в сховищі. Перемикач версії на екрані входу —
 * `@both`: він мусить працювати з обох боків.
 *
 * Більшість перевірок не потребує бази: валідація, вимоги до пароля й
 * переходи між екранами живуть на клієнті. Вхід паролем і пауза після
 * трьох невдалих спроб — з акаунтом.
 *
 * Кодів із пошти немає (ADR-042), тож і тестів на них немає.
 */

const emailBox = (page: Page) => page.locator('input[name="email"]');
const passwordBox = (page: Page) => page.locator('input[name="password"]');
const submit = (page: Page, name: RegExp) => page.locator('button[type="submit"]').filter({ hasText: name });

const SIGN_IN = /^(увійти|zaloguj się|sign in)$/i;

test.describe('вхід v2', { tag: '@v2' }, () => {
  test('помилка під полем на виході з поля; кнопка не блокується й веде до першого хибного поля', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('html')).toHaveAttribute('data-design', 'v2');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      /твій список лишається твоїм|twoja lista zostaje twoja|your list stays yours/i,
    );

    // На виході з поля — «бракує @», а не на кожній літері.
    await emailBox(page).fill('marta.pochta.ua');
    await expect(page.getByText(/бракує знака @|brakuje znaku @|the @ sign is missing/i)).toHaveCount(0);
    await emailBox(page).blur();
    await expect(page.getByText(/бракує знака @|brakuje znaku @|the @ sign is missing/i)).toBeVisible();
    await expect(emailBox(page)).toHaveAttribute('aria-invalid', 'true');

    // Кнопка активна: натиск переводить фокус до першого поля з помилкою.
    await submit(page, SIGN_IN).click();
    await expect(emailBox(page)).toBeFocused();

    // Помилка зникає, щойно рядок стає коректним; поле не очищається.
    await emailBox(page).fill('marta@pochta.ua');
    await expect(page.getByText(/бракує знака @|brakuje znaku @|the @ sign is missing/i)).toHaveCount(0);

    // Порожній пароль — наступний на черзі; «Не памʼятаєш пароль?» лишається поруч.
    await submit(page, SIGN_IN).click();
    await expect(passwordBox(page)).toBeFocused();
    await expect(page.getByText(/введи пароль|wpisz hasło|enter your password/i)).toBeVisible();
    await expect(page.getByRole('link', { name: /не памʼятаєш пароль|nie pamiętasz hasła|forgot your password/i })).toBeVisible();
  });

  test('«показати пароль» міняє тип поля й каже про стан', async ({ page }) => {
    await page.goto('/login');
    await passwordBox(page).fill('secret-123');
    const toggle = page.getByRole('button', { name: /показати пароль|pokaż hasło|show password/i });
    await toggle.click();
    await expect(passwordBox(page)).toHaveAttribute('type', 'text');
    await expect(page.getByRole('button', { name: /сховати пароль|ukryj hasło|hide password/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  test('«Не памʼятаєш пароль?» веде на скидання з уже підставленою поштою', async ({ page }) => {
    await page.goto('/login');
    await emailBox(page).fill('marta@pochta.ua');
    await page.getByRole('link', { name: /не памʼятаєш пароль|nie pamiętasz hasła|forgot your password/i }).click();
    await expect(page).toHaveURL(/\/reset$/);
    await expect(emailBox(page)).toHaveValue('marta@pochta.ua');
    // Кодів немає (ADR-042): лише «надіслати посилання».
    await expect(submit(page, /надіслати посилання|wyślij link|send link/i)).toBeVisible();
  });

  test('реєстрація: вимоги до пароля видно наперед і відмічаються під час введення', async ({ page }) => {
    await page.goto('/register');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/новий акаунт|nowe konto|new account/i);

    const rule = (name: RegExp) => page.getByRole('listitem').filter({ hasText: name });
    const long = rule(/8/);
    const notEmail = rule(/з поштою|adres e-mail|your email/i);
    const notCommon = rule(/найпоширеніших|najpopularniejszych|most common/i);
    const met = /виконано|spełnione|done/i;
    const open = /ще ні|jeszcze nie|not yet/i;

    await expect(long).toContainText(open);

    await emailBox(page).fill('marta@pochta.ua');
    await passwordBox(page).fill('12345678');
    await expect(long).toContainText(met);
    await expect(notCommon).toContainText(open);

    await passwordBox(page).fill('marta@pochta.ua');
    await expect(notEmail).toContainText(open);

    // Кнопка не блокується: натиск із невиконаними вимогами — фокус на пароль.
    await submit(page, /створити акаунт|utwórz konto|create account/i).click();
    await expect(passwordBox(page)).toBeFocused();
    await expect(page.getByText(/не відповідає вимогам|nie spełnia jeszcze wymagań|doesn't meet the requirements/i)).toBeVisible();

    await passwordBox(page).fill('kava-z-molokom-7');
    await expect(long).toContainText(met);
    await expect(notEmail).toContainText(met);
    await expect(notCommon).toContainText(met);
  });

  test('новий пароль без сесії — сторінка «посилання не діє» з полем пошти', async ({ page }) => {
    await page.goto('/update-password');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      /це посилання вже використане|ten link został już użyty|this link has already been used/i,
    );
    await expect(submit(page, /надіслати нове посилання|wyślij nowy link|send a new link/i)).toBeVisible();
  });

  test('скасований вхід через Google повертає без червоного', async ({ page }) => {
    // Так Supabase повертає людину, яка закрила вікно Google (потік Q).
    await page.goto('/login?error=access_denied&error_description=cancelled');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    // Параметри помилки прибрано: F5 не покаже нічого нового.
    await expect(page).toHaveURL(/\/login$/);
  });

  test('протерміноване посилання з листа — «Посилання вже не діє» з повторним листом', async ({ page }) => {
    await page.goto('/login?error=access_denied&error_code=otp_expired&error_description=expired');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      /посилання вже не діє|link już nie działa|this link no longer works/i,
    );
    await expect(submit(page, /надіслати новий лист|wyślij nową wiadomość|send a new email/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login$/);
  });
});

/**
 * Вибір версії ще до входу (ADR-039, п. 4): посилання під формою веде на той
 * самий екран в іншій версії й не губить `next`. Іде в усіх проєктах — у
 * v1-проєктах перемикаємо на v2, у v2-проєктах навпаки.
 */
test('перемикач версії на екрані входу веде на той самий екран і зберігає next', { tag: '@both' }, async ({ page }) => {
  await page.goto('/login?next=%2Fshares');
  const html = page.locator('html');
  const before = await html.getAttribute('data-design');
  const after = before === 'v2' ? 'v1' : 'v2';

  await page
    .getByRole('link', { name: /новий вигляд|nowy wygląd|new look|старого вигляду|starego wyglądu|old look/i })
    .click();
  await expect(html).toHaveAttribute('data-design', after);
  await expect(page).toHaveURL(/\/login\?next=%2Fshares$/);
  // Вибір запамʼятовано: F5 лишає нову версію.
  await page.reload();
  await expect(html).toHaveAttribute('data-design', after);
});

test.describe('вхід v2 з акаунтом', { tag: '@v2' }, () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('вхід паролем веде на «Мої списки» з «Вітаю!», вихід повертає на вхід', async ({ page }) => {
    await page.goto('/login');
    await emailBox(page).fill(EMAIL!);
    await passwordBox(page).fill(PASSWORD!);
    await submit(page, SIGN_IN).click();
    await expect(page).toHaveURL(/\/lists$/);
    await expect(page.locator('html')).toHaveAttribute('data-design', 'v2');
    // Стрічка вітання — лише після входу з екрана входу (A4).
    await expect(page.getByRole('status').filter({ hasText: /вітаю|witaj|welcome/i })).toBeVisible();

    // Вихід — у Налаштуваннях: на телефоні бічної колонки немає.
    await page.goto('/settings');
    await page.getByRole('main').getByRole('button', { name: /^(вийти|wyloguj się|sign out)$/i }).click();
    await expect(page).toHaveURL(/\/login\?next=/);
  });

  test('три невдалі спроби поспіль — пауза з лічильником і порадою скинути пароль', async ({ page }) => {
    await page.goto('/login');
    await emailBox(page).fill(EMAIL!);
    for (let i = 0; i < 3; i++) {
      await passwordBox(page).fill(`wrong-password-${i}`);
      await submit(page, SIGN_IN).click();
      await expect(page.getByRole('alert').first()).toContainText(
        /не підходять|nie pasują|don't match|не підійшли|nie pasowały|didn't match/i,
      );
    }
    await expect(page.locator('button[type="submit"]')).toHaveText(/знову можна за|znowu można za|try again in/i);
    await expect(page.getByRole('alert').getByRole('link', { name: /скинути пароль|zresetuj hasło|reset password/i })).toBeVisible();
    // Поля не очищаються: людина повертається до свого тексту.
    await expect(emailBox(page)).toHaveValue(EMAIL!);
  });
});
