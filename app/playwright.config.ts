import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

/**
 * Версія дизайну — друга вісь проєктів поряд із розкладкою (ADR-039, п. 11).
 *
 * v1-проєкти (`chromium`, `mobile`) нічого не кладуть у сховище, тобто стоять
 * на усталеній v1. v2-проєкти кладуть `wl.design = v2` — так, як його лишає
 * перемикач у Налаштуваннях. Які тести де йдуть, вирішують теги:
 *
 *   без тегу — екрани v1: лише v1-проєкти;
 *   `@v2`    — екрани v2: лише v2-проєкти;
 *   `@both`  — те, що мусить однаково працювати за будь-якого вибору
 *              (гостьова адреса, аварійний вихід): усі чотири.
 */
const V2_STORAGE = {
  cookies: [],
  origins: [{ origin: new URL(baseURL).origin, localStorage: [{ name: 'wl.design', value: 'v2' }] }],
};
const IN_V1 = { grepInvert: /@v2\b/ };
const IN_V2 = { grep: /@v2\b|@both\b/ };

export default defineConfig({
  testDir: './tests/e2e',
  // Прогріває локальний dev-сервер перед тестами (див. файл).
  globalSetup: './tests/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // У CI: анотації біля коду в GitHub плюс звичайний список у лозі задачі.
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium',    use: { ...devices['Desktop Chrome'] }, ...IN_V1 },
    { name: 'mobile',      use: { ...devices['Pixel 7'] }, ...IN_V1 },
    { name: 'chromium-v2', use: { ...devices['Desktop Chrome'], storageState: V2_STORAGE }, ...IN_V2 },
    { name: 'mobile-v2',   use: { ...devices['Pixel 7'], storageState: V2_STORAGE }, ...IN_V2 },
  ],
  webServer: {
    // E2E_LOCALDB=1 — фронтенд проти локальної бази з сідом, а не бойової (TESTING.md).
    command: process.env.E2E_LOCALDB ? 'npm run dev:local' : 'npm run dev',
    url: 'http://localhost:5173',
    reuseExistingServer: !process.env.CI,
    // Вивід Vite у консоль тестів з префіксом [WebServer]. Без цього, коли сторінки
    // не завантажуються, не видно, чи сервер перебудовує залежності, перезапускається
    // чи падає.
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
