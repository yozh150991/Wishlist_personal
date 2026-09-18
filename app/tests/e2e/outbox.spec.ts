import { test, expect } from '@playwright/test';
import { applyToItems } from '../../src/lib/outboxOps';
import type { Op } from '../../src/lib/outboxOps';
import type { Item } from '../../src/lib/types';

// Чисті функції: ні сторінки, ні браузера — як safe-next.spec.ts і transfer.spec.ts.

function item(over: Partial<Item> = {}): Item {
  return {
    id: 'i1',
    list_id: 'l1',
    owner_id: 'u1',
    title: 'Кавоварка',
    url: null,
    price: 450,
    quantity: 1,
    priority: 'medium',
    note: null,
    image_url: null,
    status: 'active',
    source_site: null,
    parsed_at: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const NOW = '2026-09-18T20:00:00Z';

test.describe('застосування черги до списку', () => {
  test('створення додає позицію зверху — усталене сортування новіші першими', () => {
    const op: Op = { kind: 'create', listId: 'l1', id: 'new', input: { title: 'Келихи' } };
    const out = applyToItems([item()], op, NOW);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: 'new',
      title: 'Келихи',
      status: 'active',
      quantity: 1,
      priority: 'medium',
      price: null,
    });
    expect(out[1]?.id).toBe('i1');
  });

  test('створена офлайн позиція має той самий id, що піде в базу', () => {
    const op: Op = { kind: 'create', listId: 'l1', id: 'fixed-id', input: { title: 'А' } };
    expect(applyToItems([], op, NOW)[0]?.id).toBe('fixed-id');
  });

  test('зміна оновлює лише свою позицію', () => {
    const op: Op = { kind: 'update', listId: 'l1', id: 'i1', input: { title: 'Інша', price: 99 } };
    const out = applyToItems([item(), item({ id: 'i2', title: 'Друга' })], op, NOW);
    expect(out[0]).toMatchObject({ title: 'Інша', price: 99, updated_at: NOW });
    expect(out[1]).toMatchObject({ title: 'Друга', price: 450 });
  });

  test('зміна статусу бере всі вибрані позиції й не чіпає решту', () => {
    const op: Op = { kind: 'status', listId: 'l1', ids: ['i1', 'i3'], status: 'gifted' };
    const out = applyToItems(
      [item(), item({ id: 'i2' }), item({ id: 'i3' })],
      op,
      NOW,
    );
    expect(out.map((i) => i.status)).toEqual(['gifted', 'active', 'gifted']);
  });

  test('видалення прибирає лише названі позиції', () => {
    const op: Op = { kind: 'delete', listId: 'l1', ids: ['i2'] };
    const out = applyToItems([item(), item({ id: 'i2' }), item({ id: 'i3' })], op, NOW);
    expect(out.map((i) => i.id)).toEqual(['i1', 'i3']);
  });

  test('видалення того, чого вже немає, нічого не ламає', () => {
    const op: Op = { kind: 'delete', listId: 'l1', ids: ['немає'] };
    expect(applyToItems([item()], op, NOW).map((i) => i.id)).toEqual(['i1']);
  });

  test('операції накладаються по черзі, як їх робила людина', () => {
    const ops: Op[] = [
      { kind: 'create', listId: 'l1', id: 'n1', input: { title: 'Нова' } },
      { kind: 'status', listId: 'l1', ids: ['n1'], status: 'purchased' },
      { kind: 'delete', listId: 'l1', ids: ['i1'] },
    ];
    const out = ops.reduce((acc, op) => applyToItems(acc, op, NOW), [item()]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'n1', title: 'Нова', status: 'purchased' });
  });

  test('вихідний масив не змінюється — React бачить новий стан', () => {
    const before = [item()];
    applyToItems(before, { kind: 'delete', listId: 'l1', ids: ['i1'] }, NOW);
    expect(before).toHaveLength(1);
  });
});
