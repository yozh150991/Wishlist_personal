import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from './auth';
import { flush, pendingCount, subscribe } from './outbox';
import type { Dropped } from './outbox';

/**
 * Паузи між повторами, коли мережа ніби є, а відправка впала (BUG-QA-34): 5 с,
 * 15 с, 30 с, далі щохвилини, поки вкладка на екрані.
 */
export const RETRY_DELAYS_MS = [5_000, 15_000, 30_000, 60_000] as const;

/**
 * Черга офлайн-змін для оболонки застосунку (ROADMAP 6.5, ADR-029).
 *
 * Відправляє чергу при відкритті оболонки й щоразу, як є привід думати, що
 * мережа повернулась: подія `online`, повернення застосунку на екран
 * (`visibilitychange`, `pageshow`, `focus`). Спроба, що впала на мережі,
 * повторюється сама з паузами `RETRY_DELAYS_MS`, поки застосунок на екрані.
 * Однієї події `online` мало: на iPhone вона приходить, щойно ввімкнено Wi-Fi,
 * коли запити ще падають, або не приходить зовсім, якщо застосунок був у фоні.
 * Тоді зміни висіли «чекають на мережу» до перезапуску (BUG-QA-34).
 *
 * Рахує, що ще чекає; збирає зміни, які сервер відхилив, — їх показуємо, доки
 * людина не закриє, інакше зміна зникла б без сліду. Вигляд — `designs/v2/ShellV2.tsx`.
 */
export function useOutbox() {
  const { session } = useAuth();
  const userId = session?.user.id;

  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dropped, setDropped] = useState<Dropped[]>([]);

  const refresh = useCallback(() => {
    if (!userId) return setCount(0);
    void pendingCount(userId).then(setCount);
  }, [userId]);

  // Таймер повтору й номер спроби — поза станом: їх читає й міняє `send`,
  // викликаний зі слухачів подій, і перемальовувати через них нічого не треба.
  const retryTimer = useRef(0);
  const attempt = useRef(0);
  const sending = useRef(false);

  const send = useCallback(async () => {
    if (!userId || sending.current) return;
    window.clearTimeout(retryTimer.current);
    sending.current = true;
    setBusy(true);
    try {
      const result = await flush(userId);
      if (result.dropped.length) setDropped((prev) => [...prev, ...result.dropped]);
      if (result.stalled) {
        // Мережа ще не готова — пробуємо пізніше, але лише поки застосунок на
        // екрані: у фоні браузер однаково присипляє таймери, а повернення на
        // екран і так запускає відправку.
        const delay = RETRY_DELAYS_MS[Math.min(attempt.current, RETRY_DELAYS_MS.length - 1)];
        attempt.current += 1;
        if (document.visibilityState === 'visible') {
          retryTimer.current = window.setTimeout(() => void sendRef.current(), delay);
        }
      } else {
        attempt.current = 0;
      }
    } finally {
      sending.current = false;
      setBusy(false);
      refresh();
    }
  }, [userId, refresh]);

  // Таймер викликає найсвіжіший `send`, а не той, що був на момент запуску.
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    refresh();
    return subscribe(refresh);
  }, [refresh]);

  useEffect(() => {
    if (!userId) return;
    attempt.current = 0;
    void sendRef.current();
    // Подія — новий привід спробувати: відлік пауз починається спочатку.
    const again = () => {
      attempt.current = 0;
      void sendRef.current();
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') again();
    };
    window.addEventListener('online', again);
    window.addEventListener('pageshow', again);
    window.addEventListener('focus', again);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearTimeout(retryTimer.current);
      window.removeEventListener('online', again);
      window.removeEventListener('pageshow', again);
      window.removeEventListener('focus', again);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [userId]);

  const clearDropped = useCallback(() => setDropped([]), []);

  // Кнопка «Надіслати зараз» — свідома дія людини: теж починає відлік спочатку.
  const sendNow = useCallback(() => {
    attempt.current = 0;
    return send();
  }, [send]);

  return { count, busy, dropped, send: sendNow, clearDropped };
}
