import { expect } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

/**
 * Спільні кроки для сценаріїв, яким потрібен акаунт.
 *
 * Два правила, на яких трималась більшість падінь:
 *
 * 1. Поля шукаються всередині відкритого діалогу. Діалоги — нативні <dialog>,
 *    і закриті лишаються в DOM. На сторінці списку одночасно живуть форма
 *    позиції й форма списку, обидві з полем «Назва», тож getByLabel на всю
 *    сторінку знаходить два поля. getByRole('dialog') бачить лише відкритий.
 *
 * 2. Після відкриття діалогу треба дочекатися фокусу на першому полі.
 *    Dialog ставить його в requestAnimationFrame, уже після того, як діалог
 *    видно. Якщо заповнити поле раніше, фокус перескакує посеред введення,
 *    і текст опиняється в полі «Посилання» — так «399» потрапляло в URL.
 *
 * 3. Кожен тест створює собі дані сам. Playwright запускає тести паралельно
 *    і в довільному порядку, тож тест, що чекає на список, створений іншим
 *    тестом, падає або проходить випадково.
 */

export const EMAIL = process.env.E2E_EMAIL;
export const PASSWORD = process.env.E2E_PASSWORD;
export const hasAccount = Boolean(EMAIL && PASSWORD);

/** Унікальний суфікс: паралельні тести й повторні запуски не перетинаються. */
export function unique(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function openDialog(page: Page): Locator {
  return page.getByRole('dialog');
}

/** Відкритий діалог, у якому Dialog уже поставив фокус на перше поле. */
export async function settledDialog(page: Page): Promise<Locator> {
  const dialog = openDialog(page);
  await expect(dialog.locator('input:not([type="hidden"]), select, textarea').first()).toBeFocused();
  return dialog;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function signIn(page: Page) {
  await page.goto('/login');
  await page.getByLabel(/пошта|e-mail|email/i).fill(EMAIL!);
  await page.getByLabel(/пароль|hasło|password/i).fill(PASSWORD!);
  await page.getByRole('button', { name: /увійти|zaloguj|sign in/i }).click();
  await expect(page).toHaveURL(/\/lists/);
}

/** Створює список і відкриває його. Очікує, що відкрита сторінка /lists. */
export async function createList(page: Page, title: string) {
  await page.getByRole('button', { name: /створити список|utwórz listę|create list/i }).first().click();
  const dialog = await settledDialog(page);
  await dialog.getByLabel(/^назва$|^nazwa$|^title$/i).fill(title);
  await dialog.getByRole('button', { name: /^зберегти$|^zapisz$|^save$/i }).click();
  await expect(dialog).toHaveCount(0);
  await page.getByRole('link', { name: title }).click();
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
}

/** Додає позицію лише з назвою на відкритій сторінці списку. */
export async function addItem(page: Page, title: string) {
  await page.getByRole('button', { name: /додати позицію|dodaj pozycję|add item/i }).click();
  const dialog = await settledDialog(page);
  await dialog.getByLabel(/^назва$|^nazwa$|^title$/i).fill(title);
  await dialog.getByRole('button', { name: /^зберегти$|^zapisz$|^save$/i }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(title, { exact: true })).toBeVisible();
}

/**
 * Створює посилання з вибраних позицій і повертає його адресу.
 * Адреса читається з поля в діалозі, а не з буфера обміну: читання буфера
 * потребує дозволу браузера, якого в тестовому профілі немає.
 */
export async function createShare(page: Page, pick: string[], title: string): Promise<string> {
  await page.getByRole('button', { name: /^вибрати$|^zaznacz$|^select$/i }).click();
  // Роль checkbox обовʼязкова: назва позиції є і в підписі чекбокса вибору,
  // і в підписі списку статусу тієї ж картки.
  for (const name of pick) {
    await page.getByRole('checkbox', { name: new RegExp(escapeRegExp(name)) }).check();
  }
  await page.getByRole('button', { name: /створити посилання|utwórz link|create link/i }).click();

  const dialog = await settledDialog(page);
  await dialog.getByLabel(/^заголовок для гостей$|heading for guests|nagłówek/i).fill(title);
  await dialog.getByRole('button', { name: /створити посилання|utwórz link|create link/i }).click();

  // Саме #shareLink: підпис «Посилання» має ще й поле URL у формі позиції.
  const link = await dialog.locator('#shareLink').inputValue();
  expect(link).toMatch(/\/s\/[A-Za-z0-9_-]{22}$/);
  return link;
}

/**
 * Лічильник режиму вибору. Живе в шапці екрана, а не в панелі дій унизу,
 * тому шукається на рівні сторінки: прив'язка до панелі ламалась би від
 * кожного перенесення лічильника між блоками, хоч число на екрані є.
 */
export function selectedCount(page: Page, n: number): Locator {
  return page.getByText(new RegExp(`^(вибрано|zaznaczono|selected): ${n}$`, 'i'));
}

/**
 * Відкриває фільтри, якщо на цій ширині вони сховані в нижній лист.
 * На широкому екрані панель уже розгорнута, а кнопки «Фільтри» там немає —
 * тоді нічого робити не треба. Так один і той самий сценарій проходить
 * і в десктопній, і в телефонній розкладці.
 */
export async function openFilters(page: Page) {
  // Пошук стоїть поруч із кнопкою й на екрані завжди: поки його немає,
  // сторінка ще не готова, і питання «чи видно кнопку Фільтри» отримало б
  // відповідь «ні» просто тому, що її ще не намалювали.
  await expect(page.getByRole('searchbox')).toBeVisible();
  // Підпис якірний і з необовʼязковим числом: у кнопці сидить значок
  // кількості активних фільтрів («Фільтри 1»). Без якорів сюди ж потрапляли
  // «Скинути фільтри» в панелі й «Скинути все» в листі — щойно фільтр стає
  // активним, їх на екрані одразу дві, і помічник падав на strict mode.
  const toggle = page.getByRole('button', { name: /^(фільтри|filtry|filters)(\s+\d+)?$/i });
  if (!(await toggle.isVisible())) return;
  await toggle.click();
  await expect(openDialog(page)).toBeVisible();
}

/** Закриває лист фільтрів, якщо він відкритий: під ним список недосяжний. */
export async function closeFilters(page: Page) {
  const sheet = openDialog(page);
  if (!(await sheet.isVisible())) return;
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
}

/**
 * Виходить з акаунта. На телефоні кнопки виходу в нижній смузі немає — там
 * лише три розділи, а акаунт живе в Налаштуваннях; на десктопі вона поруч
 * із поштою в бічній колонці. Перехід саме посиланням, а не `goto`: тест
 * може бути офлайн, і перезавантаження сторінки йому нізвідки взяти.
 */
export async function signOut(page: Page) {
  const button = page.getByRole('button', { name: /^вийти$|^wyloguj$|^sign out$/i });
  if (!(await button.isVisible())) {
    await page.getByRole('link', { name: /^налаштування$|^ustawienia$|^settings$/i }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }
  await button.click();
}
