import { MAX_IMPORT_ITEMS, capItems, exportItems, parseJsonItem, parseJsonList } from './transfer';
import type { Issue, TransferItem, TransferList } from './transfer';
import { PHOTO_INPUT_MAX } from './photoRules';
import type { PhotoExt } from './photoRules';
import { isScheme, isTheme } from './appearance';
import type { Scheme, Theme } from './appearance';
import type { Item, List, Section } from './types';
import type { Locale } from './i18n';

/**
 * Резервна копія акаунта — ZIP із JSON і своїми фото (ROADMAP 8.12).
 *
 * Чисті правила формату: ні React, ні мережі, ні DOM, ні самого ZIP — щоб
 * збирання й розбір перевіряли логічні тести (tests/e2e/backup.spec.ts).
 * Пакування, завантаження фото й запис у базу — у `backupZip.ts`, лінивим
 * чанком.
 *
 * Що в копії: списки з розділами, порядком (позиції стоять у порядку гостя,
 * як у файлі експорту, ADR-066) і всіма полями позицій, які задає власник;
 * архів, щорічність і оформлення списку; мова й вигляд застосунку. Свої фото
 * (бакет `item-photos`, ADR-073) — файлами `photos/0001.webp`, без старої
 * адреси; фото з магазину — лише адресою в `image_url`.
 *
 * Чого в копії немає, і це не недогляд (CLAUDE.md §3): позначок гостей і
 * всього про гостей, посилань і їхніх токенів, push-підписок, подяки гостям
 * (`thanks_message` — лист гостям того самого свята, ADR-059), id і дат рядків
 * бази. Немає й опису посилань, який ніс старий файл «Моїх даних»: копія — на
 * відновлення, а посилання не відновлюються.
 */

export const BACKUP_FORMAT = 'wishlist-backup';
export const BACKUP_VERSION = 1;
/** Старий файл «Моїх даних» (до 8.12) — теж відновлюється, але без фото. */
export const LEGACY_ACCOUNT_FORMAT = 'wishlist-personal-account';
/** Файл одного списку — це «Імпорт із файлу», не відновлення. */
const SINGLE_LIST_FORMAT = 'wishlist-personal';

/** Ім'я JSON усередині ZIP. Усе інше, крім `photos/…`, при відновленні ігнорується. */
export const BACKUP_MANIFEST = 'wishlist-backup.json';

/** Більше не відкриваємо: ZIP цілком лежить у пам'яті телефона. 1000 фото по ~400 КБ — 400 МБ. */
export const BACKUP_MAX_BYTES = 512 * 1024 * 1024;
/** JSON на тисячі позицій — кілька мегабайтів; більше — не наш файл. */
export const MANIFEST_MAX_BYTES = 32 * 1024 * 1024;
export const BACKUP_MAX_LISTS = 500;

/** Ім'я фото в архіві — лише наше: номер і розширення, ніяких шляхів. */
const PHOTO_NAME = /^photos\/\d{4,6}\.(webp|jpg)$/;

const LOCALES: readonly Locale[] = ['uk', 'pl', 'en'];
const BUILTIN_KEYS = ['birthday', 'wedding', 'housewarming'] as const;
type BuiltinKey = (typeof BUILTIN_KEYS)[number];
/** Межа з `appearances.name`. */
const APPEARANCE_NAME_MAX = 24;

/** Оформлення списку (ADR-034) — назвою й відтінком, а не id чужої бази. */
export type BackupAppearance = { builtin_key: BuiltinKey } | { name: string; hue: number };

export type BackupProfile = {
  locale: Locale | null;
  theme: Theme | null;
  scheme: Scheme | null;
  high_contrast: boolean | null;
};

/** Що, крім полів файлу списку, копія тримає про список. */
export type ListExtras = {
  is_archived: boolean;
  repeats_yearly: boolean;
  appearance: BackupAppearance | null;
};

export type BackupItem = TransferItem & {
  /** Своє фото — ім'я файлу в архіві; тоді `image_url` порожній. */
  photo: string | null;
};

