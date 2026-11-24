import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { hasAccount, itemCard, signIn, unique, escapeRegExp } from './helpers';

/**
 * Резервна копія з фото (ROADMAP 8.12): «Мої дані» дають ZIP, «Відновити з
 * копії» створює з нього список із тими самими розділами, порядком і фото —
 * своє фото завантажується заново, під нову випадкову адресу (ADR-073).
 *
 * Тестовий акаунт спільний, тож у копії лишаємо лише свій список і даємо
 * йому нову назву: інакше відновлення задвоїло б усі списки акаунта.
 * Фото — лише на локальній базі (сховище файлів є там, ADR-073, п. 8).
 */

const localDb = Boolean(process.env.E2E_LOCALDB);
const OWN = /\/storage\/v1\/object\/public\/item-photos\/[0-9a-f]{32}\.(?:webp|jpg)$/;

const ownerTitles = (page: Page, group: string) =>
  page.getByRole('region', { name: new RegExp(`^(${group}) · \\d+$`) }).locator('.v2-item__title');

/** Невеликий справжній JPEG із браузера. */
async function jpeg(page: Page): Promise<Buffer> {
  const bytes = await page.evaluate(async () => {
    const c = document.createElement('canvas');
    c.width = 400;
    c.height = 300;
    const ctx = c.getContext('2d')!;
    ctx.fillStyle = 'teal';
    ctx.fillRect(0, 0, 400, 300);
    const blob = await new Promise<Blob>((r) => c.toBlob((b) => r(b!), 'image/jpeg', 0.9));
    return Array.from(new Uint8Array(await blob.arrayBuffer()));
  });
  return Buffer.from(bytes);
}

