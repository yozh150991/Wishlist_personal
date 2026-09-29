import { test, expect } from '@playwright/test';
import {
  draftTitle,
  findSameTitle,
  findSameUrl,
  isDraft,
  linkPriceChange,
  matchesView,
  normalizeUrl,
  parsePrice,
  sortItems,
  totalsOf,
  urlKey,
  viewGroups,
} from '../../src/lib/itemsView';
import type { Item, Section } from '../../src/lib/types';

// Чисті функції сторінки списку v2 (lib/itemsView.ts): ні сторінки, ні
// браузера — як outbox.spec.ts і transfer.spec.ts.

let seq = 0;
function item(over: Partial<Item> = {}): Item {
  seq += 1;
  return {
    id: `i${String(seq).padStart(3, '0')}`,
    list_id: 'l1',
    owner_id: 'u1',
    title: `Річ ${seq}`,
    url: null,
    price: null,
    quantity: 1,
    priority: 'medium',
    note: null,
    variants: [],
    image_url: null,
    status: 'active',
    source_site: null,
    parsed_at: null,
    section_id: null,
    position: null,
    created_at: `2026-09-${String(10 + (seq % 18)).padStart(2, '0')}T10:00:00Z`,
    updated_at: '2026-09-20T10:00:00Z',
    ...over,
  };
}

const section = (id: string, position: number): Section => ({
  id,
  list_id: 'l1',
  title: id,
  position,
  created_at: '2026-09-01T00:00:00Z',
});

test.describe('підсумок списку', () => {
  test('ціна множиться на кількість, а сума рахується в мінорних одиницях', () => {
    const t = totalsOf([
      item({ price: '0.1', quantity: 1 }),
      item({ price: 0.2, quantity: 1 }),
      item({ price: '19.99', quantity: 3 }),
      item({ price: 500, status: 'gifted' }),
      item({ price: null }),
      item({ price: 100, status: 'purchased' }),
    ]);
    // 0,1 + 0,2 у float дає 0,30000000000000004 — у копійках рівно.
    expect(t.active_price).toBe(60.27);
    expect(t.total_price).toBe(660.27);
    expect(t).toMatchObject({
      items_count: 6,
      active_count: 4,
      purchased_count: 1,
      gifted_count: 1,
      items_no_price: 1,
    });
  });
});

test.describe('сортування й групи', () => {
  test('ціна: без ціни — завжди в кінці, в обидва боки', () => {
    const a = item({ price: 300 });
    const b = item({ price: null });
    const c = item({ price: 100 });
    expect(sortItems([a, b, c], 'priceAsc').map((i) => i.id)).toEqual([c.id, a.id, b.id]);
    expect(sortItems([a, b, c], 'priceDesc').map((i) => i.id)).toEqual([a.id, c.id, b.id]);
  });

  test('«Пріоритет» — заголовки рівнів від «Дуже хочу», порожніх рівнів немає', () => {
    const low = item({ priority: 'low' });
    const high = item({ priority: 'high' });
    const mid = item({ priority: 'medium' });
    const groups = viewGroups([low, high, mid], 'priority', [], { keepEmpty: true });
    expect(groups.map((g) => (g.kind === 'priority' ? g.priority : g.kind))).toEqual(['high', 'medium', 'low']);
    expect(viewGroups([mid], 'priority', [], { keepEmpty: true })).toHaveLength(1);
  });

  test('«Нещодавно додані» — новіші першими', () => {
    const old = item({ created_at: '2026-01-01T00:00:00Z' });
    const fresh = item({ created_at: '2026-09-01T00:00:00Z' });
    expect(sortItems([old, fresh], 'recent')[0]!.id).toBe(fresh.id);
  });

  test('«Вручну» з розділами: розділи в їхньому порядку, решта — «Інше» в кінці', () => {
    const s1 = section('s1', 2);
    const s2 = section('s2', 1);
    const empty = section('s3', 3);
    const inS1 = item({ section_id: 's1', position: 1 });
    const inS2 = item({ section_id: 's2', position: 1 });
    const loose = item();
    const groups = viewGroups([inS1, loose, inS2], 'manual', [s1, s2, empty].sort((a, b) => a.position - b.position), {
      keepEmpty: true,
    });
    expect(groups.map((g) => g.key)).toEqual(['s:s2', 's:s1', 's:s3', 'other']);
    // Під фільтром порожні розділи ховаються — показуємо лише знайдене.
    const filtered = viewGroups([inS1], 'manual', [s1, s2, empty], { keepEmpty: false });
    expect(filtered.map((g) => g.key)).toEqual(['s:s1']);
  });

  test('без розділів і для решти сортувань — одна група', () => {
    const groups = viewGroups([item(), item()], 'manual', [], { keepEmpty: true });
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe('all');
    expect(viewGroups([item()], 'priceAsc', [section('s1', 1)], { keepEmpty: true })[0]!.kind).toBe('all');
  });

  test('пошук без регістру в назві; «Без ціни» лишає лише позиції без ціни', () => {
    const lamp = item({ title: 'Керамічна ЛАМПА', price: 1240 });
    const book = item({ title: 'Книга', price: null });
    expect(matchesView(lamp, 'лампа', 'all')).toBe(true);
    expect(matchesView(book, 'лампа', 'all')).toBe(false);
    expect(matchesView(lamp, '', 'noPrice')).toBe(false);
    expect(matchesView(book, '  ', 'noPrice')).toBe(true);
  });
});

