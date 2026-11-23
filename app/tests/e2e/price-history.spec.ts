import { test, expect } from '@playwright/test';
import {
  HISTORY_DAYS,
  parseTarget,
  sparkline,
  summarizeHistory,
  targetReached,
  windowStart,
} from '../../src/lib/priceHistory';
import type { ItemPrice } from '../../src/lib/types';

/**
 * Історія ціни й своя ціль (8.16) — правила без браузера й акаунта.
 * Запис точок і сповіщення — на боці сервісу (services/parser/tests),
 * доступ до таблиці — pgTAP (34_price_history.test.sql).
 */

const TODAY = '2026-12-03';

function point(day: string, price: number | string, currency: string | null = 'PLN'): ItemPrice {
  return { item_id: 'i1', day, price, currency, source: 'check', checked_at: `${day}T03:15:00Z` };
}

test.describe('історія ціни: 30 днів', () => {
  test('вікно — сьогодні й ще 29 днів назад', () => {
    expect(HISTORY_DAYS).toBe(30);
    expect(windowStart(TODAY)).toBe('2026-11-04');
    expect(windowStart('2026-03-01')).toBe('2026-01-31');
  });

  test('найнижча й остання — з датою; старіші за вікно не враховуються', () => {
    const s = summarizeHistory(
      [point('2026-11-03', 100), point('2026-11-20', '1290.00'), point('2026-12-03', 1390), point('2026-11-10', 1500)],
      'PLN',
      TODAY,
    );
    expect(s.points.map((p) => p.day)).toEqual(['2026-11-10', '2026-11-20', '2026-12-03']);
    expect(s.current).toEqual({ day: '2026-12-03', minor: 139000, checkedAt: '2026-12-03T03:15:00Z' });
    expect(s.min?.day).toBe('2026-11-20');
    expect(s.min?.minor).toBe(129000);
    expect(s.max?.minor).toBe(150000);
  });

  test('однакова найнижча — найсвіжіша: «це й найнижча» про сьогодні', () => {
    const s = summarizeHistory([point('2026-11-20', 100), point('2026-12-03', 100)], 'PLN', TODAY);
    expect(s.min).toBe(s.current);
  });

  test('інша валюта не змішується, а лише називається (ADR-051)', () => {
    const s = summarizeHistory(
      [point('2026-12-01', 25, 'EUR'), point('2026-12-02', 120, 'PLN'), point('2026-12-03', 30, 'USD'), point('2026-12-03', 110, null)],
      'PLN',
      TODAY,
    );
    expect(s.points.map((p) => p.minor)).toEqual([12000, 11000]);
    expect(s.others).toEqual(['EUR', 'USD']);
  });

  test('без точок — порожньо', () => {
    const s = summarizeHistory([], 'PLN', TODAY);
    expect(s).toEqual({ points: [], current: null, min: null, max: null, others: [] });
    expect(sparkline([], TODAY, 240, 48)).toBe('');
  });

  test('графік: дорожче — вище, перший день вікна ліворуч, сьогодні праворуч', () => {
    const s = summarizeHistory([point('2026-11-04', 200), point('2026-12-03', 100)], 'PLN', TODAY);
    expect(sparkline(s.points, TODAY, 240, 48)).toBe('2,2 238,46');
    const flat = summarizeHistory([point('2026-12-03', 100)], 'PLN', TODAY);
    expect(sparkline(flat.points, TODAY, 240, 48)).toBe('238,24');
  });
});

test.describe('ціль: поле й мітка', () => {
  test('поле — як у бази: порожньо без цілі, нуль і сміття — помилка, межа numeric(12,2)', () => {
    expect(parseTarget('')).toEqual({ value: null, error: null });
    expect(parseTarget('999,50')).toEqual({ value: 999.5, error: null });
    expect(parseTarget('1 000')).toEqual({ value: 1000, error: null });
    expect(parseTarget('0')).toEqual({ value: null, error: 'zero' });
    expect(parseTarget('0,00')).toEqual({ value: null, error: 'zero' });
    expect(parseTarget('-5').error).toBe('format');
    expect(parseTarget('abc').error).toBe('format');
    expect(parseTarget('10000000000').error).toBe('tooBig');
    expect(parseTarget('9999999999,99')).toEqual({ value: 9999999999.99, error: null });
  });

  const base = {
    status: 'active' as const,
    link_status: 'ok' as const,
    link_price: '990.00',
    link_currency: 'PLN',
    price_target: '1000.00',
    currency: null,
  };

  test('досягнуто — ціна в магазині не вища за ціль, «≤» включно', () => {
    expect(targetReached(base, 'PLN')).toBe(true);
    expect(targetReached({ ...base, link_price: 1000 }, 'PLN')).toBe(true);
    expect(targetReached({ ...base, link_price: '1000.01' }, 'PLN')).toBe(false);
  });

  test('не досягнуто без цілі, без ціни, не в наявності, не в актуальних чи в іншій валюті', () => {
    expect(targetReached({ ...base, price_target: null }, 'PLN')).toBe(false);
    expect(targetReached({ ...base, link_price: null }, 'PLN')).toBe(false);
    expect(targetReached({ ...base, link_status: 'out' }, 'PLN')).toBe(false);
    expect(targetReached({ ...base, status: 'gifted' }, 'PLN')).toBe(false);
    expect(targetReached({ ...base, link_currency: 'EUR' }, 'PLN')).toBe(false);
    expect(targetReached({ ...base, currency: 'EUR', link_currency: 'EUR' }, 'PLN')).toBe(true);
    expect(targetReached({ ...base, link_currency: null }, 'PLN')).toBe(true);
  });
});
