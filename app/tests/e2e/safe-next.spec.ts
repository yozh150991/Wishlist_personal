import { test, expect } from '@playwright/test';
import { safeNext } from '../../src/lib/safeNext';

// Pure function test: no page, no browser. It runs under Playwright only so
// the project does not need a second test runner.

test.describe('safeNext', () => {
  const internal: Array<[string, string]> = [
    ['/lists', '/lists'],
    ['/lists/abc', '/lists/abc'],
    ['/lists/abc?sort=price#top', '/lists/abc?sort=price#top'],
    ['/settings', '/settings'],
  ];

  for (const [input, expected] of internal) {
    test(`keeps internal path ${input}`, () => {
      expect(safeNext(input)).toBe(expected);
    });
  }

  const external = [
    'https://google.com',
    'http://google.com',
    '//google.com',
    '/\\google.com',
    '\\\\google.com',
    '/\t/google.com',
    '/\n/google.com',
    'javascript:alert(1)',
    'lists',
    '',
  ];

  for (const input of external) {
    test(`rejects ${JSON.stringify(input)}`, () => {
      expect(safeNext(input)).toBe('/lists');
    });
  }

  test('missing parameter falls back', () => {
    expect(safeNext(null)).toBe('/lists');
  });

  test('custom fallback is respected', () => {
    expect(safeNext('//google.com', '/settings')).toBe('/settings');
  });
});
