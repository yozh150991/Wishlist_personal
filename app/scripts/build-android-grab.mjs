// Код закладки «У вішліст» (`pageGrab`, lib/bookmarklet.ts) для застосунку на
// Android (android/, ADR-080, ADR-081). Помічник виконує в невидимому WebView той
// самий код, що й закладка, — тож правила читання сторінки лишаються в одному
// місці. Цей скрипт перекладає `pageGrab` із TypeScript у JavaScript і пише
// його виразом функції в assets застосунку.
//
//   npm run build:android-grab           — оновити файл
//   npm run build:android-grab -- --check — лише перевірити, що файл свіжий (CI)
import { build } from 'esbuild';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = resolve(here, '../src/lib/bookmarklet.ts');
const target = resolve(here, '../../android/app/src/main/assets/grab.js');
const check = process.argv.includes('--check');

const dir = await mkdtemp(join(tmpdir(), 'grab-'));
try {
  const out = join(dir, 'bookmarklet.mjs');
  await build({
    entryPoints: [source],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'es2017',
    outfile: out,
    logLevel: 'error',
  });
  const mod = await import(pathToFileURL(out).href);
  if (typeof mod.pageGrab !== 'function') throw new Error('pageGrab не знайдено в bookmarklet.ts');

  const text =
    '// Згенеровано з app/src/lib/bookmarklet.ts (pageGrab) — не редагувати вручну.\n' +
    '// Оновлення: cd app && npm run build:android-grab\n' +
    `(${mod.pageGrab.toString()})\n`;

  if (check) {
    const current = await readFile(target, 'utf8').catch(() => '');
    if (current !== text) {
      console.error('android/app/src/main/assets/grab.js застарів: cd app && npm run build:android-grab');
      process.exit(1);
    }
    console.log('grab.js свіжий');
  } else {
    await writeFile(target, text);
    console.log(`записано ${target}`);
  }
} finally {
  await rm(dir, { recursive: true, force: true });
}
