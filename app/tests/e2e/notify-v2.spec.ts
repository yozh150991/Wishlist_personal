import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { EMAIL, PASSWORD, hasAccount, unique } from './helpers';

/**
 * Сповіщення власника у v2 (потік P, ADR-049).
 *
 * Налаштування одні на акаунт, тож тест іде лише в одному проєкті: два
 * паралельні прогони перемикали б їх навзаєм. Збірка тестів — без
 * `VITE_VAPID_PUBLIC_KEY`, тобто push вимкнений цілком і лишається пошта:
 * саме цю гілку й видно. Сам push перевіряється на сервісі
 * (services/parser/tests/test_notify.py) і вручну на телефоні (TESTING.md).
 *
 * Наприкінці сповіщення вимикаються — інакше сервіс слав би листи тестовому
 * акаунту.
 */

async function signInV2(page: Page) {
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(EMAIL!);
  await page.locator('input[name="password"]').fill(PASSWORD!);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/lists$/);
}

const card = (page: Page) => page.locator('#notifications');
const enableButton = (scope: ReturnType<Page['locator']>) =>
  scope.getByRole('button', { name: /^(увімкнути сповіщення|włącz powiadomienia|turn on notifications)$/i });
const allOffButton = (page: Page) =>
  card(page).getByRole('button', { name: /^(вимкнути всі сповіщення|wyłącz wszystkie powiadomienia|turn off all notifications)$/i });

/** Сповіщення вимкнені — з будь-якого стану, який лишив попередній прогін. */
async function ensureOff(page: Page) {
  await page.goto('/settings#notifications');
  await expect(card(page).getByRole('heading', { name: /сповіщення|powiadomienia|notifications/i })).toBeVisible();
  await expect(card(page).getByText(/завантаження|ładowanie|loading/i)).toHaveCount(0);
  if (await allOffButton(page).isVisible()) await allOffButton(page).click();
  await expect(enableButton(card(page))).toBeVisible();
}

async function shareFreshList(page: Page) {
  await page.goto('/lists/new');
  await page.locator('input[name="title"]').fill(unique('V2 notify'));
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/lists\/[0-9a-f-]{36}$/);
  await page.getByRole('button', { name: /^(додати позицію|dodaj pozycję|add item)$/i }).first().click();
  const item = page.getByRole('dialog', { name: /нова позиція|nowa pozycja|new item/i });
  await expect(item.locator('input[name="link"]')).toBeFocused();
  await item.getByRole('button', { name: /вписати вручну|wpisz ręcznie|type it in/i }).click();
  await item.locator('input[name="title"]').fill(unique('Лампа'));
  await item.getByRole('button', { name: /^(додати|dodaj|add)$/i }).click();
  await expect(item).toHaveCount(0);
  await page.getByRole('button', { name: /^(поділитися|udostępnij|share)$/i }).first().click();
  const sheet = page.getByRole('dialog');
  await sheet.getByRole('button', { name: /^(створити посилання|utwórz link|create link)$/i }).click();
  await expect(sheet.getByRole('heading', { name: /посилання готове|link gotowy|link is ready/i })).toBeVisible();
  return sheet;
}

const askHeading = /сказати, коли настане час|powiedzieć, kiedy nadejdzie czas|heads-up when it's time/i;

test.describe('сповіщення v2 з акаунтом', { tag: '@v2' }, () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('запит після посилання, «Не зараз», увімкнення листом і вибір каналів у Налаштуваннях', async ({ page }, info) => {
    test.skip(info.project.name !== 'chromium-v2', 'Налаштування одні на акаунт — лише один проєкт');
    await signInV2(page);
    await ensureOff(page);
    try {
      // Після посилання вже є чого чекати — тоді й питаємо (P1).
      let sheet = await shareFreshList(page);
      await expect(sheet.getByRole('heading', { name: askHeading })).toBeVisible();
      await sheet.getByRole('button', { name: /^(не зараз|nie teraz|not now)$/i }).click();
      await expect(sheet.getByRole('heading', { name: askHeading })).toHaveCount(0);

      // «Не зараз» на цьому пристрої більше не питає.
      await page.keyboard.press('Escape');
      sheet = await shareFreshList(page);
      await expect(sheet.getByRole('heading', { name: /посилання готове|link gotowy|link is ready/i })).toBeVisible();
      await expect(sheet.getByRole('heading', { name: askHeading })).toHaveCount(0);

      // Інший пристрій (чисте сховище): «Увімкнути» — push тут немає, тож листом.
      await page.evaluate(() => localStorage.removeItem('wl.v2.notifyAsked'));
      await page.keyboard.press('Escape');
      sheet = await shareFreshList(page);
      await enableButton(sheet).click();
      await expect(sheet.getByText(new RegExp(`${EMAIL!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`))).toBeVisible();
      await sheet.getByRole('link', { name: /налаштувати сповіщення|ustawienia powiadomień|notification settings/i }).click();

      // Налаштування: пошта для важливого увімкнена, ціна — ні.
      await expect(page).toHaveURL(/\/settings#notifications$/);
      const email = (kind: RegExp) => card(page).getByRole('switch', { name: kind });
      await expect(email(/^(після свята|po święcie|after the celebration): (пошта|e-mail|email)$/i)).toHaveAttribute('aria-checked', 'true');
      await expect(email(/^(товар недоступний|produkt niedostępny|product unavailable): (пошта|e-mail|email)$/i)).toHaveAttribute('aria-checked', 'true');
      const price = email(/^(ціна змінилась|cena się zmieniła|price changed): (пошта|e-mail|email)$/i);
      await expect(price).toHaveAttribute('aria-checked', 'false');
      // Push-каналу без ключа VAPID немає зовсім — не вдаємо, що він є.
      await expect(card(page).getByRole('switch', { name: /: push$/i })).toHaveCount(0);
      // Про позначки гостей — пояснення, а не перемикач (ADR-040).
      await expect(card(page).getByText(/що взяли гості|co wzięli goście|what guests took/i)).toBeVisible();

      const saved = page.waitForResponse((r) => r.url().includes('/rest/v1/notification_settings') && r.request().method() === 'POST');
      await price.click();
      await saved;
      await page.reload();
      await expect(email(/^(ціна змінилась|cena się zmieniła|price changed): (пошта|e-mail|email)$/i)).toHaveAttribute(
        'aria-checked',
        'true',
      );
    } finally {
      await ensureOff(page);
    }
  });
});
