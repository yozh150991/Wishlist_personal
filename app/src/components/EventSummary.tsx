import { useEffect, useState } from 'react';
import { useI18n } from '../lib/i18n';
import { formatDate } from '../lib/format';
import type { List, Totals } from '../lib/types';

/**
 * Нагадування підбити підсумки після події.
 *
 * Дата події зберігається в списку саме заради цього (DATA_MODEL: «event_date
 * вмикає підказку "підбити підсумки"»). Коли дата минула, а актуальні позиції
 * лишились, застосунок пропонує позначити, що вже подаровано.
 *
 * Відмову памʼятає localStorage, окремо для кожного списку, і разом із датою:
 * перенесли подію на наступний рік — нагадування зʼявиться знову.
 */
const KEY = 'wl.summaryDismissed';

function dismissed(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, string>;
  } catch {
    return {};
  }
}

/** Порівнюємо календарні дати, не моменти часу: подія «сьогодні» ще не минула. */
function isPast(eventDate: string): boolean {
  const today = new Date();
  const todayIso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  return eventDate < todayIso;
}

export function EventSummary({
  list,
  totals,
  onStart,
}: {
  list: List | null;
  totals: Totals | null;
  onStart: () => void;
}) {
  const { t, locale } = useI18n();
  const [hidden, setHidden] = useState(false);

  const eventDate = list?.event_date ?? null;
  useEffect(() => {
    setHidden(eventDate ? dismissed()[list?.id ?? ''] === eventDate : false);
  }, [list?.id, eventDate]);

  if (!list || !totals || !eventDate || !isPast(eventDate)) return null;

  const wrapped = totals.gifted_count + totals.purchased_count;

  // Актуальних не лишилось — підсумки вже підбиті, лишається тихий рядок.
  if (totals.active_count === 0) {
    if (wrapped === 0) return null;
    return (
      <p className="small">
        {t('summary.done', { gifted: totals.gifted_count, n: totals.items_count })}
      </p>
    );
  }

  if (hidden) return null;

  function later() {
    setHidden(true);
    try {
      localStorage.setItem(KEY, JSON.stringify({ ...dismissed(), [list!.id]: eventDate }));
    } catch {
      // Приватний режим браузера: нагадування просто зʼявиться наступного разу.
    }
  }

  return (
    <div className="event-summary" role="region" aria-label={t('summary.region')}>
      <p>{t('summary.banner', { date: formatDate(eventDate, locale) ?? eventDate })}</p>
      <div className="event-summary__actions">
        <button type="button" className="btn btn--secondary" onClick={later}>
          {t('summary.later')}
        </button>
        <button type="button" className="btn btn--primary" onClick={onStart}>
          {t('summary.start')}
        </button>
      </div>
    </div>
  );
}
