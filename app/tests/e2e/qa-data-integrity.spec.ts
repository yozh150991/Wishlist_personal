import { test, expect } from '@playwright/test';
import { parseJsonFile, parseCsvFile, toJson, toCsv, exportItems } from '../../src/lib/transfer';
import { dateTextToIso } from '../../src/lib/dateText';
import { applyToItems, type Op } from '../../src/lib/outboxOps';
import type { Item, List, Currency, ItemStatus, ItemPriority } from '../../src/lib/types';

const NOW = '2026-10-22T10:00:00Z';
const list: List = {
  id: 'qa-list', owner_id: 'qa-owner', title: 'Подарунки', description: null,
  currency: 'PLN', event_date: null, is_archived: false, created_at: NOW, updated_at: NOW,
};
function item(over: Partial<Item> = {}): Item {
  return {
    id: 'qa-item', list_id: list.id, owner_id: list.owner_id, title: 'Лампа 🎁',
    url: 'https://shop.example/lamp', price: 19.99, currency: null,
    quantity: 2, priority: 'medium', status: 'active', note: null, variants: [],
    image_url: null, source_site: null, parsed_at: null, created_at: NOW, updated_at: NOW,
    ...over,
  };
}
const json = (fields: object, listFields: object = {}) => parseJsonFile(JSON.stringify({
  format: 'wishlist-personal', version: 1, list: { title: 'QA', ...listFields },
  items: [{ title: 'Річ', ...fields }],
}), 'QA');

test.describe('EP: JSON numeric prices are numbers, not localized text', () => {
  for (const [price, expected] of [[0, 0], [0.01, 0.01], [19.99, 19.99], [9999999999.99, 9999999999.99]]) {
    test(`valid numeric class ${price}`, () => {
      const parsed = json({ price });
      expect(parsed.issues).toEqual([]);
      expect(parsed.items[0]?.price).toBe(expected);
    });
  }
  for (const [price, expected] of [[1.234, 1.23], [12.345, 12.35], [0.125, 0.13]]) {
    test(`BUG-QA-23: JSON numeric ${price} keeps its decimal magnitude`, () => {
      const parsed = json({ price });
      test.fail(!process.env.QA_STRICT, 'BUG-QA-23: numeric JSON is passed through localized grouping parser');
      expect(parsed.items[0]?.price).toBe(expected);
    });
  }
  for (const price of [-0.01, 10000000000, 'Infinity', 'NaN']) {
    test(`invalid price class ${price} is warned and cleared`, () => {
      const parsed = json({ price });
      expect(parsed.items[0]?.price).toBeNull();
      expect(parsed.issues.map(i => i.key)).toContain('transfer.issues.price');
    });
  }
});

test.describe('BVA: calendar and Unicode boundaries', () => {
  for (const day of ['2000-02-29', '2024-02-29', '2026-04-30', '2026-12-31']) {
    test(`valid event date ${day}`, () => {
      expect(json({}, { event_date: day }).list.event_date).toBe(day);
    });
  }
  for (const day of ['1900-02-29', '2026-02-29', '2026-04-31', '2026-00-01', '2026-13-01', '2026-01-00']) {
    test(`BUG-QA-24: import rejects impossible date ${day}`, () => {
      const [year, month, date] = day.split('-');
      expect(dateTextToIso(`${date}.${month}.${year}`), 'form already rejects this date').toBeNull();
      const parsed = json({}, { event_date: day });
      test.fail(!process.env.QA_STRICT, 'BUG-QA-24: import validates only the ISO shape');
      expect(parsed.list.event_date).toBeNull();
      expect(parsed.issues.map(i => i.key)).toContain('transfer.issues.eventDate');
    });
  }
  for (const [field, max] of [['note', 1000], ['section', 60]] as const) {
    test(`BUG-QA-25: ${field} truncation never creates an unpaired surrogate`, () => {
      const parsed = json({ [field]: 'a'.repeat(max - 1) + '🎁tail' });
      expect(parsed.items).toHaveLength(1);
      expect(parsed.issues.length).toBeGreaterThan(0);
      test.fail(!process.env.QA_STRICT, 'BUG-QA-25: UTF-16 slice breaks emoji, PostgreSQL JSON cannot accept it');
      expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(parsed.items[0]![field]!)).toBe(false);
    });
  }
});

