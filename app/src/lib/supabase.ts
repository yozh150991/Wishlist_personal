import { createClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!url || !key) {
  throw new Error(
    'Немає VITE_SUPABASE_URL або VITE_SUPABASE_PUBLISHABLE_KEY. ' +
      'Скопіюй .env.example у app/.env.local і заповни значення з дашборду Supabase.',
  );
}

/**
 * Запити до даних без мережі падають одразу.
 *
 * Клієнт PostgREST повторює GET-запит тричі з паузами 1, 2 і 4 с, якщо fetch
 * відхилено. У звичайній мережі це рятує від короткого збою, але коли пристрій
 * явно офлайн (встановлений застосунок у метро), людина 7 секунд дивиться на
 * «Завантаження…» заради гарантовано марних спроб. Помилка з імʼям AbortError
 * клієнтом не повторюється, а errorText показує для неї «Немає зʼєднання».
 *
 * Лише для /rest/v1/. Запити автентифікації йдуть як завжди: невдале оновлення
 * токена з неочікуваною помилкою клієнт Auth може сприйняти як привід завершити
 * сесію, а вилогінювати людину через відсутність мережі не можна.
 */
const offlineAwareFetch: typeof fetch = (input, init) => {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (navigator.onLine === false && target.includes('/rest/v1/')) {
    return Promise.reject(new DOMException('Offline', 'AbortError'));
  }
  return fetch(input, init);
};

export const supabase = createClient(url, key, {
  global: { fetch: offlineAwareFetch },
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'pkce',
  },
});

/** Базова адреса застосунку для листів підтвердження і скидання пароля. */
export const publicOrigin = import.meta.env.VITE_PUBLIC_ORIGIN ?? window.location.origin;
