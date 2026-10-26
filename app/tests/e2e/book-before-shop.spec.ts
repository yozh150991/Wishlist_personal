import { test, expect } from '@playwright/test';
import type { Page, Route } from '@playwright/test';

/**
 * «Спершу бронь, потім магазин» (ROADMAP 8.1, ADR-075).
 *
 * «Забронювати й перейти» відкриває порожню вкладку в самому натиску, чекає
 * `claim_item_v2` і лише після успіху веде вкладку в магазин. Програш гонки,
 * збій сервера чи мертве посилання закривають вкладку. Головне правило, яке
 * стережуть усі сценарії: **жодного запиту в магазин без підтвердженої броні**.
 *
 * Відповіді бази підставляємо: що сервер не віддає одну штуку двом, стереже
 * pgTAP (`claim_item_v2`, `not_enough_left`); тут — що робить екран з
 * кожною відповіддю. Справжня гонка двох гостей на одній базі — у
 * `guest-v2.spec.ts` (потребує тестового акаунта).
 */

const SHOP = 'https://shop.example.com/e2e-kettle';
const shopLink = /^(у магазин|do sklepu|to the shop)$/i;
const bookGo = /^(забронювати й перейти|zarezerwuj i przejdź|take it and go)$/i;
const yours = /ви берете|bierzesz to|you're taking this/i;
const codeTitle = /за вами|twoje|is yours/i;

type ClaimReply = { status: number; json: unknown };

type Stand = {
  /** Скільки разів сторінка просила бронь. */
  claims: () => number;
  /** Скільки разів хтось відкрив магазин. */
  shopHits: () => number;
  /** Заголовок Referer останнього запиту в магазин. */
  lastReferer: () => string | null;
  /** Відпустити придержані відповіді на бронь. */
  release: () => void;
};

/**
 * Гостьова сторінка з однією позицією «Чайник» за посиланням на магазин.
 * `reply` — відповідь на `claim_item_v2`; `hold` — придержати її до `release()`
 * (повільна мережа); `known` — гість уже мав бронь на цьому списку (код є).
 */
async function stand(
  page: Page,
  opts: { reply: () => ClaimReply; hold?: boolean; known?: boolean },
): Promise<Stand> {
  let claims = 0;
  let shopHits = 0;
  let referer: string | null = null;
  let mine = 0;
  const held: (() => void)[] = [];
  let released = !opts.hold;

  const body = () => ({
    title: 'Новосілля', message: null, currency: 'PLN', event_date: null,
    expires_at: null, expires_tz: null, owner_scheme: null, appearance_hue: null,
    hide_prices: false, allow_reservations: true, archived: false, viewer_is_owner: false,
    guest: opts.known || mine > 0 ? { code: 'ABCDE', name: null, email: null } : null,
    sections: [], thanks: null,
    items: [
      {
        id: 'e2e-kettle', title: 'Чайник', url: SHOP, price: 120, currency: 'PLN', quantity: 1,
        priority: 'medium', note: null, variants: [], image_url: null, status: 'active',
        created_at: '2026-10-01T10:00:00Z', section_id: null, taken_qty: mine, mine_qty: mine,
      },
      {
        id: 'e2e-plates', title: 'Тарілки', url: null, price: 80, currency: 'PLN', quantity: 1,
        priority: 'medium', note: null, variants: [], image_url: null, status: 'active',
        created_at: '2026-10-01T10:00:00Z', section_id: null, taken_qty: 0, mine_qty: 0,
      },
    ],
  });

  await page.context().route('https://shop.example.com/**', (r) => {
    shopHits += 1;
    referer = r.request().headers()['referer'] ?? null;
    return r.fulfill({ contentType: 'text/html', body: '<title>shop</title>shop' });
  });
  await page.route('**/rpc/get_guest_list', (r) => r.fulfill({ json: body() }));
  await page.route('**/rpc/register_share_view', (r) => r.fulfill({ status: 204, body: '' }));
  await page.route('**/rpc/claim_item_v2', async (r: Route) => {
    claims += 1;
    if (!released) await new Promise<void>((done) => held.push(done));
    const res = opts.reply();
    if (res.status === 200) mine = 1;
    await r.fulfill({ status: res.status, json: res.json });
  });

  await page.goto('/l/e2e-shop-token');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  return {
    claims: () => claims,
    shopHits: () => shopHits,
    lastReferer: () => referer,
    release: () => {
      released = true;
      for (const done of held.splice(0)) done();
    },
  };
}

const ok: ClaimReply = {
  status: 200,
  json: { taken_qty: 1, mine_qty: 1, code: 'K7M2Q', name: null, email: null },
};
const lost: ClaimReply = {
  status: 400,
  json: { code: 'P0001', message: 'not_enough_left', details: null, hint: null },
};
const broken: ClaimReply = {
  status: 500,
  json: { code: '57014', message: 'canceling statement due to statement timeout', details: null, hint: null },
};
const gone: ClaimReply = {
  status: 400,
  json: { code: 'P0001', message: 'not_found', details: null, hint: null },
};

const card = (page: Page, title: string) => page.locator('.v2-gcard').filter({ hasText: title });

/** Відкриває аркуш «Забронювати «Чайник»?» з картки. */
async function askShop(page: Page) {
  await card(page, 'Чайник').getByRole('link', { name: shopLink }).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: /чайник/i })).toBeVisible();
  return sheet;
}

