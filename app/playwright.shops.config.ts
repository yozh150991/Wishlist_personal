import { defineConfig, devices } from '@playwright/test';

/**
 * Кнопка «У вішліст» на живих сторінках магазинів родини (ROADMAP 8.3, ADR-076).
 *
 * Лише вручну, не в CI: `npm run check:shops`. Без застосунку й бази —
 * відкриває кожну адресу з `services/parser/tests/shop-links.txt` у
 * справжньому Chromium і виконує код закладки. Магазини з захистом від ботів
 * часто не пускають безголовий браузер, тож краще з вікном:
 *   PowerShell:  $env:HEADED=1; npm run check:shops
 *   bash:        HEADED=1 npm run check:shops
 * Звіт — `test-results/shops.md`.
 */
export default defineConfig({
  testDir: './tests/live',
  testMatch: /\.live\.ts$/,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: 'list',
  use: {
    ...devices['Desktop Chrome'],
    headless: !process.env.HEADED,
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
  },
});
