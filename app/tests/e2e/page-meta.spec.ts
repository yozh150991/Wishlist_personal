import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createList, hasAccount, signIn, unique } from './helpers';

/**
 * Мова сторінки й заголовки вкладок (аудит 15.11.2026, A-6 і A-7).
 *
 * A-6: `<html lang>` дорівнює активній мові — і коли її визначено з мови
 * браузера, і після ручного вибору, і на гостьовій. Інакше зчитувач екрана
 * читає польський інтерфейс українським голосом.
 *
 * A-7: кожен екран називає вкладку «<Назва екрана> · Wishlist» своєю мовою,
 * і заголовок не «залипає» після переходу.
 *
 * Гостьова — окремо: у заголовку вкладки немає ні назви списку, ні токена, ні
 * ключа гостя (CLAUDE.md §3.5; заголовок осідає в історії браузера), а мертве
 * посилання зветься однаково, хоч яка в нього причина (§3.3).
 *
 * Акаунт потрібен лише останньому блоку: решта працює на підставлених
 * відповідях і тоді, коли бази не видно.
 */

const TOKEN = 'e2e-meta-token-AAAAAAAAAAAA';
/** Будь-який рядок форми ключа (lib/guest.ts): 22–64 символи base64url. */
const KEY = 'e2eMetaGuestKeyAAAAAAAAA';
const MAIL_TOKEN = 'e2eMetaMailTokenAAAAAAAA';
const LIST_NAME = 'Секретне новосілля e2e';

const lang = (page: Page) => page.locator('html');
const langSelect = (page: Page) => page.locator('select.v2-lang__select');

/** Живий список за посиланням: відповідь бази підставлено. */
async function stubGuestList(page: Page) {
  // Решта гостьових RPC (перегляд, відписка) — тиха відповідь без мережі.
  await page.route('**/rest/v1/rpc/**', (route) => route.fulfill({ status: 204, body: '' }));
  await page.route('**/rpc/get_guest_list', (route) =>
    route.fulfill({
      json: {
        title: LIST_NAME, message: null, currency: 'PLN', event_date: null,
        expires_at: null, expires_tz: null, owner_scheme: null, appearance_hue: null,
        hide_prices: false, allow_reservations: true, archived: false, viewer_is_owner: false,
        guest: null, sections: [],
        items: [
          {
            id: 'e2e-meta-1', title: 'Ваза', url: null, price: 120, currency: 'PLN', quantity: 1,
            priority: 'medium', note: null, variants: [], image_url: null, status: 'active',
            created_at: '2026-10-01T10:00:00Z', section_id: null, taken_qty: 0, mine_qty: 0,
          },
        ],
      },
    }),
  );
}

/** Мертве посилання: саме так відповідає база на всі три причини (ADR-035). */
async function stubDeadLink(page: Page) {
  await page.route('**/rest/v1/rpc/**', (route) => route.fulfill({ status: 204, body: '' }));
  await page.route('**/rpc/get_guest_list', (route) =>
    route.fulfill({
      status: 400,
      json: { code: 'P0001', message: 'not_found', details: null, hint: null },
    }),
  );
}

test.describe('мова сторінки: <html lang> — це активна мова', () => {
  test.describe('браузер польською', () => {
    test.use({ locale: 'pl-PL' });

    test('автовизначення дає lang="pl"', async ({ page }) => {
      await page.goto('/login');
      await expect(page.getByRole('button', { name: /^zaloguj się$/i })).toBeVisible();
      await expect(lang(page)).toHaveAttribute('lang', 'pl');
    });

    test('ручний вибір міняє lang одразу й переживає перезавантаження', async ({ page }) => {
      await page.goto('/login');
      await expect(lang(page)).toHaveAttribute('lang', 'pl');
      await langSelect(page).selectOption('en');
      await expect(lang(page)).toHaveAttribute('lang', 'en');
      await expect(page).toHaveTitle('Sign in · Wishlist');

      await page.reload();
      await expect(page.getByRole('button', { name: /^sign in$/i })).toBeVisible();
      await expect(lang(page)).toHaveAttribute('lang', 'en');

      await langSelect(page).selectOption('uk');
      await expect(lang(page)).toHaveAttribute('lang', 'uk');
      await expect(page).toHaveTitle('Вхід · Wishlist');
    });
  });

  test.describe('браузер англійською', () => {
    test.use({ locale: 'en-US' });

    test('автовизначення дає lang="en"', async ({ page }) => {
      await page.goto('/login');
      await expect(page.getByRole('button', { name: /^sign in$/i })).toBeVisible();
      await expect(lang(page)).toHaveAttribute('lang', 'en');
    });

    test('гостьова: lang за мовою браузера, а перемикач у підвалі міняє і його, і заголовок', async ({ page }) => {
      await stubGuestList(page);
      await page.goto(`/l/${TOKEN}`);
      await expect(page.getByRole('heading', { level: 1, name: LIST_NAME })).toBeVisible();
      await expect(lang(page)).toHaveAttribute('lang', 'en');
      await expect(page).toHaveTitle('Wish list · Wishlist');

      await langSelect(page).selectOption('pl');
      await expect(lang(page)).toHaveAttribute('lang', 'pl');
      await expect(page).toHaveTitle('Lista życzeń · Wishlist');
    });
  });

  test.describe('браузер мовою, якої в застосунку немає', () => {
    test.use({ locale: 'de-DE' });

    test('запасна українська — і в інтерфейсі, і в lang', async ({ page }) => {
      await page.goto('/login');
      await expect(page.getByRole('button', { name: /^увійти$/i })).toBeVisible();
      await expect(lang(page)).toHaveAttribute('lang', 'uk');
    });
  });

  test.describe('збережений вибір сильніший за мову браузера', () => {
    test.use({ locale: 'en-US' });

    test('wl.locale = pl дає lang="pl"', async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem('wl.locale', 'pl'));
      await page.goto('/login');
      await expect(lang(page)).toHaveAttribute('lang', 'pl');
      await expect(page).toHaveTitle('Logowanie · Wishlist');
    });
  });
});

