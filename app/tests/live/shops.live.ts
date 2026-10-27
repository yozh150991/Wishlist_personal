import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { bookmarkletHref } from '../../src/lib/bookmarklet';

/**
 * Що кнопка «У вішліст» бере з живих сторінок магазинів (ROADMAP 8.3, ADR-076).
 * Запуск і умови — у `playwright.shops.config.ts`. Той самий набір посилань
 * читає `pytest -m live` для серверного парсера, тож дві таблиці можна
 * порівняти рядок у рядок.
 */

// SHOP_LINKS — інший файл того самого формату (наприклад, лише нові посилання).
const LINKS = process.env.SHOP_LINKS ?? new URL('../../../services/parser/tests/shop-links.txt', import.meta.url);
const REPORT_DIR = new URL('../../test-results/', import.meta.url);
const APP = 'https://wishlist.example';

function readLinks(): { shop: string; url: string }[] {
  return readFileSync(LINKS, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.includes('|'))
    .map((l) => {
      const at = l.indexOf('|');
      return { shop: l.slice(0, at).trim(), url: l.slice(at + 1).trim() };
    })
    .filter((l) => l.shop && /^https?:\/\//.test(l.url));
}

type Row = { shop: string; title: string; price: string; currency: string; image: string; page: string; error: string };
const rows: Row[] = [];
const cell = (v: string | null | undefined) => (v ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 80);
type Opened = { __opened?: string };

const links = readLinks();

test.describe.serial('кнопка «У вішліст» на сторінках магазинів', () => {
  if (links.length === 0) {
    test('набір посилань', () => {
      const hidden = readFileSync(LINKS, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trimStart().startsWith('#') && l.includes('|') && l.includes('://') && !l.includes('...')).length;
      test.skip(
        true,
        hidden
          ? `у shop-links.txt усі ${hidden} посилань закоментовані — прибери «# » на початку рядків`
          : 'services/parser/tests/shop-links.txt порожній — допиши посилання',
      );
    });
  }

  test.afterAll(() => {
    if (rows.length === 0) return;
    mkdirSync(REPORT_DIR, { recursive: true });
    const head = '| Магазин | Назва | Ціна | Валюта | Фото | Заголовок вкладки | Помилка |\n|---|---|---|---|---|---|---|\n';
    const body = rows
      .map((r) => `| ${r.shop} | ${r.title} | ${r.price} | ${r.currency} | ${r.image} | ${r.page} | ${r.error} |`)
      .join('\n');
    writeFileSync(new URL('shops.md', REPORT_DIR), `${head}${body}\n`, 'utf8');
  });

  for (const { shop, url } of links) {
    test(`${shop}: ${url.slice(0, 60)}`, async ({ page }) => {
      const row: Row = { shop, title: '', price: '', currency: '', image: '', page: '', error: '' };
      rows.push(row);
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        // Частина магазинів дописує JSON-LD скриптами вже після завантаження.
        await page.waitForLoadState('load', { timeout: 15_000 }).catch(() => undefined);
        await page.waitForTimeout(2_000);
      } catch (e) {
        row.error = cell(e instanceof Error ? e.message.split('\n')[0] : String(e));
        throw e;
      }
      row.page = cell(await page.title());
      await page.evaluate(() => {
        window.open = (u?: string | URL) => {
          (window as unknown as Opened).__opened = String(u);
          return window;
        };
      });
      await page.evaluate(decodeURIComponent(bookmarkletHref(APP).slice('javascript:'.length)));
      const opened = await page.evaluate(() => (window as unknown as Opened).__opened ?? '');
      const q = new URL(opened).searchParams;
      row.title = cell(q.get('title'));
      row.price = cell(q.get('price'));
      row.currency = cell(q.get('currency'));
      row.image = q.get('image') ? 'так' : '';
      expect(q.get('title'), `${shop}: назви немає`).toBeTruthy();
    });
  }
});
