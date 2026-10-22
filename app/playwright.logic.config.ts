import { defineConfig } from '@playwright/test';

// These suites exercise pure production functions: no browser, Vite, credentials
// or database. Keep the regular desktop/mobile E2E configuration unchanged.
export default defineConfig({
  testDir: './tests/e2e',
  testMatch: /(?:after-event|date-text|items-view|notify-rules|outbox|qa-techniques|qa-data-integrity|safe-next|thresholds|transfer)\.spec\.ts$/,
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 4,
  reporter: [['list'], ['junit', { outputFile: 'test-results/logic.xml' }]],
});
