import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Copy, Search, X } from 'lucide-react';
import { fetchListsOverview, ownCurrency, searchMyItems } from '../../../lib/db';
import { LISTS_KEY, readItemSnapshots, readSnapshot } from '../../../lib/cache';
import { copyInput } from '../../../lib/afterEvent';
import { newId, run } from '../../../lib/outbox';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';
import { useDocumentTitle } from '../../../lib/documentTitle';
import { errorText, isNetworkError } from '../../../lib/errors';
import {
  SEARCH_LIMIT,
  SEARCH_QUERY_MAX,
  copyTargets,
  hitsFromServer,
  markRanges,
  noteSnippet,
  queryWords,
  searchLocal,
  searchable,
  shopOf,
} from '../../../lib/search';
import type { SearchHit } from '../../../lib/search';
import type { Item, List } from '../../../lib/types';
import { BackHeaderV2, NoteV2, SubmitV2 } from './AuthPartsV2';
import { SheetV2, useCounts } from './CommonV2';
import { Bar } from './AfterEventV2';
import { useStatusLabel } from './ListPartsV2';

const STROKE = 2.75;
/** Пауза після останньої літери, перш ніж іти в базу. */
const DEBOUNCE_MS = 250;

type Found =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  /** `device` — без мережі, з офлайн-копій: результат може бути неповним. */
  | { kind: 'done'; query: string; items: Item[]; more: boolean; source: 'server' | 'device' };

/** Що щойно скопіювали — рядком згори, з переходом до копії. */
type Copied = { listId: string; title: string; itemId: string; queued: boolean };

/**
 * «Пошук по всіх списках» (ROADMAP 8.11). Вхід — з «Моїх списків».
 *
 * У мережі шукає база (`search_my_items`, з архівом і без чужого — RLS), без
 * мережі — офлайн-копії на пристрої з чесною позначкою, що це може бути не
 * все. Запит живе в стані історії, а не в адресі: «Назад» зі списку
 * повертає той самий пошук, а назви позицій не потрапляють у журнали
 * запитів сервера при перезавантаженні.
 *
 * Результат веде в список із підсвіткою позиції; «Скопіювати в список…» —
 * нова позиція без позначок гостей і поза посиланнями (CLAUDE.md §3.2).
 */