export type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  version: typeof BACKUP_VERSION;
  /** Випадковий id копії: за ним відновлення не вантажить те саме фото двічі. */
  backup_id: string;
  exported_at: string;
  profile: BackupProfile;
  photo_count: number;
  lists: { list: TransferList & ListExtras; items: BackupItem[] }[];
};

/* ── Збирання ───────────────────────────── */

export type BackupSource = {
  list: List;
  items: Item[];
  sections: Section[];
};

/** Розширення свого фото за адресою; `null` — не своє фото. */
function photoExt(url: string): PhotoExt | null {
  const m = /\.(webp|jpg)$/.exec(url.trim());
  return m ? (m[1] as PhotoExt) : null;
}

/**
 * JSON копії й перелік фото, які треба покласти поруч.
 *
 * `ownPhoto` вирішує, яку адресу качати файлом: лише своє сховище, а не
 * будь-яку адресу, схожу на нього (`isOwnPhoto` дивиться лише на шлях).
 * Одне фото на кількох позиціях («Повторити список» копіює адресу) — один
 * файл.
 */
export function buildBackup(input: {
  lists: BackupSource[];
  appearances: Map<string, BackupAppearance>;
  profile: BackupProfile;
  ownPhoto: (url: string) => boolean;
  id: string;
  now?: string;
}): { manifest: BackupManifest; photos: { name: string; url: string }[] } {
  const photos: { name: string; url: string }[] = [];
  const byUrl = new Map<string, string>();

  const nameFor = (url: string): string | null => {
    const ext = photoExt(url);
    if (!ext || !input.ownPhoto(url)) return null;
    const known = byUrl.get(url);
    if (known) return known;
    const name = `photos/${String(photos.length + 1).padStart(4, '0')}.${ext}`;
    byUrl.set(url, name);
    photos.push({ name, url });
    return name;
  };

  const lists = input.lists.map(({ list, items, sections }) => ({
    list: {
      title: list.title,
      description: list.description,
      currency: list.currency,
      event_date: list.event_date,
      sections: [...sections]
        .sort((a, b) => a.position - b.position || (a.created_at < b.created_at ? -1 : 1))
        .map((s) => s.title),
      is_archived: list.is_archived,
      repeats_yearly: Boolean(list.repeats_yearly),
      appearance: list.appearance_id ? (input.appearances.get(list.appearance_id) ?? null) : null,
    },
    items: exportItems(items, sections).map((item): BackupItem => {
      const photo = item.image_url ? nameFor(item.image_url) : null;
      return { ...item, image_url: photo ? null : item.image_url, photo };
    }),
  }));

  return {
    manifest: {
      format: BACKUP_FORMAT,
      version: BACKUP_VERSION,
      backup_id: input.id,
      exported_at: input.now ?? new Date().toISOString(),
      profile: input.profile,
      photo_count: photos.length,
      lists,
    },
    photos,
  };
}

/**
 * Фото, якого не вдалося взяти (сховище відповіло 404, файл зник), лишається
 * в копії адресою, як і до 8.12: краще адреса, ніж позиція без фото взагалі.
 */
export function keepAsAddress(manifest: BackupManifest, missing: Map<string, string>): BackupManifest {
  if (missing.size === 0) return manifest;
  return {
    ...manifest,
    photo_count: manifest.photo_count - missing.size,
    lists: manifest.lists.map((l) => ({
      ...l,
      items: l.items.map((i) => {
        const url = i.photo ? missing.get(i.photo) : undefined;
        return url ? { ...i, photo: null, image_url: url } : i;
      }),
    })),
  };
}

export function backupFileName(now = new Date()): string {
  return `wishlist-backup-${now.toISOString().slice(0, 10)}.zip`;
}

/* ── Розбір ─────────────────────────────── */

/** Чому копію не відновити: ключ перекладу й підстановки. Нічого не записано. */
export type BackupProblem = { key: string; vars?: Record<string, string | number> };

export type RestoreList = {
  list: TransferList;
  extras: ListExtras;
  items: TransferItem[];
  /** Своє фото кожної позиції — ім'я в архіві або `null`; той самий порядок, що `items`. */
  photos: (string | null)[];
};

