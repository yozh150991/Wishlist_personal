import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { addItem, createList, hasAccount, signIn, unique } from './helpers';

/**
 * Клавіатура й три мови (ROADMAP, «Редизайн», ручна перевірка → автоматично).
 *
 * 1. Прохід Tab: кожен елемент, що отримав фокус, видно, і на ньому є кільце
 *    (`outline` чи `box-shadow`); головні дії екрана досяжні з клавіатури.
 * 2. Три мови на вузькому телефоні (360 px): сторінка не їде вбік, текст
 *    кнопок і заголовків не обрізано. Довші польські й англійські підписи —
 *    найчастіша причина таких поломок.
 *
 * Гостьова береться з сіду (`seed-active-share-token`), тож ці кроки — лише
 * проти локальної бази (E2E_LOCALDB, TESTING.md).
 */

const SEED_GUEST = '/l/seed-active-share-token';
const localDb = Boolean(process.env.E2E_LOCALDB);

type Focus = { label: string; visible: boolean; ring: boolean } | null;

async function tabWalk(page: Page, steps: number): Promise<Focus[]> {
  const out: Focus[] = [];
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press('Tab');
    out.push(
      await page.evaluate(() => {
        const el = document.activeElement as HTMLElement | null;
        if (!el || el === document.body) return null;
        const r = el.getBoundingClientRect();
        const cs = getComputedStyle(el);
        return {
          label: (el.getAttribute('aria-label') || el.textContent || el.getAttribute('name') || el.tagName)
            .trim()
            .slice(0, 60),
          visible: r.width > 0 && r.height > 0 && cs.visibility !== 'hidden',
          ring: (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0) || cs.boxShadow !== 'none',
        };
      }),
    );
  }
  return out;
}

/** Кожен зупинений фокус видимий і з кільцем; повертає підписи для перевірок досяжності. */
async function expectKeyboardOk(page: Page, steps: number): Promise<string[]> {
  const stops = (await tabWalk(page, steps)).filter((f): f is NonNullable<Focus> => f !== null);
  expect(stops.length).toBeGreaterThan(3);
  expect(stops.filter((f) => !f.visible).map((f) => f.label), 'фокус на невидимому елементі').toEqual([]);
  expect(stops.filter((f) => !f.ring).map((f) => f.label), 'фокус без кільця').toEqual([]);
  return stops.map((f) => f.label);
}

test.describe('клавіатура', () => {
  test('вхід: поля, «Показати пароль», «Увійти» — по черзі, з кільцем', async ({ page }) => {
    await page.goto('/login');
    await expect(page.locator('input[name="email"]')).toBeVisible();
    const labels = await expectKeyboardOk(page, 8);
    expect(labels.join(' | ')).toMatch(/увійти|zaloguj|sign in/i);
  });

  test('гостьова: фільтри, «Беру», «Вигляд», «Поскаржитись»', async ({ page }) => {
    test.skip(!localDb, 'Гостьова з сіду — лише проти локальної бази');
    await page.goto(SEED_GUEST);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    const labels = (await expectKeyboardOk(page, 14)).join(' | ');
    expect(labels).toMatch(/беру|biorę|take/i);
    expect(labels).toMatch(/поскаржитись|zgłoś|report/i);
  });

  test.describe('з акаунтом', () => {
    test.skip(!hasAccount, 'Потрібні E2E_EMAIL і E2E_PASSWORD');

    test('«Мої списки», сторінка списку й «Налаштування»', async ({ page }) => {
      await signIn(page);
      await expectKeyboardOk(page, 12);

      // Свій список: чужі тести паралельно лишають списки з картками «Після свята».
      await createList(page, unique('A11y'));
      await addItem(page, unique('Лампа'));
      await page.reload();
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const list = (await expectKeyboardOk(page, 30)).join(' | ');
      expect(list).toMatch(/поділитися|udostępnij|share/i);
      expect(list).toMatch(/дії зі списком|działania na liście|list actions/i);

      await page.goto('/settings');
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      const settings = (await expectKeyboardOk(page, 14)).join(' | ');
      expect(settings).toMatch(/висока контрастність|wysoki kontrast|high contrast/i);
    });
  });
});

test.describe('три мови на 360 px', () => {
  test.use({ viewport: { width: 360, height: 780 } });

  for (const locale of ['uk', 'pl', 'en'] as const) {
    test(`${locale}: нічого не їде вбік і не обрізано`, async ({ page }) => {
      await page.addInitScript((l) => localStorage.setItem('wl.locale', l), locale);
      const paths = ['/login', '/register', '/privacy', '/такої-сторінки-немає'];
      if (localDb) paths.push(SEED_GUEST);
      for (const path of paths) {
        await page.goto(path);
        await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
        const problems = await page.evaluate(() => {
          const out: string[] = [];
          const over = document.documentElement.scrollWidth - innerWidth;
          if (over > 0) out.push(`сторінка ширша на ${over}px`);
          for (const el of document.querySelectorAll<HTMLElement>('button, a, label, h1, h2, h3, p')) {
            const r = el.getBoundingClientRect();
            // Підписи для зчитувача навмисно 1×1 px; закриті аркуші — поза екраном.
            if (r.width <= 1 || el.closest('.v2-sr') || el.closest('dialog:not([open])')) continue;
            const cs = getComputedStyle(el);
            if (cs.overflow !== 'visible' && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
              out.push(`обрізано: ${(el.textContent || '').trim().slice(0, 40)}`);
            }
            if (r.right > innerWidth + 1 && cs.position !== 'fixed') {
              out.push(`за краєм: ${(el.textContent || '').trim().slice(0, 40)}`);
            }
          }
          return out;
        });
        expect(problems, `${locale} ${path}`).toEqual([]);
      }
    });
  }
});
