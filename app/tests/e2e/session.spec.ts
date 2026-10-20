import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { EMAIL, PASSWORD, addItem, createList, escapeRegExp, hasAccount, itemCard, setStatus, signIn, signOut, unique } from './helpers';

/**
 * Поведінка сесії: вхід клавішею Enter, повернення на ?next, F5 без виходу,
 * офлайн-копії й черга змін (етапи 6.4–6.5).
 */
test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

const navLists = (page: Page) => page.getByRole('link', { name: /^списки$|^listy$|^lists$/i }).first();
const navShares = (page: Page) => page.getByRole('link', { name: /^(мої )?посилання$|^(moje )?linki$|^(my )?links$/i });
const listLink = (page: Page, title: string) => page.getByRole('link', { name: new RegExp(escapeRegExp(title)) });
/** «Куплене й подароване» — згорнутий блок унизу списку. */
const doneGroup = (page: Page) =>
  page.locator('details').filter({ hasText: /куплене й подароване|kupione i podarowane|purchased and gifted/i });
/** Смуга черги змін над екраном (закритий аркуш виходу з тим самим текстом лишається в DOM). */
const pending = (page: Page) =>
  page.getByRole('status').filter({ hasText: /чекають на мережу|czekają na sieć|waiting for the network/i });
const GIFTED = /^(подаровано|podarowane|gifted)$/i;
const PURCHASED = /^(куплено|kupione|purchased)$/i;

test('вхід клавішею Enter повертає на сторінку з ?next', async ({ page }) => {
  await page.goto('/shares');
  await expect(page).toHaveURL(/\/login\?next=%2Fshares/);

  await page.locator('input[name="email"]').fill(EMAIL!);
  const password = page.locator('input[name="password"]');
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
  await page.getByRole('link', { name: /^(мої )?посилання$|^(moje )?linki$|^(my )?links$/i }).click();

  await expect(page.getByText(/немає зʼєднання|немає з'єднання|brak połączenia|no internet connection/i).first()).toBeVisible();
  await expect(page.getByText('[object Object]')).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 2, name: /ще жодного посилання|jeszcze żadnego linku|no links yet/i })).toHaveCount(0);

  await context.setOffline(false);
});

