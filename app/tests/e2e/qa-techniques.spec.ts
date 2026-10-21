import { test, expect } from '@playwright/test';
import {
  EMPTY_RANGE,
  PRICE_MAX,
  matchesView,
  normalizeUrl,
  parsePrice,
  toMinor,
  urlKey,
  type ViewRange,
} from '../../src/lib/itemsView';
import { MIN_PASSWORD, passwordChecks, passwordOk } from '../../src/lib/password';
import { variantsError } from '../../src/lib/variants';
import { priceThresholds } from '../../src/lib/format';
import { safeNext } from '../../src/lib/safeNext';
import { MAX_IMPORT_ITEMS, fileName, parseCsvFile, parseJsonFile } from '../../src/lib/transfer';
import { applyToItems, type Op } from '../../src/lib/outboxOps';
import type { Item, ItemStatus } from '../../src/lib/types';

// QA-регресія за техніками тест-дизайну (ADR-069), чисті функції без браузера.
//
// Кожен describe — одна техніка. Відомі баги позначено `test.fail()` з номером
// із docs/QA_REPORT.md: такий тест зелений, поки баг є, і червоніє, щойно баг
// виправлено, — тоді позначку треба зняти й тест стає звичайною регресією.

let seq = 0;
function item(over: Partial<Item> = {}): Item {
  seq += 1;
  return {
    id: `qa${String(seq).padStart(4, '0')}`,
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
    needs_title: false,
    currency: null,
    created_at: '2026-09-10T10:00:00Z',
    updated_at: '2026-09-10T10:00:00Z',
    ...over,
  };
}

const csv = (header: string, row: string) => parseCsvFile(`${header}\n${row}\n`, 'Імпорт');

/* ═══════════════════════════════════════════════════════════════
 * 1. Класи еквівалентності (EP)
 * ═══════════════════════════════════════════════════════════════ */

test.describe('EP: класи еквівалентності', () => {
  test('адреса товару: кожен клас дає свій результат', () => {
    // [вхід, очікуване] — по одному представнику з кожного класу.
    const classes: [string, string | null][] = [
      ['https://shop.pl/lampa', 'https://shop.pl/lampa'], // повна адреса
      ['http://shop.pl/lampa', 'http://shop.pl/lampa'], // http теж дозволено
      ['shop.pl/lampa', 'https://shop.pl/lampa'], // без схеми — додається https
      ['Глянь: https://shop.pl/lampa?x=1 супер', 'https://shop.pl/lampa?x=1'], // адреса в тексті
      ['https://xn--80ak6aa92e.com', 'https://xn--80ak6aa92e.com/'], // IDN у punycode
      ['shoppl', null], // без крапки в хості
      ['ftp://shop.pl/x', null], // чужа схема
      ['javascript:alert(1)', null], // небезпечна схема
      ['   ', null], // порожньо
      ['просто текст без адреси', null], // текст без адреси
    ];
    for (const [input, want] of classes) expect(normalizeUrl(input), input).toBe(want);
  });

  test('ціна з поля: валідні формати й класи помилок', () => {
    const valid: [string, number | null][] = [
      ['', null], // порожньо — «без ціни», не помилка
      ['0', 0], // нуль — дозволена ціна
      ['1240', 1240],
      ['1 240,50', 1240.5], // пробіл-розряд, кома-дріб
      ['1.240,50', 1240.5], // крапка-розряд
      ['1,240.50', 1240.5], // кома-розряд
      ['1 240', 1240], // нерозривний пробіл
    ];
    for (const [input, want] of valid) expect(parsePrice(input), input).toEqual({ value: want, error: null });
    for (const input of ['abc', '-5', '+5', '1,2345', '12a', '٣٤']) {
      expect(parsePrice(input).error, input).toBe('format');
    }
  });

  test('імпорт: статус і пріоритет — свій клас, чужі значення — усталені з попередженням', () => {
    for (const [raw, want] of [
      ['active', 'active'],
      ['Purchased', 'purchased'],
      ['gifted', 'gifted'],
      ['done', 'active'],
    ] as const) {
      const r = csv('title,status', `Річ,${raw}`);
      expect(r.items[0]?.status, raw).toBe(want);
      expect(r.issues.some((i) => i.key === 'transfer.issues.status'), raw).toBe(want !== raw.toLowerCase());
    }
    for (const [raw, want] of [
      ['HIGH', 'high'],
      ['low', 'low'],
      ['urgent', 'medium'],
    ] as const) {
      expect(csv('title,priority', `Річ,${raw}`).items[0]?.priority, raw).toBe(want);
    }
  });

  test('імпорт: валюта позиції — з переліку, порожня, невідома', () => {
    expect(csv('title,currency', 'Річ,eur').items[0]?.currency).toBe('EUR');
    expect(csv('title,currency', 'Річ,').items[0]?.currency).toBeNull();
    const gbp = csv('title,currency', 'Річ,GBP');
    expect(gbp.items[0]?.currency).toBeNull();
    expect(gbp.issues.map((i) => i.key)).toContain('transfer.issues.itemCurrency');
  });
});

