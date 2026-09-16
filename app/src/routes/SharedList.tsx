import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  fetchSharedList,
  registerView,
  reserveItem,
  unreserveItem,
} from '../lib/shares';
import type { SharedItem, SharedList as Shared } from '../lib/shares';
import { forgetReservation, guestKey, myReservations, rememberReservation } from '../lib/guest';
import { useI18n } from '../lib/i18n';
import { hostOf, money } from '../lib/format';
import { Note } from '../components/ui';
import { LanguagePicker } from '../components/LanguagePicker';

export default function SharedList() {
  const { token = '' } = useParams();
  const { t, locale } = useI18n();

  const [data, setData] = useState<Shared | null>(null);
  const [loading, setLoading] = useState(true);
  const [gone, setGone] = useState(false);
  const [mine, setMine] = useState<string[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await fetchSharedList(token));
      setMine(myReservations(token));
    } catch {
      // Три причини — одна сторінка: інакше різниця відповідей
      // сама підказувала б, що такий токен колись існував.
      setGone(true);
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (data && !data.viewer_is_owner) void registerView(token);
  }, [data, token]);

  async function toggle(item: SharedItem) {
    if (!data?.allow_reservations) return;
    setBusyId(item.id);
    setError(null);
    try {
      if (mine.includes(item.id)) {
        await unreserveItem(token, item.id, guestKey());
        forgetReservation(token, item.id);
      } else {
        await reserveItem(token, item.id, guestKey(), 1);
        rememberReservation(token, item.id);
      }
      setMine(myReservations(token));
      setData(await fetchSharedList(token));
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      setError(msg.includes('not_enough_left') ? t('guest.taken') : t('guest.error'));
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <div className="booting" role="status">
        {t('common.loading')}…
      </div>
    );
  }

  if (gone || !data) {
    return (
      <div className="guest">
        <div className="empty">
          <h2>{t('guest.goneTitle')}</h2>
          <p className="lede">{t('guest.goneBody')}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="guest">
      <header className="guest__head">
        <div>
          <h1 className="display">{data.title}</h1>
          {data.message && <p className="lede">{data.message}</p>}
        </div>
        <LanguagePicker />
      </header>

      {data.viewer_is_owner && <Note>{t('guest.ownerBanner')}</Note>}
      {!data.viewer_is_owner && data.allow_reservations && (
        <Note>{t('guest.hint')}</Note>
      )}
      {error && <Note tone="error">{error}</Note>}

      {data.items.length === 0 ? (
        <div className="empty">
          <h2>{t('guest.emptyTitle')}</h2>
          <p className="lede">{t('guest.emptyBody')}</p>
        </div>
      ) : (
        <ul className="guest__grid">
          {data.items.map((item) => {
            const reserved = item.reserved_qty ?? 0;
            const isMine = mine.includes(item.id);
            const left = item.quantity - reserved;
            const price = money(item.price, data.currency, locale);
            const host = hostOf(item.url);

            return (
              <li className="gcard" key={item.id} data-taken={!isMine && left <= 0}>
                {item.image_url && (
                  <div className="gcard__media">
                    <img src={item.image_url} alt="" loading="lazy" />
                  </div>
                )}

                <div className="gcard__body">
                  <h2 className="gcard__title">
                    {item.url ? (
                      <a href={item.url} target="_blank" rel="noreferrer noopener">
                        {item.title}
                      </a>
                    ) : (
                      item.title
                    )}
                  </h2>

                  <p className="gcard__meta">
                    {price && <span className="gcard__price">{price}</span>}
                    {item.quantity > 1 && <span className="small">× {item.quantity}</span>}
                    {host && <span className="small card__host">{host}</span>}
                  </p>

                  {item.note && <p className="small">{item.note}</p>}

                  {data.allow_reservations && (
                    <div className="gcard__foot">
                      {isMine ? (
                        <>
                          <span className="chip chip--mine">{t('guest.yours')}</span>
                          <button
                            className="btn btn--bare"
                            disabled={busyId === item.id}
                            onClick={() => void toggle(item)}
                          >
                            {t('guest.cancel')}
                          </button>
                        </>
                      ) : left <= 0 ? (
                        <span className="chip">{t('guest.reserved')}</span>
                      ) : (
                        <button
                          className="btn"
                          disabled={busyId === item.id}
                          onClick={() => void toggle(item)}
                        >
                          {t('guest.take')}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <footer className="guest__foot small">{t('guest.footer')}</footer>
    </div>
  );
}
