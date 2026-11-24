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

  test('збір: організатор позначає внесок отриманим — інший гість бачить «отримано», власник нічого (ROADMAP 8.14)', async ({ page, browser }) => {
    await signIn(page);
    await createList(page, unique('Guest v2 pool'));
    // Друга позиція вільна: інакше учасник, що вже скинувся, бачить «Усе вже розібрали».
    for (const name of ['Проектор', 'Лампа']) await addItem(page, name);
    const link = await shareLink(page, ['Проектор', 'Лампа'], unique('Гостям'));
    const gpool = (p: Page) => card(p, 'Проектор').locator('.v2-gpool');

    // Оля відкриває збір: ціни немає — ціль своя.
    const a = await guest(browser, link);
    await card(a, 'Проектор').getByRole('button', { name: /зібрати разом|zrzućmy się|chip in together/i }).click();
    let sheet = a.getByRole('dialog');
    await sheet.locator('input[name="pool_name"]').fill('Оля-e2e');
    await sheet.locator('textarea[name="pool_instructions"]').fill('BLIK e2e');
    await sheet.locator('input[name="pool_amount"]').fill('300');
    await sheet.getByRole('button', { name: /відкрити збір|otwórz zrzutkę|start the collection/i }).click();
    await expect(sheet).toHaveCount(0);

    // Тарас долучається на 120.
    const b = await guest(browser, link);
    await card(b, 'Проектор').getByRole('button', { name: /^(долучитися|dołącz|chip in)$/i }).click();
    sheet = b.getByRole('dialog');
    await sheet.locator('input[name="pool_name"]').fill('Тарас-e2e');
    await sheet.locator('input[name="pool_amount"]').fill('120');
    await sheet.getByRole('button', { name: /^(долучитися|dołączam|count me in)$/i }).click();
    await expect(sheet).toHaveCount(0);
    await expect(gpool(b).locator('.v2-gpool__mine')).toContainText(/ви обіцяли|obiecałeś|you pledged/i);
    await expect(gpool(b).locator('.v2-gpool__received')).toHaveCount(0);

    // Оля позначає внесок Тараса отриманим.
    await a.reload();
    await card(a, 'Проектор').getByRole('button', { name: /керувати збором|zarządzaj zrzutką|manage collection/i }).click();
    sheet = a.getByRole('dialog');
    const row = sheet.locator('.v2-giftrow--pledge').filter({ hasText: 'Тарас-e2e' });
    const got = row.getByRole('button', { name: /^(отримано|otrzymano|received)$/i });
    await expect(got).toHaveAttribute('aria-pressed', 'false');
    const marked = a.waitForResponse((r) => r.url().includes('/rpc/set_pledge_received') && r.ok());
    await got.click();
    await marked;
    await expect(got).toHaveAttribute('aria-pressed', 'true');
    await a.keyboard.press('Escape');

    // Новий гість бачить «отримано 120 з 120» — без імен.
    const c = await guest(browser, link);
    await expect(gpool(c).locator('.v2-gpool__received')).toContainText('120');
    await expect(c.getByText('Тарас-e2e')).toHaveCount(0);

    // Тарас бачить, що його внесок отримано.
    await b.reload();
    await expect(gpool(b).locator('.v2-gpool__mine')).toContainText(/отримано|dotarła|has arrived/i);

    // Власник на своєму посиланні — нічого про збір.
    await page.goto(link);
    await expect(page.getByText(/це твоє посилання|to twój link|your own link/i)).toBeVisible();
    await expect(page.locator('.v2-gpool')).toHaveCount(0);
    await expect(page.getByText(/тарас-e2e|оля-e2e/i)).toHaveCount(0);
    await expect(page.locator('.v2-gcard').filter({ hasText: /отримано|otrzymano|received/i })).toHaveCount(0);

    for (const p of [a, b, c]) await p.context().close();
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

test('«Про мене» на /l/ — лише коли воно прийшло; на телефоні згорнуто (ROADMAP 8.10)', async ({ page, isMobile }) => {
  // Відповідь бази підставляємо: що без дозволу ключа `about` немає, стереже pgTAP 38.
  const body = {
    title: 'День народження', message: null, currency: 'PLN', event_date: null,
    expires_at: null, expires_tz: null, owner_scheme: null, appearance_hue: null,
    hide_prices: false, allow_reservations: true, archived: false, viewer_is_owner: false,
    guest: null, sections: [], items: [], thanks: null,
  };
  let withAbout = false;
  await page.route('**/rpc/get_guest_list', (route) =>
    route.fulfill({
      json: withAbout ? { ...body, about: { sizes: 'M / 42 / EU 43', avoid: 'Парфуми\nСвічки' } } : body,
    }),
  );
  await page.route('**/rpc/register_share_view', (route) => route.fulfill({ status: 204, body: '' }));

  await page.goto('/l/e2e-about-token');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByTestId('guest-about')).toHaveCount(0);

  withAbout = true;
  await page.reload();
  const block = page.getByTestId('guest-about');
  await expect(block).toBeVisible();
  const sizes = block.getByText('M / 42 / EU 43');
  if (isMobile) {
    await expect(sizes).toBeHidden();
    await block.getByText(/^(про мене|o mnie|about me)$/i).click();
  }
  await expect(sizes).toBeVisible();
  await expect(block).toContainText('Свічки');
  // Поля, якого немає у відповіді, немає й на сторінці.
  await expect(block.locator('[data-field="likes"]')).toHaveCount(0);
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
  await expect(card('Велосипед')).toContainText(/ви обіцяли|obiecałeś|you pledged/i);
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

test('збір на /l/ — «Отримано» в аркуші організатора, підсумок гостям, свій внесок учаснику (ROADMAP 8.14)', async ({ page }) => {
  const item = {
    id: 'i-bike', title: 'Велосипед', url: null, price: 1200, currency: 'PLN', quantity: 1, priority: 'medium', note: null,
    variants: [], image_url: null, status: 'active', created_at: '2026-10-01T10:00:00Z', section_id: null,
    taken_qty: 1, mine_qty: 1,
  };
  const lamp = { ...item, id: 'i-lamp', title: 'Лампа', price: 400, taken_qty: 0, mine_qty: 0 };
  let pledges = [
    { id: 'pl-1', name: 'Тарас', amount: '150.00', received: false },
    { id: 'pl-2', name: 'Марія', amount: '150.00', received: false },
  ];
  let viewer: 'organizer' | 'member' | 'owner' = 'organizer';
  const calls: Record<string, unknown>[] = [];
  const received = () => pledges.filter((p) => p.received).reduce((s, p) => s + Math.round(Number(p.amount) * 100), 0) / 100;
  const pool = () => ({
    id: 'pool-1', organizer: 'Оля', instructions: 'BLIK на +48 500 000 000', goal: '1200.00', currency: 'PLN',
    closed: false, raised: '300.00', received: received(), count: 2,
    mine: viewer === 'member' ? '150.00' : null,
    mine_received: viewer === 'member' ? pledges[0]!.received : false,
    is_organizer: viewer === 'organizer',
    pledges: viewer === 'organizer' ? pledges : null,
  });
  const body = () => ({
    title: 'Ювілей тата', message: null, currency: 'PLN', event_date: null, expires_at: null, expires_tz: null,
    owner_scheme: null, appearance_hue: null, hide_prices: false, allow_reservations: viewer !== 'owner', archived: false,
    viewer_is_owner: viewer === 'owner', guest: null, sections: [], thanks: null,
    // Друга позиція вільна: інакше гостьова показує «Усе вже розібрали» замість карток.
    items: viewer === 'owner'
      ? [{ ...item, taken_qty: null, mine_qty: null }, { ...lamp, taken_qty: null, mine_qty: null }]
      : [{ ...item, mine_qty: viewer === 'organizer' ? 1 : 0, pool: pool() }, lamp],
  });
  await page.route('**/rpc/get_guest_list', (r) => r.fulfill({ json: body() }));
  await page.route('**/rpc/register_share_view', (r) => r.fulfill({ status: 204, body: '' }));
  await page.route('**/rpc/set_pledge_received', async (r) => {
    const req = r.request().postDataJSON();
    calls.push(req);
    pledges = pledges.map((p) => (p.id === req.p_pledge_id ? { ...p, received: req.p_received } : p));
    await r.fulfill({ status: 204, body: '' });
  });

  await page.goto('/l/e2e-pool-token');
  const gpool = page.locator('.v2-gcard').filter({ hasText: 'Велосипед' }).locator('.v2-gpool');
  // Поки ніхто нічого не позначив — картка така, як до 8.14.
  await expect(gpool).toBeVisible();
  await expect(gpool.locator('.v2-gpool__received')).toHaveCount(0);

  await page.getByRole('button', { name: /керувати збором|zarządzaj zrzutką|manage collection/i }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByText(/позначте «отримано»|zaznacz „otrzymano”|mark “received”/i)).toBeVisible();
  const row = sheet.locator('.v2-giftrow--pledge').filter({ hasText: 'Тарас' });
  const got = row.getByRole('button', { name: /^(отримано|otrzymano|received)$/i });
  await expect(got).toHaveAttribute('aria-pressed', 'false');
  await got.click();
  await expect(got).toHaveAttribute('aria-pressed', 'true');
  expect(calls.at(-1)).toMatchObject({ p_pool_id: 'pool-1', p_pledge_id: 'pl-1', p_received: true });
  expect(calls.at(-1)).toHaveProperty('p_key');
  // Аркуш лишається відкритим: можна позначити наступного.
  await expect(sheet.locator('.v2-gpool__received')).toContainText('150');
  // Кнопка — не нижче 44 px і не вилазить за рядок ні на телефоні, ні на широкому.
  const box = (await got.boundingBox())!;
  const rowBox = (await row.boundingBox())!;
  expect(box.height).toBeGreaterThanOrEqual(44);
  expect(box.x + box.width).toBeLessThanOrEqual(rowBox.x + rowBox.width + 1);
  // Зняти позначку — так само.
  await got.click();
  await expect(got).toHaveAttribute('aria-pressed', 'false');
  expect(calls.at(-1)).toMatchObject({ p_pledge_id: 'pl-1', p_received: false });
  await got.click();
  await expect(got).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');

  // Учасник: свій внесок отримано, підсумок — без імен.
  viewer = 'member';
  await page.reload();
  await expect(gpool.locator('.v2-gpool__received')).toContainText('150');
  await expect(gpool.locator('.v2-gpool__mine')).toContainText(/отримано|dotarła|has arrived/i);
  await expect(page.getByText(/марія/i)).toHaveCount(0);

  // Власник: ні збору, ні «отримано».
  viewer = 'owner';
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.locator('.v2-gpool')).toHaveCount(0);
  await expect(page.locator('.v2-gcard').filter({ hasText: /отримано|otrzymano|received/i })).toHaveCount(0);
});

test('код після першої броні: як повернути броні й лист на пошту гостя (ROADMAP 8.6, 8.7)', async ({ page }) => {
  // Відповіді бази підставляємо: що лист несе той самий код, стереже pytest (guest_mail).
  let guest: { code: string; name: string | null; email: string | null } | null = null;
  const body = () => ({
    title: 'Новосілля', message: null, currency: 'PLN', event_date: null,
    expires_at: null, expires_tz: null, owner_scheme: null, appearance_hue: null,
    hide_prices: false, allow_reservations: true, archived: false, viewer_is_owner: false,
    guest, sections: [], thanks: null,
    items: ['Ваза', 'Рушники'].map((title, i) => ({
      id: `e2e-rec-${i}`, title, url: null, price: 100, currency: 'PLN', quantity: 1,
      priority: 'medium', note: null, variants: [], image_url: null, status: 'active',
      created_at: '2026-10-01T10:00:00Z', section_id: null,
      taken_qty: guest && i === 0 ? 1 : 0, mine_qty: guest && i === 0 ? 1 : 0,
    })),
  });
  await page.route('**/rpc/get_guest_list', (r) => r.fulfill({ json: body() }));
  await page.route('**/rpc/register_share_view', (r) => r.fulfill({ status: 204, body: '' }));
  await page.route('**/rpc/claim_item_v2', async (r) => {
    const args = r.request().postDataJSON() as { p_email: string | null };
    guest = { code: 'K7M2Q', name: null, email: args.p_email || null };
    await r.fulfill({ json: { taken_qty: 1, mine_qty: 1, code: 'K7M2Q', name: null, email: guest.email } });
  });

  await page.goto('/l/e2e-recovery-token');
  await card(page, 'Ваза').getByRole('button', { name: takeBtn }).click();
  const sheet = page.getByRole('dialog');
  // Бронь — не оплата (ROADMAP 8.7).
  await expect(sheet.getByText(/бронь — це не оплата|rezerwacja to nie płatność|taking isn.t paying/i)).toBeVisible();
  await sheet.locator('input[name="guest_email"]').fill(MAIL);
  await sheet.getByRole('button', { name: /^(забронювати|zarezerwuj|take it)$/i }).click();

  await expect(sheet.getByRole('heading', { name: /за вами|twoje|is yours/i })).toBeVisible();
  await expect(sheet.locator('.v2-gcode')).toHaveText('K7M2Q');
  // Чесно: бронь тримає браузер — і як її повернути, коли його дані зникнуть.
  await expect(sheet.getByText(/інкогніто|incognito|private window/i)).toBeVisible();
  await expect(sheet.getByText(/уже маю броні|mam już rezerwacje|i already have picks/i)).toBeVisible();
  await expect(sheet.getByText(MAIL)).toBeVisible();
  await expect(sheet.getByRole('button', { name: /надіслати собі посилання|wyślij sobie link|send myself the link/i })).toBeVisible();

  // «Мої броні» розводять «Беру» й «Уже куплено»: обидва — не оплата й не для власника.
  await sheet.getByRole('button', { name: /^(готово|gotowe|done)$/i }).click();
  await page.getByRole('button', { name: /мої броні · 1|moje rezerwacje · 1|my picks · 1/i }).click();
  await expect(page.getByRole('dialog').getByText(/нічого не оплачує|niczego nie opłaca|doesn.t pay for anything/i)).toBeVisible();
});

test('«Уже куплено» — записано одразу, шість секунд на «Відмінити»; з купленої картки дорога в «Мої броні» (BUG-QA-35)', async ({ page }) => {
  test.setTimeout(45_000);
  const TOKEN = 'e2e-bought-token';
  let bought = false;
  const calls: boolean[] = [];
  await page.route('**/rpc/get_guest_list', (route) =>
    route.fulfill({
      json: {
        title: 'Новосілля', message: null, currency: 'PLN', event_date: null,
        expires_at: null, expires_tz: null, owner_scheme: null, appearance_hue: null,
        hide_prices: false, allow_reservations: true, archived: false, viewer_is_owner: false,
        guest: { code: 'K7M2Q', name: null, email: null }, sections: [], thanks: null,
        items: [{
          id: 'e2e-bought-1', title: 'Ваза', url: null, price: 100, currency: 'PLN', quantity: 1,
          priority: 'medium', note: null, variants: [], image_url: null, status: 'active',
          created_at: '2026-10-01T10:00:00Z', section_id: null, taken_qty: 1, mine_qty: 1, bought,
        }],
      },
    }),
  );
  await page.route('**/rpc/register_share_view', (route) => route.fulfill({ status: 204, body: '' }));
  await page.route('**/rpc/set_claim_bought', async (route) => {
    const args = route.request().postDataJSON() as { p_bought: boolean };
    calls.push(args.p_bought);
    bought = args.p_bought;
    await route.fulfill({ status: 204, body: '' });
  });
  await page.addInitScript((t) => localStorage.setItem(`wl.gk.${t}`, 'e2e-guest-key-000000000000'), TOKEN);
  await page.goto(`/l/${TOKEN}`);

  const vase = card(page, 'Ваза');
  const markBought = /^(уже куплено|już kupione|already bought)$/i;
  const undoBtn = page.getByRole('button', { name: /^(відмінити|cofnij|undo)$/i });
  const boughtTag = /^(куплено|kupione|bought)$/i;

  // Випадковий дотик: «Куплено» видно й записано одразу (закрита вкладка її
  // не загубить), а «Відмінити» відправляє зворотну позначку.
  await vase.getByRole('button', { name: markBought }).click();
  await expect(vase.getByText(boughtTag)).toBeVisible();
  await expect.poll(() => calls).toEqual([true]);
  await undoBtn.click();
  await expect(vase.getByRole('button', { name: markBought })).toBeVisible();
  await expect.poll(() => calls).toEqual([true, false]);

  // Без «Відмінити» тост зникає сам, а позначка лишається.
  await vase.getByRole('button', { name: markBought }).click();
  await expect.poll(() => calls).toEqual([true, false, true]);
  await expect(undoBtn).toHaveCount(0, { timeout: 12_000 });
  await expect(vase.getByText(boughtTag)).toBeVisible();

  // На купленій картці — дорога в «Мої броні», де є «Ще не куплено».
  await vase.getByRole('button', { name: /мої броні|moich rezerwacjach|my picks/i }).click();
  const picks = page.getByRole('dialog');
  await expect(picks.getByRole('button', { name: /^(ще не куплено|jeszcze nie kupione|not bought yet)$/i })).toBeVisible();
  // На телефоні жодна кнопка не виглядає виділеною: фокус на самому вікні.
  const touch = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
  if (touch) expect(await page.evaluate(() => document.activeElement?.tagName.toLowerCase())).toBe('dialog');
  await picks.getByRole('button', { name: /^(ще не куплено|jeszcze nie kupione|not bought yet)$/i }).click();
  await expect.poll(() => calls).toEqual([true, false, true, false]);
});

test('фото позиції на /l/ — мініатюра відкриває перегляд на весь екран; тап, Escape і «Назад» закривають', async ({ page }) => {
  // Маленька PNG 1×1 як «фото» — адреса з того самого сайту, щоб не впиратись у CSP img-src.
  await page.route('**/e2e-photo.png', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
    }),
  );
  await page.route('**/rpc/get_guest_list', (route) =>
    route.fulfill({
      json: {
        title: 'День народження', message: null, currency: 'PLN', event_date: null,
        expires_at: null, expires_tz: null, owner_scheme: null, appearance_hue: null,
        hide_prices: false, allow_reservations: true, archived: false, viewer_is_owner: false,
        guest: null, sections: [], thanks: null,
        items: [{
          id: 'e2e-photo-1', title: 'Лампа', url: null, price: 120, currency: 'PLN', quantity: 1, priority: 'medium',
          note: null, variants: [], image_url: '/e2e-photo.png', status: 'active', created_at: '2026-10-01T10:00:00Z',
          section_id: null, taken_qty: 0, mine_qty: 0,
        }],
      },
    }),
  );
  await page.route('**/rpc/register_share_view', (route) => route.fulfill({ status: 204, body: '' }));

  await page.goto('/l/e2e-photo-token');
  const thumb = page.getByRole('button', { name: /збільшити фото|powiększ zdjęcie|enlarge photo/i });
  const viewer = page.getByTestId('photo-viewer');

  // Тап по фото закриває, фокус повертається на мініатюру.
  await thumb.click();
  await expect(viewer).toBeVisible();
  const box = await viewer.locator('img').boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(200);
  await viewer.locator('img').click();
  await expect(viewer).toHaveCount(0);
  await expect(thumb).toBeFocused();

  // Escape.
  await thumb.click();
  await expect(viewer).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer).toHaveCount(0);

  // «Назад» закриває перегляд, а сторінка лишається тією самою.
  await thumb.click();
  await expect(viewer).toBeVisible();
  await page.goBack();
  await expect(viewer).toHaveCount(0);
  await expect(page).toHaveURL(/\/l\/e2e-photo-token$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('аркуш на /l/ — сторінка під ним не гортається, головна дія на виду навіть у ландшафті', async ({ page }) => {
  const item = (id: string, title: string) => ({
    id, title, url: null, price: 1999, currency: 'PLN', quantity: 1, priority: 'medium', note: null,
    variants: [], image_url: null, status: 'active', created_at: '2026-10-01T10:00:00Z', section_id: null,
    taken_qty: 0, mine_qty: 0,
  });
  await page.route('**/rpc/get_guest_list', (route) =>
    route.fulfill({
      json: {
        title: 'День народження', message: null, currency: 'PLN', event_date: null,
        expires_at: null, expires_tz: null, owner_scheme: null, appearance_hue: null,
        hide_prices: false, allow_reservations: true, archived: false, viewer_is_owner: false,
        guest: null, sections: [], thanks: null,
        items: Array.from({ length: 12 }, (_, i) => item(`e2e-sheet-${i}`, `Позиція ${i + 1}`)),
      },
    }),
  );
  await page.route('**/rpc/register_share_view', (route) => route.fulfill({ status: 204, body: '' }));
  // Телефон боком: низьке вікно, де раніше від аркуша лишалась смужка.
  await page.setViewportSize({ width: 915, height: 340 });
  await page.goto('/l/e2e-sheet-token');

  await page.getByRole('button', { name: /брати разом|zrzućmy się|chip in/i }).first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  // Сторінка під вікном не гортається.
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).toBe('hidden');
  // «Відкрити збір» видно одразу, без прокрутки аркуша.
  await expect(sheet.getByRole('button', { name: /відкрити збір|otwórz zrzutkę|start the collection/i })).toBeInViewport();
  await sheet.getByRole('button', { name: /^(скасувати|anuluj|cancel)$/i }).click();
  await expect(sheet).toHaveCount(0);
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).overflow)).not.toBe('hidden');
});

