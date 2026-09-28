import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { addItem, createList, hasAccount, settledDialog, signIn, unique } from './helpers';

/**
 * Термін посилання — доба власника (ADR-037). Власник і гість живуть у різних
 * зонах: браузер Playwright уміє підмінити зону на рівні контексту, тож
 * «власник у Києві, гість у Ванкувері» — це два контексти, а не два сервери.
 */
test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

const nextYear = new Date().getFullYear() + 1;

/** Сьогоднішній день у зоні — як його бачить календар власника. */
function dayIn(tz: string, shiftDays = 0): string {
  const d = new Date(Date.now() + shiftDays * 86_400_000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** Власник створює посилання з терміном і повертає адресу (або null, якщо форма відмовила). */
async function shareUntil(page: Page, until: string): Promise<string | null> {
  await signIn(page);
  await createList(page, unique('Expiry'));
  await addItem(page, 'Гірлянда');
  await page.getByRole('button', { name: /^вибрати$|^zaznacz$|^select$/i }).click();
  await page.getByRole('checkbox', { name: /Гірлянда/ }).check();
  await page.getByRole('button', { name: /створити посилання|utwórz link|create link/i }).click();

  const dialog = await settledDialog(page);
  await dialog.getByLabel(/^заголовок для гостей$|heading for guests|nagłówek/i).fill(unique('Термін'));
  if (until) await dialog.getByLabel(/^(діє до|ważny do|valid until)$/i).fill(until);
  await dialog.getByRole('button', { name: /створити посилання|utwórz link|create link/i }).click();

  const link = dialog.locator('#shareLink');
  const refused = dialog.getByText(/дата вже минула|data już minęła|date has passed/i);
  await expect(link.or(refused)).toBeVisible();
  return (await link.count()) ? link.inputValue() : null;
}

async function guestIn(browser: Browser, link: string, timezoneId: string): Promise<Page> {
  const ctx = await browser.newContext({ timezoneId });
  const guest = await ctx.newPage();
  await guest.goto(link);
  await expect(guest.getByRole('heading', { level: 1 })).toBeVisible();
  return guest;
}

test.describe('власник у Києві', () => {
  test.use({ timezoneId: 'Europe/Kyiv' });

  test('гість у Ванкувері бачить час і місто власника, а не свій годинник', async ({ page, browser }) => {
    const link = await shareUntil(page, `${nextYear}-12-20`);
    expect(link).not.toBeNull();

    const guest = await guestIn(browser, link!, 'America/Vancouver');
    // У Ванкувері в цей момент 13:59 — але гість має бачити 23:59 за Києвом.
    await expect(guest.locator('.guest__valid')).toHaveText(
      /^(діє до|ważny do|valid until) .*20.*, (23:59|11:59\sPM) (за києвом|czasu kijowskiego|kyiv time)$/i,
    );
    await guest.context().close();
  });

  test('дата в минулому не створює мертве посилання', async ({ page }) => {
    const link = await shareUntil(page, dayIn('Europe/Kyiv', -1));
    expect(link).toBeNull();
  });

  test('сьогодні — можна: посилання живе до кінця дня власника', async ({ page, browser }) => {
    const link = await shareUntil(page, dayIn('Europe/Kyiv'));
    expect(link).not.toBeNull();
    const guest = await guestIn(browser, link!, 'Europe/Kyiv');
    await expect(guest.locator('.guest__valid')).toHaveText(/(23:59|11:59\sPM)/);
    await guest.context().close();
  });

  test('без терміну гість не бачить рядка про термін', async ({ page, browser }) => {
    const link = await shareUntil(page, '');
    const guest = await guestIn(browser, link!, 'America/Vancouver');
    await expect(guest.locator('.guest__valid')).toHaveCount(0);
    await guest.context().close();
  });
});

test.describe('власник у Токіо', () => {
  test.use({ timezoneId: 'Asia/Tokyo' });

  test('зона без власного рядка — назва від браузера в дужках', async ({ page, browser }) => {
    const link = await shareUntil(page, `${nextYear}-12-20`);
    const guest = await guestIn(browser, link!, 'Europe/Warsaw');
    await expect(guest.locator('.guest__valid')).toHaveText(/, (23:59|11:59\sPM) \(.+\)$/);
    await guest.context().close();
  });
});