/* ═══════════════════════════════════════════════════════════════
 * 2. Граничні значення (BVA)
 * ═══════════════════════════════════════════════════════════════ */

test.describe('BVA: граничні значення', () => {
  test('ціна: десять цифр до коми — максимум, одинадцять — забагато', () => {
    expect(parsePrice('9999999999')).toEqual({ value: PRICE_MAX, error: null });
    expect(parsePrice('10000000000').error).toBe('tooBig');
    expect(parsePrice('0,01')).toEqual({ value: 0.01, error: null });
    expect(parsePrice('0,1')).toEqual({ value: 0.1, error: null });
  });

  test('BUG-QA-12: ціна 9 999 999 999,99 — максимум numeric(12,2) — приймається', () => {
    test.fail(true, 'BUG-QA-12: поле відкидає найбільшу ціну, яку приймає база');
    expect(parsePrice('9 999 999 999,99')).toEqual({ value: 9999999999.99, error: null });
  });

  test('пароль: 7 символів — ні, 8 — так; межа — до обрізання пробілів', () => {
    expect(MIN_PASSWORD).toBe(8);
    expect(passwordChecks('Kwiat7!').long).toBe(false);
    expect(passwordOk(passwordChecks('Kwiat78!'))).toBe(true);
    expect(passwordOk(passwordChecks('        '))).toBe(false); // вісім пробілів — не пароль
  });

  test('ознаки товару: 5 пар і 40/80 символів — межі', () => {
    const pair = (label = 'Розмір', value = 'M') => ({ label, value });
    expect(variantsError(Array.from({ length: 5 }, () => pair()))).toBeNull();
    expect(variantsError(Array.from({ length: 6 }, () => pair()))).toBe('item.errors.variantsMany');
    expect(variantsError([pair('я'.repeat(40))])).toBeNull();
    expect(variantsError([pair('я'.repeat(41))])).toBe('item.errors.variantsLong');
    expect(variantsError([pair('Колір', 'ч'.repeat(80))])).toBeNull();
    expect(variantsError([pair('Колір', 'ч'.repeat(81))])).toBe('item.errors.variantsLong');
    // Порожні рядки не рахуються в ліміт.
    expect(variantsError([...Array.from({ length: 5 }, () => pair()), pair('', '')])).toBeNull();
  });

  test('пороги ціни гостя: 5 цін — порогів немає, 6 — є', () => {
    expect(priceThresholds([10, 20, 30, 40, 50])).toEqual([]);
    expect(priceThresholds([10, 20, 30, 40, 50, 60]).length).toBeGreaterThan(0);
    // Нулі й неприпустимі значення в межу не рахуються.
    expect(priceThresholds([0, 0, 10, 20, 30, 40, Number.NaN])).toEqual([]);
  });

  test('імпорт: назва 200/201, нотатка 1000/1001, кількість 0/1/999/1000', () => {
    expect(csv('title', 'я'.repeat(200)).items).toHaveLength(1);
    const long = csv('title', 'я'.repeat(201));
    expect(long.items).toHaveLength(0);
    expect(long.issues.map((i) => i.key)).toContain('transfer.issues.titleLong');

    expect(csv('title,note', `Річ,${'н'.repeat(1000)}`).items[0]?.note).toHaveLength(1000);
    const note = csv('title,note', `Річ,${'н'.repeat(1001)}`);
    expect(note.items[0]?.note).toHaveLength(1000);
    expect(note.issues.map((i) => i.key)).toContain('transfer.issues.noteLong');

    for (const [raw, want, warned] of [
      ['0', 1, true],
      ['1', 1, false],
      ['999', 999, false],
      ['1000', 1, true],
    ] as const) {
      const r = csv('title,quantity', `Річ,${raw}`);
      expect(r.items[0]?.quantity, raw).toBe(want);
      expect(r.issues.some((i) => i.key === 'transfer.issues.quantity'), raw).toBe(warned);
    }
  });

  test('імпорт: 1000 позицій — усі, 1001 — перша тисяча з попередженням', () => {
    const rows = (n: number) => ['title', ...Array.from({ length: n }, (_, i) => `Річ ${i}`)].join('\n');
    expect(MAX_IMPORT_ITEMS).toBe(1000);
    expect(parseCsvFile(rows(1000), 'L').items).toHaveLength(1000);
    const over = parseCsvFile(rows(1001), 'L');
    expect(over.items).toHaveLength(1000);
    expect(over.issues.map((i) => i.key)).toContain('transfer.issues.tooMany');
  });

  test('імпорт JSON: назва списку 120/121 і опис 2000/2001', () => {
    const file = (title: string, description: string) =>
      JSON.stringify({ format: 'wishlist-personal', version: 1, list: { title, description, currency: 'PLN' }, items: [] });
    expect(parseJsonFile(file('Н'.repeat(120), 'о'.repeat(2000)), 'L').issues).toHaveLength(0);
    const r = parseJsonFile(file('Н'.repeat(121), 'о'.repeat(2001)), 'L');
    expect(r.list.title).toHaveLength(120);
    expect(r.list.description).toHaveLength(2000);
    expect(r.issues.map((i) => i.key).sort()).toEqual(['transfer.issues.descriptionLong', 'transfer.issues.listTitleLong']);
  });

  test('BUG-QA-17: імʼя файлу не розрізає емодзі на межі 60 символів', () => {
    test.fail(true, 'BUG-QA-17: slice(0, 60) рахує UTF-16 і лишає половину сурогатної пари');
    const name = fileName(`${'a'.repeat(59)}🎁`, 'csv');
    // Самотня половина сурогатної пари — зіпсований рядок для імені файлу.
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(name)).toBe(false);
  });
});