test('у налаштуваннях є розділ встановлення застосунку', async ({ page }) => {
  await signIn(page);
  await page.goto('/settings');
  const section = page.getByTestId('install');
  await expect(section.getByRole('heading', { name: /застосунок на телефоні|aplikacja na telefonie|app on your phone/i })).toBeVisible();
  // Підказок у розділі дві: про встановлення і про QR для телефона. Нас
  // цікавить перша — саме вона залежить від того, як браузер уміє ставити
  // застосунок. У тестовому браузері подія встановлення не приходить, тож
  // це одна з підказок «вручну».
  await expect(section.locator('p').first()).not.toHaveText('');
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
  await page.locator('input[name="email"]').fill(EMAIL!);
  await page.locator('input[name="password"]').fill(PASSWORD!);

  // Кнопка в роботі каже «Входжу…» і позначена aria-disabled; повторний натиск
  // нічого не робить. Шукаємо її за типом, бо підпис міняється.
  const submit = page.locator('button[type="submit"]');
  await submit.click();
  await expect(submit).toHaveAttribute('aria-disabled', 'true');
  // Довго — пропонуємо «Скасувати», не чекаючи тайм-ауту.
  await expect(page.getByRole('button', { name: /^(скасувати|anuluj|cancel)$/i })).toBeVisible({ timeout: 12_000 });

  await expect(
    page.getByText(/сервер не відповідає|serwer nie odpowiada|server is not responding/i),
  ).toBeVisible({ timeout: 25_000 });
  await expect(submit).not.toHaveAttribute('aria-disabled', 'true');
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
  await expect(listLink(page, title)).toBeVisible();
  await listLink(page, title).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();

  // Перехід усередині застосунку, без перезавантаження: у режимі розробки
  // Service Worker вимкнено, тож офлайн сторінку нізвідки було б узяти.
  await context.setOffline(true);
  await navLists(page).click();

  await expect(listLink(page, title)).toBeVisible();
  const stale = page.getByText(/збережену копію|zapisaną kopię|a saved copy/i);
  await expect(stale).toBeVisible();
  // Позначка мусить називати час, інакше копію не відрізнити від свіжих даних.
  await expect(stale).toHaveText(/\d/);
  await expect(page.getByRole('heading', { name: /не завантажились|nie udało się wczytać|didn't load/i })).toHaveCount(0);

  await context.setOffline(false);
});

test('без мережі відкривається й сам список із позиціями', async ({ page, context }) => {
  await signIn(page);
  const title = unique('E2E offline list');
  await createList(page, title);
  await addItem(page, 'Кавоварка офлайн');

  await navLists(page).click();
  await expect(listLink(page, title)).toBeVisible();

  await context.setOffline(true);
  await listLink(page, title).click();

  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
  await expect(itemCard(page, 'Кавоварка офлайн')).toBeVisible();
  await expect(page.getByText(/збережену копію|zapisaną kopię|a saved copy/i)).toBeVisible();

  await context.setOffline(false);
});

test('після виходу з акаунта офлайн-копії не лишається', async ({ page, context }) => {
  await signIn(page);
  await page.goto('/lists');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

  await signOut(page);
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
 * Читає або переписує знімок, не прив'язуючись до версії бази: версія росте з
 * кожним новим сховищем (черга змін підняла її до 2), і числом у тесті це
 * дублювати не варто — відкриття зі старшою версією падає з `VersionError`.
 * Зʼєднання закривається завжди, інакше наступне оновлення схеми заблокується.
 */
async function snapshots(page: Page, replaceUserId?: string): Promise<number> {
  return page.evaluate(
    (foreign) =>
      new Promise<number>((resolve) => {
        const req = indexedDB.open('wishlist');
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
  await navLists(page).click();
  await expect(listLink(page, title)).toBeVisible();

  // Дочекатись власного знімка застосунку, і лише тоді переписати підпис —
  // інакше застосунок затер би підміну своїм записом.
  await expect.poll(() => snapshots(page)).toBeGreaterThan(0);
  expect(await snapshots(page, 'not-this-user')).toBeGreaterThan(0);

  await context.setOffline(true);
  // Через іншу сторінку, щоб список завантажився наново. Обидва переходи
  // дочікуємо: без цього тест лишався на /shares і перевіряв не ту сторінку —
  // «нічого немає» там теж правда.
  await navShares(page).click();
  await page.waitForURL(/\/shares$/);
  await navLists(page).click();
  await page.waitForURL(/\/lists$/);

  // Стан сторінки читаємо за розміткою, а не за текстом: українською
  // «Немає зʼєднання» починають обидва повідомлення — і помилка, і позначка
  // копії, — тож за словами їх не розрізнити.
  const stale = page.locator('[data-stale="true"]');
  const failure = page.getByRole('heading', {
    name: /не завантажились|nie udało się wczytać|didn't load/i,
  });

  // Спершу дочекатись, поки сторінка взагалі відповість: без цього перевірки
  // «нічого немає» проходять на ще порожньому екрані.
  await expect(failure.or(stale)).toBeVisible();

  await expect(stale).toHaveCount(0);
  await expect(listLink(page, title)).toHaveCount(0);

  await context.setOffline(false);
});

/**
 * Черга змін (етап 6.5). Перевіряємо не сховище, а те, заради чого все це:
 * зміна, зроблена без мережі, видно одразу й доходить до бази, коли мережа
 * повертається.
 */
test('зміна статусу без мережі доходить до бази після повернення звʼязку', async ({
  page,
  context,
}) => {
  await signIn(page);
  const title = unique('E2E outbox');
  await createList(page, title);
  await addItem(page, 'Кавоварка черги');

  await context.setOffline(true);
  await setStatus(page, 'Кавоварка черги', GIFTED);

  // Видно одразу, без мережі.
  await expect(doneGroup(page)).toContainText('Кавоварка черги');
  const waiting = pending(page);
  await expect(waiting).toBeVisible();

  // Мережа повернулась — черга відправляється сама.
  await context.setOffline(false);
  await expect(waiting).toHaveCount(0, { timeout: 15_000 });

  // І це справді в базі, а не лише на екрані: перезавантажуємо сторінку.
  await page.reload();
  await expect(doneGroup(page)).toContainText('Кавоварка черги');
});

test('позиція, створена без мережі, зʼявляється в списку й не дублюється в базі', async ({
  page,
  context,
}) => {
  await signIn(page);
  const title = unique('E2E outbox add');
  await createList(page, title);

  await context.setOffline(true);
  await addItem(page, 'Додано офлайн');

  await context.setOffline(false);
  await expect(pending(page)).toHaveCount(0, {
    timeout: 15_000,
  });

  await page.reload();
  // Рівно одна: id згенеровано на клієнті, тож повторна відправка не створює другу.
  await expect(itemCard(page, 'Додано офлайн')).toHaveCount(1);
});

test('зміни в черзі переживають перезавантаження сторінки', async ({ page, context }) => {
  await signIn(page);
  const title = unique('E2E outbox keep');
  await createList(page, title);
  await addItem(page, 'Переживе перезавантаження');

  // Сторінку треба відвідати онлайн, щоб знімок ліг у кеш.
  await navLists(page).click();
  await expect(listLink(page, title)).toBeVisible();
  await listLink(page, title).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();

  await context.setOffline(true);
  await setStatus(page, 'Переживе перезавантаження', PURCHASED);
  await expect(pending(page)).toBeVisible();

  // Перехід усередині застосунку: у режимі розробки Service Worker вимкнено.
  await navLists(page).click();
  await listLink(page, title).click();

  // Знімок у кеші вже підправлений чергою, тож статус лишається зміненим.
  await expect(doneGroup(page)).toContainText('Переживе перезавантаження');
  await expect(pending(page)).toBeVisible();

  await context.setOffline(false);
});

/**
 * Найважливіший сценарій черги: відправку обірвано **після** того, як сервер
 * уже записав зміну. Клієнт бачить мережевий збій і лишає зміну в черзі, тож
 * наступна спроба відправить її вдруге.
 *
 * Рятує `id`, згенерований на клієнті: повтор впирається в первинний ключ
 * (`23505`), і черга вважає це успіхом. Без нього в списку зʼявився б дублікат.
 */
test('обірвана відправка не створює дублікат позиції', async ({ page }) => {
  await signIn(page);
  const title = unique('E2E outbox retry');
  await createList(page, title);

  // Перший POST доходить до бази, але відповідь до сторінки — ні.
  let cut = true;
  await page.route('**/rest/v1/items**', async (route) => {
    if (cut && route.request().method() === 'POST') {
      cut = false;
      await route.fetch();
      await route.abort();
      return;
    }
    await route.continue();
  });

  await addItem(page, 'Позиція з обірваної відправки').catch(() => {});

  // Зміна в черзі: клієнт вважає, що не дійшло.
  const waiting = pending(page);
  await expect(waiting).toBeVisible();

  // Друга спроба впирається в уже створений рядок і має порахувати це успіхом.
  await page.getByRole('button', { name: /спробувати зараз|spróbuj teraz|try now/i }).click();
  await expect(waiting).toHaveCount(0, { timeout: 15_000 });

  await page.reload();
  await expect(itemCard(page, 'Позиція з обірваної відправки')).toHaveCount(1);
});

/**
 * Вихід стирає чергу разом із кешем, тож незакінчену чергу застосунок не
 * викидає мовчки. Дані людини не мають зникати без її відома.
 */
test('вихід із незакінченою чергою спершу питає', async ({ page, context }) => {
  await signIn(page);
  const title = unique('E2E outbox leave');
  await createList(page, title);
  await addItem(page, 'Незакінчена зміна');

  await context.setOffline(true);
  await setStatus(page, 'Незакінчена зміна', GIFTED);
  await expect(pending(page)).toBeVisible();

  // Застосунок питає своїм аркушем; «Лишитися» — виходу не має статися.
  // Перевіряємо саме відсутність події: `toHaveURL` тут марний, бо збігається
  // миттєво, ще до переходу.
  await signOut(page);
  const ask = page.getByRole('dialog', { name: /вийти з акаунта|wylogować|sign out/i });
  await expect(ask).toContainText(/мережу: 1|sieć: 1|1 change/i);
  await ask.getByRole('button', { name: /^(лишитися|zostań|stay)$/i }).click();
  await page.waitForURL(/\/login/, { timeout: 3000 }).then(
    () => {
      throw new Error('застосунок вийшов, хоча запит було скасовано');
    },
    () => undefined,
  );
  await expect(pending(page)).toBeVisible();

  await context.setOffline(false);
});