test.describe('ST: export after a sequence of offline edits', () => {
  for (const format of ['json', 'csv'] as const) {
    test(`${format}: create → edit → purchased → active → delete`, () => {
      let items: Item[] = [item({ id: 'neighbour', title: 'Do not change' })];
      const operations: Op[] = [
        { kind: 'create', listId: list.id, id: 'new', input: { title: 'New', price: 12.50 } },
        { kind: 'update', listId: list.id, id: 'new', input: { title: 'Edited', note: 'Two\nlines' } },
        { kind: 'status', listId: list.id, ids: ['new'], status: 'purchased' },
        { kind: 'status', listId: list.id, ids: ['new'], status: 'active' },
        { kind: 'delete', listId: list.id, ids: ['new'] },
      ];
      const expectedStates = ['active', 'active', 'purchased', 'active', undefined];
      for (const [index, operation] of operations.entries()) {
        const before = structuredClone(items);
        const next = applyToItems(items, operation, NOW);
        expect(items).toEqual(before);
        items = next;
        const restored = format === 'json'
          ? parseJsonFile(toJson(list, items), 'QA') : parseCsvFile(toCsv(items), 'QA');
        expect(restored.issues).toEqual([]);
        expect(restored.items).toEqual(exportItems(items));
        expect(items.find(i => i.id === 'new')?.status).toBe(expectedStates[index]);
        expect(items.find(i => i.id === 'neighbour')).toEqual(before.find(i => i.id === 'neighbour'));
      }
    });
  }
});

// Deterministic greedy covering array. Independent pair-completeness assertion
// below prevents silently claiming pairwise coverage after adding a dimension.
const domains = [
  ['json', 'csv'], ['PLN', 'EUR', 'UAH', 'USD'], ['active', 'purchased', 'gifted'],
  ['low', 'medium', 'high'], ['none', 'multiline', 'formula'], ['none', 'variants'],
];
function pairs(row: string[]): string[] {
  return row.flatMap((a, i) => row.slice(i + 1).map((b, j) => JSON.stringify([i, a, i + j + 1, b])));
}
const candidates = domains.reduce<string[][]>((rows, values) => rows.flatMap(r => values.map(v => [...r, v])), [[]]);
const uncovered = new Set(candidates.flatMap(pairs));
const rows: string[][] = [];
while (uncovered.size) {
  let best = candidates[0]!;
  let score = 0;
  for (const candidate of candidates) {
    const count = pairs(candidate).filter(p => uncovered.has(p)).length;
    if (count > score) { best = candidate; score = count; }
  }
  if (!score) throw new Error('Pairwise generation stalled');
  rows.push(best);
  pairs(best).forEach(p => uncovered.delete(p));
}
test.describe('PW: transfer format × currency × status × priority × note × variants', () => {
  test('covering array contains every pair of declared values', () => {
    for (let i = 0; i < domains.length; i++) for (let j = i + 1; j < domains.length; j++) {
      for (const a of domains[i]!) for (const b of domains[j]!) {
        expect(rows.some(r => r[i] === a && r[j] === b), `${i}:${a} × ${j}:${b}`).toBe(true);
      }
    }
    expect(rows.length).toBeLessThan(candidates.length);
  });
  for (const [index, [format, currency, status, priority, note, variants]] of rows.entries()) {
    test(`row ${index + 1}: ${format}/${currency}/${status}/${priority}/${note}/${variants}`, () => {
      const source = item({ currency: currency as Currency, status: status as ItemStatus,
        priority: priority as ItemPriority,
        note: note === 'none' ? null : note === 'multiline' ? 'Перший, "другий"\nTrzeci; fourth' : '=1+1',
        variants: variants === 'none' ? [] : [{ label: 'Колір', value: 'Синій; blue 🎁' }],
      });
      const parsed = format === 'json'
        ? parseJsonFile(toJson(list, [source]), 'QA') : parseCsvFile(toCsv([source]), 'QA');
      expect(parsed.issues).toEqual([]);
      expect(parsed.items).toEqual(exportItems([source]));
    });
  }
});

test('EG BUG-QA-26: syntactically valid hostile JSON produces a validation result, never throws', () => {
  const payload = '{"items":[{"title":{"toString":null}}]}';
  expect(() => JSON.parse(payload)).not.toThrow();
  test.fail(!process.env.QA_STRICT, 'BUG-QA-26: String(object) can throw for imported JSON');
  expect(() => parseJsonFile(payload, 'QA')).not.toThrow();
});
