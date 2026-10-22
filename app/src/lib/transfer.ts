import {
  CURRENCIES,
  PRIORITIES,
  STATUSES,
  VARIANTS_MAX,
  VARIANT_LABEL_MAX,
  VARIANT_VALUE_MAX,
} from './types';
import { groupItems } from './order';
import { parsePrice as parsePriceField } from './itemsView';
import { dateTextToIso, isoToDateText } from './dateText';
import type { Currency, Item, ItemPriority, ItemStatus, ItemVariant, List, Section } from './types';

/**
 * Експорт та імпорт списків (ROADMAP 6.3).
 *
 * Чисті функції: ні React, ні мережі, ні DOM — щоб правила формату можна було
 * перевіряти тестами без браузера (tests/e2e/transfer.spec.ts).
 *
 * Що НЕ потрапляє у вивантаження, і це не недогляд:
 * - **броні** — власник їх не бачить ніде, і файл не має ставати обхідним
 *   шляхом (CLAUDE.md §3.2);
 * - **токени спільних посилань** — секрет, який не лягає ні в кеш, ні в файл
 *   (CLAUDE.md §3.5);
 * - **id, owner_id, created_at** — файл описує вміст, а не рядки конкретної
 *   бази, тож його можна внести в інший акаунт.
 *
 * Розділи (ADR-036) їдуть назвами: колонка `section` у CSV, `list.sections`
 * і `section` позиції в JSON. Позиції у файлі стоять у порядку гостя —
 * розділи по черзі, «Інше» в кінці, — тож імпорт відтворює і розділи, і
 * ручний порядок, не знаючи жодного `id`.
 *
 * Перевірки нижче повторюють `check`-обмеження зі схеми (CLAUDE.md §4): людина
 * має побачити зрозумілу підказку в попередньому перегляді, а не `400` від бази.
 */

export const TRANSFER_FORMAT = 'wishlist-personal';
export const TRANSFER_VERSION = 1;

/** Більше за раз не приймаємо: сторінка попереднього перегляду стає некерованою. */
export const MAX_IMPORT_ITEMS = 1000;

export const CSV_COLUMNS = [
  'title',
  'url',
  'price',
  'quantity',
  'priority',
  'status',
  'note',
  'image_url',
  // Нова колонка стоїть у кінці: файли, збережені до появи ознак, читаються
  // далі без змін, а чужі таблиці зі старим набором колонок не ламаються.
  'variants',
  // Валюта ціни позиції (ADR-051). Порожньо — валюта списку, як у файлах до неї.
  'currency',
  // Назва розділу (ADR-036). Порожньо — «Інше», як у файлах до розділів.
  'section',
] as const;

export type TransferItem = {
  title: string;
  url: string | null;
  price: number | null;
  quantity: number;
  priority: ItemPriority;
  status: ItemStatus;
  note: string | null;
  image_url: string | null;
  variants: ItemVariant[];
  /** Валюта ціни (ADR-051); null — валюта списку. */
  currency: Currency | null;
  /** Назва розділу (ADR-036); null — «Інше». */
  section: string | null;
};

export type TransferList = {
  title: string;
  description: string | null;
  currency: Currency;
  event_date: string | null;
  /** Розділи в порядку власника, назвами; порожні теж — їх створив власник. */
  sections: string[];
};

/**
 * Зауваження до рядка файлу.
 *
 * `error` — рядок не імпортується; `warning` — поле очищено або підставлено
 * усталене значення, решта рядка придатна. Текст не тут: повідомлення
 * перекладаються за ключем уже в інтерфейсі (CLAUDE.md §4).
 */
export type Issue = {
  level: 'error' | 'warning';
  /** Номер рядка у файлі, як його бачить людина; 0 — про файл у цілому. */
  row: number;
  key: string;
  vars?: Record<string, string | number>;
};

export type ParseResult = {
  list: TransferList;
  items: TransferItem[];
  issues: Issue[];
};

/* ── Вивантаження ───────────────────────── */

