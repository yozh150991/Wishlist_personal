// Перевірка словників і місць, де їх викликають:
//   node scripts/check-i18n.mjs
// Падає з кодом 1, якщо ключі трьох мов розійшлися, якщо код просить ключ,
// якого немає, або якщо ключ із підстановкою викликають без значень.
//
// Останнє — не педантизм: `t('settings.signedInAs')` без другого аргументу
// виводив у бічну колонку «Ти увійшов як {email}» разом із дужками. Помилка
// не ламає ні збірку, ні типи, ні жоден тест — її видно тільки очима, і то
// якщо дивитися саме на ту мову, яку зламали.
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const app = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCALES = ['uk', 'pl', 'en'];
const BASE = 'uk';
const failures = [];

/** Пласка мапа «шлях.через.крапку» → рядок. */
function flatten(node, prefix = '', out = new Map()) {
  for (const [key, value] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) flatten(value, path, out);
    else out.set(path, String(value));
  }
  return out;
}

const placeholders = (text) => new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

const dicts = new Map();
for (const locale of LOCALES) {
  const raw = await readFile(join(app, 'src', 'i18n', `${locale}.json`), 'utf8');
  dicts.set(locale, flatten(JSON.parse(raw)));
}

// 1. Однаковий набір ключів у всіх мовах: пропущений ключ показує людині
//    англійський рядок посеред українського екрана.
const base = dicts.get(BASE);
for (const locale of LOCALES.filter((l) => l !== BASE)) {
  const dict = dicts.get(locale);
  for (const key of base.keys()) if (!dict.has(key)) failures.push(`${locale}.json: немає ключа ${key}`);
  for (const key of dict.keys()) if (!base.has(key)) failures.push(`${locale}.json: зайвий ключ ${key} (немає в ${BASE})`);
}

// 2. Однакові підстановки: перекладач легко втрачає {n} або пише {N}.
for (const [key, text] of base) {
  const want = placeholders(text);
  for (const locale of LOCALES.filter((l) => l !== BASE)) {
    const other = dicts.get(locale).get(key);
    if (other === undefined) continue;
    const got = placeholders(other);
    const missing = [...want].filter((p) => !got.has(p));
    const extra = [...got].filter((p) => !want.has(p));
    if (missing.length || extra.length) {
      failures.push(
        `${locale}.json: ключ ${key} має підстановки {${[...got].join('}, {')}}, ` +
          `а ${BASE} — {${[...want].join('}, {')}}`,
      );
    }
  }
}

/** Усі .ts/.tsx у src, крім згенерованих типів. */
async function sources(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(path)));
    else if (/\.tsx?$/.test(entry.name) && !path.includes(join('src', 'types'))) out.push(path);
  }
  return out;
}

// 3. Виклики в коді. Шукаємо тільки літеральні ключі: `t(key)` зі змінною
//    перевірити статично не можна, і таких у коді немає.
const CALL = /\bt\(\s*'([^']+)'\s*([,)])/g;
for (const file of await sources(join(app, 'src'))) {
  const text = await readFile(file, 'utf8');
  const where = (index) => `${relative(app, file)}:${text.slice(0, index).split('\n').length}`;
  for (const match of text.matchAll(CALL)) {
    const [, key, next] = match;
    if (!base.has(key)) {
      failures.push(`${where(match.index)}: ключа ${key} немає в словниках`);
      continue;
    }
    const want = placeholders(base.get(key));
    if (want.size && next === ')') {
      failures.push(
        `${where(match.index)}: ключ ${key} чекає {${[...want].join('}, {')}}, ` +
          'а викликаний без значень — дужки поїдуть в інтерфейс',
      );
    }
  }
}

if (failures.length) {
  console.error('i18n: знайдено проблеми:\n- ' + failures.join('\n- '));
  process.exit(1);
}
console.log(`i18n: ${base.size} ключів × ${LOCALES.length} мови, виклики в коді збігаються зі словниками.`);
