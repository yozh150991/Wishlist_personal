import { test, expect } from '@playwright/test';
import { addItem, createList, hasAccount, settledDialog, signIn, unique } from './helpers';

/**
 * Сценарії етапу 3 працюють з реальним акаунтом.
 * Локально — під користувачем із сіду (TESTING.md, «Акаунт для E2E»):
 *   $env:E2E_LOCALDB="1"; $env:E2E_EMAIL="anna@wishlist.test"; $env:E2E_PASSWORD="password123"
 * Без акаунта набір пропускається, щоб CI не падав на відсутніх даних.
 */
test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

test('повний цикл: список, позиція без ціни, редагування, видалення', async ({ page }) => {
  await signIn(page);
  await createList(page, unique('E2E'));

  // Позиція лише з назвою — ціна й посилання необовʼязкові.
  await addItem(page, 'Навушники');
  await expect(page.getByText(/ціна не вказана|brak ceny|no price/i)).toBeVisible();

  // Підсумки чесно рахують позиції без ціни.
  await expect(page.getByText(/без ціни|bez ceny|without a price/i)).toBeVisible();

  await page.getByRole('button', { name: /^змінити$|^edytuj$|^edit$/i }).first().click();
  const dialog = await settledDialog(page);
  await dialog.getByLabel(/^ціна$|^cena$|^price$/i).fill('399');
  await dialog.getByRole('button', { name: /^зберегти$|^zapisz$|^save$/i }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(/ціна не вказана|brak ceny|no price/i)).toHaveCount(0);

  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: /^видалити$|^usuń$|^delete$/i }).first().click();
  await expect(page.getByText('Навушники', { exact: true })).toHaveCount(0);
});

test('пошук звужує вибірку', async ({ page }) => {
  await signIn(page);
  await createList(page, unique('E2E search'));

  for (const name of ['Кавоварка', 'Ковдра', 'Лампа']) {
    await addItem(page, name);
  }

  await page.getByRole('searchbox').fill('Ко');
  await expect(page.getByText('Кавоварка', { exact: true })).toBeVisible();
  await expect(page.getByText('Ковдра', { exact: true })).toBeVisible();
  await expect(page.getByText('Лампа', { exact: true })).toHaveCount(0);
});

test('зміна розміру сторінки перезавантажує вибірку з початку', async ({ page }) => {
  await signIn(page);
  await createList(page, unique('E2E page size'));

  const size = page.getByLabel(/на сторінці|na stronie|per page/i);
  await size.selectOption('10');
  await expect(size).toHaveValue('10');
});

test('Enter у діалогах списку й позиції зберігає, а в примітці — ні', async ({ page }) => {
  await signIn(page);

  // Список: Enter у полі назви.
  const listTitle = unique('E2E enter');
  await page.getByRole('button', { name: /створити список|utwórz listę|create list/i }).first().click();
  let dialog = await settledDialog(page);
  await dialog.getByLabel(/^назва$|^nazwa$|^title$/i).fill(listTitle);
  await dialog.getByLabel(/^назва$|^nazwa$|^title$/i).press('Enter');
  await expect(dialog).toHaveCount(0);
  await page.getByRole('link', { name: listTitle }).click();

  // Позиція: Enter у примітці переносить рядок і нічого не зберігає.
  await page.getByRole('button', { name: /додати позицію|dodaj pozycję|add item/i }).click();
  dialog = await settledDialog(page);
  await dialog.getByLabel(/^назва$|^nazwa$|^title$/i).fill('Через Enter');
  await dialog.getByLabel(/нотатка|notatka|^note$/i).press('Enter');
  await expect(dialog).toBeVisible();

  // Enter у полі назви — зберігає.
  await dialog.getByLabel(/^назва$|^nazwa$|^title$/i).press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Через Enter', { exact: true })).toBeVisible();
});

test('Enter у полі посилання без назви запускає «Заповнити»', async ({ page }) => {
  await signIn(page);
  await createList(page, unique('E2E parser'));
  await page.getByRole('button', { name: /додати позицію|dodaj pozycję|add item/i }).click();
  const dialog = await settledDialog(page);

  // Без VITE_PARSER_URL кнопка «Заповнити» вимкнена — перевіряти нічого.
  const notConfigured = dialog.getByText(/VITE_PARSER_URL/);
  test.skip((await notConfigured.count()) > 0, 'Парсер не налаштовано (VITE_PARSER_URL порожній)');

  // Справжній парсер не потрібен: відповідь підставляється тут.
  await page.route('**/parse', (route) =>
    route.fulfill({
      headers: { 'access-control-allow-origin': '*' },
      json: {
        url: 'https://shop.example.com/p/1', title: 'Лампа з парсера', price: 149.9, currency: 'PLN',
        image_url: null, site_name: 'shop.example.com', confidence: {}, partial: false,
      },
    }),
  );

  const url = dialog.getByLabel(/^посилання$|^link$/i);
  await url.fill('https://shop.example.com/p/1');
  await url.press('Enter');

  // Діалог не закрився, а назва й ціна заповнились.
  await expect(dialog.getByLabel(/^назва$|^nazwa$|^title$/i)).toHaveValue('Лампа з парсера');
  await expect(dialog.getByLabel(/^ціна$|^cena$|^price$/i)).toHaveValue('149.9');

  // Тепер назва є, і Enter у тому ж полі зберігає.
  await url.press('Enter');
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('Лампа з парсера', { exact: true })).toBeVisible();
});

