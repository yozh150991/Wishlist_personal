import { test, expect } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
import {
  BACKUP_MANIFEST,
  alreadyThere,
  buildBackup,
  keepAsAddress,
  parseBackup,
  photoBytesOk,
  planPhotos,
  restoreOrder,
  wantedEntry,
  withSuffix,
} from '../../src/lib/backup';
import type { BackupProfile } from '../../src/lib/backup';
import { createZipWriter, indexArchive, looksLikeZip, readEntry, readManifest } from '../../src/lib/zip';
import { toAccountJson, toJson } from '../../src/lib/transfer';
import type { Item, List, Section } from '../../src/lib/types';

// Резервна копія з фото (ROADMAP 8.12): формат, ZIP і перевірки — без
// браузера й бази. Запис у базу й сховище — e2e `backup-restore.spec.ts`.

const STORAGE = 'http://127.0.0.1:54321/storage/v1/object/public/item-photos/';
const PHOTO_A = `${STORAGE}${'a'.repeat(32)}.webp`;
const PHOTO_B = `${STORAGE}${'b'.repeat(32)}.jpg`;
const SHOP = 'https://shop.example.com/img/1.jpg';
/** Той самий шлях на чужому домені — не наше сховище. */
const LOOKALIKE = `https://evil.example.com/storage/v1/object/public/item-photos/${'c'.repeat(32)}.webp`;

const own = (url: string) => url.startsWith('http://127.0.0.1:54321/');
const profile: BackupProfile = { locale: 'pl', theme: 'dark', scheme: 'slyva', high_contrast: false };

