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
 * Скільки чекати на відповідь Auth, перш ніж визнати, що її не буде.
 *
 * Мережа буває не лише «є» або «немає»: сервер може прийняти зʼєднання й
 * замовкнути — зламане прокидування порту в локальному Docker, проксі, що
 * ковтає запит, завислий балансувальник. Тоді fetch не відхиляється ніколи,
 * а форма входу лишається з вимкненою кнопкою й без жодного повідомлення.
 * Саме так виглядав день налагодження локального стеку (SETUP.md, розділ 8).
 *
 * 15 секунд — свідомо багато: звичайний вхід укладається в пів секунди навіть
 * на поганому мобільному звʼязку, тож помилкових спрацювань не буде.
 */
const AUTH_TIMEOUT_MS = 15_000;

/** Сигнал, що спрацює через `ms` або коли скасує сам викликач. */
function withTimeout(caller: AbortSignal | null | undefined, ms: number) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new DOMException('Timeout', 'TimeoutError')), ms);
  if (caller) {
    if (caller.aborted) ctl.abort(caller.reason);
    else caller.addEventListener('abort', () => ctl.abort(caller.reason), { once: true });
  }
  return { signal: ctl.signal, done: () => clearTimeout(timer) };
}

/**
 * Мережевий шар клієнта: два різні лікування двох різних бід.
 *
 * **Дані без мережі падають одразу.** Клієнт PostgREST повторює GET-запит тричі
 * з паузами 1, 2 і 4 с, якщо fetch відхилено. У звичайній мережі це рятує від
 * короткого збою, але коли пристрій явно офлайн (встановлений застосунок у
 * метро), людина 7 секунд дивиться на «Завантаження…» заради гарантовано
 * марних спроб. Помилка з імʼям AbortError клієнтом не повторюється, а
 * errorText показує для неї «Немає зʼєднання».
 *
 * **Автентифікація обмежена тайм-аутом, але не скасовується достроково.** Тут
 * `navigator.onLine` навмисне не перевіряється: невдале оновлення токена з
 * неочікуваною помилкою клієнт Auth може сприйняти як привід завершити сесію, а
 * вилогінювати людину через відсутність мережі не можна. Тайм-аут безпечний з
 * іншої причини — обрив fetch клієнт загортає в AuthRetryableFetchError, тобто
 * помилку «спробуй ще раз», після якої сесія лишається на місці.
 */
const offlineAwareFetch: typeof fetch = (input, init) => {
  const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

  if (navigator.onLine === false && target.includes('/rest/v1/')) {
    return Promise.reject(new DOMException('Offline', 'AbortError'));
  }

  if (target.includes('/auth/v1/')) {
    const { signal, done } = withTimeout(init?.signal, AUTH_TIMEOUT_MS);
    return fetch(input, { ...init, signal }).finally(done);
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
