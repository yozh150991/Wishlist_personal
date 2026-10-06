import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { addItem, createList, createShare, hasAccount, signIn, unique } from './helpers';

/**
 * Гостьова v2 під `/l/…` (крок 5а; ADR-041, ADR-053; потік E).
 *
 * Версію гостьової визначає адреса, а не сховище (ADR-039, п. 11), тож
 * власника тут готують наявні помічники, а гості відкривають `/l/…`.
 * Кожен гість — окремий browser context, як рідні на різних телефонах.
 *
 * Головне, що стережемо: підпис гостя бачить лише він сам — ні власник на
 * своєму посиланні, ні інший гість (CLAUDE.md §3.2).
 */
const takeBtn = /^(беру|biorę|take)$/i;
const yours = /ви берете|bierzesz to|you're taking this/i;
const NAME = 'Іра-e2e';

async function guest(browser: Browser, link: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return page;
}

const card = (page: Page, title: string) => page.locator('.v2-gcard').filter({ hasText: title });

test.describe('з акаунтом власника', () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('бронь із підписом, код і «Уже маю броні»; підпис не бачить ніхто, крім гостя', async ({ page, browser }) => {
    await signIn(page);
    await createList(page, unique('Guest v2'));
    for (const name of ['Сковорода', 'Рушники']) await addItem(page, name);
    const sLink = await createShare(page, ['Сковорода', 'Рушники'], unique('Гостям'));
    await page.keyboard.press('Escape');
    const link = sLink.replace('/s/', '/l/');
    const token = link.split('/l/')[1]!;

    // Гість A: «Беру» → аркуш із підписом → код після першої броні.
    const a = await guest(browser, link);
    await expect(a.locator('html')).toHaveAttribute('data-design', 'v2');
    await card(a, 'Сковорода').getByRole('button', { name: takeBtn }).click();
    const sheet = a.getByRole('dialog');
    await expect(sheet.getByRole('heading', { name: /сковорода/i })).toBeVisible();
    await sheet.locator('input[name="guest_name"]').fill(NAME);
    await sheet.getByRole('button', { name: /^(забронювати|zarezerwuj|take it)$/i }).click();
    await expect(sheet.getByRole('heading', { name: /за вами|twoje|is yours/i })).toBeVisible();
    const code = (await sheet.locator('.v2-gcode').innerText()).trim();
    expect(code).toMatch(/^[2-9ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);
    await sheet.getByRole('button', { name: /^(готово|gotowe|done)$/i }).click();
    await expect(card(a, 'Сковорода')).toContainText(yours);
    await expect(a.getByRole('button', { name: /мої броні · 1|moje rezerwacje · 1|my picks · 1/i })).toBeVisible();
    // Ключ — у браузері, не в адресі.
    expect(await a.evaluate((tk) => localStorage.getItem(`wl.gk.${tk}`), token)).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
    await expect(a).toHaveURL(new RegExp(`/l/${token}$`));

    // Власник на своєму посиланні: ні броней, ні підпису.
    await page.goto(link);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByText(/це твоє посилання|to twój link|your own link/i)).toBeVisible();
    await expect(page.getByText(yours)).toHaveCount(0);
    await expect(page.getByText(NAME)).toHaveCount(0);

    // Гість B: позиція взята, хто — невідомо.
    const b = await guest(browser, link);
    await b.getByRole('radio', { name: /^(усі|wszystkie|all) 2$/i }).click();
    await expect(card(b, 'Сковорода')).toContainText(/уже взяли|już wzięte|already taken/i);
    await expect(b.getByText(NAME)).toHaveCount(0);

    // Гість C: «Уже маю броні» → код → броні й підпис на новому пристрої.
    const c = await guest(browser, link);
    await c.getByRole('button', { name: /уже маю броні|mam już rezerwacje|already have picks/i }).click();
    const redeem = c.getByRole('dialog');
    await redeem.locator('input[name="guest_code"]').fill(code.toLowerCase());
    await redeem.getByRole('button', { name: /відкрити мої броні|otwórz moje rezerwacje|open my picks/i }).click();
    await expect(card(c, 'Сковорода')).toContainText(yours);
    await c.getByRole('button', { name: /мої броні · 1|moje rezerwacje · 1|my picks · 1/i }).click();
    await expect(c.getByRole('dialog')).toContainText(NAME);
    await c.keyboard.press('Escape');

    // Гість A знімає бронь: тост «Відмінити», запит — після відліку.
    const released = a.waitForResponse((r) => r.url().includes('/rpc/release_claim'), { timeout: 15_000 });
    await card(a, 'Сковорода').getByRole('button', { name: /^(зняти|zdejmij|release)$/i }).click();
    await expect(a.getByRole('status').filter({ hasText: /бронь знято|rezerwacja zdjęta|released/i })).toBeVisible();
    await released;
    await a.reload();
    await expect(card(a, 'Сковорода').getByRole('button', { name: takeBtn })).toBeVisible();

    for (const p of [a, b, c]) await p.context().close();
  });
});

test('мертве посилання під /l/ — один екран і доля броней', { tag: '@both' }, async ({ page }) => {
  await page.goto('/l/e2e-nonexistent-token');
  await expect(page.getByRole('heading', { name: /більше не працює|już nie działa|no longer works/i })).toBeVisible();
  await expect(page.getByText(/бронь знято|rezerwację zdjęto|pick was released/i)).toBeVisible();
});