/* ═══════════════════════════════════════════════════════════════
 * 3. Переходи станів: черга офлайн-змін
 * ═══════════════════════════════════════════════════════════════ */

test.describe('State transition: позиція в черзі офлайн-змін', () => {
  type State = 'absent' | ItemStatus;
  const LIST = 'l1';
  const ID = 'qa-state-item';

  function stateOf(items: Item[]): State {
    const found = items.filter((i) => i.id === ID);
    expect(found.length, 'позиція не дублюється').toBeLessThanOrEqual(1);
    return found[0]?.status ?? 'absent';
  }
  function start(state: State): Item[] {
    return state === 'absent' ? [item()] : [item(), item({ id: ID, status: state })];
  }
  const events: Record<string, Op> = {
    create: { kind: 'create', listId: LIST, id: ID, input: { title: 'Нова' } },
    update: { kind: 'update', listId: LIST, id: ID, input: { title: 'Змінена' } },
    toPurchased: { kind: 'status', listId: LIST, ids: [ID], status: 'purchased' },
    toGifted: { kind: 'status', listId: LIST, ids: [ID], status: 'gifted' },
    toActive: { kind: 'status', listId: LIST, ids: [ID], status: 'active' },
    delete: { kind: 'delete', listId: LIST, ids: [ID] },
  };

  // Таблиця переходів: стан × подія → стан. «create» з наявного стану в
  // таблиці немає навмисно: id нової позиції завжди новий (newId()).
  const table: [State, keyof typeof events, State][] = [
    ['absent', 'create', 'active'],
    ['absent', 'update', 'absent'],
    ['absent', 'toPurchased', 'absent'],
    ['absent', 'delete', 'absent'],
    ['active', 'update', 'active'],
    ['active', 'toPurchased', 'purchased'],
    ['active', 'toGifted', 'gifted'],
    ['active', 'delete', 'absent'],
    ['purchased', 'toActive', 'active'],
    ['purchased', 'toGifted', 'gifted'],
    ['purchased', 'update', 'purchased'],
    ['purchased', 'delete', 'absent'],
    ['gifted', 'toActive', 'active'],
    ['gifted', 'delete', 'absent'],
  ];

  for (const [from, event, to] of table) {
    test(`${from} --${event}--> ${to}`, () => {
      const before = start(from);
      const snapshot = structuredClone(before);
      const after = applyToItems(before, events[event]!);
      expect(stateOf(after)).toBe(to);
      expect(before, 'вихідний масив не змінено').toEqual(snapshot);
    });
  }

  test('ланцюжок: створити → змінити → куплено → видалити — позиції немає й не воскресає', () => {
    let items = start('absent');
    for (const e of ['create', 'update', 'toPurchased', 'delete', 'update', 'toActive'] as const) {
      items = applyToItems(items, events[e]!);
    }
    expect(stateOf(items)).toBe('absent');
  });

  test('зміна не чіпає сусідні позиції', () => {
    const neighbour = item({ status: 'active', title: 'Сусід' });
    const after = applyToItems([neighbour, item({ id: ID })], events.toPurchased!);
    expect(after.find((i) => i.id === neighbour.id)).toEqual(neighbour);
  });
});

