import { useCallback, useEffect, useRef, useState } from 'react';
import { useI18n } from '../lib/i18n';

/**
 * Скасування замість підтвердження.
 *
 * Зворотна дія не питає дозволу — вона дає сім секунд, щоб передумати.
 * Діалог лишається тільки незворотному: видаленню списку, масовому видаленню.
 * Підтвердження на те, що й так можна відкотити, люди перестають читати
 * і натискають «так» не дивлячись — тобто воно не захищає ні від чого.
 *
 * Дія справді **не виконується** до кінця відліку: скасування має бути
 * миттєвим і не залежати від мережі. Ціна — сім секунд, протягом яких зміна
 * живе лише на екрані; тому при виході зі сторінки відлік не втрачається,
 * а завершується негайно.
 */

const DELAY = 7000;

export type Pending = {
  /** Що сталося — минулим часом: «Позицію видалено». */
  label: string;
  /** Справжня дія. Викликається, коли час вийшов або людина пішла зі сторінки. */
  commit: () => void;
  /** Повернути екран у попередній стан. */
  revert: () => void;
};

export function useUndo() {
  const [pending, setPending] = useState<Pending | null>(null);
  const timer = useRef<number | null>(null);
  // Тримаємо в ref, щоб прибирання ефекту бачило актуальне значення,
  // а не те, яке було на момент підписки.
  const current = useRef<Pending | null>(null);

  const clear = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    current.current = null;
    setPending(null);
  }, []);

  const commitNow = useCallback(() => {
    const p = current.current;
    clear();
    p?.commit();
  }, [clear]);

  const schedule = useCallback(
    (next: Pending) => {
      // Друга дія поспіль не скасовує першу: та вже відбулась на екрані,
      // і людина чекає, що вона доїде.
      commitNow();
      current.current = next;
      setPending(next);
      timer.current = window.setTimeout(() => {
        const p = current.current;
        clear();
        p?.commit();
      }, DELAY);
    },
    [clear, commitNow],
  );

  const undo = useCallback(() => {
    const p = current.current;
    clear();
    p?.revert();
  }, [clear]);

  // Пішли зі сторінки — доводимо незавершене до кінця. Мовчки втратити
  // видалення, яке людина вже бачила виконаним, гірше за все інше.
  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    current.current?.commit();
  }, []);

  return { pending, schedule, undo };
}

export function UndoToast({ pending, onUndo }: { pending: Pending | null; onUndo: () => void }) {
  const { t } = useI18n();
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  if (!pending) return null;

  return (
    <div className="undo" role="status">
      <div className="undo__row">
        <span className="undo__label">{pending.label}</span>
        <button type="button" className="btn btn--compact undo__btn" onClick={onUndo}>
          {t('undo.action')}
        </button>
      </div>
      {/* Офлайн зміна йде в ту саму чергу, тож поводиться однаково —
          змінюється лише примітка. */}
      {!online && <span className="undo__note">{t('undo.offline')}</span>}
      {/* Смужка показує, скільки лишилось. Вона декоративна: те саме
          сказано тим, що кнопка зникає. */}
      <span className="undo__bar" aria-hidden="true">
        <span className="undo__fill" />
      </span>
    </div>
  );
}
