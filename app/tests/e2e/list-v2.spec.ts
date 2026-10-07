import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { EMAIL, PASSWORD, hasAccount, unique } from './helpers';

/**
 * Сторінка списку дизайну v2 (ROADMAP, «Дизайн v2», кроки 3б-1, 3б-2 і 4б;
 * потоки C, D, F, L, O, R, V3).
 *
 * Тег `@v2` — лише у v2-проєктах. Правила вигляду (сортування, групи, сума,
 * посилання, ціна) перевіряє без браузера items-view.spec.ts; тут — те, що
 * бачить людина: додати, відмінити, змінити статус, видалити з «Відмінити»,
 * поділитися вибраним, змінити порядок, видалити список.
 */

async function signInV2(page: Page) {
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(EMAIL!);
  await page.locator('input[name="password"]').fill(PASSWORD!);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/lists$/);
}

/** Новий список через «Новий список» v2 — одразу всередині нього. */
async function newList(page: Page, title: string) {
  await page.goto('/lists/new');
  await page.locator('input[name="title"]').fill(title);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/lists\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
}

/** Запит видалення позиції дійшов до бази — перезавантажувати сторінку раніше не можна. */
const itemDeleted = (page: Page) =>
  page.waitForResponse((r) => r.url().includes('/rest/v1/items') && r.request().method() === 'DELETE', {
    timeout: 15_000,
  });

/** Запит видалення списку дійшов до бази. */
const listDeleted = (page: Page) =>
  page.waitForResponse((r) => r.url().includes('/rest/v1/lists') && r.request().method() === 'DELETE', {
    timeout: 15_000,
  });

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const itemSheet = (page: Page) => page.getByRole('dialog', { name: /нова позиція|nowa pozycja|new item/i });
const addButton = (page: Page) => page.getByRole('button', { name: /^(додати позицію|dodaj pozycję|add item)$/i }).first();
const undoButton = (page: Page) => page.getByRole('button', { name: /^(відмінити|cofnij|undo)$/i });
const card = (page: Page, title: string) => page.getByRole('listitem').filter({ hasText: title });
const menuOf = (page: Page, title: string) =>
  page.getByRole('button', {
    name: new RegExp(`(дії з позицією «${escape(title)}»|działania na pozycji „${escape(title)}”|actions for “${escape(title)}”)`, 'i'),
  });

/** Позиція вручну: «Вписати вручну» → назва → «Додати». */
async function addManual(page: Page, title: string, price?: string) {
  await addButton(page).click();
  const sheet = itemSheet(page);
  await expect(sheet.locator('input[name="link"]')).toBeFocused();
  await sheet.getByRole('button', { name: /вписати вручну|wpisz ręcznie|type it in/i }).click();
  await expect(sheet.locator('input[name="title"]')).toBeFocused();
  await sheet.locator('input[name="title"]').fill(title);
  if (price) await sheet.locator('input[name="price"]').fill(price);
  await sheet.getByRole('button', { name: /^(додати|dodaj|add)$/i }).click();
  await expect(sheet).toHaveCount(0);
}

test('сторінка списку v2 без сесії веде на вхід із next', { tag: '@v2' }, async ({ page }) => {
  await page.goto('/lists/00000000-0000-4000-8000-000000000000');
  await expect(page).toHaveURL(/\/login\?next=%2Flists%2F00000000-0000-4000-8000-000000000000$/);
});

