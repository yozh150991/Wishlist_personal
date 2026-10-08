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
 * Головне, що стережемо: підпис гостя й позначку «Куплено» бачить лише він
 * сам — ні власник на своєму посиланні, ні інший гість (CLAUDE.md §3.2).
 */
const takeBtn = /^(беру|biorę|take)$/i;
const yours = /ви берете|bierzesz to|you're taking this/i;
const NAME = 'Іра-e2e';
const MAIL = 'guest-e2e@example.com';

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
    // Хибна пошта не доходить до сервера: помилка під полем, броні ще немає.
    await sheet.locator('input[name="guest_email"]').fill('ira@pochta');
    await sheet.getByRole('button', { name: /^(забронювати|zarezerwuj|take it)$/i }).click();
    await expect(sheet.getByText(/в адресі помилка|w adresie jest błąd|looks mistyped/i)).toBeVisible();
    await sheet.locator('input[name="guest_email"]').fill(MAIL);
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

    // «Надіслати код на пошту»: відповідь однакова, є адреса в списку чи ні (ADR-041, п. 4).
    const d = await guest(browser, link);
    const sent = /код уже в дорозі|kod już do ciebie leci|code is on its way/i;
    for (const address of ['nobody-e2e@example.com', MAIL]) {
      await d.getByRole('button', { name: /уже маю броні|mam już rezerwacje|already have picks/i }).click();
      const sheetD = d.getByRole('dialog');
      await sheetD.getByRole('button', { name: /надіслати код на пошту|wyślij kod na e-mail|email me the code/i }).click();
      await sheetD.locator('input[name="guest_code_email"]').fill(address);
      await sheetD.getByRole('button', { name: /^(надіслати код|wyślij kod|send the code)$/i }).click();
      await expect(sheetD.getByText(sent)).toBeVisible();
      await d.keyboard.press('Escape');
    }

    // Відписка з листа: секрет зникає з адреси, «Повернути листи» — на місці.
    const e = await guest(browser, `${link}/u/e2eMailTokenAAAAAAAAAAA`);
    await expect(e).toHaveURL(new RegExp(`/l/${token}$`));
    await expect(e.getByText(/більше не буде|nie będzie już|no more emails/i)).toBeVisible();
    await expect(e.getByRole('button', { name: /повернути листи|przywróć wiadomości|turn emails back on/i })).toBeVisible();

    for (const p of [a, b, c, d, e]) await p.context().close();
  });

  test('«У магазин» без броні — раз питаємо; «Уже куплено» бачить лише гість (потік S)', async ({ page, browser }) => {
    await signIn(page);
    await createList(page, unique('Guest v2 S'));
    for (const name of ['Чайник', 'Тарілки']) await addItem(page, name);
    const link = (await createShare(page, ['Чайник', 'Тарілки'], unique('Гостям'))).replace('/s/', '/l/');
    await page.keyboard.press('Escape');

    // Посилання на магазин підставляємо у відповідь: парсер і форма тут ні до чого.
    const shopUrl = 'https://shop.example.com/e2e';
    const ctx = await browser.newContext();
    await ctx.route('https://shop.example.com/**', (r) => r.fulfill({ body: 'shop' }));
    await ctx.route('**/rpc/get_guest_list', async (route) => {
      const res = await route.fetch();
      const body = await res.json();
      body.items = (body.items ?? []).map((i: { url: string | null }) => ({ ...i, url: shopUrl }));
      await route.fulfill({ response: res, json: body });
    });
    const g = await ctx.newPage();
    await g.goto(link);
    await expect(g.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(g.getByText(/спершу натисніть|najpierw kliknij|tap .take. first/i)).toBeVisible();

    // Перший похід у магазин без броні — аркуш; «Забронювати й перейти» бронює й відкриває магазин.
    const shop = /^(у магазин|do sklepu|to the shop)$/i;
    await card(g, 'Чайник').getByRole('link', { name: shop }).click();
    const ask = g.getByRole('dialog');
    await expect(ask.getByRole('heading', { name: /чайник/i })).toBeVisible();
    const popup = g.waitForEvent('popup');
    await ask.getByRole('link', { name: /забронювати й перейти|zarezerwuj i przejdź|take it and go/i }).click();
    await (await popup).close();
    // Перша бронь — код, як і через «Беру».
    await expect(g.getByRole('dialog').getByRole('heading', { name: /за вами|twoje|is yours/i })).toBeVisible();
    await g.getByRole('dialog').getByRole('button', { name: /^(готово|gotowe|done)$/i }).click();
    await expect(card(g, 'Чайник')).toContainText(yours);

    // Удруге за сесію — без питання, магазин просто відкривається.
    const second = g.waitForEvent('popup');
    await card(g, 'Тарілки').getByRole('link', { name: shop }).click();
    await (await second).close();
    await expect(g.getByRole('link', { name: /просто подивитись|tylko popatrzę|just looking/i })).toHaveCount(0);

    // «Уже куплено»: «Зняти» ховається; назад — лише з «Моїх броней».
    await card(g, 'Чайник').getByRole('button', { name: /^(уже куплено|już kupione|already bought)$/i }).click();
    await expect(card(g, 'Чайник').locator('.v2-gcard__mine')).toHaveText(/^(куплено|kupione|bought)$/i);
    await expect(card(g, 'Чайник').getByRole('button', { name: /^(зняти|zdejmij|release)$/i })).toHaveCount(0);
    await g.reload();
    await expect(card(g, 'Чайник')).toHaveAttribute('data-bought', 'true');

    // Власник на своєму посиланні нічого з цього не бачить.
    await page.goto(link);
    await expect(page.getByText(/це твоє посилання|to twój link|your own link/i)).toBeVisible();
    await expect(page.getByText(/^(куплено|kupione|bought)$/i)).toHaveCount(0);
    await expect(page.locator('[data-bought]')).toHaveCount(0);

    await g.getByRole('button', { name: /мої броні · 1|moje rezerwacje · 1|my picks · 1/i }).click();
    await g.getByRole('dialog').getByRole('button', { name: /ще не куплено|jeszcze nie kupione|not bought yet/i }).click();
    await g.keyboard.press('Escape');
    await expect(card(g, 'Чайник').getByRole('button', { name: /^(зняти|zdejmij|release)$/i })).toBeVisible();

    await ctx.close();
  });
});

test('мертве посилання під /l/ — один екран і доля броней', { tag: '@both' }, async ({ page }) => {
  await page.goto('/l/e2e-nonexistent-token');
  await expect(page.getByRole('heading', { name: /більше не працює|już nie działa|no longer works/i })).toBeVisible();
  await expect(page.getByText(/бронь знято|rezerwację zdjęto|pick was released/i)).toBeVisible();
});
