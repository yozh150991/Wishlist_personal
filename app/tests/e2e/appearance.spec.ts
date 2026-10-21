import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { addItem, createList, escapeRegExp, hasAccount, listMenu, shareLink, signIn, unique } from './helpers';

/**
 * Вигляд: п'ять схем смаку, висока контрастність і правило вирішення
 * (lib/appearance.ts, ADR-033).
 *
 * Перевіряється не колір, а атрибути на <html>: саме за них чіпляються
 * дванадцять наборів токенів, а контраст кожного набору стереже
 * `npm run check:contrast`.
 */

const html = (page: Page) => page.locator('html');

test('системне prefers-contrast: more вмикає Вугіль ще до рендера', async ({ page }) => {
  await page.emulateMedia({ contrast: 'more' });
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await expect(html(page)).toHaveAttribute('data-scheme', 'vuhil');
});

test('старе «Вугіль» у сховищі стає тумблером контрасту, а смак — усталеним', async ({ page }) => {
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => {
    localStorage.setItem('wl.scheme', 'vuhil');
    localStorage.removeItem('wl.contrast');
  });
  await page.reload();
  await expect(html(page)).toHaveAttribute('data-scheme', 'vuhil');
  await expect
    .poll(() => page.evaluate(() => [localStorage.getItem('wl.scheme'), localStorage.getItem('wl.contrast')]))
    .toEqual(['sage', '1']);
  await page.evaluate(() => localStorage.setItem('wl.contrast', '0'));
});

test.describe('з акаунтом', () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('коли контраст просить система, тумблер увімкнений і пояснює чому', async ({ page }) => {
    await page.emulateMedia({ contrast: 'more' });
    await signIn(page);
    await page.goto('/settings');
    const contrast = page.getByRole('switch', { name: /висока контрастність|wysoki kontrast|high contrast/i });
    await expect(contrast).toHaveAttribute('aria-checked', 'true');
    await expect(contrast).toHaveAttribute('aria-disabled', 'true');
    await expect(html(page)).toHaveAttribute('data-scheme', 'vuhil');
  });
});

/**
 * Оформлення списку (ADR-034): другий шар, що належить власникові. На свої
 * екрани власника не лягає; гість бачить його поверх схеми власника; висока
 * контрастність глядача вимикає його зовсім.
 */
