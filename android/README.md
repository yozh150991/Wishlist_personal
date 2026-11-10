# Wishlist для Android

Один APK із двох частин (ADR-080, ADR-081):

- **Іконка Wishlist** — сам сайт на весь екран у Chrome (Trusted Web Activity, бібліотека Google [android-browser-helper](https://github.com/GoogleChrome/android-browser-helper)). Вхід спільний із Chrome, push-сповіщення працюють, вміст оновлюється з сайту.
- **«У вішліст» у меню «Поділитися»** — відкриває сторінку товару в невидимому WebView на самому телефоні, читає назву, ціну й фото тими самими правилами, що й закладка «У вішліст», і відкриває форму `/add` у цьому ж застосунку. Так дані приходять навіть з Allegro й Amazon, які не пускають наш парсер.

## Як працює «У вішліст»

1. «Поділитися» з додатка магазину чи з Chrome → «У вішліст».
2. Внизу картка «Читаю сторінку магазину…»; сторінка вантажиться у WebView за нею.
3. Раз на секунду по сторінці проходить `assets/grab.js` (= `pageGrab` з `app/src/lib/bookmarklet.ts`).
4. Є назва, ціна й фото — відкривається форма Wishlist.
5. За 15 секунд ціни немає — показується сама сторінка: там може бути перевірка «чи ти не робот», її можна пройти, і форма відкриється сама. Або «Додати як є».

Діагностика: Logcat, фільтр `tag:WishlistShare` — кожна проба з часом і тим, що знайдено.

## Файли

| Що | Де |
|---|---|
| TWA: стартова адреса, кольори, заставка, App Links | `app/src/main/AndroidManifest.xml` (`LauncherActivity`) |
| Пара з сайтом | `asset_statements` (з `build.gradle.kts`) ↔ `app/public/.well-known/assetlinks.json` |
| Push-сповіщення | `DelegationService.kt` |
| «У вішліст» | `ShareActivity.kt`, `Shared.kt`, `Grab.kt`, `assets/grab.js` |
| Адреса сайту | `wishlistOrigin` у `gradle.properties` |

## Збірка

**GitHub Actions** (`.github/workflows/android.yml`): Actions → запуск `android` → Artifacts → `wishlist-android` → `wishlist.apk`. З секретами ключа — підписаний release; без них — debug тимчасовим ключем (рядок адреси вгорі, поверх не оновлюється).

**Android Studio:** Open → тека `android` → Run. Потрібна Studio з AGP 8.9 (Meerkat або новіша), Android SDK 36, JDK 17+. Щоб збірка ставилась поверх збірки з CI і Chrome її впізнавав — ключ у `%USERPROFILE%\.gradle\gradle.properties` (DEPLOY.md, 14.4).

Ключ підпису, секрети, `assetlinks.json` і встановлення на телефон — `docs/DEPLOY.md`, розділ 14.

## Коли змінюється закладка

`grab.js` не редагується вручну. Після будь-якої зміни `pageGrab`:

```
cd app
npm run build:android-grab
```

і закомітити оновлений `android/app/src/main/assets/grab.js`. CI перевіряє, що файл збігається з `bookmarklet.ts`.
