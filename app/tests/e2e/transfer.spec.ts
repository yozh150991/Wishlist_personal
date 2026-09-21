import { test, expect } from '@playwright/test';
import {
  MAX_IMPORT_ITEMS,
  fileName,
  parseCsv,
  parseCsvFile,
  parseFile,
  parseJsonFile,
  toCsv,
  toJson,
} from '../../src/lib/transfer';
import type { Item, List } from '../../src/lib/types';

// Чисті функції: ні сторінки, ні браузера. Як і safe-next.spec.ts, ці тести
// йдуть під Playwright лише щоб не заводити другий запускач.

const list: List = {
  id: 'l1',
  owner_id: 'u1',
  title: 'День народження',
  description: 'Подарунки',
  currency: 'PLN',
  event_date: '2026-05-01',
  is_archived: false,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function item(over: Partial<Item> = {}): Item {
  return {
    id: 'i1',
    list_id: 'l1',
    owner_id: 'u1',
    title: 'Кавоварка',
    url: 'https://shop.example.com/a',
    price: 450,
    quantity: 1,
    priority: 'high',
    status: 'active',
    note: null,
    variants: [],
    image_url: null,
    source_site: 'shop.example.com',
    parsed_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

test.describe('вивантаження', () => {
  test('JSON описує вміст, а не рядки бази', () => {
    const parsed = JSON.parse(toJson(list, [item()]));
    expect(parsed.format).toBe('wishlist-personal');
    expect(parsed.list).toEqual({
      title: 'День народження',
      description: 'Подарунки',
      currency: 'PLN',
      event_date: '2026-05-01',
    });
    expect(parsed.items[0]).toEqual({
      title: 'Кавоварка',
      url: 'https://shop.example.com/a',
      price: 450,
      quantity: 1,
      priority: 'high',
      status: 'active',
      note: null,
      image_url: null,
      variants: [],
    });
  });

  test('у файл не потрапляють ні id, ні токени, ні службові поля', () => {
    const text = toJson(list, [item()]);
    for (const forbidden of ['owner_id', '"id"', 'list_id', 'token', 'created_at', 'source_site']) {
      expect(text).not.toContain(forbidden);
    }
  });

  test('CSV має BOM і заголовок з очікуваними колонками', () => {
    const csv = toCsv([item()]);
    expect(csv.startsWith('﻿')).toBe(true);
    expect(csv.split('\r\n')[0]).toBe(
      '﻿title,url,price,quantity,priority,status,note,image_url,variants',
    );
  });

  test('коми, лапки й переноси рядків не ламають колонки', () => {
    const csv = toCsv([item({ title: 'Ніж "шеф", 20 см', note: 'рядок\nдругий' })]);
    const rows = parseCsv(csv.replace(/^﻿/, ''), ',');
    expect(rows[1]?.[0]).toBe('Ніж "шеф", 20 см');
    expect(rows[1]?.[6]).toBe('рядок\nдругий');
  });

  test('клітинка, що починається з =, не стає формулою в таблиці', () => {
    const csv = toCsv([item({ title: '=1+1' })]);
    expect(csv).toContain("'=1+1");
    // Але при зворотному читанні апостроф не осідає в назві.
    expect(parseCsvFile(csv, 'Список').items[0]?.title).toBe('=1+1');
  });

  test('ціна без значення лишається порожньою, а не нулем', () => {
    const csv = toCsv([item({ price: null })]);
    expect(csv.split('\r\n')[1]?.split(',')[2]).toBe('');
    expect(parseCsvFile(csv, 'Список').items[0]?.price).toBeNull();
  });

  test('імʼя файлу безпечне й не порожнє', () => {
    expect(fileName('Список: подарунки/2026', 'csv')).toMatch(/^Список-подарунки2026-\d{4}-\d{2}-\d{2}\.csv$/);
    expect(fileName('   ', 'json')).toMatch(/^wishlist-\d{4}-\d{2}-\d{2}\.json$/);
  });
});

test.describe('повний оберт', () => {
  test('CSV: вивантажили — внесли — отримали те саме', () => {
    const items = [
      item({ title: 'Кавоварка', price: 450.5, quantity: 2, priority: 'low', status: 'gifted' }),
      item({ title: 'Келихи', price: null, url: null, note: 'на 6 персон' }),
    ];
    const back = parseCsvFile(toCsv(items), 'Список');
    expect(back.issues).toEqual([]);
    expect(back.items).toEqual(items.map((i) => ({
      title: i.title,
      url: i.url,
      price: i.price,
      quantity: i.quantity,
      priority: i.priority,
      status: i.status,
      note: i.note,
      image_url: i.image_url,
      variants: i.variants,
    })));
  });

  test('JSON: список і позиції повертаються без втрат', () => {
    const back = parseJsonFile(toJson(list, [item()]), 'Запасна назва');
    expect(back.issues).toEqual([]);
    expect(back.list).toEqual({
      title: 'День народження',
      description: 'Подарунки',
      currency: 'PLN',
      event_date: '2026-05-01',
    });
    expect(back.items).toHaveLength(1);
  });
});

test.describe('перевірка при внесенні', () => {
  const head = 'title,url,price,quantity,priority,status,note,image_url,variants';

  test('рядок без назви пропускається з помилкою', () => {
    const r = parseCsvFile(`${head}\nНормальна,,,,,,,\n,,10,,,,,`, 'Список');
    expect(r.items).toHaveLength(1);
    expect(r.issues).toEqual([
      { level: 'error', row: 3, key: 'transfer.issues.titleRequired' },
    ]);
  });

  test('задовга назва — помилка рядка, задовга нотатка — обрізання', () => {
    const long = 'я'.repeat(201);
    const note = 'н'.repeat(1001);
    const r = parseCsvFile(`${head}\n${long},,,,,,,\nНазва,,,,,,"${note}",`, 'Список');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.note).toHaveLength(1000);
    expect(r.issues.map((i) => i.key)).toEqual([
      'transfer.issues.titleLong',
      'transfer.issues.noteLong',
    ]);
  });

  test('погана ціна не ламає рядок, а лише очищає поле', () => {
    const r = parseCsvFile(`${head}\nНазва,,дорого,,,,,`, 'Список');
    expect(r.items[0]?.price).toBeNull();
    expect(r.issues[0]).toMatchObject({ level: 'warning', key: 'transfer.issues.price' });
  });

  test('відʼємна ціна відхиляється — у базі стоїть check (price >= 0)', () => {
    expect(parseCsvFile(`${head}\nНазва,,-5,,,,,`, 'Список').items[0]?.price).toBeNull();
  });

  test('ціна з комою й нерозривним пробілом читається', () => {
    const r = parseCsvFile(`${head}\nНазва,,"1 234,56",,,,,`, 'Список');
    expect(r.items[0]?.price).toBe(1234.56);
    expect(r.issues).toEqual([]);
  });

  test('кількість поза межами 1..999 повертається до 1', () => {
    const r = parseCsvFile(`${head}\nА,,,0,,,,\nБ,,,1000,,,,\nВ,,,2.5,,,,`, 'Список');
    expect(r.items.map((i) => i.quantity)).toEqual([1, 1, 1]);
    expect(r.issues).toHaveLength(3);
    expect(r.issues.every((i) => i.key === 'transfer.issues.quantity')).toBe(true);
  });

  test('невідомі статус і пріоритет замінюються усталеними', () => {
    const r = parseCsvFile(`${head}\nНазва,,,,urgent,bought,,`, 'Список');
    expect(r.items[0]).toMatchObject({ priority: 'medium', status: 'active' });
    expect(r.issues.map((i) => i.key)).toEqual([
      'transfer.issues.priority',
      'transfer.issues.status',
    ]);
  });

  test('регістр статусу й пріоритету значення не змінює', () => {
    const r = parseCsvFile(`${head}\nНазва,,,,HIGH,Gifted,,`, 'Список');
    expect(r.items[0]).toMatchObject({ priority: 'high', status: 'gifted' });
    expect(r.issues).toEqual([]);
  });

  test('посилання не за схемою http очищається, рядок лишається', () => {
    const r = parseCsvFile(`${head}\nНазва,javascript:alert(1),,,,,,ftp://x/i.png`, 'Список');
    expect(r.items[0]).toMatchObject({ url: null, image_url: null, title: 'Назва' });
    expect(r.issues).toHaveLength(2);
  });

  test('крапка з комою як розділювач розпізнається сама', () => {
    const r = parseCsvFile('title;url;price\nКавоварка;;450', 'Список');
    expect(r.items[0]).toMatchObject({ title: 'Кавоварка', price: 450 });
  });

  test('колонки в іншому порядку й зайві колонки не заважають', () => {
    const r = parseCsvFile('price,note,title\n99,нотатка,Назва', 'Список');
    expect(r.items[0]).toMatchObject({ title: 'Назва', price: 99, note: 'нотатка' });
  });

  test('файл без колонки title відхиляється цілком', () => {
    const r = parseCsvFile('назва,ціна\nКавоварка,450', 'Список');
    expect(r.items).toEqual([]);
    expect(r.issues[0]?.key).toBe('transfer.issues.noTitleColumn');
  });

  test('порожній файл дає зрозумілу помилку, а не порожній список', () => {
    expect(parseCsvFile('', 'Список').issues[0]?.key).toBe('transfer.issues.empty');
  });

  test('зіпсований JSON не валить розбір', () => {
    expect(parseJsonFile('{ це не json', 'Список').issues[0]?.key).toBe('transfer.issues.badJson');
  });

  test('JSON без масиву позицій відхиляється', () => {
    expect(parseJsonFile('{"list":{"title":"А"}}', 'Список').issues[0]?.key).toBe(
      'transfer.issues.noItems',
    );
  });

  test('приймається й голий масив позицій', () => {
    const r = parseJsonFile('[{"title":"Кавоварка","price":450}]', 'Запасна');
    expect(r.items).toHaveLength(1);
    expect(r.list.title).toBe('Запасна');
  });

  test('чужий format лише попереджає, але файл читається', () => {
    const r = parseJsonFile('{"format":"other-app","items":[{"title":"А"}]}', 'Список');
    expect(r.items).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ level: 'warning', key: 'transfer.issues.foreignFormat' });
  });

  test('невідома валюта й крива дата події замінюються усталеними', () => {
    const r = parseJsonFile(
      '{"list":{"title":"А","currency":"GBP","event_date":"01.05.2026"},"items":[{"title":"Б"}]}',
      'Список',
    );
    expect(r.list).toMatchObject({ currency: 'PLN', event_date: null });
    expect(r.issues.map((i) => i.key)).toEqual([
      'transfer.issues.currency',
      'transfer.issues.eventDate',
    ]);
  });

  test('понад тисячу позицій обрізається з попередженням', () => {
    const items = Array.from({ length: MAX_IMPORT_ITEMS + 5 }, (_, i) => ({ title: `Позиція ${i}` }));
    const r = parseJsonFile(JSON.stringify({ items }), 'Список');
    expect(r.items).toHaveLength(MAX_IMPORT_ITEMS);
    expect(r.issues.at(-1)?.key).toBe('transfer.issues.tooMany');
  });

  test('формат визначається за розширенням, а без нього — за вмістом', () => {
    expect(parseFile('a.json', '{"items":[{"title":"А"}]}', 'С').items).toHaveLength(1);
    expect(parseFile('a.csv', 'title\nА', 'С').items).toHaveLength(1);
    expect(parseFile('dump', '{"items":[{"title":"А"}]}', 'С').items).toHaveLength(1);
    expect(parseFile('dump', 'title\nА', 'С').items).toHaveLength(1);
  });
});

