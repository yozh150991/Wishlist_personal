import { test, expect } from '@playwright/test';
import { priceThresholds } from '../../src/lib/format';

/**
 * Поріг ціни «до …» для гостя (ADR-036) генерується з даних — терцилі,
 * округлені вгору до круглого числа. Без браузера.
 */
test('терцилі цін стають круглими порогами', () => {
  expect(priceThresholds([120, 199, 250, 420, 480, 890, 1190, 2400, 2800])).toEqual([500, 1500]);
});

test('на дорогому списку пороги дорогі, а не «до 500»', () => {
  const prices = [2100, 3400, 5200, 7800, 9900, 12500, 15800, 19900, 20000];
  const [low] = priceThresholds(prices);
  expect(low).toBe(8000);
  // Верхній терциль 15 800 округлюється до 20 000 — під нього підпадає все, тож його немає.
  expect(priceThresholds(prices)).toHaveLength(1);
});

test('замало цін — порогів немає', () => {
  expect(priceThresholds([100, 200, 300])).toEqual([]);
});

test('поріг, під який підпадає все, не пропонується', () => {
  expect(priceThresholds([100, 100, 100, 100, 100, 100])).toEqual([]);
});
