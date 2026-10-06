import { test, expect } from '@playwright/test';
import {
  EMPTY_RANGE,
  approxTotal,
  itemCurrency,
  draftTitle,
  findSameTitle,
  findSameUrl,
  isDraft,
  linkPriceChange,
  matchesView,
  normalizeUrl,
  parsePrice,
  rangeCount,
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

test.describe('фільтри «Статус» і «Ціна від–до», сортування за назвою (ADR-050)', () => {
  test('статус: порожньо — усі, інакше лише вибрані', () => {
    const a = item({ status: 'active' });
    const p = item({ status: 'purchased' });
    const g = item({ status: 'gifted' });
    const only = (statuses: Item['status'][]) =>
      [a, p, g].filter((i) => matchesView(i, '', 'all', { ...EMPTY_RANGE, statuses })).map((i) => i.status);
    expect(only([])).toEqual(['active', 'purchased', 'gifted']);
    expect(only(['purchased', 'gifted'])).toEqual(['purchased', 'gifted']);
  });

  test('ціна: межі включно, у мінорних одиницях; без ціни під діапазон не потрапляє', () => {
    const cheap = item({ price: 99.99 });
    const edge = item({ price: 100 });
    const top = item({ price: 500 });
    const none = item({ price: null });
    const pick = (min: number | null, max: number | null) =>
      [cheap, edge, top, none].filter((i) => matchesView(i, '', 'all', { statuses: [], min, max })).map((i) => i.price);
    expect(pick(10000, 50000)).toEqual([100, 500]);
    expect(pick(null, 9999)).toEqual([99.99]);
    expect(pick(null, null)).toEqual([99.99, 100, 500, null]);
  });

  test('лічильник фільтрів і сортування за назвою з числами', () => {
    expect(rangeCount(EMPTY_RANGE)).toBe(0);
    expect(rangeCount({ statuses: ['gifted'], min: 1, max: null })).toBe(2);
    const titles = ['річ 10', 'Б', 'річ 2', 'а'].map((title) => item({ title }));
    expect(sortItems(titles, 'title').map((i) => i.title)).toEqual(['а', 'Б', 'річ 2', 'річ 10']);
  });
});

test.describe('валюта позиції (ADR-051)', () => {
  test('порожня валюта — валюта списку', () => {
    expect(itemCurrency(item(), 'UAH')).toBe('UAH');
    expect(itemCurrency(item({ currency: 'EUR' }), 'UAH')).toBe('EUR');
  });

  test('сума: валюта списку окремо, інші — доданками, без курсу', () => {
    const t = totalsOf(
      [
        item({ price: 100, quantity: 2 }),
        item({ price: 85, currency: 'EUR' }),
        item({ price: 15, currency: 'EUR' }),
        item({ price: 40, currency: 'USD', status: 'gifted' }),
        item({ price: 50, currency: 'PLN' }),
      ],
      'PLN',
    );
    expect(t.active_price).toBe(250);
    expect(t.foreign).toEqual([{ currency: 'EUR', active_price: 100 }]);
    expect(t.total_price).toBe(250);
  });

  test('без валюти списку сума — як до ADR-051', () => {
    expect(totalsOf([item({ price: 10 }), item({ price: 5, currency: 'EUR' })]).active_price).toBe(15);
  });

  test('сортування за ціною: спершу валюта списку, далі інші групами, без ціни — в кінці', () => {
    const pln = item({ price: 300 });
    const eur = item({ price: 20, currency: 'EUR' });
    const usd = item({ price: 10, currency: 'USD' });
    const none = item({ price: null });
    const cheap = item({ price: 5 });
    expect(sortItems([none, usd, pln, eur, cheap], 'priceAsc', 'PLN').map((i) => i.id)).toEqual([
      cheap.id,
      pln.id,
      eur.id,
      usd.id,
      none.id,
    ]);
  });

  test('діапазон ціни — у валюті списку: інша валюта під нього не потрапляє', () => {
    const eur = item({ price: 100, currency: 'EUR' });
    const pln = item({ price: 100 });
    const range = { statuses: [], min: 5000, max: 20000 };
    expect(matchesView(eur, '', 'all', range, 'PLN')).toBe(false);
    expect(matchesView(pln, '', 'all', range, 'PLN')).toBe(true);
  });

  test('ціна з магазину порівнюється з валютою позиції', () => {
    expect(
      linkPriceChange(item({ price: 100, currency: 'EUR', link_status: 'ok', link_price: 130, link_currency: 'EUR' }), 'PLN'),
    ).toEqual({ price: 130, notable: true });
    expect(linkPriceChange(item({ price: 100, link_status: 'ok', link_price: 130, link_currency: 'EUR' }), 'PLN')).toBeNull();
  });
});

test.describe('підказка «≈» за курсом НБП (ADR-051)', () => {
  const rates = {
    EUR: { pln_per_unit: 4.2765, rate_date: '2026-10-05' },
    UAH: { pln_per_unit: 0.0881, rate_date: '2026-10-03' },
  };

  test('злотий + євро у злотих, округлено до цілих, з датою курсу', () => {
    expect(approxTotal([{ currency: 'PLN', amount: 1240 }, { currency: 'EUR', amount: 85 }], 'PLN', rates)).toEqual({
      amount: 1604,
      date: '2026-10-05',
    });
  });

  test('список у гривнях: через злотий, дата — найстаріша з використаних', () => {
    expect(approxTotal([{ currency: 'UAH', amount: 1000 }, { currency: 'EUR', amount: 10 }], 'UAH', rates)).toEqual({
      amount: 1485,
      date: '2026-10-03',
    });
  });

  test('бракує курсу хоч однієї валюти — підказки немає', () => {
    expect(approxTotal([{ currency: 'PLN', amount: 10 }, { currency: 'USD', amount: 5 }], 'PLN', rates)).toBeNull();
  });
});