test.describe('заголовки вкладок', () => {
  test.use({ locale: 'uk-UA' });

  test('екрани без входу називають себе, і заголовок не залипає після переходу', async ({ page }) => {
    await page.goto('/login');
    await expect(page).toHaveTitle('Вхід · Wishlist');

    await page.getByRole('link', { name: /політика конфіденційності/i }).click();
    await expect(page).toHaveURL(/\/privacy$/);
    await expect(page).toHaveTitle('Політика конфіденційності · Wishlist');

    await page.goBack();
    await expect(page).toHaveURL(/\/login/);
    await expect(page).toHaveTitle('Вхід · Wishlist');

    await page.goto('/register');
    await expect(page).toHaveTitle('Новий акаунт · Wishlist');
    await page.goto('/reset');
    await expect(page).toHaveTitle('Скидання пароля · Wishlist');
  });

  test('невідома адреса — «Такої сторінки немає»', async ({ page }) => {
    await page.goto('/такої-сторінки-немає');
    await expect(page.getByRole('heading', { level: 1, name: /такої сторінки немає/i })).toBeVisible();
    await expect(page).toHaveTitle('Такої сторінки немає · Wishlist');
  });

  test('захищена адреса без сесії веде на вхід, і вкладка зветься «Вхід»', async ({ page }) => {
    await page.goto('/settings');
    await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/);
    await expect(page).toHaveTitle('Вхід · Wishlist');
  });

  test.describe('гостьова', () => {
    // Три адреси одного екрана: спільна, особиста (ключ) і відписка з листа.
    for (const [name, path] of [
      ['спільне посилання', `/l/${TOKEN}`],
      ['особисте посилання з ключем', `/l/${TOKEN}/g/${KEY}`],
      ['відписка з листа', `/l/${TOKEN}/u/${MAIL_TOKEN}`],
    ] as const) {
      test(`${name}: нейтральний заголовок без назви списку, токена й ключа`, async ({ page }) => {
        await stubGuestList(page);
        // Усі заголовки, які вкладка мала за час життя сторінки: секрет не
        // має майнути в заголовку й на мить, поки адреса ще не очищена.
        await page.addInitScript(() => {
          const seen: string[] = [];
          (window as unknown as { __titles: string[] }).__titles = seen;
          const note = () => seen.push(document.title);
          document.addEventListener('DOMContentLoaded', () => {
            note();
            new MutationObserver(note).observe(document.head, { childList: true, subtree: true, characterData: true });
          });
        });

        await page.goto(path);
        // Назва списку — на сторінці, для того гість і прийшов…
        await expect(page.getByRole('heading', { level: 1, name: LIST_NAME })).toBeVisible();
        await expect(page).toHaveURL(new RegExp(`/l/${TOKEN}$`));
        // …але не у вкладці: заголовок осідає в історії браузера.
        await expect(page).toHaveTitle('Список бажань · Wishlist');

        const titles = await page.evaluate(() => (window as unknown as { __titles: string[] }).__titles);
        expect(titles.length).toBeGreaterThan(0);
        for (const title of titles) {
          expect(title).not.toContain(LIST_NAME);
          expect(title).not.toContain(TOKEN);
          expect(title).not.toContain(KEY);
          expect(title).not.toContain(MAIL_TOKEN);
        }
      });
    }

    test('мертве посилання: один заголовок для будь-якого токена, без токена в ньому', async ({ page }) => {
      await stubDeadLink(page);
      const seen: string[] = [];
      for (const token of ['e2e-never-existed-token', 'e2e-revoked-or-expired-token']) {
        await page.goto(`/l/${token}`);
        await expect(page.getByRole('heading', { level: 1, name: /більше не працює/i })).toBeVisible();
        await expect(page).toHaveTitle('Посилання більше не працює · Wishlist');
        const title = await page.title();
        expect(title).not.toContain(token);
        seen.push(title);
      }
      expect(new Set(seen).size).toBe(1);
    });
  });

  test.describe('з акаунтом власника', () => {
    test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

    test('«Мої списки», сторінка списку з його назвою, Налаштування', async ({ page }) => {
      await signIn(page);
      await expect(page).toHaveTitle('Мої списки · Wishlist');

      const title = unique('Заголовок вкладки');
      await createList(page, title);
      await expect(page).toHaveTitle(`${title} · Wishlist`);

      await page.goto('/settings');
      await expect(page.getByRole('heading', { level: 1, name: /^налаштування$/i })).toBeVisible();
      await expect(page).toHaveTitle('Налаштування · Wishlist');

      await page.goto('/shares');
      await expect(page).toHaveTitle('Мої посилання · Wishlist');
      await page.goto('/gifts');
      await expect(page).toHaveTitle('Я дарую · Wishlist');
    });
  });
});
