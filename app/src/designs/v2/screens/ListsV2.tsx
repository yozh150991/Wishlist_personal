import { useCallback, useEffect, useMemo, useState } from 'react';
import type { CSSProperties } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, Check, ChevronRight, Plus } from 'lucide-react';
import { fetchListsOverview } from '../../../lib/db';
import { fetchAppearances } from '../../../lib/appearances';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';
import { useTheme } from '../../../lib/theme';
import { errorText, isNetworkError } from '../../../lib/errors';
import { formatDateTime, formatDay, localToday } from '../../../lib/format';
import { LISTS_KEY, readSnapshot, saveSnapshot } from '../../../lib/cache';
import { overlayVars } from '../../../lib/hue-ramp.js';
import type { List } from '../../../lib/types';
import { NoteV2 } from './AuthPartsV2';
import { useCounts } from './CommonV2';

/** Стрічка «Вітаю!» після входу живе стільки (A4). */
const WELCOME_MS = 4000;

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
 * Порожня головна — шаблони свят (U2): вони лише підставляють назву.
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
  const [welcome, setWelcome] = useState(() => Boolean((location.state as { welcome?: boolean } | null)?.welcome));

  // «Вітаю!» — раз: стан історії чистимо одразу, інакше F5 показав би знову.
  useEffect(() => {
    if (!welcome) return;
    navigate(location.pathname, { replace: true, state: null });
    const id = window.setTimeout(() => setWelcome(false), WELCOME_MS);
    return () => window.clearTimeout(id);
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
  const groups = useMemo(() => {
    const soon = lists
      .filter((l) => l.event_date && l.event_date.slice(0, 10) >= today)
      .sort((a, b) => a.event_date!.localeCompare(b.event_date!));
    const undated = lists.filter((l) => !l.event_date);
    const past = lists
      .filter((l) => l.event_date && l.event_date.slice(0, 10) < today)
      .sort((a, b) => b.event_date!.localeCompare(a.event_date!));
    return { soon, undated, past };
  }, [lists, today]);

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

  const empty = !loading && !error && lists.length === 0;

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

  if (empty) {
    return (
      <main className="v2-page">
        {welcome && <Welcome />}
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
      </main>
    );
  }

  return (
    <main className="v2-page" aria-busy={loading || undefined}>
      {welcome && <Welcome />}
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
    </main>
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
