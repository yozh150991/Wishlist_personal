import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import {
  FOLD_FROM,
  FOLD_TO,
  SEARCH_QUERY_MAX,
  SEARCH_WORDS_MAX,
  copyTargets,
  fold,
  hitsFromServer,
  markRanges,
  matchItem,
  noteSnippet,
  queryWords,
  searchLocal,
  searchable,
  shopOf,
} from '../../src/lib/search';
import { copyInput } from '../../src/lib/afterEvent';
import type { Item, List } from '../../src/lib/types';

// Пошук по всіх списках (ROADMAP 8.11, lib/search.ts): нормалізація запиту,
// збіг по назві, нотатці, магазину й ознаках, підсвітка й порядок — без
// браузера, як after-event.spec.ts. Те саме правило в базі перевіряє pgTAP
// (supabase/tests/database/33_search_my_items.test.sql).

function item(over: Partial<Item> = {}): Item {
  return {
    id: 'i1',
    list_id: 'l1',
    owner_id: 'u1',
    title: 'Плед',
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
    created_at: '2025-12-01T10:00:00Z',
    updated_at: '2025-12-01T10:00:00Z',
    ...over,
  };
}

function list(over: Partial<List> = {}): List {
  return {
    id: 'l1',
    owner_id: 'u1',
    title: 'Новий рік',
    description: null,
    currency: 'PLN',
    event_date: null,
    is_archived: false,
    created_at: '2025-11-01T10:00:00Z',
    updated_at: '2025-11-01T10:00:00Z',
    ...over,
  };
}

const words = (q: string) => queryWords(q);

test.describe('згортання', () => {
  test('регістр, польська діакритика, ї/є/ґ/й і апострофи', () => {
    expect(fold('Łyżka Źdźbło ĄĘ')).toBe('lyzka zdzblo ae');
    expect(fold('Їжак Євген Ґанок Йогурт')).toBe('іжак евген ганок иогурт');
    expect(fold('м’яч мʼяч м‘яч м`яч')).toBe("м'яч м'яч м'яч м'яч");
    expect(fold('Crème Brûlée')).toBe('creme brulee');
  });

  test('довжина рядка не змінюється — на ній тримається підсвітка', () => {
    for (const s of ['Łyżka', 'İstanbul', 'Їжак', 'emoji 🎁 тут']) expect(fold(s)).toHaveLength(s.length);
  });

  test('таблиця літер — кожна літера рівно одна кодова одиниця, пар порівну', () => {
    expect(FOLD_FROM.length).toBe(FOLD_TO.length);
    expect(new Set(FOLD_FROM).size).toBe(FOLD_FROM.length);
  });

  test('у міграції search_my_items — рівно та сама таблиця', () => {
    const dir = new URL('../../../supabase/migrations/', import.meta.url);
    const file = readdirSync(dir).find((f) => /^\d{14}_search_my_items\.sql$/.test(f));
    expect(file).toBeTruthy();
    const sql = readFileSync(new URL(file!, dir), 'utf8');
    const from = [...sql.matchAll(/\$f\$(.*?)\$f\$/g)].map((m) => m[1]);
    const to = [...sql.matchAll(/\$t\$(.*?)\$t\$/g)].map((m) => m[1]);
    expect(from.length).toBe(3);
    expect(to.length).toBe(3);
    for (const f of from) expect(f).toBe(FOLD_FROM);
    for (const t of to) expect(t).toBe(FOLD_TO);
  });
});

test.describe('запит', () => {
  test('слова без зайвих пробілів, згорнуті, не більше восьми', () => {
    expect(queryWords('  Червоний   ПЛЕД ')).toEqual([fold('червоний'), 'плед']);
    expect(queryWords('a b c d e f g h i j')).toHaveLength(SEARCH_WORDS_MAX);
    expect(queryWords('')).toEqual([]);
  });

  test('довший за межу запит обрізається, як і поле', () => {
    expect(queryWords('я'.repeat(SEARCH_QUERY_MAX + 20))[0]).toHaveLength(SEARCH_QUERY_MAX);
  });

  test('щонайменше дві літери без пробілів', () => {
    expect(searchable('я')).toBe(false);
    expect(searchable(' я ')).toBe(false);
    expect(searchable('я я')).toBe(true);
    expect(searchable('пл')).toBe(true);
  });
});

