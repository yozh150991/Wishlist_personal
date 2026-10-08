import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { useLocation, useNavigate, useParams } from 'react-router-dom';
import { Link2, ListChecks, Palette, X } from 'lucide-react';
import {
  ackClaimChange,
  claimItemV2,
  fetchGuestList,
  GoneError,
  registerView,
  releaseClaim,
  setClaimBought,
  setGuestMail,
} from '../../../lib/shares';
import type { SharedItem, SharedList } from '../../../lib/shares';
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
} from '../../../lib/guest';
import { useI18n, LOCALES } from '../../../lib/i18n';
import type { Locale } from '../../../lib/i18n';
import { formatDay, money, num, priceThresholds } from '../../../lib/format';
import { validUntilText } from '../../../lib/zones';
import { useSurface } from '../../../lib/theme';
import { useUndo } from '../../../lib/undo';
import { CURRENCIES } from '../../../lib/types';
import type { Currency } from '../../../lib/types';
import { NoteV2, useCountdown } from './AuthPartsV2';
import { useCounts } from './CommonV2';
import { usePriorityLabel } from './ListPartsV2';
import {
  BookSheetV2,
  GuestCardV2,
  GuestHeadV2,
  LookSheetV2,
  MyPicksSheetV2,
  RedeemSheetV2,
  ShopSheetV2,
} from './GuestPartsV2';
import type { BookStep, GuestCounts } from './GuestPartsV2';
// Стилі форми v2 — і тут: гостьова вантажиться окремо від решти застосунку.
import '../v2.css';

/**
 * Гостьова v2 — `/l/{токен}` і `/l/{токен}/g/{ключ}` (ADR-039, ADR-041, ADR-053;
 * потік E пакета 2.0).
 *
 * Гість не реєструється. Ключ генерується в браузері перед першою бронню й
 * лежить тут і в особистому посиланні; з адресного рядка він зникає одразу
 * (CLAUDE.md §3.5). Після першої броні — код із 5 символів: єдиний спосіб
 * повернутись з іншого пристрою без посилання.
 *
 * «Беру» відкриває аркуш: необовʼязковий підпис (щоб гість упізнав свої
 * броні), пошта (код і лист про бронь, ADR-054) і, для позицій на кілька
 * штук, скільки. Ні власник, ні інші гості ні підпису, ні пошти не бачать.
 *
 * Потік S (ADR-056): «Уже куплено» на своїй броні — окремий крок, після
 * якого «Зняти» ховається; «Ще не куплено» — у «Моїх бронях». Хто йде в
 * магазин, не взявши позицію, раз за сесію бачить «Забронювати й перейти» —
 * щоб двоє не купили те саме. Власник покупок не бачить, як і броней.
 *
 * `/l/{токен}/u/{секрет}` — посилання «Не надсилати листів про цей список»
 * з листа: листи вимикаються одразу, секрет зникає з адреси, а на сторінці —
 * «Повернути листи».
 *
 * Своя бронь — контур і «Ви берете», «Зняти» одним дотиком із тостом на 6 с:
 * запит іде, коли відлік скінчився, тож відкат миттєвий. Чужа — «Уже взяли»,
 * без імені, без дати, без дії (ADR-035, п. 8). Програна гонка — пояснення в
 * аркуші й «Показати схоже за ціною».
 *
 * Типово видно вільні (і свої); «Усі», поріг ціни з даних і «Дуже хочу» —
 * поруч, як у гостьовій v1 (ADR-036, п. 7–8).
 */

const BASE = '/l';
/** Назва мови її ж мовою — як у перемикачах застосунку. */
const LANGUAGE: Record<Locale, string> = { uk: 'Українська', pl: 'Polski', en: 'English' };
const UNDO_MS = 6000;
/** Скільки позицій показати як «схоже за ціною». */
const SIMILAR_MAX = 6;
/** «У магазин» без броні — питаємо раз за сесію вкладки, і лише для цього списку. */
const SHOP_ASKED = (token: string) => `wl.shopask.${token}`;

function shopAsked(token: string): boolean {
  try {
    return sessionStorage.getItem(SHOP_ASKED(token)) === '1';
  } catch {
    return false;
  }
}

function markShopAsked(token: string) {
  try {
    sessionStorage.setItem(SHOP_ASKED(token), '1');
  } catch {
    /* без сховища — спитаємо ще раз, це не біда */
  }
}