export default function SearchV2() {
  const { t } = useI18n();
  useDocumentTitle(t('v2search.title'));
  const { session } = useAuth();
  const counts = useCounts();
  const location = useLocation();
  const navigate = useNavigate();
  const userId = session?.user.id ?? '';

  const [query, setQuery] = useState(() => {
    const q = (location.state as { q?: unknown } | null)?.q;
    return typeof q === 'string' ? q.slice(0, SEARCH_QUERY_MAX) : '';
  });
  const [lists, setLists] = useState<List[]>([]);
  const [found, setFound] = useState<Found>({ kind: 'idle' });
  const [copying, setCopying] = useState<SearchHit | null>(null);
  const [copied, setCopied] = useState<Copied | null>(null);
  /** Пошук «зараз», без паузи: Enter у полі. */
  const [now, setNow] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Списки — назви біля результатів і куди копіювати. Без мережі — копія.
  useEffect(() => {
    let alive = true;
    fetchListsOverview()
      .then((fresh) => alive && setLists(fresh))
      .catch(async (e: unknown) => {
        const snapshot = isNetworkError(e) && userId ? await readSnapshot<List[]>(LISTS_KEY, userId) : null;
        if (alive && snapshot) setLists(snapshot.data);
      });
    return () => {
      alive = false;
    };
  }, [userId]);

  useEffect(() => {
    const q = query.trim();
    if (!searchable(q)) {
      setFound({ kind: 'idle' });
      return;
    }
    const ctrl = new AbortController();
    const timer = window.setTimeout(
      () => {
        setFound({ kind: 'loading' });
        // Запит — у стан історії: «Назад» зі списку повертає той самий пошук.
        navigate(location.pathname, { replace: true, state: { q } });
        searchMyItems(q, SEARCH_LIMIT + 1, ctrl.signal)
          .then((items) => {
            if (ctrl.signal.aborted) return;
            setFound({
              kind: 'done',
              query: q,
              items: items.slice(0, SEARCH_LIMIT),
              more: items.length > SEARCH_LIMIT,
              source: 'server',
            });
          })
          .catch(async (e: unknown) => {
            if (ctrl.signal.aborted) return;
            if (!isNetworkError(e) || !userId) {
              setFound({ kind: 'error', message: errorText(e, t) });
              return;
            }
            const items = await readItemSnapshots(userId);
            if (ctrl.signal.aborted) return;
            setFound({ kind: 'done', query: q, items, more: false, source: 'device' });
          });
      },
      now > 0 ? 0 : DEBOUNCE_MS,
    );
    return () => {
      window.clearTimeout(timer);
      ctrl.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, now, userId]);

  /** Списки приїжджають окремо — приєднуємо їх під час рендеру, а не в запиті. */
  const hits = useMemo<SearchHit[]>(() => {
    if (found.kind !== 'done') return [];
    return found.source === 'server'
      ? hitsFromServer(found.items, lists, found.query)
      : searchLocal(found.items, lists, found.query);
  }, [found, lists]);

  const words = found.kind === 'done' ? queryWords(found.query) : [];
  const q = query.trim();

  return (
    <main className="v2-page v2-searchpage">
      <BackHeaderV2 to="/lists" title={t('v2search.title')} />

      <form
        role="search"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          setNow((n) => n + 1);
        }}
      >
        <div className="v2-search">
          <Search className="v2-search__icon" size={20} strokeWidth={STROKE} aria-hidden="true" />
          <input
            ref={inputRef}
            type="search"
            name="search_all"
            className="v2-input v2-search__input"
            aria-label={t('v2search.title')}
            aria-describedby="v2-search-hint"
            placeholder={t('v2search.placeholder')}
            maxLength={SEARCH_QUERY_MAX}
            enterKeyHint="search"
            autoComplete="off"
            // Окремий екран пошуку: сюди приходять саме друкувати.
            autoFocus
            value={query}
            onChange={(e) => {
              setNow(0);
              setQuery(e.target.value);
            }}
          />
          {query && (
            <button
              type="button"
              className="v2-iconbtn v2-search__clear"
              aria-label={t('v2list.search.clear')}
              onClick={() => {
                setQuery('');
                inputRef.current?.focus();
              }}
            >
              <X size={20} strokeWidth={STROKE} aria-hidden="true" />
            </button>
          )}
        </div>
      </form>
      <p className="v2-hint v2-hint--start" id="v2-search-hint">
        {q && !searchable(q) ? t('v2search.short') : t('v2search.hint')}
      </p>

      {copied && (
        <p className="v2-welcome v2-search__copied" role="status">
          <Copy size={18} strokeWidth={STROKE} aria-hidden="true" />
          <span>
            {copied.queued
              ? t('v2search.copiedQueued', { title: copied.title })
              : t('v2search.copied', { title: copied.title })}
          </span>
          <Link to={`/lists/${copied.listId}`} state={{ item: copied.itemId }}>
            {t('v2after.carry.open')}
          </Link>
        </p>
      )}

      <div aria-live="polite" aria-busy={found.kind === 'loading' || undefined}>
        {found.kind === 'loading' && <p className="v2-hint v2-hint--start">{t('v2search.searching')}</p>}
        {found.kind === 'error' && (
          <div className="v2-noresults">
            <h2 className="v2-noresults__title">{t('v2search.errorTitle')}</h2>
            <p className="v2-hint" role="alert">
              {found.message}
            </p>
            <button type="button" className="v2-btn v2-btn--outline" onClick={() => setNow((n) => n + 1)}>
              {t('common.retry')}
            </button>
          </div>
        )}
        {found.kind === 'done' && (
          <>
            {found.source === 'device' && <NoteV2 tone="info">{t('v2search.offline')}</NoteV2>}
            {hits.length === 0 ? (
              <div className="v2-noresults">
                <h2 className="v2-noresults__title">{t('v2search.none', { q: found.query })}</h2>
                <p className="v2-hint">{t('v2search.noneHint')}</p>
              </div>
            ) : (
              <>
                <h2 className="v2-kicker v2-search__count">{counts.found(hits.length)}</h2>
                <ul className="v2-results">
                  {hits.map((hit) => (
                    <ResultV2 key={hit.item.id} hit={hit} words={words} onCopy={setCopying} />
                  ))}
                </ul>
                {found.more && <p className="v2-hint v2-hint--start">{t('v2search.more', { n: SEARCH_LIMIT })}</p>}
              </>
            )}
          </>
        )}
      </div>

      <CopySheetV2
        hit={copying}
        lists={lists}
        userId={userId}
        onClose={() => setCopying(null)}
        onDone={(done) => {
          setCopying(null);
          setCopied(done);
        }}
      />
    </main>
  );
}

