import { test, expect } from '@playwright/test';
import { ANDROID_APK_URL, ANDROID_PACKAGE, androidOfferFor, fromReferrer } from '../../src/lib/androidApp';
import { readFileSync } from 'node:fs';

// Застосунок Wishlist для Android: кому його пропонувати (ADR-082).

const PIXEL =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36';
const IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DESKTOP =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

test.describe('кому пропонувати застосунок для Android', () => {
  test('Android поза застосунком — пропозиція; у застосунку — підказка «Поділитися»', () => {
    expect(androidOfferFor(PIXEL, false)).toBe('offer');
    expect(androidOfferFor(PIXEL, true)).toBe('app');
  });

  test('iPhone і компʼютер — нічого', () => {
    expect(androidOfferFor(IPHONE, false)).toBeNull();
    expect(androidOfferFor(DESKTOP, false)).toBeNull();
    expect(androidOfferFor(DESKTOP, true)).toBeNull();
  });
});

test.describe('упізнати застосунок за referrer (TWA)', () => {
  test('referrer застосунку — так', () => {
    expect(fromReferrer(`android-app://${ANDROID_PACKAGE}`)).toBe(true);
    expect(fromReferrer(`android-app://${ANDROID_PACKAGE}/`)).toBe(true);
  });

  test('старий помічник, інший застосунок, звичайний сайт — ні', () => {
    expect(fromReferrer('android-app://pl.yozh.wishlistshare')).toBe(false);
    expect(fromReferrer('android-app://com.android.chrome/')).toBe(false);
    expect(fromReferrer('https://allegro.pl/')).toBe(false);
    expect(fromReferrer('')).toBe(false);
  });
});

test.describe('збіг із Android-проєктом', () => {
  test('пакет — той самий, що в build.gradle.kts', () => {
    const gradle = readFileSync(new URL('../../../android/app/build.gradle.kts', import.meta.url), 'utf8');
    expect(gradle).toContain(`applicationId = "${ANDROID_PACKAGE}"`);
  });

  test('посилання — на останній Release цього репозиторію, файл wishlist.apk', () => {
    expect(ANDROID_APK_URL).toMatch(/^https:\/\/github\.com\/[^/]+\/[^/]+\/releases\/latest\/download\/wishlist\.apk$/);
    const workflow = readFileSync(new URL('../../../.github/workflows/android.yml', import.meta.url), 'utf8');
    expect(workflow).toContain('gh release create');
    expect(workflow).toContain('/wishlist.apk');
  });
});
