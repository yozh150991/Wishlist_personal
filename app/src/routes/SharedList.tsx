import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  claimItem,
  fetchSharedList,
  GoneError,
  redeemCode,
  registerView,
  releaseClaim,
} from '../lib/shares';
import type { SharedItem, SharedList as Shared } from '../lib/shares';
import {
  ensureKey,
  isGuestKey,
  legacyKey,
  personalLink,
  readWatch,
  rememberKey,
  saveWatch,
  stopWatch,
  storedKey,
} from '../lib/guest';
import { useI18n } from '../lib/i18n';
import { money, num, priceThresholds } from '../lib/format';
import { validUntilText } from '../lib/zones';
import { useSurface } from '../lib/theme';
import { LanguagePicker } from '../components/LanguagePicker';
import { AppearanceSheet } from '../components/AppearanceSheet';
import { GuestHeader, GuestItemBody } from '../components/GuestParts';
import { Dialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { Note } from '../components/ui';

/**
 * Гостьова сторінка (ADR-035).
 *
 * Гість без акаунта й без імені. Його позначки тримає ключ — у цьому браузері
 * й в особистому посиланні `/s/{токен}/g/{ключ}`, яке він надсилає собі.
 * Перша позначка нічого не питає; одразу після неї сторінка пропонує забрати
 * доступ із собою — посиланням або кодом із 5 символів.
 *
 * Три стани позиції очима гостя: вільна («Я візьму це»), своя («Ти береш це»
 * + «Звільнити»), чужа («Хтось уже взяв» — без імені, без дати, без дії).
 * Ні хто, ні коли — нічого, що видало б гостей одне одному.
 *
 * Гість прийшов вибирати, а не читати каталог, тому типово видно лише
 * вільні (і свої); «Усі» — поруч.
 */

/**
 * Скільки штук гість бере зараз. Живе окремо від позначки: поки він крутить
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

type Filter = 'free' | 'all';

type Changes = { fresh: Set<string>; freed: Set<string> } | null;

const left = (i: SharedItem) => i.quantity - (i.taken_qty ?? 0);
const mine = (i: SharedItem) => i.mine_qty ?? 0;

export default function SharedList() {
  const { token = '', key: urlKey } = useParams();
  const navigate = useNavigate();
  const { t, locale } = useI18n();

  const [data, setData] = useState<Shared | null>(null);
  const [loading, setLoading] = useState(true);
  const [gone, setGone] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [want, setWant] = useState<Record<string, number>>({});
  /** Позиції, на яких гість програв гонку: пояснення стоїть на місці картки. */
  const [lost, setLost] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<Filter>('free');
  /** Поріг «до …» із терцилів цін або null (ADR-036). */
  const [maxPrice, setMaxPrice] = useState<number | null>(null);
  const [highOnly, setHighOnly] = useState(false);
  const [appearance, setAppearance] = useState(false);
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [watching, setWatching] = useState(false);
  const [changes, setChanges] = useState<Changes>(null);
  const listTop = useRef<HTMLDivElement>(null);
  const watchChecked = useRef(false);

  /**
   * Ключ з особистого посилання лягає в цей браузер, а з адресного рядка
   * зникає: людина, яка скопіює адресу, щоб переслати список рідним, не має
   * випадково переслати й доступ до своїх позначок.
   */
  useEffect(() => {
    if (!urlKey) return;
    if (isGuestKey(urlKey)) rememberKey(token, urlKey);
    navigate(`/s/${token}`, { replace: true });
  }, [urlKey, token, navigate]);

  const load = useCallback(async () => {
    // Особисте посилання вже в сховищі — ефект вище спрацював раніше.
    const own = storedKey(token);
    const old = own ? null : legacyKey();
    try {
      const fresh = await fetchSharedList(token, own ?? old);
      // Старий ключ браузера береться лише там, де з ним уже є позначки.
      if (!own && old && fresh.guest) rememberKey(token, old);
      setKey(storedKey(token));
      setData(fresh);
    } catch (e) {
      // Три причини — одна сторінка: інакше різниця відповідей
      // сама підказувала б, що такий токен колись існував.
      if (e instanceof GoneError) setGone(true);
      else setError(t('guest.error'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (urlKey) return; // спершу ключ ляже в сховище й адреса очиститься
    void load();
  }, [load, urlKey]);

  useEffect(() => {
    if (data && !data.viewer_is_owner) void registerView(token);
    // Лише перше завантаження: перечитування після позначки — не новий перегляд.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(data), token]);

  // Гість — у схемі власника й оформленні списку; власник на власному
  // посиланні — у своїй схемі з оформленням. Поки дані не приїхали, вигляд не
  // чіпаємо, щоб не блимнути.
  useSurface(
    data
      ? data.viewer_is_owner
        ? { kind: 'preview', hue: data.appearance_hue }
        : { kind: 'guest', ownerScheme: data.owner_scheme, hue: data.appearance_hue }
      : null,
  );

  const items = data?.items ?? [];
  const canClaim = Boolean(data?.allow_reservations);
  const freeItems = items.filter((i) => left(i) > 0);
  const mineCount = items.filter((i) => mine(i) > 0).length;
  const allTaken = canClaim && items.length > 0 && freeItems.length === 0;

  /**
   * «Стежити» живе на пристрої. Наступного разу — різниця: нові позиції й ті,
   * що звільнились. Знімок одразу оновлюється, а різниця лишається на екрані
   * до кінця візиту.
   */
  useEffect(() => {
    if (!data || data.viewer_is_owner || watchChecked.current) return;
    watchChecked.current = true;
    const w = readWatch(token);
    if (!w) return;
    setWatching(true);
    const known = new Set(w.items);
    const wasFree = new Set(w.free);
    const fresh = new Set(items.filter((i) => !known.has(i.id)).map((i) => i.id));
    const freed = new Set(items.filter((i) => known.has(i.id) && !wasFree.has(i.id) && left(i) > 0).map((i) => i.id));
    setChanges({ fresh, freed });
    saveWatch(token, items.map((i) => i.id), freeItems.map((i) => i.id));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, token]);

  function watch() {
    saveWatch(token, items.map((i) => i.id), freeItems.map((i) => i.id));
    setWatching(true);
  }

  function unwatch() {
    stopWatch(token);
    setWatching(false);
    setChanges(null);
  }

  async function take(item: SharedItem, total: number) {
    if (!canClaim || busyId) return;
    setBusyId(item.id);
    setError(null);
    setNotice(null);
    // Ключ зберігається до запиту: обірвана відповідь не лишить позначку
    // без власника.
    const k = ensureKey(token);
    setKey(k);
    try {
      await claimItem(token, item.id, k, total);
      setData(await fetchSharedList(token, k));
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('not_enough_left')) {
        // Гонка: поки гість думав, позицію взяли. Це не помилка застосунку, і
        // пояснити треба на місці позиції, а не смиканням кнопки.
        setLost((prev) => new Set(prev).add(item.id));
      } else if (e instanceof GoneError) {
        setGone(true);
        return;
      } else {
        setError(t('guest.error'));
      }
      try {
        setData(await fetchSharedList(token, k));
      } catch {
        /* лишаємо те, що є на екрані */
      }
    } finally {
      setBusyId(null);
    }
  }

  async function giveBack(item: SharedItem) {
    if (busyId || !key) return;
    setBusyId(item.id);
    setError(null);
    try {
      await releaseClaim(token, item.id, key);
      setData(await fetchSharedList(token, key));
    } catch (e) {
      if (e instanceof GoneError) setGone(true);
      else setError(t('guest.error'));
    } finally {
      setBusyId(null);
    }
  }

  function showFree() {
    setLost(new Set());
    resetFilters();
    listTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  async function copyLink() {
    if (!key) return;
    try {
      await navigator.clipboard.writeText(personalLink(token, key));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError(t('guest.error'));
    }
  }

  async function sendSelf() {
    if (!key || !data) return;
    const url = personalLink(token, key);
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: data.title, url });
        return;
      } catch (e) {
        // Людина закрила системне вікно — це не помилка.
        if (e instanceof DOMException && e.name === 'AbortError') return;
      }
    }
    await copyLink();
  }

  const thresholds = useMemo(
    () => priceThresholds(items.map((i) => num(i.price)).filter((p): p is number => p !== null)),
    [items],
  );
  const hasHigh = items.some((i) => i.priority === 'high');

  /**
   * Гість типово бачить вільні (і свої, і ту, на якій щойно програв гонку).
   * Поруч — «Усі», поріг ціни з даних і «Високий». Порядок — той, що задав
   * власник: сервер уже віддає позиції в ньому.
   */
  const shown = useMemo(
    () =>
      items.filter((i) => {
        if (canClaim && filter === 'free' && !(left(i) > 0 || mine(i) > 0 || lost.has(i.id))) return false;
        if (maxPrice !== null) {
          const p = num(i.price);
          if (p === null || p > maxPrice) return false;
        }
        if (highOnly && i.priority !== 'high') return false;
        return true;
      }),
    [items, canClaim, filter, lost, maxPrice, highOnly],
  );

  /** Розділи з позиціями, що лишились після фільтрів; «Інше» — в кінці. */
  const shownGroups = useMemo(() => {
    const sections = data?.sections ?? [];
    if (sections.length === 0) return [{ id: null as string | null, title: null as string | null, items: shown }];
    const known = new Set(sections.map((s) => s.id));
    const groups = sections.map((s) => ({
      id: s.id as string | null,
      title: s.title as string | null,
      items: shown.filter((i) => i.section_id === s.id),
    }));
    groups.push({ id: null, title: t('sections.other'), items: shown.filter((i) => !i.section_id || !known.has(i.section_id)) });
    return groups.filter((g) => g.items.length > 0);
  }, [shown, data, t]);

  const freeSum = useMemo(() => {
    if (!data || data.hide_prices) return null;
    let cents = 0;
    for (const i of freeItems) {
      const p = num(i.price);
      if (p !== null) cents += Math.round(p * 100) * left(i);
    }
    return cents > 0 ? money(cents / 100, data.currency, locale) : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, items, locale]);

  function resetFilters() {
    setFilter('free');
    setMaxPrice(null);
    setHighOnly(false);
  }

  if (loading || urlKey) {
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

  /** Блок дії внизу картки. */
  function action(item: SharedItem) {
    if (!canClaim) return null;
    const l = left(item);
    const m = mine(item);
    const busy = busyId === item.id;

    // Програш гонки — на місці позиції, з виходом до вільних. Кнопка «Я
    // візьму це» щезає, а не блокується: disabled тут читається як «спробуй ще».
    if (lost.has(item.id) && m === 0 && l <= 0) {
      return (
        <div className="gcard__action">
          <div className="gcard__race" role="status">
            <strong>{t('guest.raceTitle')}</strong>
            <span className="small">{t('guest.raceBody')}</span>
          </div>
          <button type="button" className="btn btn--secondary btn--block" onClick={showFree}>
            {t('guest.showFree', { n: freeItems.length })}
          </button>
        </div>
      );
    }

    const wanted = Math.min(want[item.id] ?? 1, Math.max(l, 1));
    return (
      <div className="gcard__action">
        {m > 0 && (
          <p className="gcard__mine">
            <Icon name="check" size={16} />
            <span>{item.quantity > 1 ? t('guest.yoursPartial', { n: m, left: l }) : t('guest.yours')}</span>
            <button
              type="button"
              className="btn btn--ghost btn--compact"
              disabled={busy}
              onClick={() => void giveBack(item)}
            >
              {t('guest.release')}
            </button>
          </p>
        )}

        {l > 0 ? (
          <div className="gcard__take">
            {item.quantity > 1 && l > 1 && (
              <QuantityPicker
                value={wanted}
                max={l}
                disabled={busy}
                onChange={(n) => setWant((w) => ({ ...w, [item.id]: n }))}
              />
            )}
            <button
              type="button"
              className="btn btn--primary btn--block"
              disabled={busy}
              onClick={() => void take(item, m + (item.quantity > 1 ? wanted : 1))}
            >
              {busy && <span className="spinner" />}
              {busy
                ? t('guest.taking')
                : m > 0
                  ? t('guest.takeMore')
                  : item.quantity > 1
                    ? t('guest.takeSome', { n: wanted, of: item.quantity })
                    : t('guest.take')}
            </button>
          </div>
        ) : (
          m === 0 && (
            // Чужа: без імені, без дати, без дії.
            <p className="gcard__taken">
              {item.quantity > 1 ? t('guest.takenAll', { n: item.quantity }) : t('guest.takenByOther')}
            </p>
          )
        )}
      </div>
    );
  }

  function card(item: SharedItem) {
    const takenByOthers = canClaim && left(item) <= 0 && mine(item) === 0 && !lost.has(item.id);
    return (
      <li className="gcard" key={item.id} data-taken={takenByOthers} data-lost={lost.has(item.id)}>
        {changes && (changes.fresh.has(item.id) || changes.freed.has(item.id)) && (
          <span className="tag tag--accent gcard__flag">
            {changes.fresh.has(item.id) ? t('guest.tagNew') : t('guest.tagFreed')}
          </span>
        )}
        <GuestItemBody
          item={{
            ...item,
            // «лишилось N» — лише коли частину вже взяли: це про позицію, не про людей.
            quantityNote:
              canClaim && item.quantity > 1 && (item.taken_qty ?? 0) > 0 && left(item) > 0
                ? t('guest.neededLeft', { n: item.quantity, left: left(item) })
                : undefined,
          }}
          currency={data!.currency}
        >
          {action(item)}
        </GuestItemBody>
      </li>
    );
  }

  const mineItems = items.filter((i) => mine(i) > 0);
  const takenRest = items.filter((i) => mine(i) === 0);

  return (
    // <main>: гостьову сторінку відкривають сторонні люди, і без орієнтира
    // зчитувач екрана не має куди перейти до головного вмісту.
    <main className="guest">
      <GuestHeader
        title={data.title}
        message={data.message}
        eventDate={data.event_date}
        validUntil={validUntilText(data.expires_at, data.expires_tz, locale, t)}
      />

      <div className="guest__body">
        {data.viewer_is_owner && (
          <p className="banner banner--accent" role="status">
            <span className="banner__icon">
              <Icon name="alert" size={18} />
            </span>
            <span className="banner__text">{t('guest.ownerBanner')}</span>
          </p>
        )}
        {error && <Note tone="error">{error}</Note>}
        {notice && <Note>{notice}</Note>}

        {changes && (
          <div className="banner banner--accent" role="status">
            <span className="banner__icon">
              <Icon name="clock" size={18} />
            </span>
            <span className="banner__text">
              {changes.fresh.size || changes.freed.size
                ? t('guest.changes', { new: changes.fresh.size, freed: changes.freed.size })
                : t('guest.noChanges')}
            </span>
            <button type="button" className="btn btn--ghost btn--compact" onClick={unwatch}>
              {t('guest.unwatch')}
            </button>
          </div>
        )}

        {/* Одразу після першої позначки: посилання для себе й код — на випадок,
            коли посилання загубилось. Реєстрації немає ніде. */}
        {canClaim && mineCount > 0 && key && data.guest && (
          <section className="keep" aria-labelledby="keep-title">
            <p className="keep__kicker">{t('guest.keepKicker')}</p>
            <h2 className="keep__title" id="keep-title">
              {t('guest.keepTitle')}
            </h2>
            <p className="small">{t('guest.keepBody')}</p>
            <div className="keep__actions">
              <button type="button" className="btn btn--primary" onClick={() => void sendSelf()}>
                {t('guest.sendSelf')}
              </button>
              <button type="button" className="btn btn--secondary" onClick={() => void copyLink()}>
                {t('guest.copyLink')}
              </button>
            </div>
            <div className="keep__code">
              <span className="small">{t('guest.codeHint')}</span>
              <span className="keep__code-value" aria-label={t('guest.codeLabel', { code: data.guest.code })}>
                {data.guest.code}
              </span>
            </div>
          </section>
        )}

        {items.length === 0 ? (
          <div className="empty">
            <h2>{t('guest.emptyTitle')}</h2>
            <p className="lede">{t('guest.emptyBody')}</p>
          </div>
        ) : allTaken ? (
          <>
            {/* «Усе розібрали» — не помилка й не порожнеча, а привід
                повернутись. Список лишається видимим: гість має побачити, що
                саме подобається, — це підказка для власного подарунка. */}
            <section className="all-taken" aria-labelledby="all-taken-title">
              <h2 id="all-taken-title">
                {mineCount > 0 ? t('guest.allTakenMine', { n: mineCount }) : t('guest.allTakenTitle')}
              </h2>
              <p className="small">{mineCount > 0 ? t('guest.allTakenBodyMine') : t('guest.allTakenBody')}</p>
              {watching ? (
                <p className="small all-taken__watching">
                  <Icon name="check" size={16} />
                  <span>{t('guest.watching')}</span>
                  <button type="button" className="btn btn--ghost btn--compact" onClick={unwatch}>
                    {t('guest.unwatch')}
                  </button>
                </p>
              ) : (
                <>
                  <button type="button" className="btn btn--primary btn--block" onClick={watch}>
                    {t('guest.watch')}
                  </button>
                  <p className="small muted">{t('guest.watchHint')}</p>
                </>
              )}
            </section>

            {mineItems.length > 0 && <ul className="guest__grid">{mineItems.map(card)}</ul>}

            {takenRest.length > 0 && (
              <section className="taken-list" aria-labelledby="taken-list-title">
                <p className="taken-list__head">
                  <span className="settings__label" id="taken-list-title">
                    {t('guest.allTakenList')}
                  </span>
                  <span className="small muted">{t('guest.itemsCount', { n: takenRest.length })}</span>
                </p>
                <ul className="taken-list__rows">
                  {takenRest.map((i) => (
                    <li key={i.id} className="taken-row">
                      <span className="taken-row__title">{i.title}</span>
                      <span className="tag tag--neutral">{t('guest.takenPill')}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        ) : (
          <>
            {(canClaim || thresholds.length > 0 || hasHigh) && (
              <div className="guest-filters" ref={listTop}>
                <div className="gchips">
                  {canClaim && (
                    <span className="gchips__group" role="radiogroup" aria-label={t('guest.filterLabel')}>
                      <button
                        type="button"
                        role="radio"
                        className="gchip"
                        aria-checked={filter === 'free'}
                        onClick={() => setFilter('free')}
                      >
                        {t('guest.filterFree', { n: freeItems.length })}
                      </button>
                      <button
                        type="button"
                        role="radio"
                        className="gchip"
                        aria-checked={filter === 'all'}
                        onClick={() => setFilter('all')}
                      >
                        {t('guest.filterAll', { n: items.length })}
                      </button>
                    </span>
                  )}
                  {thresholds.length > 0 && (
                    <span className="gchips__group" role="group" aria-label={t('guest.filterPrice')}>
                      {thresholds.map((v) => (
                        <button
                          key={v}
                          type="button"
                          className="gchip"
                          aria-pressed={maxPrice === v}
                          onClick={() => setMaxPrice(maxPrice === v ? null : v)}
                        >
                          {t('guest.priceUpTo', { price: money(v, data.currency, locale) ?? String(v) })}
                        </button>
                      ))}
                    </span>
                  )}
                  {hasHigh && (
                    <button
                      type="button"
                      className="gchip"
                      aria-pressed={highOnly}
                      aria-label={t('guest.filterPriority')}
                      onClick={() => setHighOnly(!highOnly)}
                    >
                      {t('item.priority.high')}
                    </button>
                  )}
                </div>
                {canClaim && (
                  <span className="small muted" aria-live="polite">
                    {t('guest.freeCounter', { n: freeItems.length, m: items.length })}
                    {freeSum && ` · ${t('guest.freeSum', { sum: freeSum })}`}
                  </span>
                )}
              </div>
            )}

            {shown.length > 0 ? (
              shownGroups.map((g) => (
                <section key={g.id ?? '__other'} className="guest-section" aria-label={g.title ?? undefined}>
                  {g.title && (
                    <p className="guest-section__head">
                      <span className="guest-section__title">{g.title}</span>
                      {canClaim && (
                        <span className="small muted">
                          {t('guest.sectionFree', {
                            n: items.filter((i) => (g.id ? i.section_id === g.id : !data.sections.some((s) => s.id === i.section_id)) && left(i) > 0).length,
                            m: items.filter((i) => (g.id ? i.section_id === g.id : !data.sections.some((s) => s.id === i.section_id))).length,
                          })}
                        </span>
                      )}
                    </p>
                  )}
                  <ul className="guest__grid">{g.items.map(card)}</ul>
                </section>
              ))
            ) : (
              <div className="guest-empty">
                <p className="lede center">
                  {maxPrice !== null || highOnly ? t('guest.filterEmpty') : t('guest.freeEmpty')}
                </p>
                {(maxPrice !== null || highOnly || filter === 'free') && (
                  <button type="button" className="btn btn--secondary" onClick={() => {
                    resetFilters();
                    if (maxPrice === null && !highOnly) setFilter('all');
                  }}>
                    {t('guest.filterReset')}
                  </button>
                )}
              </div>
            )}
          </>
        )}

        {canClaim && (
          <div className="guest__extra">
            <button type="button" className="btn btn--ghost" onClick={() => setRedeemOpen(true)}>
              {t('guest.haveCode')}
            </button>
            <p className="small muted">{t('guest.ownerBlind')}</p>
          </div>
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

      <RedeemDialog
        open={redeemOpen}
        token={token}
        onClose={() => setRedeemOpen(false)}
        onRedeemed={async (newKey, count) => {
          rememberKey(token, newKey);
          setKey(newKey);
          setRedeemOpen(false);
          setNotice(t('guest.redeemDone', { n: count }));
          try {
            setData(await fetchSharedList(token, newKey));
          } catch {
            /* сторінка перечитається при наступній дії */
          }
        }}
      />

      {copied && (
        <p className="toast" role="status">
          <Icon name="check" size={16} />
          {t('guest.copied')}
        </p>
      )}
    </main>
  );
}

/**
 * «У мене вже щось відкладено»: код із 5 символів переносить позначки на цей
 * пристрій і лишає їх на попередньому. Після 5 спроб на годину на список не
 * приймається навіть правильний — і сторінка каже про це прямо.
 */
function RedeemDialog({
  open,
  token,
  onClose,
  onRedeemed,
}: {
  open: boolean;
  token: string;
  onClose: () => void;
  onRedeemed: (key: string, claims: number) => void;
}) {
  const { t } = useI18n();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setCode('');
      setError(null);
    }
  }, [open]);

  async function submit() {
    if (busy) return;
    const clean = code.replace(/\s+/g, '').toUpperCase();
    if (clean.length !== 5) {
      setError(t('guest.redeemShort'));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await redeemCode(token, clean);
      if ('error' in res) {
        setError(res.error === 'too_many_attempts' ? t('guest.redeemTooMany') : t('guest.redeemNotFound'));
      } else {
        onRedeemed(res.key, res.claims);
      }
    } catch {
      setError(t('guest.error'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title={t('guest.haveCode')}>
      <form
        className="form-grid"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <p className="small">{t('guest.redeemBody')}</p>
        {error && <Note tone="error">{error}</Note>}
        <div className="field" data-invalid={error ? 'true' : 'false'}>
          <label htmlFor="guestCode">{t('guest.redeemCode')}</label>
          <input
            id="guestCode"
            className="input code-input"
            value={code}
            maxLength={5}
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            inputMode="text"
            onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^0-9A-Z]/g, ''))}
          />
        </div>
        <div className="appearance-note">
          <strong>{t('guest.noCodeTitle')}</strong>
          <p className="small">{t('guest.noCodeBody')}</p>
        </div>
        <div className="dialog__foot">
          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy && <span className="spinner" />}
            {busy ? t('guest.redeeming') : t('guest.redeem')}
          </button>
        </div>
      </form>
    </Dialog>
  );
}
