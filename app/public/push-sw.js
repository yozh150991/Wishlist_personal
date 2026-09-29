/*
 * Push-сповіщення власника (ADR-049). Service Worker збирає vite-plugin-pwa, а
 * цей файл він підключає через `workbox.importScripts` у vite.config.ts.
 *
 * Тіло push зашифроване для цього браузера (RFC 8291) і містить лише заголовок,
 * текст і адресу всередині застосунку. Про позначки гостей там нічого немає
 * (ADR-040). Адреса — лише відносна, у межах цього сайту: чужий домен з
 * повідомлення не відкривається.
 */
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (e) {
    data = {};
  }
  const title = typeof data.title === 'string' && data.title ? data.title : 'Wishlist';
  const url = typeof data.url === 'string' && data.url.startsWith('/') && !data.url.startsWith('//') ? data.url : '/lists';
  event.waitUntil(
    self.registration.showNotification(title, {
      body: typeof data.body === 'string' ? data.body : '',
      tag: typeof data.tag === 'string' ? data.tag : 'wishlist',
      icon: '/icons/icon-192.png',
      data: { url },
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/lists';
  const target = new URL(url, self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        try {
          await client.focus();
          // Вкладку, якою цей Service Worker не керує, navigate не веде —
          // тоді відкриваємо нову.
          if ('navigate' in client && (await client.navigate(target.href))) return;
        } catch (e) {
          // див. нижче
        }
        break;
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