const TITLE_MAX = 200;
const LIST_TITLE_MAX = 120;
const DESCRIPTION_MAX = 2000;
const NOTE_MAX = 1000;
const URL_MAX = 2048;
const QUANTITY_MAX = 999;
/** Межа з `sections.title` (той самий `SECTION_TITLE_MAX` у `sections.ts`). */
const SECTION_TITLE_MAX = 60;
/** numeric(12,2): десять цифр до крапки й дві після. */
const PRICE_MAX = 9_999_999_999.99;

function priceOut(value: number | string | null): string {
  if (value === null || value === '') return '';
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n.toFixed(2) : '';
}

export function toTransferItem(item: Item, section: string | null = null): TransferItem {
  const n = item.price === null || item.price === '' ? null : Number(item.price);
  return {
    title: item.title,
    url: item.url,
    price: n !== null && Number.isFinite(n) ? n : null,
    quantity: item.quantity,
    priority: item.priority,
    status: item.status,
    note: item.note,
    image_url: item.image_url,
    variants: item.variants ?? [],
    currency: item.currency ?? null,
    section,
  };
}

/**
 * Позиції в порядку гостя з назвою розділу: розділи за порядком власника,
 * усередині — ручний порядок, «Інше» в кінці (`groupItems`). Так файл
 * читається як сторінка списку, а імпорт відтворює порядок без `position`.
 */
export function exportItems(items: Item[], sections: Section[] = []): TransferItem[] {
  return groupItems(items, ordered(sections)).flatMap((g) =>
    g.items.map((i) => toTransferItem(i, g.section?.title ?? null)),
  );
}

/** Порядок розділів власника — той самий, що віддає `fetchSections`. */
function ordered(sections: Section[]): Section[] {
  return [...sections].sort((a, b) => a.position - b.position || (a.created_at < b.created_at ? -1 : 1));
}

function sectionTitles(sections: Section[]): string[] {
  return ordered(sections).map((s) => s.title);
}

/**
 * Ознаки в одній клітинці CSV — як JSON.
 *
 * Це єдиний запис, що точно повертається назад: підпис або значення можуть
 * містити і крапку з комою, і двокрапку, і будь-який роздільник, який ми б
 * вибрали. Читач приймає й людський запис «Розмір: M; Колір: чорний» — саме
 * так ознаки допишуть руками в таблиці.
 */
function variantsOut(variants: ItemVariant[]): string {
  return variants.length ? JSON.stringify(variants) : '';
}

export function toJson(list: List, items: Item[], sections: Section[] = []): string {
  const payload = {
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    exported_at: new Date().toISOString(),
    list: {
      title: list.title,
      description: list.description,
      currency: list.currency,
      event_date: list.event_date,
      sections: sectionTitles(sections),
    },
    items: exportItems(items, sections),
  };
  return JSON.stringify(payload, null, 2) + '\n';
}

/**
 * «Мої дані» (потік I3): усі списки з позиціями й опис посилань одним файлом.
 *
 * Це файл на збереження, не на імпорт: імпорт приймає файл одного списку
 * (ADR-027), а кожен запис у `lists` — той самий список і позиції, що й у
 * ньому. Адрес посилань тут немає: токен — ключ до гостьової сторінки, а
 * файл живе далі без нас (CLAUDE.md §3.5). Позначок гостей немає тим паче —
 * їх не бачить і сам власник (§3.2).
 */
export const ACCOUNT_FORMAT = 'wishlist-personal-account';

export type AccountShare = {
  title: string;
  list_title: string | null;
  created_at: string;
  expires_at: string | null;
  revoked_at: string | null;
  view_count: number;
  items_count: number;
};

export function toAccountJson(
  lists: { list: List; items: Item[]; sections?: Section[] }[],
  shares: AccountShare[],
  now = new Date().toISOString(),
): string {
  const payload = {
    format: ACCOUNT_FORMAT,
    version: TRANSFER_VERSION,
    exported_at: now,
    lists: lists.map(({ list, items, sections = [] }) => ({
      list: {
        title: list.title,
        description: list.description,
        currency: list.currency,
        event_date: list.event_date,
        sections: sectionTitles(sections),
      },
      items: exportItems(items, sections),
    })),
    shares,
  };
  return JSON.stringify(payload, null, 2) + '\n';
}

