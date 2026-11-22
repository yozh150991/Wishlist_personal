import { readFileSync } from 'node:fs';
import { defineConfig, loadEnv } from 'vite';
import type { Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * `<link rel="preconnect">` до Supabase у `<head>`: гостьова й «Мої списки»
 * першим ділом ідуть у базу, і зʼєднання (DNS, TLS) встигає відкритись, поки
 * завантажується JS (Lighthouse, «uses-rel-preconnect»). Без адреси в
 * оточенні (збірка в CI) рядка просто немає.
 */
function preconnectSupabase(url: string | undefined): Plugin {
  return {
    name: 'wishlist-preconnect-supabase',
    transformIndexHtml() {
      if (!url || !/^https?:\/\//.test(url)) return [];
      return [{ tag: 'link', attrs: { rel: 'preconnect', href: new URL(url).origin, crossorigin: '' }, injectTo: 'head' }];
    },
  };
}

/**
 * Версія з package.json — у збірку як `__APP_VERSION__`, видно внизу Налаштувань.
 * Піднята версія міняє код застосунку, отже й Service Worker: відкриті вкладки
 * отримують банер «Оновити», а після оновлення в Налаштуваннях видно новий номер.
 */
const APP_VERSION = (JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')) as { version: string }).version;

/**
 * Бібліотеки — окремими файлами від коду застосунку (ADR-084).
 *
 * Імʼя файлу містить хеш його вмісту, а `/assets/*` віддається з
 * `Cache-Control: immutable` і лежить у кеші Service Worker за цим імʼям. Поки
 * бібліотеки жили в одному файлі з кодом застосунку, кожен реліз міняв хеш
 * усього пакета, і телефон перекачував React і supabase-js заради правки в
 * одному екрані. Тепер реліз міняє лише файли застосунку.
 *
 * Групи — за тим, коли вони міняються:
 * - `vendor-react` — React, його планувальник і маршрутизатор: оновлюються разом і рідко;
 * - `vendor-supabase` — клієнт Supabase з його залежностями: окремо, бо
 *   оновлюється частіше за React і є кандидатом на заміну (ROADMAP, 8.27);
 * - `vendor-dnd` — перетягування позицій; потрібне лише екранам власника, тож
 *   його тягне лінивий чанк `OwnerScreens`, а не головна сторінка й не гостьова.
 *
 * Навмисно НЕ тут: `lucide-react` (у кожен чанк їдуть лише його іконки; спільний
 * файл міняв би хеш із кожною новою іконкою), `qrcode-generator` і
 * `workbox-window` (уже окремі ліниві чанки).
 *
 * Список — точні назви пакетів, а не «усе з node_modules»: нова залежність не
 * потрапить у стабільний файл мовчки. Хеші стабільні, лише поки ці файли не
 * імпортують нічого з коду застосунку — це стереже `npm run check:pwa`.
 */
const VENDOR_CHUNKS: Record<string, readonly string[]> = {
  'vendor-react': ['react', 'react-dom', 'scheduler', 'react-router', 'react-router-dom', '@remix-run/router'],
  'vendor-supabase': ['@supabase/', 'tslib', 'iceberg-js'],
  'vendor-dnd': ['@dnd-kit/'],
};

/**
 * Словники мов — кожен своїм чанком `locale-<мова>` (ROADMAP 8.24): застосунок
 * качає лише активну мову (`lib/i18n.tsx`). Окреме імʼя, а не усталене `uk-*.js`,
 * щоб `npm run check:pwa` впізнавав їх: ні вхідний файл, ні гостьова не тягнуть
 * їх одразу, а в кеші оболонки — усі три (офлайн-перемикання мови).
 */
const LOCALE_FILE = /\/src\/i18n\/(uk|pl|en)\.json$/;

function chunkFor(id: string): string | undefined {
  const locale = LOCALE_FILE.exec(id.replace(/\\/g, '/'))?.[1];
  if (locale) return `locale-${locale}`;
  return vendorChunk(id);
}

function vendorChunk(id: string): string | undefined {
  const at = id.lastIndexOf('/node_modules/');
  if (at < 0) return undefined;
  const path = id.slice(at + '/node_modules/'.length);
  for (const [chunk, packages] of Object.entries(VENDOR_CHUNKS)) {
    // `@scope/` — усі пакети простору імен; інакше — точна назва пакета.
    if (packages.some((p) => (p.endsWith('/') ? path.startsWith(p) : path.startsWith(`${p}/`)))) return chunk;
  }
  return undefined;
}

export default defineConfig(({ mode }) => ({
  define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
  plugins: [
    react(),
    preconnectSupabase(loadEnv(mode, process.cwd(), 'VITE_').VITE_SUPABASE_URL),
    // Встановлення на телефон і оболонка застосунку офлайн (ROADMAP, етап 6.1).
    // Дані списків тут НЕ кешуються — це окремий крок з IndexedDB.
    VitePWA({
      // Нова версія не підміняє сторінку сама: людина може бути посеред
      // редагування. UpdatePrompt показує банер, оновлення — за кнопкою.
      registerType: 'prompt',
      injectRegister: false,
      // Іконки потрапляють у кеш через globPatterns нижче; без цього
      // вони були б у списку двічі.
      includeManifestIcons: false,
      manifest: {
        id: '/',
        name: 'Wishlist',
        short_name: 'Wishlist',
        description: 'Приватні списки бажань із секретними посиланнями для рідних',
        lang: 'uk',
        dir: 'ltr',
        start_url: '/lists',
        scope: '/',
        display: 'standalone',
        // Wishlist у системному «Поділитися» (Android, десктопний Chrome; потік L,
        // ADR-046). GET: поширене приходить параметрами, а `/add` прибирає їх з адреси.
        share_target: {
          action: '/add',
          method: 'GET',
          params: { title: 'title', text: 'text', url: 'url' },
        },
        background_color: '#f5f6f4',
        theme_color: '#ffffff',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icons/maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        // Оболонка: код, стилі, шрифти (самохостяться саме заради офлайну), іконки.
        // Карти коду (.map) не кешуються: вони великі й користувачам не потрібні.
        globPatterns: ['**/*.{js,css,html,svg,png,woff2}'], // маніфест плагін додає сам
        globIgnores: [
          // Джерело для генерації maskable-512.png, сторінці не потрібне.
          'icons/maskable.svg',
          // Шрифти самохостяться з усіма підмножинами, але застосунок українською,
          // польською й англійською: решта письмен у кеш не їде. Rubik возить із
          // собою ще арабицю й іврит — це близько 200 КБ, яких ніхто не побачить.
          'assets/*-greek-*.woff2',
          'assets/*-vietnamese-*.woff2',
          'assets/*-arabic-*.woff2',
          'assets/*-hebrew-*.woff2',
          // QR тягнеться ліниво й лише в налаштуваннях на десктопі. Класти
          // 50 КБ у кеш оболонки заради панелі, яку відкривають раз, немає
          // сенсу — та й сканувати QR без мережі нікуди.
          'assets/qrcode*.js',
        ],
        // Будь-яка адреса застосунку відкривається з кешованого index.html,
        // навіть без мережі.
        navigateFallback: '/index.html',
        // Крім гостьових сторінок: відповідь на /s/<токен> (гостьова v1) чи
        // /l/<токен> (гостьова v2, ADR-041) не має лягати в кеш пристрою разом
        // із токеном і ключем гостя (ARCHITECTURE.md, «Офлайн-режим»).
        // І крім /.well-known/: там лежить assetlinks.json для Android-застосунку
        // (ADR-081) — справжній файл, а не сторінка застосунку.
        navigateFallbackDenylist: [/^\/s\//, /^\/l\//, /^\/\.well-known\//],
        cleanupOutdatedCaches: true,
        // Запити до Supabase і парсера — завжди в мережу.
        runtimeCaching: [],
        // Push-сповіщення власника (ADR-049): обробники push і натиску на
        // сповіщення. Перевіряє `npm run check:pwa`.
        importScripts: ['push-sw.js'],
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 5173,
    // Якщо порт зайнятий, не перескакувати мовчки на 5174, а впасти з помилкою.
    // Інакше старий процес лишається на 5173, новий тихо сідає поруч, і браузер
    // та Playwright ходять на старий — з чужим токеном HMR і, можливо, з бойовою базою.
    strictPort: true,
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // Шрифти ніколи не вбудовуються в CSS як `data:` URI. Vite за усталеним
    // порогом інлайнить усе, менше за 4 КБ, і під нього потрапляла кирилиця-ext
    // Manrope — разом зі знаком ₴. CSP дозволяє `font-src 'self'`, тож
    // браузер такий шрифт мовчки блокував, і знак гривні в бою малювався
    // системним шрифтом. Перевіряє `npm run check:pwa`.
    assetsInlineLimit: (file: string) => (/\.(woff2?|ttf|otf|eot)$/i.test(file) ? false : undefined),
    rollupOptions: { output: { manualChunks: chunkFor } },
  },
}));
