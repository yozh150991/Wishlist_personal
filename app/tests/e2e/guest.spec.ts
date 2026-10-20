import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { addItem, createList, hasAccount, itemMenu, shareLink, signIn, unique } from './helpers';

/**
 * Гість без акаунта (ADR-035, ADR-053): особисте посилання, програш гонки,
 * «Усе вже розібрали» зі стеженням, сліпе скидання власником, усталений
 * фільтр «Вільні». Бронь із підписом і код — у guest-v2.spec.ts.
 *
 * Кожен гість — окремий browser context: саме так рідні відкривають посилання
 * на різних телефонах.
 */
test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

const takeBtn = /^(беру|biorę|take)$/i;
const yours = /ви берете|bierzesz to|you're taking this/i;

async function guest(browser: Browser, link: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return page;
}

const card = (page: Page, title: string) => page.locator('.v2-gcard').filter({ hasText: title });

/** «Беру» → підпис → «Забронювати»; перша бронь показує код — закриваємо. */
async function take(page: Page, title: string) {
  await card(page, title).getByRole('button', { name: takeBtn }).click();
  const sheet = page.getByRole('dialog');
  await sheet.locator('input[name="guest_name"]').fill('Гість-e2e');
  await sheet.getByRole('button', { name: /^(забронювати|zarezerwuj|take it)$/i }).click();
  await sheet.getByRole('button', { name: /^(готово|gotowe|done)$/i }).click();
  await expect(card(page, title)).toContainText(yours);
}

/** Власник створює список із позиціями й посилання на всі; лишається на сторінці списку. */
async function setup(page: Page, items: string[]): Promise<{ link: string; token: string }> {
  await signIn(page);
  await createList(page, unique('Guest'));
  for (const name of items) await addItem(page, name);
  const link = await shareLink(page, items, unique('Гостям'));
  return { link, token: link.split('/l/')[1]! };
}

test('особисте посилання переносить броні на інший пристрій, «Надіслати собі» дає його ж', async ({ page, browser }) => {
  const { link, token } = await setup(page, ['Глечик']);

  const first = await guest(browser, link);
  await take(first, 'Глечик');
  const key = await first.evaluate((tk) => localStorage.getItem(`wl.gk.${tk}`), token);
  expect(key).toMatch(/^[A-Za-z0-9_-]{22,64}$/);

  // Системного «Поділитися» в тестовому браузері може й не бути, а буфер
  // потребує дозволу. Вимикаємо перше й підміняємо друге, щоб прочитати, що
  // саме сторінка скопіювала б.
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, 'share', { configurable: true, value: undefined });
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          w.__copied.push(text);
        },
      },
    });
  });
  const second = await ctx.newPage();
  await second.goto(`${link}/g/${key}`);
  // Ключ лягає в браузер і зникає з адреси (ADR-035).
  await expect(second).toHaveURL(new RegExp(`/l/${token}$`));
  await expect(card(second, 'Глечик')).toContainText(yours);

  await second.getByRole('button', { name: /мої броні · 1|moje rezerwacje · 1|my picks · 1/i }).click();
  await second
    .getByRole('dialog')
    .getByRole('button', { name: /надіслати собі посилання|wyślij sobie link|send myself the link/i })
    .click();
  await expect.poll(() => second.evaluate(() => (window as unknown as { __copied: string[] }).__copied.length)).toBe(1);
  const copied = await second.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
  expect(copied[0]).toMatch(new RegExp(`/l/${token}/g/${key}$`));

  await first.context().close();
  await ctx.close();
});

