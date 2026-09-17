// Генерує PNG-іконки з SVG у public/icons/. Запуск із теки app:
//   node scripts/generate-icons.mjs
// Потрібен Chromium від Playwright (npx playwright install chromium).
// Інший браузер можна вказати змінною CHROMIUM_PATH.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'icons');

const targets = [
  { src: 'icon.svg', out: 'icon-192.png', size: 192 },
  { src: 'icon.svg', out: 'icon-512.png', size: 512 },
  { src: 'maskable.svg', out: 'maskable-512.png', size: 512 },
  // iOS сам заокруглює кути, тож беремо варіант без заокруглення.
  { src: 'maskable.svg', out: 'apple-touch-icon.png', size: 180 },
];

const browser = await chromium.launch(
  process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {},
);
try {
  for (const t of targets) {
    const svg = await readFile(join(dir, t.src), 'utf8');
    const page = await browser.newPage({ viewport: { width: t.size, height: t.size } });
    await page.setContent(
      `<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${t.size}" height="${t.size}" `)}</body></html>`,
    );
    await page.screenshot({ path: join(dir, t.out), omitBackground: true, clip: { x: 0, y: 0, width: t.size, height: t.size } });
    await page.close();
    console.log(`${t.out} ${t.size}×${t.size}`);
  }
} finally {
  await browser.close();
}
