import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createList, hasAccount, itemCard, signIn, unique } from './helpers';

/**
 * Своє фото позиції (ADR-073): фото з телефона (3000×2000, з EXIF) після
 * завантаження — зменшене до 1600 по довшій стороні, без EXIF, за випадковою
 * адресою з бакета `item-photos`, на картці позиції й у її зміні як «Ваше
 * фото». Сховище файлів є лише в локальному стеку (CI піднімає storage-api),
 * тож тест — лише проти локальної бази.
 */

const localDb = Boolean(process.env.E2E_LOCALDB);
const MARKER = 'WISHLIST-EXIF-MARKER-0451';
const OWN = /\/storage\/v1\/object\/public\/item-photos\/[0-9a-f]{32}\.(?:webp|jpg)$/;

/** JPEG 3000×2000 із браузера — справжній, який розкодує будь-який рушій. */
async function bigJpeg(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 3000;
    c.height = 2000;
    const ctx = c.getContext('2d')!;
    const g = ctx.createLinearGradient(0, 0, 3000, 2000);
    g.addColorStop(0, 'teal');
    g.addColorStop(1, 'orange');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 3000, 2000);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.9));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  return Buffer.from(bytes);
}

/**
 * Той самий JPEG із сегментом APP1 «Exif»: порожній TIFF-каталог і мітка
 * замість координат. Мітки не має бути в тому, що поїхало в сховище.
 */
function withExif(jpeg: Buffer): Buffer {
  const tiff = Buffer.concat([
    Buffer.from('II*\0', 'binary'),
    Buffer.from([8, 0, 0, 0]), // зсув першого каталогу
    Buffer.from([0, 0]), // записів: 0
    Buffer.from([0, 0, 0, 0]), // наступного каталогу немає
    Buffer.from(MARKER, 'ascii'),
  ]);
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const len = payload.length + 2;
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (len >> 8) & 0xff, len & 0xff]), payload]);
  return Buffer.concat([jpeg.subarray(0, 2), app1, jpeg.subarray(2)]);
}

test('своє фото: зменшене, без EXIF, за випадковою адресою — і «Ваше фото» у зміні', async ({ page }) => {
  test.skip(!localDb || !hasAccount, 'Сховище файлів — лише на локальній базі');

  await signIn(page);
  await createList(page, unique('Фото'));
  const title = unique('Чайник');
  const file = withExif(await bigJpeg(page));
  expect(file.includes(Buffer.from(MARKER))).toBe(true);

  await page.getByRole('button', { name: /^(додати позицію|dodaj pozycję|add item)$/i }).first().click();
  const sheet = page.getByRole('dialog', { name: /нова позиція|nowa pozycja|new item/i });
  await sheet.getByRole('button', { name: /вписати вручну|wpisz ręcznie|type it in/i }).click();
  await sheet.locator('input[name="title"]').fill(title);

  await sheet.getByTestId('photo-file').setInputFiles({ name: 'IMG_0451.jpg', mimeType: 'image/jpeg', buffer: file });
  const own = sheet.getByTestId('own-photo');
  await expect(own).toBeVisible({ timeout: 20_000 });
  await expect(own).toContainText(/ваше фото|twoje zdjęcie|your photo/i);
  // Поки фото своє, поля з адресою немає.
  await expect(sheet.locator('input[name="image_url"]')).toHaveCount(0);

  await sheet.getByRole('button', { name: /^(додати|dodaj|add)$/i }).click();
  await expect(sheet).toHaveCount(0);

  const img = itemCard(page, title).first().locator('img');
  await expect(img).toHaveAttribute('src', OWN);
  const src = (await img.getAttribute('src'))!;

  // Зменшене: довша сторона — рівно 1600, пропорції ті самі.
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1600);
  expect(await img.evaluate((el: HTMLImageElement) => el.naturalHeight)).toBe(1067);

  // Без EXIF: ні мітки, ні сегмента «Exif».
  const res = await page.request.get(src);
  expect(res.ok()).toBe(true);
  const body = await res.body();
  expect(body.length).toBeLessThan(file.length);
  expect(body.includes(Buffer.from(MARKER))).toBe(false);
  expect(body.includes(Buffer.from('Exif\0\0', 'binary'))).toBe(false);

  // Зміна позиції: «Ваше фото», «Замінити фото», а хрестик повертає поле адреси.
  await itemCard(page, title).first().getByRole('button', { name: new RegExp(title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')) }).first().click();
  const edit = page.getByRole('dialog', { name: /^(позиція|pozycja|item)$/i });
  await expect(edit.getByTestId('own-photo')).toBeVisible();
  await expect(edit.getByText(/замінити фото|zmień zdjęcie|replace photo/i)).toBeVisible();
  await edit.getByRole('button', { name: /прибрати фото|usuń zdjęcie|remove photo/i }).click();
  await expect(edit.locator('input[name="image_url"]')).toHaveValue('');
  await edit.getByRole('button', { name: /^(зберегти|zapisz|save)$/i }).click();
  await expect(edit).toHaveCount(0);
  await expect(itemCard(page, title).first().locator('img')).toHaveCount(0);
});

test('своє фото: не картинка — зрозуміла помилка, нічого не завантажено', async ({ page }) => {
  test.skip(!localDb || !hasAccount, 'Сховище файлів — лише на локальній базі');

  await signIn(page);
  await createList(page, unique('Фото'));
  await page.getByRole('button', { name: /^(додати позицію|dodaj pozycję|add item)$/i }).first().click();
  const sheet = page.getByRole('dialog', { name: /нова позиція|nowa pozycja|new item/i });
  await sheet.getByRole('button', { name: /вписати вручну|wpisz ręcznie|type it in/i }).click();

  await sheet.getByTestId('photo-file').setInputFiles({
    name: 'notes.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 not a photo'),
  });
  await expect(sheet.getByRole('alert')).toContainText(/не схоже на фото|nie wygląda na zdjęcie|doesn.t look like a photo/i);
  await expect(sheet.locator('input[name="image_url"]')).toHaveValue('');
});
