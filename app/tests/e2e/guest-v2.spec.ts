import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { addItem, createList, hasAccount, shareLink, signIn, unique } from './helpers';

/**
 * Гостьова v2 під `/l/…` (крок 5а; ADR-041, ADR-053; потік E).
 *
 * Власника готують спільні помічники, гості відкривають `/l/…`.
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
    const link = await shareLink(page, ['Сковорода', 'Рушники'], unique('Гостям'));
    const token = link.split('/l/')[1]!;

    // Гість A: «Беру» → аркуш із підписом → код після першої броні.
    const a = await guest(browser, link);
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
    const link = await shareLink(page, ['Чайник', 'Тарілки'], unique('Гостям'));

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

    // Перший похід у магазин без броні — аркуш; «Забронювати й перейти» бронює,
    // і лише тоді вкладка йде в магазин (ADR-075).
    const shop = /^(у магазин|do sklepu|to the shop)$/i;
    await card(g, 'Чайник').getByRole('link', { name: shop }).click();
    const ask = g.getByRole('dialog');
    await expect(ask.getByRole('heading', { name: /чайник/i })).toBeVisible();
    const popup = g.waitForEvent('popup');
    await ask.getByRole('button', { name: /забронювати й перейти|zarezerwuj i przejdź|take it and go/i }).click();
    const tab = await popup;
    await tab.waitForURL(shopUrl);
    await tab.close();
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

  test('два гості на одну штуку через «Забронювати й перейти»: магазин відкриває лише переможець (ADR-075)', async ({ page, browser }) => {
    await signIn(page);
    await createList(page, unique('Guest v2 race'));
    await addItem(page, 'Кавоварка');
    const link = await shareLink(page, ['Кавоварка'], unique('Гостям'));

    const shopUrl = 'https://shop.example.com/e2e-race';
    let shopHits = 0;
    const open = async () => {
      const ctx = await browser.newContext();
      await ctx.route('https://shop.example.com/**', (r) => {
        shopHits += 1;
        return r.fulfill({ body: 'shop' });
      });
      await ctx.route('**/rpc/get_guest_list', async (route) => {
        const res = await route.fetch();
        const body = await res.json();
        body.items = (body.items ?? []).map((i: { url: string | null }) => ({ ...i, url: shopUrl }));
        await route.fulfill({ response: res, json: body });
      });
      const p = await ctx.newPage();
      await p.goto(link);
      await expect(p.getByRole('heading', { level: 1 })).toBeVisible();
      return p;
    };
    const a = await open();
    const b = await open();

    // Обидва відкрили аркуш, поки позиція вільна.
    const shop = /^(у магазин|do sklepu|to the shop)$/i;
    const go = /забронювати й перейти|zarezerwuj i przejdź|take it and go/i;
    for (const p of [a, b]) {
      await card(p, 'Кавоварка').getByRole('link', { name: shop }).click();
      await expect(p.getByRole('dialog').getByRole('button', { name: go })).toBeVisible();
    }

    // A першим: бронь, вкладка йде в магазин.
    const tabA = a.waitForEvent('popup');
    await a.getByRole('dialog').getByRole('button', { name: go }).click();
    await (await tabA).waitForURL(shopUrl);
    expect(shopHits).toBe(1);

    // B програє: вкладка закривається, «встигли раніше», магазину для B немає.
    const tabB = b.waitForEvent('popup');
    await b.getByRole('dialog').getByRole('button', { name: go }).click();
    const lostTab = await tabB;
    await expect.poll(() => lostTab.isClosed()).toBe(true);
    await expect(b.getByRole('dialog').getByRole('heading', { name: /щойно взяв хтось інший|ktoś właśnie wziął|someone just took/i })).toBeVisible();
    expect(shopHits).toBe(1);

    for (const p of [a, b]) await p.context().close();
  });
});

test('мертве посилання під /l/ — один екран і доля броней', async ({ page }) => {
  await page.goto('/l/e2e-nonexistent-token');
  await expect(page.getByRole('heading', { name: /більше не працює|już nie działa|no longer works/i })).toBeVisible();
  await expect(page.getByText(/бронь знято|rezerwację zdjęto|pick was released/i)).toBeVisible();
});

