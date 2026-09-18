import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { EMAIL, PASSWORD, addItem, createList, hasAccount, signIn, unique } from './helpers';

/**
 * Поведінка сесії: вхід клавішею Enter, повернення на ?next, F5 без виходу.
 */
test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

test('вхід клавішею Enter повертає на сторінку з ?next', async ({ page }) => {
  await page.goto('/shares');
  await expect(page).toHaveURL(/\/login\?next=%2Fshares/);

  await page.getByLabel(/пошта|e-mail|email/i).fill(EMAIL!);
  const password = page.getByLabel(/пароль|hasło|password/i);
  await password.fill(PASSWORD!);
  await password.press('Enter');

  await expect(page).toHaveURL(/\/shares$/);
});

test('F5 на захищеній сторінці не викидає на вхід', async ({ page }) => {
  await signIn(page);
  await page.goto('/shares');
  await expect(page).toHaveURL(/\/shares$/);

  await page.reload();
  await expect(page).toHaveURL(/\/shares$/);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
});

test('без мережі — зрозуміла помилка, а не «[object Object]» чи порожній стан', async ({ page, context }) => {
  await signIn(page);
  await context.setOffline(true);

  // Перехід усередині застосунку: сторінку не перевантажуємо, запит даних падає.
  await page.getByRole('link', { name: /^посилання$|^linki$|^links$/i }).click();

  await expect(page.getByText(/немає зʼєднання|немає з'єднання|brak połączenia|no internet connection/i)).toBeVisible();
  await expect(page.getByText('[object Object]')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2, name: /посилань ще немає|nie ma jeszcze linków|no links yet/i })).toHaveCount(0);

  await context.setOffline(false);
});

test('у налаштуваннях є розділ встановлення застосунку', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings');
  const section = page.getByTestId('install');
  await expect(section.getByRole('heading', { name: /застосунок на телефоні|aplikacja na telefonie|app on your phone/i })).toBeVisible();
  // У тестовому браузері подія встановлення не приходить, тож видно одну з підказок.
  await expect(section.locator('p')).not.toHaveText('');
});

/**
 * Сервер, що прийняв зʼєднання й замовк, — не те саме, що офлайн: fetch не
 * відхиляється ніколи. Без тайм-ауту кнопка «Увійти» лишалась вимкненою
 * назавжди, без повідомлення. Саме так виглядав зламаний локальний стек
 * (SETUP.md, розділ 8) — а зовні це нічим не відрізнялось від зависання
 * самого застосунку.
 */
test('мовчазний сервер не залишає кнопку входу вимкненою назавжди', async ({ page }) => {
  // Тайм-аут 15 с плюс запас на прогрів сторінки.
  test.setTimeout(60_000);

  // Запит на вхід не отримує ні відповіді, ні помилки.
  await page.route('**/auth/v1/token**', () => {});

  await page.goto('/login');
  await page.getByLabel(/пошта|e-mail|email/i).fill(EMAIL!);
  await page.getByLabel(/пароль|hasło|password/i).fill(PASSWORD!);

  const submit = page.getByRole('button', { name: /увійти|zaloguj|sign in/i });
  await submit.click();
  await expect(submit).toBeDisabled();

  await expect(
    page.getByText(/сервер не відповідає|serwer nie odpowiada|server is not responding/i),
  ).toBeVisible({ timeout: 25_000 });
  await expect(submit).toBeEnabled();
  await expect(page).toHaveURL(/\/login/);
});

/**
 * Офлайн-читання (етап 6.4). Перевіряємо не «є щось у IndexedDB», а те, що
 * бачить людина: замість «Немає зʼєднання» — списки з позначкою, коли їх
 * збережено.
 */