const WEBP = new Uint8Array([...strToU8('RIFF'), 0, 0, 0, 0, ...strToU8('WEBPVP8 '), 1, 2, 3, 4]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const list: List = {
  id: 'l1',
  owner_id: 'u1',
  title: 'День народження',
  description: 'Подарунки',
  currency: 'PLN',
  event_date: '2026-05-01',
  appearance_id: 'ap-1',
  is_archived: true,
  repeats_yearly: true,
  thanks_message: 'Дякую всім!',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const sections: Section[] = [
  { id: 's2', list_id: 'l1', title: 'Кухня', position: 2, created_at: '2026-01-01T00:00:00Z' },
  { id: 's1', list_id: 'l1', title: 'Спальня', position: 1, created_at: '2026-01-01T00:00:00Z' },
  { id: 's3', list_id: 'l1', title: 'Порожній', position: 3, created_at: '2026-01-01T00:00:00Z' },
];

function item(over: Partial<Item> = {}): Item {
  return {
    id: 'i1',
    list_id: 'l1',
    owner_id: 'u1',
    title: 'Кавоварка',
    url: 'https://shop.example.com/a',
    price: 450,
    quantity: 1,
    priority: 'high',
    status: 'active',
    note: null,
    variants: [],
    image_url: null,
    source_site: 'shop.example.com',
    parsed_at: null,
    section_id: null,
    position: null,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

const items: Item[] = [
  item({ id: 'i1', title: 'Чайник', section_id: 's2', position: 2, image_url: PHOTO_A }),
  item({ id: 'i2', title: 'Тостер', section_id: 's2', position: 1, image_url: PHOTO_A, status: 'gifted' }),
  item({ id: 'i3', title: 'Плед', section_id: 's1', position: 1, image_url: PHOTO_B, price: '19.99', currency: 'EUR' }),
  item({ id: 'i4', title: 'https://shop.example.com/x', needs_title: true, image_url: SHOP, variants: [{ label: 'Розмір', value: 'M' }] }),
  item({ id: 'i5', title: 'Ваза', image_url: LOOKALIKE }),
];

function build() {
  return buildBackup({
    lists: [{ list, items, sections }],
    appearances: new Map([['ap-1', { name: 'Мій', hue: 200 }]]),
    profile,
    ownPhoto: own,
    id: 'b-1',
    now: '2026-11-22T10:00:00Z',
  });
}

function zipOf(json: string, photos: Record<string, Uint8Array>): Uint8Array {
  const w = createZipWriter();
  for (const [name, bytes] of Object.entries(photos)) w.addFile(name, bytes);
  w.addText(BACKUP_MANIFEST, json);
  const chunks = w.finish();
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

const fullZip = () => {
  const { manifest } = build();
  return zipOf(JSON.stringify(manifest), { 'photos/0002.webp': WEBP, 'photos/0001.jpg': JPEG });
};

function parseZip(bytes: Uint8Array) {
  return parseBackup(readManifest(bytes) ?? '', indexArchive(bytes), 'Список');
}

test.describe('збирання копії', () => {
  test('свої фото — файлами, одне фото на кількох позиціях — один файл; магазин і схожа адреса — адресою', () => {
    const { manifest, photos } = build();
    expect(photos).toEqual([
      { name: 'photos/0001.jpg', url: PHOTO_B },
      { name: 'photos/0002.webp', url: PHOTO_A },
    ]);
    expect(manifest.photo_count).toBe(2);
    const byTitle = new Map(manifest.lists[0]!.items.map((i) => [i.title, i]));
    expect(byTitle.get('Чайник')).toMatchObject({ photo: 'photos/0002.webp', image_url: null });
    expect(byTitle.get('Тостер')).toMatchObject({ photo: 'photos/0002.webp', image_url: null });
    expect(byTitle.get('https://shop.example.com/x')).toMatchObject({ photo: null, image_url: SHOP, needs_title: true });
    expect(byTitle.get('Ваза')).toMatchObject({ photo: null, image_url: LOOKALIKE });
  });

  test('формат, версія, розділи в порядку власника, позиції в порядку гостя, поля списку й профіль', () => {
    const { manifest } = build();
    expect(manifest).toMatchObject({ format: 'wishlist-backup', version: 1, backup_id: 'b-1', profile });
    const l = manifest.lists[0]!;
    expect(l.list).toEqual({
      title: 'День народження',
      description: 'Подарунки',
      currency: 'PLN',
      event_date: '2026-05-01',
      sections: ['Спальня', 'Кухня', 'Порожній'],
      is_archived: true,
      repeats_yearly: true,
      appearance: { name: 'Мій', hue: 200 },
    });
    expect(l.items.map((i) => [i.title, i.section])).toEqual([
      ['Плед', 'Спальня'],
      ['Тостер', 'Кухня'],
      ['Чайник', 'Кухня'],
      ['https://shop.example.com/x', null],
      ['Ваза', null],
    ]);
  });

  test('у копії немає id, власника, подяки, посилань, позначок і старих адрес своїх фото', () => {
    const text = JSON.stringify(build().manifest);
    expect(text).not.toMatch(/"id"|"owner_id"|"list_id"|"section_id"|"token"|"shares"|"claims"|"thanks|"created_at"/);
    expect(text).not.toContain('a'.repeat(32));
    expect(text).not.toContain('b'.repeat(32));
  });

  test('фото, якого вже немає у сховищі, лишається адресою', () => {
    const { manifest } = build();
    const kept = keepAsAddress(manifest, new Map([['photos/0001.jpg', PHOTO_B]]));
    expect(kept.photo_count).toBe(1);
    expect(kept.lists[0]!.items.find((i) => i.title === 'Плед')).toMatchObject({ photo: null, image_url: PHOTO_B });
  });
});

test.describe('ZIP і розбір', () => {
  test('повний оберт: зібрали — розпакували — той самий план із розділами, порядком, чернеткою й фото', () => {
    const bytes = fullZip();
    expect(looksLikeZip(bytes)).toBe(true);
    const parsed = parseZip(bytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const { plan } = parsed;
    expect(plan).toMatchObject({ kind: 'backup', backupId: 'b-1', profile, warnings: 0 });
    const l = plan.lists[0]!;
    expect(l.list.sections).toEqual(['Спальня', 'Кухня', 'Порожній']);
    expect(l.extras).toEqual({ is_archived: true, repeats_yearly: true, appearance: { name: 'Мій', hue: 200 } });
    expect(l.items.map((i) => i.title)).toEqual(['Плед', 'Тостер', 'Чайник', 'https://shop.example.com/x', 'Ваза']);
    expect(l.photos).toEqual(['photos/0001.jpg', 'photos/0002.webp', 'photos/0002.webp', null, null]);
    expect(l.items[0]).toMatchObject({ price: 19.99, currency: 'EUR', section: 'Спальня', image_url: null });
    expect(l.items[1]).toMatchObject({ status: 'gifted' });
    expect(l.items[3]).toMatchObject({ needs_title: true, image_url: SHOP, variants: [{ label: 'Розмір', value: 'M' }] });
    expect(planPhotos(plan.lists)).toEqual(['photos/0001.jpg', 'photos/0002.webp']);
    expect(readEntry(bytes, 'photos/0002.webp')).toEqual(WEBP);
  });

  test('зламаний, чужий, новіший і файл одного списку — зрозуміла помилка', () => {
    const key = (text: string, archive = new Map<string, number>()) => {
      const r = parseBackup(text, archive, 'Список');
      return r.ok ? 'ok' : r.problem.key;
    };
    expect(key('{"format":')).toBe('backup.errors.broken');
    expect(key('[1,2]')).toBe('backup.errors.foreign');
    expect(key('{"format":"something-else","version":1,"lists":[]}')).toBe('backup.errors.foreign');
    expect(key(toJson(list, [item()]))).toBe('backup.errors.singleList');
    const newer = parseBackup('{"format":"wishlist-backup","version":2,"lists":[]}', new Map(), 'Список');
    expect(newer).toEqual({ ok: false, problem: { key: 'backup.errors.newer', vars: { version: 2 } } });
    expect(key('{"format":"wishlist-backup","version":1}')).toBe('backup.errors.broken');
    expect(key('{"format":"wishlist-backup","version":1,"lists":[{"list":{"title":"A"},"items":[{"title":""}]}]}')).toBe(
      'backup.errors.badItem',
    );
  });

  test('фото: без ZIP, бракує в архіві, чуже ім’я — помилка до будь-якого запису', () => {
    const { manifest } = build();
    const text = JSON.stringify(manifest);
    const key = (t: string, archive: Map<string, number>) => {
      const r = parseBackup(t, archive, 'Список');
      return r.ok ? 'ok' : r.problem.key;
    };
    expect(key(text, new Map())).toBe('backup.errors.needZip');
    expect(key(text, new Map([['photos/0001.jpg', 10]]))).toBe('backup.errors.missingPhoto');
    expect(key(text, new Map([['photos/0001.jpg', 10], ['photos/0002.webp', 30 * 1024 * 1024]]))).toBe(
      'backup.errors.photoTooBig',
    );
    const evil = text.replace('"photos/0002.webp"', '"../../etc/passwd.webp"');
    expect(key(evil, new Map([['photos/0001.jpg', 10], ['photos/0002.webp', 10]]))).toBe('backup.errors.broken');
  });

  test('ZIP: шляхи поза photos/, задовгі й чужі файли не потрапляють у перелік', () => {
    const bytes = zipSync({
      [BACKUP_MANIFEST]: strToU8('{}'),
      'photos/0001.webp': WEBP,
      '../photos/0002.webp': WEBP,
      'photos/../../x.webp': WEBP,
      '/abs/photos/0003.webp': WEBP,
      'photos/script.js': strToU8('alert(1)'),
      'photos/0004.webp': new Uint8Array(26 * 1024 * 1024),
    });
    expect([...indexArchive(bytes).keys()].sort()).toEqual(['photos/0001.webp', BACKUP_MANIFEST]);
    expect(readEntry(bytes, 'photos/0004.webp')).toBeNull();
    expect(wantedEntry('photos/0001.WEBP', 1)).toBe(false);
  });

  test('ZIP-бомба із заниженим розміром дає обрізаний файл, а не гігабайти; не ZIP — виняток', () => {
    const bytes = zipSync({ [BACKUP_MANIFEST]: new Uint8Array(5_000_000).fill(32) });
    // Розмір розпакованого в центральному каталозі — 10 байтів.
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (let i = bytes.length - 22; i >= 0; i -= 1) {
      if (view.getUint32(i, true) === 0x02014b50) {
        view.setUint32(i + 24, 10, true);
        break;
      }
    }
    expect(readManifest(bytes)?.length ?? 0).toBeLessThanOrEqual(10);
    expect(() => indexArchive(strToU8('PK\u0003\u0004 not really a zip'))).toThrow();
    expect(looksLikeZip(strToU8('{"format":"wishlist-backup"}'))).toBe(false);
  });

  test('перші байти фото: WebP і JPEG так, решта ні', () => {
    expect(photoBytesOk(WEBP, 'photos/0001.webp')).toBe(true);
    expect(photoBytesOk(JPEG, 'photos/0001.jpg')).toBe(true);
    expect(photoBytesOk(JPEG, 'photos/0001.webp')).toBe(false);
    expect(photoBytesOk(strToU8('<svg onload=alert(1)>'), 'photos/0001.jpg')).toBe(false);
  });

  test('старий файл «Моїх даних» відновлюється без фото: адреси як були, посилання ігноруються', () => {
    const text = toAccountJson(
      [{ list, items, sections }],
      [{ title: 'Для бабусі', list_title: list.title, created_at: '', expires_at: null, revoked_at: null, view_count: 1, items_count: 2 }],
    );
    const r = parseBackup(text, new Map(), 'Список');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.plan.kind).toBe('legacy');
    expect(r.plan.profile).toBeNull();
    const l = r.plan.lists[0]!;
    expect(l.list.sections).toEqual(['Спальня', 'Кухня', 'Порожній']);
    expect(l.photos.every((p) => p === null)).toBe(true);
    expect(l.items.find((i) => i.title === 'Чайник')?.image_url).toBe(PHOTO_A);
    // Старий файл не знав архіву й оформлення — список відновлюється звичайним.
    expect(l.extras).toEqual({ is_archived: false, repeats_yearly: false, appearance: null });
  });
});

test.describe('повтор відновлення', () => {
  test('список, що вже є (назва, валюта, дата, кількість), пропускається; порядок запису — найстаріший першим', () => {
    const parsed = parseZip(fullZip());
    if (!parsed.ok) throw new Error('parse');
    const entry = parsed.plan.lists[0]!;
    const same = { title: 'День народження', currency: 'PLN' as const, event_date: '2026-05-01', item_count: 5 };
    expect(alreadyThere(entry, [same])).toBe(true);
    expect(alreadyThere(entry, [{ ...same, item_count: 4 }])).toBe(false);
    expect(alreadyThere(entry, [{ ...same, event_date: null }])).toBe(false);
    expect(restoreOrder(['new', 'mid', 'old'])).toEqual(['old', 'mid', 'new']);
  });

  test('позначка дубля вміщається в межу назви й не розрізає емодзі', () => {
    expect(withSuffix('Свято', '(з копії)')).toBe('Свято (з копії)');
    const long = withSuffix('🎁'.repeat(130), '(з копії)');
    expect(Array.from(long).length).toBe(120);
    expect(long.endsWith(' (з копії)')).toBe(true);
  });
});