/** Екранування за RFC 4180 плюс захист від формул у таблицях. */
function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let s = String(value);
  // Клітинка, що починається з =, +, - або @, у Excel і Calc стає формулою.
  // Апостроф попереду лишає її текстом і не змінює прочитаного значення.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",;\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(items: Item[], sections: Section[] = []): string {
  const rows = [CSV_COLUMNS.join(',')];
  for (const t of exportItems(items, sections)) {
    rows.push(
      [
        csvCell(t.title),
        csvCell(t.url),
        priceOut(t.price),
        csvCell(t.quantity),
        csvCell(t.priority),
        csvCell(t.status),
        csvCell(t.note),
        csvCell(t.image_url),
        csvCell(variantsOut(t.variants)),
        csvCell(t.currency),
        csvCell(t.section),
      ].join(','),
    );
  }
  // BOM: без нього Excel на Windows читає UTF-8 як cp1251 і псує кирилицю.
  // CRLF — той кінець рядка, який очікують таблиці.
  return '﻿' + rows.join('\r\n') + '\r\n';
}

/** Ім'я файлу з назви списку: без службових символів, не порожнє. */
export function fileName(listTitle: string, ext: 'csv' | 'json'): string {
  const clean = listTitle
    .trim()
    .replace(/[\\/:*?"<>|]/g, '')
    .replace(/\s+/g, '-');
  // Межа — у символах, а не в одиницях UTF-16: емодзі на межі не розрізаємо (BUG-QA-17).
  const base = Array.from(clean).slice(0, 60).join('') || 'wishlist';
  const day = new Date().toISOString().slice(0, 10);
  return `${base}-${day}.${ext}`;
}

/* ── Розбір CSV ─────────────────────────── */

/**
 * Розділювач вибирає сам файл.
 *
 * Excel у частині локалей (українська, польська) зберігає CSV із крапкою з
 * комою, бо кома там — десятковий роздільник. Свій експорт пишемо комою, але
 * читаємо обидва варіанти: інакше найпоширеніший спосіб відредагувати файл
 * ламав би імпорт.
 */
function detectSeparator(headerLine: string): ',' | ';' {
  const outside = headerLine.replace(/"[^"]*"/g, '');
  return (outside.match(/;/g)?.length ?? 0) > (outside.match(/,/g)?.length ?? 0) ? ';' : ',';
}

/** Розбір за RFC 4180: лапки, подвоєні лапки всередині, переноси рядків у полі. */
export function parseCsv(text: string, sep: ',' | ';'): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];

    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
      continue;
    }

    if (ch === '"') quoted = true;
    else if (ch === sep) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }

  if (cell !== '' || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/* ── Перевірка значень ──────────────────── */

/**
 * Значення поля як текст. Приводимо лише примітиви (BUG-QA-26): обʼєкт із
 * файлу може мати будь-який `toString` — зокрема `null`, і тоді `String()`
 * кидає `TypeError` замість зрозумілого зауваження до рядка. Обʼєкт у полі,
 * де чекали текст чи число, — це порожнє поле: назва дасть
 * `titleRequired`, решта — усталене значення.
 */
function trimmed(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value).trim();
  return '';
}

/**
 * Довжина й обрізання — у символах (code points), а не в одиницях UTF-16
 * (BUG-QA-25). Так рахує і база: `length(text)` у PostgreSQL — це символи.
 * `slice` за UTF-16 міг розрізати емодзі навпіл і лишити самотній
 * сурогат — рядок, який не є валідним UTF-8 і якого база не прийме.
 */
function charLength(s: string): number {
  return Array.from(s).length;
}

function clip(s: string, max: number): string {
  return charLength(s) > max ? Array.from(s).slice(0, max).join('') : s;
}