test.describe('посилання на товар', () => {
  test('адреса з тексту, без протоколу чи з крапкою, якої бракує', () => {
    expect(normalizeUrl('shop.ua/lampa')).toBe('https://shop.ua/lampa');
    expect(normalizeUrl('  https://shop.ua/a?b=1  ')).toBe('https://shop.ua/a?b=1');
    expect(normalizeUrl('Глянь, яка лампа: https://shop.ua/lampa?x=1 класна')).toBe('https://shop.ua/lampa?x=1');
    expect(normalizeUrl('shopua')).toBeNull();
    expect(normalizeUrl('ftp://shop.ua/file')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('просто текст')).toBeNull();
    expect(normalizeUrl('')).toBeNull();
  });

  test('та сама сторінка — попри www, рекламні мітки, якір і кінцеву косу', () => {
    expect(urlKey('https://www.Shop.ua/lampa/?utm_source=ig&fbclid=1#top')).toBe(urlKey('http://shop.ua/lampa'));
    expect(urlKey('https://shop.ua/lampa?color=red')).not.toBe(urlKey('https://shop.ua/lampa'));
    const lamp = item({ url: 'https://shop.ua/lampa' });
    expect(findSameUrl([lamp], 'shop.ua/lampa/?utm_medium=mail')?.id).toBe(lamp.id);
    // Позиція не дублює саму себе, поки її редагують.
    expect(findSameUrl([lamp], 'shop.ua/lampa', lamp.id)).toBeUndefined();
  });

  test('схожа назва — без регістру й пробілів довкола', () => {
    const lamp = item({ title: 'Керамічна лампа' });
    expect(findSameTitle([lamp], '  керамічна ЛАМПА ')?.id).toBe(lamp.id);
    expect(findSameTitle([lamp], 'Лампа')).toBeUndefined();
  });
});

test.describe('ціна з поля', () => {
  test('так, як її пишуть люди', () => {
    expect(parsePrice('1 240')).toEqual({ value: 1240, error: null });
    expect(parsePrice('1 240,50')).toEqual({ value: 1240.5, error: null });
    expect(parsePrice('1.240,50')).toEqual({ value: 1240.5, error: null });
    expect(parsePrice('1,240.50')).toEqual({ value: 1240.5, error: null });
    expect(parsePrice('1,240')).toEqual({ value: 1240, error: null });
    expect(parsePrice('12,5')).toEqual({ value: 12.5, error: null });
    expect(parsePrice('0')).toEqual({ value: 0, error: null });
  });

  test('порожнє — без ціни; решта — помилка, а не тихий нуль', () => {
    expect(parsePrice('')).toEqual({ value: null, error: null });
    expect(parsePrice('   ')).toEqual({ value: null, error: null });
    expect(parsePrice('abc').error).toBe('format');
    expect(parsePrice('-5').error).toBe('format');
    expect(parsePrice('1,2345').error).toBe('format');
    expect(parsePrice('10000000000').error).toBe('tooBig');
    expect(parsePrice('9999999999').error).toBeNull();
  });
});

test.describe('чернетки (ADR-046)', () => {
  test('назва чернетки — адреса без протоколу, www., параметрів і кінцевої /', () => {
    expect(draftTitle('https://www.shop.ua/lampa-keramika/?utm_source=x#top')).toBe('shop.ua/lampa-keramika');
    expect(draftTitle('https://rozetka.com.ua/')).toBe('rozetka.com.ua');
    expect(draftTitle('https://shop.ua/%D0%BB%D0%B0%D0%BC%D0%BF%D0%B0')).toBe('shop.ua/лампа');
  });

  test('назва чернетки не довша за межу назви з БД', () => {
    expect(draftTitle(`https://shop.ua/${'a'.repeat(400)}`).length).toBe(200);
  });

  test('чернетка — лише з позначкою; старий знімок без поля — звичайна позиція', () => {
    expect(isDraft(item({ needs_title: true }))).toBe(true);
    expect(isDraft(item({ needs_title: false }))).toBe(false);
    expect(isDraft(item())).toBe(false);
  });
});

test.describe('ціна з перевірки посилання (ADR-048)', () => {
  test('інша ціна в магазині — підказка; від 15 % — ще й мітка на картці', () => {
    expect(linkPriceChange(item({ price: 1240, link_status: 'ok', link_price: 1390, link_currency: 'UAH' }), 'UAH')).toEqual({
      price: 1390,
      notable: false,
    });
    expect(linkPriceChange(item({ price: 1000, link_status: 'ok', link_price: 1150 }), 'UAH')).toEqual({
      price: 1150,
      notable: true,
    });
    expect(linkPriceChange(item({ price: '899.00', link_status: 'out', link_price: '599' }), 'PLN')).toEqual({
      price: 599,
      notable: true,
    });
  });

  test('без ціни в списку — підказка в діалозі, але не «Ціна змінилась» на картці', () => {
    expect(linkPriceChange(item({ price: null, link_status: 'ok', link_price: 500 }), 'PLN')).toEqual({
      price: 500,
      notable: false,
    });
  });

  test('та сама ціна, інша валюта, нуль, сторінки немає чи не перевіряли — нічого', () => {
    expect(linkPriceChange(item({ price: 1240, link_status: 'ok', link_price: '1240.00' }), 'UAH')).toBeNull();
    expect(linkPriceChange(item({ price: 100, link_status: 'ok', link_price: 25, link_currency: 'EUR' }), 'PLN')).toBeNull();
    expect(linkPriceChange(item({ price: 100, link_status: 'ok', link_price: 0 }), 'PLN')).toBeNull();
    expect(linkPriceChange(item({ price: 100, link_status: 'gone', link_price: 50 }), 'PLN')).toBeNull();
    expect(linkPriceChange(item({ price: 100 }), 'PLN')).toBeNull();
  });
});
