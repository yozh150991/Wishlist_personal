import { useI18n } from '../lib/i18n';
import { formatDateTime } from '../lib/format';

/**
 * Позначка «це збережена копія, а не свіжі дані» (ROADMAP 6.4).
 *
 * Показується замість помилки, коли мережі немає, а знімок у IndexedDB є.
 * Час збереження обовʼязковий: без нього людина не відрізнить учорашній стан
 * від сьогоднішнього й може вирішити, ніби позицію хтось видалив.
 */
export function StaleNotice({ savedAt }: { savedAt: string }) {
  const { t, locale } = useI18n();
  return (
    <p className="note note--stale" role="status">
      {t('offline.stale', { when: formatDateTime(savedAt, locale) ?? savedAt })}
    </p>
  );
}