test('програш гонки пояснюється аркушем, позиція стає взятою', async ({ page, browser }) => {
  const { link } = await setup(page, ['Кавомолка', 'Дошка']);

  const slow = await guest(browser, link);
  const fast = await guest(browser, link);
  await take(fast, 'Кавомолка');

  // Повільний гість ще бачить стару сторінку й тисне.
  await card(slow, 'Кавомолка').getByRole('button', { name: takeBtn }).click();
  const sheet = slow.getByRole('dialog');
  await sheet.locator('input[name="guest_name"]').fill('Повільний');
  await sheet.getByRole('button', { name: /^(забронювати|zarezerwuj|take it)$/i }).click();
  await expect(sheet.getByRole('heading', { name: /щойно взяв хтось інший|właśnie wziął|just took/i })).toBeVisible();
  await sheet.getByRole('button', { name: /повернутись до списку|wróć do listy|back to the list/i }).click();

  // Перечитана сторінка: «Кавомолки» серед вільних немає, «Дошка» лишилась.
  await expect(card(slow, 'Кавомолка')).toHaveCount(0);
  await expect(card(slow, 'Дошка').getByRole('button', { name: takeBtn })).toBeVisible();
  await slow.context().close();
  await fast.context().close();
});

test('«Усе вже розібрали», стеження й сліпе скидання власником', async ({ page, browser }) => {
  const { link } = await setup(page, ['Постіль']);

  const taker = await guest(browser, link);
  await take(taker, 'Постіль');
  // Свої броні не рахуються як «хтось інший»: нагорі — «з них ваші».
  await expect(taker.getByRole('heading', { name: /1 з них ваші|1 z tego twoje|1 by you/i })).toBeVisible();

  const watcher = await guest(browser, link);
  await expect(watcher.getByRole('heading', { name: /усе вже розібрали|wszystko już rozebrane|everything's been taken/i })).toBeVisible();
  await expect(watcher.getByText('Постіль')).toBeVisible();
  await watcher.getByRole('button', { name: /стежити за списком|obserwuj listę|follow this list/i }).click();
  await expect(watcher.getByText(/ви стежите за списком|obserwujesz listę|following this list/i)).toBeVisible();

  // Власник скидає позицію наосліп: нічого не дізнається, лише «скинуто».
  const menu = await itemMenu(page, 'Постіль');
  await menu.getByRole('button', { name: /^(змінити|zmień|edit)$/i }).click();
  const sheet = page.getByRole('dialog').filter({ has: page.locator('input[name="title"]') });
  await sheet.getByRole('button', { name: /скинути позицію|zresetuj pozycję|reset item/i }).click();
  await page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: /скинути позицію «Постіль»|zresetować pozycję „Постіль”|reset “Постіль”/i }) })
    .getByRole('button', { name: /скинути позицію|zresetuj pozycję|reset item/i })
    .click();
  await expect(sheet.getByText(/позицію скинуто|pozycję zresetowano|item reset/i)).toBeVisible();

  // Той, хто стежив, наступного разу бачить, що звільнилось.
  await watcher.reload();
  await expect(watcher.getByText(/звільнилось — 1|zwolniło się — 1|1 available again/i)).toBeVisible();
  await expect(card(watcher, 'Постіль').getByRole('button', { name: takeBtn })).toBeVisible();

  // Гість, чию бронь скинуто, бачить позицію вільною.
  await taker.reload();
  await expect(card(taker, 'Постіль')).not.toContainText(yours);
  await expect(card(taker, 'Постіль').getByRole('button', { name: takeBtn })).toBeVisible();
  await taker.context().close();
  await watcher.context().close();
});

test('гість типово бачить вільні, «Усі» поруч; чужа бронь — без імені й без дій', async ({ page, browser }) => {
  const { link } = await setup(page, ['Ваза', 'Лампа']);
  const a = await guest(browser, link);
  await take(a, 'Ваза');

  const b = await guest(browser, link);
  await expect(b.getByRole('radio', { name: /^(вільні|wolne|available) 1$/i })).toBeChecked();
  await expect(card(b, 'Ваза')).toHaveCount(0);
  await b.getByRole('radio', { name: /^(усі|wszystkie|all) 2$/i }).click();
  const taken = card(b, 'Ваза');
  await expect(taken).toContainText(/уже взяли|już wzięte|already taken/i);
  await expect(taken).not.toContainText('Гість-e2e');
  await expect(taken.getByRole('button', { name: takeBtn })).toHaveCount(0);
  await a.context().close();
  await b.context().close();
});
