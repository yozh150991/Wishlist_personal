import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  // Прогріває локальний dev-сервер перед тестами (див. файл).
  globalSetup: './tests/global-setup.ts',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:5173',
    trace: 'on-first-retry',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile',   use: { ...devices['Pixel 7'] } },
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