test('аркуш «Беру» на телефоні відкривається без клавіатури й без збільшення полів; мишею — одразу в поле підпису (BUG-QA-32, 33)', async ({ page }) => {
  await page.route('**/rpc/get_guest_list', (route) =>
    route.fulfill({
      json: {
        title: 'День народження', message: null, currency: 'PLN', event_date: null,
        expires_at: null, expires_tz: null, owner_scheme: null, appearance_hue: null,
        hide_prices: false, allow_reservations: true, archived: false, viewer_is_owner: false,
        guest: null, sections: [], thanks: null,
        items: [{
          id: 'e2e-focus-1', title: 'Плед', url: null, price: 199, currency: 'PLN', quantity: 1, priority: 'medium',
          note: null, variants: [], image_url: null, status: 'active', created_at: '2026-10-01T10:00:00Z',
          section_id: null, taken_qty: 0, mine_qty: 0,
        }],
      },
    }),
  );
  await page.route('**/rpc/register_share_view', (route) => route.fulfill({ status: 204, body: '' }));
  await page.goto('/l/e2e-focus-token');

  await card(page, 'Плед').getByRole('button', { name: takeBtn }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.locator('input[name="guest_name"]')).toBeVisible();
  const touch = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
  const focused = await page.evaluate(() => {
    const el = document.activeElement;
    return el instanceof HTMLInputElement ? `input:${el.name}` : (el?.tagName.toLowerCase() ?? 'none');
  });
  // Телефон (профіль mobile): фокус на самому вікні — клавіатура не накриває
  // «Забронювати». Комп'ютер: фокус у першому полі, як і раніше.
  expect(focused).toBe(touch ? 'dialog' : 'input:guest_name');
  // Головна дія на виду одразу, без прокрутки.
  await expect(sheet.locator('button[type="submit"]')).toBeInViewport();
  // Tab з вікна веде в поле: саме вікно в порядку обходу не стоїть.
  if (touch) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => document.activeElement?.tagName.toLowerCase())).not.toBe('dialog');
  }

  // Поля від 16 px на телефоні (BUG-QA-33): менший шрифт iPhone збільшує при
  // фокусі, і сторінка їде вбік. На комп'ютері розмір не чіпаємо.
  const sizes = await sheet.locator('input.v2-input').evaluateAll((els) =>
    els.map((el) => parseFloat(getComputedStyle(el).fontSize)),
  );
  expect(sizes.length).toBeGreaterThan(0);
  for (const size of sizes) {
    if (touch) expect(size).toBeGreaterThanOrEqual(16);
    else expect(size).toBeLessThan(16);
  }
});