test.describe('сторінка списку v2 з акаунтом', { tag: '@v2' }, () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('новий список відкривається порожнім; додана позиція підсвічена, «Відмінити» її прибирає', async ({ page }) => {
    await signInV2(page);
    await newList(page, unique('V2 items'));
    await expect(page.getByRole('heading', { name: /жодної позиції|ani jednej pozycji|no items yet/i })).toBeVisible();

    const title = unique('Лампа');
    await addManual(page, title, '1 240,50');
    await expect(card(page, title)).toBeVisible();
    // Сума — у тексті ціни є «240»; копійки не губляться.
    await expect(card(page, title)).toContainText(/240[,.]50/);
    const toast = page.getByRole('status').filter({ hasText: /додано|dodano|added/i });
    await expect(toast).toContainText(title);

    // На сторінці немає дубльованих id — одна розмітка на обидві розкладки (CLAUDE.md §4).
    const dupes = await page.evaluate(() => {
      const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
      return ids.filter((id, i) => ids.indexOf(id) !== i);
    });
    expect(dupes).toEqual([]);

    const deleted = itemDeleted(page);
    await undoButton(page).click();
    await expect(card(page, title)).toHaveCount(0);
    await deleted;
    await page.reload();
    await expect(page.getByRole('heading', { name: /жодної позиції|ani jednej pozycji|no items yet/i })).toBeVisible();
  });

  test('статус з меню «⋯» переносить у «Куплене й подароване»; видалення — тостом із «Відмінити»', async ({ page }) => {
    await signInV2(page);
    await newList(page, unique('V2 status'));
    const title = unique('Плед');
    await addManual(page, title);
    await expect(card(page, title)).toBeVisible();
    // Тост додавання доживає своє — щоб наступний тост був саме про видалення.
    await expect(undoButton(page)).toHaveCount(0, { timeout: 10_000 });

    await menuOf(page, title).click();
    const menu = page.getByRole('dialog', { name: title });
    // click, а не check: вибір одразу закриває меню, і перевіряти стан радіокнопки вже нема де.
    await menu.getByRole('radio', { name: /^(куплено|kupione|purchased)$/i }).click();
    await expect(menu).toHaveCount(0);
    const done = page.locator('details').filter({ hasText: /куплене й подароване|kupione i podarowane|purchased and gifted/i });
    await expect(done).toContainText(title);

    // Видалення без діалогу: позиція зникає одразу, «Відмінити» повертає.
    await menuOf(page, title).click();
    await page.getByRole('dialog', { name: title }).getByRole('button', { name: /^(видалити|usuń|delete)$/i }).click();
    await expect(card(page, title)).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: /видалено|usunięto|deleted/i })).toBeVisible();
    await undoButton(page).click();
    await expect(card(page, title)).toBeVisible();

    // Удруге — без відкату: запит іде, коли відлік скінчився, і після F5 позиції немає.
    const deleted = itemDeleted(page);
    await menuOf(page, title).click();
    await page.getByRole('dialog', { name: title }).getByRole('button', { name: /^(видалити|usuń|delete)$/i }).click();
    await expect(undoButton(page)).toHaveCount(0, { timeout: 10_000 });
    await deleted;
    await page.reload();
    await expect(page.getByRole('heading', { name: /жодної позиції|ani jednej pozycji|no items yet/i })).toBeVisible();
  });

  test('фото посиланням: хибна адреса не зберігається, мініатюра на картці, у зміні — «Прибрати фото»', async ({
    page,
  }) => {
    await signInV2(page);
    await newList(page, unique('V2 photo'));
    const title = unique('Навушники');
    const photo = 'https://example.com/wishlist-e2e/photo.jpg';

    await addButton(page).click();
    const sheet = itemSheet(page);
    await sheet.getByRole('button', { name: /вписати вручну|wpisz ręcznie|type it in/i }).click();
    await sheet.locator('input[name="title"]').fill(title);
    await sheet.locator('input[name="image_url"]').fill('ftp://example.com/photo.jpg');
    await sheet.getByRole('button', { name: /^(додати|dodaj|add)$/i }).click();
    await expect(sheet.locator('input[name="image_url"]')).toHaveAttribute('aria-invalid', 'true');
    await expect(sheet.locator('input[name="image_url"]')).toBeFocused();

    await sheet.locator('input[name="image_url"]').fill(photo);
    await sheet.getByRole('button', { name: /^(додати|dodaj|add)$/i }).click();
    await expect(sheet).toHaveCount(0);
    await expect(card(page, title).locator('img')).toHaveAttribute('src', photo);

    // Зміна позиції: фото видно й можна прибрати.
    await card(page, title).getByRole('button', { name: new RegExp(escape(title)) }).first().click();
    const edit = page.getByRole('dialog', { name: /^(позиція|pozycja|item)$/i });
    await expect(edit.locator('input[name="image_url"]')).toHaveValue(photo);
    await edit.getByRole('button', { name: /прибрати фото|usuń zdjęcie|remove photo/i }).click();
    await expect(edit.locator('input[name="image_url"]')).toHaveValue('');
    await edit.getByRole('button', { name: /^(зберегти|zapisz|save)$/i }).click();
    await expect(edit).toHaveCount(0);
    await expect(card(page, title).locator('img')).toHaveCount(0);
  });

  test('хибне посилання — підказка під полем і «Додати без посилання» до ручної форми', async ({ page }) => {
    await signInV2(page);
    await newList(page, unique('V2 link'));
    await addButton(page).click();
    const sheet = itemSheet(page);
    await sheet.locator('input[name="link"]').fill('shopua');
    await sheet.getByRole('button', { name: /^(далі|dalej|next)$/i }).click();
    await expect(sheet.getByText(/не адреса сторінки|nie wygląda na adres strony|doesn't look like a page address/i)).toBeVisible();
    await expect(sheet.locator('input[name="link"]')).toHaveAttribute('aria-invalid', 'true');
    // Поле не очищається: людина виправляє свій текст.
    await expect(sheet.locator('input[name="link"]')).toHaveValue('shopua');

    await sheet.getByRole('button', { name: /додати без посилання|dodaj bez linku|add without a link/i }).click();
    await expect(sheet.locator('input[name="title"]')).toBeFocused();
    // Порожня назва не відправляється: підказка під полем і фокус на ньому.
    await sheet.getByRole('button', { name: /^(додати|dodaj|add)$/i }).click();
    await expect(sheet.getByText(/назви позицію|nazwij pozycję|name the item/i)).toBeVisible();
    await expect(sheet.locator('input[name="title"]')).toBeFocused();
  });
});

