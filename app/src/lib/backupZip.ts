import { supabase } from './supabase';
import { fetchAllItems, fetchLists, importList, updateList } from './db';
import type { ListInput } from './db';
import { fetchSections } from './sections';
import { createAppearance, fetchAppearances } from './appearances';
import { PHOTO_HOURLY, PHOTO_INPUT_MAX, PHOTO_QUOTA, PhotoError, isOwnPhoto, uploadPhoto } from './photos';
import {
  BACKUP_MAX_BYTES,
  MANIFEST_MAX_BYTES,
  alreadyThere,
  backupFileName,
  buildBackup,
  keepAsAddress,
  parseBackup,
  photoBytesOk,
  restoreOrder,
  withSuffix,
} from './backup';
import type { BackupAppearance, BackupProfile, BackupSource, RestoreList, RestorePlan } from './backup';
import type { TransferItem, TransferList } from './transfer';
import type { List } from './types';
import { createZipWriter, indexArchive, looksLikeZip, readEntry, readManifest } from './zip';

/**
 * Резервна копія з фото (ROADMAP 8.12): збирання ZIP у браузері й
 * відновлення з нього. Сервера для цього немає — лише ті самі запити, що й
 * експорт, імпорт і своє фото позиції.
 *
 * Лінивий чанк: «Мої дані» імпортують модуль на натискання, і разом із ним
 * приїздить `fflate` (`zip.ts`). Правила формату — у чистому `backup.ts`.
 */

/** Помилка з ключем перекладу; `vars` — підстановки. */
export class BackupError extends Error {
  constructor(
    readonly key: string,
    readonly vars?: Record<string, string | number>,
  ) {
    super(key);
    this.name = 'BackupError';
  }
}

/** Фото зі сховища — не довше, ніж будь-який інший запит до нього (`lib/supabase.ts`). */
const PHOTO_TIMEOUT_MS = 60_000;

const storageOrigin = (() => {
  try {
    return new URL(import.meta.env.VITE_SUPABASE_URL).origin;
  } catch {
    return '';
  }
})();

/** Своє фото — лише з нашого сховища: адресу з тим самим шляхом на чужому домені не качаємо. */
function ownStoragePhoto(url: string): boolean {
  try {
    return isOwnPhoto(url) && new URL(url).origin === storageOrigin;
  } catch {
    return false;
  }
}

function appearanceOf(a: { builtin_key: string | null; name: string; hue: number }): BackupAppearance {
  return a.builtin_key === 'birthday' || a.builtin_key === 'wedding' || a.builtin_key === 'housewarming'
    ? { builtin_key: a.builtin_key }
    : { name: a.name, hue: a.hue };
}

/* ── Збирання ───────────────────────────── */

export type ExportProgress = { stage: 'lists' | 'photos'; done: number; total: number };

export async function exportBackup(
  profile: BackupProfile,
  onProgress: (p: ExportProgress) => void,
  cancelled: () => boolean,
): Promise<{ name: string; blob: Blob; photos: number; missing: number } | null> {
  const lists = await fetchLists();
  onProgress({ stage: 'lists', done: 0, total: lists.length });
  const sources: BackupSource[] = [];
  for (const list of lists) {
    if (cancelled()) return null;
    const [items, sections] = await Promise.all([fetchAllItems(list.id), fetchSections(list.id)]);
    sources.push({ list, items, sections });
    onProgress({ stage: 'lists', done: sources.length, total: lists.length });
  }

  const appearances = new Map((await fetchAppearances()).map((a) => [a.id, appearanceOf(a)]));
  const { manifest, photos } = buildBackup({
    lists: sources,
    appearances,
    profile,
    ownPhoto: ownStoragePhoto,
    id: crypto.randomUUID(),
  });

  const writer = createZipWriter();
  const missing = new Map<string, string>();
  onProgress({ stage: 'photos', done: 0, total: photos.length });
  for (const [at, photo] of photos.entries()) {
    if (cancelled()) return null;
    // Збій мережі — виняток: копія без половини фото гірша за повтор.
    // Файлу немає (404) — фото лишається в копії адресою.
    const res = await fetch(photo.url, { signal: AbortSignal.timeout(PHOTO_TIMEOUT_MS) });
    const bytes = res.ok ? new Uint8Array(await res.arrayBuffer()) : null;
    if (bytes && bytes.length <= PHOTO_INPUT_MAX && photoBytesOk(bytes, photo.name)) writer.addFile(photo.name, bytes);
    else missing.set(photo.name, photo.url);
    onProgress({ stage: 'photos', done: at + 1, total: photos.length });
  }

  const final = keepAsAddress(manifest, missing);
  // JSON — першим у переліку архіву, хоч і пишеться останнім: порядок
  // записів для читання не важить, а знати про відсутні фото треба до запису.
  writer.addText('wishlist-backup.json', JSON.stringify(final, null, 2) + '\n');
  const chunks = writer.finish();
  return {
    name: backupFileName(),
    blob: new Blob(chunks as BlobPart[], { type: 'application/zip' }),
    photos: final.photo_count,
    missing: missing.size,
  };
}

