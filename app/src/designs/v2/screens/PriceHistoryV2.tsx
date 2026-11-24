import { useEffect, useId, useState } from 'react';
import { useI18n } from '../../../lib/i18n';
import { fetchItemPrices } from '../../../lib/db';
import { formatDay, moneyShort } from '../../../lib/format';
import { HISTORY_DAYS, sparkline, summarizeHistory, utcToday, windowStart } from '../../../lib/priceHistory';
import type { HistorySummary, PricePoint } from '../../../lib/priceHistory';
import type { Currency } from '../../../lib/types';

const CHART_W = 240;
const CHART_H = 48;

/**
 * Історія ціни позиції (8.16) у формі власника: найнижча за 30 днів і
 * остання, кожна з датою й джерелом («перевірено 3 грудня» — щоденна
 * перевірка посилання), і маленький графік без бібліотек.
 *
 * Лише ціни у валюті позиції (ADR-051): точки іншої валюти — одним рядком,
 * без порівняння. Немає мережі чи збій — тихий рядок, а не порожній стан.
 * Гостям цього блоку немає: точки читає лише власник (RLS).
 */
export function PriceHistoryV2({ itemId, currency }: { itemId: string; currency: Currency }) {
  const { t, locale } = useI18n();
  const titleId = useId();
  const [state, setState] = useState<{ today: string; summary: HistorySummary } | 'loading' | 'failed'>('loading');

  useEffect(() => {
    let alive = true;
    const today = utcToday();
    setState('loading');
    fetchItemPrices(itemId, windowStart(today))
      .then((rows) => alive && setState({ today, summary: summarizeHistory(rows, currency, today) }))
      .catch(() => alive && setState('failed'));
    return () => {
      alive = false;
    };
  }, [itemId, currency]);

  if (state === 'loading') return null;
  if (state === 'failed') {
    return <p className="v2-hint v2-hint--start">{t('v2item.history.failed')}</p>;
  }

  const { today, summary } = state;
  const price = (p: PricePoint) => moneyShort(p.minor / 100, currency, locale) ?? '';
  const date = (p: PricePoint) => formatDay(p.day, locale) ?? p.day;
  const others = summary.others.join(', ');

  if (summary.points.length === 0) {
    return (
      <div className="v2-pricehist" data-testid="price-history">
        <p className="v2-hint v2-hint--start">{t('v2item.history.empty')}</p>
        {others && <p className="v2-hint v2-hint--start">{t('v2item.history.otherCurrency', { currencies: others })}</p>}
      </div>
    );
  }

  const { current, min, max } = summary;
  const line = sparkline(summary.points, today, CHART_W, CHART_H);
  const single = summary.points.length === 1;

  return (
    <section className="v2-pricehist" aria-labelledby={titleId} data-testid="price-history">
      <h3 className="v2-pricehist__title" id={titleId}>
        {t('v2item.history.title', { n: HISTORY_DAYS })}
      </h3>
      {!single && min && max && (
        <svg
          className="v2-pricehist__chart"
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          preserveAspectRatio="none"
          role="img"
          aria-label={t('v2item.history.chart', { min: price(min), max: price(max) })}
        >
          <polyline points={line} fill="none" vectorEffect="non-scaling-stroke" />
        </svg>
      )}
      {current && (
        <p className="v2-pricehist__line" data-testid="price-current">
          {t('v2item.history.current', { price: price(current), date: date(current) })}
        </p>
      )}
      {min && current && min !== current && (
        <p className="v2-pricehist__line" data-testid="price-min">
          {t('v2item.history.min', { n: HISTORY_DAYS, price: price(min), date: date(min) })}
        </p>
      )}
      {min && current && min === current && !single && (
        <p className="v2-pricehist__line" data-testid="price-min">
          {t('v2item.history.minIsNow', { n: HISTORY_DAYS })}
        </p>
      )}
      {others && <p className="v2-hint v2-hint--start">{t('v2item.history.otherCurrency', { currencies: others })}</p>}
    </section>
  );
}