/** Пункт меню «⋯» списку. */
async function listMenu(page: Page, item: RegExp) {
  await page.getByRole('button', { name: /^(дії зі списком|działania na liście|list actions)$/i }).click();
  await page.getByRole('dialog').getByRole('button', { name: item }).click();
}

test.describe('сторінка списку v2: поділитися, порядок, видалення', { tag: '@v2' }, () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('«Поділитися»: прихована позиція не доходить до гостя; відкритий список видаляється лише з назвою', async ({
    page,
    browser,
  }) => {
    await signInV2(page);
    const listTitle = unique('V2 share');
    await newList(page, listTitle);
    const shown = unique('Лампа');
    const secret = unique('Сюрприз');
    await addManual(page, shown);
    await addManual(page, secret);

    await page.getByRole('button', { name: /^(поділитися|udostępnij|share)$/i }).first().click();
    const sheet = page.getByRole('dialog');
    // На телефоні вибір — окремий крок «Обрати», на десктопі — поруч із превʼю.
    const box = sheet.getByRole('checkbox', { name: new RegExp(escape(secret)) });
    if (!(await box.isVisible())) await sheet.getByRole('button', { name: /^(обрати|wybierz|choose)$/i }).click();
    await box.uncheck();
    await expect(sheet.getByText(/1 з 2|1 z 2|1 of 2/)).toBeVisible();
    const done = sheet.getByRole('button', { name: /^(готово|gotowe|done)$/i });
    if (await done.isVisible()) await done.click();
    await sheet.getByRole('button', { name: /^(створити посилання|utwórz link|create link)$/i }).click();

    await expect(sheet.getByRole('heading', { name: /посилання готове|link gotowy|link is ready/i })).toBeVisible();
    const link = await sheet.locator('input[readonly]').inputValue();
    expect(link).toMatch(/\/s\/[A-Za-z0-9_-]{16,}$/);

    // Гість без сесії бачить лише вибране. Перегляд реєструється — список «відкривали».
    const guestContext = await browser.newContext();
    const guest = await guestContext.newPage();
    const viewed = guest.waitForResponse((r) => r.url().includes('/rpc/register_share_view'));
    await guest.goto(link);
    await expect(guest.getByText(shown)).toBeVisible();
    await expect(guest.getByText(secret)).toHaveCount(0);
    await viewed;

    // «Відкликати доступ» — з підтвердженням; посилання гасне.
    await sheet.getByRole('button', { name: /^(відкликати доступ|cofnij dostęp|revoke access)$/i }).click();
    await page
      .getByRole('dialog', { name: /відкликати доступ|cofnąć dostęp|revoke access/i })
      .getByRole('button', { name: /^(відкликати|cofnij|revoke)$/i })
      .click();
    await expect(sheet.getByRole('heading', { name: /доступ відкликано|dostęp cofnięty|access revoked/i })).toBeVisible();
    await guest.reload();
    await expect(guest.getByText(shown)).toHaveCount(0);
    await guestContext.close();
    await sheet.getByRole('button', { name: /^(готово|gotowe|done)$/i }).first().click();

    // Список відкривали — видалити можна, лише вписавши назву (F3).
    await listMenu(page, /^(налаштування списку|ustawienia listy|list settings)$/i);
    await page.getByRole('dialog').getByRole('button', { name: /^(видалити список|usuń listę|delete list)$/i }).click();
    const confirm = page.getByRole('dialog', { name: new RegExp(escape(listTitle)) });
    await expect(confirm.getByText(/відкривали|otwierano|opened/i)).toBeVisible();
    // Кнопка приглушена, поки назву не вписано; вписали — ожила.
    const forGood = confirm.getByRole('button', { name: /видалити назавжди|usuń na zawsze|delete for good/i });
    await expect(forGood).toHaveAttribute('aria-disabled', 'true');
    await confirm.locator('input[name="confirm_title"]').fill(listTitle);
    await expect(forGood).not.toHaveAttribute('aria-disabled', 'true');
    await forGood.click();
    await expect(page).toHaveURL(/\/lists$/);
    await expect(page.getByRole('status').filter({ hasText: /видалено|usunięta|deleted/i })).toBeVisible();
    await expect(page.getByRole('link', { name: new RegExp(escape(listTitle)) })).toHaveCount(0);
  });

  test('«Змінити порядок»: «Вище» переставляє позицію, і порядок переживає F5', async ({ page }) => {
    await signInV2(page);
    await newList(page, unique('V2 order'));
    const first = unique('Перша');
    const second = unique('Друга');
    await addManual(page, first);
    await addManual(page, second);
    // Щойно додані — зверху, новіші першими: «Друга», потім «Перша».
    const titles = () => page.locator('.v2-item__title, .v2-order .v2-item__title').allTextContents();
    await expect.poll(titles).toEqual([second, first]);

    await listMenu(page, /^(змінити порядок|zmień kolejność|change order)$/i);
    // «Перша» вище / „Перша” wyżej / Move “Перша” up.
    await page.getByRole('button', { name: new RegExp(`${escape(first)}.*(вище|wyżej|up)$`, 'i') }).click();
    await expect.poll(titles).toEqual([first, second]);
    await page.getByRole('button', { name: /^(готово|gotowe|done)$/i }).click();

    await page.reload();
    await expect.poll(titles).toEqual([first, second]);
  });

  test('список, який ніхто не відкривав, видаляється тостом «Відмінити» на головній', async ({ page }) => {
    await signInV2(page);
    const listTitle = unique('V2 delete');
    await newList(page, listTitle);

    // Налаштування: нова назва зберігається.
    const renamed = `${listTitle} ✓`;
    await listMenu(page, /^(налаштування списку|ustawienia listy|list settings)$/i);
    await page.getByRole('dialog').locator('input[name="list_title"]').fill(renamed);
    await page.getByRole('dialog').getByRole('button', { name: /^(зберегти|zapisz|save)$/i }).click();
    await expect(page.getByRole('heading', { level: 1, name: renamed })).toBeVisible();

    await listMenu(page, /^(налаштування списку|ustawienia listy|list settings)$/i);
    await page.getByRole('dialog').getByRole('button', { name: /^(видалити список|usuń listę|delete list)$/i }).click();
    await expect(page).toHaveURL(/\/lists$/);
    await expect(page.getByRole('link', { name: new RegExp(escape(renamed)) })).toHaveCount(0);

    // «Відмінити» повертає список, а без відкату він зникає після відліку.
    await undoButton(page).click();
    await expect(page.getByRole('link', { name: new RegExp(escape(renamed)) })).toBeVisible();

    await page.getByRole('link', { name: new RegExp(escape(renamed)) }).click();
    const deleted = listDeleted(page);
    await listMenu(page, /^(налаштування списку|ustawienia listy|list settings)$/i);
    await page.getByRole('dialog').getByRole('button', { name: /^(видалити список|usuń listę|delete list)$/i }).click();
    await expect(page).toHaveURL(/\/lists$/);
    await deleted;
    await page.reload();
    await expect(page.getByRole('link', { name: new RegExp(escape(renamed)) })).toHaveCount(0);
  });
});

