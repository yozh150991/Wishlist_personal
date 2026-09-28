import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { fetchSharedList, registerView, reserveItem, unreserveItem } from '../lib/shares';
import type { SharedItem, SharedList as Shared } from '../lib/shares';
import { forgetReservation, guestKey, myReservations, rememberReservation } from '../lib/guest';
import type { MyReservations } from '../lib/guest';
import { useI18n } from '../lib/i18n';
import { LanguagePicker } from '../components/LanguagePicker';
import { AppearanceSheet } from '../components/AppearanceSheet';
import { Icon } from '../components/Icon';
import { useSurface } from '../lib/theme';
import { GuestHeader, GuestItemBody } from '../components/GuestParts';

/**
 * Скільки штук гість бере зараз. Живе окремо від броні: поки він крутить
 * лічильник, на сервері ще нічого не змінилось.
 */
function QuantityPicker({
  value,
  max,
  onChange,
  disabled,
}: {
  value: number;
  max: number;
  onChange: (n: number) => void;
  disabled: boolean;
}) {
  const { t } = useI18n();
  return (
    <span className="qty">
      <button
        type="button"
        className="btn btn--icon"
        aria-label={t('guest.less')}
        disabled={disabled || value <= 1}
        onClick={() => onChange(value - 1)}
      >
        −
      </button>
      <span className="qty__value" aria-live="polite">
        {value}
      </span>
      <button
        type="button"
        className="btn btn--icon"
        aria-label={t('guest.more')}
        disabled={disabled || value >= max}
        onClick={() => onChange(value + 1)}
      >
        +
      </button>
    </span>
  );
}