/**
 * Гроші до копійок за десятковим записом числа, половина — вгору.
 * `Math.round(n * 100) / 100` тут помиляється: 12.345 * 100 у двійковій
 * арифметиці — 1234.4999…, і виходило б 12.34 (CLAUDE.md §4: гроші не
 * рахуємо у float). `String(n)` дає найкоротший запис, що читається назад у
 * те саме число, — тобто саме те, що написано у файлі.
 */
function roundToCents(n: number): number {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(String(n));
  // Експоненційний запис для невідʼємних цін у межах PRICE_MAX буває лише
  // для крихітних значень (1e-7) — вони округлюються до нуля.
  if (!m) return n < 0.005 ? 0 : Math.round(n * 100) / 100;
  const frac = (m[2] ?? '').padEnd(3, '0');
  const cents = Number(m[1]) * 100 + Number(frac.slice(0, 2)) + (frac.charCodeAt(2) >= 53 /* '5' */ ? 1 : 0);
  return cents / 100;
}

/**
 * Ціна з клітинки — за тими самими правилами, що й поле форми (BUG-QA-14):
 * «123.45», «1 234,56», «1.240,50», «1,240.50». `Number()` тут не годиться —
 * він читає «1e3» як 1000, а «0x10» як 16.
 *
 * Єдиний додатковий випадок — дріб із чотирьох і більше цифр через крапку:
 * таблиця й JavaScript так пишуть неокруглені числа («19.990000000000002»).
 * Три цифри — це вже розряди («1.240» = 1240), як і в полі форми.
 */
function parsePrice(raw: string): number | null {
  const s = raw.trim();
  if (s === '') return null;
  const field = parsePriceField(s);
  if (field.value !== null) return field.value;
  if (/^\d+\.\d{4,}$/.test(s)) return Number(s);
  return NaN;
}

function checkUrl(raw: string, row: number, field: string, issues: Issue[]): string | null {
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw) || raw.length > URL_MAX) {
    issues.push({ level: 'warning', row, key: 'transfer.issues.url', vars: { field } });
    return null;
  }
  return raw;
}

/**
 * Ознаки з клітинки: приймається і JSON, і запис «Розмір: M; Колір: чорний».
 *
 * Пробільні символи згортаються в один пробіл: база не приймає переносів рядка
 * й табуляцій усередині ознаки, а в клітинці CSV вони цілком можливі. Це
 * мовчазне виправлення, а не попередження, — людина не помітить різниці.
 */
function parseVariants(raw: string, row: number, issues: Issue[]): ItemVariant[] {
  if (!raw) return [];

  const flat = (s: string) => s.replace(/\s+/g, ' ').trim();
  let pairs: ItemVariant[];

  if (raw.startsWith('[')) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      issues.push({ level: 'warning', row, key: 'transfer.issues.variants', vars: { value: raw.slice(0, 40) } });
      return [];
    }
    if (!Array.isArray(parsed)) {
      issues.push({ level: 'warning', row, key: 'transfer.issues.variants', vars: { value: raw.slice(0, 40) } });
      return [];
    }
    pairs = parsed.map((entry) => {
      const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
      return { label: flat(trimmed(record.label)), value: flat(trimmed(record.value)) };
    });
  } else {
    pairs = raw.split(';').map((part) => {
      const at = part.indexOf(':');
      return at < 0
        ? { label: '', value: flat(part) }
        : { label: flat(part.slice(0, at)), value: flat(part.slice(at + 1)) };
    });
  }

  // Напівзаповнена пара нічого не означає: ні підказки гостю, ні даних.
  const filled = pairs.filter((p) => p.label !== '' || p.value !== '');
  let out = filled.filter((p) => p.label !== '' && p.value !== '');
  if (out.length < filled.length) {
    issues.push({ level: 'warning', row, key: 'transfer.issues.variants', vars: { value: raw.slice(0, 40) } });
  }

  const trimmedPairs = out.map((p) => ({
    label: clip(p.label, VARIANT_LABEL_MAX),
    value: clip(p.value, VARIANT_VALUE_MAX),
  }));
  if (trimmedPairs.some((p, i) => p.label !== out[i]?.label || p.value !== out[i]?.value)) {
    issues.push({ level: 'warning', row, key: 'transfer.issues.variantsLong' });
  }
  out = trimmedPairs;

  if (out.length > VARIANTS_MAX) {
    issues.push({ level: 'warning', row, key: 'transfer.issues.variantsMany' });
    out = out.slice(0, VARIANTS_MAX);
  }
  return out;
}

