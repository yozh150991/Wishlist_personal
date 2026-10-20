import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertCircle, ExternalLink, Gift } from 'lucide-react';
import { fetchMyGifts } from '../../../lib/gifts';
import type { GiftItem, GiftList } from '../../../lib/gifts';
import { useI18n } from '../../../lib/i18n';
import { errorText } from '../../../lib/errors';
import { formatDay, localToday, moneyShort } from '../../../lib/format';
import { useCounts } from './CommonV2';

const STROKE = 2.75;

/**
 * «Я дарую» (крок 6, ADR-041, п. 5; ADR-062) — що я беру в чужих списках.
 *
 * Сюди потрапляють броні, зроблені після входу, і броні з поштою, що
 * збігається з підтвердженою поштою акаунта. Власних списків тут немає ніколи
 * (ADR-040, п. 3). Картка — посилання: назва, дата, мої позиції зі станом
 * («Куплено», «Змінено») і «Відкрити список» — справжня гостьова, де свої
 * броні вже підхоплені за акаунтом, без коду.
 *
 * Офлайн-копії немає: у відповіді токени посилань (CLAUDE.md §3.5).
 */
export default function GiftsV2() {
  const { t, locale } = useI18n();
  const counts = useCounts();
  const [gifts, setGifts] = useState<GiftList[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setGifts(await fetchMyGifts());
      setError(null);
    } catch (e) {
      setError(errorText(e, t));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const today = localToday();
  const upcoming = gifts.filter((g) => !g.archived && !(g.event_date && g.event_date < today));
  const past = gifts.filter((g) => !upcoming.includes(g));

  function itemRow(i: GiftItem) {
    const price = moneyShort(i.price, i.currency, locale);
    const qty = i.quantity > 1 ? t('v2gifts.qty', { mine: i.mine_qty, n: i.quantity }) : null;
    return (
      <li key={i.id} className="v2-giftrow">
        <span className="v2-giftrow__title">{i.title}</span>
        <span className="v2-giftrow__meta">{[qty, price].filter(Boolean).join(' · ')}</span>
        {i.changed ? (
          <span className="v2-tag" data-tone="warm">
            {t('v2gifts.changed')}
          </span>
        ) : i.bought ? (
          <span className="v2-tag" data-tone="neutral">
            {t('v2gifts.bought')}
          </span>
        ) : (
          <span className="v2-tag" data-tone="accent">
            {t('v2gifts.taking')}
          </span>
        )}
      </li>
    );
  }

  function card(g: GiftList) {
    const day = formatDay(g.event_date, locale);
    const left = g.items.filter((i) => !i.bought).length;
    const meta = [day, counts.items(g.items.length), left > 0 && left < g.items.length ? t('v2gifts.left', { n: left }) : null].filter(
      Boolean,
    );
    return (
      <li key={g.token} className="v2-sharecard">
        <div className="v2-sharecard__head">
          <h3 className="v2-sharecard__title">{g.title}</h3>
          {g.archived && (
            <span className="v2-tag" data-tone="neutral">
              {t('v2gifts.archived')}
            </span>
          )}
        </div>
        <p className="v2-sharecard__meta">{meta.join(' · ')}</p>
        {g.thanks && (
          <blockquote className="v2-giftthanks">
            <p className="v2-giftthanks__text">{g.thanks}</p>
          </blockquote>
        )}
        <ul className="v2-giftrows">{g.items.map(itemRow)}</ul>
        {g.code && <p className="v2-sharecard__meta">{t('v2gifts.code', { code: g.code })}</p>}
        <div className="v2-sharecard__actions">
          <Link
            to={`/l/${g.token}`}
            className="v2-btn v2-btn--outline v2-btn--small"
            aria-label={t('v2gifts.openLabel', { title: g.title })}
          >
            <ExternalLink size={18} strokeWidth={STROKE} aria-hidden="true" />
            {t('v2gifts.open')}
          </Link>
        </div>
      </li>
    );
  }

  return (
    <main className="v2-page" aria-busy={loading || undefined}>
      <div className="v2-head">
        <h1 className="v2-page__title">{t('v2gifts.title')}</h1>
        <p className="v2-lede">{t('v2gifts.subtitle')}</p>
      </div>

      {loading ? (
        <>
          <span className="v2-sr">{t('common.loading')}</span>
          <ul className="v2-sharegrid" aria-hidden="true">
            {[0, 1].map((i) => (
              <li key={i} className="v2-sharecard v2-sharecard--sk" style={{ animationDelay: `${i * 150}ms` }} />
            ))}
          </ul>
        </>
      ) : error ? (
        <div className="v2-empty">
          <span className="v2-circle v2-circle--warm" aria-hidden="true">
            <AlertCircle size={32} strokeWidth={STROKE} />
          </span>
          <h2 className="v2-empty__title">{t('v2gifts.errorTitle')}</h2>
          <p className="v2-lede" role="alert">
            {error}
          </p>
          <button type="button" className="v2-btn v2-btn--primary" onClick={() => void load()}>
            {t('common.retry')}
          </button>
        </div>
      ) : gifts.length === 0 ? (
        <div className="v2-empty">
          <span className="v2-circle v2-circle--calm" aria-hidden="true">
            <Gift size={32} strokeWidth={STROKE} />
          </span>
          <h2 className="v2-empty__title">{t('v2gifts.emptyTitle')}</h2>
          <p className="v2-lede">{t('v2gifts.emptyBody')}</p>
        </div>
      ) : (
        <div className="v2-groups">
          {upcoming.length > 0 && (
            <section aria-labelledby="v2-gifts-upcoming">
              <h2 className="v2-kicker" id="v2-gifts-upcoming">
                {t('v2gifts.upcoming')} · {upcoming.length}
              </h2>
              <ul className="v2-sharegrid">{upcoming.map(card)}</ul>
            </section>
          )}
          {past.length > 0 && (
            <section aria-labelledby="v2-gifts-past">
              <h2 className="v2-kicker" id="v2-gifts-past">
                {t('v2gifts.past')} · {past.length}
              </h2>
              <ul className="v2-sharegrid">{past.map(card)}</ul>
            </section>
          )}
        </div>
      )}
    </main>
  );
}
