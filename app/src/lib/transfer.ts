import { CURRENCIES, PRIORITIES, STATUSES } from './types';
import type { Currency, Item, ItemPriority, ItemStatus, List } from './types';

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
};

export type TransferList = {
  title: string;
  description: string | null;
  currency: Currency;
  event_date: string | null;
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
/** numeric(12,2): десять цифр до крапки й дві після. */
const PRICE_MAX = 9_999_999_999.99;

function priceOut(value: number | string | null): string {
  if (value === null || value === '') return '';
  const n = typeof value === 'string' ? Number(value) : value;
  return Number.isFinite(n) ? n.toFixed(2) : '';
}

export function toTransferItem(item: Item): TransferItem {
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
  };
}

export function toJson(list: List, items: Item[]): string {
  const payload = {
    format: TRANSFER_FORMAT,
    version: TRANSFER_VERSION,
    exported_at: new Date().toISOString(),
    list: {
      title: list.title,
      description: list.description,
      currency: list.currency,
      event_date: list.event_date,
    },
    items: items.map(toTransferItem),
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

export function toCsv(items: Item[]): string {
  const rows = [CSV_COLUMNS.join(',')];
  for (const item of items) {
    const t = toTransferItem(item);
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
      ].join(','),
    );
  }
  // BOM: без нього Excel на Windows читає UTF-8 як cp1251 і псує кирилицю.
  // CRLF — той кінець рядка, який очікують таблиці.
  return '﻿' + rows.join('\r\n') + '\r\n';
}

/** Ім'я файлу з назви списку: без службових символів, не порожнє. */
export function fileName(listTitle: string, ext: 'csv' | 'json'): string {
  const base =
    listTitle
      .trim()
      .replace(/[\\/:*?"<>|]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 60) || 'wishlist';
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

function trimmed(value: unknown): string {
  return typeof value === 'string' ? value.trim() : value === null || value === undefined ? '' : String(value).trim();
}

/** Приймає і «123.45», і «1 234,56» — так ціну зберігає Excel у наших локалях. */
function parsePrice(raw: string): number | null {
  const cleaned = raw.replace(/[\s  ]/g, '').replace(',', '.');
  if (cleaned === '') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : NaN;
}

function checkUrl(raw: string, row: number, field: string, issues: Issue[]): string | null {
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw) || raw.length > URL_MAX) {
    issues.push({ level: 'warning', row, key: 'transfer.issues.url', vars: { field } });
    return null;
  }
  return raw;
}

/** Один рядок таблиці → позиція. `null`, якщо рядок непридатний. */
function rowToItem(
  get: (column: (typeof CSV_COLUMNS)[number]) => string,
  row: number,
  issues: Issue[],
): TransferItem | null {
  const title = get('title');
  if (!title) {
    issues.push({ level: 'error', row, key: 'transfer.issues.titleRequired' });
    return null;
  }
  if (title.length > TITLE_MAX) {
    issues.push({ level: 'error', row, key: 'transfer.issues.titleLong', vars: { max: TITLE_MAX } });
    return null;
  }

  let price: number | null = null;
  const rawPrice = get('price');
  if (rawPrice) {
    const n = parsePrice(rawPrice);
    if (n === null || Number.isNaN(n) || n < 0 || n > PRICE_MAX) {
      issues.push({ level: 'warning', row, key: 'transfer.issues.price', vars: { value: rawPrice } });
    } else {
      price = Math.round(n * 100) / 100;
    }
  }

  let quantity = 1;
  const rawQuantity = get('quantity');
  if (rawQuantity) {
    const n = Number(rawQuantity);
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
  if (note && note.length > NOTE_MAX) {
    note = note.slice(0, NOTE_MAX);
    issues.push({ level: 'warning', row, key: 'transfer.issues.noteLong', vars: { max: NOTE_MAX } });
  }

  return {
    title,
    url: checkUrl(get('url'), row, 'url', issues),
    price,
    quantity,
    priority,
    status,
    note,
    image_url: checkUrl(get('image_url'), row, 'image_url', issues),
  };
}

function checkList(raw: Partial<TransferList>, fallbackTitle: string, issues: Issue[]): TransferList {
  let title = trimmed(raw.title) || fallbackTitle;
  if (title.length > LIST_TITLE_MAX) {
    title = title.slice(0, LIST_TITLE_MAX);
    issues.push({ level: 'warning', row: 0, key: 'transfer.issues.listTitleLong', vars: { max: LIST_TITLE_MAX } });
  }

  let description = trimmed(raw.description) || null;
  if (description && description.length > DESCRIPTION_MAX) {
    description = description.slice(0, DESCRIPTION_MAX);
    issues.push({ level: 'warning', row: 0, key: 'transfer.issues.descriptionLong', vars: { max: DESCRIPTION_MAX } });
  }

  const rawCurrency = trimmed(raw.currency).toUpperCase();
  const currency = (CURRENCIES as string[]).includes(rawCurrency) ? (rawCurrency as Currency) : 'PLN';
  if (rawCurrency && currency !== rawCurrency) {
    issues.push({ level: 'warning', row: 0, key: 'transfer.issues.currency', vars: { value: rawCurrency } });
  }

  const rawDate = trimmed(raw.event_date);
  const eventDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : null;
  if (rawDate && !eventDate) {
    issues.push({ level: 'warning', row: 0, key: 'transfer.issues.eventDate', vars: { value: rawDate } });
  }

  return { title, description, currency, event_date: eventDate };
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

  return { list: checkList({}, fallbackTitle, issues), items: capItems(items, issues), issues };
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
    const get = (column: (typeof CSV_COLUMNS)[number]) => trimmed(record[column]);
    const item = rowToItem(get, i + 1, issues);
    if (item) items.push(item);
  });

  const listRaw = (obj.list && typeof obj.list === 'object' ? obj.list : {}) as Partial<TransferList>;
  return { list: checkList(listRaw, fallbackTitle, issues), items: capItems(items, issues), issues };
}

/** Формат обираємо за розширенням, а якщо його немає — за вмістом. */
export function parseFile(name: string, text: string, fallbackTitle: string): ParseResult {
  const isJson = /\.json$/i.test(name) || (!/\.csv$/i.test(name) && text.trimStart().startsWith('{')) ||
    (!/\.csv$/i.test(name) && text.trimStart().startsWith('['));
  return isJson ? parseJsonFile(text, fallbackTitle) : parseCsvFile(text, fallbackTitle);
}