/** Один рядок таблиці → позиція. `null`, якщо рядок непридатний. */
/** Назва розділу з клітинки: пробіли згорнуто, задовга — обрізано з попередженням. */
function parseSection(raw: string, row: number, issues: Issue[]): string | null {
  const title = raw.replace(/\s+/g, ' ').trim();
  if (!title) return null;
  if (charLength(title) > SECTION_TITLE_MAX) {
    issues.push({ level: 'warning', row, key: 'transfer.issues.sectionLong', vars: { max: SECTION_TITLE_MAX } });
    return clip(title, SECTION_TITLE_MAX).trim();
  }
  return title;
}

/**
 * `numeric` — ціна, що у файлі вже є числом (JSON). Вона не проходить
 * правила тексту: «1.234» у клітинці — це розряди, тобто 1234, а JSON-число
 * 1.234 — однозначно одна ціла й 234 тисячних (BUG-QA-23).
 */
function rowToItem(
  get: (column: (typeof CSV_COLUMNS)[number]) => string,
  row: number,
  issues: Issue[],
  numeric?: { price?: number },
): TransferItem | null {
  const title = get('title');
  if (!title) {
    issues.push({ level: 'error', row, key: 'transfer.issues.titleRequired' });
    return null;
  }
  if (charLength(title) > TITLE_MAX) {
    issues.push({ level: 'error', row, key: 'transfer.issues.titleLong', vars: { max: TITLE_MAX } });
    return null;
  }

  let price: number | null = null;
  const rawPrice = get('price');
  if (rawPrice) {
    const n = numeric?.price ?? parsePrice(rawPrice);
    if (n === null || !Number.isFinite(n) || n < 0 || n > PRICE_MAX) {
      issues.push({ level: 'warning', row, key: 'transfer.issues.price', vars: { value: rawPrice } });
    } else {
      price = roundToCents(n);
    }
  }

  let quantity = 1;
  const rawQuantity = get('quantity');
  if (rawQuantity) {
    // Лише десяткові цифри (BUG-QA-15): Number() прийняв би «1e2» і «0x0A».
    const n = /^\d+$/.test(rawQuantity) ? Number(rawQuantity) : NaN;
    if (!Number.isInteger(n) || n < 1 || n > QUANTITY_MAX) {
      issues.push({ level: 'warning', row, key: 'transfer.issues.quantity', vars: { value: rawQuantity } });
    } else quantity = n;
  }

  const rawPriority = get('priority').toLowerCase();
  const priority = (PRIORITIES as string[]).includes(rawPriority)
    ? (rawPriority as ItemPriority)
    : 'medium';
  if (rawPriority && priority !== rawPriority) {
    issues.push({ level: 'warning', row, key: 'transfer.issues.priority', vars: { value: rawPriority } });
  }

  const rawStatus = get('status').toLowerCase();
  const status = (STATUSES as string[]).includes(rawStatus) ? (rawStatus as ItemStatus) : 'active';
  if (rawStatus && status !== rawStatus) {
    issues.push({ level: 'warning', row, key: 'transfer.issues.status', vars: { value: rawStatus } });
  }

  let note: string | null = get('note') || null;
  if (note && charLength(note) > NOTE_MAX) {
    note = clip(note, NOTE_MAX);
    issues.push({ level: 'warning', row, key: 'transfer.issues.noteLong', vars: { max: NOTE_MAX } });
  }

  // Порожньо — валюта списку. Незнайома валюта — зауваження, і ціна лишається
  // без валюти, тобто у валюті списку: так файл імпортувався й до ADR-051.
  const rawCurrency = get('currency').toUpperCase();
  const currency = (CURRENCIES as string[]).includes(rawCurrency) ? (rawCurrency as Currency) : null;
  if (rawCurrency && !currency) {
    issues.push({ level: 'warning', row, key: 'transfer.issues.itemCurrency', vars: { value: rawCurrency } });
  }

  return {
    title,
    currency,
    url: checkUrl(get('url'), row, 'url', issues),
    price,
    quantity,
    priority,
    status,
    note,
    image_url: checkUrl(get('image_url'), row, 'image_url', issues),
    variants: parseVariants(get('variants'), row, issues),
    section: parseSection(get('section'), row, issues),
  };
}