test('масові дії: статус і видалення вибраних', async ({ page }) => {
  await signIn(page);
  await createList(page, unique('E2E bulk'));
  for (const name of ['Перша', 'Друга', 'Третя']) await addItem(page, name);

  const region = page.getByRole('region', { name: /дії з вибраними|działania na zaznaczonych|actions for selected/i });
  const status = (title: string) => page.getByRole('combobox', { name: new RegExp(title) });

  // Статус двох позицій одразу.
  await page.getByRole('button', { name: /^вибрати$|^zaznacz$|^select$/i }).click();
  await page.getByRole('checkbox', { name: /Перша/ }).check();
  await page.getByRole('checkbox', { name: /Друга/ }).check();
  await expect(region.getByText(/^(вибрано|zaznaczono|selected): 2$/i)).toBeVisible();
  await region.getByRole('combobox').selectOption('gifted');

  await expect(region).toHaveCount(0);
  await expect(status('Перша')).toHaveValue('gifted');
  await expect(status('Друга')).toHaveValue('gifted');
  await expect(status('Третя')).toHaveValue('active');

  // Видалення двох позицій одразу, з підтвердженням.
  await page.getByRole('button', { name: /^вибрати$|^zaznacz$|^select$/i }).click();
  await page.getByRole('checkbox', { name: /Перша/ }).check();
  await page.getByRole('checkbox', { name: /Третя/ }).check();
  page.once('dialog', (d) => void d.accept());
  await region.getByRole('button', { name: /^видалити$|^usuń$|^delete$/i }).click();

  await expect(page.getByText('Перша', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Третя', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Друга', { exact: true })).toBeVisible();
});

test('масова дія не зачіпає вибрані позиції, сховані пошуком', async ({ page }) => {
  await signIn(page);
  await createList(page, unique('E2E bulk hidden'));
  await addItem(page, 'Яблуко');
  await addItem(page, 'Груша');

  await page.getByRole('button', { name: /^вибрати$|^zaznacz$|^select$/i }).click();
  await page.getByRole('button', { name: /вибрати всі показані|zaznacz wszystkie widoczne|select all shown/i }).click();

  // Пошук ховає «Грушу» — вона має випасти з вибору.
  await page.getByRole('searchbox').fill('Ябл');
  await expect(page.getByText('Груша', { exact: true })).toHaveCount(0);
  const region = page.getByRole('region', { name: /дії з вибраними|działania na zaznaczonych|actions for selected/i });
  await expect(region.getByText(/^(вибрано|zaznaczono|selected): 1$/i)).toBeVisible();

  page.once('dialog', (d) => void d.accept());
  await region.getByRole('button', { name: /^видалити$|^usuń$|^delete$/i }).click();
  await expect(page.getByText('Яблуко', { exact: true })).toHaveCount(0);

  await page.getByRole('searchbox').fill('');
  await expect(page.getByText('Груша', { exact: true })).toBeVisible();
});

test('після дати події застосунок пропонує підбити підсумки', async ({ page }) => {
  await signIn(page);

  // Список із подією в минулому.
  const title = unique('E2E summary');
  await page.getByRole('button', { name: /створити список|utwórz listę|create list/i }).first().click();
  let dialog = await settledDialog(page);
  await dialog.getByLabel(/^назва$|^nazwa$|^title$/i).fill(title);
  await dialog.getByLabel(/дата події|data wydarzenia|event date/i).fill('2020-05-01');
  await dialog.getByRole('button', { name: /^зберегти$|^zapisz$|^save$/i }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('link', { name: title }).click();

  const banner = page.getByRole('region', { name: /підсумки події|podsumowanie wydarzenia|event summary/i });
  await expect(banner).toHaveCount(0); // порожній список нагадувати нема про що

  for (const name of ['Подарунок А', 'Подарунок Б']) await addItem(page, name);
  await expect(banner).toBeVisible();

  // «Пізніше» ховає нагадування, і воно не повертається після перезавантаження.
  await banner.getByRole('button', { name: /^пізніше$|^później$|^later$/i }).click();
  await expect(banner).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Подарунок А', { exact: true })).toBeVisible();
  await expect(banner).toHaveCount(0);

  // Нова вкладка (інший стан памʼяті) нагадування знову покаже.
  await page.evaluate(() => localStorage.removeItem('wl.summaryDismissed'));
  await page.reload();
  await expect(banner).toBeVisible();

  // «Підбити підсумки» вибирає всі актуальні позиції; лишається позначити їх подарованими.
  await banner.getByRole('button', { name: /підбити підсумки|podsumuj|wrap up/i }).click();
  const region = page.getByRole('region', { name: /дії з вибраними|działania na zaznaczonych|actions for selected/i });
  await expect(region.getByText(/^(вибрано|zaznaczono|selected): 2$/i)).toBeVisible();
  await region.getByRole('combobox').selectOption('gifted');

  // Нагадування зникло, натомість тихий рядок із підсумком.
  await expect(banner).toHaveCount(0);
  await expect(page.getByText(/подаровано 2 з 2|podarowano 2 z 2|2 of 2 gifted/i)).toBeVisible();
});

test('до дати події нагадування не показується', async ({ page }) => {
  await signIn(page);

  const title = unique('E2E future');
  await page.getByRole('button', { name: /створити список|utwórz listę|create list/i }).first().click();
  const dialog = await settledDialog(page);
  await dialog.getByLabel(/^назва$|^nazwa$|^title$/i).fill(title);
  await dialog.getByLabel(/дата події|data wydarzenia|event date/i).fill('2099-12-31');
  await dialog.getByRole('button', { name: /^зберегти$|^zapisz$|^save$/i }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('link', { name: title }).click();

  await addItem(page, 'Ще попереду');
  await expect(
    page.getByRole('region', { name: /підсумки події|podsumowanie wydarzenia|event summary/i }),
  ).toHaveCount(0);
});
