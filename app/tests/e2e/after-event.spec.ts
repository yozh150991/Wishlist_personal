import { test, expect } from '@playwright/test';
import {
  addDays,
  afterEventDue,
  copyInput,
  eventYear,
  isPastEvent,
  nextYear,
  openItems,
  repeatTitle,
  snoozeNext,
} from '../../src/lib/afterEvent';
import type { Item } from '../../src/lib/types';

// Чисті правила «Після події» й «Повторити на наступний рік» (lib/afterEvent.ts,
// ADR-045): ні сторінки, ні браузера — як items-view.spec.ts.

function item(over: Partial<Item> = {}): Item {
  return {
    id: 'i1',
    list_id: 'l1',
    owner_id: 'u1',
    title: 'Керамічна лампа',
    url: 'https://shop.ua/lampa',
    price: 1240.5,
    quantity: 2,
    priority: 'high',
    note: 'Біла',
    variants: [{ label: 'Колір', value: 'білий' }],
    image_url: 'https://shop.ua/lampa.jpg',
    status: 'gifted',
    source_site: 'shop.ua',
    parsed_at: '2026-09-01T10:00:00Z',
    section_id: 's1',
    position: 3,
    created_at: '2026-09-01T10:00:00Z',
    updated_at: '2026-09-02T10:00:00Z',
    ...over,
  };
}

test.describe('дати', () => {
  test('addDays рахує календарні дні через межу місяця й року', () => {
    expect(addDays('2026-09-29', 3)).toBe('2026-10-02');
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
  });

  test('nextYear: та сама дата наступного року, 29 лютого стає 28-м', () => {
    expect(nextYear('2026-10-18')).toBe('2027-10-18');
    expect(nextYear('2028-02-29')).toBe('2029-02-28');
    expect(nextYear('2026-01-01')).toBe('2027-01-01');
  });

  test('подія минула лише наступного дня: у сам день свята — ще ні', () => {
    expect(isPastEvent({ event_date: '2026-10-18' }, '2026-10-18')).toBe(false);
    expect(isPastEvent({ event_date: '2026-10-18' }, '2026-10-19')).toBe(true);
    expect(isPastEvent({ event_date: null }, '2026-10-19')).toBe(false);
  });

  test('рік події — з дати, без дати його немає', () => {
    expect(eventYear({ event_date: '2026-10-18' })).toBe(2026);
    expect(eventYear({ event_date: null })).toBeNull();
  });
});

test.describe('картка «Свято минуло»', () => {
  const list = { event_date: '2026-10-18', is_archived: false };

  test('зʼявляється наступного дня після події й не раніше', () => {
    expect(afterEventDue(list, '2026-10-18', null)).toBe(false);
    expect(afterEventDue(list, '2026-10-19', null)).toBe(true);
  });

  test('архівний список і список без дати картки не мають', () => {
    expect(afterEventDue({ ...list, is_archived: true }, '2026-10-19', null)).toBe(false);
    expect(afterEventDue({ event_date: null, is_archived: false }, '2026-10-19', null)).toBe(false);
  });

  test('«Пізніше» ховає на три дні, картка повертається один раз, друге «Пізніше» — назовсім', () => {
    const first = snoozeNext(null, list.event_date, '2026-10-19');
    expect(first).toEqual({ date: '2026-10-18', until: '2026-10-22', count: 1 });
    expect(afterEventDue(list, '2026-10-21', first)).toBe(false);
    expect(afterEventDue(list, '2026-10-22', first)).toBe(true);

    const second = snoozeNext(first, list.event_date, '2026-10-22');
    expect(second.count).toBe(2);
    expect(afterEventDue(list, '2026-10-26', second)).toBe(false);
    expect(afterEventDue(list, '2027-10-26', second)).toBe(false);
  });

  test('перенесли дату — відлік «Пізніше» починається спочатку', () => {
    const old = snoozeNext(snoozeNext(null, '2026-10-18', '2026-10-19'), '2026-10-18', '2026-10-22');
    const moved = { event_date: '2026-10-25', is_archived: false };
    expect(afterEventDue(moved, '2026-10-26', old)).toBe(true);
    expect(snoozeNext(old, moved.event_date, '2026-10-26').count).toBe(1);
  });
});

test.describe('«Повторити на наступний рік»', () => {
  test('рік у назві посувається, решта назви — як була', () => {
    expect(repeatTitle('Новий рік 2026', 2026)).toBe('Новий рік 2027');
    expect(repeatTitle('2026: день народження', 2026)).toBe('2027: день народження');
    expect(repeatTitle('День народження', 2026)).toBe('День народження');
  });

  test('чужі числа й частини інших чисел не чіпаються', () => {
    expect(repeatTitle('Квартира 20261', 2026)).toBe('Квартира 20261');
    expect(repeatTitle('Весілля 2025', 2026)).toBe('Весілля 2025');
    expect(repeatTitle('Новий рік 2026', null)).toBe('Новий рік 2026');
  });
});

test.describe('копії позицій', () => {
  test('копія несе те, що людина хоче, — і знову актуальна, без розділу й місця', () => {
    const copy = copyInput(item());
    expect(copy).toEqual({
      title: 'Керамічна лампа',
      url: 'https://shop.ua/lampa',
      price: 1240.5,
      quantity: 2,
      priority: 'high',
      note: 'Біла',
      variants: [{ label: 'Колір', value: 'білий' }],
      image_url: 'https://shop.ua/lampa.jpg',
      status: 'active',
      section_id: null,
      position: null,
    });
  });

  test('у копії немає ні id, ні списку, ні власника, ні службових полів', () => {
    const copy = copyInput(item()) as Record<string, unknown>;
    for (const key of ['id', 'list_id', 'owner_id', 'created_at', 'updated_at', 'source_site', 'parsed_at']) {
      expect(copy).not.toHaveProperty(key);
    }
  });

  test('повтор списку передає розділ і місце явно', () => {
    expect(copyInput(item(), { section_id: 's9', position: 3 })).toMatchObject({ section_id: 's9', position: 3 });
  });

  test('пропонуємо перенести лише нерозібране — статус власника, а не позначки', () => {
    const items = [
      item({ id: 'a', status: 'active' }),
      item({ id: 'b', status: 'gifted' }),
      item({ id: 'c', status: 'purchased' }),
    ];
    expect(openItems(items).map((i) => i.id)).toEqual(['a']);
  });
});
