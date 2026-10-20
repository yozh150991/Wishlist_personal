import { test, expect } from '@playwright/test';
import { EMAIL, PASSWORD, hasAccount } from './helpers';

/**
 * «Я дарую» (крок 6, ADR-062). Прив'язку броней до акаунта, виключення власних
 * списків і attach_guest_key стереже pgTAP 22 — для цього потрібні два акаунти,
 * а e2e має один. Тут — що вкладка є в навігації, відкривається й не показує
 * власних списків цього акаунта.
 */

test.describe('«Я дарую» v2', () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('вкладка в навігації; власних списків серед подарунків немає', async ({ page }) => {
    await page.goto('/login');
    await page.locator('input[name="email"]').fill(EMAIL!);
    await page.locator('input[name="password"]').fill(PASSWORD!);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/lists$/);
    const own = await page.locator('main h2, main h3').allInnerTexts();

    await page.getByRole('navigation').getByRole('link', { name: /я дарую|daruję|i'm giving/i }).click();
    await expect(page).toHaveURL(/\/gifts$/);
    await expect(page.getByRole('heading', { level: 1, name: /я дарую|daruję|i'm giving/i })).toBeVisible();
    await expect(page.locator('main[aria-busy]')).toHaveCount(0);

    const titles = await page.locator('.v2-sharecard__title').allInnerTexts();
    for (const t of titles) expect(own).not.toContain(t);
    if (titles.length === 0) {
      await expect(page.getByText(/тут поки порожньо|na razie pusto|nothing here yet/i)).toBeVisible();
    }
  });
});
