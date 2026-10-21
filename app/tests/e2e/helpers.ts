import { expect } from '@playwright/test';
import type { Page } from '@playwright/test';

/**
 * Спільні кроки для сценаріїв, яким потрібен акаунт. Дизайн один (ADR-065),
 * тож помічники ходять тими самими дорогами, що й людина в застосунку.
 *
 * Правила, на яких трималась більшість падінь:
 *
 * 1. Поля шукаються за `name`, а не за підписом. Аркуші — нативні <dialog>,
 *    і форм з полем «Назва» на сторінці списку кілька; `name` у кожної свій.
 *
 * 2. Кожен тест створює собі дані сам. Playwright запускає тести паралельно
 *    і в довільному порядку, тож тест, що чекає на список, створений іншим
 *    тестом, падає або проходить випадково.
 *
 * 3. Кожне очікування, що може не настати, — з обмеженням часу
 *    (TESTING.md, правило 4).
 */

export const EMAIL = process.env.E2E_EMAIL;
export const PASSWORD = process.env.E2E_PASSWORD;
export const hasAccount = Boolean(EMAIL && PASSWORD);

/** Унікальний суфікс: паралельні тести й повторні запуски не перетинаються. */
export function unique(prefix: string): string {
  return `${prefix} ${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Вхід паролем; кінцева точка — «Мої списки». */
export async function signIn(page: Page) {
  await page.goto('/login');
  await page.locator('input[name="email"]').fill(EMAIL!);
  await page.locator('input[name="password"]').fill(PASSWORD!);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/lists$/);
}

/** Новий список через «Новий список» — одразу всередині нього. */
export async function createList(page: Page, title: string) {
  await page.goto('/lists/new');
  await page.locator('input[name="title"]').fill(title);
  await page.locator('button[type="submit"]').click();
  await expect(page).toHaveURL(/\/lists\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: title })).toBeVisible();
}

/** Картка позиції на сторінці списку. */
export function itemCard(page: Page, title: string) {
  return page.getByRole('listitem').filter({ hasText: title });
}

/** Позиція вручну на відкритій сторінці списку: «Вписати вручну» → назва → «Додати». */
export async function addItem(page: Page, title: string) {
  await page.getByRole('button', { name: /^(додати позицію|dodaj pozycję|add item)$/i }).first().click();
  const sheet = page.getByRole('dialog', { name: /нова позиція|nowa pozycja|new item/i });
  await expect(sheet.locator('input[name="link"]')).toBeFocused();
  await sheet.getByRole('button', { name: /вписати вручну|wpisz ręcznie|type it in/i }).click();
  await expect(sheet.locator('input[name="title"]')).toBeFocused();
  await sheet.locator('input[name="title"]').fill(title);
  await sheet.getByRole('button', { name: /^(додати|dodaj|add)$/i }).click();
  await expect(sheet).toHaveCount(0);
  await expect(itemCard(page, title).first()).toBeVisible();
}

/** Меню «⋯» позиції — аркуш, названий її назвою. */
export async function itemMenu(page: Page, title: string) {
  const t = escapeRegExp(title);
  await page
    .getByRole('button', {
      name: new RegExp(`(дії з позицією «${t}»|działania na pozycji „${t}”|actions for “${t}”)`, 'i'),
    })
    .click();
  return page.getByRole('dialog', { name: title });
}

/** Статус позиції з меню «⋯». */
export async function setStatus(page: Page, title: string, status: RegExp) {
  const menu = await itemMenu(page, title);
  // click, а не check: вибір одразу закриває меню.
  await menu.getByRole('radio', { name: status }).click();
  await expect(menu).toHaveCount(0);
}

/** Пункт меню «Дії зі списком». */
export async function listMenu(page: Page, item: RegExp) {
  await page.getByRole('button', { name: /^(дії зі списком|działania na liście|list actions)$/i }).click();
  await page.getByRole('dialog').getByRole('button', { name: item }).click();
}

export type ShareOptions = {
  /** «Діє до» — `YYYY-MM-DD`. */
  expires?: string;
};

/**
 * Відкриває «Поділитися», лишає вибраними рівно `pick`, вписує заголовок і
 * створює посилання. Повертає адресу з поля аркуша (а не з буфера: читання
 * буфера потребує дозволу, якого в тестовому профілі немає) — або null, якщо
 * форма відмовила (дата в минулому). Аркуш лишається відкритим.
 */
export async function createShare(
  page: Page,
  pick: string[],
  title: string,
  opts: ShareOptions = {},
): Promise<string | null> {
  await page.getByRole('button', { name: /^(поділитися|udostępnij|share)$/i }).first().click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.locator('input[name="share_title"]')).toBeVisible();

  // На телефоні вибір — окремий крок «Обрати», на десктопі — поруч із превʼю.
  const boxes = sheet.getByRole('checkbox');
  if (!(await boxes.first().isVisible())) await sheet.getByRole('button', { name: /^(обрати|wybierz|choose)$/i }).click();
  await expect(boxes.first()).toBeVisible();
  for (const box of await boxes.all()) {
    const label = await box.locator('xpath=ancestor::label[1]').innerText();
    const want = pick.some((name) => label.includes(name));
    if ((await box.isChecked()) !== want) await box.setChecked(want);
  }
  const done = sheet.getByRole('button', { name: /^(готово|gotowe|done)$/i });
  if (await done.isVisible()) await done.click();

  await sheet.locator('input[name="share_title"]').fill(title);
  if (opts.expires) await sheet.locator('input[name="share_expires"]').fill(opts.expires);
  await sheet.getByRole('button', { name: /^(створити посилання|utwórz link|create link)$/i }).click();

  const ready = sheet.getByRole('heading', { name: /посилання готове|link gotowy|link is ready/i });
  const refused = sheet.getByText(/дата вже минула|data już minęła|date has passed/i);
  await expect(ready.or(refused)).toBeVisible();
  if (!(await ready.isVisible())) return null;
  const link = await sheet.locator('input[readonly]').inputValue();
  expect(link).toMatch(/\/l\/[A-Za-z0-9_-]{16,}$/);
  return link;
}

/** Посилання, яке мусить створитись; аркуш закрито. */
export async function shareLink(page: Page, pick: string[], title: string, opts: ShareOptions = {}): Promise<string> {
  const link = await createShare(page, pick, title, opts);
  expect(link).not.toBeNull();
  await page.getByRole('dialog').getByRole('button', { name: /^(готово|gotowe|done)$/i }).first().click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  return link!;
}

/**
 * Виходить з акаунта. На телефоні кнопка живе в Налаштуваннях, на десктопі —
 * поруч із поштою в бічній колонці. Перехід саме посиланням, а не `goto`: тест
 * може бути офлайн, і перезавантаження сторінки йому нізвідки взяти.
 */
export async function signOut(page: Page) {
  const button = page.getByRole('button', { name: /^вийти$|^wyloguj$|^sign out$/i });
  if (!(await button.first().isVisible())) {
    await page.getByRole('link', { name: /^налаштування$|^ustawienia$|^settings$/i }).click();
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }
  await button.first().click();
}