test.describe('ознаки товару', () => {
  const head = 'title,url,price,quantity,priority,status,note,image_url,variants';

  test('CSV: пари повертаються точно, навіть із роздільниками всередині', () => {
    const variants = [
      { label: 'Розмір', value: 'M; L' },
      { label: 'Колір', value: 'чорний: матовий' },
    ];
    const back = parseCsvFile(toCsv([item({ variants })]), 'Список');
    expect(back.issues).toEqual([]);
    expect(back.items[0]?.variants).toEqual(variants);
  });

  test('CSV: людський запис «підпис: значення» теж читається', () => {
    const r = parseCsvFile(`${head}\nСветр,,,,,,,,"Розмір: M; Колір: чорний"`, 'Список');
    expect(r.issues).toEqual([]);
    expect(r.items[0]?.variants).toEqual([
      { label: 'Розмір', value: 'M' },
      { label: 'Колір', value: 'чорний' },
    ]);
  });

  test('порожня клітинка — просто порожній список, без зауважень', () => {
    const r = parseCsvFile(`${head}\nСветр,,,,,,,,`, 'Список');
    expect(r.items[0]?.variants).toEqual([]);
    expect(r.issues).toEqual([]);
  });

  test('напівзаповнена пара відкидається з попередженням', () => {
    const r = parseCsvFile(`${head}\nСветр,,,,,,,,"Розмір: ; Колір: чорний"`, 'Список');
    expect(r.items[0]?.variants).toEqual([{ label: 'Колір', value: 'чорний' }]);
    expect(r.issues.map((i) => i.key)).toEqual(['transfer.issues.variants']);
  });

  test('зайві пари відкидаються, задовгі обрізаються', () => {
    const many = Array.from({ length: 7 }, (_, i) => `П${i}: з${i}`).join('; ');
    const r = parseCsvFile(`${head}\nСветр,,,,,,,,"${many}"`, 'Список');
    expect(r.items[0]?.variants).toHaveLength(5);
    expect(r.issues.map((i) => i.key)).toEqual(['transfer.issues.variantsMany']);

    const long = `${'п'.repeat(50)}: ${'з'.repeat(90)}`;
    const r2 = parseCsvFile(`${head}\nСветр,,,,,,,,"${long}"`, 'Список');
    expect(r2.items[0]?.variants[0]?.label).toHaveLength(40);
    expect(r2.items[0]?.variants[0]?.value).toHaveLength(80);
    expect(r2.issues.map((i) => i.key)).toEqual(['transfer.issues.variantsLong']);
  });

  test('переноси рядка в клітинці згортаються: база їх не прийме', () => {
    const r = parseCsvFile(`${head}\nСветр,,,,,,,,"Розмір: M\nдодатково"`, 'Список');
    expect(r.items[0]?.variants).toEqual([{ label: 'Розмір', value: 'M додатково' }]);
  });

  test('зіпсований JSON у клітинці не ламає рядок', () => {
    const r = parseCsvFile(`${head}\nСветр,,,,,,,,"[{""label"":""Розмір"""`, 'Список');
    expect(r.items).toHaveLength(1);
    expect(r.items[0]?.variants).toEqual([]);
    expect(r.issues.map((i) => i.key)).toEqual(['transfer.issues.variants']);
  });

  test('JSON: масив ознак читається як масив, а не як текст', () => {
    const payload = JSON.stringify({
      items: [{ title: 'Светр', variants: [{ label: 'Розмір', value: 'M' }] }],
    });
    const r = parseJsonFile(payload, 'Список');
    expect(r.issues).toEqual([]);
    expect(r.items[0]?.variants).toEqual([{ label: 'Розмір', value: 'M' }]);
  });

  test('ознаки не протікають у файл як службові поля', () => {
    const text = toJson(list, [item({ variants: [{ label: 'Розмір', value: 'M' }] })]);
    expect(JSON.parse(text).items[0].variants).toEqual([{ label: 'Розмір', value: 'M' }]);
    expect(text).not.toContain('reserved');
  });
});
