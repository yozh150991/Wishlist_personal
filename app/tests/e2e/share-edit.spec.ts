import { test, expect } from '@playwright/test';
import type { Browser, Page } from '@playwright/test';
import { addItem, createList, escapeRegExp, hasAccount, itemCard, shareLink, signIn, unique } from './helpers';

/**
 * 8.9: склад розданого посилання змінюється, а URL лишається той самий.
 * Нова позиція потрапляє в посилання лише явною дією («Додати в посилання»),
 * прибрана — зникає в гостя. Про броні власник тут нічого не бачить і не
 * може побачити (CLAUDE.md §3.2): це стереже pgTAP 36_share_edit_items.
 */
test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

async function guest(browser: Browser, link: string): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(link);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  return page;
}

const gcard = (page: Page, title: string) => page.locator('.v2-gcard').filter({ hasText: title });

async function showAll(page: Page) {
  const all = page.getByRole('radio', { name: /^(усі|wszystkie|all) \d+$/i });
  if (await all.isVisible()) await all.click();
}

test('нова позиція видна за старим посиланням після «Додати в посилання»', async ({ page, browser }) => {
  await signIn(page);
  await createList(page, unique('Склад нова'));
  await addItem(page, 'Склад перша');
  const share = unique('Посилання');
  const link = await shareLink(page, ['Склад перша'], share);
  await expect(itemCard(page, 'Склад перша').getByText(/видно гостям|widzą goście|guests see this/i)).toBeVisible();

  await addItem(page, 'Склад друга');
  const ask = page.getByRole('dialog', {
    name: new RegExp(`(у посилання «${escapeRegExp(share)}»|do linku „${escapeRegExp(share)}”|to the link “${escapeRegExp(share)}”)`, 'i'),
  });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: /^(додати|dodaj|add)$/i }).click();
  await expect(ask).toHaveCount(0);
  await expect(page.getByText(/додано в посилання: 1|dodano do linków: 1|added to links: 1/i)).toBeVisible();
  await expect(itemCard(page, 'Склад друга').getByText(/видно гостям|widzą goście|guests see this/i)).toBeVisible();

  const g = await guest(browser, link);
  await showAll(g);
  await expect(gcard(g, 'Склад перша')).toBeVisible();
  await expect(gcard(g, 'Склад друга')).toBeVisible();
  await g.context().close();
});

test('«Не зараз» — нова позиція в посилання не потрапляє', async ({ page, browser }) => {
  await signIn(page);
  await createList(page, unique('Склад не зараз'));
  await addItem(page, 'Склад видима');
  const link = await shareLink(page, ['Склад видима'], unique('Посилання'));

  await addItem(page, 'Склад прихована');
  const ask = page.getByRole('dialog', { name: /склад прихована/i });
  await ask.getByRole('button', { name: /^(не зараз|nie teraz|not now)$/i }).click();
  await expect(ask).toHaveCount(0);

  const g = await guest(browser, link);
  await showAll(g);
  await expect(gcard(g, 'Склад видима')).toBeVisible();
  await expect(g.getByText('Склад прихована')).toHaveCount(0);
  await g.context().close();
});

test('прибрана з посилання позиція зникає в гостя', async ({ page, browser }) => {
  await signIn(page);
  await createList(page, unique('Склад прибрати'));
  await addItem(page, 'Склад лишається');
  await addItem(page, 'Склад іде');
  const share = unique('Посилання');
  const link = await shareLink(page, ['Склад лишається', 'Склад іде'], share);

  const g = await guest(browser, link);
  await showAll(g);
  await expect(gcard(g, 'Склад іде')).toBeVisible();

  await page.goto('/shares');
  const card = page.locator('.v2-sharecard').filter({ hasText: share });
  await expect(card.getByText(/видно 2 з 2|widać 2 z 2|2 of 2 visible/i)).toBeVisible();
  await card.getByRole('button', { name: /змінити склад|zmień skład|change items/i }).click();
  const sheet = page.getByRole('dialog');
  const box = sheet.getByRole('checkbox', { name: /склад іде/i });
  await expect(box).toBeChecked();
  await box.uncheck();
  await expect(sheet.getByText(/бронь знімемо|zdejmiemy rezerwację|release the pick/i)).toBeVisible();
  await sheet.getByRole('button', { name: /^(зберегти склад|zapisz skład|save items)$/i }).click();
  await expect(sheet).toHaveCount(0);
  await expect(card.getByText(/видно 1 з 2|widać 1 z 2|1 of 2 visible/i)).toBeVisible();

  await g.reload();
  await expect(g.getByRole('heading', { level: 1 })).toBeVisible();
  await showAll(g);
  await expect(gcard(g, 'Склад лишається')).toBeVisible();
  await expect(g.getByText('Склад іде')).toHaveCount(0);
  await g.context().close();
});

test('список із живим посиланням позначено «Відкрито гостям»', async ({ page }) => {
  await signIn(page);
  const title = unique('Склад позначка');
  await createList(page, title);
  await addItem(page, 'Склад щось');
  await page.goto('/lists');
  const plain = page.locator('.v2-listcard').filter({ hasText: title });
  await expect(plain).toBeVisible();
  await expect(plain.getByText(/відкрито гостям|widoczna dla gości|open to guests/i)).toHaveCount(0);

  await plain.click();
  await shareLink(page, ['Склад щось'], unique('Посилання'));
  await page.goto('/lists');
  await expect(
    page.locator('.v2-listcard').filter({ hasText: title }).getByText(/відкрито гостям|widoczna dla gości|open to guests/i),
  ).toBeVisible();
});
