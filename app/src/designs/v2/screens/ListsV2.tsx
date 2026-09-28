import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, Check, ChevronRight, Link2, ListPlus, Plus } from 'lucide-react';
import { createList, deleteList, fetchDefaultCurrency, fetchListsOverview } from '../../../lib/db';
import { fetchAppearances } from '../../../lib/appearances';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';
import { useTheme } from '../../../lib/theme';
import { errorText, isNetworkError } from '../../../lib/errors';
import { formatDateTime, formatDay, localToday } from '../../../lib/format';
import { LISTS_KEY, readSnapshot, saveSnapshot } from '../../../lib/cache';
import { overlayVars } from '../../../lib/hue-ramp.js';
import { useUndo } from '../../../lib/undo';
import type { List } from '../../../lib/types';
import { NoteV2 } from './AuthPartsV2';
import { useCounts } from './CommonV2';
import { UndoToastV2 } from './ListPartsV2';

/** Стрічка «Вітаю!» після входу живе стільки (A4). */
const WELCOME_MS = 4000;
/** Тост «Відмінити» — шість секунд, як і на сторінці списку. */
const UNDO_MS = 6000;
/** Перший запуск «З чого почнемо?» показано — більше не питаємо (Q2). */
const FIRST_RUN_KEY = 'wl.v2.firstRunDone';

function firstRunDone(): boolean {
  try {
    return localStorage.getItem(FIRST_RUN_KEY) === '1';
  } catch {
    return false;
  }
}

function markFirstRun() {
  try {
    localStorage.setItem(FIRST_RUN_KEY, '1');
  } catch {
    /* без сховища спитаємо ще раз — не біда */
  }
}

/** З чим сюди прийшли: після входу, з видаленням списку, після видалення. */
type Arrival = {
  welcome?: boolean;
  /** Список, який ніхто не відкривав: видаляється тостом «Відмінити» (F3). */
  deleteList?: { id: string; title: string };
  /** Список видалено остаточно — назву кажемо один раз. */
  deletedTitle?: string;
} | null;

type Tone = 'soon' | 'undated' | 'past';

/** Шаблони свят для порожньої головної (U2): лише назва, решта — всередині. */
const TEMPLATES = ['birthday', 'wedding', 'newYear', 'baby', 'housewarming', 'graduation', 'anniversary', 'secretSanta'] as const;

/** Календарний день `YYYY-MM-DD` як місцева північ. */
function day(iso: string): Date {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return new Date(y!, m! - 1, d!);
}

/**
 * Головна v2 — «Мої списки» (потоки U1, B1, A4).
 *
 * Два блоки: «Найближчі» — за датою події, списки без дати одразу за ними;
 * «Минулі» — від найсвіжішого. На картці — коло (відтінок оформлення списку
 * або тон блоку), назва й один рядок: «18 жовтня · через 21 день», «без
 * дати · 6 позицій», «1 січня · 4 позиції не розібрано».
 *
 * Жодного слова про позначки гостей — ні числа, ні «сюрпризу до…» (ADR-040).
 * «Не розібрано» — це статуси самого власника.
 *
 * Порожня головна — шаблони свят (U2): вони лише підставляють назву. Уперше
 * порожня — «З чого почнемо?» (Q2): одразу річ, список до свята чи пропустити.
 *
 * Сюди ж повертається видалення списку зі сторінки списку: той, посилання на
 * який ніхто не відкривав, зникає одразу й видаляється після тосту
 * «Відмінити» (F3); видалений остаточно — рядок «Список … видалено».
 */
