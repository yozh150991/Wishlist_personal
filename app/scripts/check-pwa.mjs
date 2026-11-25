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
// «Поділитися» з інших застосунків (ADR-046): лише GET на /add з трьома параметрами.
check(
  manifest.share_target?.action === '/add' &&
    manifest.share_target?.method === 'GET' &&
    ['title', 'text', 'url'].every((k) => manifest.share_target?.params?.[k] === k),
  'маніфест: share_target має вести GET-запитом на /add з параметрами title, text, url',
);

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
// Гостьових префіксів два: /l/ — гостьова, /s/ — старі роздані посилання,
// які застосунок переводить на /l/ з тим самим токеном (ADR-065). Токен є в
// обох адресах, тож кожна з трьох перевірок стосується обох.
const GUEST_PREFIXES = ['s', 'l'];

const robots = await readFile(join(dist, 'robots.txt'), 'utf8').catch(() => '');
for (const p of GUEST_PREFIXES) {
  const guestHeaders = vercel.headers
    ?.filter((h) => h.source?.startsWith(`/${p}/`))
    .flatMap((h) => h.headers ?? []);
  check(
    guestHeaders?.some((h) => h.key === 'X-Robots-Tag' && /noindex/i.test(h.value)),
    `vercel.json: для /${p}/* немає заголовка X-Robots-Tag: noindex — гостьові посилання можуть потрапити в пошук`,
  );
  check(new RegExp(`^\\s*Disallow:\\s*/${p}/`, 'm').test(robots), `robots.txt: немає рядка Disallow: /${p}/`);
}

// Шлях гостьової адреси несе токен, а в особистому посиланні ще й ключ гостя.
// Referrer-Policy вирішує, чи піде цей шлях у магазин, коли гість натисне на
// товар. Безпечні лише політики, які за межі сайту шлях не віддають;
// `unsafe-url` і `no-referrer-when-downgrade` віддають його повністю (ADR-041).
const referrer = vercel.headers
  ?.filter((h) => h.source === '/(.*)')
  .flatMap((h) => h.headers ?? [])
  .find((h) => h.key === 'Referrer-Policy')?.value;
