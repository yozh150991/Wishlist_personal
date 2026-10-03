import { useEffect, useState } from 'react';
import { useI18n } from '../lib/i18n';
import type { Pending } from '../lib/undo';

/**
 * Тост «Скасувати» v1.
 *
 * Логіка відліку — у `lib/undo.ts` (`useUndo`), спільна з v2: там і пояснення,
 * чому дія не виконується до кінця відліку. Тут лише вигляд.
 */

export { useUndo } from '../lib/undo';
export type { Pending } from '../lib/undo';

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
