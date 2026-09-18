import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { flush, pendingCount, subscribe } from '../lib/outbox';
import type { Dropped } from '../lib/outbox';

/**
 * Скільки змін чекає на мережу, і що з ними сталося (ROADMAP 6.5).
 *
 * Живе в оболонці застосунку, тож видно на будь-якій сторінці: зміну зроблено
 * в списку, а помітити, що вона не дійшла, людина може вже деінде.
 *
 * Черга відправляється сама — при появі мережі й при відкритті застосунку.
 * Кнопка поруч потрібна для випадку, коли браузер вважає мережу наявною, а
 * насправді її немає: подія `online` тоді не настане ніколи.
 */
export function OutboxNotice() {
  const { t } = useI18n();
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
      // Відхилене сервером показуємо доти, доки людина не закриє: інакше
      // зміна зникне без сліду, і вона дізнається про це з порожнього списку.
      if (result.dropped.length) setDropped((prev) => [...prev, ...result.dropped]);
    } finally {
      setBusy(false);
      refresh();
    }
  }, [userId, busy, refresh]);

  useEffect(() => {
    refresh();
    const off = subscribe(refresh);
    return off;
  }, [refresh]);

  useEffect(() => {
    if (!userId) return;
    void send();
    const onOnline = () => void send();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
    // send змінюється разом із busy, а перепідписуватись на кожну відправку
    // не треба: слухач читає актуальний userId через замикання нижче.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  if (count === 0 && dropped.length === 0) return null;

  return (
    <div className="outbox">
      {count > 0 && (
        <p className="note note--stale outbox__row" role="status">
          <span>{t('outbox.pending', { n: count })}</span>
          <button type="button" className="btn btn--quiet" disabled={busy} onClick={() => void send()}>
            {busy ? t('outbox.sending') : t('outbox.retry')}
          </button>
        </p>
      )}

      {dropped.length > 0 && (
        <p className="note outbox__row" data-tone="error" role="alert">
          <span>{t('outbox.dropped', { n: dropped.length })}</span>
          <button type="button" className="btn btn--quiet" onClick={() => setDropped([])}>
            {t('common.close')}
          </button>
        </p>
      )}
    </div>
  );
}
