import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import type { ReactNode } from 'react';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { flush, pendingCount, subscribe } from '../lib/outbox';
import type { Dropped } from '../lib/outbox';
import { Icon } from './Icon';
import type { IconName } from './Icon';

/**
 * Наскрізні повідомлення: черга змін, відхилені зміни, збережена копія.
 *
 * Усі три можуть бути активні одночасно, але **на екрані завжди рівно один
 * банер — найважливіший**. Решта згорнута в текстову кнопку «Ще повідомлень: N»,
 * яка розкриває їх списком. Три банери стосом з'їдають півекрана на телефоні,
 * і людина перестає читати їх усі.
 *
 * Порядок важливості: відхилені зміни → черга змін → збережена копія.
 *
 * Офлайн — не помилка: черга й копія йдуть другим акцентом. Червоний лишається
 * тільки відхиленим змінам, тобто тому, що людині доведеться переробити.
 */

type Stale = { savedAt: Date } | null;

const StaleCtx = createContext<{ stale: Stale; setStale: (s: Stale) => void }>({
  stale: null,
  setStale: () => {},
});

/**
 * Сторінка, яка показала збережену копію замість свіжих даних, повідомляє про
 * це оболонці — банер живе в одному місці, а не дублюється на кожному екрані.
 */
export function StaleProvider({ children }: { children: ReactNode }) {
  const [stale, setStale] = useState<Stale>(null);
  const value = useMemo(() => ({ stale, setStale }), [stale]);
  return <StaleCtx.Provider value={value}>{children}</StaleCtx.Provider>;
}

/** Викликається сторінкою: `useStale(snapshot ? snapshot.savedAt : null)`. */
export function useStale(savedAt: Date | null) {
  const { setStale } = useContext(StaleCtx);
  const time = savedAt?.getTime() ?? null;
  useEffect(() => {
    setStale(time === null ? null : { savedAt: new Date(time) });
    return () => setStale(null);
  }, [time, setStale]);
}

type Item = {
  key: string;
  tone: 'danger' | 'queue' | 'stale';
  icon: IconName;
  title: string;
  body?: string;
  action?: { label: string; onClick: () => void; busy?: boolean };
  dismiss?: () => void;
};

export function Banners() {
  const { t, locale } = useI18n();
  const { session } = useAuth();
  const { stale } = useContext(StaleCtx);
  const userId = session?.user.id;

  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [dropped, setDropped] = useState<Dropped[]>([]);
  const [expanded, setExpanded] = useState(false);

  const refresh = useCallback(() => {
    if (!userId) return setCount(0);
    void pendingCount(userId).then(setCount);
  }, [userId]);

  const send = useCallback(async () => {
    if (!userId || busy) return;
    setBusy(true);
    try {
      const result = await flush(userId);
      // Відхилене сервером показуємо доти, доки людина не закриє: інакше зміна
      // зникне без сліду, і вона дізнається про це з порожнього списку.
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

  const items: Item[] = [];

  if (dropped.length > 0) {
    items.push({
      key: 'dropped',
      tone: 'danger',
      icon: 'alert',
      title: t('outbox.dropped', { n: dropped.length }),
      dismiss: () => setDropped([]),
    });
  }

  if (count > 0) {
    items.push({
      key: 'queue',
      tone: 'queue',
      icon: 'clock',
      title: t('outbox.pendingTitle', { n: count }),
      body: t('outbox.pendingBody'),
      action: {
        label: busy ? t('outbox.sending') : t('outbox.retry'),
        onClick: () => void send(),
        busy,
      },
    });
  }

  if (stale) {
    items.push({
      key: 'stale',
      tone: 'stale',
      icon: 'wifiOff',
      title: t('offline.title'),
      body: t('offline.savedAt', {
        when: new Intl.DateTimeFormat(locale, {
          day: 'numeric',
          month: 'long',
          hour: '2-digit',
          minute: '2-digit',
        }).format(stale.savedAt),
      }),
    });
  }

  if (items.length === 0) return null;

  const shown = expanded ? items : items.slice(0, 1);
  const hidden = items.length - shown.length;

  return (
    <div className="banners">
      {shown.map((item) => (
        <div
          key={item.key}
          /* data-kind — єдиний надійний спосіб відрізнити банери одне від
             одного ззовні: українською «Немає зʼєднання» починають і помилка,
             і позначка копії, тож за текстом їх не розділити. На ньому ж
             тримаються e2e-перевірки офлайну. */
          data-kind={item.key}
          className={'banner' + (item.tone === 'danger' ? ' banner--danger' : '')}
          role={item.tone === 'danger' ? 'alert' : 'status'}
        >
          <span className="banner__icon">
            <Icon name={item.icon} size={18} />
          </span>
          <div className="banner__text">
            <span className="banner__title">{item.title}</span>
            {item.body && <span>{item.body}</span>}
            {(item.action || item.dismiss) && (
              <div className="banner__actions">
                {item.action && (
                  <button
                    type="button"
                    className="btn btn--secondary btn--compact"
                    disabled={item.action.busy}
                    onClick={item.action.onClick}
                  >
                    {item.action.busy && <span className="spinner" />}
                    {item.action.label}
                  </button>
                )}
                {item.dismiss && (
                  <button type="button" className="btn btn--ghost btn--compact" onClick={item.dismiss}>
                    {t('common.close')}
                  </button>
                )}
              </div>
            )}
          </div>
        </div>
      ))}

      {hidden > 0 && (
        <button type="button" className="btn btn--ghost btn--compact" onClick={() => setExpanded(true)}>
          {t('banners.more', { n: hidden })}
        </button>
      )}
      {expanded && items.length > 1 && (
        <button type="button" className="btn btn--ghost btn--compact" onClick={() => setExpanded(false)}>
          {t('banners.less')}
        </button>
      )}
    </div>
  );
}