test('повільна мережа: вкладка чекає броні й лише тоді йде в магазин, без Referer', async ({ page }) => {
  const s = await stand(page, { reply: () => ok, hold: true });
  const sheet = await askShop(page);

  const popupP = page.waitForEvent('popup');
  await sheet.getByRole('button', { name: bookGo }).click();
  const popup = await popupP;

  // Бронь ще в дорозі: вкладка порожня з «Бронюємо…», магазину не було, кнопка зайнята.
  await expect(popup.getByRole('status')).toHaveText(/бронюємо|rezerwujemy|taking/i);
  expect(popup.url()).toBe('about:blank');
  await expect(sheet.getByRole('button', { name: /^(бронюємо…|rezerwujemy…|taking it…)$/i })).toBeDisabled();
  await page.waitForTimeout(500);
  expect(s.shopHits()).toBe(0);
  expect(s.claims()).toBe(1);

  s.release();
  await popup.waitForURL(SHOP);
  expect(s.shopHits()).toBe(1);
  // Як і посилання на картках (rel="noreferrer"): адреса з токеном у магазин не йде.
  expect(s.lastReferer()).toBeNull();
  expect(await popup.evaluate(() => window.opener)).toBeNull();

  // Перша бронь — код; вкладка відкрилась, тож посилання на магазин в аркуші немає.
  const code = page.getByRole('dialog');
  await expect(code.getByRole('heading', { name: codeTitle })).toBeVisible();
  await expect(code.getByRole('link', { name: /перейти в магазин|przejdź do sklepu|go to the shop/i })).toHaveCount(0);
  await code.getByRole('button', { name: /^(готово|gotowe|done)$/i }).click();
  await expect(card(page, 'Чайник')).toContainText(yours);
});

test('позицію встигли взяти раніше: вкладка закривається, магазину немає, «встигли раніше»', async ({ page }) => {
  const s = await stand(page, { reply: () => lost });
  const sheet = await askShop(page);

  const popupP = page.waitForEvent('popup');
  await sheet.getByRole('button', { name: bookGo }).click();
  const popup = await popupP;
  await expect.poll(() => popup.isClosed()).toBe(true);

  await expect(page.getByRole('dialog').getByRole('heading', { name: /щойно взяв хтось інший|ktoś właśnie wziął|someone just took/i })).toBeVisible();
  expect(s.shopHits()).toBe(0);
});

test('збій сервера: вкладка закривається, магазину немає, помилка на сторінці', async ({ page }) => {
  const s = await stand(page, { reply: () => broken });
  const sheet = await askShop(page);

  const popupP = page.waitForEvent('popup');
  await sheet.getByRole('button', { name: bookGo }).click();
  const popup = await popupP;
  await expect.poll(() => popup.isClosed()).toBe(true);

  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.v2-note[data-tone="error"], [role="alert"]').first()).toBeVisible();
  await expect(card(page, 'Чайник')).not.toContainText(yours);
  expect(s.shopHits()).toBe(0);
});

test('посилання вже мертве: вкладка закривається, екран «більше не працює»', async ({ page }) => {
  const s = await stand(page, { reply: () => gone });
  const sheet = await askShop(page);

  const popupP = page.waitForEvent('popup');
  await sheet.getByRole('button', { name: bookGo }).click();
  const popup = await popupP;
  await expect.poll(() => popup.isClosed()).toBe(true);

  await expect(page.getByRole('heading', { name: /більше не працює|już nie działa|no longer works/i })).toBeVisible();
  expect(s.shopHits()).toBe(0);
});

test('подвійний натиск: одна бронь, одна вкладка', async ({ page }) => {
  const s = await stand(page, { reply: () => ok, hold: true });
  const sheet = await askShop(page);
  const popups: Page[] = [];
  page.on('popup', (p) => popups.push(p));

  const btn = sheet.getByRole('button', { name: bookGo });
  await btn.dblclick();
  await expect.poll(() => popups.length).toBe(1);
  await page.waitForTimeout(400);
  expect(s.claims()).toBe(1);

  s.release();
  await popups[0]!.waitForURL(SHOP);
  expect(popups.length).toBe(1);
  expect(s.claims()).toBe(1);
  expect(s.shopHits()).toBe(1);
});

test('вікно не відкрилось: магазин — посиланням уже після броні', async ({ page }) => {
  // Браузер заблокував спливне вікно — так само поводиться PWA з екрана «Додому».
  await page.addInitScript(() => {
    window.open = () => null;
  });
  const s = await stand(page, { reply: () => ok, known: true });
  const sheet = await askShop(page);

  await sheet.getByRole('button', { name: bookGo }).click();
  const go = page.getByRole('dialog');
  await expect(go.getByRole('heading', { name: codeTitle })).toBeVisible();
  const link = go.getByRole('link', { name: /перейти в магазин|przejdź do sklepu|go to the shop/i });
  await expect(link).toHaveAttribute('href', SHOP);
  await expect(link).toHaveAttribute('rel', /noreferrer/);
  expect(s.shopHits()).toBe(0);
  expect(s.claims()).toBe(1);

  const popupP = page.waitForEvent('popup');
  await link.click();
  await (await popupP).waitForURL(SHOP);
  expect(s.shopHits()).toBe(1);
});

test('вікно не відкрилось на першій броні: код і посилання на магазин в одному аркуші', async ({ page }) => {
  await page.addInitScript(() => {
    window.open = () => null;
  });
  const s = await stand(page, { reply: () => ok });
  const sheet = await askShop(page);

  await sheet.getByRole('button', { name: bookGo }).click();
  const code = page.getByRole('dialog');
  await expect(code.getByRole('heading', { name: codeTitle })).toBeVisible();
  await expect(code.locator('.v2-gcode')).toHaveText('K7M2Q');
  await expect(code.getByRole('link', { name: /перейти в магазин|przejdź do sklepu|go to the shop/i })).toHaveAttribute('href', SHOP);
  expect(s.shopHits()).toBe(0);
});
