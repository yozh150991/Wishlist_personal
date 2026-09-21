/**
 * Аудит палітр: контраст кожної пари «фарба на фарбі», яка реально трапляється
 * в інтерфейсі, у кожній із шести палітр (три схеми × дві теми).
 *
 * Числа рахуються з `src/styles/tokens.css`, а не вписані сюди руками: інакше
 * таблиця почала б розходитися з тим, що бачить користувач, і мовчки.
 *
 * Пороги WCAG AA: 4,5:1 для тексту, 3:1 для нетекстових індикаторів —
 * смужки пріоритету й кільце фокуса.
 *
 * Додаєш палітру — вона автоматично потрапляє в прогін. Додаєш пару кольорів
 * у компонентах — додай її і сюди, інакше вона лишиться неперевіреною.
 *
 * Запуск: npm run check:contrast   (у CI — разом із typecheck і збіркою)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const SRC = join(here, '..', 'src');
const TOKENS = join(SRC, 'styles', 'tokens.css');

/** Схеми й теми, які мусять існувати. Порядок — порядок колонок у таблиці. */
const PALETTES = [
  { scheme: 'sage', theme: 'light', short: 'Шавлія св.' },
  { scheme: 'sage', theme: 'dark', short: 'Шавлія тм.' },
  { scheme: 'slyva', theme: 'light', short: 'Слива св.' },
  { scheme: 'slyva', theme: 'dark', short: 'Слива тм.' },
  { scheme: 'vuhil', theme: 'light', short: 'Вугіль св.' },
  { scheme: 'vuhil', theme: 'dark', short: 'Вугіль тм.' },
];

/**
 * Обов'язковий склад палітри. Пропущений токен не ламає сторінку, а тихо падає
 * на значення з :root — саме так темні схеми колись отримали світлі значки.
 */
const REQUIRED = [
  '--color-bg', '--color-surface', '--color-text', '--color-divider',
  ...Array.from({ length: 9 }, (_, i) => `--color-neutral-${i + 1}00`),
  '--color-accent',
  ...Array.from({ length: 9 }, (_, i) => `--color-accent-${i + 1}00`),
  '--color-accent-2',
  ...Array.from({ length: 9 }, (_, i) => `--color-accent-2-${i + 1}00`),
  '--color-danger', '--color-danger-bg', '--color-danger-ink', '--color-danger-line',
  '--color-guest-bg', '--color-guest-header', '--color-guest-card',
  '--color-primary-fill', '--color-primary-ink', '--color-ghost-ink',
  '--color-prio-high', '--color-prio-low',
];

/** [підпис, чорнило, тло, поріг] — те, що справді накладається одне на одне. */
const PAIRS = [
  ['Текст на фоні', '--color-text', '--color-bg', 4.5],
  ['Текст на поверхні', '--color-text', '--color-surface', 4.5],
  ['Приглушений текст на фоні', '--color-neutral-700', '--color-bg', 4.5],
  ['Приглушений текст на поверхні', '--color-neutral-700', '--color-surface', 4.5],
  ['Підпис головної кнопки', '--color-primary-ink', '--color-primary-fill', 4.5],
  ['Кнопка-привид на фоні', '--color-ghost-ink', '--color-bg', 4.5],
  ['Кнопка-привид на поверхні', '--color-ghost-ink', '--color-surface', 4.5],
  ['Активний пункт навігації', '--color-accent-800', '--color-accent-200', 4.5],
  ['Значок «Високий»', '--color-accent-800', '--color-accent-100', 4.5],
  ['Значок «Низький»', '--color-accent-2-800', '--color-accent-2-100', 4.5],
  ['Значок нейтральний', '--color-neutral-800', '--color-neutral-100', 4.5],
  ['Банер небезпеки', '--color-danger-ink', '--color-danger-bg', 4.5],
  ['«Видалити» на поверхні', '--color-danger', '--color-surface', 4.5],
  ['Шапка режиму вибору', '--color-bg', '--color-accent-800', 4.5],
  ['Гостьовий заголовок', '--color-accent-900', '--color-guest-header', 4.5],
  ['Текст на гостьовій картці', '--color-text', '--color-guest-card', 4.5],
  ['Приглушений на гостьовій картці', '--color-neutral-700', '--color-guest-card', 4.5],
  ['Текст на гостьовому фоні', '--color-text', '--color-guest-bg', 4.5],
  ['Смужка «Високий»', '--color-prio-high', '--color-surface', 3],
  ['Смужка «Низький»', '--color-prio-low', '--color-surface', 3],
  ['Підпис кнопки видалення', '--color-bg', '--color-danger', 4.5],
  ['Підпис у тості', '--color-bg', '--color-accent-2-700', 4.5],
  ['Кільце фокуса', '--color-accent-700', '--color-bg', 3],
  ['Кільце фокуса на поверхні', '--color-accent-700', '--color-surface', 3],
];

