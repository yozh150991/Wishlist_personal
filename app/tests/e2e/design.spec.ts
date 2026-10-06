import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { hasAccount, signIn } from './helpers';

/**
 * Перемикач версії дизайну (ADR-032).
 *
 * v2 — не інші кольори, а інша таблиця маршрутів: свої екрани й свій порядок
 * кроків. Тому тести перевіряють не вигляд, а те, що ця таблиця справді
 * підмінюється, що з неї є вихід і що вона не зачіпає гостьову сторінку.
 *
 * Поки пакет v2 не приїхав, у її таблиці один екран-заглушка. Перевірки
 * нижче написані так, щоб наповнення v2 їх не зламало: вони питають про
 * версію й про можливість вийти, а не про конкретний вміст екрана.
 *
 * Теги (playwright.config.ts): `@both` іде в усіх чотирьох проєктах — у
 * v1-проєктах сховище каже «v1», у v2-проєктах «v2», тож перевірка «адреса
 * перемагає вибір» проходить в обидва боки. Без тегу — лише v1-проєкти: ці
 * тести починають зі стану «людина обрала v1» (`wl.design = v1` у сховищі).
 */

/**
 * Усталена версія — v2 (ADR-052): чисте сховище відкриває екрани v2 ще до
 * рендера, і React цього не перекидає.
 */
test('без вибору в сховищі — v2', { tag: '@both' }, async ({ browser }) => {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    storageState: { cookies: [], origins: [] },
  });
  const page = await context.newPage();
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-design', 'v2');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('html')).toHaveAttribute('data-design', 'v2');
  expect(await page.evaluate(() => localStorage.getItem('wl.design'))).toBeNull();
  await context.close();
});

/** Кнопка заглушки v2 «Повернутися на v1» — на гостьовій її бути не може. */
const placeholderBack = (page: import('@playwright/test').Page) =>
  page.getByRole('button', { name: /v1/i });

/** Дорога назад із v2 — її власні Налаштування з тим самим перемикачем версії. */
async function backToV1(page: import('@playwright/test').Page) {
  await page.goto('/settings');
  await page.getByTestId('design').getByRole('radio', { name: /v1/i }).click();
}

/**
 * Аварійний вихід не потребує акаунта — і це його суть: він має працювати
 * тоді, коли застосунок не працює.
 */
test('?design= перемикає версію до рендера й не лишається в адресі', { tag: '@both' }, async ({ page }) => {
  await page.goto('/login?design=v2', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-design', 'v2');
  // Параметр знято одразу: інакше він поїхав би далі в скопійованому посиланні.
  await expect(page).toHaveURL(/\/login$/);

  // Решту параметрів зняття не чіпає — на них тримається повернення після входу.
  await page.goto('/login?next=%2Fshares&design=v1', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('html')).toHaveAttribute('data-design', 'v1');
  await expect(page).toHaveURL(/\/login\?next=%2Fshares$/);
});

test.describe('з акаунтом', () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('перемикання в Налаштуваннях міняє таблицю маршрутів і переживає F5', async ({ page }) => {
    await signIn(page);
    await page.goto('/settings');

    const html = page.locator('html');
    await expect(html).toHaveAttribute('data-design', 'v1');

    await page.getByTestId('design').getByRole('radio', { name: /v2/i }).click();

    // Перемикання веде на корінь із перезавантаженням: адреси версій не
    // зобов'язані збігатися, тож лишатися на /settings не можна.
    await expect(html).toHaveAttribute('data-design', 'v2');
    await expect(page).not.toHaveURL(/\/settings$/);

    await page.reload();
    await expect(html).toHaveAttribute('data-design', 'v2');

    // З v2 дорога назад — її власні Налаштування з тим самим перемикачем.
    await backToV1(page);
    await expect(html).toHaveAttribute('data-design', 'v1');
    await page.reload();
    await expect(html).toHaveAttribute('data-design', 'v1');
  });

  test('вибір версії не чіпає тему й схему', async ({ page }) => {
    await signIn(page);
    await page.goto('/settings');

    const html = page.locator('html');
    const scheme = await html.getAttribute('data-scheme');
    const theme = await html.getAttribute('data-theme');

    await page.getByTestId('design').getByRole('radio', { name: /v2/i }).click();
    await expect(html).toHaveAttribute('data-design', 'v2');
    await expect(html).toHaveAttribute('data-scheme', scheme!);
    await expect(html).toHaveAttribute('data-theme', theme!);

    await backToV1(page);
    await expect(html).toHaveAttribute('data-design', 'v1');
  });
});

/**
 * Версію гостьової визначає адреса, а не вибір власника (ADR-039): `/s/…` —
 * гостьова v1, `/l/…` — гостьова v2. Посилання вже роздані рідним, і
 * незакінчений флоу не має відкритися їм через те, що власник щось перемкнув
 * у себе в браузері; а в гостя сховища власника немає взагалі.
 *
 * Акаунт і база не потрібні: мертвий токен дає гостьову сторінку помилки, і
 * вона теж належить гостьовому екрану, а не заглушці v2.
 */
test.describe('гостьова адреса визначає версію', { tag: '@both' }, () => {
  const DEAD = 'e2e-nonexistent-token';
  /** Будь-який рядок форми ключа (lib/guest.ts): 22–64 символи base64url. */
  const KEY = 'e2eGuestKeyAAAAAAAAAAAAA';

  /** Вибір людини в цьому проєкті (сховище кладе кожен проєкт); без нього — усталена v2 (ADR-052). */
  const chosen = (page: Page) => page.evaluate(() => localStorage.getItem('wl.design') ?? 'v2');

  for (const [prefix, version] of [['/s/', 'v1'], ['/l/', 'v2']] as const) {
    test(`${prefix}… — завжди ${version}, і до рендера, і після`, async ({ page }) => {
      const html = page.locator('html');
      await page.goto(`${prefix}${DEAD}`, { waitUntil: 'domcontentloaded' });
      await expect(html).toHaveAttribute('data-design', version);

      // React змонтувався, ThemeProvider поставив атрибути сам — і не затер
      // адресу вибором зі сховища.
      await page.waitForLoadState('networkidle');
      await expect(html).toHaveAttribute('data-design', version);
      await expect(placeholderBack(page)).toHaveCount(0);

      // Звичайна адреса повертає вибір людини.
      const mine = await chosen(page);
      await page.goto('/login', { waitUntil: 'domcontentloaded' });
      await expect(html).toHaveAttribute('data-design', mine);
    });

    test(`${prefix}…/g/… — ключ лягає в браузер і зникає з адреси, префікс лишається`, async ({ page }) => {
      await page.goto(`${prefix}${DEAD}/g/${KEY}`);
      // Особисте посилання не лишається в адресному рядку (ADR-035), а гість —
      // у своїй версії: прибирання не перекидає /l/ на /s/.
      await expect(page).toHaveURL(new RegExp(`${prefix}${DEAD}$`));
      await expect(page.locator('html')).toHaveAttribute('data-design', version);
      // Ключ належить токену, а не префіксу: під іншим префіксом він той самий.
      expect(await page.evaluate((tk) => localStorage.getItem(`wl.gk.${tk}`), DEAD)).toBe(KEY);
    });
  }
});
