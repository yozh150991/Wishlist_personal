import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { addItem, createList, hasAccount, shareLink, signIn, unique } from './helpers';

/**
 * «Про мене» (ROADMAP 8.10): гість бачить розміри, «що люблю» й «не дарувати»
 * лише на посиланні, де власник це ввімкнув. Без дозволу блоку немає зовсім.
 *
 * Профіль у тестового акаунта один на всі паралельні прогони (десктоп і
 * телефон пишуть його водночас), тому вміст звіряється за шаблоном `E2E <час>-…`,
 * а не точним рядком; відсутність блоку від цього не залежить.
 */
test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

async function guest(browser: Browser, link: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('.v2-gcard').first()).toBeVisible();
  return page;
}

/** Блок «Про мене» видно й розгорнуто (на телефоні він згорнутий). */
async function openAbout(page: Page) {
  const block = page.getByTestId('guest-about');
  await expect(block).toBeVisible();
  if ((await block.getAttribute('open')) === null) await block.locator('summary').click();
  await expect(block.locator('dd').first()).toBeVisible();
  return block;
}

test('«Про мене»: без дозволу гість не бачить, з дозволом — бачить', async ({ page, browser }) => {
  const mark = unique('E2E');
  await signIn(page);

  // Заповнити «Про мене» в Налаштуваннях.
  await page.goto('/settings');
  const form = page.getByTestId('about-form');
  await expect(form).toBeVisible();
  await form.locator('input[name="about_sizes"]').fill(`M / 42 / ${mark}`);
  await form.locator('textarea[name="about_likes"]').fill(`Чай ${mark}`);
  await form.locator('textarea[name="about_avoid"]').fill('Парфуми');
  await form.getByRole('button', { name: /^(зберегти|zapisz|save)$/i }).click();
  await expect(form.getByText(/^(збережено|zapisano|saved)\.$/i)).toBeVisible();

  await createList(page, unique('About'));
  await addItem(page, 'Светр');

  // Посилання без дозволу — блоку немає, жодного рядка профілю.
  const closedTitle = unique('Без про мене');
  const closed = await shareLink(page, ['Светр'], closedTitle);
  const g1 = await guest(browser, closed);
  await expect(g1.getByTestId('guest-about')).toHaveCount(0);
  await expect(g1.getByText(mark)).toHaveCount(0);
  await expect(g1.getByText('Парфуми')).toHaveCount(0);
  await g1.context().close();

  // Посилання з дозволом — блок є.
  const open = await shareLink(page, ['Светр'], unique('З про мене'), { about: true });
  const g2 = await guest(browser, open);
  const block = await openAbout(g2);
  await expect(block).toContainText(/E2E \d+-/);
  await expect(block).toContainText('Парфуми');
  await g2.context().close();

  // Дозвіл на одному посиланні не відкриває інше.
  const g3 = await guest(browser, closed);
  await expect(g3.getByTestId('guest-about')).toHaveCount(0);

  // Увімкнути на першому посиланні з «Моїх посилань» — тепер видно й там.
  await page.goto('/shares');
  const card = page.locator('.v2-sharecard').filter({ hasText: closedTitle });
  const toggle = card.getByRole('switch', { name: /про мене|o mnie|about me/i });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await page.reload();
  await expect(
    page.locator('.v2-sharecard').filter({ hasText: closedTitle }).getByRole('switch', { name: /про мене|o mnie|about me/i }),
  ).toHaveAttribute('aria-checked', 'true');

  await g3.reload();
  await expect(g3.getByRole('heading', { level: 1 })).toBeVisible();
  await openAbout(g3);
  await g3.context().close();
});
