import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { EMAIL, PASSWORD, hasAccount, unique } from './helpers';

/**
 * Каркас власника, «Мої списки», «Мої посилання» й «Налаштування» дизайну v2
 * (ROADMAP, «Дизайн v2», кроки 3а і 3в).
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

  test('навігація: «Посилання» і «Налаштування» — екрани v2, пункт підсвічено', async ({ page }) => {
    await signInV2(page);
    const nav = page.getByRole('navigation');
    await nav.getByRole('link', { name: /посилання|linki|links/i }).click();
    await expect(page).toHaveURL(/\/shares$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/мої посилання|moje linki|my links/i);
    await expect(nav.getByRole('link', { name: /посилання|linki|links/i })).toHaveAttribute('aria-current', 'page');

    await nav.getByRole('link', { name: /налаштування|ustawienia|settings/i }).click();
    await expect(page).toHaveURL(/\/settings$/);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(/налаштування|ustawienia|settings/i);
    await expect(page.locator('html')).toHaveAttribute('data-design', 'v2');
  });
});

test.describe('«Мої посилання» й «Налаштування» v2 з акаунтом', { tag: '@v2' }, () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('посилання, створене зі списку, є в «Моїх посиланнях»; відкликане переходить у «Уже не діють»; видалене зникає', async ({
    page,
  }) => {
    await signInV2(page);
    const listTitle = unique('V2 links');
    await page.goto('/lists/new');
    await page.locator('input[name="title"]').fill(listTitle);
    await page.locator('button[type="submit"]').click();
    await expect(page).toHaveURL(/\/lists\/[0-9a-f-]{36}$/);

    // Одна позиція вручну — ділитися порожнім списком не можна.
    await page.getByRole('button', { name: /^(додати позицію|dodaj pozycję|add item)$/i }).first().click();
    const sheet = page.getByRole('dialog');
    await sheet.getByRole('button', { name: /вписати вручну|wpisz ręcznie|type it in/i }).click();
    await sheet.locator('input[name="title"]').fill(unique('Річ'));
    await sheet.getByRole('button', { name: /^(додати|dodaj|add)$/i }).click();
    await expect(sheet).toHaveCount(0);

    const linkTitle = unique('Для друзів');
    await page.getByRole('button', { name: /^(поділитися|udostępnij|share)$/i }).first().click();
    const share = page.getByRole('dialog');
    await share.locator('input[name="share_title"]').fill(linkTitle);
    await share.getByRole('button', { name: /^(створити посилання|utwórz link|create link)$/i }).click();
    await expect(share.getByRole('heading', { name: /посилання готове|link gotowy|link is ready/i })).toBeVisible();
    await share.getByRole('button', { name: /^(готово|gotowe|done)$/i }).first().click();

    await page.goto('/shares');
    const live = page.getByRole('region', { name: /діють|aktywne|active/i }).first();
    const card = page.getByRole('listitem').filter({ hasText: linkTitle });
    await expect(live.getByRole('listitem').filter({ hasText: linkTitle })).toBeVisible();
    await expect(card).toContainText(listTitle);
    // Перегляди — не позначки: число є, а слова про позначки немає.
    await expect(card).toContainText(/перегляд|wyświetle|view/i);

    await card.getByRole('button', { name: /^(відкликати|cofnij|revoke)$/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /^(відкликати|cofnij|revoke)$/i }).click();
    await expect(card).toContainText(/відкликано|cofnięty|odwołany|revoked/i);
    await expect(card.getByRole('button', { name: /копіювати|kopiuj|copy/i })).toHaveCount(0);

    await card.getByRole('button', { name: /видалити посилання|usuń link|delete the link/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /^(видалити|usuń|delete)$/i }).click();
    await expect(card).toHaveCount(0);
  });

  test('налаштування застосовуються одразу: тема, висока контрастність, мова; «Мої дані» — файл без адрес посилань', async ({
    page,
  }) => {
    await signInV2(page);
    await page.goto('/settings');
    const html = page.locator('html');
    const scheme = await html.getAttribute('data-scheme');
    const theme = await html.getAttribute('data-theme');
    const lang = (await html.getAttribute('lang')) ?? 'uk';

    await page.getByRole('radio', { name: /^(темна|ciemny|ciemna|dark)$/i }).click();
    await expect(html).toHaveAttribute('data-theme', 'dark');

    const contrast = page.getByRole('switch', { name: /висока контрастність|wysoki kontrast|high contrast/i });
    await contrast.click();
    await expect(html).toHaveAttribute('data-scheme', 'vuhil');
    await contrast.click();
    await expect(html).toHaveAttribute('data-scheme', scheme!);

    await page.getByRole('radio', { name: 'English' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Settings');
    await page.getByRole('radio', { name: 'Українська' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Налаштування');

    const downloading = page.waitForEvent('download');
    await page.getByRole('button', { name: /завантажити мої дані|pobierz moje dane|download my data/i }).click();
    const file = await downloading;
    expect(file.suggestedFilename()).toMatch(/^wishlist-\d{4}-\d{2}-\d{2}\.json$/);
    const path = await file.path();
    const { readFile } = await import('node:fs/promises');
    const text = await readFile(path!, 'utf8');
    expect(JSON.parse(text).format).toBe('wishlist-personal-account');
    expect(text).not.toMatch(/"token"/);

    // Тему й мову повертаємо, як були: акаунт тестовий, але вигляд і мова їдуть у профіль.
    const back = theme === 'dark' ? /^(темна|dark)$/i : /^(як у системі|jak w systemie|match system)$/i;
    await page.getByRole('radio', { name: back }).click();
    const language: Record<string, string> = { uk: 'Українська', pl: 'Polski', en: 'English' };
    await page.getByRole('radio', { name: language[lang] ?? 'Українська' }).click();
  });
});