export type RestorePlan = {
  kind: 'backup' | 'legacy';
  backupId: string | null;
  exportedAt: string | null;
  profile: BackupProfile | null;
  /** У порядку файлу: найновіший список першим, як на «Моїх списках». */
  lists: RestoreList[];
  /** Скільки значень довелося обрізати чи замінити усталеними (як у превʼю імпорту). */
  warnings: number;
};

export type ParseBackupResult = { ok: true; plan: RestorePlan } | { ok: false; problem: BackupProblem };

/** Що лежить в архіві: ім'я → розмір розпакованого файлу. Для JSON без ZIP — порожньо. */
export type ArchiveIndex = Map<string, number>;

const fail = (key: string, vars?: Record<string, string | number>): ParseBackupResult => ({
  ok: false,
  problem: { key: `backup.errors.${key}`, ...(vars ? { vars } : {}) },
});

function isRecord(v: unknown): v is Record<string, unknown> {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function parseAppearance(raw: unknown): BackupAppearance | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.builtin_key === 'string') {
    const key = BUILTIN_KEYS.find((k) => k === raw.builtin_key);
    return key ? { builtin_key: key } : null;
  }
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  const hue = raw.hue;
  if (!name || Array.from(name).length > APPEARANCE_NAME_MAX) return null;
  if (typeof hue !== 'number' || !Number.isInteger(hue) || hue < 0 || hue > 359) return null;
  return { name, hue };
}

function parseProfile(raw: unknown): BackupProfile | null {
  if (!isRecord(raw)) return null;
  return {
    locale: LOCALES.find((l) => l === raw.locale) ?? null,
    theme: isTheme(raw.theme) ? raw.theme : null,
    scheme: isScheme(raw.scheme) ? raw.scheme : null,
    high_contrast: typeof raw.high_contrast === 'boolean' ? raw.high_contrast : null,
  };
}

/**
 * Розбір і повна перевірка копії до першого запису (п. 6 пункту 8.12).
 *
 * Фатально — і тоді не записано нічого: не JSON, чужий формат, новіша
 * версія, файл одного списку, позиція, яку не прийняв би імпорт (без назви,
 * задовга назва), фото, якого немає в архіві чи яке задавелике. Те, що
 * імпорт списку виправляє з попередженням (обрізаний опис, незнайома
 * валюта), — виправляється так само й лише рахується.
 */
export function parseBackup(text: string, archive: ArchiveIndex, fallbackTitle: string): ParseBackupResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    return fail('broken');
  }
  if (!isRecord(raw)) return fail('foreign');

  const format = raw.format;
  if (format === SINGLE_LIST_FORMAT) return fail('singleList');
  if (format !== BACKUP_FORMAT && format !== LEGACY_ACCOUNT_FORMAT) return fail('foreign');
  const legacy = format === LEGACY_ACCOUNT_FORMAT;

  const version = raw.version;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return fail('broken');
  if (version > BACKUP_VERSION) return fail('newer', { version });

  if (!Array.isArray(raw.lists)) return fail('broken');
  if (raw.lists.length > BACKUP_MAX_LISTS) return fail('tooManyLists', { max: BACKUP_MAX_LISTS });

  const issues: Issue[] = [];
  const lists: RestoreList[] = [];

  for (const [at, entry] of raw.lists.entries()) {
    if (!isRecord(entry) || !Array.isArray(entry.items)) return fail('broken');
    const rawList = isRecord(entry.list) ? entry.list : {};

    const items: TransferItem[] = [];
    const photos: (string | null)[] = [];
    const own: Issue[] = [];
    for (const [row, rawItem] of entry.items.entries()) {
      const item = parseJsonItem(rawItem, row + 1, own);
      if (!item) {
        const listTitle = typeof rawList.title === 'string' ? rawList.title : String(at + 1);
        return fail('badItem', { list: Array.from(listTitle).slice(0, 60).join(''), row: row + 1 });
      }
      let photo: string | null = null;
      if (!legacy && isRecord(rawItem) && rawItem.photo !== undefined && rawItem.photo !== null) {
        const name = rawItem.photo;
        if (typeof name !== 'string' || !PHOTO_NAME.test(name)) return fail('broken');
        if (archive.size === 0) return fail('needZip');
        const size = archive.get(name);
        if (size === undefined) return fail('missingPhoto', { name });
        if (size > PHOTO_INPUT_MAX) return fail('photoTooBig', { name });
        photo = name;
        // Своє фото їде файлом; адреса, якщо її дописали руками, не потрібна.
        item.image_url = null;
      }
      items.push(item);
      photos.push(photo);
    }

    const kept = capItems(items, own);
    issues.push(...own);
    lists.push({
      list: parseJsonList(rawList, kept, fallbackTitle, issues),
      extras: {
        is_archived: rawList.is_archived === true,
        repeats_yearly: rawList.repeats_yearly === true,
        appearance: parseAppearance(rawList.appearance),
      },
      items: kept,
      photos: photos.slice(0, kept.length),
    });
  }

  return {
    ok: true,
    plan: {
      kind: legacy ? 'legacy' : 'backup',
      backupId: !legacy && typeof raw.backup_id === 'string' ? raw.backup_id.slice(0, 64) : null,
      exportedAt: typeof raw.exported_at === 'string' ? raw.exported_at.slice(0, 40) : null,
      profile: legacy ? null : parseProfile(raw.profile),
      lists,
      warnings: issues.filter((i) => i.level === 'warning').length,
    },
  };
}

