import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { addItem, createList, createShare, hasAccount, settledDialog, signIn, unique } from './helpers';

/**
 * Гість без акаунта (ADR-035): ключ у браузері й в особистому посиланні,
 * код із 5 символів, програш гонки, «Усе вже розібрали», сліпе скидання.
 *
 * Кожен гість — окремий browser context: саме так рідні відкривають посилання
 * на різних телефонах.
 */
test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

const take = /^(я візьму це|biorę to|i'll take this)$/i;
const yours = /ти береш це|bierzesz to|you are taking this/i;

async function guest(browser: Browser, link: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return page;
}

/** Власник створює список із позиціями й посилання на всі. */
async function setup(page: Page, items: string[]): Promise<{ link: string; token: string }> {
  await signIn(page);
  await createList(page, unique('Guest'));
  for (const name of items) await addItem(page, name);
  const link = await createShare(page, items, unique('Гостям'));
  await page.keyboard.press('Escape');
  return { link, token: link.split('/s/')[1]! };
}

test('особисте посилання й код переносять позначку на інший пристрій', async ({ page, browser }) => {
  const { link, token } = await setup(page, ['Сковорода', 'Рушники']);

  const first = await guest(browser, link);
  await first.getByRole('listitem').filter({ hasText: 'Сковорода' }).getByRole('button', { name: take }).click();
  await expect(first.getByText(yours)).toBeVisible();

  // Одразу після першої позначки — «Забери доступ із собою» з кодом.
  await expect(first.getByRole('heading', { name: /забери доступ|zabierz dostęp|take your access/i })).toBeVisible();
  const code = await first.locator('.keep__code-value').innerText();
  expect(code).toMatch(/^[2-9ABCDEFGHJKMNPQRSTUVWXYZ]{5}$/);
  const key = await first.evaluate((tk) => localStorage.getItem(`wl.gk.${tk}`), token);
  expect(key).toMatch(/^[A-Za-z0-9_-]{22,64}$/);

  // Особисте посилання: ключ лягає в браузер і зникає з адреси.
  const second = await guest(browser, `${link}/g/${key}`);
  await expect(second).toHaveURL(new RegExp(`/s/${token}$`));
  await expect(second.getByText(yours)).toBeVisible();

  // Код на третьому пристрої: позначки переносяться, старі пристрої лишаються робочими.
  const third = await guest(browser, link);
  await expect(third.getByText(yours)).toHaveCount(0);
  await third.getByRole('button', { name: /у мене вже щось відкладено|mam już coś odłożone|already picked something/i }).click();
  const dialog = await settledDialog(third);
  await dialog.getByLabel(/^код$|^kod$|^code$/i).fill(code.toLowerCase());
  await dialog.getByRole('button', { name: /відновити позначки|przywróć rezerwacje|restore my picks/i }).click();
  await expect(third.getByText(/позначки відновлено: 1|przywrócono rezerwacje: 1|picks restored: 1/i)).toBeVisible();
  await expect(third.getByText(yours)).toBeVisible();

  await first.reload();
  await expect(first.getByText(yours)).toBeVisible();

  // Код одноразовий: вдруге той самий не спрацьовує, і сторінка каже чому.
  const fourth = await guest(browser, link);
  await fourth.getByRole('button', { name: /у мене вже щось відкладено|mam już coś odłożone|already picked something/i }).click();
  const again = await settledDialog(fourth);
  await again.getByLabel(/^код$|^kod$|^code$/i).fill(code);
  await again.getByRole('button', { name: /відновити позначки|przywróć rezerwacje|restore my picks/i }).click();
  await expect(again.getByText(/такого коду|takiego kodu|that code isn't/i)).toBeVisible();
});

/**
 * Гостьова v2 живе під `/l/…` (ADR-041): той самий токен і той самий ключ.
 * Поки її екрани не намальовані, під `/l/` стоїть та сама сторінка — і вже
 * зараз важливо, що ключ з особистого посилання прибирається на `/l/`, а не
 * перекидає гостя на `/s/`, і що «Забери доступ із собою» дає посилання
 * під тим самим префіксом.
 */
test('/l/ — та сама позначка за тим самим ключем, особисте посилання лишається під /l/', async ({ page, browser }) => {
  const { link, token } = await setup(page, ['Глечик']);

  const first = await guest(browser, link);
  await first.getByRole('button', { name: take }).click();
  await expect(first.getByText(yours)).toBeVisible();
  const key = await first.evaluate((tk) => localStorage.getItem(`wl.gk.${tk}`), token);
  expect(key).toMatch(/^[A-Za-z0-9_-]{22,64}$/);

  // Буфер обміну в тестовому профілі потребує дозволу. Підміняємо запис,
  // щоб прочитати, що саме сторінка скопіювала б.
  const ctx = await browser.newContext();
  await ctx.addInitScript(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          w.__copied.push(text);
        },
      },
    });
  });
  const v2 = await ctx.newPage();
  await v2.goto(`${link.replace('/s/', '/l/')}/g/${key}`);
  await expect(v2).toHaveURL(new RegExp(`/l/${token}$`));
  await expect(v2.locator('html')).toHaveAttribute('data-design', 'v2');
  await expect(v2.getByText(yours)).toBeVisible();

  await v2.getByRole('button', { name: /^(скопіювати|skopiuj|copy)$/i }).click();
  const copied = await v2.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
  expect(copied).toHaveLength(1);
  expect(copied[0]).toMatch(new RegExp(`/l/${token}/g/${key}$`));
});

