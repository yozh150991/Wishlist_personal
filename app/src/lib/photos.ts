import { supabase } from './supabase';
import { PHOTO_BUCKET, PHOTO_OUTPUT_MAX, PhotoError, fitSize, photoInputProblem } from './photoRules';
import type { PhotoErrorKey, PhotoExt } from './photoRules';

/**
 * Своє фото позиції (ADR-073).
 *
 * Фото не їде на сервер як є. Браузер зменшує його до `PHOTO_MAX_SIDE` по
 * довшій стороні й перекодовує в WebP (або JPEG, якщо WebP не вміє), і саме
 * перекодування стирає EXIF — координати, де знято, модель телефона, час.
 * Гості бачать фото за адресою, тож ці дані до них не мають доїхати.
 *
 * Адресу видає база (`reserve_item_photo`): 32 випадкові символи, як токен,
 * плюс ліміти на акаунт. Файл кладеться саме туди, і посилання на нього йде
 * в той самий `image_url`, що й фото з магазину: гостьова, офлайн-копія,
 * експорт нічого про «своє» фото знати не мусять.
 *
 * Видаляти файл тут не треба й не можна: на нього може посилатися ще
 * позиція в черзі офлайн-змін чи тост «Відмінити». Файли, на які вже ніщо не
 * посилається, прибирає wishlist-jobs раз на добу.
 */

export {
  PHOTO_BUCKET,
  PHOTO_INPUT_MAX,
  PHOTO_MAX_SIDE,
  PHOTO_OUTPUT_MAX,
  PHOTO_QUOTA,
  PhotoError,
  fitSize,
  isOwnPhoto,
  photoInputProblem,
} from './photoRules';
export type { PhotoErrorKey, PhotoExt } from './photoRules';

const QUALITIES = [0.82, 0.7, 0.55];
const FORMATS: { type: string; ext: PhotoExt }[] = [
  { type: 'image/webp', ext: 'webp' },
  { type: 'image/jpeg', ext: 'jpg' },
];

function toBlob(canvas: HTMLCanvasElement, type: string, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}

/**
 * Файл → зменшене фото без EXIF. `imageOrientation: 'from-image'` повертає
 * знімок так, як його бачила людина: поворот живе в EXIF, який далі зникне.
 */
export async function preparePhoto(file: File): Promise<{ blob: Blob; ext: PhotoExt }> {
  const problem = photoInputProblem(file);
  if (problem) throw new PhotoError(problem);

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    // HEIC поза Safari, зіпсований файл, не картинка з порожнім типом.
    throw new PhotoError('v2item.photo.upload.unreadable');
  }

  const { width, height } = fitSize(bitmap.width, bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    throw new PhotoError('v2item.photo.upload.unreadable');
  }
  // Прозорі PNG — на білому: у JPEG прозорість стала б чорною.
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  for (const { type, ext } of FORMATS) {
    for (const quality of QUALITIES) {
      const blob = await toBlob(canvas, type, quality);
      // Браузер, що не вміє формат, мовчки віддає PNG — такий не беремо.
      if (!blob || blob.type !== type) break;
      if (blob.size <= PHOTO_OUTPUT_MAX) return { blob, ext };
    }
  }
  throw new PhotoError('v2item.photo.upload.tooBig');
}

/** Помилка бази → ключ: ліміти приходять як `photo_quota` / `photo_rate`. */
function reserveProblem(error: { message?: string }): PhotoErrorKey | null {
  if (error.message === 'photo_quota') return 'v2item.photo.upload.quota';
  if (error.message === 'photo_rate') return 'v2item.photo.upload.rate';
  return null;
}

/** Завантажити своє фото; повертає адресу для `image_url`. */
export async function uploadPhoto(file: File): Promise<string> {
  const { blob, ext } = await preparePhoto(file);

  const { data: path, error } = await supabase.rpc('reserve_item_photo', { p_ext: ext });
  if (error) {
    const key = reserveProblem(error);
    throw key ? new PhotoError(key) : error;
  }
  if (typeof path !== 'string') throw new Error('reserve_item_photo');

  const bucket = supabase.storage.from(PHOTO_BUCKET);
  const { error: upload } = await bucket.upload(path, blob, {
    contentType: blob.type,
    // Адреса ніколи не перезаписується: заміна фото — нова адреса.
    cacheControl: '31536000',
    upsert: false,
  });
  if (upload) throw upload;
  return bucket.getPublicUrl(path).data.publicUrl;
}
