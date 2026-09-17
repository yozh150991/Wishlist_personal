import { chromium } from '@playwright/test';
import type { FullConfig } from '@playwright/test';

/**
 * Прогрів dev-сервера перед тестами.
 *
 * Playwright вважає сервер готовим, щойно той віддає index.html. Але при першому
 * відкритті сторінки Vite ще збирає залежності (react, supabase-js тощо) і може
 * один раз перезавантажити сторінку, коли закінчить. На Windows це буває довше
 * 30 секунд. Тести, що стартують першими, паралельно впираються в цю збірку
 * і падають на page.goto з тайм-аутом або ERR_ABORTED, а решта проходять.
 *
 * Тут одна сторінка відкривається й чекає на форму входу з великим запасом часу.
 * Після цього тести отримують уже зібраний і стабільний сервер.
 *
 * Лише для локального сервера: бойовий фронтенд (E2E_BASE_URL) не прогріваємо.
 */
const READY = 'input[autocomplete="current-password"]';

export default async function globalSetup(config: FullConfig) {
  const project = config.projects[0];
  const baseURL = project?.use.baseURL;
  if (!baseURL || !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/.test(baseURL)) return;

  const started = Date.now();
  const browser = await chromium.launch(project.use.launchOptions);
  try {
    const page = await browser.newPage();
    await page.goto(`${baseURL}/login`, { timeout: 180_000 });
    await page.locator(READY).waitFor({ timeout: 180_000 });

    // Якщо Vite саме дозбирав залежності, він перезавантажить сторінку.
    // Чекаємо, поки мережа затихне, і перевіряємо форму ще раз уже після цього.
    await page.waitForLoadState('networkidle', { timeout: 60_000 }).catch(() => {});
    await page.locator(READY).waitFor({ timeout: 60_000 });
  } finally {
    await browser.close();
  }
  console.log(`[warm-up] dev-сервер готовий за ${Math.round((Date.now() - started) / 1000)} с`);
}