test.describe('сторінка списку v2: чернетки', { tag: '@v2' }, () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('посилання без назви — чернетка «Потрібна назва»: гостям її не запропонувати, назва робить її позицією', async ({
    page,
  }) => {
    await signInV2(page);
    await newList(page, unique('V2 drafts'));
    const plaid = unique('Плед');
    await addManual(page, plaid);

    // Посилання є, назви немає — «Зберегти чернетку» замість вигадування назви (L).
    // Магазин «не віддав опису»: відповідь парсера підмінено, хоч би який він стояв.
    await page.route(/\/parse$/, (route) => route.fulfill({ status: 502, body: '' }));
    const slug = `lampa-${Date.now()}`;
    await addButton(page).click();
    const sheet = itemSheet(page);
    await expect(sheet.locator('input[name="link"]')).toBeFocused();
    await sheet.locator('input[name="link"]').fill(`https://www.shop.ua/${slug}/?utm_source=x`);
    await sheet.getByRole('button', { name: /^(далі|dalej|next)$/i }).click();
    await sheet.getByRole('button', { name: /зберегти чернетку|zapisz szkic|save as draft/i }).click();
    await expect(sheet).toHaveCount(0);
    await expect(page.getByRole('status').filter({ hasText: /чернетку збережено|szkic zapisany|draft saved/i })).toBeVisible();

    const draft = card(page, `shop.ua/${slug}`);
    await expect(draft).toContainText(/потрібна назва|potrzebna nazwa|needs a name/i);
    await expect(page.getByRole('heading', { name: /потрібна назва · 1|potrzebna nazwa · 1|needs a name · 1/i })).toBeVisible();

    // «Поділитися» чернетки не пропонує: гості її не бачать (ADR-046).
    await page.getByRole('button', { name: /^(поділитися|udostępnij|share)$/i }).first().click();
    const share = page.getByRole('dialog');
    const choose = share.getByRole('button', { name: /^(обрати|wybierz|choose)$/i });
    if (await choose.isVisible()) await choose.click();
    await expect(share.getByRole('checkbox', { name: new RegExp(escape(plaid)) })).toBeVisible();
    await expect(share.getByRole('checkbox', { name: new RegExp(escape(slug)) })).toHaveCount(0);
    await page.keyboard.press('Escape');
    if (await share.isVisible()) await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Відкрили чернетку — поле назви порожнє; назва робить її звичайною позицією.
    await draft.getByRole('button').first().click();
    const edit = page.getByRole('dialog', { name: /^(позиція|pozycja|item)$/i });
    await expect(edit.locator('input[name="title"]')).toHaveValue('');
    const lamp = unique('Керамічна лампа');
    await edit.locator('input[name="title"]').fill(lamp);
    await edit.getByRole('button', { name: /^(зберегти|zapisz|save)$/i }).click();
    await expect(edit).toHaveCount(0);
    await expect(card(page, lamp)).toBeVisible();
    await expect(card(page, lamp)).not.toContainText(/потрібна назва|potrzebna nazwa|needs a name/i);
    await page.reload();
    await expect(card(page, lamp)).toBeVisible();
    await expect(page.getByRole('heading', { name: /потрібна назва|potrzebna nazwa|needs a name/i })).toHaveCount(0);
  });
});