test('програш гонки пояснюється на місці позиції, кнопка зникає', async ({ page, browser }) => {
  const { link } = await setup(page, ['Кавомолка', 'Дошка']);

  const slow = await guest(browser, link);
  const fast = await guest(browser, link);
  await fast.getByRole('listitem').filter({ hasText: 'Кавомолка' }).getByRole('button', { name: take }).click();
  await expect(fast.getByText(yours)).toBeVisible();

  // Повільний гість ще бачить стару сторінку й тисне.
  const card = slow.getByRole('listitem').filter({ hasText: 'Кавомолка' });
  await card.getByRole('button', { name: take }).click();
  await expect(card.getByRole('status')).toContainText(/поки ти дивився|gdy patrzyłeś|while you were looking/i);
  await expect(card.getByRole('button', { name: take })).toHaveCount(0);

  // Вихід до вільних: одна вільна лишилась.
  await card.getByRole('button', { name: /показати вільні · 1|pokaż wolne · 1|show available · 1/i }).click();
  await expect(slow.getByRole('listitem').filter({ hasText: 'Кавомолка' })).toHaveCount(0);
  await expect(slow.getByRole('listitem').filter({ hasText: 'Дошка' })).toBeVisible();
});

test('«Усе вже розібрали», стеження й сліпе скидання власником', async ({ page, browser }) => {
  const { link } = await setup(page, ['Постіль']);

  const taker = await guest(browser, link);
  await taker.getByRole('button', { name: take }).click();
  await expect(taker.getByText(yours)).toBeVisible();
  // Свої позначки не рахуються як «хтось інший»: нагорі — «з них твої».
  await expect(taker.getByRole('heading', { name: /1 з них твої|1 z nich twoje|1 of them yours/i })).toBeVisible();

  const watcher = await guest(browser, link);
  await expect(watcher.getByRole('heading', { name: /усе вже розібрали|wszystko już rozebrane|everything's been taken/i })).toBeVisible();
  await expect(watcher.getByText('Постіль', { exact: true })).toBeVisible();
  await watcher.getByRole('button', { name: /стежити за списком|obserwuj listę|watch this list/i }).click();
  await expect(watcher.getByText(/стежиш за списком|obserwujesz listę|watching this list/i)).toBeVisible();

  // Власник скидає позицію наосліп: нічого не дізнається, лише «скинуто».
  await page.getByRole('button', { name: /(змінити|zmień|edit).*Постіль/i }).click();
  const dialog = await settledDialog(page);
  await dialog.getByRole('button', { name: /скинути позицію|zresetuj pozycję|reset item/i }).click();
  await page.getByRole('dialog').filter({ hasText: /цього не можна скасувати|nie da się cofnąć|can't be undone/i })
    .getByRole('button', { name: /скинути позицію|zresetuj pozycję|reset item/i }).click();
  await expect(dialog.getByText(/позицію скинуто|pozycję zresetowano|item reset/i)).toBeVisible();

  // Той, хто стежив, наступного разу бачить, що звільнилось.
  await watcher.reload();
  await expect(watcher.getByText(/звільнилось — 1|zwolniło się — 1|1 freed up/i)).toBeVisible();
  await expect(watcher.getByRole('button', { name: take })).toBeVisible();

  // Гість, чию позначку скинуто, бачить позицію вільною.
  await taker.reload();
  await expect(taker.getByText(yours)).toHaveCount(0);
  await expect(taker.getByRole('button', { name: take })).toBeVisible();
});

test('гість типово бачить вільні, «Усі» поруч', async ({ page, browser }) => {
  const { link } = await setup(page, ['Ваза', 'Лампа']);
  const a = await guest(browser, link);
  await a.getByRole('listitem').filter({ hasText: 'Ваза' }).getByRole('button', { name: take }).click();
  await expect(a.getByText(yours)).toBeVisible();

  const b = await guest(browser, link);
  const filters = b.getByRole('radiogroup', { name: /що показати|co pokazać|^show$/i });
  await expect(filters.getByRole('radio', { name: /вільні 1|wolne 1|available 1/i })).toHaveAttribute('aria-checked', 'true');
  await expect(b.getByRole('listitem').filter({ hasText: 'Ваза' })).toHaveCount(0);
  await filters.getByRole('radio', { name: /усі 2|wszystkie 2|all 2/i }).click();
  const taken = b.getByRole('listitem').filter({ hasText: 'Ваза' });
  // Чужа позначка: без імені, без дати, без дії.
  await expect(taken.getByText(/хтось уже взяв|ktoś już to wziął|someone has taken this/i)).toBeVisible();
  await expect(taken.getByRole('button')).toHaveCount(0);
});