test('архівний список під /l/ — позиції видно, бронювати ні (ADR-058)', async ({ page }) => {
  // Відповідь бази підставляємо: що архів закриває бронь на сервері, стереже pgTAP 18.
  const item = (id: string, title: string) => ({
    id, title, url: null, price: 120, currency: 'PLN', quantity: 1, priority: 'medium', note: null,
    variants: [], image_url: null, status: 'active', created_at: '2026-10-01T10:00:00Z', section_id: null,
    taken_qty: 0, mine_qty: 0,
  });
  await page.route('**/rpc/get_guest_list', (route) =>
    route.fulfill({
      json: {
        title: 'Новосілля', message: null, currency: 'PLN', event_date: '2026-10-10',
        expires_at: null, expires_tz: null, owner_scheme: null, appearance_hue: null,
        hide_prices: false, allow_reservations: false, archived: true, viewer_is_owner: false,
        guest: null, sections: [], items: [item('e2e-arch-1', 'Ваза'), item('e2e-arch-2', 'Рушники')],
      },
    }),
  );
  await page.route('**/rpc/register_share_view', (route) => route.fulfill({ status: 204, body: '' }));

  await page.goto('/l/e2e-archived-token');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByText(/список в архіві|lista jest w archiwum|list is archived/i)).toBeVisible();
  await expect(card(page, 'Ваза')).toBeVisible();
  await expect(card(page, 'Рушники')).toBeVisible();
  await expect(page.getByRole('button', { name: takeBtn })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /уже маю броні|mam już rezerwacje|already have picks/i })).toHaveCount(0);
});

test('подяка власника на /l/ — видно всім, з переносами рядків (ADR-059)', async ({ page }) => {
  await page.route('**/rpc/get_guest_list', (route) =>
    route.fulfill({
      json: {
        title: 'Річниця', message: null, currency: 'PLN', event_date: '2026-10-10',
        expires_at: null, expires_tz: null, owner_scheme: null, appearance_hue: null,
        hide_prices: false, allow_reservations: false, archived: true, viewer_is_owner: false,
        guest: null, sections: [], items: [], thanks: 'Дякуємо, що були з нами!\nДо зустрічі',
      },
    }),
  );
  await page.route('**/rpc/register_share_view', (route) => route.fulfill({ status: 204, body: '' }));

  await page.goto('/l/e2e-thanks-token');
  const thanks = page.getByRole('region', { name: /подяка від автора|podziękowanie od autora|thank-you from the list/i });
  await expect(thanks).toBeVisible();
  await expect(thanks).toContainText('Дякуємо, що були з нами!');
  await expect(thanks).toContainText('До зустрічі');
});

test('«Поскаржитись» на /l/ — причина, коментар, подяка; власнику кнопки немає (ADR-061)', async ({ page }) => {
  const body = {
    title: 'Виграй айфон', message: null, currency: 'PLN', event_date: null,
    expires_at: null, expires_tz: null, owner_scheme: null, appearance_hue: null,
    hide_prices: false, allow_reservations: true, archived: false, viewer_is_owner: false,
    guest: null, sections: [], items: [], thanks: null,
  };
  let reported: Record<string, unknown> | null = null;
  await page.route('**/rpc/get_guest_list', (route) => route.fulfill({ json: body }));
  await page.route('**/rpc/register_share_view', (route) => route.fulfill({ status: 204, body: '' }));
  await page.route('**/rpc/report_share', async (route) => {
    reported = route.request().postDataJSON();
    await route.fulfill({ status: 204, body: '' });
  });

  await page.goto('/l/e2e-report-token');
  await page.getByRole('button', { name: /^(поскаржитись|zgłoś|report)$/i }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toContainText(/не автору списку|nie do autora listy|not to the list's author/i);

  // Без причини запит не йде.
  await sheet.getByRole('button', { name: /надіслати скаргу|wyślij zgłoszenie|send report/i }).click();
  await expect(sheet.getByText(/виберіть причину|wybierz powód|choose a reason/i)).toBeVisible();
  expect(reported).toBeNull();

  await sheet.getByRole('radio', { name: /шахрайство|oszustwo|scam/i }).check();
  await sheet.locator('textarea[name="report_comment"]').fill('Просять гроші на картку');
  await sheet.getByRole('button', { name: /надіслати скаргу|wyślij zgłoszenie|send report/i }).click();
  await expect(sheet.getByRole('heading', { name: /скаргу надіслано|zgłoszenie wysłane|report sent/i })).toBeVisible();
  expect(reported).toMatchObject({ p_token: 'e2e-report-token', p_reason: 'scam', p_comment: 'Просять гроші на картку' });

  // Власник на своєму посиланні кнопки не бачить.
  await page.unroute('**/rpc/get_guest_list');
  await page.route('**/rpc/get_guest_list', (route) => route.fulfill({ json: { ...body, viewer_is_owner: true, allow_reservations: false } }));
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: /^(поскаржитись|zgłoś|report)$/i })).toHaveCount(0);
});