test.describe('сторінка списку v2: те, що прийшло з v1 (ADR-050)', { tag: '@v2' }, () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('пошук і «Фільтри» є вже на короткому списку; статус звужує, чип «×» знімає', async ({ page }) => {
    await signInV2(page);
    await newList(page, unique('V2 filters'));
    const keep = unique('Чашка');
    const bought = unique('Ковдра');
    await addManual(page, keep, '50');
    await addManual(page, bought, '300');
    await expect(undoButton(page)).toHaveCount(0, { timeout: 10_000 });
    await menuOf(page, bought).click();
    await page.getByRole('dialog', { name: bought }).getByRole('radio', { name: /^(куплено|kupione|purchased)$/i }).click();

    // Два пункти — а пошук уже є (у пакеті був від 20).
    await expect(page.getByRole('searchbox')).toBeVisible();

    await page.getByRole('button', { name: /^(фільтри|filtry|filters)/i }).click();
    const sheet = page.getByRole('dialog', { name: /^(фільтри|filtry|filters)$/i });
    await sheet.getByRole('checkbox', { name: /^(куплено|kupione|purchased)$/i }).check();
    await sheet.getByRole('button', { name: /^(показати|pokaż|show)$/i }).click();
    await expect(sheet).toHaveCount(0);
    await expect(card(page, keep)).toHaveCount(0);
    // Картка, а не getByText: назва є ще в закритих вікнах (меню «⋯», «Схожа вже є»),
    // які лишаються в DOM, і строгий режим знаходить три збіги.
    await expect(card(page, bought)).toBeVisible();

    await page.getByRole('button', { name: /зняти фільтр статусу|clear status filter|zdejmij filtr statusu/i }).click();
    await expect(card(page, keep)).toBeVisible();

    // Ціна «від–до»: 100…500 лишає лише ковдру.
    await page.getByRole('button', { name: /^(фільтри|filtry|filters)/i }).click();
    await sheet.locator('input[name="price_from"]').fill('100');
    await sheet.locator('input[name="price_to"]').fill('500');
    await sheet.getByRole('button', { name: /^(показати|pokaż|show)$/i }).click();
    await expect(card(page, keep)).toHaveCount(0);
  });

  test('експорт CSV із меню списку й імпорт файлу на «Моїх списках»', async ({ page }) => {
    await signInV2(page);
    const listTitle = unique('V2 export');
    await newList(page, listTitle);
    const title = unique('Ліхтарик');
    await addManual(page, title, '120');

    await page.getByRole('button', { name: /^(дії зі списком|działania na liście|list actions)$/i }).click();
    await page.getByRole('dialog').getByRole('button', { name: /експортувати список|eksportuj listę|export list/i }).click();
    const download = page.waitForEvent('download');
    await page.getByRole('dialog').getByRole('button', { name: /csv/i }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/\.csv$/);
    const path = await file.path();

    await page.goto('/lists');
    await page.getByRole('button', { name: /імпорт із файлу|import z pliku|import from a file/i }).first().click();
    const sheet = page.getByRole('dialog', { name: /імпортувати список|importuj listę|import list/i });
    await sheet.locator('input[type="file"]').setInputFiles(path);
    await expect(sheet.getByText(title)).toBeVisible();
    const imported = unique('V2 imported');
    await sheet.locator('input[name="import_title"]').fill(imported);
    await sheet.getByRole('button', { name: /\(1\)/ }).click();
    await expect(page.getByRole('heading', { level: 1, name: imported })).toBeVisible();
    await expect(card(page, title)).toBeVisible();
  });
});

