// Створює app/.env.localdb.local з даних запущеного локального Supabase.
//   npm run env:local
//
// Файл у .gitignore (шаблон *.local), тож він зникає разом із node_modules і
// після кожного свіжого клону, а ключ ще й змінюється після stop/start із
// перезбиранням тому. Раніше це доводилось щоразу переносити руками з виводу
// `npx supabase status` — і саме розбіжність ключа давала мовчазне падіння
// всіх E2E з акаунтом.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const target = join(appDir, '.env.localdb.local');

// Ключі, якими ми керуємо. Решту рядків файлу лишаємо як є: там можуть бути
// власні перевизначення, наприклад справжня адреса парсера.
const MANAGED = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_PUBLISHABLE_KEY'];

function status() {
  try {
    return execFileSync('npx', ['supabase', 'status', '-o', 'env'], {
      cwd: join(appDir, '..'),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
    });
  } catch (e) {
    const out = `${e.stdout ?? ''}${e.stderr ?? ''}`.trim();
    console.error(
      'Не вдалося прочитати стан локального Supabase.\n' +
        'Спершу підніми його: npx supabase start\n' +
        (out ? `\nВивід CLI:\n${out}\n` : ''),
    );
    process.exit(1);
  }
}

/** KEY="value" → Map. CLI лапкує значення, але на це не покладаємось. */
function parseEnv(text) {
  const map = new Map();
  for (const line of text.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line.trim());
    if (m) map.set(m[1], m[2].replace(/^["']|["']$/g, ''));
  }
  return map;
}

const values = parseEnv(status());
const url = values.get('API_URL');
// Назва ключа змінювалась між версіями CLI: спершу ANON_KEY, потім publishable.
const key = values.get('PUBLISHABLE_KEY') ?? values.get('ANON_KEY');

if (!url || !key) {
  console.error(
    'У виводі `supabase status -o env` немає API_URL або ключа.\n' +
      `Знайдено: ${[...values.keys()].join(', ') || '(порожньо)'}\n` +
      'Схоже, змінився формат виводу CLI — заповни app/.env.localdb.local вручну (SETUP.md, розділ 8).',
  );
  process.exit(1);
}

const kept = existsSync(target)
  ? readFileSync(target, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.trim() && !MANAGED.some((k) => l.startsWith(`${k}=`)))
  : [
      // Тест «Заповнити» без адреси парсера пропускається; фіктивна адреса
      // вмикає його, а відповідь підставляє сам тест (TESTING.md).
      'VITE_PARSER_URL=http://parser.invalid',
    ];

const body = [`VITE_SUPABASE_URL=${url}`, `VITE_SUPABASE_PUBLISHABLE_KEY=${key}`, ...kept];
writeFileSync(target, body.join('\n') + '\n', 'utf8');

console.log(`app/.env.localdb.local оновлено: ${url}, ключ ${key.slice(0, 12)}…`);
