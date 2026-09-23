import { test, expect } from '@playwright/test';
import { hasAccount, signIn } from './helpers';

/**
 * Перемикач версії дизайну (ADR-032).
 *
 * v2 — не інші кольори, а інша таблиця маршрутів: свої екрани й свій порядок
 * кроків. Тому тести перевіряють не вигляд, а те, що ця таблиця справді
 * підмінюється, що з неї є вихід і що вона не зачіпає гостьову сторінку.
 *
 * Поки пакет v2 не приїхав, у її таблиці один екран-заглушка. Перевірки
 * нижче написані так, щоб наповнення v2 їх не зламало: вони питають про
 * версію й про можливість вийти, а не про конкретний вміст екрана.
 */

const backButton = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: /v1/i });

/**
 * Аварійний вихід не потребує акаунта — і це його суть: він має працювати
 * тоді, коли застосунок не працює.
 */
test('?design= перемикає версію до рендера й не лишається в адресі', async ({ page }) => {
  await page.goto('/login?design=v2', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-design', 'v2');
  // Параметр знято одразу: інакше він поїхав би далі в скопійованому посиланні.
  await expect(page).toHaveURL(/\/login$/);

  // Решту параметрів зняття не чіпає — на них тримається повернення після входу.
  await page.goto('/login?next=%2Fshares&design=v1', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-design', 'v1');
  await expect(page).toHaveURL(/\/login\?next=%2Fshares$/);
});

test.describe('з акаунтом', () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('перемикання в Налаштуваннях міняє таблицю маршрутів і переживає F5', async ({ page }) => {
    await signIn(page);
    await page.goto('/settings');

    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-design', 'v1');

    await page.getByTestId('design').getByRole('radio', { name: /v2/i }).click();

    // Перемикання веде на корінь із перезавантаженням: адреси версій не
    // зобов'язані збігатися, тож лишатися на /settings не можна.
    await expect(html).toHaveAttribute('data-design', 'v2');
    await expect(page).not.toHaveURL(/\/settings$/);

    await page.reload();
    await expect(html).toHaveAttribute('data-design', 'v2');

    // З v2 завжди є дорога назад, навіть поки в неї немає власних Налаштувань.
    await backButton(page).click();
    await expect(html).toHaveAttribute('data-design', 'v1');
    await page.reload();
    await expect(html).toHaveAttribute('data-design', 'v1');
  });

  test('вибір версії не чіпає тему й схему', async ({ page }) => {
    await signIn(page);
    await page.goto('/settings');

    const html = page.locator('html');
    const scheme = await html.getAttribute('data-scheme');
    const theme = await html.getAttribute('data-theme');

    await page.getByTestId('design').getByRole('radio', { name: /v2/i }).click();
    await expect(html).toHaveAttribute('data-design', 'v2');
    await expect(html).toHaveAttribute('data-scheme', scheme!);
    await expect(html).toHaveAttribute('data-theme', theme!);

    await backButton(page).click();
    await expect(html).toHaveAttribute('data-design', 'v1');
  });
});

/**
 * Інваріант: версія власника не доходить до гостя.
 *
 * Посилання вже роздані рідним, і незакінчений флоу не має відкритися їм
 * через те, що власник щось перемкнув у себе в браузері. Тест іде на мертвий
 * токен — сторінка помилки теж належить гостьовому екрану, а не заглушці v2.
 */
test('гостьова сторінка не переходить на v2 разом із рештою застосунку', async ({ page }) => {
  await page.goto('/login?design=v2', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-design', 'v2');

  await page.goto('/s/e2e-nonexistent-token');
  await expect(backButton(page)).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  await page.goto('/login?design=v1', { waitUntil: 'domcontentloaded' });
});
