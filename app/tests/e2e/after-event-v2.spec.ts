import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { EMAIL, PASSWORD, hasAccount, unique } from './helpers';

/**
 * «Після події», архів і щорічні свята дизайну v2 (ROADMAP, «Дизайн v2»,
 * кроки 4а і 4в; потоки M, S3, U; ADR-045, ADR-047).
 *
 * Тег `@v2` — лише у v2-проєктах. Правила дат, «Пізніше» й копій перевіряє без
 * браузера after-event.spec.ts; тут — те, що бачить людина, на справжній базі.
 */

async function signInV2(page: Page) {
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(EMAIL!);
  await page.locator('input[name="password"]').fill(PASSWORD!);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/lists$/);
}

/** Дата через `n` днів як `YYYY-MM-DD` — за годинником пристрою, як і в застосунку. */
function inDays(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function newList(page: Page, title: string) {
  await page.goto('/lists/new');
  await page.locator('input[name="title"]').fill(title);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/lists\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
}

const itemSheet = (page: Page) => page.getByRole('dialog', { name: /нова позиція|nowa pozycja|new item/i });
const addButton = (page: Page) => page.getByRole('button', { name: /^(додати позицію|dodaj pozycję|add item)$/i }).first();
const card = (page: Page, title: string) => page.getByRole('listitem').filter({ hasText: title });
const listMenu = (page: Page) => page.getByRole('button', { name: /^(дії зі списком|działania na liście|list actions)$/i });
const afterCard = (page: Page) => page.getByRole('region', { name: /як минуло свято|jak minęło święto|how did it go/i });
const archivedNote = (page: Page) => page.getByText(/список в архіві|lista w archiwum|this list is archived/i);
const shareButton = (page: Page) => page.getByRole('button', { name: /^(поділитися|udostępnij|share)$/i });

async function addManual(page: Page, title: string) {
  await addButton(page).click();
  const sheet = itemSheet(page);
  await expect(sheet.locator('input[name="link"]')).toBeFocused();
  await sheet.getByRole('button', { name: /вписати вручну|wpisz ręcznie|type it in/i }).click();
  await expect(sheet.locator('input[name="title"]')).toBeFocused();
  await sheet.locator('input[name="title"]').fill(title);
  await sheet.getByRole('button', { name: /^(додати|dodaj|add)$/i }).click();
  await expect(sheet).toHaveCount(0);
  await expect(card(page, title)).toBeVisible();
}

/** Дата події — через «Налаштування списку»: так список стає минулим без чекання. */
async function setEventDate(page: Page, date: string) {
  await listMenu(page).click();
  await page.getByRole('dialog').getByRole('button', { name: /налаштування списку|ustawienia listy|list settings/i }).click();
  const dialog = page.getByRole('dialog', { name: /налаштування списку|ustawienia listy|list settings/i });
  await dialog.locator('input[name="list_date"]').fill(date);
  await dialog.getByRole('button', { name: /^(зберегти|zapisz|save)$/i }).click();
  await expect(dialog).toHaveCount(0);
}

test.describe('після свята й архів v2', { tag: '@v2' }, () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('«Як минуло свято?»: отримане позначає власник, «Ще хочу» переносить копії', async ({ page }) => {
    await signInV2(page);
    await newList(page, unique('V2 after'));
    const lamp = unique('Лампа');
    const plaid = unique('Плед');
    await addManual(page, lamp);
    await addManual(page, plaid);

    // У день свята картки ще немає — наступного дня вона є.
    await setEventDate(page, inDays(0));
    await expect(afterCard(page)).toHaveCount(0);
    await setEventDate(page, inDays(-1));
    await expect(afterCard(page)).toBeVisible();
    // Там, де можна чекати інформації про позначки, — пояснення, а не мовчання (ADR-040).
    await expect(afterCard(page)).toContainText(/не показуємо|nie pokazujemy|don't show/i);

    // Позначити отримане: нічого не позначено наперед.
    await afterCard(page).getByRole('button', { name: /позначити отримане|oznacz otrzymane|mark what you received/i }).click();
    const received = page.getByRole('dialog', { name: /що подарували|co podarowano|what did you receive/i });
    await expect(received.getByRole('checkbox', { name: lamp })).not.toBeChecked();
    await expect(received.getByRole('checkbox', { name: plaid })).not.toBeChecked();
    await received.getByRole('checkbox', { name: lamp }).check();
    await received.getByRole('button', { name: /\(1\)$/ }).click();
    await expect(received).toHaveCount(0);
    await expect(page.locator('.v2-done__summary')).toContainText(/· 1$/);

    // «Ще хочу»: пропонується лише нерозібране, усе вже вибрано.
    await afterCard(page).getByRole('button', { name: /що ще хочу|czego wciąż chcę|what i still want/i }).click();
    const carry = page.getByRole('dialog', { name: /що ще хочеш|czego jeszcze chcesz|what do you still want/i });
    await expect(carry.getByRole('checkbox', { name: plaid })).toBeChecked();
    await expect(carry.getByRole('checkbox', { name: lamp })).toHaveCount(0);
    const target = unique('V2 still want');
    await carry.locator('input[name="carry_title"]').fill(target);
    await carry.getByRole('button', { name: /\(1\)$/ }).click();
    await expect(carry).toHaveCount(0);

    // Копія, а не переїзд: у цьому списку плед лишився.
    await expect(card(page, plaid)).toBeVisible();
    const done = page.getByRole('status').filter({ hasText: target });
    await done.getByRole('link').click();
    await expect(page.getByRole('heading', { level: 1, name: target })).toBeVisible();
    await expect(card(page, plaid)).toBeVisible();
    await expect(card(page, lamp)).toHaveCount(0);
  });

  test('«Пізніше» ховає картку й після F5', async ({ page }) => {
    await signInV2(page);
    await newList(page, unique('V2 later'));
    await addManual(page, unique('Книга'));
    await setEventDate(page, inDays(-2));
    await expect(afterCard(page)).toBeVisible();
    await afterCard(page).getByRole('button', { name: /^(пізніше|później|later)$/i }).click();
    await expect(afterCard(page)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(afterCard(page)).toHaveCount(0);
  });

  test('архів: без «Поділитися», у своєму блоці на головній, «Повторити» й «Повернути з архіву»', async ({ page }) => {
    await signInV2(page);
    const yesterday = inDays(-1);
    const year = Number(yesterday.slice(0, 4));
    const title = unique(`V2 archive ${year}`);
    await newList(page, title);
    const keep = unique('Лампа');
    await addManual(page, keep);
    await setEventDate(page, yesterday);

    await listMenu(page).click();
    await page.getByRole('dialog').getByRole('button', { name: /^(архівувати|zarchiwizuj|archive)$/i }).click();
    await expect(archivedNote(page)).toBeVisible();
    await expect(shareButton(page)).toHaveCount(0);
    await expect(afterCard(page)).toHaveCount(0);
    await page.reload();
    await expect(archivedNote(page)).toBeVisible();

    // Головна: не серед найближчих і минулих, а в згорнутому «Архів · N».
    await page.goto('/lists');
    const archive = page.locator('details.v2-archive');
    await expect(archive).toBeVisible();
    await expect(page.locator('section').getByRole('link', { name: new RegExp(title) })).toHaveCount(0);
    await archive.locator('summary').click();
    await archive.getByRole('link', { name: new RegExp(title) }).click();
    await expect(archivedNote(page)).toBeVisible();

    // «Повторити на наступний рік»: рік у назві посунуто, нерозібране — копіями.
    await listMenu(page).click();
    await page.getByRole('dialog').getByRole('button', { name: new RegExp(String(year + 1)) }).click();
    const repeat = page.getByRole('dialog', { name: new RegExp(String(year + 1)) });
    const nextTitle = title.replace(String(year), String(year + 1));
    await expect(repeat.locator('input[name="repeat_title"]')).toHaveValue(nextTitle);
    await expect(repeat.getByRole('switch', { name: /неподаровані|niepodarowane|not yet gifted/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await repeat.getByRole('button', { name: /^(створити|utwórz|create)$/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: nextTitle })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: title })).toBeVisible();
    await expect(card(page, keep)).toBeVisible();
    await expect(archivedNote(page)).toHaveCount(0);

    // Старий список лишився в архіві — повертаємо його одним натиском.
    await page.goBack();
    await expect(archivedNote(page)).toBeVisible();
    await page.getByRole('button', { name: /повернути з архіву|przywróć z archiwum|restore from archive/i }).click();
    await expect(archivedNote(page)).toHaveCount(0);
    await expect(shareButton(page)).toBeVisible();
  });

  test('новий список із минулою датою — «Створити як архів»', async ({ page }) => {
    await signInV2(page);
    await page.goto('/lists/new');
    const title = unique('V2 old party');
    await page.locator('input[name="title"]').fill(title);
    await page.locator('input[name="event_date"]').fill(inDays(-30));
    await expect(page.getByText(/піде в архів|trafi do archiwum|straight to the archive/i)).toBeVisible();
    await page.getByRole('button', { name: /створити як архів|utwórz jako archiwum|create as archive/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
    await expect(archivedNote(page)).toBeVisible();
  });
});

test.describe('щорічні свята v2', { tag: '@v2' }, () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  const yearly = (page: Page) => page.getByRole('switch', { name: /повторювати щороку|powtarzaj co roku|repeat every year/i });

  test('«Повторювати щороку» — лише з датою; позначка зберігається й видна в налаштуваннях', async ({ page }) => {
    await signInV2(page);
    await page.goto('/lists/new');
    const title = unique('V2 yearly new');
    await page.locator('input[name="title"]').fill(title);
    await expect(yearly(page)).toHaveAttribute('aria-disabled', 'true');
    await page.locator('input[name="event_date"]').fill(inDays(40));
    await expect(yearly(page)).not.toHaveAttribute('aria-disabled', 'true');
    await yearly(page).click();
    await expect(yearly(page)).toHaveAttribute('aria-checked', 'true');
    await page.getByRole('button', { name: /^(готово|gotowe|done)$/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();

    await listMenu(page).click();
    await page.getByRole('dialog').getByRole('button', { name: /налаштування списку|ustawienia listy|list settings/i }).click();
    const settings = page.getByRole('dialog', { name: /налаштування списку|ustawienia listy|list settings/i });
    await expect(settings.getByRole('switch', { name: /повторювати щороку|powtarzaj co roku|repeat every year/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
  });

  test('за місяць до річниці — нагадування на головній; «Повторити» веде в повтор, і нагадування переходить до нового списку', async ({
    page,
  }) => {
    await signInV2(page);
    // Свято було 340 днів тому: річниця — за місяць.
    const eventDate = inDays(-340);
    const fromYear = Number(eventDate.slice(0, 4));
    const toYear = fromYear + 1;
    const title = unique(`V2 yearly ${fromYear}`);
    await page.goto('/lists/new');
    await page.locator('input[name="title"]').fill(title);
    await page.locator('input[name="event_date"]').fill(eventDate);
    await yearly(page).click();
    // Минула дата — одразу в архів (ADR-045); нагадування про архівний теж приходить.
    await page.getByRole('button', { name: /створити як архів|utwórz jako archiwum|create as archive/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();

    await page.goto('/lists');
    const reminder = page.getByRole('region', { name: new RegExp(title) });
    await expect(reminder).toBeVisible();
    await reminder.getByRole('link', { name: new RegExp(String(toYear)) }).click();

    const repeat = page.getByRole('dialog', { name: new RegExp(String(toYear)) });
    const nextTitle = title.replace(String(fromYear), String(toYear));
    await expect(repeat.locator('input[name="repeat_title"]')).toHaveValue(nextTitle);
    await expect(repeat.getByRole('switch', { name: /повторювати щороку|powtarzaj co roku|repeat every year/i })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await repeat.getByRole('button', { name: /^(створити|utwórz|create)$/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: nextTitle })).toBeVisible();

    // Позначка тепер у нового списку, чия дата ще попереду, — нагадування немає.
    await page.goto('/lists');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: new RegExp(title) })).toHaveCount(0);
  });

  test('«Не цього разу» ховає нагадування до наступної річниці', async ({ page }) => {
    await signInV2(page);
    const title = unique('V2 yearly skip');
    await page.goto('/lists/new');
    await page.locator('input[name="title"]').fill(title);
    await page.locator('input[name="event_date"]').fill(inDays(-350));
    await yearly(page).click();
    await page.getByRole('button', { name: /створити як архів|utwórz jako archiwum|create as archive/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();

    await page.goto('/lists');
    const reminder = page.getByRole('region', { name: new RegExp(title) });
    await reminder.getByRole('button', { name: /не цього разу|nie tym razem|not this time/i }).click();
    await expect(reminder).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await expect(page.getByRole('region', { name: new RegExp(title) })).toHaveCount(0);
  });
});