/** Різні свої фото плану — стільки адрес попросить відновлення. */
export function planPhotos(lists: RestoreList[]): string[] {
  return [...new Set(lists.flatMap((l) => l.photos.filter((p): p is string => p !== null)))];
}

/**
 * Чи такий список уже є в акаунті: та сама назва, валюта, дата й кількість
 * позицій. Так повторне відновлення тієї самої копії — після обриву мережі
 * чи через годину, коли мине ліміт фото, — не дублює вже відновлене, а
 * докладає решту. Збіг на чужому списку з тими самими чотирма ознаками
 * можливий; тоді є «Відновити й ті, що вже є».
 */
export function alreadyThere(entry: RestoreList, existing: Pick<List, 'title' | 'currency' | 'event_date' | 'item_count'>[]): boolean {
  return existing.some(
    (l) =>
      l.title === entry.list.title &&
      l.currency === entry.list.currency &&
      (l.event_date ?? null) === entry.list.event_date &&
      (l.item_count ?? -1) === entry.items.length,
  );
}

/**
 * Порядок запису: найстаріший першим. «Мої списки» сортують за датою
 * створення, тож відновлені стануть у тому самому порядку, що й були.
 */
export function restoreOrder<T>(lists: T[]): T[] {
  return [...lists].reverse();
}

/** Перші байти фото: WebP — `RIFF....WEBP`, JPEG — `FF D8 FF`. Інше не вантажимо. */
export function photoBytesOk(bytes: Uint8Array, name: string): boolean {
  if (name.endsWith('.webp')) {
    const tag = (from: number) => String.fromCharCode(...bytes.subarray(from, from + 4));
    return bytes.length > 12 && tag(0) === 'RIFF' && tag(8) === 'WEBP';
  }
  return bytes.length > 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
}

/** Імена в архіві, які взагалі розпаковуємо: JSON і фото з нашим іменем. */
export function wantedEntry(name: string, size: number): boolean {
  if (name === BACKUP_MANIFEST) return size <= MANIFEST_MAX_BYTES;
  return PHOTO_NAME.test(name) && size <= PHOTO_INPUT_MAX;
}

/** Позначка дубля: назва обрізається так, щоб позначка влізла в 120 символів. */
export function withSuffix(title: string, suffix: string, max = 120): string {
  const tail = ` ${suffix.trim()}`;
  const room = Math.max(1, max - Array.from(tail).length);
  return Array.from(title).slice(0, room).join('').trimEnd() + tail;
}

export { MAX_IMPORT_ITEMS };
