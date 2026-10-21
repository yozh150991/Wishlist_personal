import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL ?? 'http://localhost:5173';

export default defineConfig({
  testDir: './tests/e2e',
  // Прогріває локальний dev-сервер перед тестами (див. файл).
  globalSetup: './tests/global-setup.ts',
  fullyParallel: true,
  // Сценарій власника з кількома позиціями законно йде 20–30 с: після кожного
  // додавання «+» шість секунд поступається місцем тосту «Відмінити».
  timeout: 60_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  // У CI: анотації біля коду в GitHub плюс звичайний список у лозі задачі.
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [
    // Дві розкладки одного дизайну (ADR-065): десктопна й телефонна.
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
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