/* ═══════════════════════════════════════════════════════════════
 * 4. Попарне тестування: фільтр сторінки списку
 * ═══════════════════════════════════════════════════════════════ */

test.describe('Pairwise: matchesView', () => {
  // Повний перебір 3·2·3·4·2·3·2 = 864; покривний масив — 13 рядків, кожна пара
  // значень будь-яких двох параметрів трапляється хоч раз (QA_REPORT.md).
  type Row = [
    search: 'empty' | 'hit' | 'miss',
    filter: 'all' | 'noPrice',
    statuses: 'none' | 'active' | 'done',
    range: 'none' | 'min' | 'max' | 'both',
    currency: 'list' | 'foreign',
    price: 'null' | 'inside' | 'outside',
    status: 'active' | 'gifted',
  ];
  const rows: Row[] = [
    ['empty', 'noPrice', 'active', 'max', 'foreign', 'null', 'gifted'],
    ['hit', 'all', 'done', 'both', 'foreign', 'inside', 'active'],
    ['miss', 'noPrice', 'none', 'none', 'list', 'outside', 'active'],
    ['hit', 'all', 'none', 'min', 'list', 'null', 'gifted'],
    ['empty', 'all', 'active', 'min', 'foreign', 'outside', 'active'],
    ['empty', 'noPrice', 'done', 'none', 'list', 'inside', 'gifted'],
    ['miss', 'all', 'none', 'max', 'foreign', 'inside', 'active'],
    ['miss', 'noPrice', 'active', 'both', 'list', 'outside', 'gifted'],
    ['hit', 'noPrice', 'done', 'max', 'list', 'outside', 'active'],
    ['hit', 'all', 'active', 'none', 'foreign', 'null', 'active'],
    ['miss', 'noPrice', 'done', 'min', 'list', 'null', 'gifted'],
    ['empty', 'all', 'none', 'both', 'foreign', 'null', 'gifted'],
    ['miss', 'all', 'active', 'min', 'foreign', 'inside', 'gifted'],
  ];
  const MIN = 100;
  const MAX = 500;

  for (const [n, row] of rows.entries()) {
    const [search, filter, statuses, range, currency, price, status] = row;
    test(`рядок ${n + 1}: ${row.join(' · ')}`, () => {
      const priceValue =
        price === 'null' ? null : price === 'inside' ? 300 : range === 'min' ? 50 : 900;
      const it = item({
        title: 'Керамічна лампа',
        price: priceValue,
        currency: currency === 'list' ? null : 'EUR',
        status,
      });
      const r: ViewRange = {
        statuses: statuses === 'none' ? [] : statuses === 'active' ? ['active'] : ['purchased', 'gifted'],
        min: range === 'min' || range === 'both' ? MIN * 100 : null,
        max: range === 'max' || range === 'both' ? MAX * 100 : null,
      };
      const q = search === 'empty' ? '' : search === 'hit' ? '  ЛАМПА ' : 'ваза';

      // Оракул — правила словами, незалежно від реалізації.
      const searchOk = search !== 'miss';
      const filterOk = filter === 'all' || priceValue === null;
      const statusOk = r.statuses.length === 0 || r.statuses.includes(status);
      const rangeOk =
        range === 'none' ||
        (priceValue !== null &&
          currency === 'list' &&
          (r.min === null || priceValue * 100 >= r.min) &&
          (r.max === null || priceValue * 100 <= r.max));

      expect(matchesView(it, q, filter, r, 'PLN')).toBe(searchOk && filterOk && statusOk && rangeOk);
    });
  }

  test('масив справді попарно повний', () => {
    const values = [
      ['empty', 'hit', 'miss'],
      ['all', 'noPrice'],
      ['none', 'active', 'done'],
      ['none', 'min', 'max', 'both'],
      ['list', 'foreign'],
      ['null', 'inside', 'outside'],
      ['active', 'gifted'],
    ];
    for (let a = 0; a < values.length; a += 1) {
      for (let b = a + 1; b < values.length; b += 1) {
        for (const va of values[a]!) {
          for (const vb of values[b]!) {
            expect(rows.some((r) => r[a] === va && r[b] === vb), `${va} × ${vb}`).toBe(true);
          }
        }
      }
    }
  });

  test('усталений діапазон нічого не відсіює', () => {
    expect(matchesView(item({ price: null }), '', 'all', EMPTY_RANGE, 'PLN')).toBe(true);
  });
});

