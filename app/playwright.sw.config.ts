import { defineConfig, devices } from '@playwright/test';

/**
 * Service Worker у справжній збірці: `npm run test:sw` (TESTING.md, «PWA»).
 *
 * Окрема конфігурація, бо звичайні e2e ходять на dev-сервер, а там Service
 * Worker вимкнено (`devOptions` у `vite.config.ts`). Тут — `vite preview` поверх
 * уже зібраного `dist/`: спершу `npx vite build`. Бази не треба: відповіді
 * Supabase підставляє сам сценарій.
 *
 * SW_PORT — порт сервера (усталено 4173, як у `vite preview`); порт зайнятий —
 * сервер падає, а не сідає поруч. PW_CHANNEL=chrome — узяти встановлений
 * Chrome, якщо Chromium від Playwright не завантажено.
 */
const port = Number(process.env.SW_PORT ?? 4173);
const baseURL = `http://localhost:${port}`;

export default defineConfig({
  testDir: './tests/sw',
  // Кожен тест — свій чистий профіль браузера, тож реєстрації не перетинаються.
  fullyParallel: true,
  timeout: 30_000,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['list']] : 'list',
  use: {
    ...devices['Desktop Chrome'],
    baseURL,
    serviceWorkers: 'allow',
    channel: process.env.PW_CHANNEL || undefined,
  },
  webServer: {
    command: `npx vite preview --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: false,
    stdout: 'pipe',
    stderr: 'pipe',
  },
});