test.describe('сторінка списку v2: валюта позиції (ADR-051)', { tag: '@v2' }, () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('позиція в євро — своя валюта на картці й окремий доданок у сумі', async ({ page }) => {
    await signInV2(page);
    await newList(page, unique('V2 currency'));
    await addManual(page, unique('Чашка'), '50');

    const title = unique('Навушники');
    await addButton(page).click();
    const sheet = itemSheet(page);
    await sheet.getByRole('button', { name: /вписати вручну|wpisz ręcznie|type it in/i }).click();
    await sheet.locator('input[name="title"]').fill(title);
    await sheet.locator('input[name="price"]').fill('85');
    await sheet.locator('select[name="currency"]').selectOption('EUR');
    await expect(sheet.getByText(/не у валюті списку|nie w walucie listy|not in the list currency/i)).toBeVisible();
    await sheet.getByRole('button', { name: /^(додати|dodaj|add)$/i }).click();
    await expect(sheet).toHaveCount(0);

    await expect(card(page, title)).toContainText('€');
    // «50 zł + 85 €» — без перерахунку.
    await expect(page.locator('.v2-sum__value')).toContainText('+');
    await expect(page.locator('.v2-sum__value')).toContainText('€');

    await page.reload();
    await expect(card(page, title)).toContainText('€');
  });
});

