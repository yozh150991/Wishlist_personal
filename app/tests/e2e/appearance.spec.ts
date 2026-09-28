import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { hasAccount, signIn } from './helpers';

/**
 * Вигляд: п'ять схем смаку, висока контрастність і правило вирішення
 * (lib/appearance.ts, ADR-033).
 *
 * Перевіряється не колір, а атрибути на <html>: саме за них чіпляються
 * дванадцять наборів токенів, а контраст кожного набору стереже
 * `npm run check:contrast`.
 */

const html = (page: Page) => page.locator('html');

test('системне prefers-contrast: more вмикає Вугіль ще до рендера', async ({ page }) => {
  await page.emulateMedia({ contrast: 'more' });
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await expect(html(page)).toHaveAttribute('data-scheme', 'vuhil');
});

test('старе «Вугіль» у сховищі стає тумблером контрасту, а смак — усталеним', async ({ page }) => {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.setItem('wl.scheme', 'vuhil');
    localStorage.removeItem('wl.contrast');
  });
  await page.reload();
  await expect(html(page)).toHaveAttribute('data-scheme', 'vuhil');
  await expect
    .poll(() => page.evaluate(() => [localStorage.getItem('wl.scheme'), localStorage.getItem('wl.contrast')]))
    .toEqual(['sage', '1']);
  await page.evaluate(() => localStorage.setItem('wl.contrast', '0'));
});

test.describe('з акаунтом', () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('коли контраст просить система, тумблер увімкнений і пояснює чому', async ({ page }) => {
    await page.emulateMedia({ contrast: 'more' });
    await signIn(page);
    await page.goto('/settings');
    const contrast = page.getByRole('switch', { name: /висока контрастність|wysoki kontrast|high contrast/i });
    await expect(contrast).toHaveAttribute('aria-checked', 'true');
    await expect(contrast).toBeDisabled();
    await expect(html(page)).toHaveAttribute('data-scheme', 'vuhil');
  });
});

/**
 * Ці тести міняють профіль спільного тестового акаунта. Профіль один на всі
 * паралельні прогони, тож вони йдуть послідовно й лише в одній розкладці:
 * інакше друга розкладка відновлювала б Шавлію посеред перевірки першої.
 */
test.describe('з акаунтом, профіль', () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'chromium', 'Профіль спільний — перевіряється в одній розкладці');
  });

  test('пʼять схем смаку, Вугіль — лише з тумблера, вимкнення повертає свій смак', async ({ page }) => {
    await signIn(page);
    await page.goto('/settings');
    const colors = page.getByRole('radiogroup', { name: /кольори|kolory|colors/i });

    await expect(colors.getByRole('radio')).toHaveCount(5);
    await expect(colors.getByRole('radio', { name: /вугіль|węgiel|charcoal/i })).toHaveCount(0);

    const contrast = page.getByRole('switch', { name: /висока контрастність|wysoki kontrast|high contrast/i });
    try {
      await colors.getByRole('radio', { name: /полотно|płótno|canvas/i }).click();
      await expect(html(page)).toHaveAttribute('data-scheme', 'polotno');

      await contrast.click();
      await expect(contrast).toHaveAttribute('aria-checked', 'true');
      await expect(html(page)).toHaveAttribute('data-scheme', 'vuhil');

      // Вибір переживає перезавантаження: він у профілі, а не лише в браузері.
      await page.reload();
      await expect(html(page)).toHaveAttribute('data-scheme', 'vuhil');

      // Тумблер не перезаписує смак: вимкнув — повернувся до Полотна.
      await contrast.click();
      await expect(html(page)).toHaveAttribute('data-scheme', 'polotno');
    } finally {
      if ((await contrast.getAttribute('aria-checked')) === 'true') await contrast.click();
      await colors.getByRole('radio', { name: /шавлія|szałwia|sage/i }).click();
      await expect(html(page)).toHaveAttribute('data-scheme', 'sage');
    }
  });

  test('Ніч — темна за замовчуванням, але ручний вибір теми її перекриває', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await signIn(page);
    await page.goto('/settings');
    const colors = page.getByRole('radiogroup', { name: /кольори|kolory|colors/i });
    const themes = page.getByRole('radiogroup', { name: /^тема$|^motyw$|^theme$/i });
    try {
      await themes.getByRole('radio', { name: /як у системі|jak w systemie|match system/i }).click();
      await colors.getByRole('radio', { name: /ніч|noc|night/i }).click();
      await expect(html(page)).toHaveAttribute('data-scheme', 'nich');
      await expect(html(page)).toHaveAttribute('data-theme', 'dark');

      await themes.getByRole('radio', { name: /світла|jasny|light/i }).click();
      await expect(html(page)).toHaveAttribute('data-theme', 'light');
      await expect(html(page)).toHaveAttribute('data-scheme', 'nich');
    } finally {
      await colors.getByRole('radio', { name: /шавлія|szałwia|sage/i }).click();
      await themes.getByRole('radio', { name: /як у системі|jak w systemie|match system/i }).click();
    }
  });
});
