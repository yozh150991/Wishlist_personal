// Перевірка зібраного PWA: запускається після `vite build` (у CI — задача frontend).
//   node scripts/check-pwa.mjs
// Падає з кодом 1, якщо маніфест, іконки або Service Worker не такі, як треба
// для встановлення й для приватності гостьових посилань.
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dist = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const failures = [];
const check = (ok, message) => { if (!ok) failures.push(message); };

const manifest = JSON.parse(await readFile(join(dist, 'manifest.webmanifest'), 'utf8'));
check(manifest.name && manifest.short_name, 'маніфест: немає name або short_name');
check(manifest.display === 'standalone', 'маніфест: display має бути standalone');
check(manifest.start_url === '/lists', 'маніфест: start_url має бути /lists');

async function pngSize(path) {
  const b = await readFile(join(dist, path));
  const signature = b.subarray(0, 8).toString('hex') === '89504e470d0a1a0a';
  return signature ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null;
}
for (const [size, purpose] of [['192x192', 'any'], ['512x512', 'any'], ['512x512', 'maskable']]) {
  const icon = (manifest.icons ?? []).find((i) => i.sizes === size && (i.purpose ?? 'any') === purpose);
  check(icon, `маніфест: немає іконки ${size} (${purpose})`);
  if (icon) {
    const real = await pngSize(icon.src.replace(/^\//, '')).catch(() => null);
    check(real && `${real[0]}x${real[1]}` === size, `іконка ${icon.src}: фактичний розмір ${real?.join('x') ?? 'не PNG'}, очікувано ${size}`);
  }
}
check(await pngSize('icons/apple-touch-icon.png').then((s) => s?.join('x') === '180x180').catch(() => false),
  'icons/apple-touch-icon.png: немає або не 180×180');

const html = await readFile(join(dist, 'index.html'), 'utf8');
check(html.includes('rel="manifest"'), 'index.html: немає посилання на маніфест');
check(html.includes('rel="apple-touch-icon"'), 'index.html: немає apple-touch-icon');

// CSP живе у vercel.json і містить хеш єдиного інлайнового скрипта в index.html
// (застосування теми до першого рендера). Якщо скрипт змінити й забути оновити хеш,
// у бою тема почне блимати, а в консолі зʼявиться помилка CSP — тож звіряємо тут.
const vercel = JSON.parse(await readFile(join(dist, '..', 'vercel.json'), 'utf8'));
const csp = vercel.headers
  ?.flatMap((h) => h.headers ?? [])
  .find((h) => h.key === 'Content-Security-Policy')?.value;
check(csp, 'vercel.json: немає заголовка Content-Security-Policy');
if (csp) {
  for (const directive of ['default-src', 'script-src', 'connect-src', 'frame-ancestors', 'object-src']) {
    check(csp.includes(directive), `CSP: немає директиви ${directive}`);
  }
  check(!/script-src[^;]*'unsafe-inline'/.test(csp), "CSP: script-src містить 'unsafe-inline' — це знімає захист від XSS");
  const inline = html.match(/<script>([\s\S]*?)<\/script>/);
  check(inline, 'index.html: інлайновий скрипт теми зник — перевір CSP');
  if (inline) {
    // Перед хешуванням нормалізуємо кінці рядків до LF. Хеш має відповідати
    // байтам, які віддасть Vercel, а він збирає на Linux із LF. На Windows
    // git кладе на диск CRLF, vite переносить їх у dist/index.html, і хеш
    // без нормалізації виходив інший — перевірка падала на справному коді.
    const body = inline[1].replace(/\r\n/g, '\n');
    const hash = 'sha256-' + createHash('sha256').update(body).digest('base64');
    check(csp.includes(hash), `CSP: хеш інлайнового скрипта застарів, має бути '${hash}'`);
  }
}

// Гостьова сторінка — секрет у самій адресі. Кеш пристрою її не бачить
// (нижче), а пошуковий індекс не має побачити й поготів: заборона в
// robots.txt лише просить не сканувати, від індексації захищає заголовок.
const guestHeaders = vercel.headers
  ?.filter((h) => h.source?.includes('/s/'))
  .flatMap((h) => h.headers ?? []);
check(
  guestHeaders?.some((h) => h.key === 'X-Robots-Tag' && /noindex/i.test(h.value)),
  'vercel.json: для /s/* немає заголовка X-Robots-Tag: noindex — гостьові посилання можуть потрапити в пошук',
);

const robots = await readFile(join(dist, 'robots.txt'), 'utf8').catch(() => '');
check(/^\s*Disallow:\s*\/s\//m.test(robots), 'robots.txt: немає рядка Disallow: /s/');

// Жодного шрифта, вбудованого в CSS як `data:` URI. CSP дозволяє
// `font-src 'self'`, тож вбудований шрифт браузер блокує мовчки — сторінка
// виглядає справною, просто частина символів малюється системним шрифтом.
// Саме так зникала кирилиця-ext Manrope разом зі знаком ₴.
for (const file of (await readdir(join(dist, 'assets'))).filter((f) => f.endsWith('.css'))) {
  const text = await readFile(join(dist, 'assets', file), 'utf8');
  check(
    !/url\(\s*["']?data:(font|application\/font)/i.test(text),
    `assets/${file}: шрифт вбудовано в CSS як data: URI — CSP font-src 'self' його заблокує`,
  );
}

const sw = await readFile(join(dist, 'sw.js'), 'utf8');
check(sw.includes('createHandlerBoundToURL("/index.html")'), 'sw.js: немає запасної навігації на index.html');
check(/denylist:\[[^\]]*\\\/s\\\//.test(sw), 'sw.js: гостьові сторінки /s/ не виключені з навігації — токени лягли б у кеш пристрою');
check(!/\.map"/.test(sw), 'sw.js: у кеш потрапили карти коду (.map)');

if (failures.length) {
  console.error('PWA: знайдено проблеми:\n- ' + failures.join('\n- '));
  process.exit(1);
}
console.log('PWA: маніфест, іконки й Service Worker у порядку.');
