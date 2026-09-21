import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
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
        // Крім гостьових сторінок: відповідь на /s/<токен> не має лягати
        // в кеш пристрою разом із токеном (ARCHITECTURE.md, «Офлайн-режим»).
        navigateFallbackDenylist: [/^\/s\//],
        cleanupOutdatedCaches: true,
        // Запити до Supabase і парсера — завжди в мережу.
        runtimeCaching: [],
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
  },
});