/**
 * Розділи списку: спершу ті, що перелічено у файлі (`list.sections` — разом
 * із порожніми), далі — назви з позицій у порядку першої появи. Однакові
 * назви — один розділ: у файлі їх нічим іншим не розрізнити.
 */
function collectSections(declared: unknown, items: TransferItem[], issues: Issue[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (title: string | null) => {
    if (title && !seen.has(title)) {
      seen.add(title);
      out.push(title);
    }
  };
  if (Array.isArray(declared)) {
    for (const entry of declared) add(parseSection(trimmed(entry), 0, issues));
  }
  for (const item of items) add(item.section);
  return out;
}

function checkList(
  raw: Partial<Omit<TransferList, 'sections'>>,
  fallbackTitle: string,
  issues: Issue[],
  sections: string[] = [],
): TransferList {
  let title = trimmed(raw.title) || fallbackTitle;
  if (charLength(title) > LIST_TITLE_MAX) {
    title = clip(title, LIST_TITLE_MAX).trim();
    issues.push({ level: 'warning', row: 0, key: 'transfer.issues.listTitleLong', vars: { max: LIST_TITLE_MAX } });
  }

  let description = trimmed(raw.description) || null;
  if (description && charLength(description) > DESCRIPTION_MAX) {
    description = clip(description, DESCRIPTION_MAX);
    issues.push({ level: 'warning', row: 0, key: 'transfer.issues.descriptionLong', vars: { max: DESCRIPTION_MAX } });
  }

  const rawCurrency = trimmed(raw.currency).toUpperCase();
  const currency = (CURRENCIES as string[]).includes(rawCurrency) ? (rawCurrency as Currency) : 'PLN';
  if (rawCurrency && currency !== rawCurrency) {
    issues.push({ level: 'warning', row: 0, key: 'transfer.issues.currency', vars: { value: rawCurrency } });
  }

  // Справжня календарна дата за тими самими правилами, що й поле форми
  // (BUG-QA-24): «2026-02-29» чи «2026-04-31» мають вигляд дати, але в
  // колонку `date` не лягають.
  const rawDate = trimmed(raw.event_date);
  const eventDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) && dateTextToIso(isoToDateText(rawDate)) === rawDate
    ? rawDate
    : null;
  if (rawDate && !eventDate) {
    issues.push({ level: 'warning', row: 0, key: 'transfer.issues.eventDate', vars: { value: rawDate } });
  }

  return { title, description, currency, event_date: eventDate, sections };
}

function capItems(items: TransferItem[], issues: Issue[]): TransferItem[] {
  if (items.length <= MAX_IMPORT_ITEMS) return items;
  issues.push({
    level: 'warning',
    row: 0,
    key: 'transfer.issues.tooMany',
    vars: { max: MAX_IMPORT_ITEMS, count: items.length },
  });
  return items.slice(0, MAX_IMPORT_ITEMS);
}

/* ── Розбір файлу ───────────────────────── */

