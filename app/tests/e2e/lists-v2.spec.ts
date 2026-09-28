import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { EMAIL, PASSWORD, hasAccount, unique } from './helpers';

/**
 * Каркас власника й «Мої списки» дизайну v2 (ROADMAP, «Дизайн v2», крок 3а).
 *
 * Тег `@v2` — лише у v2-проєктах. Захист маршрутів перевіряється без акаунта;
 * решта — з акаунтом, бо головна показує справжні списки.
 */

async function signInV2(page: Page) {
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(EMAIL!);
  await page.locator('input[name="password"]').fill(PASSWORD!);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/lists$/);
}

/** Дата через `n` днів як `YYYY-MM-DD` — для поля дати. */
function inDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

test('екрани власника v2 без сесії ведуть на вхід із next', { tag: '@v2' }, async ({ page }) => {
  await page.goto('/lists');
  await expect(page).toHaveURL(/\/login\?next=%2Flists$/);
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/login\?next=%2Fsettings$/);
});

test.describe('«Мої списки» v2 з акаунтом', { tag: '@v2' }, () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('новий список з датою зʼявляється серед найближчих; дубль назви — попередження, не заборона', async ({ page }) => {
    await signInV2(page);
    const title = unique('V2 list');

    await page.goto('/lists/new');
    await page.locator('input[name="title"]').fill(title);
    await page.locator('input[name="event_date"]').fill(inDays(3));
    await page.locator('button[type="submit"]').click();
    // Новий список відкривається одразу: перша позиція додається всередині (B, C).
    await expect(page).toHaveURL(/\/lists\/[0-9a-f-]{36}$/);
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await page.getByRole('link', { name: /до моїх списків|do moich list|to my lists/i }).first().click();
    await expect(page).toHaveURL(/\/lists$/);

    const soon = page.getByRole('region', { name: /найближчі|najbliższe|upcoming/i });
    const card = soon.getByRole('link', { name: new RegExp(title) });
    await expect(card).toBeVisible();
    // Рядок картки — дата й відносний час, без жодного слова про позначки.
    await expect(card).toContainText(/через 3 дні|za 3 dni|in 3 days/i);

    // Та сама назва ще раз: попередження теракотою, кнопка працює.
    await page.goto('/lists/new');
    await page.locator('input[name="title"]').fill(title);
    await expect(page.getByText(/такий список уже є|taka lista już jest|already have a list/i)).toBeVisible();
    await expect(page.locator('input[name="title"]')).not.toHaveAttribute('aria-invalid', 'true');
  });

  test('«Назад» із вписаною назвою питає «Лишити чернетку?»; збережена чернетка повертається', async ({ page }) => {
    await signInV2(page);
    const title = unique('Draft');

    await page.goto('/lists/new');
    await page.locator('input[name="title"]').fill(title);
    await page.getByRole('button', { name: /^(назад|wstecz|back)$/i }).click();
    const sheet = page.getByRole('dialog', { name: /лишити чернетку|zostawić szkic|keep the draft/i });
    await expect(sheet).toBeVisible();
    await sheet.getByRole('button', { name: /зберегти чернетку|zapisz szkic|save draft/i }).click();
    await expect(page).toHaveURL(/\/lists$/);

    await page.goto('/lists/new');
    await expect(page.locator('input[name="title"]')).toHaveValue(title);

    // «Видалити й вийти» стирає чернетку.
    await page.getByRole('button', { name: /^(назад|wstecz|back)$/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /видалити й вийти|usuń i wyjdź|delete and leave/i }).click();
    await page.goto('/lists/new');
    await expect(page.locator('input[name="title"]')).toHaveValue('');

    // Порожню форму «Назад» закриває мовчки.
    await page.getByRole('button', { name: /^(назад|wstecz|back)$/i }).click();
    await expect(page).toHaveURL(/\/lists$/);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('навігація: «Посилання» — екран «ще в роботі» з дорогою до v1', async ({ page }) => {
    await signInV2(page);
    await page.getByRole('navigation').getByRole('link', { name: /посилання|linki|links/i }).click();
    await expect(page).toHaveURL(/\/shares$/);
    const v1 = page.getByRole('link', { name: /старому вигляді|starym wyglądzie|old look/i });
    await expect(v1).toHaveAttribute('href', /\/shares\?design=v1$/);
    await v1.click();
    await expect(page.locator('html')).toHaveAttribute('data-design', 'v1');
    await expect(page).toHaveURL(/\/shares$/);
  });
});
