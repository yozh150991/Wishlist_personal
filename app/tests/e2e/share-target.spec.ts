import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fromShare, iosShortcutPrefix, rawSharedUrl } from '../../src/lib/shareTarget';
import { EMAIL, PASSWORD, hasAccount, unique } from './helpers';

/**
 * «Додати в Wishlist» із системного «Поділитися» (ROADMAP, «Дизайн v2», крок
 * 4б; потік L; ADR-046).
 *
 * Правила розбору поширеного — без браузера; місток `/add` у v1 — без акаунта;
 * саме додавання — у v2-проєктах з акаунтом.
 */

test.describe('розбір поширеного', () => {
  test('браузер: адреса в url, назва сторінки в title', () => {
    expect(fromShare({ title: 'Керамічна лампа — Shop', url: 'https://www.shop.ua/lampa?utm_source=x' })).toEqual({
      url: 'https://www.shop.ua/lampa?utm_source=x',
      title: 'Керамічна лампа — Shop',
    });
  });

  test('магазин: усе в text — назва окремо від адреси, без хвостових розділових знаків', () => {
    expect(fromShare({ text: 'Подивись: Керамічна лампа https://shop.ua/lampa-123).' })).toEqual({
      url: 'https://shop.ua/lampa-123',
      title: 'Подивись: Керамічна лампа',
    });
    expect(fromShare({ text: 'Керамічна лампа (https://shop.ua/l)' }).title).toBe('Керамічна лампа');
  });

  test('окремий title важить більше за решту тексту', () => {
    expect(fromShare({ title: 'Лампа', text: 'Знижка! https://shop.ua/l' })).toEqual({
      url: 'https://shop.ua/l',
      title: 'Лампа',
    });
  });

  test('назва, що сама є адресою, — не назва', () => {
    expect(fromShare({ title: 'https://shop.ua/l', url: 'https://shop.ua/l' })).toEqual({
      url: 'https://shop.ua/l',
      title: null,
    });
    expect(fromShare({ text: 'www.shop.ua/lampa' })).toEqual({ url: null, title: null });
  });

  test('лише текст — позиція без посилання; нічого — нічого', () => {
    expect(fromShare({ text: '  Книга   «Кобзар»  ' })).toEqual({ url: null, title: 'Книга «Кобзар»' });
    expect(fromShare({})).toEqual({ url: null, title: null });
    expect(fromShare({ url: 'javascript:alert(1)' })).toEqual({ url: null, title: null });
  });

  test('задовга назва обрізається до межі з БД', () => {
    expect(fromShare({ title: 'я'.repeat(300) }).title).toHaveLength(200);
  });
});

test.describe('Команда для iPhone: сира адреса (ADR-077)', () => {
  const prefix = iosShortcutPrefix('https://wishlist.example/');

  test('початок адреси для Команди', () => {
    expect(prefix).toBe('https://wishlist.example/add?src=ios&url=');
  });

  test('адреса з власними ? і & збирається цілою, разом із якорем', () => {
    const search = new URL(`${prefix}https://allegro.pl/oferta/czajnik-123?bi_s=ads&utm_source=x`).search;
    expect(rawSharedUrl(search, '#opis')).toBe('https://allegro.pl/oferta/czajnik-123?bi_s=ads&utm_source=x#opis');
    // Далі — той самий розбір, що й для «Поділитися».
    expect(fromShare({ url: rawSharedUrl(search) }).url).toBe('https://allegro.pl/oferta/czajnik-123?bi_s=ads&utm_source=x');
  });

  test('закодовану адресу розкодовує; зіпсоване кодування — нічого', () => {
    expect(rawSharedUrl('?src=ios&url=https%3A%2F%2Fwww.olx.pl%2Fd%2Foferta%2Frower%3Fa%3D1')).toBe('https://www.olx.pl/d/oferta/rower?a=1');
    expect(rawSharedUrl('?src=ios&url=https%3A%2F%2Fx.pl%2F%E0%A4%A')).toBeNull();
  });

  test('без src=ios — не Команда; порожній хвіст — нічого', () => {
    expect(rawSharedUrl('?url=https://shop.ua/x')).toBeNull();
    expect(rawSharedUrl('?src=ios&url=')).toBeNull();
    expect(rawSharedUrl('?src=ios')).toBeNull();
  });

  test('чуже в хвості не стає адресою', () => {
    expect(fromShare({ url: rawSharedUrl('?src=ios&url=javascript:alert(1)') }).url).toBeNull();
  });
});