export function parseCsvFile(text: string, fallbackTitle: string): ParseResult {
  const issues: Issue[] = [];
  const body = text.replace(/^﻿/, '');
  const firstLine = body.slice(0, body.search(/\r?\n/) === -1 ? body.length : body.search(/\r?\n/));
  const rows = parseCsv(body, detectSeparator(firstLine)).filter((r) => r.some((c) => c.trim() !== ''));

  if (rows.length === 0) {
    issues.push({ level: 'error', row: 0, key: 'transfer.issues.empty' });
    return { list: checkList({}, fallbackTitle, issues), items: [], issues };
  }

  const header = (rows[0] ?? []).map((h) => h.trim().toLowerCase().replace(/^'/, ''));
  const index = new Map(CSV_COLUMNS.map((c) => [c, header.indexOf(c)]));
  if ((index.get('title') ?? -1) < 0) {
    issues.push({ level: 'error', row: 1, key: 'transfer.issues.noTitleColumn' });
    return { list: checkList({}, fallbackTitle, issues), items: [], issues };
  }

  const items: TransferItem[] = [];
  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i] ?? [];
    const get = (column: (typeof CSV_COLUMNS)[number]) => {
      const at = index.get(column) ?? -1;
      // Апостроф, доданий проти формул, прибираємо назад — інакше він осів би в назві.
      return at < 0 ? '' : trimmed(cells[at]).replace(/^'(?=[=+\-@])/, '');
    };
    const item = rowToItem(get, i + 1, issues);
    if (item) items.push(item);
  }

  const kept = capItems(items, issues);
  return { list: checkList({}, fallbackTitle, issues, collectSections(null, kept, issues)), items: kept, issues };
}

export function parseJsonFile(text: string, fallbackTitle: string): ParseResult {
  const issues: Issue[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    issues.push({ level: 'error', row: 0, key: 'transfer.issues.badJson' });
    return { list: checkList({}, fallbackTitle, issues), items: [], issues };
  }

  if (!raw || typeof raw !== 'object') {
    issues.push({ level: 'error', row: 0, key: 'transfer.issues.badJson' });
    return { list: checkList({}, fallbackTitle, issues), items: [], issues };
  }

  const obj = raw as Record<string, unknown>;
  // Приймаємо і повний файл експорту, і просто масив позицій — так простіше
  // зібрати список із чогось стороннього.
  const rawItems = Array.isArray(raw) ? raw : Array.isArray(obj.items) ? obj.items : null;
  if (!rawItems) {
    issues.push({ level: 'error', row: 0, key: 'transfer.issues.noItems' });
    return { list: checkList({}, fallbackTitle, issues), items: [], issues };
  }

  if (typeof obj.format === 'string' && obj.format !== TRANSFER_FORMAT) {
    issues.push({ level: 'warning', row: 0, key: 'transfer.issues.foreignFormat', vars: { format: obj.format } });
  }

  const items: TransferItem[] = [];
  rawItems.forEach((entry, i) => {
    const record = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    // Ознаки у JSON-файлі — справжній масив, а не рядок. Повертаємо його як
    // JSON-текст: далі обидва формати читає одна й та сама `parseVariants`.
    const get = (column: (typeof CSV_COLUMNS)[number]) => {
      const raw = record[column];
      return Array.isArray(raw) ? JSON.stringify(raw) : trimmed(raw);
    };
    const rawPrice = record.price;
    const item = rowToItem(get, i + 1, issues, typeof rawPrice === 'number' ? { price: rawPrice } : undefined);
    if (item) items.push(item);
  });

  const listRaw = (obj.list && typeof obj.list === 'object' ? obj.list : {}) as Record<string, unknown>;
  const kept = capItems(items, issues);
  return {
    list: checkList(listRaw as Partial<TransferList>, fallbackTitle, issues, collectSections(listRaw.sections, kept, issues)),
    items: kept,
    issues,
  };
}

/** Формат обираємо за розширенням, а якщо його немає — за вмістом. */
export function parseFile(name: string, text: string, fallbackTitle: string): ParseResult {
  const isJson = /\.json$/i.test(name) || (!/\.csv$/i.test(name) && text.trimStart().startsWith('{')) ||
    (!/\.csv$/i.test(name) && text.trimStart().startsWith('['));
  return isJson ? parseJsonFile(text, fallbackTitle) : parseCsvFile(text, fallbackTitle);
}
