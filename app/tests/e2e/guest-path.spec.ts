import { test, expect } from '@playwright/test';
import { isGuestPath } from '../../src/lib/guestPath';

// Чиста функція: без сторінки й браузера (як решта `test:logic`).
test.describe('isGuestPath', () => {
  for (const path of ['/l/abc', '/l/abc/g/key', '/l/abc/u/mail', '/s/abc', '/s/abc/g/key']) {
    test(`гостьова: ${path}`, () => expect(isGuestPath(path)).toBe(true));
  }
  for (const path of ['/', '/login', '/lists', '/lists/l/x', '/settings', '/shares', '/l', '/s', '/privacy', '/add']) {
    test(`застосунок: ${path}`, () => expect(isGuestPath(path)).toBe(false));
  }
});
