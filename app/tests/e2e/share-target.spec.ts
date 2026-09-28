import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { fromShare } from '../../src/lib/shareTarget';
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

test('/add у v1 — місток у новий вигляд із тим самим поширеним', async ({ page }) => {
  await page.goto('/add?title=%D0%9B%D0%B0%D0%BC%D0%BF%D0%B0&url=https%3A%2F%2Fshop.ua%2Flampa');
  await expect(page.locator('html')).toHaveAttribute('data-design', 'v1');
  const go = page.getByRole('link', { name: /перемкнути й додати|przełącz i dodaj|switch and add/i });
  await expect(go).toHaveAttribute('href', /^\/add\?.*url=https%3A%2F%2Fshop\.ua%2Flampa.*design=v2/);
  await go.click();
  // Новий вигляд, вхід — і поширене чекає в `next`.
  await expect(page.locator('html')).toHaveAttribute('data-design', 'v2');
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

test.describe('«Додати в Wishlist» з акаунтом', { tag: '@v2' }, () => {
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