test('без мережі показується збережена копія списків, позначена як копія', async ({
  page,
  context,
}) => {
  await signIn(page);
  const title = unique('E2E offline');
  await createList(page, title);

  // Сторінку списків треба відвідати онлайн — саме там знімок і зберігається.
  await page.goto('/lists');
  await expect(page.getByRole('link', { name: title })).toBeVisible();
  await page.getByRole('link', { name: title }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();

  // Перехід усередині застосунку, без перезавантаження: у режимі розробки
  // Service Worker вимкнено, тож офлайн сторінку нізвідки було б узяти.
  await context.setOffline(true);
  await page.getByRole('link', { name: /^списки$|^listy$|^lists$/i }).first().click();

  await expect(page.getByRole('link', { name: title })).toBeVisible();
  const stale = page.getByText(/збережену копію|zapisaną kopię|a saved copy/i);
  await expect(stale).toBeVisible();
  // Позначка мусить називати час, інакше копію не відрізнити від свіжих даних.
  await expect(stale).toHaveText(/\d/);
  await expect(page.getByText(/немає зʼєднання|немає з'єднання|no internet connection/i)).toHaveCount(0);

  await context.setOffline(false);
});

test('без мережі відкривається й сам список із позиціями', async ({ page, context }) => {
  await signIn(page);
  const title = unique('E2E offline list');
  await createList(page, title);
  await addItem(page, 'Кавоварка офлайн');

  await page.getByRole('link', { name: /^списки$|^listy$|^lists$/i }).first().click();
  await expect(page.getByRole('link', { name: title })).toBeVisible();

  await context.setOffline(true);
  await page.getByRole('link', { name: title }).click();

  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(page.getByText('Кавоварка офлайн', { exact: true })).toBeVisible();
  await expect(page.getByText(/збережену копію|zapisaną kopię|a saved copy/i)).toBeVisible();

  await context.setOffline(false);
});

test('пошук офлайн не видає частину списку за весь список', async ({ page, context }) => {
  await signIn(page);
  const title = unique('E2E offline search');
  await createList(page, title);
  await addItem(page, 'Кавоварка');

  await context.setOffline(true);
  await page.getByPlaceholder(/пошук|szukaj|search/i).fill('келих');

  // Вибірку з пошуком ми не кешуємо: краще чесна помилка, ніж копія,
  // яку легко прийняти за результат пошуку.
  await expect(page.getByText(/немає зʼєднання|немає з'єднання|no internet connection/i)).toBeVisible();
  await expect(page.getByText(/збережену копію|zapisaną kopię|a saved copy/i)).toHaveCount(0);

  await context.setOffline(false);
});

test('після виходу з акаунта офлайн-копії не лишається', async ({ page, context }) => {
  await signIn(page);
  await page.goto('/lists');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  await page.getByRole('button', { name: /^вийти$|^wyloguj$|^sign out$/i }).click();
  await expect(page).toHaveURL(/\/login/);

  // Порожньо саме в сховищі, а не лише на екрані.
  await expect
    .poll(async () =>
      page.evaluate(
        () =>
          new Promise<number>((resolve) => {
            const req = indexedDB.open('wishlist');
            req.onsuccess = () => {
              const db = req.result;
              if (!db.objectStoreNames.contains('snapshots')) return resolve(0);
              const count = db.transaction('snapshots', 'readonly').objectStore('snapshots').count();
              count.onsuccess = () => resolve(count.result);
              count.onerror = () => resolve(-1);
            };
            req.onerror = () => resolve(0);
          }),
      ),
    )
    .toBe(0);

  await context.setOffline(false);
});

/**
 * Друга лінія захисту. Вихід із акаунта стирає кеш, але покладатися лише на це
 * не можна: сховище могло лишитися від збою, від старішої версії застосунку або
 * від акаунта, з якого вийшли не по-людськи. Кожен запис підписаний `userId`, і
 * чужий підпис має бути промахом, а не даними на екрані.
 */

/**
 * Читає або переписує знімок так само, як це робить застосунок: та сама версія
 * бази, і зʼєднання завжди закривається. Відкриття без версії створило б
 * порожню базу без сховища, після чого застосунок не зміг би створити своє —
 * і тест проходив би, нічого не перевіривши.
 */
async function snapshots(page: Page, replaceUserId?: string): Promise<number> {
  return page.evaluate(
    (foreign) =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open('wishlist', 1);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('snapshots')) {
            db.createObjectStore('snapshots', { keyPath: 'key' });
          }
        };
        req.onerror = () => resolve(-1);
        req.onblocked = () => resolve(-1);
        req.onsuccess = () => {
          const db = req.result;
          const tx = db.transaction('snapshots', 'readwrite');
          const store = tx.objectStore('snapshots');
          const all = store.getAll();
          all.onsuccess = () => {
            const rows = all.result as Array<{ key: string; userId: string }>;
            if (foreign) for (const row of rows) store.put({ ...row, userId: foreign });
          };
          tx.oncomplete = () => {
            db.close();
            resolve((all.result as unknown[] | undefined)?.length ?? 0);
          };
          tx.onerror = () => {
            db.close();
            resolve(-1);
          };
        };
      }),
    replaceUserId ?? '',
  );
}

test('чужий знімок у сховищі не показується', async ({ page, context }) => {
  await signIn(page);
  const title = unique('E2E foreign');
  await createList(page, title);
  await page.getByRole('link', { name: /^списки$|^listy$|^lists$/i }).first().click();
  await expect(page.getByRole('link', { name: title })).toBeVisible();

  // Дочекатись власного знімка застосунку, і лише тоді переписати підпис —
  // інакше застосунок затер би підміну своїм записом.
  await expect.poll(() => snapshots(page)).toBeGreaterThan(0);
  expect(await snapshots(page, 'not-this-user')).toBeGreaterThan(0);

  await context.setOffline(true);
  // Через іншу сторінку, щоб список завантажився наново. Обидва переходи
  // дочікуємо: без цього тест лишався на /shares і перевіряв не ту сторінку —
  // «нічого немає» там теж правда.
  await page.getByRole('link', { name: /^посилання$|^linki$|^links$/i }).click();
  await page.waitForURL(/\/shares$/);
  await page.getByRole('link', { name: /^списки$|^listy$|^lists$/i }).first().click();
  await page.waitForURL(/\/lists$/);

  // Стан сторінки читаємо за розміткою, а не за текстом: українською
  // «Немає зʼєднання» починають обидва повідомлення — і помилка, і позначка
  // копії, — тож за словами їх не розрізнити.
  const stale = page.locator('.note--stale');
  const failure = page.locator('.note[data-tone="error"]');

  // Спершу дочекатись, поки сторінка взагалі відповість: без цього перевірки
  // «нічого немає» проходять на ще порожньому екрані.
  await expect(failure.or(stale)).toBeVisible();

  await expect(stale).toHaveCount(0);
  await expect(page.getByRole('link', { name: title })).toHaveCount(0);

  await context.setOffline(false);
});