test.describe('сторінка списку v2: «Вибрати кілька»', { tag: '@v2' }, () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('статус вибраним одним рухом; масове видалення — з підтвердженням і переживає F5', async ({ page }) => {
    await signInV2(page);
    await newList(page, unique('V2 select'));
    const a = unique('Чайник');
    const b = unique('Тостер');
    const c = unique('Міксер');
    for (const title of [a, b, c]) await addManual(page, title);
    await expect(undoButton(page)).toHaveCount(0, { timeout: 10_000 });

    await listMenu(page, /^(вибрати кілька|zaznacz kilka|select several)$/i);
    const bar = page.getByRole('region', {
      name: /дії з вибраними позиціями|działania na zaznaczonych pozycjach|actions for selected items/i,
    });
    await expect(bar).toBeVisible();
    // У режимі вибору картка — прапорець: «⋯» і «+» ховаються.
    await expect(menuOf(page, a)).toHaveCount(0);
    await expect(addButton(page)).toHaveCount(0);

    await card(page, a).getByRole('checkbox').check();
    await card(page, b).getByRole('checkbox').check();
    await expect(bar).toContainText(/: 2/);

    await bar.getByRole('button', { name: /^(статус|status)$/i }).click();
    await page
      .getByRole('dialog', { name: /\(2\)/ })
      .getByRole('button', { name: /^(куплено|kupione|purchased)$/i })
      .click();
    await expect(bar).toHaveCount(0);
    const done = page.locator('details').filter({ hasText: /куплене й подароване|kupione i podarowane|purchased and gifted/i });
    await expect(done).toContainText(a);
    await expect(done).toContainText(b);
    await expect(done).not.toContainText(c);

    // «Вибрати всі показані» → «Видалити» → підтвердження: незворотне питає.
    await listMenu(page, /^(вибрати кілька|zaznacz kilka|select several)$/i);
    await bar.getByRole('button', { name: /вибрати всі показані|zaznacz wszystkie widoczne|select all shown/i }).click();
    await expect(bar).toContainText(/: 3/);
    await bar.getByRole('button', { name: /^(видалити|usuń|delete)$/i }).click();
    const confirm = page.getByRole('dialog', { name: /\(3\)/ });
    await expect(confirm).toBeVisible();
    const deleted = itemDeleted(page);
    await confirm.getByRole('button', { name: /^(видалити|usuń|delete)$/i }).click();
    await deleted;
    await expect(card(page, c)).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { name: /жодної позиції|ani jednej pozycji|no items yet/i })).toBeVisible();
  });
});

test.describe('сторінка списку v2: зміна позиції, яку могли взяти (ADR-055)', { tag: '@v2' }, () => {
  test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

  test('власник бачить попередження без жодного слова про броні; гість бачить «Змінено» й «Лишити»', async ({
    page,
    browser,
  }) => {
    await signInV2(page);
    await newList(page, unique('V2 changes'));
    const title = unique('Чайник');
    await addManual(page, title, '200');
    await expect(undoButton(page)).toHaveCount(0, { timeout: 10_000 });

    await page.getByRole('button', { name: /^(поділитися|udostępnij|share)$/i }).first().click();
    const share = page.getByRole('dialog');
    await share.getByRole('button', { name: /^(створити посилання|utwórz link|create link)$/i }).click();
    await expect(share.getByRole('heading', { name: /посилання готове|link gotowy|link is ready/i })).toBeVisible();
    const link = (await share.locator('input[readonly]').inputValue()).replace('/s/', '/l/');
    await share.getByRole('button', { name: /^(готово|gotowe|done)$/i }).first().click();

    // Гість бере позицію.
    const guestCtx = await browser.newContext();
    const guest = await guestCtx.newPage();
    await guest.goto(link);
    await guest.locator('.v2-gcard').filter({ hasText: title }).getByRole('button', { name: /^(беру|biorę|take)$/i }).click();
    await guest.getByRole('dialog').getByRole('button', { name: /^(забронювати|zarezerwuj|take it)$/i }).click();
    await guest.getByRole('dialog').getByRole('button', { name: /^(готово|gotowe|done)$/i }).click();
    const guestCard = guest.locator('.v2-gcard').filter({ hasText: title });
    await expect(guestCard).toContainText(/ви берете|bierzesz to|you're taking this/i);

    // Власник змінює назву: попередження про посилання — однакове для кожної
    // позиції в посиланні, і нічого про те, чи її взяли.
    await card(page, title).getByRole('button').first().click();
    const sheet = page.getByRole('dialog');
    const renamed = `${title} XL`;
    await sheet.locator('input[name="title"]').fill(renamed);
    const warn = sheet.getByTestId('item-guests-warn');
    await expect(warn).toContainText(/1/);
    await expect(warn).not.toContainText(/взял|wzię|took|taken/i);
    await sheet.getByRole('button', { name: /^(зберегти|zapisz|save)$/i }).click();
    await expect(card(page, renamed)).toBeVisible();

    // Гість бачить «Змінено», «Лишити» його знімає, бронь лишається.
    await guest.reload();
    const changed = guest.locator('.v2-gcard').filter({ hasText: renamed });
    await expect(changed).toContainText(/змінено|zmieniono|changed/i);
    await changed.getByRole('button', { name: /^(лишити|zostaw|keep)$/i }).click();
    await expect(changed).not.toContainText(/змінено|zmieniono|changed/i);
    await expect(changed).toContainText(/ви берете|bierzesz to|you're taking this/i);
    await guestCtx.close();
  });
});
