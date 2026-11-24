import { test, expect } from '@playwright/test';
import {
  addDays,
  afterEventDue,
  afterEventHome,
  copyInput,
  daysBetween,
  eventYear,
  isPastEvent,
  nextOccurrence,
  nextYear,
  openItems,
  repeatTarget,
  readSnooze,
  repeatTitle,
  snoozeLater,
  snoozeNext,
  yearlyDue,
  yearlyReminders,
} from '../../src/lib/afterEvent';
import type { Snooze } from '../../src/lib/afterEvent';
import type { Item, List } from '../../src/lib/types';

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
      needs_title: false,
      currency: null,
      price_target: null,
    });
  });

  test('ціль ціни (8.16) їде в копію: це частина бажання', () => {
    expect(copyInput(item({ price_target: '999.00' })).price_target).toBe('999.00');
  });

  test('копія несе валюту позиції, розгорнуту з валюти списку-джерела (ADR-051)', () => {
    expect(copyInput(item(), undefined, 'UAH').currency).toBe('UAH');
    expect(copyInput(item({ currency: 'EUR' }), undefined, 'UAH').currency).toBe('EUR');
  });

  test('чернетка й у копії лишається чернеткою — гості її так само не бачать', () => {
    expect(copyInput(item({ needs_title: true })).needs_title).toBe(true);
    expect(copyInput(item({ needs_title: undefined })).needs_title).toBe(false);
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

test.describe('щорічні свята (ADR-047)', () => {
  test('найближча річниця: наступного дня після свята — через рік, давній список — цьогорічна дата', () => {
    expect(nextOccurrence('2026-10-18', '2026-10-19')).toBe('2027-10-18');
    expect(nextOccurrence('2024-10-18', '2026-09-28')).toBe('2026-10-18');
    expect(nextOccurrence('2024-10-18', '2026-10-18')).toBe('2026-10-18');
    expect(nextOccurrence('2026-10-18', '2026-09-28')).toBe('2027-10-18');
  });

  test('29 лютого повертається у високосні роки, а в інші — 28-ме', () => {
    expect(nextOccurrence('2024-02-29', '2025-01-01')).toBe('2025-02-28');
    expect(nextOccurrence('2024-02-29', '2027-03-01')).toBe('2028-02-29');
  });

  test('daysBetween — календарні дні, навіть через перехід на літній час', () => {
    expect(daysBetween('2026-03-28', '2026-03-30')).toBe(2);
    expect(daysBetween('2026-09-28', '2026-10-18')).toBe(20);
    expect(daysBetween('2026-10-18', '2026-10-18')).toBe(0);
  });

  test('повтор давнього списку — на найближчу річницю, рік у назві — той самий', () => {
    expect(repeatTarget({ event_date: '2024-10-18' }, '2026-09-28')).toEqual({ date: '2026-10-18', year: 2026 });
    expect(repeatTitle('День народження 2024', 2024, 2026)).toBe('День народження 2026');
    expect(repeatTarget({ event_date: null }, '2026-09-28')).toEqual({ date: null, year: null });
  });

  test('нагадування — за місяць до річниці, лише для щорічного', () => {
    const list = { event_date: '2025-10-18', repeats_yearly: true };
    expect(yearlyDue(list, '2026-09-17', null)).toBeNull();
    expect(yearlyDue(list, '2026-09-18', null)).toEqual({ date: '2026-10-18', days: 30 });
    expect(yearlyDue(list, '2026-10-18', null)).toEqual({ date: '2026-10-18', days: 0 });
    expect(yearlyDue({ ...list, repeats_yearly: false }, '2026-10-01', null)).toBeNull();
    expect(yearlyDue({ event_date: null, repeats_yearly: true }, '2026-10-01', null)).toBeNull();
  });

  test('список, день якого ще попереду, не нагадує — його річниця наступного року', () => {
    expect(yearlyDue({ event_date: '2026-10-18', repeats_yearly: true }, '2026-10-01', null)).toBeNull();
  });

  test('«Не цього разу» ховає саме цю річницю, а наступної — нагадає знову', () => {
    const list = { event_date: '2025-10-18', repeats_yearly: true };
    expect(yearlyDue(list, '2026-10-01', '2026-10-18')).toBeNull();
    expect(yearlyDue(list, '2027-10-01', '2026-10-18')).toEqual({ date: '2027-10-18', days: 17 });
  });
});

test.describe('головна: «Як минуло свято?» (8.13)', () => {
  type Home = Pick<List, 'id' | 'title' | 'event_date' | 'is_archived' | 'repeats_yearly' | 'active_count'>;
  const home = (over: Partial<Home> & { id: string }): Home => ({
    title: over.id,
    event_date: '2026-10-18',
    is_archived: false,
    repeats_yearly: false,
    active_count: 2,
    ...over,
  });
  const none = () => null;
  const ids = (lists: Home[]) => lists.map((l) => l.id);

  test('ті самі правила, що й на сторінці списку: з наступного дня, не архів, з датою', () => {
    const lists = [
      home({ id: 'today', event_date: '2026-10-19' }),
      home({ id: 'yesterday', event_date: '2026-10-18' }),
      home({ id: 'archived', is_archived: true }),
      home({ id: 'undated', event_date: null }),
      home({ id: 'soon', event_date: '2026-11-01' }),
    ];
    expect(ids(afterEventHome(lists, '2026-10-19', none))).toEqual(['yesterday']);
  });

  test('лише там, де актуальні позиції ще є — розібране на головній не нагадує', () => {
    const lists = [home({ id: 'open' }), home({ id: 'done', active_count: 0 }), home({ id: 'old', active_count: undefined })];
    expect(ids(afterEventHome(lists, '2026-10-19', none))).toEqual(['open']);
  });

  test('найсвіжіше свято — першим, однакові дати — за назвою', () => {
    const lists = [
      home({ id: 'a', title: 'Весілля', event_date: '2026-09-01' }),
      home({ id: 'b', title: 'Різдво', event_date: '2026-10-18' }),
      home({ id: 'c', title: 'Іменини', event_date: '2026-10-18' }),
    ];
    expect(ids(afterEventHome(lists, '2026-10-19', none))).toEqual(['c', 'b', 'a']);
  });

  test('«Пізніше» — той самий стан, що й на сторінці списку: три дні, потім ще раз, потім назовсім', () => {
    const list = home({ id: 'l' });
    const first = snoozeNext(null, '2026-10-18', '2026-10-19');
    const second = snoozeNext(first, '2026-10-18', '2026-10-22');
    const of = (s: Snooze | null) => () => s;
    expect(ids(afterEventHome([list], '2026-10-20', of(first)))).toEqual([]);
    expect(ids(afterEventHome([list], '2026-10-22', of(first)))).toEqual(['l']);
    expect(ids(afterEventHome([list], '2027-01-01', of(second)))).toEqual([]);
    // Перенесли дату — відлік спочатку, як і на сторінці списку.
    expect(ids(afterEventHome([{ ...list, event_date: '2026-12-01' }], '2026-12-02', of(second)))).toEqual(['l']);
  });

  test('«Пізніше» з головної й зі сторінки списку — один відлік на пристрої', () => {
    const store = new Map<string, string>();
    const fake = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    };
    const g = globalThis as { localStorage?: unknown };
    const before = g.localStorage;
    g.localStorage = fake;
    try {
      // Головна: перше «Пізніше».
      const fromHome = snoozeLater('l1', '2026-10-18', '2026-10-19');
      expect(fromHome.count).toBe(1);
      expect(readSnooze('l1')).toEqual(fromHome);
      // Сторінка списку відкрилась раніше й нічого не знала (known = null) —
      // її «Пізніше» все одно друге, тобто назовсім.
      const fromList = snoozeLater('l1', '2026-10-18', '2026-10-22', null);
      expect(fromList.count).toBe(2);
      expect(afterEventDue({ event_date: '2026-10-18', is_archived: false }, '2027-01-01', readSnooze('l1'))).toBe(false);
      // Інший список — свій відлік.
      expect(snoozeLater('l2', '2026-10-18', '2026-10-19').count).toBe(1);
    } finally {
      g.localStorage = before;
    }
  });

  test('сховище не пише — відлік продовжує те, що екран уже знає', () => {
    const known = snoozeNext(null, '2026-10-18', '2026-10-19');
    expect(snoozeLater('l1', '2026-10-18', '2026-10-22', known).count).toBe(2);
  });

  test('щорічне у вікні нагадування — лише нагадування; «Не цього разу» картки не воскрешає', () => {
    // Свято 2025-12-10, сьогодні 2026-11-22: до річниці 18 днів.
    const yearly = home({ id: 'y', event_date: '2025-12-10', repeats_yearly: true });
    const plain = home({ id: 'p', event_date: '2025-12-10' });
    const today = '2026-11-22';
    expect(yearlyReminders([yearly, plain], today, none).map((r) => r.list.id)).toEqual(['y']);
    expect(ids(afterEventHome([yearly, plain], today, none))).toEqual(['p']);
    // «Не цього разу»: нагадування немає, а картка все одно мовчить до кінця вікна.
    expect(yearlyReminders([yearly], today, () => '2026-12-10')).toEqual([]);
    expect(ids(afterEventHome([yearly], today, none))).toEqual([]);
    // Вікно минуло (річниця позаду) — картка повертається, як на сторінці списку.
    expect(ids(afterEventHome([yearly], '2026-12-11', none))).toEqual(['y']);
  });

  test('щорічне одразу після свята — картка є: до наступної річниці ще рік', () => {
    const yearly = home({ id: 'y', event_date: '2026-10-18', repeats_yearly: true });
    expect(yearlyReminders([yearly], '2026-10-19', none)).toEqual([]);
    expect(ids(afterEventHome([yearly], '2026-10-19', none))).toEqual(['y']);
  });

  test('нагадування — найближча річниця першою, архівні теж', () => {
    const lists = [
      home({ id: 'late', event_date: '2025-12-15', repeats_yearly: true }),
      home({ id: 'arch', event_date: '2025-12-01', repeats_yearly: true, is_archived: true }),
    ];
    expect(yearlyReminders(lists, '2026-11-22', none).map((r) => r.list.id)).toEqual(['arch', 'late']);
  });
});
