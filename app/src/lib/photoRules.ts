/**
 * Чисті правила свого фото позиції (ADR-073): без браузера, мережі й
 * Supabase — щоб їх перевіряли логічні тести (tests/e2e/photo-rules.spec.ts).
 * Стиснення й завантаження — у `photos.ts`.
 */

export const PHOTO_BUCKET = 'item-photos';
/** Довша сторона після зменшення: досить для картки й повноекранного перегляду. */
export const PHOTO_MAX_SIDE = 1600;
/** Що взагалі беремося відкривати. Більше — це вже не фото з телефона. */
export const PHOTO_INPUT_MAX = 25 * 1024 * 1024;
/** Межа файлу після стиснення — та сама, що `file_size_limit` бакета. */
export const PHOTO_OUTPUT_MAX = 2 * 1024 * 1024;
/** Межа з `reserve_item_photo`; число лише для тексту помилки. */
export const PHOTO_QUOTA = 1000;

export type PhotoExt = 'webp' | 'jpg';

/** Помилка з ключем перекладу: що сталося, людина має прочитати своєю мовою. */
export class PhotoError extends Error {
  constructor(readonly key: PhotoErrorKey) {
    super(key);
    this.name = 'PhotoError';
  }
}

export type PhotoErrorKey =
  | 'v2item.photo.upload.notImage'
  | 'v2item.photo.upload.unreadable'
  | 'v2item.photo.upload.tooBig'
  | 'v2item.photo.upload.quota'
  | 'v2item.photo.upload.rate';

/** Адреса свого фото з нашого сховища — так її впізнає форма позиції. */
const OWN_PHOTO = /\/storage\/v1\/object\/public\/item-photos\/[0-9a-f]{32}\.(?:webp|jpg)$/;

export function isOwnPhoto(url: string | null | undefined): boolean {
  return typeof url === 'string' && OWN_PHOTO.test(url.trim());
}

/** Розмір після зменшення: пропорції ті самі, менше за оригінал — ніколи. */
export function fitSize(width: number, height: number, max = PHOTO_MAX_SIDE): { width: number; height: number } {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const scale = Math.min(1, max / Math.max(w, h));
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

/** Чи схожий файл на фото — до того, як його розкодовувати. */
export function photoInputProblem(file: { type: string; size: number }): PhotoErrorKey | null {
  // Частина Android-галерей не дає типу HEIC; порожній тип пробуємо розкодувати.
  if (file.type !== '' && !file.type.startsWith('image/')) return 'v2item.photo.upload.notImage';
  if (file.size > PHOTO_INPUT_MAX) return 'v2item.photo.upload.tooBig';
  return null;
}