/* ═══════════════════════════════════════════════════════════════
 * 5. Вгадування помилок
 * ═══════════════════════════════════════════════════════════════ */

test.describe('Error guessing', () => {
  test('гроші в мінорних одиницях: класичні пастки float', () => {
    expect(toMinor(0.1 + 0.2)).toBe(30);
    expect(toMinor('19.99')).toBe(1999);
    // Ціна з бази — numeric(12,2): кожні копійки від 0 до 1000,00 і верхня межа точні.
    for (let c = 0; c <= 100_000; c += 1) {
      if (toMinor((c / 100).toFixed(2)) !== c) throw new Error(`toMinor(${(c / 100).toFixed(2)}) ≠ ${c}`);
    }
    expect(toMinor('9999999999.99')).toBe(999_999_999_999);
    expect(toMinor('')).toBeNull();
    expect(toMinor('NaN')).toBeNull();
  });

  test('BUG-QA-13: ціна з кривими розрядами — помилка, а не інше число', () => {
    test.fail(true, 'BUG-QA-13: «1.2.3», «192.168.1.1», «0,500», «1234,567» читаються як числа');
    for (const input of ['1.2.3', '192.168.1.1', '0,500', '1234,567', '1,2,3']) {
      expect(parsePrice(input).error, input).toBe('format');
    }
  });

  test('BUG-QA-14: імпорт ціни — шістнадцяткові й експоненційні записи не стають ціною', () => {
    test.fail(true, 'BUG-QA-14: Number() приймає «1e3» і «0x10»');
    for (const raw of ['1e3', '0x10', '0b101']) {
      const r = csv('title,price', `Річ,${raw}`);
      expect(r.items[0]?.price, raw).toBeNull();
      expect(r.issues.map((i) => i.key), raw).toContain('transfer.issues.price');
    }
  });

  test('BUG-QA-14: імпорт ціни розуміє ті самі формати, що й поле форми', () => {
    test.fail(true, 'BUG-QA-14: «1,240.50» і «1.240,50» з форми в імпорті — попередження й без ціни');
    expect(csv('title,price', 'Річ,"1,240.50"').items[0]?.price).toBe(1240.5);
    expect(csv('title;price', 'Річ;1.240,50').items[0]?.price).toBe(1240.5);
  });

  test('BUG-QA-15: імпорт кількості — лише десяткове ціле', () => {
    test.fail(true, 'BUG-QA-15: «1e2» стає 100, «0x0A» — 10');
    for (const raw of ['1e2', '0x0A']) {
      expect(csv('title,quantity', `Річ,${raw}`).items[0]?.quantity, raw).toBe(1);
    }
  });

  test('BUG-QA-16: та сама сторінка з параметрами в іншому порядку — дублікат', () => {
    test.fail(true, 'BUG-QA-16: urlKey зберігає порядок параметрів запиту');
    expect(urlKey('https://shop.pl/p?color=red&size=m')).toBe(urlKey('https://shop.pl/p?size=m&color=red'));
  });

  test('CSV: формули в клітинках нейтралізовано на експорті й не ламають імпорт', () => {
    for (const title of ['=HYPERLINK("http://evil")', '+1+1', '-2', '@SUM(A1)']) {
      const r = csv('title', `"'${title.replace(/"/g, '""')}"`);
      expect(r.items[0]?.title, title).toBe(title);
    }
  });

  test('next після входу: відомі обходи ведуть на /lists', () => {
    for (const raw of [
      '//evil.com',
      '/\\evil.com',
      '/\t/evil.com',
      '/\n/evil.com',
      'https://evil.com',
      'javascript:alert(1)',
      '\\\\evil.com',
      '/%0a/evil.com/..',
      '',
    ]) {
      const out = safeNext(raw);
      expect(out.startsWith('/') && !out.startsWith('//'), JSON.stringify(raw)).toBe(true);
      expect(new URL(out, 'https://app.invalid').origin, JSON.stringify(raw)).toBe('https://app.invalid');
    }
    expect(safeNext('/lists/abc?tab=1#x')).toBe('/lists/abc?tab=1#x');
  });

  test('адреса з логіном перед @ — хост справжній, а не той, що в логіні', () => {
    const href = normalizeUrl('https://allegro.pl@evil.example/x');
    expect(href === null || new URL(href).hostname === 'evil.example').toBe(true);
  });

  test('імпорт JSON: ворожі значення не роняють розбір', () => {
    for (const text of [
      '{"format":"wishlist-personal","list":null,"items":null}',
      '{"items":[null, 1, "x", {"title": 5}]}',
      '[{"title":"__proto__"},{"title":"constructor"}]',
      `{"items":[${'{"title":"x"},'.repeat(5)}{"title":"y"}]}`,
    ]) {
      expect(() => parseJsonFile(text, 'L'), text).not.toThrow();
    }
    const proto = parseJsonFile('[{"title":"__proto__","note":"x"}]', 'L');
    expect(proto.items[0]?.title).toBe('__proto__');
    expect(({} as Record<string, unknown>).note).toBeUndefined();
  });
});
