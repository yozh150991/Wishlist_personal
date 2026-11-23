import { Zip, ZipDeflate, ZipPassThrough, strFromU8, strToU8, unzipSync } from 'fflate';
import { BACKUP_MANIFEST, wantedEntry } from './backup';
import type { ArchiveIndex } from './backup';

/**
 * ZIP резервної копії (ROADMAP 8.12) поверх `fflate`.
 *
 * Без DOM і мережі — логічні тести ганяють його в Node. Імпортує його лише
 * `backupZip.ts`, а той — лише лінивим `import()` з «Моїх даних»: бібліотека
 * не їде ні в головний пакет, ні гостю (`npm run check:pwa`, LAZY_ONLY).
 *
 * Лише синхронні й потокові класи без воркерів: асинхронні `zip`/`unzip`
 * `fflate` запускають Web Worker із `blob:`-адреси, а CSP (`worker-src
 * 'self'`) таких не пускає.
 */

/** Збирач архіву частинами: JSON стискається, фото (вже стиснені WebP/JPEG) — як є. */
export function createZipWriter(): {
  addText: (name: string, text: string) => void;
  addFile: (name: string, bytes: Uint8Array) => void;
  finish: () => Uint8Array[];
} {
  const chunks: Uint8Array[] = [];
  let failure: Error | null = null;
  const zip = new Zip((err, data) => {
    if (err) failure = err;
    else chunks.push(data);
  });
  const check = () => {
    if (failure) throw failure;
  };
  return {
    addText(name, text) {
      const entry = new ZipDeflate(name, { level: 6 });
      zip.add(entry);
      entry.push(strToU8(text), true);
      check();
    },
    addFile(name, bytes) {
      const entry = new ZipPassThrough(name);
      zip.add(entry);
      entry.push(bytes, true);
      check();
    },
    finish() {
      zip.end();
      check();
      return chunks;
    },
  };
}

/** Чи це взагалі ZIP — за підписом локального заголовка. */
export function looksLikeZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

/**
 * Перелік архіву без розпакування: лише наші імена й у межах розмірів.
 * Імена з `../`, абсолютні шляхи й решта чужого просто не потрапляють у
 * перелік — далі їх ніхто не шукає. Розмір — більший із двох заголовків:
 * `fflate` не віддає більше, ніж обіцяє заголовок, тож «ZIP-бомба» з
 * заниженим розміром дає обрізаний файл, а не гігабайти в пам'яті.
 * Зламаний архів — виняток.
 */
export function indexArchive(bytes: Uint8Array): ArchiveIndex {
  const index: ArchiveIndex = new Map();
  unzipSync(bytes, {
    filter(file) {
      const size = Math.max(file.size, file.originalSize);
      if ((file.compression === 0 || file.compression === 8) && wantedEntry(file.name, size)) {
        index.set(file.name, size);
      }
      return false;
    },
  });
  return index;
}

/** Один файл з архіву; `null`, якщо такого немає чи він поза межами. */
export function readEntry(bytes: Uint8Array, name: string): Uint8Array | null {
  const out = unzipSync(bytes, {
    filter: (file) =>
      file.name === name &&
      (file.compression === 0 || file.compression === 8) &&
      wantedEntry(file.name, Math.max(file.size, file.originalSize)),
  });
  return out[name] ?? null;
}

export function readManifest(bytes: Uint8Array): string | null {
  const entry = readEntry(bytes, BACKUP_MANIFEST);
  return entry ? strFromU8(entry) : null;
}
