/**
 * Застосунок Wishlist для Android (ADR-080, ADR-081, ADR-082).
 *
 * Той самий сайт, відкритий у Trusted Web Activity, плюс «У вішліст» у меню
 * «Поділитися», що приносить назву, ціну й фото навіть з Allegro й Amazon.
 * Тут — чи пропонувати його людині й куди вести по файл.
 *
 * Модуль імпортується в main.tsx: позначку треба поставити на першому ж
 * завантаженні, поки `document.referrer` ще той, з яким відкрив застосунок.
 */

/** Пакет застосунку — той самий, що в `android/app/build.gradle.kts`. */
export const ANDROID_PACKAGE = 'pl.yozh.wishlist';

/**
 * Постійне посилання на останню версію APK: GitHub віддає файл із
 * найсвіжішого Release (workflow `android.yml`). Відкривається без акаунта.
 */
export const ANDROID_APK_URL =
  'https://github.com/yozh150991/Wishlist_personal/releases/latest/download/wishlist.apk';

const KEY = 'wl.androidApp';

/**
 * Chrome відкриває Trusted Web Activity з `document.referrer`
 * `android-app://<пакет>` — це задокументований спосіб упізнати застосунок.
 * Лише на першій сторінці, тож запамʼятовуємо на пристрої. Сховище в TWA
 * спільне з Chrome: після першого запуску застосунку пропозиція зникає і в
 * браузері — встановлювати вдруге нічого.
 */
export function fromReferrer(referrer: string): boolean {
  // Точний пакет: старий помічник `pl.yozh.wishlistshare` — не застосунок.
  const base = `android-app://${ANDROID_PACKAGE}`;
  return referrer === base || referrer.startsWith(`${base}/`);
}

export function markAndroidApp(referrer: string = typeof document !== 'undefined' ? document.referrer : ''): void {
  if (!fromReferrer(referrer)) return;
  try {
    localStorage.setItem(KEY, '1');
  } catch {
    /* приватний режим — пропозиція лишиться, шкоди немає */
  }
}

/** Відкрито в застосунку Wishlist — зараз чи колись раніше на цьому пристрої. */
export function inAndroidApp(): boolean {
  if (typeof document !== 'undefined' && fromReferrer(document.referrer)) return true;
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

/** Що показувати про застосунок: запропонувати, підказати «Поділитися» чи нічого. */
export type AndroidOffer = 'offer' | 'app' | null;

/** Чисте правило — для тестів і для `androidOffer`. */
export function androidOfferFor(userAgent: string, appSeen: boolean): AndroidOffer {
  if (!/android/i.test(userAgent)) return null;
  return appSeen ? 'app' : 'offer';
}

export function androidOffer(): AndroidOffer {
  if (typeof navigator === 'undefined') return null;
  return androidOfferFor(navigator.userAgent, inAndroidApp());
}

if (typeof window !== 'undefined') markAndroidApp();