test('копія → відновлення: новий список із розділами, порядком і своїм фото за новою адресою', async ({ page }) => {
  test.skip(!hasAccount, 'Потрібен тестовий акаунт');
  test.setTimeout(120_000);

  await signIn(page);
  const source = unique('Backup src');
  // Список із розділами й ручним порядком — імпортом файлу, як у sections.spec.
  const file = {
    format: 'wishlist-personal',
    version: 1,
    list: { title: source, description: 'Опис', currency: 'EUR', event_date: null, sections: ['Кухня', 'Балкон', 'Порожній'] },
    items: [
      { title: 'Сковорода', section: 'Кухня', price: 49.9 },
      { title: 'Дошка', section: 'Кухня' },
      { title: 'Крісло', section: 'Балкон', status: 'purchased' },
      { title: 'Лампа' },
    ],
  };
  await page.getByRole('button', { name: /імпорт із файлу|import z pliku|import from a file/i }).first().click();
  const importSheet = page.getByRole('dialog', { name: /імпортувати список|importuj listę|import list/i });
  await importSheet.locator('input[type="file"]').setInputFiles({
    name: 'src.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(file)),
  });
  await importSheet.getByRole('button', { name: /\(4\)/ }).click();
  await expect(page.getByRole('heading', { level: 1, name: source })).toBeVisible();
  await expect(ownerTitles(page, 'Кухня')).toHaveText(['Сковорода', 'Дошка']);

  let originalPhoto: string | null = null;
  if (localDb) {
    await itemCard(page, 'Дошка').first().getByRole('button', { name: /Дошка/ }).first().click();
    const edit = page.getByRole('dialog', { name: /^(позиція|pozycja|item)$/i });
    await edit.getByTestId('photo-file').setInputFiles({ name: 'IMG.jpg', mimeType: 'image/jpeg', buffer: await jpeg(page) });
    await expect(edit.getByTestId('own-photo')).toBeVisible({ timeout: 20_000 });
    await edit.getByRole('button', { name: /^(зберегти|zapisz|save)$/i }).click();
    await expect(edit).toHaveCount(0);
    originalPhoto = await itemCard(page, 'Дошка').first().locator('img').getAttribute('src');
    expect(originalPhoto).toMatch(OWN);
  }

  // «Мої дані» — ZIP.
  await page.goto('/settings');
  const downloading = page.waitForEvent('download');
  await page.getByRole('button', { name: /завантажити мої дані|pobierz moje dane|download my data/i }).click();
  const download = await downloading;
  expect(download.suggestedFilename()).toMatch(/^wishlist-backup-\d{4}-\d{2}-\d{2}\.zip$/);
  const zip = unzipSync(new Uint8Array(await readFile((await download.path())!)));
  const manifest = JSON.parse(strFromU8(zip['wishlist-backup.json']!));
  expect(manifest).toMatchObject({ format: 'wishlist-backup', version: 1 });
  const text = strFromU8(zip['wishlist-backup.json']!);
  expect(text).not.toMatch(/"token"|"owner_id"|"claims"|"shares"/);

  // Лишаємо свій список під новою назвою.
  const mine = manifest.lists.find((l: { list: { title: string } }) => l.list.title === source);
  expect(mine).toBeTruthy();
  const restored = unique('Backup restored');
  mine.list.title = restored;
  const photos: Record<string, Uint8Array> = {};
  for (const i of mine.items as { photo: string | null }[]) if (i.photo) photos[i.photo] = zip[i.photo]!;
  expect(Object.keys(photos)).toHaveLength(localDb ? 1 : 0);
  if (originalPhoto) expect(text).not.toContain(originalPhoto.slice(-37));
  const trimmed = zipSync({
    'wishlist-backup.json': strToU8(JSON.stringify({ ...manifest, lists: [mine] })),
    ...photos,
  });

  await page.getByRole('button', { name: /^(відновити з копії|przywróć z kopii|restore from backup)$/i }).click();
  const sheet = page.getByRole('dialog', { name: /відновити з копії|przywróć z kopii|restore from backup/i });
  await sheet.getByTestId('restore-file').setInputFiles({ name: 'backup.zip', mimeType: 'application/zip', buffer: Buffer.from(trimmed) });
  await expect(sheet.getByTestId('restore-summary')).toContainText(/1.*4.*(1|0)/);
  await sheet.getByRole('button', { name: /(відновити списки|przywróć listy|restore lists): 1/i }).click();
  await expect(sheet.getByText(/(відновлено списків|przywrócono list|lists restored): 1/i)).toBeVisible({ timeout: 60_000 });

  // Той самий файл ще раз — список уже є, нічого не задвоюється.
  await sheet.getByTestId('restore-file').setInputFiles({ name: 'backup.zip', mimeType: 'application/zip', buffer: Buffer.from(trimmed) });
  await expect(sheet.getByText(/(вже є в акаунті|są już na koncie|already in the account): 1/i)).toBeVisible();
  await expect(sheet.getByRole('button', { name: /: 0$/ })).toBeVisible();
  await sheet.getByRole('button', { name: /^(скасувати|anuluj|cancel)$/i }).click();

  await page.goto('/lists');
  await page.getByRole('link', { name: new RegExp(escapeRegExp(restored)) }).first().click();
  await expect(page.getByRole('heading', { level: 1, name: restored })).toBeVisible();
  await expect(ownerTitles(page, 'Кухня')).toHaveText(['Сковорода', 'Дошка']);
  // «Крісло» куплене: власник бачить його не в розділі, а в згорнутому
  // «Куплене й подароване» — статус відновився разом із позицією.
  await expect(page.getByRole('region', { name: /^Балкон · \d+$/ })).toBeVisible();
  await expect(page.locator('.v2-done .v2-item__title')).toHaveText(['Крісло']);
  await expect(ownerTitles(page, 'Інше|Inne|Other')).toHaveText(['Лампа']);
  await expect(page.getByRole('region', { name: /^Порожній · 0$/ })).toBeVisible();

  if (originalPhoto) {
    const src = await itemCard(page, 'Дошка').first().locator('img').getAttribute('src');
    expect(src).toMatch(OWN);
    expect(src).not.toBe(originalPhoto);
  }
});

test('чужий файл — зрозуміла помилка, кнопки «Відновити» немає', async ({ page }) => {
  test.skip(!hasAccount, 'Потрібен тестовий акаунт');
  await signIn(page);
  await page.goto('/settings');
  await page.getByRole('button', { name: /^(відновити з копії|przywróć z kopii|restore from backup)$/i }).click();
  const sheet = page.getByRole('dialog', { name: /відновити з копії|przywróć z kopii|restore from backup/i });
  await sheet.getByTestId('restore-file').setInputFiles({
    name: 'x.json',
    mimeType: 'application/json',
    buffer: Buffer.from('{"format":"wishlist-backup","version":99,"lists":[]}'),
  });
  await expect(sheet.getByText(/новішою версією|nowsza wersja|newer version/i)).toBeVisible();
  await expect(sheet.getByTestId('restore-summary')).toHaveCount(0);
});
