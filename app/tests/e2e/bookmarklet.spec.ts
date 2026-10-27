import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { bookmarkletHref, fromPage } from '../../src/lib/bookmarklet';

/**
 * Кнопка «У вішліст» на панелі закладок (ROADMAP 8.4, ADR-076).
 *
 * Дві половини окремо: що закладка збирає на сторінці магазину (сторінку
 * віддаємо самі, `window.open` перехоплюємо) і що застосунок погоджується
 * взяти з адреси `/add` (без браузера). Заповнена форма `/add` з акаунтом —
 * у `share-target.spec.ts`.
 */

const APP = 'https://wishlist.example';
type Opened = { __opened?: string };

/** Відкриває «сторінку магазину» з цим `<head>` і тисне закладку; повертає параметри `/add`. */
async function grab(page: Page, head: string, path = '/p/kettle?id=7#reviews'): Promise<URLSearchParams> {
  await page.route('https://shop.example.com/**', (r) =>
    r.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html><head>${head}</head><body>shop</body></html>` }),
  );
  await page.goto(`https://shop.example.com${path}`);
  await page.evaluate(() => {
    window.open = (u?: string | URL) => {
      (window as unknown as Opened).__opened = String(u);
      return window;
    };
  });
  const href = bookmarkletHref(APP);
  expect(href.startsWith('javascript:')).toBe(true);
  await page.evaluate(decodeURIComponent(href.slice('javascript:'.length)));
  const opened = await page.evaluate(() => (window as unknown as Opened).__opened ?? '');
  expect(opened.startsWith(`${APP}/add?`)).toBe(true);
  return new URL(opened).searchParams;
}

const ld = (data: unknown) => `<script type="application/ld+json">${JSON.stringify(data)}</script>`;

test.describe('закладка на сторінці магазину', () => {
  test('JSON-LD Product: назва, ціна, валюта, фото; адреса без якоря', async ({ page }) => {
    const q = await grab(
      page,
      `<title>Чайник — Shop</title>` +
        ld({
          '@context': 'https://schema.org',
          '@type': 'Product',
          name: '  Чайник   скляний  ',
          image: ['/img/kettle.jpg', '/img/2.jpg'],
          offers: [{ '@type': 'Offer', price: '129.99', priceCurrency: 'PLN' }],
        }),
    );
    expect(q.get('src')).toBe('page');
    expect(q.get('url')).toBe('https://shop.example.com/p/kettle?id=7');
    expect(q.get('title')).toBe('Чайник скляний');
    expect(q.get('price')).toBe('129.99');
    expect(q.get('currency')).toBe('PLN');
    expect(q.get('image')).toBe('https://shop.example.com/img/kettle.jpg');
  });

  test('@graph і група варіантів: ціна першого варіанта; зіпсований блок не заважає', async ({ page }) => {
    const q = await grab(
      page,
      `<script type="application/ld+json">{ broken</script>` +
        ld({
          '@graph': [
            { '@type': 'BreadcrumbList', name: 'Головна' },
            {
              '@type': ['ProductGroup'],
              name: 'Светр',
              image: { url: 'https://cdn.example.com/s.jpg' },
              hasVariant: [{ '@type': 'Product', offers: { lowPrice: 199, priceCurrency: 'UAH' } }],
            },
          ],
        }),
    );
    expect(q.get('title')).toBe('Светр');
    expect(q.get('price')).toBe('199');
    expect(q.get('currency')).toBe('UAH');
    expect(q.get('image')).toBe('https://cdn.example.com/s.jpg');
  });

  test('сутності в назві з JSON-LD розкодовано, теги не виконуються (як на Amazon)', async ({ page }) => {
    const q = await grab(
      page,
      ld({ '@type': 'Product', name: 'Bielizna M&eogon;ska, D&lstrok;ugi &amp; <img src=x onerror=alert(1)>', offers: { price: '129.95', priceCurrency: 'PLN' } }),
    );
    expect(q.get('title')).toBe('Bielizna Męska, Długi & <img src=x onerror=alert(1)>');
  });

  test('без JSON-LD — Open Graph', async ({ page }) => {
    const q = await grab(
      page,
      `<title>Сайт</title><meta property="og:title" content="Лампа"><meta property="product:price:amount" content="49.90">` +
        `<meta property="product:price:currency" content="EUR"><meta property="og:image" content="https://cdn.example.com/l.png">`,
    );
    expect(q.get('title')).toBe('Лампа');
    expect(q.get('price')).toBe('49.90');
    expect(q.get('currency')).toBe('EUR');
    expect(q.get('image')).toBe('https://cdn.example.com/l.png');
  });

  test('нічого, крім <title>: лише назва й адреса', async ({ page }) => {
    const q = await grab(page, `<title>Подушка | Shop</title>`, '/x');
    expect(q.get('title')).toBe('Подушка | Shop');
    expect(q.get('url')).toBe('https://shop.example.com/x');
    expect(q.has('price')).toBe(false);
    expect(q.has('image')).toBe(false);
  });

  test('вікно заблоковане — та сама адреса в цій вкладці', async ({ page }) => {
    await page.route('https://shop.example.com/**', (r) =>
      r.fulfill({ contentType: 'text/html; charset=utf-8', body: '<title>Ваза</title>' }),
    );
    await page.route(`${APP}/**`, (r) => r.fulfill({ contentType: 'text/html', body: 'app' }));
    await page.goto('https://shop.example.com/vase');
    await page.evaluate(() => {
      window.open = () => null;
    });
    await page.evaluate(decodeURIComponent(bookmarkletHref(APP).slice('javascript:'.length)));
    await page.waitForURL(`${APP}/add?**`);
    expect(new URL(page.url()).searchParams.get('title')).toBe('Ваза');
  });
});

test.describe('закладка: сторінка без розмітки (ADR-078)', () => {
  /** Повна сторінка (не лише `<head>`), щоб браузер розклав її й порахував розміри. */
  async function grabPage(page: Page, html: string): Promise<URLSearchParams> {
    await page.route('https://shop.example.com/**', (r) =>
      r.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><html>${html}</html>` }),
    );
    await page.goto('https://shop.example.com/dp/B0X');
    await page.evaluate(() => {
      window.open = (u?: string | URL) => {
        (window as unknown as Opened).__opened = String(u);
        return window;
      };
    });
    await page.evaluate(decodeURIComponent(bookmarkletHref(APP).slice('javascript:'.length)));
    return new URL(await page.evaluate(() => (window as unknown as Opened).__opened ?? '')).searchParams;
  }

  test('як Amazon: назва з h1, головна ціна — найбільша видима, стара закреслена — ні, фото — найбільше', async ({ page }) => {
    const q = await grabPage(
      page,
      `<head><title>Filtr osmozy : Amazon.pl: Przemysł i nauka</title></head><body style="margin:0">
        <h1 id="title"><span id="productTitle">  Ecosoft PURE Balance filtr   osmozy </span></h1>
        <img src="https://cdn.example.com/logo.png" width="90" height="30" alt="">
        <img src="https://cdn.example.com/main.jpg" width="400" height="400" alt="">
        <img src="https://cdn.example.com/thumb.jpg" width="130" height="130" alt="">
        <div class="basisPrice"><span class="a-price" style="text-decoration:line-through;font-size:40px">1 599,00 zł</span></div>
        <div id="corePrice"><span class="a-price" style="font-size:28px"><span class="a-price-whole">1 299</span>,<span>00</span> zł</span></div>
        <div class="price-per-unit" style="font-size:12px">(64,95 zł / l)</div>
        <div style="height:8000px"></div>
        <div class="a-price" style="font-size:60px">9 999,00 zł</div>
      </body>`,
    );
    expect(q.get('title')).toBe('Ecosoft PURE Balance filtr osmozy');
    expect(q.get('price')).toBe('1 299,00');
    expect(q.get('currency')).toBe('PLN');
    expect(q.get('image')).toBe('https://cdn.example.com/main.jpg');
    // Застосунок бере цю ціну крізь ті самі межі, що й форма.
    expect(fromPage(q)).toMatchObject({ price: 1299, currency: 'PLN', image: 'https://cdn.example.com/main.jpg' });
  });

  test('як Decathlon: ціна в елементі з «price» у класі, без знака валюти — з копійками', async ({ page }) => {
    const q = await grabPage(
      page,
      `<head><title>Kurtka | Decathlon</title><meta property="og:title" content="Kurtka puchowa MT500"></head><body>
        <h1>Kurtka puchowa MT500</h1>
        <span class="vtmn-price" style="font-size:32px">699,99</span>
        <span class="series-price" style="font-size:14px">IKEA 365+</span>
      </body>`,
    );
    expect(q.get('title')).toBe('Kurtka puchowa MT500');
    expect(q.get('price')).toBe('699,99');
    expect(q.has('currency')).toBe(false);
  });

  test('число без знака й без копійок ціною не вважаємо; приховані й далекі — теж', async ({ page }) => {
    const q = await grabPage(
      page,
      `<head><title>Kubek</title></head><body>
        <span class="price-name" style="font-size:40px">IKEA 365+</span>
        <span class="price" style="display:none">49,99 zł</span>
        <div style="height:8000px"></div><span class="price">19,99 zł</span>
      </body>`,
    );
    expect(q.has('price')).toBe(false);
    expect(q.has('image')).toBe(false);
  });

  test('розмітка важить більше за те, що на екрані', async ({ page }) => {
    const q = await grabPage(
      page,
      `<head>${ld({ '@type': 'Product', name: 'Лампа', offers: { price: '49.90', priceCurrency: 'EUR' }, image: 'https://cdn.example.com/ld.jpg' })}</head><body>
        <h1>Інша назва</h1><span class="price" style="font-size:50px">999,00 zł</span>
        <img src="https://cdn.example.com/big.jpg" width="500" height="500" alt="">
      </body>`,
    );
    expect([q.get('title'), q.get('price'), q.get('currency'), q.get('image')]).toEqual(['Лампа', '49.90', 'EUR', 'https://cdn.example.com/ld.jpg']);
  });
});

test.describe('що застосунок бере з адреси', () => {
  const q = (o: Record<string, string>) => new URLSearchParams(o);

  test('не від закладки — null (звичайне «Поділитися»)', () => {
    expect(fromPage(q({ url: 'https://shop.ua/x', title: 'X' }))).toBeNull();
  });

  test('назва, ціна, валюта, фото — у межах форми', () => {
    expect(
      fromPage(q({ src: 'page', title: '  Чайник \n скляний ', price: '1 299,99', currency: 'pln', image: 'https://cdn.example.com/k.jpg' })),
    ).toEqual({ title: 'Чайник скляний', price: 1299.99, currency: 'PLN', image: 'https://cdn.example.com/k.jpg' });
    expect(fromPage(q({ src: 'page', title: 'я'.repeat(500) }))!.title).toHaveLength(200);
  });

  test('незнайома валюта — без ціни; без валюти — ціна у валюті списку', () => {
    expect(fromPage(q({ src: 'page', price: '25', currency: 'GBP' }))).toMatchObject({ price: null, currency: null });
    expect(fromPage(q({ src: 'page', price: '25' }))).toMatchObject({ price: 25, currency: null });
  });

  test('сміття замість ціни, нуль і від’ємна — без ціни', () => {
    for (const price of ['abc', '0', '-5', '1e9', '99999999999']) {
      expect(fromPage(q({ src: 'page', price, currency: 'PLN' }))!.price).toBeNull();
    }
  });

  test('фото лише https і в межах довжини', () => {
    for (const image of ['http://cdn.example.com/a.jpg', 'javascript:alert(1)', 'data:image/png;base64,AAAA', `https://cdn.example.com/${'a'.repeat(2100)}`]) {
      expect(fromPage(q({ src: 'page', image }))!.image).toBeNull();
    }
  });
});