export default function ListsV2() {
  const { t, locale } = useI18n();
  const { session } = useAuth();
  const { resolved } = useTheme();
  const counts = useCounts();
  const location = useLocation();
  const navigate = useNavigate();
  const userId = session?.user.id ?? '';

  const [lists, setLists] = useState<List[]>([]);
  const [hues, setHues] = useState<Map<string, number>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [staleAt, setStaleAt] = useState<string | null>(null);
  const [arrival] = useState<Arrival>(() => (location.state as Arrival) ?? null);
  const [welcome, setWelcome] = useState(() => Boolean(arrival?.welcome));
  const [flash, setFlash] = useState<string | null>(() => arrival?.deletedTitle ?? null);
  /** Списки, чиє видалення ще відлічує тост. */
  const [hidden, setHidden] = useState<Set<string>>(() => new Set(arrival?.deleteList ? [arrival.deleteList.id] : []));
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [firstRun, setFirstRun] = useState(() => !firstRunDone());
  const [starting, setStarting] = useState(false);
  const undo = useUndo(UNDO_MS);

  // Стан історії — раз: чистимо одразу, інакше F5 показав би «Вітаю!» знову.
  useEffect(() => {
    if (arrival) navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!welcome) return;
    const id = window.setTimeout(() => setWelcome(false), WELCOME_MS);
    return () => window.clearTimeout(id);
  }, [welcome]);

  useEffect(() => {
    if (!flash) return;
    const id = window.setTimeout(() => setFlash(null), WELCOME_MS);
    return () => window.clearTimeout(id);
  }, [flash]);

  // Список, який ніхто не відкривав, видаляється тут — тостом «Відмінити».
  // Відлік ставимо таймером, а не прямо в ефекті: у StrictMode ефект
  // проганяється двічі, і прибирання першого проходу довело б видалення до
  // кінця без жодного відліку.
  useEffect(() => {
    const target = arrival?.deleteList;
    if (!target) return;
    const timer = window.setTimeout(() => {
      undo.schedule({
        label: t('v2list.toast.deleted', { title: target.title }),
        commit: () => {
          deleteList(target.id)
            .then(() => setLists((prev) => prev.filter((l) => l.id !== target.id)))
            .catch((e: unknown) => {
              setDeleteError(errorText(e, t));
              setHidden((prev) => {
                const next = new Set(prev);
                next.delete(target.id);
                return next;
              });
            });
        },
        revert: () =>
          setHidden((prev) => {
            const next = new Set(prev);
            next.delete(target.id);
            return next;
          }),
      });
    }, 0);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const fresh = await fetchListsOverview();
      setLists(fresh);
      setError(null);
      setStaleAt(null);
      void saveSnapshot(LISTS_KEY, userId, fresh);
      // Відтінки — лише якщо хоч один список оформлено: зайвий запит не потрібен.
      if (fresh.some((l) => l.appearance_id)) {
        fetchAppearances()
          .then((all) => setHues(new Map(all.map((a) => [a.id, a.hue]))))
          .catch(() => undefined);
      }
    } catch (e) {
      // Без мережі — останній бачений стан, чесно позначений як копія.
      // Відмову сервера копією не прикриваємо.
      const snapshot = isNetworkError(e) ? await readSnapshot<List[]>(LISTS_KEY, userId) : null;
      if (snapshot) {
        setLists(snapshot.data);
        setStaleAt(snapshot.savedAt);
        setError(null);
      } else {
        setError(errorText(e, t));
      }
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  const today = localToday();
  const visible = useMemo(() => lists.filter((l) => !hidden.has(l.id)), [lists, hidden]);
  const groups = useMemo(() => {
    const soon = visible
      .filter((l) => l.event_date && l.event_date.slice(0, 10) >= today)
      .sort((a, b) => a.event_date!.localeCompare(b.event_date!));
    const undated = visible.filter((l) => !l.event_date);
    const past = visible
      .filter((l) => l.event_date && l.event_date.slice(0, 10) < today)
      .sort((a, b) => b.event_date!.localeCompare(a.event_date!));
    return { soon, undated, past };
  }, [visible, today]);

  const relative = useMemo(() => new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }), [locale]);

  function meta(l: List, tone: Tone): string {
    const n = l.item_count ?? 0;
    if (tone === 'undated') return `${t('v2app.lists.noDate')} · ${counts.items(n)}`;
    const date = formatDay(l.event_date, locale) ?? '';
    if (tone === 'soon') {
      const days = Math.round((day(l.event_date!).getTime() - day(today).getTime()) / 86_400_000);
      return `${date} · ${relative.format(days, 'day')}`;
    }
    const open = l.active_count ?? 0;
    return `${date} · ${open > 0 ? counts.open(open) : counts.items(n)}`;
  }

  /** Коло картки: відтінок оформлення списку, якщо він діє, інакше тон блоку. */
  function dot(l: List): CSSProperties | undefined {
    const hue = l.appearance_id ? hues.get(l.appearance_id) : undefined;
    // Висока контрастність перемагає будь-яке оформлення (ADR-033, правило 1).
    if (hue === undefined || resolved.scheme === 'vuhil') return undefined;
    return { '--v2-dot': overlayVars(hue, resolved.theme)['--color-accent-200'] } as CSSProperties;
  }

  function card(l: List, tone: Tone) {
    return (
      <li key={l.id}>
        <Link to={`/lists/${l.id}`} className="v2-listcard" data-tone={tone}>
          <span className="v2-listcard__dot" style={dot(l)} aria-hidden="true" />
          <span className="v2-listcard__text">
            <span className="v2-listcard__title">{l.title}</span>
            <span className="v2-listcard__meta">{meta(l, tone)}</span>
          </span>
          <ChevronRight className="v2-listcard__chevron" size={20} strokeWidth={2.75} aria-hidden="true" />
        </Link>
      </li>
    );
  }

  const empty = !loading && !error && visible.length === 0;

  /**
   * «Вставити посилання на річ» (Q2): список створюється з назвою «Мої
   * бажання» — назвати інакше можна пізніше, у налаштуваннях списку, — і
   * одразу відкривається форма позиції. Чернеток без назви ще немає (крок 4).
   */
  async function startWithItem() {
    if (starting) return;
    setStarting(true);
    setDeleteError(null);
    try {
      const currency = (userId ? await fetchDefaultCurrency(userId).catch(() => null) : null) ?? 'PLN';
      const created = await createList({ title: t('v2app.firstRun.defaultTitle'), currency }, userId);
      markFirstRun();
      navigate(`/lists/${created.id}`, { state: { add: true } });
    } catch (e) {
      setDeleteError(errorText(e, t));
      setStarting(false);
    }
  }

  function finishFirstRun(to?: string) {
    markFirstRun();
    setFirstRun(false);
    if (to) navigate(to);
  }

  const notes = (
    <>
      {welcome && <Welcome />}
      {flash && <Flash text={t('v2app.lists.deleted', { title: flash })} />}
      {deleteError && <NoteV2 tone="error">{deleteError}</NoteV2>}
    </>
  );
  const toast = <UndoToastV2 pending={undo.pending} until={undo.until} onUndo={undo.undo} />;

  const template = (key: (typeof TEMPLATES)[number]) => {
    switch (key) {
      case 'birthday':
        return t('v2app.templates.birthday');
      case 'wedding':
        return t('v2app.templates.wedding');
      case 'newYear':
        return t('v2app.templates.newYear');
      case 'baby':
        return t('v2app.templates.baby');
      case 'housewarming':
        return t('v2app.templates.housewarming');
      case 'graduation':
        return t('v2app.templates.graduation');
      case 'anniversary':
        return t('v2app.templates.anniversary');
      default:
        return t('v2app.templates.secretSanta');
    }
  };

  if (empty && firstRun) {
    return (
      <main className="v2-page v2-page--narrow">
        {notes}
        <div className="v2-first">
          <div className="v2-head">
            <h1 className="v2-page__title">{t('v2app.firstRun.title')}</h1>
            <p className="v2-lede">{t('v2app.firstRun.body')}</p>
          </div>
          <button
            type="button"
            className="v2-first__choice"
            aria-disabled={starting || undefined}
            onClick={() => void startWithItem()}
          >
            <span className="v2-circle v2-circle--calm v2-first__icon" aria-hidden="true">
              {starting ? <span className="v2-spinner" /> : <Link2 size={24} strokeWidth={2.75} />}
            </span>
            <span className="v2-first__text">
              <span className="v2-first__label">{t('v2app.firstRun.withItem')}</span>
              <span className="v2-first__hint">{t('v2app.firstRun.withItemHint')}</span>
            </span>
          </button>
          <button type="button" className="v2-first__choice" onClick={() => finishFirstRun('/lists/new')}>
            <span className="v2-circle v2-circle--warm v2-first__icon" aria-hidden="true">
              <ListPlus size={24} strokeWidth={2.75} />
            </span>
            <span className="v2-first__text">
              <span className="v2-first__label">{t('v2app.firstRun.withList')}</span>
              <span className="v2-first__hint">{t('v2app.firstRun.withListHint')}</span>
            </span>
          </button>
          <button type="button" className="v2-btn v2-btn--ghost" onClick={() => finishFirstRun()}>
            {t('v2app.firstRun.skip')}
          </button>
        </div>
        {toast}
      </main>
    );
  }

  if (empty) {
    return (
      <main className="v2-page">
        {notes}
        <div className="v2-head">
          <h1 className="v2-page__title">{t('v2app.templates.title')}</h1>
          <p className="v2-lede">{t('v2app.templates.body')}</p>
        </div>
        <ul className="v2-chips">
          {TEMPLATES.map((k) => (
            <li key={k}>
              <Link to="/lists/new" state={{ title: template(k) }} className="v2-chip">
                {template(k)}
              </Link>
            </li>
          ))}
        </ul>
        <Link to="/lists/new" className="v2-btn v2-btn--ghost">
          {t('v2app.templates.own')}
        </Link>
        {toast}
      </main>
    );
  }

  return (
    <main className="v2-page" aria-busy={loading || undefined}>
      {notes}
      <div className="v2-page__head">
        <h1 className="v2-page__title">{t('v2app.lists.title')}</h1>
        {!error && (
          <Link to="/lists/new" className="v2-fab" aria-label={t('v2app.lists.new')}>
            <Plus size={24} strokeWidth={2.75} aria-hidden="true" />
          </Link>
        )}
      </div>

      {staleAt && (
        <NoteV2 tone="info">{t('v2app.lists.stale', { time: formatDateTime(staleAt, locale) ?? '' })}</NoteV2>
      )}

      {loading ? (
        <>
          <span className="v2-sr">{t('v2app.lists.loading')}</span>
          <ul className="v2-listgrid" aria-hidden="true">
            {[0, 1, 2].map((i) => (
              <li key={i} className="v2-listcard v2-listcard--sk" style={{ animationDelay: `${i * 150}ms` }} />
            ))}
          </ul>
        </>
      ) : error ? (
        <div className="v2-empty">
          <span className="v2-circle v2-circle--warm" aria-hidden="true">
            <AlertCircle size={32} strokeWidth={2.75} />
          </span>
          <h2 className="v2-empty__title">{t('v2app.lists.errorTitle')}</h2>
          <p className="v2-lede" role="alert">
            {error}
          </p>
          <button type="button" className="v2-btn v2-btn--primary" onClick={() => void load()}>
            {t('common.retry')}
          </button>
        </div>
      ) : (
        <div className="v2-stack" data-stale={staleAt ? 'true' : undefined}>
          {(groups.soon.length > 0 || groups.undated.length > 0) && (
            <section aria-labelledby="v2-soon">
              <h2 className="v2-kicker" id="v2-soon">
                {t('v2app.lists.upcoming')}
              </h2>
              <ul className="v2-listgrid">
                {groups.soon.map((l) => card(l, 'soon'))}
                {groups.undated.map((l) => card(l, 'undated'))}
              </ul>
            </section>
          )}
          {groups.past.length > 0 && (
            <section aria-labelledby="v2-past">
              <h2 className="v2-kicker" id="v2-past">
                {t('v2app.lists.past')}
              </h2>
              <ul className="v2-listgrid">{groups.past.map((l) => card(l, 'past'))}</ul>
            </section>
          )}
        </div>
      )}
      {toast}
    </main>
  );
}

/** Одноразова стрічка про те, що сталося, — як «Вітаю!», але з текстом. */
function Flash({ text }: { text: string }) {
  return (
    <p className="v2-welcome" role="status">
      <Check size={18} strokeWidth={2.75} aria-hidden="true" />
      {text}
    </p>
  );
}

/** Стрічка вітання: без окремого екрана «Успішно» — він краде крок (A4). */
function Welcome() {
  const { t } = useI18n();
  return (
    <p className="v2-welcome" role="status">
      <Check size={18} strokeWidth={2.75} aria-hidden="true" />
      {t('v2app.lists.welcome')}
    </p>
  );
}
