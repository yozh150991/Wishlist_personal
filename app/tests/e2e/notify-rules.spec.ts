import { test, expect } from '@playwright/test';
import {
  IMPORTANT_KINDS,
  NOTIFY_KINDS,
  allOff,
  anyOn,
  anyPushOn,
  enabledDefaults,
  flag,
  vapidKeyBytes,
} from '../../src/lib/notifyRules';

/**
 * Правила сповіщень власника (ADR-049) — без браузера й акаунта.
 * Сам вибір подій і тиша 22:00–9:00 — на боці сервісу (services/parser/tests/test_notify.py).
 */

test.describe('сповіщення: вибір за замовчуванням', () => {
  test('push працює — push для всього, крім ціни; листів не вмикаємо', () => {
    const d = enabledDefaults(true);
    for (const k of NOTIFY_KINDS) {
      expect(d[flag(k, 'push')]).toBe(k !== 'price');
      expect(d[flag(k, 'email')]).toBe(false);
    }
  });

  test('push неможливий — пошта для важливого, ціна вимкнена (P, гілка «push заборонено»)', () => {
    const d = enabledDefaults(false);
    for (const k of NOTIFY_KINDS) {
      expect(d[flag(k, 'push')]).toBe(false);
      expect(d[flag(k, 'email')]).toBe(IMPORTANT_KINDS.includes(k));
    }
    expect(IMPORTANT_KINDS).not.toContain('price');
  });

  test('усе вимкнене — те саме, що рядка немає (поведінка v1)', () => {
    expect(anyOn(allOff())).toBe(false);
    expect(anyOn(null)).toBe(false);
    expect(anyOn({ ...allOff(), share_email: true })).toBe(true);
    expect(anyPushOn({ ...allOff(), share_email: true })).toBe(false);
    expect(anyPushOn({ ...allOff(), link_push: true })).toBe(true);
  });

  test('серед подій немає нічого про позначки гостей (ADR-040)', () => {
    expect([...NOTIFY_KINDS].sort()).toEqual(['after_event', 'link', 'price', 'share', 'yearly']);
  });
});

test('ключ VAPID із base64url — 65 байтів нестиснутої точки P-256', () => {
  // Публічний ключ із прикладу web-push: base64url без доповнення.
  const key = 'BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U';
  const bytes = vapidKeyBytes(key);
  expect(bytes.length).toBe(65);
  expect(bytes[0]).toBe(4);
});