/** Читає блок токенів за селектором. Повертає Map або null, якщо блоку немає. */
function readBlock(css, selector) {
  const at = css.indexOf(selector + ' {');
  if (at === -1) return null;
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  const out = new Map();
  for (const [, name, value] of css
    .slice(open + 1, close)
    .matchAll(/(--color-[a-z0-9-]+)\s*:\s*([^;]+)/g)) {
    out.set(name, value.trim());
  }
  return out;
}

const srgb = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

function luminance(hex) {
  const [r, g, b] = [1, 3, 5].map((i) => srgb(parseInt(hex.slice(i, i + 2), 16) / 255));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a, b) {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}

const num = (v) => v.toFixed(2).replace('.', ',');

/**
 * Жодного літерального кольору поза tokens.css.
 *
 * Захардкоджений hex виглядає правильно рівно в одній палітрі, а в решті п'яти
 * тихо ламається — і помічають це не одразу. Тому перевірка механічна.
 */
function findHardcodedColors(dir, found = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      findHardcodedColors(full, found);
      continue;
    }
    if (full === TOKENS) continue;
    if (!/\.(css|ts|tsx)$/.test(entry.name)) continue;
    const text = readFileSync(full, 'utf8');
    text.split('\n').forEach((line, i) => {
      for (const [hex] of line.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        // Кольори бувають лише в CSS-значеннях і в рядках; решта — якірні
        // посилання, коментарі з ідентифікаторами тощо. Відсікаємо грубо:
        // справжній колір — це 3, 6 або 8 шістнадцяткових цифр.
        if (![4, 7, 9].includes(hex.length)) continue;
        found.push(`${relative(SRC, full)}:${i + 1} — ${hex}`);
      }
    });
  }
  return found;
}

function main() {
  const css = readFileSync(TOKENS, 'utf8');
  const problems = findHardcodedColors(SRC).map(
    (place) => `літеральний колір поза tokens.css: ${place}`,
  );

  // 1. Склад кожної палітри — повний.
  const sets = PALETTES.map((p) => {
    const selector = `[data-scheme='${p.scheme}'][data-theme='${p.theme}']`;
    const block = readBlock(css, selector);
    if (!block) {
      problems.push(`немає блоку ${selector} — палітра «${p.short}» не оголошена`);
      return { ...p, tokens: new Map() };
    }
    for (const token of REQUIRED) {
      if (!block.has(token)) problems.push(`${p.short}: не оголошено ${token}`);
    }
    return { ...p, tokens: block };
  });

  // 2. Контраст кожної пари в кожній палітрі.
  const worst = new Map();
  let tight = null;
  const rows = PAIRS.map(([label, fg, bg, min]) => {
    const cells = sets.map((set) => {
      const ink = set.tokens.get(fg);
      const back = set.tokens.get(bg);
      if (!ink || !back || !ink.startsWith('#') || !back.startsWith('#')) return '—';
      const r = ratio(ink, back);
      if (!worst.has(set.short) || r < worst.get(set.short)) worst.set(set.short, r);
      if (!tight || r - min < tight.margin) tight = { margin: r - min, r, min, label, short: set.short };
      if (r < min) {
        problems.push(
          `${set.short}: ${label} — ${num(r)}:1 проти порога ${num(min)} (${fg} на ${bg})`,
        );
        return num(r) + ' ✗';
      }
      return num(r);
    });
    return { label, min, cells };
  });

  // 3. Таблиця — той самий вигляд, що в макеті аудиту.
  const head = ['Пара'.padEnd(34), 'Поріг'.padStart(6), ...sets.map((s) => s.short.padStart(11))];
  console.log(head.join(' '));
  console.log('─'.repeat(head.join(' ').length));
  for (const row of rows) {
    console.log(
      [
        row.label.padEnd(34),
        num(row.min).padStart(6),
        ...row.cells.map((c) => c.padStart(11)),
      ].join(' '),
    );
  }
  console.log('─'.repeat(head.join(' ').length));
  console.log(
    ['мінімум у палітрі'.padEnd(34), ''.padStart(6),
      ...sets.map((s) => (worst.has(s.short) ? num(worst.get(s.short)) : '—').padStart(11))].join(' '),
  );

  const total = PAIRS.length * PALETTES.length;
  if (problems.length) {
    console.error(`\n✗ Аудит палітр не пройдено. Проблем: ${problems.length}`);
    for (const p of problems) console.error('  · ' + p);
    process.exit(1);
  }
  console.log(
    `\n✓ Пар: ${PAIRS.length}, палітр: ${PALETTES.length}, перевірок: ${total} — усі проходять.`,
  );
  console.log(
    `  Найтісніше місце — ${tight.label.toLowerCase()} у палітрі «${tight.short}»: ` +
      `${num(tight.r)}:1 проти порога ${num(tight.min)}, запас +${num(tight.margin)}.`,
  );
}

main();