type Filter = 'free' | 'all';
type Changes = { fresh: Set<string>; freed: Set<string> } | null;

export default function GuestV2() {
  const { token = '', key: urlKey, mailToken } = useParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { t, locale, setLocale } = useI18n();
  const counts = useCounts();
  const priority = usePriorityLabel();
  const langId = useId();

  const [data, setData] = useState<SharedList | null>(null);
  const [loading, setLoading] = useState(true);
  const [gone, setGone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [key, setKey] = useState<string | null>(null);

  const [filter, setFilter] = useState<Filter>('free');
  const [maxPrice, setMaxPrice] = useState<number | null>(null);
  const [highOnly, setHighOnly] = useState(false);
  /** «Показати схоже за ціною» після програної гонки: позиція, до якої шукаємо. */
  const [similarTo, setSimilarTo] = useState<SharedItem | null>(null);

  const [book, setBook] = useState<{ item: SharedItem; step: BookStep } | null>(null);
  const [bookBusy, setBookBusy] = useState(false);
  const [bookError, setBookError] = useState<string | null>(null);
  const [picksOpen, setPicksOpen] = useState(false);
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [lookOpen, setLookOpen] = useState(false);
  /** «У магазин» без броні: позиція, про яку питаємо «Забронювати й перейти?». */
  const [shopItem, setShopItem] = useState<SharedItem | null>(null);
  /** Спитали вже в цій вкладці — далі посилання просто відкривається. */
  const shopAskedRef = useRef(false);

  /** Броні, зняття яких ще відлічує тост: на екрані їх уже немає. */
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const pendingRelease = useRef<string | null>(null);
  const undo = useUndo(UNDO_MS);

  /** Відписка з листа: секрет живе лише в стані історії цієї вкладки. */
  const unsubToken = (location.state as { unsub?: string } | null)?.unsub ?? null;
  const [unsubOn, setUnsubOn] = useState<boolean | null>(null);

  const [watching, setWatching] = useState(false);
  const [changes, setChanges] = useState<Changes>(null);
  const watchChecked = useRef(false);
  const listTop = useRef<HTMLDivElement>(null);

  /**
   * Ключ з особистого посилання лягає в цей браузер і зникає з адреси — на
   * той самий префікс `/l`: хто скопіює адресу рідним, не перешле й доступ до
   * своїх броней (ADR-035, п. 4).
   */
  useEffect(() => {
    if (!urlKey) return;
    if (isGuestKey(urlKey)) rememberKey(token, urlKey);
    navigate(`${BASE}/${token}`, { replace: true });
  }, [urlKey, token, navigate]);

  /**
   * «Не надсилати листів про цей список» — одним натиском, без входу
   * (потік P3). Секрет прибираємо з адресного рядка, як і ключ гостя.
   */
  useEffect(() => {
    if (!mailToken) return;
    void setGuestMail(mailToken, false).catch(() => undefined);
    navigate(`${BASE}/${token}`, { replace: true, state: { unsub: mailToken } });
  }, [mailToken, token, navigate]);

  async function toggleMail(on: boolean) {
    if (!unsubToken) return;
    try {
      await setGuestMail(unsubToken, on);
      setUnsubOn(on);
    } catch {
      setError(t('v2guest.error'));
    }
  }

  const load = useCallback(async () => {
    const own = storedKey(token);
    const old = own ? null : legacyKey();
    try {
      const fresh = await fetchGuestList(token, own ?? old);
      // Старий ключ браузера береться лише там, де з ним уже є броні.
      if (!own && old && fresh.guest) rememberKey(token, old);
      setKey(storedKey(token));
      setData(fresh);
    } catch (e) {
      // Три причини — один екран (ADR-035, п. 7).
      if (e instanceof GoneError) setGone(true);
      else setError(t('v2guest.error'));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    if (urlKey || mailToken) return;
    void load();
  }, [load, urlKey, mailToken]);

  useEffect(() => {
    if (data && !data.viewer_is_owner) void registerView(token);
    // Лише перше завантаження: перечитування після броні — не новий перегляд.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [Boolean(data), token]);

  // Гість — у схемі власника й оформленні списку; власник на своєму
  // посиланні — у своїй схемі з оформленням (resolveAppearance, правила 2–3).
  useSurface(
    data
      ? data.viewer_is_owner
        ? { kind: 'preview', hue: data.appearance_hue }
        : { kind: 'guest', ownerScheme: data.owner_scheme, hue: data.appearance_hue }
      : null,
  );

  /* ── Що на екрані ── */

  const items = useMemo(() => data?.items ?? [], [data]);
  const canClaim = Boolean(data?.allow_reservations);
  /** Власник на своєму посиланні бачить сторінку гостя, але нічого не бронює (§3.2). */
  const asOwner = Boolean(data?.viewer_is_owner);
  const listCurrency: Currency = data?.currency ?? 'PLN';

  const countsOf = useCallback(
    (i: SharedItem): GuestCounts => {
      const mine = i.mine_qty ?? 0;
      const taken = i.taken_qty ?? 0;
      return hidden.has(i.id)
        ? { left: i.quantity - taken + mine, mine: 0 }
        : { left: i.quantity - taken, mine };
    },
    [hidden],
  );

  const freeItems = items.filter((i) => countsOf(i).left > 0);
  const mineItems = items.filter((i) => countsOf(i).mine > 0);
  const allTaken = canClaim && items.length > 0 && freeItems.length === 0;

  /** «Стежити» живе на пристрої; наступного разу — що нового й що звільнилось. */
  useEffect(() => {
    if (!data || data.viewer_is_owner || watchChecked.current) return;
    watchChecked.current = true;
    const w = readWatch(token);
    if (!w) return;
    setWatching(true);
    const known = new Set(w.items);
    const wasFree = new Set(w.free);
    const fresh = new Set(items.filter((i) => !known.has(i.id)).map((i) => i.id));
    const freed = new Set(
      items.filter((i) => known.has(i.id) && !wasFree.has(i.id) && countsOf(i).left > 0).map((i) => i.id),
    );
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

  /** Ціна в іншій валюті, ніж список (ADR-051): поріг і «схоже» її не порівнюють. */
  const foreign = (i: SharedItem) => Boolean(i.currency && i.currency !== listCurrency);
  const thresholds = useMemo(
    () =>
      priceThresholds(
        items
          .filter((i) => !(i.currency && i.currency !== listCurrency))
          .map((i) => num(i.price))
          .filter((p): p is number => p !== null),
      ),
    [items, listCurrency],
  );
  const hasHigh = items.some((i) => i.priority === 'high');

  /** «Схоже за ціною»: вільні позиції в тій самій валюті, найближчі за ціною. */
  const similar = useMemo(() => {
    if (!similarTo) return [];
    const target = num(similarTo.price);
    if (target === null) return [];
    const cur = similarTo.currency ?? listCurrency;
    return items
      .filter((i) => i.id !== similarTo.id && countsOf(i).left > 0 && countsOf(i).mine === 0)
      .filter((i) => num(i.price) !== null && (i.currency ?? listCurrency) === cur)
      .sort((a, b) => Math.abs(num(a.price)! - target) - Math.abs(num(b.price)! - target))
      .slice(0, SIMILAR_MAX);
  }, [similarTo, items, countsOf, listCurrency]);

  const shown = useMemo(
    () =>
      items.filter((i) => {
        const c = countsOf(i);
        if (canClaim && filter === 'free' && !(c.left > 0 || c.mine > 0)) return false;
        if (maxPrice !== null) {
          const p = num(i.price);
          if (p === null || foreign(i) || p > maxPrice) return false;
        }
        if (highOnly && i.priority !== 'high') return false;
        return true;
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, canClaim, filter, maxPrice, highOnly, countsOf],
  );

  /** Розділи з позиціями, що лишились після фільтрів; «Інше» — в кінці. */
  const groups = useMemo(() => {
    const sections = data?.sections ?? [];
    if (sections.length === 0) return [{ id: null as string | null, title: null as string | null, items: shown }];
    const known = new Set(sections.map((s) => s.id));
    const out = sections.map((s) => ({
      id: s.id as string | null,
      title: s.title as string | null,
      items: shown.filter((i) => i.section_id === s.id),
    }));
    out.push({ id: null, title: t('sections.other'), items: shown.filter((i) => !i.section_id || !known.has(i.section_id)) });
    return out.filter((g) => g.items.length > 0);
  }, [shown, data, t]);

  /** «на 1 240 zł + 85 €» — вільне, кожна валюта окремо, без курсу (ADR-051). */
  const freeSum = useMemo(() => {
    if (!data || data.hide_prices) return null;
    const cents = new Map<Currency, number>();
    for (const i of freeItems) {
      const p = num(i.price);
      const c = i.currency ?? listCurrency;
      if (p !== null) cents.set(c, (cents.get(c) ?? 0) + Math.round(p * 100) * countsOf(i).left);
    }
    const order = [listCurrency, ...CURRENCIES.filter((c) => c !== listCurrency)];
    const parts = order
      .filter((c) => (cents.get(c) ?? 0) > 0)
      .map((c) => money((cents.get(c) ?? 0) / 100, c, locale));
    return parts.length > 0 ? parts.join(' + ') : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, items, hidden, locale]);

  function resetFilters() {
    setFilter('free');
    setMaxPrice(null);
    setHighOnly(false);
    setSimilarTo(null);
  }

  /* ── Бронь ── */

  function openBook(item: SharedItem) {
    if (!canClaim) return;
    setError(null);
    setNotice(null);
    setBookError(null);
    setBook({ item, step: { kind: 'form' } });
  }

  async function submitBook(quantity: number, name: string, email: string) {
    if (!book || bookBusy || !data) return;
    const target = book.item;
    // Бронь, зняття якої ще відлічує тост, повертаємо: інакше відкладений
    // запит зняв би її вже після нової броні.
    let base = countsOf(target).mine;
    if (hidden.has(target.id) && pendingRelease.current === target.id) {
      undo.undo();
      base = 0;
    }
    const first = !data.guest;
    setBookBusy(true);
    setBookError(null);
    // Ключ зберігається до запиту: обірвана відповідь не лишить бронь без власника.
    const k = ensureKey(token);
    setKey(k);
    try {
      const res = await claimItemV2(token, target.id, k, base + quantity, name, email, locale);
      setData(await fetchGuestList(token, k));
      if (first) setBook({ item: target, step: { kind: 'code', code: res.code } });
      else setBook(null);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (e instanceof GoneError) {
        setBook(null);
        setGone(true);
        return;
      }
      if (msg.includes('not_enough_left')) {
        // Гонка: поки гість думав, позицію взяли. Конфлікт ловимо на записі.
        setBook({ item: target, step: { kind: 'race' } });
      } else if (msg.includes('bad_name')) {
        setBookError(t('v2guest.book.badName'));
      } else if (msg.includes('bad_email')) {
        setBookError(t('v2guest.book.badEmail'));
      } else {
        setBookError(t('v2guest.error'));
      }
      try {
        setData(await fetchGuestList(token, k));
      } catch {
        /* лишаємо те, що є на екрані */
      }
    } finally {
      setBookBusy(false);
    }
  }

  function showSimilar() {
    if (!book) return;
    setSimilarTo(book.item);
    setBook(null);
    listTop.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /* ── Зняти бронь: тост «Відмінити», запит — після відліку ── */

  function release(item: SharedItem) {
    if (!key) return;
    setPicksOpen(false);
    setError(null);
    setHidden((s) => new Set(s).add(item.id));
    pendingRelease.current = item.id;
    undo.schedule({
      label: t('v2guest.released', { title: item.title }),
      commit: () => void commitRelease(item),
      revert: () => {
        pendingRelease.current = null;
        setHidden((s) => without(s, item.id));
      },
    });
  }

  async function commitRelease(item: SharedItem) {
    if (pendingRelease.current === item.id) pendingRelease.current = null;
    const k = storedKey(token) ?? key;
    if (!k) return;
    try {
      await releaseClaim(token, item.id, k);
      setData(await fetchGuestList(token, k));
    } catch (e) {
      if (e instanceof GoneError) setGone(true);
      else setError(t('v2guest.error'));
    } finally {
      setHidden((s) => without(s, item.id));
    }
  }

  /** «Лишити» після зміни (J): позначка «Змінено» знімається, бронь лишається. */
  async function keep(item: SharedItem) {
    const k = storedKey(token) ?? key;
    if (!k) return;
    setError(null);
    try {
      await ackClaimChange(token, item.id, k);
      setData(await fetchGuestList(token, k));
    } catch (e) {
      if (e instanceof GoneError) setGone(true);
      else setError(t('v2guest.error'));
    }
  }

  /** «Уже куплено» / «Ще не куплено» (потік S): лише позначка гостя, власник її не бачить. */
  async function bought(item: SharedItem, on: boolean) {
    const k = storedKey(token) ?? key;
    if (!k) return;
    setError(null);
    try {
      await setClaimBought(token, item.id, k, on);
      setData(await fetchGuestList(token, k));
    } catch (e) {
      if (e instanceof GoneError) setGone(true);
      else setError(t('v2guest.error'));
    }
  }

  /* ── «У магазин» без броні ── */

  /**
   * Перехід за посиланням позиції, яку гість ще не взяв: раз за сесію —
   * аркуш «Забронювати й перейти». Посилання не блокується: обидві кнопки
   * аркуша самі відкривають магазин, а вдруге питання не буде.
   */
  function handleShop(item: SharedItem, e: ReactMouseEvent<HTMLAnchorElement>) {
    if (!canClaim || data?.viewer_is_owner) return;
    const c = countsOf(item);
    if (c.mine > 0 || c.left <= 0) return;
    if (shopAskedRef.current || shopAsked(token)) return;
    e.preventDefault();
    setShopItem(item);
  }

  function closeShop() {
    shopAskedRef.current = true;
    markShopAsked(token);
    setShopItem(null);
  }

  /** «Забронювати й перейти»: одна штука, без аркуша; першій броні — код. */
  async function quickBook(item: SharedItem) {
    if (!data) return;
    const first = !data.guest;
    const k = ensureKey(token);
    setKey(k);
    setError(null);
    try {
      const res = await claimItemV2(token, item.id, k, countsOf(item).mine + 1, null, null, locale);
      setData(await fetchGuestList(token, k));
      if (first) {
        setBookError(null);
        setBook({ item, step: { kind: 'code', code: res.code } });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (e instanceof GoneError) {
        setGone(true);
        return;
      }
      if (msg.includes('not_enough_left')) setBook({ item, step: { kind: 'race' } });
      else setError(t('v2guest.error'));
      try {
        setData(await fetchGuestList(token, k));
      } catch {
        /* лишаємо те, що є на екрані */
      }
    }
  }

  /* ── Забрати доступ із собою ── */

  async function copyText(text: string): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      setError(t('v2guest.error'));
      return false;
    }
  }

  async function sendLink() {
    const k = storedKey(token) ?? key;
    if (!k || !data) return;
    const url = personalLink(token, k, BASE);
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: data.title, url });
        return;
      } catch (e) {
        // Людина закрила системне вікно — це не помилка.
        if (e instanceof DOMException && e.name === 'AbortError') return;
      }
    }
    if (await copyText(url)) setNotice(t('v2guest.copied'));
  }

  /** Власник прийшов зі своїх посилань — туди ж; відкрив адресу напряму — на «Мої посилання». */
  function ownerBack() {
    const idx = (window.history.state as { idx?: number } | null)?.idx ?? 0;
    if (idx > 0) navigate(-1);
    else navigate('/shares');
  }

  /* ── Розмітка ── */

  if (loading || urlKey || mailToken) {
    return (
      <div className="v2-guest v2-guest--boot" role="status">
        <span className="v2-spinner" aria-hidden="true" />
        <span className="v2-sr">{t('common.loading')}</span>
      </div>
    );
  }

  /**
   * Мертве посилання — один екран на всі три причини. Доля броней названа
   * прямо (потік G): гість завжди знає, що з ними сталось.
   */
  if (gone || !data) {
    return (
      <main className="v2-guest v2-guest--gone">
        <span className="v2-circle v2-circle--warm" aria-hidden="true">
          <Link2 size={32} strokeWidth={2.75} />
        </span>
        <h1 className="v2-guest__gone-title">{gone ? t('v2guest.goneTitle') : t('v2guest.error')}</h1>
        {gone && (
          <>
            <p className="v2-lede">{t('v2guest.goneBody')}</p>
            <p className="v2-hint">{t('v2guest.goneHint')}</p>
          </>
        )}
      </main>
    );
  }

  const day = formatDay(data.event_date, locale);
  const validUntil = validUntilText(data.expires_at, data.expires_tz, locale, t);
  const flagOf = (i: SharedItem) =>
    changes?.fresh.has(i.id) ? t('v2guest.tagNew') : changes?.freed.has(i.id) ? t('v2guest.tagFreed') : null;
  const card = (i: SharedItem) => (
    <GuestCardV2
      key={i.id}
      item={i}
      currency={listCurrency}
      counts={countsOf(i)}
      canClaim={canClaim}
      flag={flagOf(i)}
      onTake={openBook}
      onRelease={release}
      onKeep={(i) => void keep(i)}
      onBought={(i, on) => void bought(i, on)}
      onShop={handleShop}
      preview={asOwner}
    />
  );
  const takenRest = items.filter((i) => countsOf(i).mine === 0);
  const filtersOn = maxPrice !== null || highOnly;
  /** «Спершу натисніть «Беру»» — доки в гостя немає жодної броні й є куди йти. */
  const shopHint =
    canClaim && !data.viewer_is_owner && mineItems.length === 0 && items.some((i) => i.url && countsOf(i).left > 0);

  return (
    // <main>: гостьову відкривають сторонні люди, і зчитувачу екрана потрібен орієнтир.
    <main className="v2-guest">
      <GuestHeadV2
        day={day}
        title={data.title}
        count={counts.items(items.length)}
        message={data.message}
        validUntil={validUntil}
        action={
          canClaim &&
          !asOwner && (
            <button
              type="button"
              className="v2-guest__picks"
              onClick={() => (mineItems.length > 0 ? setPicksOpen(true) : setRedeemOpen(true))}
            >
              {mineItems.length > 0 && <ListChecks size={18} strokeWidth={2.75} aria-hidden="true" />}
              {mineItems.length > 0 ? t('v2guest.mine', { n: mineItems.length }) : t('v2guest.haveCode')}
            </button>
          )
        }
      />

      <div className="v2-guest__body">
        {data.viewer_is_owner && (
          <div className="v2-gbanner" role="status">
            <span>{t('v2guest.ownerBanner')}</span>
            {/* У застосунку з головного екрана немає кнопки «Назад» браузера. */}
            <button type="button" className="v2-btn v2-btn--ghost v2-btn--small" onClick={ownerBack}>
              {t('v2guest.ownerBack')}
            </button>
          </div>
        )}
        {error && <NoteV2 tone="error">{error}</NoteV2>}
        {notice && <NoteV2 tone="info">{notice}</NoteV2>}
        {unsubToken && (
          <div className="v2-gbanner" role="status">
            <span>{unsubOn ? t('v2guest.unsub.back') : t('v2guest.unsub.done')}</span>
            {!unsubOn && (
              <button type="button" className="v2-btn v2-btn--ghost v2-btn--small" onClick={() => void toggleMail(true)}>
                {t('v2guest.unsub.undo')}
              </button>
            )}
          </div>
        )}

        {changes && (
          <div className="v2-gbanner" role="status">
            <span>
              {changes.fresh.size || changes.freed.size
                ? t('v2guest.changes', { new: changes.fresh.size, freed: changes.freed.size })
                : t('v2guest.noChanges')}
            </span>
            <button type="button" className="v2-btn v2-btn--ghost v2-btn--small" onClick={unwatch}>
              {t('v2guest.unwatch')}
            </button>
          </div>
        )}

        {items.length === 0 ? (
          <div className="v2-gempty">
            <h2 className="v2-gempty__title">{t('v2guest.emptyTitle')}</h2>
            <p className="v2-lede">{t('v2guest.emptyBody')}</p>
          </div>
        ) : allTaken ? (
          <>
            {/* «Усе розібрали» — не помилка, а привід повернутись; список
                лишається видимим — підказка для власного подарунка. */}
            <section className="v2-card v2-gall" aria-labelledby="v2-gall-title">
              <h2 className="v2-card__title" id="v2-gall-title">
                {mineItems.length > 0
                  ? t('v2guest.allTakenMine', { n: mineItems.length })
                  : t('v2guest.allTakenTitle')}
              </h2>
              <p className="v2-hint v2-hint--start">
                {mineItems.length > 0 ? t('v2guest.allTakenBodyMine') : t('v2guest.allTakenBody')}
              </p>
              {watching ? (
                <p className="v2-hint v2-hint--start">
                  {t('v2guest.watching')}{' '}
                  <button type="button" className="v2-link" onClick={unwatch}>
                    {t('v2guest.unwatch')}
                  </button>
                </p>
              ) : (
                <>
                  <button type="button" className="v2-btn v2-btn--primary v2-btn--block" onClick={watch}>
                    {t('v2guest.watch')}
                  </button>
                  <p className="v2-hint v2-hint--start">{t('v2guest.watchHint')}</p>
                </>
              )}
            </section>
            {mineItems.length > 0 && <ul className="v2-gcards">{mineItems.map(card)}</ul>}
            {takenRest.length > 0 && (
              <section className="v2-gtaken" aria-labelledby="v2-gtaken-title">
                <h2 className="v2-kicker" id="v2-gtaken-title">
                  {t('v2guest.allTakenList')} · {takenRest.length}
                </h2>
                <ul className="v2-gtaken__rows">
                  {takenRest.map((i) => (
                    <li key={i.id} className="v2-gtaken__row">
                      <span>{i.title}</span>
                      <span className="v2-tag" data-tone="neutral">
                        {t('v2guest.takenPill')}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
          </>
        ) : (
          <>
            <div className="v2-gfilters" ref={listTop}>
              {(canClaim || thresholds.length > 0 || hasHigh) && (
                <div className="v2-chips">
                  {canClaim && (
                    <span className="v2-gfilters__group" role="radiogroup" aria-label={t('v2guest.filterLabel')}>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={filter === 'free'}
                        className="v2-chip v2-chip--toggle"
                        onClick={() => setFilter('free')}
                      >
                        {t('v2guest.filterFree', { n: freeItems.length })}
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={filter === 'all'}
                        className="v2-chip v2-chip--toggle"
                        onClick={() => setFilter('all')}
                      >
                        {t('v2guest.filterAll', { n: items.length })}
                      </button>
                    </span>
                  )}
                  {thresholds.length > 0 && (
                    <span className="v2-gfilters__group" role="group" aria-label={t('v2guest.filterPrice')}>
                      {thresholds.map((v) => (
                        <button
                          key={v}
                          type="button"
                          aria-pressed={maxPrice === v}
                          className="v2-chip v2-chip--toggle"
                          onClick={() => setMaxPrice(maxPrice === v ? null : v)}
                        >
                          {t('v2guest.priceUpTo', { price: money(v, listCurrency, locale) ?? String(v) })}
                        </button>
                      ))}
                    </span>
                  )}
                  {hasHigh && (
                    <button
                      type="button"
                      aria-pressed={highOnly}
                      aria-label={t('v2guest.filterHigh')}
                      className="v2-chip v2-chip--toggle"
                      onClick={() => setHighOnly(!highOnly)}
                    >
                      {priority('high')}
                    </button>
                  )}
                </div>
              )}
              {canClaim && (
                <p className="v2-hint v2-hint--start" aria-live="polite">
                  {t('v2guest.freeCounter', { n: freeItems.length, m: items.length })}
                  {freeSum && ` · ${t('v2guest.freeSum', { sum: freeSum })}`}
                </p>
              )}
              {shopHint && <p className="v2-hint v2-hint--start">{t('v2guest.shopHint')}</p>}
            </div>

            {similarTo && similar.length > 0 && (
              <section className="v2-group" aria-labelledby="v2-gsimilar-title">
                <div className="v2-group__head">
                  <h2 className="v2-kicker v2-group__title" id="v2-gsimilar-title">
                    {t('v2guest.similarTitle')}
                  </h2>
                  <button
                    type="button"
                    className="v2-iconbtn"
                    aria-label={t('v2guest.similarClear')}
                    onClick={() => setSimilarTo(null)}
                  >
                    <X size={20} strokeWidth={2.75} aria-hidden="true" />
                  </button>
                </div>
                <ul className="v2-gcards">{similar.map(card)}</ul>
              </section>
            )}

            {shown.length > 0 ? (
              groups.map((g) => (
                <section key={g.id ?? '__other'} className="v2-group" aria-label={g.title ?? undefined}>
                  {g.title && (
                    <div className="v2-group__head">
                      <h2 className="v2-kicker v2-group__title">{g.title}</h2>
                      {canClaim && (
                        <span className="v2-hint">
                          {t('v2guest.sectionFree', {
                            n: g.items.filter((i) => countsOf(i).left > 0).length,
                            m: g.items.length,
                          })}
                        </span>
                      )}
                    </div>
                  )}
                  <ul className="v2-gcards">{g.items.map(card)}</ul>
                </section>
              ))
            ) : (
              <div className="v2-gempty">
                <p className="v2-lede">{filtersOn ? t('v2guest.filterEmpty') : t('v2guest.freeEmpty')}</p>
                <button
                  type="button"
                  className="v2-btn v2-btn--outline"
                  onClick={() => {
                    const wasFiltered = filtersOn;
                    resetFilters();
                    if (!wasFiltered) setFilter('all');
                  }}
                >
                  {t('v2guest.filterReset')}
                </button>
              </div>
            )}
          </>
        )}

        {canClaim && <p className="v2-hint">{t('v2guest.ownerBlind')}</p>}
        <p className="v2-guest__footer">{t('v2guest.footer')}</p>

        {/* Підвал: лише вигляд і мова. Жодної реєстрації й жодного посилання
            в застосунок — гість прийшов не за цим (README пакета, правило 3). */}
        <div className="v2-guest__bar">
          <button type="button" className="v2-btn v2-btn--ghost v2-btn--small" onClick={() => setLookOpen(true)}>
            <Palette size={18} strokeWidth={2.75} aria-hidden="true" />
            {t('v2guest.look')}
          </button>
          <label className="v2-sr" htmlFor={langId}>
            {t('v2guest.language')}
          </label>
          <select
            id={langId}
            className="v2-lang"
            value={locale}
            onChange={(e) => setLocale(e.target.value as Locale)}
          >
            {LOCALES.map((l) => (
              <option key={l} value={l} lang={l}>
                {LANGUAGE[l]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <GuestToastV2 label={undo.pending?.label ?? null} until={undo.until} onUndo={undo.undo} />

      <BookSheetV2
        item={book?.item ?? null}
        step={book?.step ?? { kind: 'form' }}
        counts={book ? countsOf(book.item) : { left: 1, mine: 0 }}
        name={data.guest?.name ?? ''}
        email={data.guest?.email ?? ''}
        busy={bookBusy}
        error={bookError}
        canSimilar={Boolean(
          book &&
            num(book.item.price) !== null &&
            items.some(
              (i) =>
                i.id !== book.item.id &&
                countsOf(i).left > 0 &&
                num(i.price) !== null &&
                (i.currency ?? listCurrency) === (book.item.currency ?? listCurrency),
            ),
        )}
        onSubmit={(q, n, e) => void submitBook(q, n, e)}
        onClose={() => {
          if (!bookBusy) setBook(null);
        }}
        onSimilar={showSimilar}
        onCopyCode={copyText}
        onSendLink={() => void sendLink()}
      />

      <MyPicksSheetV2
        open={picksOpen}
        items={mineItems.map((item) => ({ item, mine: countsOf(item).mine }))}
        currency={listCurrency}
        code={data.guest?.code ?? null}
        name={data.guest?.name ?? null}
        email={data.guest?.email ?? null}
        onRelease={release}
        onKeep={(i) => void keep(i)}
        onBought={(i, on) => void bought(i, on)}
        onCopyCode={copyText}
        onSendLink={() => void sendLink()}
        onClose={() => setPicksOpen(false)}
      />

      <RedeemSheetV2
        open={redeemOpen}
        token={token}
        onClose={() => setRedeemOpen(false)}
        onRedeemed={async (newKey, n) => {
          rememberKey(token, newKey);
          setKey(newKey);
          setRedeemOpen(false);
          setNotice(t('v2guest.redeem.done', { n }));
          try {
            setData(await fetchGuestList(token, newKey));
          } catch {
            /* сторінка перечитається при наступній дії */
          }
        }}
      />

      <ShopSheetV2
        item={shopItem}
        onBook={(i) => {
          closeShop();
          void quickBook(i);
        }}
        onLook={closeShop}
        onClose={closeShop}
      />

      <LookSheetV2 open={lookOpen} onClose={() => setLookOpen(false)} />
    </main>
  );
}

function without<T>(set: Set<T>, value: T): Set<T> {
  if (!set.has(value)) return set;
  const next = new Set(set);
  next.delete(value);
  return next;
}

/**
 * Тост «Відмінити» гостьової: той самий вигляд, що в застосунку, але без
 * примітки про чергу — броні гостя офлайн не чекають, а повертаються з
 * помилкою.
 */
function GuestToastV2({ label, until, onUndo }: { label: string | null; until: number | null; onUndo: () => void }) {
  const { t } = useI18n();
  const left = useCountdown(until);
  if (!label) return null;
  return (
    <div className="v2-toast v2-toast--guest" role="status">
      <span className="v2-toast__timer" aria-hidden="true">
        {left}
      </span>
      <span className="v2-toast__text">
        <span className="v2-toast__label">{label}</span>
      </span>
      <button type="button" className="v2-toast__btn" onClick={onUndo}>
        {t('v2list.toast.undo')}
      </button>
    </div>
  );
}