const SAFE_REFERRER = ['no-referrer', 'same-origin', 'origin', 'strict-origin', 'origin-when-cross-origin', 'strict-origin-when-cross-origin'];
check(
  SAFE_REFERRER.includes(referrer?.trim()),
  `vercel.json: Referrer-Policy «${referrer ?? 'немає'}» — шлях гостьової адреси з токеном і ключем може піти в магазин. Дозволено: ${SAFE_REFERRER.join(', ')}`,
);

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
for (const p of GUEST_PREFIXES) {
  check(
    new RegExp(`denylist:\\[[^\\]]*\\\\/${p}\\\\/`).test(sw),
    `sw.js: гостьові сторінки /${p}/ не виключені з навігації — токени й ключі гостей лягли б у кеш пристрою`,
  );
}
check(!/\.map"/.test(sw), 'sw.js: у кеш потрапили карти коду (.map)');

// Push-сповіщення (ADR-049): без обробника push браузер покаже «сайт оновився
// у фоні» замість сповіщення, а натиск нікуди не поведе.
check(/importScripts\(\s*"push-sw\.js"\s*\)/.test(sw), 'sw.js: не підключено push-sw.js (workbox.importScripts)');
const pushSw = await readFile(join(dist, 'push-sw.js'), 'utf8').catch(() => '');
check(
  pushSw.includes("addEventListener('push'") && pushSw.includes("addEventListener('notificationclick'"),
  'push-sw.js: немає обробників push і notificationclick',
);

// Android-застосунок (ADR-081): assetlinks.json має дійти до Chrome файлом.
// Service Worker не підміняє його на index.html, а vercel.json не переписує.
const assetlinks = await readFile(join(dist, '.well-known', 'assetlinks.json'), 'utf8').catch(() => '');
let assetlinksOk = false;
try {
  const target = JSON.parse(assetlinks)[0]?.target;
  assetlinksOk = target?.namespace === 'android_app' && Array.isArray(target.sha256_cert_fingerprints);
} catch { /* лишається false */ }
check(assetlinksOk, '.well-known/assetlinks.json: немає у збірці або не той вміст');
check(
  /denylist:\[[^\]]*well-known/.test(sw),
  'sw.js: /.well-known/ немає в navigateFallbackDenylist — Service Worker віддасть index.html замість assetlinks.json',
);
const spaRewrite = (vercel.rewrites ?? []).find((r) => r.destination === '/index.html');
check(
  spaRewrite && !new RegExp(`^${spaRewrite.source}$`).test('/.well-known/assetlinks.json'),
  'vercel.json: переписування на index.html зачіпає /.well-known/',
);

// ── Легше завантаження (ROADMAP 8.22) ────────────────────────────────────────
// Бібліотеки лежать окремими файлами (`manualChunks` у vite.config.ts), щоб
// реліз застосунку не змушував телефон перекачувати React і supabase-js.
// Хеш у назві файлу стабільний, лише поки файл бібліотек не імпортує нічого з
// коду застосунку: інакше хеш застосунку потрапляє в його вміст.
const assetNames = await readdir(join(dist, 'assets'));
/** Статичні імпорти чанка: `from"./x.js"` та `import"./x.js"` (не `import(…)`). */
const staticImports = (code) => [...code.matchAll(/(?:from|import)\s*"\.\/([^"]+\.js)"/g)].map((m) => m[1]);
for (const lib of ['vendor-react', 'vendor-supabase', 'vendor-dnd']) {
  const files = assetNames.filter((f) => f.startsWith(`${lib}-`) && f.endsWith('.js'));
  check(files.length === 1, `assets/: очікувано рівно один файл ${lib}-*.js, знайдено ${files.length} — перевір manualChunks у vite.config.ts`);
  for (const file of files) {
    const foreign = staticImports(await readFile(join(dist, 'assets', file), 'utf8')).filter((f) => !f.startsWith('vendor-'));
    check(
      foreign.length === 0,
      `assets/${file}: файл бібліотек імпортує код застосунку (${foreign.join(', ')}) — його хеш мінятиметься з кожним релізом`,
    );
    // Власникові без мережі бібліотеки потрібні так само, як і код застосунку.
    check(sw.includes(`assets/${file}`), `sw.js: ${file} немає в кеші оболонки — застосунок не відкриється без мережі`);
  }
}

// Головна сторінка одразу тягне лише вхідний файл і бібліотеки, потрібні всім.
// Екрани власника, перетягування, гостьова й код реєстрації Service Worker —
// ліниві (ADR-067): потрапивши сюди, вони їхали б і гостю.
const entryFile = html.match(/<script type="module"[^>]*\ssrc="\/assets\/([^"]+\.js)"/)?.[1];
check(entryFile, 'index.html: не знайдено вхідний скрипт застосунку');
const LAZY_ONLY = /^(OwnerScreens|GuestV2|GuestPartsV2|vendor-dnd|qrcode|workbox-window|locale-)/;
const eager = [
  ...[...html.matchAll(/<link rel="modulepreload"[^>]*\shref="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]),
  ...(entryFile ? staticImports(await readFile(join(dist, 'assets', entryFile), 'utf8')) : []),
];
for (const file of new Set(eager)) {
  check(/^vendor-(react|supabase)-/.test(file), `вхідний пакет одразу тягне ${file} — очікувано лише vendor-react і vendor-supabase`);
  check(!LAZY_ONLY.test(file), `вхідний пакет одразу тягне лінивий чанк ${file} — він поїхав би й гостю`);
}

// Словник лише активної мови (ROADMAP 8.24): кожна мова — свій чанк
// `locale-<мова>-*.js` (`manualChunks` у vite.config.ts), і `lib/i18n.tsx`
// довантажує тільки потрібний. Усі три — у кеші оболонки: власник перемикає
// мову й без мережі. А тексти словників не мають осісти в жодному іншому
// файлі — інакше всі три мови знову їхали б кожному (статичний імпорт JSON
// замість `import()` повернув би їх у головний пакет).
const jsFiles = assetNames.filter((f) => f.endsWith('.js'));
for (const locale of ['uk', 'pl', 'en']) {
  const files = jsFiles.filter((f) => f.startsWith(`locale-${locale}-`));
  check(files.length === 1, `assets/: очікувано рівно один файл locale-${locale}-*.js, знайдено ${files.length} — перевір manualChunks у vite.config.ts і import() у lib/i18n.tsx`);
  for (const file of files) {
    check(sw.includes(`assets/${file}`), `sw.js: ${file} немає в кеші оболонки — без мережі мову ${locale} не ввімкнути`);
  }
  // Проби — найдовші рядки словника: вони точно не збігаються з кодом.
  const values = [];
  const walk = (node) => {
    for (const v of Object.values(node)) {
      if (typeof v === 'string') values.push(v);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(JSON.parse(await readFile(join(dist, '..', 'src', 'i18n', `${locale}.json`), 'utf8')));
  const probes = values.filter((v) => !/["\\\n]/.test(v)).sort((a, b) => b.length - a.length).slice(0, 5);
  for (const file of jsFiles.filter((f) => !f.startsWith('locale-'))) {
    const code = await readFile(join(dist, 'assets', file), 'utf8');
    const leaked = probes.filter((p) => code.includes(p));
    check(leaked.length === 0, `assets/${file}: містить тексти словника ${locale}.json — словники мають їхати лише своїм чанком locale-${locale}`);
  }
}

// На гостьових адресах Service Worker не реєструється (components/UpdatePrompt.tsx).
// Список префіксів там свій — `lib/guestPath.ts`; він мусить покривати ті самі
// префікси, що й решта захистів. Саму поведінку в браузері перевіряє `npm run test:sw`.
const guestPathSrc = await readFile(join(dist, '..', 'src', 'lib', 'guestPath.ts'), 'utf8').catch(() => '');
for (const p of GUEST_PREFIXES) {
  check(
    guestPathSrc.includes(`'/${p}/'`),
    `src/lib/guestPath.ts: немає префікса '/${p}/' — на гостьовій /${p}/* реєструвався б Service Worker`,
  );
}

if (failures.length) {
  console.error('PWA: знайдено проблеми:\n- ' + failures.join('\n- '));
  process.exit(1);
}
console.log('PWA: маніфест, іконки, Service Worker і розбиття пакета в порядку.');