/* ── Відкриття файлу ────────────────────── */

export type OpenedBackup = {
  plan: RestorePlan;
  /** Сам архів — фото з нього читаються по одному під час відновлення. */
  bytes: Uint8Array | null;
  /** Чи список уже є в акаунті (`alreadyThere`) — у порядку `plan.lists`. */
  existing: boolean[];
  photos: number;
};

export async function openBackup(file: File, fallbackTitle: string): Promise<OpenedBackup> {
  if (file.size > BACKUP_MAX_BYTES) {
    throw new BackupError('backup.errors.tooBig', { max: BACKUP_MAX_BYTES / 1024 / 1024 });
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let text: string;
  let archive: Uint8Array | null = null;
  let index = new Map<string, number>();

  if (looksLikeZip(bytes)) {
    try {
      index = indexArchive(bytes);
      text = readManifest(bytes) ?? '';
    } catch {
      throw new BackupError('backup.errors.brokenZip');
    }
    if (!text) throw new BackupError('backup.errors.noManifest');
    archive = bytes;
  } else {
    if (bytes.length > MANIFEST_MAX_BYTES) throw new BackupError('backup.errors.foreign');
    text = new TextDecoder().decode(bytes);
  }

  const parsed = parseBackup(text, index, fallbackTitle);
  if (!parsed.ok) throw new BackupError(parsed.problem.key, parsed.problem.vars);

  const lists = await fetchLists();
  const existing = parsed.plan.lists.map((l) => alreadyThere(l, lists));
  const photos = new Set(parsed.plan.lists.flatMap((l) => l.photos.filter(Boolean))).size;
  return { plan: parsed.plan, bytes: archive, existing, photos };
}

/**
 * Скільки своїх фото ще можна завантажити: квота акаунта й ліміт на годину
 * (ADR-073, `reserve_item_photo`). Рахуємо за своїми ж рядками `item_photos`
 * (політика `item_photos_select_own`); годинник браузера може трохи
 * розходитися із сервером — це підказка, а не обіцянка. `null` — не вдалося.
 */
export async function photoBudget(): Promise<{ quota: number; hour: number } | null> {
  const hourAgo = new Date(Date.now() - 3_600_000).toISOString();
  const [all, hour] = await Promise.all([
    supabase.from('item_photos').select('path', { count: 'exact', head: true }),
    supabase.from('item_photos').select('path', { count: 'exact', head: true }).gt('created_at', hourAgo),
  ]);
  if (all.error || hour.error || all.count === null || hour.count === null) return null;
  return { quota: Math.max(0, PHOTO_QUOTA - all.count), hour: Math.max(0, PHOTO_HOURLY - hour.count) };
}

/* ── Відновлення ────────────────────────── */

export type RestoreProgress = { list: number; lists: number; photo: number; photos: number };

export type RestoreResult = {
  restored: number;
  skipped: number;
  /** Фото, які не розкодувались чи виявились не фото, — позиції без них. */
  badPhotos: number;
  cancelled: boolean;
};

/**
 * Уже завантажені фото цієї вкладки: ліміт 60 на годину може зупинити
 * відновлення посеред списку, і повтор не має вантажити те саме ще раз.
 * Лише в пам'яті — нічого не лягає ні в localStorage, ні в IndexedDB.
 */
const uploaded = new Map<string, string>();

/**
 * Імпорт списку однією дією. Поки в гілці немає RPC `import_list` (8.26),
 * `importList` — серія запитів із ручним відкотом; після злиття 8.26 це
 * одна транзакція, а другий параметр стане зайвим. Тип нижче приймає обидві
 * сигнатури (функція з меншим числом параметрів йому відповідає).
 */
type ImportFn = (file: { list: TransferList; items: TransferItem[] }, ownerId: string) => Promise<List>;
const importAtomic: ImportFn = importList;

const MIME: Record<string, string> = { webp: 'image/webp', jpg: 'image/jpeg' };

export async function restoreBackup(
  opened: OpenedBackup,
  options: {
    ownerId: string;
    /** Відновити й ті, що вже є (`alreadyThere`) — тоді з позначкою в назві. */
    includeExisting: boolean;
    copySuffix: string;
    onProgress: (p: RestoreProgress) => void;
    cancelled: () => boolean;
  },
): Promise<RestoreResult> {
  const { plan, bytes } = opened;
  const now = await fetchLists();
  const marked = plan.lists.map((l) => ({ entry: l, exists: alreadyThere(l, now) }));
  const todo = restoreOrder(marked).filter((m) => options.includeExisting || !m.exists);
  const result: RestoreResult = { restored: 0, skipped: marked.length - todo.length, badPhotos: 0, cancelled: false };

  const totalPhotos = new Set(todo.flatMap((m) => m.entry.photos.filter(Boolean))).size;
  let photoDone = 0;
  const progress = () =>
    options.onProgress({ list: result.restored, lists: todo.length, photo: photoDone, photos: totalPhotos });
  progress();

  let appearances: Awaited<ReturnType<typeof fetchAppearances>> | null = null;
  const appearanceId = async (a: BackupAppearance | null): Promise<string | null> => {
    if (!a) return null;
    appearances ??= await fetchAppearances();
    const found = appearances.find((x) =>
      'builtin_key' in a ? x.builtin_key === a.builtin_key : !x.builtin_key && x.name === a.name && x.hue === a.hue,
    );
    if (found) return found.id;
    if ('builtin_key' in a) return null;
    const created = await createAppearance(options.ownerId, a.name, a.hue);
    appearances.push(created);
    return created.id;
  };

  const seen = new Map<string, string | null>();
  const photoUrl = async (name: string): Promise<string | null> => {
    if (seen.has(name)) return seen.get(name) ?? null;
    const key = `${options.ownerId}:${plan.backupId ?? ''}:${name}`;
    let url = uploaded.get(key) ?? null;
    if (!url) {
      const data = bytes ? readEntry(bytes, name) : null;
      if (!data || !photoBytesOk(data, name)) {
        result.badPhotos += 1;
      } else {
        try {
          // Те саме, що й «Своє фото» у формі: перевірка типу й розміру,
          // зменшення, перекодування без EXIF, нова випадкова адреса (ADR-073).
          const ext = name.slice(name.lastIndexOf('.') + 1);
          const file = new File([data as BlobPart], name.slice(name.lastIndexOf('/') + 1), { type: MIME[ext] ?? '' });
          url = await uploadPhoto(file);
          uploaded.set(key, url);
        } catch (e) {
          if (e instanceof PhotoError && e.key === 'v2item.photo.upload.rate') {
            throw new BackupError('backup.errors.photoRate', { done: result.restored, total: todo.length });
          }
          if (e instanceof PhotoError && e.key === 'v2item.photo.upload.quota') {
            throw new BackupError('backup.errors.photoQuota', { max: PHOTO_QUOTA, done: result.restored, total: todo.length });
          }
          if (!(e instanceof PhotoError)) throw e;
          result.badPhotos += 1;
        }
      }
    }
    seen.set(name, url);
    photoDone += 1;
    progress();
    return url;
  };

  for (const { entry, exists } of todo) {
    if (options.cancelled()) return { ...result, cancelled: true };
    await restoreList(entry, exists);
    result.restored += 1;
    progress();
  }
  return result;

  async function restoreList(entry: RestoreList, exists: boolean): Promise<void> {
    // Спершу фото: список з'являється одразу з ними. Не вдалося записати
    // список — завантажені файли стануть сиротами, і їх прибере wishlist-jobs.
    const items: TransferItem[] = [];
    for (const [at, item] of entry.items.entries()) {
      const photo = entry.photos[at];
      items.push(photo ? { ...item, image_url: await photoUrl(photo) } : item);
    }
    const title = exists ? withSuffix(entry.list.title, options.copySuffix) : entry.list.title;
    const appearance_id = await appearanceId(entry.extras.appearance);
    const extras: Partial<ListInput> & { appearance_id: string | null } = {
      is_archived: entry.extras.is_archived,
      repeats_yearly: entry.extras.repeats_yearly,
      appearance_id,
    };
    // Поля поверх файлу списку їдуть у ту саму вставку списку: `importList`
    // кладе в `lists` усе, крім `sections`. Чого вставка не взяла, —
    // наступним запитом.
    const list = await importAtomic({ list: { ...entry.list, title, ...extras }, items }, options.ownerId);
    const patch: Partial<ListInput> & { appearance_id?: string | null } = {};
    if (list.is_archived !== extras.is_archived) patch.is_archived = extras.is_archived;
    if (Boolean(list.repeats_yearly) !== extras.repeats_yearly) patch.repeats_yearly = extras.repeats_yearly;
    if ((list.appearance_id ?? null) !== appearance_id) patch.appearance_id = appearance_id;
    if (Object.keys(patch).length > 0) await updateList(list.id, patch);
  }
}