test('/add без сесії — вхід, а поширене чекає в next', async ({ page }) => {
  await page.goto('/add?title=%D0%9B%D0%B0%D0%BC%D0%BF%D0%B0&url=https%3A%2F%2Fshop.ua%2Flampa');
  await expect(page).toHaveURL(/\/login\?next=%2Fadd%3F.*shop\.ua/);
});

async function signInV2(page: Page) {
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(EMAIL!);
  await page.locator('input[name="password"]').fill(PASSWORD!);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/lists$/);
}

async function newList(page: Page, title: string) {
  await page.goto('/lists/new');
  await page.locator('input[name="title"]').fill(title);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/lists\/[0-9a-f-]{36}$/);
}

const card = (page: Page, title: string) => page.getByRole('listitem').filter({ hasText: title });

test.describe('«Додати в Wishlist» з акаунтом', () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  // Магазин «не віддав опису», хоч би який парсер стояв.
  test.beforeEach(async ({ page }) => {
    await page.route(/\/parse$/, (route) => route.fulfill({ status: 502, body: '' }));
  });

  test('назва з поширеного тексту — позиція у вибраному списку, адреса без параметрів', async ({ page }) => {
    await signInV2(page);
    const listTitle = unique('V2 add');
    await newList(page, listTitle);

    const itemTitle = unique('Керамічна лампа');
    const text = `${itemTitle} https://shop.ua/lampa-${Date.now()}`;
    await page.goto(`/add?text=${encodeURIComponent(text)}`);
    await expect(page).toHaveURL(/\/add$/);
    await expect(page.locator('input[name="title"]')).toHaveValue(itemTitle);
    await page.getByRole('radio', { name: listTitle }).check();
    await page.getByRole('radio', { name: /дуже хочу|bardzo chcę|really want/i }).check();
    await page.getByRole('button', { name: /^(додати|dodaj|add)$/i }).click();

    await expect(page.getByRole('heading', { name: new RegExp(listTitle) })).toBeVisible();
    await page.getByRole('link', { name: /відкрити список|otwórz listę|open the list/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: listTitle })).toBeVisible();
    await expect(card(page, itemTitle)).toBeVisible();
    await expect(card(page, itemTitle)).toContainText(/shop\.ua/);
  });

  test('з кнопки «У вішліст» (ADR-076): поля зі сторінки, парсер не кличемо', async ({ page }) => {
    let parsed = 0;
    await page.unroute(/\/parse$/);
    await page.route(/\/parse$/, (route) => {
      parsed += 1;
      return route.fulfill({ status: 502, body: '' });
    });
    await signInV2(page);
    const listTitle = unique('V2 add page');
    await newList(page, listTitle);

    const itemTitle = unique('Чайник скляний');
    const q = new URLSearchParams({
      src: 'page',
      url: `https://allegro.example/oferta/czajnik-${Date.now()}`,
      title: itemTitle,
      price: '129.99',
      currency: 'PLN',
      image: 'https://cdn.example.com/kettle.jpg',
    });
    await page.goto(`/add?${q}`);
    await expect(page).toHaveURL(/\/add$/);
    await expect(page.locator('input[name="title"]')).toHaveValue(itemTitle);
    await expect(page.locator('.v2-preview__meta')).toContainText(/129[,.]99/);
    await expect(page.locator('.v2-preview__img')).toHaveAttribute('src', 'https://cdn.example.com/kettle.jpg');
    await expect(page.getByText(/не віддав опису|nie podał opisu|didn't share a description/i)).toHaveCount(0);
    await page.getByRole('radio', { name: listTitle }).check();
    await page.getByRole('button', { name: /^(додати|dodaj|add)$/i }).click();
    await expect(page.getByRole('heading', { name: new RegExp(listTitle) })).toBeVisible();
    expect(parsed).toBe(0);

    await page.getByRole('link', { name: /відкрити список|otwórz listę|open the list/i }).click();
    await expect(card(page, itemTitle)).toContainText(/129[,.]99/);
  });

  test('кнопка «У вішліст» у Налаштуваннях — лише на компʼютері, перетягують, а не натискають', async ({ page }, info) => {
    await signInV2(page);
    await page.goto('/settings');
    const box = page.getByTestId('bookmarklet');
    if (info.project.name === 'mobile') {
      await expect(box).toHaveCount(0);
      return;
    }
    const link = box.getByRole('link', { name: /^(у вішліст|do wishlisty|to wishlist)$/i });
    await expect(link).toHaveAttribute('href', /^javascript:/);
    await link.click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(box.getByRole('status')).toHaveText(/перетягнути|przeciągnąć|clicking it here does nothing/i);
  });

  test('Команда для iPhone без входу: вхід → назад на форму; адреса з ? і & ціла (ADR-077)', async ({ page, browser }) => {
    await signInV2(page);
    const listTitle = unique('V2 add ios');
    await newList(page, listTitle);

    // Safari без сесії — окремий контекст, як окремий браузер на телефоні.
    const ctx = await browser.newContext();
    const safari = await ctx.newPage();
    await safari.route(/\/parse$/, (route) => route.fulfill({ status: 502, body: '' }));
    let saved: string | null = null;
    await safari.route('**/rest/v1/items**', async (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON() as { url?: string } | { url?: string }[];
        saved = (Array.isArray(body) ? body[0]?.url : body.url) ?? null;
      }
      await route.continue();
    });
    const shop = `https://allegro.example/oferta/czajnik-${Date.now()}?bi_s=ads&utm_source=x`;
    await safari.goto(`/add?src=ios&url=${shop}`);
    await expect(safari).toHaveURL(/\/login\?next=/);
    await safari.locator('input[name="email"]').fill(EMAIL!);
    await safari.locator('input[name="password"]').fill(PASSWORD!);
    await safari.locator('button[type="submit"]').click();

    await expect(safari).toHaveURL(/\/add$/);
    await expect(safari.locator('.v2-preview__meta')).toContainText('allegro.example');
    await safari.getByRole('radio', { name: listTitle }).check();
    await safari.getByRole('button', { name: /зберегти чернетку|zapisz szkic|save as draft/i }).click();
    await expect(safari.getByText(/потрібна назва|potrzebna nazwa|needs a name/i)).toBeVisible();
    expect(saved).toBe(shop);
    await ctx.close();
  });

  test('картка Команди в Налаштуваннях — лише на iPhone; копіює початок адреси (ADR-077)', async ({ browser }, info) => {
    test.skip(info.project.name !== 'mobile', 'одного прогону досить');
    const iphone = await browser.newContext({
      userAgent:
        'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
      viewport: { width: 390, height: 844 },
      isMobile: true,
      hasTouch: true,
    });
    const page = await iphone.newPage();
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: async (s: string) => void ((window as unknown as { __copied?: string }).__copied = s) },
      });
    });
    await signInV2(page);
    await page.goto('/settings');
    const box = page.getByTestId('ios-shortcut');
    await expect(box).toBeVisible();
    await expect(box.getByRole('listitem')).toHaveCount(5);
    await box.getByRole('button', { name: /скопіювати початок адреси|skopiuj początek adresu|copy the address start/i }).click();
    await expect(box.getByRole('button', { name: /^(скопійовано|skopiowano|copied)$/i })).toBeVisible();
    const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied ?? '');
    expect(copied).toMatch(/\/add\?src=ios&url=$/);
    await iphone.close();
  });

  test('на Android картки Команди немає', async ({ page }) => {
    await signInV2(page);
    await page.goto('/settings');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByTestId('ios-shortcut')).toHaveCount(0);
  });

  test('лише посилання, магазин мовчить — «Зберегти чернетку», у списку «Потрібна назва»', async ({ page }) => {
    await signInV2(page);
    const listTitle = unique('V2 add draft');
    await newList(page, listTitle);

    const slug = `pled-${Date.now()}`;
    await page.goto(`/add?url=${encodeURIComponent(`https://shop.ua/${slug}`)}`);
    await expect(page.getByText(/не віддав опису|nie podał opisu|didn't share a description/i)).toBeVisible();
    await page.getByRole('radio', { name: listTitle }).check();
    await page.getByRole('button', { name: /зберегти чернетку|zapisz szkic|save as draft/i }).click();

    await expect(page.getByText(/потрібна назва|potrzebna nazwa|needs a name/i)).toBeVisible();
    await page.getByRole('link', { name: /відкрити список|otwórz listę|open the list/i }).click();
    await expect(card(page, `shop.ua/${slug}`)).toContainText(/потрібна назва|potrzebna nazwa|needs a name/i);
  });
});
