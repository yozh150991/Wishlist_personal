import { test, expect } from '@playwright/test';
import {
  PHOTO_INPUT_MAX,
  PHOTO_MAX_SIDE,
  fitSize,
  isOwnPhoto,
  photoInputProblem,
} from '../../src/lib/photoRules';

/**
 * Своє фото позиції (ADR-073) — правила без браузера й бази. Саме
 * стиснення, стирання EXIF і завантаження — у `photo-upload.spec.ts`
 * проти локальної бази.
 */

const OWN = 'https://abc.supabase.co/storage/v1/object/public/item-photos/0123456789abcdef0123456789abcdef.webp';

test.describe('своє фото: яке фото «своє»', () => {
  test('адреса з нашого бакета з випадковим ім’ям — своє', () => {
    expect(isOwnPhoto(OWN)).toBe(true);
    expect(isOwnPhoto(OWN.replace('.webp', '.jpg'))).toBe(true);
    expect(isOwnPhoto(`  ${OWN}  `)).toBe(true);
    expect(isOwnPhoto('http://127.0.0.1:54321/storage/v1/object/public/item-photos/0123456789abcdef0123456789abcdef.jpg')).toBe(true);
  });

  test('фото з магазину, інший бакет, інше ім’я, порожньо — не своє', () => {
    expect(isOwnPhoto('https://shop.example/img/kettle.webp')).toBe(false);
    expect(isOwnPhoto(OWN.replace('item-photos', 'avatars'))).toBe(false);
    expect(isOwnPhoto(OWN.replace('0123456789abcdef0123456789abcdef', 'kettle'))).toBe(false);
    expect(isOwnPhoto(OWN.replace('.webp', '.png'))).toBe(false);
    expect(isOwnPhoto(`${OWN}?download=1`)).toBe(false);
    expect(isOwnPhoto('')).toBe(false);
    expect(isOwnPhoto(null)).toBe(false);
    expect(isOwnPhoto(undefined)).toBe(false);
  });
});

test.describe('своє фото: розмір після зменшення', () => {
  test('довша сторона — до межі, пропорції ті самі', () => {
    expect(fitSize(4032, 3024)).toEqual({ width: PHOTO_MAX_SIDE, height: 1200 });
    expect(fitSize(3024, 4032)).toEqual({ width: 1200, height: PHOTO_MAX_SIDE });
    expect(fitSize(8000, 8000)).toEqual({ width: PHOTO_MAX_SIDE, height: PHOTO_MAX_SIDE });
  });

  test('менше за межу — не збільшуємо', () => {
    expect(fitSize(800, 600)).toEqual({ width: 800, height: 600 });
    expect(fitSize(PHOTO_MAX_SIDE, 10)).toEqual({ width: PHOTO_MAX_SIDE, height: 10 });
  });

  test('дуже вузька панорама не зникає в нуль', () => {
    expect(fitSize(20000, 3)).toEqual({ width: PHOTO_MAX_SIDE, height: 1 });
    expect(fitSize(0, 0)).toEqual({ width: 1, height: 1 });
  });
});

test.describe('своє фото: що беремося відкривати', () => {
  test('будь-яка картинка і порожній тип (HEIC з частини галерей) — пробуємо', () => {
    expect(photoInputProblem({ type: 'image/jpeg', size: 3_000_000 })).toBeNull();
    expect(photoInputProblem({ type: 'image/heic', size: 3_000_000 })).toBeNull();
    expect(photoInputProblem({ type: '', size: 3_000_000 })).toBeNull();
  });

  test('не картинка — notImage; понад 25 МБ — tooBig', () => {
    expect(photoInputProblem({ type: 'application/pdf', size: 1000 })).toBe('v2item.photo.upload.notImage');
    expect(photoInputProblem({ type: 'video/mp4', size: 1000 })).toBe('v2item.photo.upload.notImage');
    expect(photoInputProblem({ type: 'image/png', size: PHOTO_INPUT_MAX })).toBeNull();
    expect(photoInputProblem({ type: 'image/png', size: PHOTO_INPUT_MAX + 1 })).toBe('v2item.photo.upload.tooBig');
  });
});
