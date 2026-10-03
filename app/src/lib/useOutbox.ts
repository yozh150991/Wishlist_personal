import { useCallback, useEffect, useState } from 'react';
import { useAuth } from './auth';
import { flush, pendingCount, subscribe } from './outbox';
import type { Dropped } from './outbox';

/**
 * Черга офлайн-змін для оболонки застосунку — спільна для обох версій дизайну
 * (ROADMAP 6.5, ADR-029).
 *
 * Відправляє чергу, щойно зʼявилась мережа й при відкритті оболонки; рахує, що
 * ще чекає; збирає зміни, які сервер відхилив, — їх показуємо, доки людина не
 * закриє, інакше зміна зникла б без сліду. Вигляд повідомлень у кожної версії
 * свій (`components/Banners.tsx` у v1, `designs/v2/ShellV2.tsx` у v2): без
 * цього хука черга, зібрана у v2, відправлялась би лише після переходу у v1.
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

  const send = useCallback(async () => {
    if (!userId || busy) return;
    setBusy(true);
    try {
      const result = await flush(userId);
      if (result.dropped.length) setDropped((prev) => [...prev, ...result.dropped]);
    } finally {
      setBusy(false);
      refresh();
    }
  }, [userId, busy, refresh]);

  useEffect(() => {
    refresh();
    return subscribe(refresh);
  }, [refresh]);

  useEffect(() => {
    if (!userId) return;
    void send();
    const onOnline = () => void send();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
    // send змінюється разом із busy, а перепідписуватись на кожну відправку не
    // треба: слухач читає актуальний userId через замикання.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  const clearDropped = useCallback(() => setDropped([]), []);

  return { count, busy, dropped, send, clearDropped };
}
