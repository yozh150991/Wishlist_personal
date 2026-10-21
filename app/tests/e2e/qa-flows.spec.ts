import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { createList, hasAccount, itemCard, itemMenu, signIn, unique } from './helpers';

/**
 * QA-регресія за техніками тест-дизайну (ADR-069) — наскрізь через інтерфейс.
 * Чисту логіку й базу ті самі техніки покривають у qa-techniques.spec.ts і
 * pgTAP 25–28; тут — лише те, що видно лише в браузері:
 *
 *  - pairwise: «Показувати ціни» × «Гості можуть позначати» × «Діє до» —
 *    4 посилання замість 8, і що бачить гість на кожному;
 *  - BVA: межі полів форми позиції там, де їх ставить сам браузер;
 *  - state transition: гість бере → «Уже куплено» → знімає;
 *  - error guessing: розмітка в назві не виконується; довга назва без
 *    пробілів не розпирає сторінку на телефоні.
 */

const takeBtn = /^(беру|biorę|take)$/i;
const yours = /ви берете|bierzesz to|you're taking this/i;
const price = /1[\s  .,]?240[.,]50/;

async function guest(browser: Browser, link: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return page;
}

const guestCard = (page: Page, title: string) => page.locator('.v2-gcard').filter({ hasText: title });

/** Позиція вручну з ціною — як addItem у helpers, плюс поле ціни. */
async function addPriced(page: Page, title: string, value: string) {
  await page.getByRole('button', { name: /^(додати позицію|dodaj pozycję|add item)$/i }).first().click();
  const sheet = page.getByRole('dialog', { name: /нова позиція|nowa pozycja|new item/i });
  await sheet.getByRole('button', { name: /вписати вручну|wpisz ręcznie|type it in/i }).click();
  await sheet.locator('input[name="title"]').fill(title);
  await sheet.locator('input[name="price"]').fill(value);
  await sheet.getByRole('button', { name: /^(додати|dodaj|add)$/i }).click();
  await expect(sheet).toHaveCount(0);
  await expect(itemCard(page, title).first()).toBeVisible();
}

/** «Поділитися» з усіма позиціями й заданими перемикачами; повертає адресу. */
async function shareWith(
  page: Page,
  title: string,
  opts: { showPrices: boolean; allowClaims: boolean; expires: string | null },
): Promise<string> {
  await page.getByRole('button', { name: /^(поділитися|udostępnij|share)$/i }).first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.locator('input[name="share_title"]')).toBeVisible();
  await sheet.locator('input[name="share_title"]').fill(title);
  const switches: [RegExp, boolean][] = [
    [/показувати ціни|pokazuj ceny|show prices/i, opts.showPrices],
    [/гості можуть позначати|goście mogą oznaczać|guests can mark/i, opts.allowClaims],
  ];
  for (const [name, want] of switches) {
    const sw = sheet.getByRole('switch', { name });
    if ((await sw.getAttribute('aria-checked')) !== String(want)) await sw.click();
    await expect(sw).toHaveAttribute('aria-checked', String(want));
  }
  if (opts.expires) await sheet.locator('input[name="share_expires"]').fill(opts.expires);
  await sheet.getByRole('button', { name: /^(створити посилання|utwórz link|create link)$/i }).click();
  await expect(sheet.getByRole('heading', { name: /посилання готове|link gotowy|link is ready/i })).toBeVisible();
  const link = await sheet.locator('input[readonly]').inputValue();
  await sheet.getByRole('button', { name: /^(готово|gotowe|done)$/i }).first().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  return link;
}

function inDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test.describe('QA: наскрізні сценарії', () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('pairwise: ціни × позначки × термін — гість бачить рівно те, що дозволено', async ({ page, browser }) => {
    test.setTimeout(120_000);
    await signIn(page);
    await createList(page, unique('QA pairwise'));
    await addPriced(page, 'Кавник', '1 240,50');

    // Покривний масив L4(2³): кожна пара значень двох перемикачів трапляється.
    const rows = [
      { showPrices: true, allowClaims: true, expires: null },
      { showPrices: true, allowClaims: false, expires: inDays(30) },
      { showPrices: false, allowClaims: true, expires: inDays(30) },
      { showPrices: false, allowClaims: false, expires: null },
    ];
    for (const [n, row] of rows.entries()) {
      const link = await shareWith(page, unique(`QA рядок ${n + 1}`), row);
      const g = await guest(browser, link);
      const card = guestCard(g, 'Кавник');
      await expect(card).toBeVisible();
      if (row.showPrices) await expect(card, `рядок ${n + 1}: ціна`).toContainText(price);
      else await expect(card, `рядок ${n + 1}: ціни немає`).not.toContainText(price);
      await expect(card.getByRole('button', { name: takeBtn }), `рядок ${n + 1}: «Беру»`).toHaveCount(row.allowClaims ? 1 : 0);
      await expect(g.getByText(/діє до|ważny do|valid until/i), `рядок ${n + 1}: термін`).toHaveCount(row.expires ? 1 : 0);
      await g.context().close();
    }
  });

  test('BVA: назва обрізається браузером на 200, кількість 999 — так, 1000 і 0 — ні', async ({ page }) => {
    await signIn(page);
    await createList(page, unique('QA межі'));
    await page.getByRole('button', { name: /^(додати позицію|dodaj pozycję|add item)$/i }).first().click();
    const sheet = page.getByRole('dialog', { name: /нова позиція|nowa pozycja|new item/i });
    await sheet.getByRole('button', { name: /вписати вручну|wpisz ręcznie|type it in/i }).click();

    const title = sheet.locator('input[name="title"]');
    await title.fill('я'.repeat(201));
    await expect(title).toHaveValue('я'.repeat(200));

    const qty = sheet.locator('input[name="quantity"]');
    const add = sheet.getByRole('button', { name: /^(додати|dodaj|add)$/i });
    const qtyError = sheet.getByText(/ціле число від 1 до 999|liczba całkowita od 1 do 999|whole number from 1 to 999/i);
    for (const bad of ['1000', '0', '2.5']) {
      await qty.fill(bad);
      await add.click();
      await expect(qtyError, bad).toBeVisible();
      await expect(sheet, bad).toBeVisible();
    }
    await qty.fill('999');
    await add.click();
    await expect(sheet).toHaveCount(0);
    await expect(itemCard(page, 'я'.repeat(200)).first()).toBeVisible();
  });

  test('BUG-QA-13: ціна «1.2.3» у формі — помилка під полем, а не позиція за 12,30', async ({ page }) => {
    test.fail(true, 'BUG-QA-13: parsePrice читає криві розряди як число, і позиція зберігається');
    await signIn(page);
    await createList(page, unique('QA ціна'));
    await page.getByRole('button', { name: /^(додати позицію|dodaj pozycję|add item)$/i }).first().click();
    const sheet = page.getByRole('dialog', { name: /нова позиція|nowa pozycja|new item/i });
    await sheet.getByRole('button', { name: /вписати вручну|wpisz ręcznie|type it in/i }).click();
    await sheet.locator('input[name="title"]').fill('Криві розряди');
    await sheet.locator('input[name="price"]').fill('1.2.3');
    await sheet.getByRole('button', { name: /^(додати|dodaj|add)$/i }).click();
    await expect(sheet.locator('input[name="price"]')).toHaveAttribute('aria-invalid', 'true', { timeout: 3000 });
  });

  test('state transition: гість бере → «Уже куплено» → «Ще не куплено» → знімає; кожен стан переживає F5', async ({ page, browser }) => {
    await signIn(page);
    await createList(page, unique('QA стани'));
    await addPriced(page, 'Чайник', '199');
    const link = await shareWith(page, unique('QA стани'), { showPrices: true, allowClaims: true, expires: null });

    const g = await guest(browser, link);
    const card = () => guestCard(g, 'Чайник');

    // FREE → TAKEN
    await card().getByRole('button', { name: takeBtn }).click();
    const sheet = g.getByRole('dialog');
    await sheet.getByRole('button', { name: /^(забронювати|zarezerwuj|take it)$/i }).click();
    await expect(sheet.getByRole('heading', { name: /за вами|twoje|is yours/i })).toBeVisible();
    await sheet.getByRole('button', { name: /^(готово|gotowe|done)$/i }).click();
    await expect(card()).toContainText(yours);
    await g.reload();
    await expect(card(), 'TAKEN переживає F5').toContainText(yours);

    // TAKEN → BOUGHT
    const bought = g.waitForResponse((r) => r.url().includes('/rpc/set_claim_bought'));
    await card().getByRole('button', { name: /уже куплено|już kupione|already bought/i }).click();
    await bought;
    await g.reload();
    await expect(card(), 'BOUGHT переживає F5').toContainText(/куплено|kupione|bought/i);

    // У BOUGHT на картці дій немає навмисно — щоб не зняти покупку випадковим
    // дотиком; «Ще не куплено» й «Зняти бронь» живуть у «Моїх бронях».
    await expect(card().getByRole('button'), 'BOUGHT: на картці жодної дії').toHaveCount(0);
    const picks = () => g.getByRole('button', { name: /мої броні · 1|moje rezerwacje · 1|my picks · 1/i });

    // BOUGHT → TAKEN («Ще не куплено»)
    await picks().click();
    const unmarked = g.waitForResponse((r) => r.url().includes('/rpc/set_claim_bought'));
    await g.getByRole('dialog').getByRole('button', { name: /ще не куплено|jeszcze nie kupione|not bought yet/i }).click();
    await unmarked;
    await g.reload();
    await expect(card(), 'BOUGHT → TAKEN переживає F5').toContainText(yours);
    await expect(card().getByRole('button', { name: /уже куплено|już kupione|already bought/i })).toBeVisible();

    // TAKEN → BOUGHT → FREE («Зняти бронь» з «Моїх броней»)
    await card().getByRole('button', { name: /уже куплено|już kupione|already bought/i }).click();
    await expect(card().getByRole('button')).toHaveCount(0);
    await picks().click();
    const released = g.waitForResponse((r) => r.url().includes('/rpc/release_claim'), { timeout: 15_000 });
    await g.getByRole('dialog').getByRole('button', { name: /зняти бронь|zdejmij rezerwację|release pick/i }).click();
    await released;
    await g.reload();
    await expect(card().getByRole('button', { name: takeBtn }), 'BOUGHT → FREE: «Беру» знову є').toBeVisible();

    // Власник за весь цикл не бачить нічого з цього (CLAUDE.md §3.2).
    await page.reload();
    await expect(itemCard(page, 'Чайник').first()).not.toContainText(/взяли|wzięte|taken|куплено|kupione|bought/i);
    await g.context().close();
  });

  test('error guessing: розмітка в назві — лише текст і у власника, і в гостя', async ({ page, browser }) => {
    await signIn(page);
    await createList(page, unique('QA XSS'));
    const payload = `<img src=x onerror="window.__qaXss=1">QA`;
    await addPriced(page, payload, '10');
    await expect(itemCard(page, payload).first()).toContainText(payload);
    expect(await page.evaluate(() => (window as unknown as { __qaXss?: number }).__qaXss)).toBeUndefined();
    await expect(page.locator('img[src="x"]')).toHaveCount(0);

    const link = await shareWith(page, unique('QA XSS'), { showPrices: true, allowClaims: true, expires: null });
    const g = await guest(browser, link);
    await expect(guestCard(g, payload)).toBeVisible();
    expect(await g.evaluate(() => (window as unknown as { __qaXss?: number }).__qaXss)).toBeUndefined();
    await expect(g.locator('img[src="x"]')).toHaveCount(0);
    await g.context().close();
  });

  test('error guessing: назва з 200 символів без пробілів не розпирає сторінку', async ({ page, browser }) => {
    await signIn(page);
    await createList(page, unique('QA ширина'));
    const long = 'Довжелезнаназвабезжодногопробілу'.repeat(7).slice(0, 200);
    await addPriced(page, long, '1');
    const fits = (p: Page) => p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(await fits(page), 'сторінка списку власника').toBe(true);

    const menu = await itemMenu(page, long);
    await expect(menu).toBeVisible();
    expect(await fits(page), 'меню позиції').toBe(true);
    await page.keyboard.press('Escape');

    const link = await shareWith(page, unique('QA ширина'), { showPrices: true, allowClaims: true, expires: null });
    const g = await guest(browser, link);
    await g.setViewportSize({ width: 360, height: 740 });
    await expect(guestCard(g, long.slice(0, 40))).toBeVisible();
    expect(await fits(g), 'гостьова сторінка на 360 px').toBe(true);
    await g.context().close();
  });
});