test('аркуш на /l/ — сторінка, яку зсунули під вікном, повертається на місце (BUG-QA-31)', async ({ page }) => {
  // iOS зсуває сторінку під вікном, щоб показати поле, а прогорнути її назад
  // під заблокованим вікном нічим. Тут зсув роблять скриптом — як iOS.
  const item = (id: string, title: string) => ({
    id, title, url: null, price: 1999, currency: 'PLN', quantity: 1, priority: 'medium', note: null,
    variants: [], image_url: null, status: 'active', created_at: '2026-10-01T10:00:00Z', section_id: null,
    taken_qty: 0, mine_qty: 0,
  });
  await page.route('**/rpc/get_guest_list', (route) =>
    route.fulfill({
      json: {
        title: 'День народження', message: null, currency: 'PLN', event_date: null,
        expires_at: null, expires_tz: null, owner_scheme: null, appearance_hue: null,
        hide_prices: false, allow_reservations: true, archived: false, viewer_is_owner: false,
        guest: null, sections: [], thanks: null,
        items: Array.from({ length: 12 }, (_, i) => item(`e2e-drift-${i}`, `Позиція ${i + 1}`)),
      },
    }),
  );
  await page.route('**/rpc/register_share_view', (route) => route.fulfill({ status: 204, body: '' }));
  await page.setViewportSize({ width: 390, height: 664 });
  await page.goto('/l/e2e-drift-token');

  await page.getByRole('button', { name: /брати разом|zrzućmy się|chip in/i }).first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet).toBeVisible();
  const before = await page.evaluate(() => window.scrollY);
  await page.evaluate(() => window.scrollTo(0, 400));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before);
  await expect(sheet.getByRole('button', { name: /^(скасувати|anuluj|cancel)$/i })).toBeInViewport();
});