test.describe('оформлення списку', () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  const openStyle = async (page: Page) => {
    await listMenu(page, /^(оформлення списку|wygląd listy|list style)$/i);
    return page.getByRole('dialog', { name: /оформлення списку|wygląd listy|list style/i });
  };

  test('гість бачить оформлення, власник у себе — ні, контраст гостя його вимикає', async ({ page, browser }) => {
    await signIn(page);
    await createList(page, unique('Style'));
    await addItem(page, 'Келихи');

    const sheet = await openStyle(page);
    // Вибір зберігається на сервері, і лише тоді радіо стає вибраним.
    await sheet.getByRole('radio', { name: /весілля|wesele|wedding/i }).click();
    await expect(sheet.getByRole('radio', { name: /весілля|wesele|wedding/i })).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    // Свої екрани — своя схема: оформлення на них не лізе.
    await expect(html(page)).not.toHaveAttribute('data-appearance', /.*/);

    const link = await shareLink(page, ['Келихи'], 'Оля та Богдан');

    const guest = await browser.newContext();
    const guestPage = await guest.newPage();
    await guestPage.goto(link);
    await expect(guestPage.getByRole('heading', { level: 1, name: 'Оля та Богдан' })).toBeVisible();
    await expect(html(guestPage)).toHaveAttribute('data-appearance', '75');
    await expect(html(guestPage)).not.toHaveAttribute('data-scheme', 'vuhil');

    // «Вигляд» у гостя — лише тема й контраст; схеми немає зовсім.
    await guestPage.getByRole('button', { name: /^(вигляд|wygląd|appearance)$/i }).click();
    const look = guestPage.getByRole('dialog');
    await expect(look.getByRole('radio', { name: /шавлія|szałwia|sage/i })).toHaveCount(0);

    // Контраст глядача перемагає будь-яке оформлення.
    await look.getByRole('switch', { name: /висока контрастність|wysoki kontrast|high contrast/i }).click();
    await expect(html(guestPage)).toHaveAttribute('data-scheme', 'vuhil');
    await expect(html(guestPage)).not.toHaveAttribute('data-appearance', /.*/);
    await guest.close();
  });

  test('свій вигляд: назва без емодзі, одразу на списку, превʼю й видалення', async ({ page }) => {
    await signIn(page);
    await createList(page, unique('Own style'));
    await addItem(page, 'Келих для превʼю');

    await openStyle(page);
    // Аркуш той самий, але заголовок тепер «Новий вигляд».
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('button', { name: /новий вигляд|nowy wygląd|new style/i }).click();
    const name = unique('Ювілей').slice(0, 20);
    const field = sheet.locator('input[name="appearance_name"]');
    await field.fill('Свято 🎉');
    await expect(sheet.getByText(/без емодзі|bez emoji|no emoji/i)).toBeVisible();

    await field.fill(name);
    await sheet.getByRole('radio', { name: /285/ }).click();
    await sheet.getByRole('button', { name: /зберегти вигляд|zapisz wygląd|save style/i }).click();
    await expect(sheet.getByRole('radio', { name: new RegExp(escapeRegExp(name)) })).toBeChecked();

    // Превʼю — так список бачать гості, з позицією й без позначок.
    await sheet.getByRole('button', { name: /показати, як бачить гість|pokaż, jak widzi gość|show how guests see it/i }).click();
    const preview = page.getByRole('dialog').filter({ hasText: /так цей список бачать гості|tak tę listę widzą goście|this is how guests see/i });
    await expect(preview.getByText('Келих для превʼю')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(preview).toHaveCount(0);
    await expect(html(page)).not.toHaveAttribute('data-appearance', /.*/);

    // Видалення вигляду повертає список до схеми без оформлення.
    const again = await openStyle(page);
    await again.getByRole('button', { name: new RegExp(`(видалити вигляд|usuń wygląd|delete style).*${escapeRegExp(name)}`, 'i') }).click();
    await page
      .getByRole('dialog')
      .filter({ hasText: /цього не можна скасувати|nie da się cofnąć|can't be undone/i })
      .getByRole('button', { name: /^(видалити вигляд|usuń wygląd|delete style)$/i })
      .click();
    await expect(again.getByRole('radio', { name: /без оформлення|bez wyglądu|no style/i })).toBeChecked();
  });
});

/**
 * Ці тести міняють профіль спільного тестового акаунта. Профіль один на всі
 * паралельні прогони, тож вони йдуть послідовно й лише в одній розкладці:
 * інакше друга розкладка відновлювала б Шавлію посеред перевірки першої.
 */
test.describe('з акаунтом, профіль', () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');
  test.describe.configure({ mode: 'serial' });
  test.beforeEach(({}, info) => {
    test.skip(info.project.name !== 'chromium', 'Профіль спільний — перевіряється в одній розкладці');
  });

  test('пʼять схем смаку, Вугіль — лише з тумблера, вимкнення повертає свій смак', async ({ page }) => {
    await signIn(page);
    await page.goto('/settings');
    const colors = page.getByRole('group', { name: /кольори|kolory|colors/i });

    await expect(colors.getByRole('radio')).toHaveCount(5);
    await expect(colors.getByRole('radio', { name: /вугіль|węgiel|charcoal/i })).toHaveCount(0);

    const contrast = page.getByRole('switch', { name: /висока контрастність|wysoki kontrast|high contrast/i });
    try {
      await colors.getByRole('radio', { name: /полотно|płótno|canvas/i }).click();
      await expect(html(page)).toHaveAttribute('data-scheme', 'polotno');

      await contrast.click();
      await expect(contrast).toHaveAttribute('aria-checked', 'true');
      await expect(html(page)).toHaveAttribute('data-scheme', 'vuhil');

      // Вибір переживає перезавантаження: він у профілі, а не лише в браузері.
      await page.reload();
      await expect(html(page)).toHaveAttribute('data-scheme', 'vuhil');

      // Тумблер не перезаписує смак: вимкнув — повернувся до Полотна.
      await contrast.click();
      await expect(html(page)).toHaveAttribute('data-scheme', 'polotno');
    } finally {
      if ((await contrast.getAttribute('aria-checked')) === 'true') await contrast.click();
      await colors.getByRole('radio', { name: /шавлія|szałwia|sage/i }).click();
      await expect(html(page)).toHaveAttribute('data-scheme', 'sage');
    }
  });

  test('Ніч — темна за замовчуванням, але ручний вибір теми її перекриває', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' });
    await signIn(page);
    await page.goto('/settings');
    const colors = page.getByRole('group', { name: /кольори|kolory|colors/i });
    const themes = page.getByRole('group', { name: /^тема$|^motyw$|^theme$/i });
    try {
      await themes.getByRole('radio', { name: /як у системі|jak w systemie|match system/i }).click();
      await colors.getByRole('radio', { name: /ніч|noc|night/i }).click();
      await expect(html(page)).toHaveAttribute('data-scheme', 'nich');
      await expect(html(page)).toHaveAttribute('data-theme', 'dark');

      await themes.getByRole('radio', { name: /світла|jasny|light/i }).click();
      await expect(html(page)).toHaveAttribute('data-theme', 'light');
      await expect(html(page)).toHaveAttribute('data-scheme', 'nich');
    } finally {
      await colors.getByRole('radio', { name: /шавлія|szałwia|sage/i }).click();
      await themes.getByRole('radio', { name: /як у системі|jak w systemie|match system/i }).click();
    }
  });
});