export default function SharedList() {
  const { token = '' } = useParams();
  const { t } = useI18n();

  const [data, setData] = useState<Shared | null>(null);
  const [loading, setLoading] = useState(true);
  const [gone, setGone] = useState(false);
  const [mine, setMine] = useState<MyReservations>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [want, setWant] = useState<Record<string, number>>({});
  const [appearance, setAppearance] = useState(false);

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

  // Гість — у схемі власника; власник на власному посиланні — у своїй (він і
  // є власник). Поки дані не приїхали, вигляд не чіпаємо, щоб не блимнути.
  useSurface(
    data
      ? data.viewer_is_owner
        ? { kind: 'preview', hue: data.appearance_hue }
        : { kind: 'guest', ownerScheme: data.owner_scheme, hue: data.appearance_hue }
      : null,
  );

  /**
   * `p_quantity` в `reserve_item` — це **підсумкова** кількість цього гостя, а
   * не приріст: RPC робить `on conflict … do update set quantity = excluded`,
   * а межу рахує як «чужі броні + твоя нова». Тому «Узяти ще» має слати суму,
   * інакше повторний виклик просто перезаписав би бронь тим самим числом.
   */
  async function take(item: SharedItem, total: number) {
    if (!data?.allow_reservations || busyId) return;
    setBusyId(item.id);
    setError(null);
    try {
      await reserveItem(token, item.id, guestKey(), total);
      rememberReservation(token, item.id, total);
      setMine(myReservations(token));
      setData(await fetchSharedList(token));
    } catch (e) {
      // Гонка: поки гість думав, позицію встигли взяти. Це не помилка
      // застосунку, і сказати про це треба про конкретну позицію.
      const msg = e instanceof Error ? e.message : '';
      setError(msg.includes('not_enough_left') ? t('guest.raceLost') : t('guest.error'));
      setData(await fetchSharedList(token));
    } finally {
      setBusyId(null);
    }
  }

  async function giveBack(item: SharedItem) {
    if (busyId) return;
    setBusyId(item.id);
    setError(null);
    try {
      await unreserveItem(token, item.id, guestKey());
      forgetReservation(token, item.id);
      setMine(myReservations(token));
      setData(await fetchSharedList(token));
    } catch {
      setError(t('guest.error'));
    } finally {
      setBusyId(null);
    }
  }

  if (loading) {
    return (
      <div className="booting" role="status">
        <span className="spinner" />
        <span className="visually-hidden">{t('common.loading')}</span>
      </div>
    );
  }

  /**
   * Мертве посилання — один екран на всі три причини: не існує, відкликане,
   * протерміноване. Порожнє місце навмисно не заповнюється підказками на
   * кшталт «можливо, термін вийшов»: сторінка не має підтверджувати, що токен
   * колись існував.
   */
  if (gone || !data) {
    return (
      <main className="guest guest--gone">
        <span className="empty__icon empty__icon--accent guest__gone-icon">
          <Icon name="link" size={44} />
        </span>
        <h1>{t('guest.goneTitle')}</h1>
        <p className="lede">{t('guest.goneBody')}</p>
      </main>
    );
  }

  return (
    // <main>: гостьову сторінку відкривають сторонні люди, і без орієнтира
    // зчитувач екрана не має куди перейти до головного вмісту.
    <main className="guest">
      <GuestHeader title={data.title} message={data.message} eventDate={data.event_date} />

      <div className="guest__body">
        {data.viewer_is_owner && (
          <p className="banner banner--accent" role="status">
            <span className="banner__icon">
              <Icon name="alert" size={18} />
            </span>
            <span className="banner__text">{t('guest.ownerBanner')}</span>
          </p>
        )}
        {error && (
          <p className="banner banner--danger" role="alert">
            <span className="banner__icon">
              <Icon name="alert" size={18} />
            </span>
            <span className="banner__text">{error}</span>
          </p>
        )}

        {data.items.length === 0 ? (
          <div className="empty">
            <h2>{t('guest.emptyTitle')}</h2>
            <p className="lede">{t('guest.emptyBody')}</p>
          </div>
        ) : (
          <ul className="guest__grid">
            {data.items.map((item) => {
              const reserved = item.reserved_qty ?? 0;
              const takenByMe = mine[item.id] ?? 0;
              const left = item.quantity - reserved;
              const busy = busyId === item.id;
              const wanted = Math.min(want[item.id] ?? 1, Math.max(left, 1));

              return (
                <li className="gcard" key={item.id} data-taken={takenByMe === 0 && left <= 0}>
                  <GuestItemBody item={item} currency={data.currency}>

                  {/* Бронювання вимкнене — блок дії зникає повністю, а не
                      гасне: сторінка стає суто для читання. */}
                  {data.allow_reservations && (
                    <div className="gcard__action">
                      {takenByMe > 0 && (
                        <p className="gcard__mine">
                          <Icon name="check" size={16} />
                          <span>
                            {item.quantity > 1
                              ? t('guest.yoursPartial', { n: takenByMe, left })
                              : t('guest.yours')}
                          </span>
                          <button
                            type="button"
                            className="btn btn--ghost btn--compact"
                            disabled={busy}
                            onClick={() => void giveBack(item)}
                          >
                            {t('guest.cancel')}
                          </button>
                        </p>
                      )}

                      {left > 0 ? (
                        <div className="gcard__take">
                          {item.quantity > 1 && left > 1 && (
                            <QuantityPicker
                              value={wanted}
                              max={left}
                              disabled={busy}
                              onChange={(n) => setWant((w) => ({ ...w, [item.id]: n }))}
                            />
                          )}
                          <button
                            type="button"
                            className="btn btn--primary btn--block"
                            disabled={busy}
                            onClick={() => void take(item, takenByMe + (item.quantity > 1 ? wanted : 1))}
                          >
                            {busy && <span className="spinner" />}
                            {busy
                              ? t('guest.taking')
                              : takenByMe > 0
                                ? t('guest.takeMore')
                                : item.quantity > 1
                                  ? t('guest.takeSome', { n: wanted, of: item.quantity })
                                  : t('guest.take')}
                          </button>
                        </div>
                      ) : (
                        takenByMe === 0 && (
                          <p className="gcard__taken">
                            {item.quantity > 1 ? t('guest.allTaken') : t('guest.reserved')}
                          </p>
                        )
                      )}
                    </div>
                  )}
                  </GuestItemBody>
                </li>
              );
            })}
          </ul>
        )}

        <p className="guest__footer">{t('guest.footer')}</p>
      </div>

      {/* Підвал гостьової: тільки вигляд і мова. Жодної реєстрації й жодного
          посилання в застосунок — гість прийшов не за цим. */}
      <div className="guest__bar">
        <button
          type="button"
          className="btn guest__bar-btn"
          aria-haspopup="dialog"
          aria-expanded={appearance}
          onClick={() => setAppearance(true)}
        >
          {t('guest.appearance')}
        </button>
        <LanguagePicker className="guest__lang" />
      </div>

      <AppearanceSheet open={appearance} onClose={() => setAppearance(false)} />
    </main>
  );
}