/** Текст зі збігами в `<mark>` — шматками, без `dangerouslySetInnerHTML`. */
function Marked({ text, words }: { text: string; words: string[] }) {
  return (
    <>
      {markRanges(text, words).map((s, i) =>
        s.hit ? (
          <mark key={i} className="v2-mark">
            {s.text}
          </mark>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

function ResultV2({ hit, words, onCopy }: { hit: SearchHit; words: string[]; onCopy: (hit: SearchHit) => void }) {
  const { t } = useI18n();
  const status = useStatusLabel();
  const { item, list, match } = hit;
  const shop = shopOf(item);
  const variants = item.variants.map((v) => `${v.label}: ${v.value}`).join(' · ');
  const note = match.fields.has('note') ? noteSnippet(item.note, words) : null;
  return (
    <li className="v2-result">
      <Link to={`/lists/${item.list_id}`} state={{ item: item.id }} className="v2-result__main">
        <span className="v2-result__title">
          <Marked text={item.title} words={words} />
        </span>
        <span className="v2-result__list">
          <span className="v2-result__listname">{list?.title ?? t('v2search.unknownList')}</span>
          {list?.is_archived && (
            <span className="v2-tag" data-tone="neutral">
              {t('v2app.lists.archive')}
            </span>
          )}
          {item.status !== 'active' && (
            <span className="v2-tag" data-tone="neutral">
              {status(item.status)}
            </span>
          )}
        </span>
        {(shop || variants) && (
          <span className="v2-result__meta">
            {shop && <Marked text={shop} words={words} />}
            {shop && variants && ' · '}
            {variants && <Marked text={variants} words={words} />}
          </span>
        )}
        {note && (
          <span className="v2-result__note">
            <Marked text={note} words={words} />
          </span>
        )}
      </Link>
      <button
        type="button"
        className="v2-btn v2-btn--ghost v2-btn--small v2-result__copy"
        aria-label={t('v2search.copyAria', { title: item.title })}
        onClick={() => onCopy(hit)}
      >
        <Copy size={18} strokeWidth={STROKE} aria-hidden="true" />
        {t('v2search.copy')}
      </button>
    </li>
  );
}

/**
 * «Скопіювати в список…»: копія — нова позиція з тим самим, що людина хоче
 * (`copyInput`, як у «Ще хочу»), без статусу, без позначок гостей і без
 * участі в посиланнях: у набір посилання позиція потрапляє лише вручну.
 * Без мережі копія лягає в чергу змін і піде, щойно мережа повернеться.
 */
function CopySheetV2({
  hit,
  lists,
  userId,
  onClose,
  onDone,
}: {
  hit: SearchHit | null;
  lists: List[];
  userId: string;
  onClose: () => void;
  onDone: (done: Copied) => void;
}) {
  const { t } = useI18n();
  const titleId = useId();
  const [target, setTarget] = useState<string>('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const targets = useMemo(() => (hit ? copyTargets(lists, hit.item.list_id) : []), [hit, lists]);

  useEffect(() => {
    if (!hit) return;
    setTarget('');
    setSubmitted(false);
    setBusy(false);
    setServer(null);
  }, [hit]);

  async function save() {
    if (busy || !hit) return;
    setSubmitted(true);
    const to = targets.find((l) => l.id === target);
    if (!to) return;
    setBusy(true);
    setServer(null);
    const [input] = ownCurrency([copyInput(hit.item, undefined, hit.list?.currency)], to.currency);
    const id = newId();
    try {
      const result = await run(userId, { kind: 'create', listId: to.id, id, input: input! });
      onDone({ listId: to.id, title: to.title, itemId: id, queued: result === 'queued' });
    } catch (e) {
      setServer(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SheetV2 open={hit !== null} onClose={onClose} labelledBy={titleId} className="v2-sheet--full">
      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Bar titleId={titleId} title={t('v2search.copyTitle')} onClose={onClose} />
        <div className="v2-itemsheet__body">
          {server && <NoteV2 tone="error">{server}</NoteV2>}
          {hit && <p className="v2-pick__name">{hit.item.title}</p>}
          <p className="v2-hint v2-hint--start">{t('v2search.copyBody')}</p>
          {targets.length === 0 ? (
            <p className="v2-hint v2-hint--start">{t('v2search.copyNone')}</p>
          ) : (
            <>
              <fieldset className="v2-pick">
                <legend className="v2-field__label">{t('v2search.copyWhere')}</legend>
                <ul className="v2-pick__list">
                  {targets.map((l) => (
                    <li key={l.id}>
                      <label className="v2-pick__row" data-on={target === l.id || undefined}>
                        <input
                          type="radio"
                          name="copy-target"
                          checked={target === l.id}
                          onChange={() => setTarget(l.id)}
                        />
                        <span className="v2-pick__text">
                          <span className="v2-pick__name">{l.title}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </fieldset>
              {submitted && !target && (
                <p className="v2-field__error" role="alert">
                  {t('v2search.copyPick')}
                </p>
              )}
              <SubmitV2 busy={busy} label={t('v2search.copySubmit')} busyLabel={t('v2search.copying')} />
            </>
          )}
        </div>
      </form>
    </SheetV2>
  );
}