test('спільний збір на /l/ — відкрити, долучитися; власник збору не бачить (ADR-063)', async ({ page }) => {
  const base = (id: string, title: string, price: number | null) => ({
    id, title, url: null, price, currency: 'PLN', quantity: 1, priority: 'medium', note: null,
    variants: [], image_url: null, status: 'active', created_at: '2026-10-01T10:00:00Z', section_id: null,
    taken_qty: 0, mine_qty: 0,
  });
  const pool = {
    id: 'pool-1', organizer: 'Оля', instructions: 'BLIK на +48 500 000 000', goal: 1200, currency: 'PLN',
    closed: false, raised: 300, count: 2, mine: null as number | null, is_organizer: false, pledges: null,
  };
  let bike = { ...base('i-bike', 'Велосипед', 1200), taken_qty: 1, pool };
  let lamp: Record<string, unknown> = base('i-lamp', 'Лампа', 400);
  let owner = false;
  const calls: Record<string, unknown>[] = [];
  const body = () => ({
    title: 'Ювілей тата', message: null, currency: 'PLN', event_date: null, expires_at: null, expires_tz: null,
    owner_scheme: null, appearance_hue: null, hide_prices: false, allow_reservations: !owner, archived: false,
    viewer_is_owner: owner, guest: null, sections: [], thanks: null,
    items: owner
      ? [{ ...bike, pool: undefined, taken_qty: null, mine_qty: null }, { ...lamp, pool: undefined, taken_qty: null, mine_qty: null }]
      : [bike, lamp],
  });
  await page.route('**/rpc/get_guest_list', (r) => r.fulfill({ json: body() }));
  await page.route('**/rpc/register_share_view', (r) => r.fulfill({ status: 204, body: '' }));
  await page.route('**/rpc/start_pool', async (r) => {
    const req = r.request().postDataJSON();
    calls.push({ fn: 'start', ...req });
    lamp = { ...lamp, taken_qty: 1, mine_qty: 1, pool: { ...pool, id: 'pool-2', organizer: req.p_name, instructions: req.p_instructions,
      goal: req.p_goal ?? 400, raised: 0, count: 0, is_organizer: true, pledges: [] } };
    await r.fulfill({ json: { code: 'K7M2Q', pool_id: 'pool-2', taken_qty: 1, mine_qty: 1 } });
  });
  await page.route('**/rpc/pledge_pool', async (r) => {
    const req = r.request().postDataJSON();
    calls.push({ fn: 'pledge', ...req });
    bike = { ...bike, pool: { ...pool, mine: req.p_amount, raised: 300 + req.p_amount, count: 3 } };
    await r.fulfill({ json: { code: 'K7M2Q' } });
  });

  await page.goto('/l/e2e-pool-token');
  const card = (title: string) => page.locator('.v2-gcard').filter({ hasText: title });

  // Чужий збір: хто збирає, скільки, як скинутися — без імен учасників.
  await expect(card('Велосипед')).toContainText(/збирає оля|zbiera оля|collected by оля/i);
  await expect(card('Велосипед')).toContainText('BLIK на +48 500 000 000');
  await card('Велосипед').getByRole('button', { name: /^(долучитися|dołącz|chip in)$/i }).click();
  let sheet = page.getByRole('dialog');
  await sheet.locator('input[name="pool_name"]').fill('Тарас');
  await sheet.locator('input[name="pool_amount"]').fill('150');
  await sheet.getByRole('button', { name: /^(долучитися|dołączam|count me in)$/i }).click();
  await expect(sheet).toHaveCount(0);
  await expect(card('Велосипед')).toContainText(/ви скидаєтесь|dokładasz|you're chipping in/i);
  expect(calls.at(-1)).toMatchObject({ fn: 'pledge', p_pool_id: 'pool-1', p_name: 'Тарас', p_amount: 150 });

  // Свій збір: ціль за замовчуванням — ціна позиції.
  await card('Лампа').getByRole('button', { name: /зібрати разом|zrzućmy się|chip in together/i }).click();
  sheet = page.getByRole('dialog');
  await expect(sheet.locator('input[name="pool_amount"]')).toHaveValue('400');
  await sheet.locator('input[name="pool_name"]').fill('Ігор');
  await sheet.getByRole('button', { name: /відкрити збір|otwórz zrzutkę|start the collection/i }).click();
  await expect(sheet.getByText(/напишіть, як скинутися|napisz, jak się dołożyć|write how to chip in/i)).toBeVisible();
  await sheet.locator('textarea[name="pool_instructions"]').fill('Переказ на картку');
  await sheet.getByRole('button', { name: /відкрити збір|otwórz zrzutkę|start the collection/i }).click();
  await expect(sheet).toHaveCount(0);
  expect(calls.at(-1)).toMatchObject({ fn: 'start', p_item_id: 'i-lamp', p_name: 'Ігор', p_instructions: 'Переказ на картку', p_goal: 400 });
  await expect(card('Лампа').getByRole('button', { name: /керувати збором|zarządzaj zrzutką|manage collection/i })).toBeVisible();

  // Власник на своєму посиланні: ні збору, ні кнопок.
  owner = true;
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('.v2-gpool')).toHaveCount(0);
  await expect(page.getByText(/оля|ігор|blik/i)).toHaveCount(0);
});