test('картка гостя на вузькому екрані — дії під текстом, «Беру» залита й від 44 px (ROADMAP 8.18)', async ({ page }) => {
  // Відповідь бази підставляємо: тут лише розкладка картки. Позиція з фото, посиланням
  // і довгою назвою — найтісніший випадок: «Беру», «Зібрати разом» і «У магазин».
  await page.route('**/e2e-photo.png', (route) =>
    route.fulfill({
      contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
    }),
  );
  const item = (id: string, title: string, extra: Record<string, unknown>) => ({
    id, title, url: null, price: 899, currency: 'PLN', quantity: 1, priority: 'medium', note: null,
    variants: [], image_url: '/e2e-photo.png', status: 'active', created_at: '2026-10-01T10:00:00Z',
    section_id: null, taken_qty: 0, mine_qty: 0, ...extra,
  });
  await page.route('**/rpc/get_guest_list', (route) =>
    route.fulfill({
      json: {
        title: 'Новосілля', message: null, currency: 'PLN', event_date: null,
        expires_at: null, expires_tz: null, owner_scheme: null, appearance_hue: null,
        hide_prices: false, allow_reservations: true, archived: false, viewer_is_owner: false,
        guest: null, sections: [], thanks: null,
        items: [
          item('e2e-card-1', 'Кавоварка ріжкова з капучинатором', { url: 'https://www.sklep-internetowy.example.com/p/1' }),
          item('e2e-card-2', 'Навушники бездротові', { taken_qty: 1, mine_qty: 1 }),
        ],
      },
    }),
  );
  await page.route('**/rpc/register_share_view', (route) => route.fulfill({ status: 204, body: '' }));

  await page.goto('/l/e2e-card-token');
  const free = card(page, 'Кавоварка');
  const mine = card(page, 'Навушники');
  await expect(free).toBeVisible();
  await expect(mine).toContainText(yours);

  // Третій розмір — дві колонки на комп'ютері: картка там така сама вузька, як на телефоні.
  for (const [width, minText] of [[320, 180], [360, 220], [1280, 200]] as const) {
    await page.setViewportSize({ width, height: 800 });
    const take = free.getByRole('button', { name: takeBtn });
    const [text, actions, takeBox, shopBox] = await Promise.all([
      free.locator('.v2-gcard__text').boundingBox(),
      free.locator('.v2-gcard__actions').boundingBox(),
      take.boundingBox(),
      free.getByRole('link', { name: /^(у магазин|do sklepu|to the shop)$/i }).boundingBox(),
    ]);
    if (!text || !actions || !takeBox || !shopBox) throw new Error('картку не намальовано');
    // Назві лишається ширина картки без фото, а не 38 px поруч зі стовпчиком кнопок.
    expect(text.width, `текст на ${width} px`).toBeGreaterThanOrEqual(minText);
    expect(actions.y, `дії під текстом на ${width} px`).toBeGreaterThanOrEqual(text.y + text.height);
    // «Беру» — головна: від 44 px, на весь рядок дій і залита, а не контурна.
    expect(takeBox.height).toBeGreaterThanOrEqual(44);
    expect(takeBox.width).toBeGreaterThanOrEqual(actions.width - 1);
    expect(await take.evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
    expect(shopBox.height).toBeGreaterThanOrEqual(44);
    // Дії своєї броні — теж від 44 px.
    for (const b of await mine.locator('.v2-gcard__actions .v2-btn').all()) {
      expect((await b.boundingBox())?.height ?? 0).toBeGreaterThanOrEqual(44);
    }
    // Ніщо не виходить за край екрана.
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  }
});