test.describe('збіг', () => {
  test('назва й нотатка', () => {
    expect(matchItem(item(), words('плед'))?.fields).toEqual(new Set(['title']));
    const winter = item({ title: 'Ковдра', note: 'Як у Олі на ЗИМОВІ свята' });
    expect(matchItem(winter, words('зимові'))?.fields).toEqual(new Set(['note']));
    expect(matchItem(winter, words('зимові'))?.inTitle).toBe(false);
  });

  test('магазин — хост посилання без www., не шлях; або source_site', () => {
    const a = item({ url: 'https://www.Allegro.pl/oferta/plaid-1' });
    expect(shopOf(a)).toBe('allegro.pl');
    expect(matchItem(a, words('allegro'))?.fields).toEqual(new Set(['shop']));
    expect(matchItem(a, words('oferta'))).toBeNull();
    expect(matchItem(a, words('www'))).toBeNull();
    const b = item({ source_site: 'Rozetka' });
    expect(shopOf(b)).toBe('Rozetka');
    expect(matchItem(b, words('rozetka'))?.fields).toEqual(new Set(['shop']));
  });

  test('ознаки — і підпис, і значення', () => {
    const v = item({ variants: [{ label: 'Колір', value: 'Червоний' }] });
    expect(matchItem(v, words('червоний'))?.fields).toEqual(new Set(['variant']));
    expect(matchItem(v, words('колір'))?.fields).toEqual(new Set(['variant']));
  });

  test('кожне слово — хоч десь; одне слово не зшиває два поля', () => {
    const v = item({ variants: [{ label: 'Колір', value: 'Червоний' }] });
    expect(matchItem(v, words('червоний плед'))?.fields).toEqual(new Set(['title', 'variant']));
    expect(matchItem(v, words('плед зелений'))).toBeNull();
    // «Плед» + нотатка «ок»: «ледок» не з'являється на стику полів.
    expect(matchItem(item({ note: 'ок' }), words('ледок'))).toBeNull();
  });

  test('діакритика не важить ні в запиті, ні в позиції', () => {
    expect(matchItem(item({ title: 'Łyżka drewniana' }), words('LYZKA'))).not.toBeNull();
    expect(matchItem(item({ title: 'Lyzka' }), words('łyżka'))).not.toBeNull();
    expect(matchItem(item({ title: 'Їжак іграшка' }), words('іжак'))).not.toBeNull();
  });

  test('% і _ — звичайні літери', () => {
    expect(matchItem(item({ title: 'Ваза axb' }), words('a_b'))).toBeNull();
    expect(matchItem(item({ title: 'Знижка 50%' }), words('50%'))).not.toBeNull();
  });
});

test.describe('підсвітка', () => {
  test('шматки «збіг / ні», перекриті збіги злито, регістр оригіналу на місці', () => {
    expect(markRanges('Łyżka drewniana', words('lyz drew'))).toEqual([
      { text: 'Łyż', hit: true },
      { text: 'ka ', hit: false },
      { text: 'drew', hit: true },
      { text: 'niana', hit: false },
    ]);
    expect(markRanges('аааб', words('аа'))).toEqual([
      { text: 'ааа', hit: true },
      { text: 'б', hit: false },
    ]);
    expect(markRanges('', words('x'))).toEqual([]);
  });

  test('уривок нотатки — довкола першого збігу, з трикрапками', () => {
    const note = `${'а'.repeat(100)} різдво ${'б'.repeat(200)}`;
    const s = noteSnippet(note, words('Різдво'), 10)!;
    expect(s.startsWith('…')).toBe(true);
    expect(s.endsWith('…')).toBe(true);
    expect(s).toContain('різдво');
    expect(noteSnippet('коротко про різдво', words('різдво'))).toBe('коротко про різдво');
    expect(noteSnippet('нічого', words('різдво'))).toBeNull();
    expect(noteSnippet(null, words('різдво'))).toBeNull();
  });
});

test.describe('результати', () => {
  const live = list({ id: 'live' });
  const archive = list({ id: 'arch', title: 'Різдво 2025', is_archived: true });

  test('без мережі: спершу все в назві, далі живі перед архівом, далі свіжіші; кожна позиція раз', () => {
    const inNote = item({ id: 'n', list_id: 'live', title: 'Ковдра', note: 'під плед', updated_at: '2026-11-01T00:00:00Z' });
    const oldArch = item({ id: 'a', list_id: 'arch', title: 'Плед', updated_at: '2025-12-20T00:00:00Z' });
    const newLive = item({ id: 'l', list_id: 'live', title: 'Плед вовняний', updated_at: '2026-01-01T00:00:00Z' });
    const hits = searchLocal([inNote, oldArch, newLive, oldArch], [live, archive], 'плед');
    expect(hits.map((h) => h.item.id)).toEqual(['l', 'a', 'n']);
    expect(hits[1]!.list?.is_archived).toBe(true);
  });

  test('без мережі — не більше межі', () => {
    const many = Array.from({ length: 70 }, (_, i) => item({ id: `i${i}` }));
    expect(searchLocal(many, [live], 'плед')).toHaveLength(50);
    expect(searchLocal(many, [live], ' ')).toEqual([]);
  });

  test('з бази: порядок бази, списки приєднано, незнайдений список — null', () => {
    const rows = [item({ id: 'x', list_id: 'arch' }), item({ id: 'y', list_id: 'gone' })];
    const hits = hitsFromServer(rows, [live, archive], 'плед');
    expect(hits.map((h) => h.item.id)).toEqual(['x', 'y']);
    expect(hits[0]!.list?.title).toBe('Різдво 2025');
    expect(hits[1]!.list).toBeNull();
  });

  test('копіювати можна в живі списки, крім свого', () => {
    const other = list({ id: 'other', title: 'День народження' });
    expect(copyTargets([live, archive, other], 'live').map((l) => l.id)).toEqual(['other']);
  });

  test('копія з архіву — знову бажання: статус «актуальна», без жодного поля позначок', () => {
    const gifted = item({ status: 'gifted', note: 'зимові свята', variants: [{ label: 'Колір', value: 'сірий' }] });
    const input = copyInput(gifted, undefined, 'PLN');
    expect(input.status).toBe('active');
    expect(input.note).toBe('зимові свята');
    expect(input.variants).toEqual([{ label: 'Колір', value: 'сірий' }]);
    expect(Object.keys(input).sort()).toEqual(
      ['currency', 'image_url', 'needs_title', 'note', 'position', 'price', 'priority', 'quantity', 'section_id', 'status', 'title', 'url', 'variants'].sort(),
    );
  });
});
