import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  AlertCircle,
  ArrowDownUp,
  ChevronLeft,
  FolderPlus,
  ListPlus,
  MoreHorizontal,
  Plus,
  Search,
  SearchX,
  X,
} from 'lucide-react';
import { fetchList } from '../../../lib/db';
import { useItems } from '../../../lib/useItems';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';
import { errorText, isNetworkError } from '../../../lib/errors';
import { formatDateTime, formatDay, moneyShort, num } from '../../../lib/format';
import { listKey, readSnapshot, saveSnapshot, sectionsKey } from '../../../lib/cache';
import { newId, run } from '../../../lib/outbox';
import type { Op } from '../../../lib/outbox';
import { useUndo } from '../../../lib/undo';
import { designSwitchHref } from '../../../lib/authFlow';
import { createSection, deleteSection, fetchSections, renameSection } from '../../../lib/sections';
import type { Section } from '../../../lib/sections';
import {
  ITEM_QTY_MAX,
  TOOLS_FROM,
  isViewSort,
  matchesView,
  sortItems,
  totalsOf,
  viewGroups,
} from '../../../lib/itemsView';
import type { ViewFilter, ViewGroup, ViewSort } from '../../../lib/itemsView';
import { DEFAULT_QUERY } from '../../../lib/types';
import type { Item, ItemInput, ItemStatus, List } from '../../../lib/types';
import { NoteV2 } from './AuthPartsV2';
import { SheetV2, useCounts } from './CommonV2';
import { ItemSheetV2 } from './ItemSheetV2';
import {
  ConfirmSheetV2,
  ItemCardV2,
  ItemMenuV2,
  ItemSkeletonsV2,
  SectionSheetV2,
  SortSheetV2,
  UndoToastV2,
  usePriorityLabel,
  useSortLabel,
} from './ListPartsV2';

const STROKE = 2.75;
/** Тост «Відмінити» живе шість секунд (C4). */
const UNDO_MS = 6000;
/** Нова картка підсвічена контуром дві секунди (C4). */
const HIGHLIGHT_MS = 2000;

/** Вибране сортування пам'ятається для кожного списку окремо (O2). Id списку — не таємниця. */
const sortKey = (listId: string) => `wl.v2.sort.${listId}`;

function readSort(listId: string): ViewSort {
  try {
    const v = localStorage.getItem(sortKey(listId));
    return isViewSort(v) ? v : 'manual';
  } catch {
    return 'manual';
  }
}

function writeSort(listId: string, sort: ViewSort) {
  try {
    if (sort === 'manual') localStorage.removeItem(sortKey(listId));
    else localStorage.setItem(sortKey(listId), sort);
  } catch {
    /* без сховища вибір просто не переживе вкладку */
  }
}

function without<T>(set: Set<T>, value: T): Set<T> {
  if (!set.has(value)) return set;
  const next = new Set(set);
  next.delete(value);
  return next;
}

/** Неіснуючий чи чужий список і адреса з хибним id — для людини одне й те саме. */
function isBadId(e: unknown): boolean {
  return Boolean(e && typeof e === 'object' && 'code' in e && (e as { code: unknown }).code === '22P02');
}

type ListState = 'loading' | 'ready' | 'missing';

/**
 * Сторінка списку v2 (потоки C, F, O, V; ROADMAP «Дизайн v2», крок 3б-1).
 *
 * Згори вниз: назва й кількість → сума актуального → [від 20 позицій: пошук,
 * сортування, «Усі / Без ціни»] → позиції → «Куплене й подароване».
 *
 * Список вантажиться цілим (`useItems(…, 'all')`), а сортування, групи й
 * підсумок рахуються на клієнті (`lib/itemsView.ts`): так зміна, що лягла в
 * офлайн-чергу, одразу видна і в сумі, і в правильній групі.
 *
 * Жодного слова про позначки гостей — ні на картці, ні в підсумку, ні
 * фільтра «вільні» (ADR-040). Куплене й подароване — статуси власника.
 *
 * Видалення позиції — тостом «Відмінити», без діалогу (F1). Запит іде, коли
 * відлік скінчився: так відкат миттєвий і не знімає позначок гостей, які
 * зникли б разом із позицією (ADR-044).
 */
export default function ListV2() {
  const { id = '' } = useParams();
  const { t, locale } = useI18n();
  const { session } = useAuth();
  const counts = useCounts();
  const sortLabel = useSortLabel();
  const priorityLabel = usePriorityLabel();
  const userId = session?.user.id ?? '';

  const [list, setList] = useState<List | null>(null);
  const [listState, setListState] = useState<ListState>('loading');
  const [listError, setListError] = useState<string | null>(null);
  const [sections, setSections] = useState<Section[]>([]);

  const { items, loading, error, staleAt, reload, refresh, applyLocal } = useItems(
    id,
    DEFAULT_QUERY,
    userId || undefined,
    'all',
  );

  /** Позиції, чиє видалення ще відлічує тост: на екрані їх уже немає. */
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  /** Видалення, яке сервер відхилив: позиція повертається з поясненням у рядку. */
  const [failed, setFailed] = useState<Map<string, string>>(new Map());
  const [highlight, setHighlight] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  const [sort, setSort] = useState<ViewSort>(() => readSort(id));
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<ViewFilter>('all');

  const [sheet, setSheet] = useState<{ open: boolean; item: Item | null; presetTitle?: string }>({
    open: false,
    item: null,
  });
  const [menuItem, setMenuItem] = useState<Item | null>(null);
  const [sortOpen, setSortOpen] = useState(false);
  const [listMenu, setListMenu] = useState(false);
  const [sectionSheet, setSectionSheet] = useState<{ open: boolean; section: Section | null }>({
    open: false,
    section: null,
  });
  const [sectionMenu, setSectionMenu] = useState<Section | null>(null);
  const [sectionToDelete, setSectionToDelete] = useState<Section | null>(null);
  const [deletingSection, setDeletingSection] = useState(false);

  const undo = useUndo(UNDO_MS);

  useEffect(() => {
    setSort(readSort(id));
    setSearch('');
    setFilter('all');
    setHidden(new Set());
    setFailed(new Map());
  }, [id]);

  // Список і розділи — окремо від позицій: якщо впали лише позиції, шапка
  // з назвою лишається на місці (README, «Стани»).
  useEffect(() => {
    let alive = true;
    setListState('loading');
    setListError(null);
    fetchList(id)
      .then((fresh) => {
        if (!alive) return;
        setList(fresh);
        setListState(fresh ? 'ready' : 'missing');
        if (fresh && userId) void saveSnapshot(listKey(id), userId, fresh);
      })
      .catch(async (e: unknown) => {
        if (isBadId(e)) {
          if (alive) setListState('missing');
          return;
        }
        // Назва й валюта теж мають пережити відсутність мережі.
        const snapshot = isNetworkError(e) && userId ? await readSnapshot<List>(listKey(id), userId) : null;
        if (!alive) return;
        setListState('ready');
        if (snapshot) setList(snapshot.data);
        else setListError(errorText(e, t));
      });
    fetchSections(id)
      .then((fresh) => {
        if (!alive) return;
        setSections(fresh);
        if (userId) void saveSnapshot(sectionsKey(id), userId, fresh);
      })
      .catch(async (e: unknown) => {
        const snapshot =
          isNetworkError(e) && userId ? await readSnapshot<Section[]>(sectionsKey(id), userId) : null;
        if (alive) setSections(snapshot?.data ?? []);
      });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, userId]);

  // Нова картка: докрутити до неї й підсвітити на дві секунди.
  useEffect(() => {
    if (!highlight) return;
    document.getElementById(`v2-item-${highlight}`)?.scrollIntoView({ block: 'nearest' });
    const timer = window.setTimeout(() => setHighlight(null), HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [highlight]);

  /* ── Що на екрані ── */

  const live = useMemo(() => items.filter((i) => !hidden.has(i.id)), [items, hidden]);
  const totals = useMemo(() => totalsOf(live), [live]);
  const noPriceCount = totals.items_no_price;

  // Менший список лишається чистим: без інструментів — і без їхньої дії.
  const tools = live.length >= TOOLS_FROM;
  const viewSort: ViewSort = tools ? sort : 'manual';
  const viewSearch = tools ? search : '';
  const viewFilter: ViewFilter = tools && noPriceCount > 0 ? filter : 'all';
  const filtering = viewSearch.trim() !== '' || viewFilter !== 'all';

  const shown = useMemo(
    () => live.filter((i) => matchesView(i, viewSearch, viewFilter)),
    [live, viewSearch, viewFilter],
  );
  const groups = useMemo(
    () =>
      viewGroups(
        shown.filter((i) => i.status === 'active'),
        viewSort,
        sections,
        { keepEmpty: !filtering },
      ),
    [shown, viewSort, sections, filtering],
  );
  const done = useMemo(
    () => sortItems(shown.filter((i) => i.status !== 'active'), viewSort === 'priority' ? 'manual' : viewSort),
    [shown, viewSort],
  );
  const activeShown = groups.reduce((n, g) => n + g.items.length, 0);

  const currency = list?.currency ?? 'PLN';

  // Позицій без ціни не лишилось — і фільтра «Без ціни» теж: інакше він
  // мовчки ввімкнувся б знову з першою такою позицією.
  useEffect(() => {
    if (noPriceCount === 0) setFilter('all');
  }, [noPriceCount]);

  /* ── Зміни позицій ── */

  /**
   * Створення й зміна: спершу запит (відмову сервера показує форма), потім
   * екран. Лягло в чергу — показуємо самі; дійшло — ще й тихо звіряємо з базою.
   */
  async function send(op: Op) {
    const result = await run(userId, op);
    applyLocal(op);
    if (result === 'sent') void refresh();
  }

  async function saveItem(input: ItemInput, itemId: string | null) {
    setActionError(null);
    if (itemId) {
      await send({ kind: 'update', listId: id, id: itemId, input });
      return;
    }
    const created = newId();
    await send({ kind: 'create', listId: id, id: created, input });
    setHighlight(created);
    // Щойно додана позиція ще не в жодному посиланні, тож відкат — звичайне
    // видалення, без відліку.
    undo.schedule({
      label: t('v2list.toast.added', { title: input.title }),
      commit: () => undefined,
      revert: () => void removeNow(created),
    });
  }

  async function removeNow(itemId: string) {
    const op: Op = { kind: 'delete', listId: id, ids: [itemId] };
    applyLocal(op);
    try {
      if ((await run(userId, op)) === 'sent') void refresh();
    } catch (e) {
      setActionError(t('v2list.actionFailed', { error: errorText(e, t) }));
      void refresh();
    }
  }

  /** Видалення з «Відмінити» (F1–F2): позиція зникає одразу, запит — після відліку. */
  function removeItem(item: Item) {
    setMenuItem(null);
    setActionError(null);
    setFailed((m) => {
      if (!m.has(item.id)) return m;
      const next = new Map(m);
      next.delete(item.id);
      return next;
    });
    setHidden((s) => new Set(s).add(item.id));
    undo.schedule({
      label: t('v2list.toast.deleted', { title: item.title }),
      commit: () => void commitDelete(item),
      revert: () => setHidden((s) => without(s, item.id)),
    });
  }

  async function commitDelete(item: Item) {
    const op: Op = { kind: 'delete', listId: id, ids: [item.id] };
    try {
      const result = await run(userId, op);
      applyLocal(op);
      setHidden((s) => without(s, item.id));
      if (result === 'sent') void refresh();
    } catch (e) {
      // Позиція повертається на своє місце з поясненням у рядку (F, гілка).
      setHidden((s) => without(s, item.id));
      setFailed((m) => new Map(m).set(item.id, errorText(e, t)));
    }
  }

  /** Статус — оборотна дія того самого меню, тож без підтвердження й без тосту. */
  async function setStatus(item: Item, status: ItemStatus) {
    setMenuItem(null);
    if (status === item.status) return;
    const op: Op = { kind: 'status', listId: id, ids: [item.id], status };
    setActionError(null);
    applyLocal(op);
    try {
      if ((await run(userId, op)) === 'sent') void refresh();
    } catch (e) {
      setActionError(t('v2list.actionFailed', { error: errorText(e, t) }));
      void refresh();
    }
  }

  /** «Ця річ уже в списку» → «Кількість: 2» (R2). */
  async function bumpQuantity(existing: Item) {
    await send({
      kind: 'update',
      listId: id,
      id: existing.id,
      input: { title: existing.title, quantity: Math.min(existing.quantity + 1, ITEM_QTY_MAX) },
    });
    setHighlight(existing.id);
  }

  const openNew = useCallback((presetTitle?: string) => setSheet({ open: true, item: null, presetTitle }), []);
  const openEdit = useCallback((item: Item) => {
    setMenuItem(null);
    setSheet({ open: true, item });
  }, []);

  /* ── Розділи (ADR-036) ── */

  async function saveSection(title: string) {
    const editing = sectionSheet.section;
    if (editing) {
      await renameSection(editing.id, title);
      setSections((prev) => prev.map((s) => (s.id === editing.id ? { ...s, title } : s)));
      return;
    }
    const next = Math.max(0, ...sections.map((s) => s.position)) + 1;
    const created = await createSection(id, title, next);
    setSections((prev) => [...prev, created]);
    // Розділи видно в ручному порядку — туди й повертаємо, щоб новий розділ не загубився.
    changeSort('manual');
  }

  async function confirmDeleteSection() {
    const target = sectionToDelete;
    if (!target || deletingSection) return;
    setDeletingSection(true);
    try {
      await deleteSection(target.id);
      setSections((prev) => prev.filter((s) => s.id !== target.id));
      void refresh();
    } catch (e) {
      setActionError(t('v2list.actionFailed', { error: errorText(e, t) }));
    } finally {
      setDeletingSection(false);
      setSectionToDelete(null);
    }
  }

  function changeSort(next: ViewSort) {
    setSort(next);
    writeSort(id, next);
  }

  /* ── Розмітка ── */

  if (listState === 'missing') {
    return (
      <main className="v2-page v2-page--list">
        <div className="v2-empty">
          <span className="v2-circle v2-circle--warm" aria-hidden="true">
            <SearchX size={32} strokeWidth={STROKE} />
          </span>
          <h1 className="v2-empty__title">{t('v2list.notFound.title')}</h1>
          <p className="v2-lede">{t('v2list.notFound.body')}</p>
          <Link to="/lists" className="v2-btn v2-btn--primary">
            {t('v2list.notFound.cta')}
          </Link>
        </div>
      </main>
    );
  }

  const ready = !loading && !error;
  const activePriced = live.some((i) => i.status === 'active' && num(i.price) !== null);
  const sumParts = [
    totals.active_count > 0 ? counts.inActive(totals.active_count) : null,
    totals.items_no_price > 0 ? t('v2list.sum.noPrice', { n: totals.items_no_price }) : null,
    totals.purchased_count > 0 ? t('v2list.sum.purchased', { n: totals.purchased_count }) : null,
    totals.gifted_count > 0 ? t('v2list.sum.gifted', { n: totals.gifted_count }) : null,
  ].filter(Boolean);
  const eventDay = formatDay(list?.event_date ?? null, locale);

  function groupHeading(g: ViewGroup, index: number) {
    const headingId = `v2-group-${index}`;
    if (g.kind === 'all') return null;
    const name =
      g.kind === 'priority' ? priorityLabel(g.priority) : g.kind === 'section' ? g.section.title : t('v2list.group.other');
    return (
      <div className="v2-group__head">
        <h2 className="v2-kicker v2-group__title" id={headingId}>
          {name} · {g.items.length}
        </h2>
        {g.kind === 'section' && (
          <button
            type="button"
            className="v2-iconbtn v2-group__more"
            aria-label={t('v2list.group.sectionMenu', { title: g.section.title })}
            onClick={() => setSectionMenu(g.section)}
          >
            <MoreHorizontal size={20} strokeWidth={STROKE} aria-hidden="true" />
          </button>
        )}
      </div>
    );
  }

  function card(item: Item) {
    return (
      <ItemCardV2
        key={item.id}
        item={item}
        currency={currency}
        showPriority={viewSort !== 'priority'}
        highlight={highlight === item.id}
        failed={failed.get(item.id) ?? null}
        onOpen={openEdit}
        onMenu={setMenuItem}
        onRetry={removeItem}
      />
    );
  }

  return (
    <main className="v2-page v2-page--list" aria-busy={loading || undefined}>
      <div className="v2-listhead">
        <Link to="/lists" className="v2-iconbtn v2-listhead__back" aria-label={t('v2list.back')}>
          <ChevronLeft size={24} strokeWidth={STROKE} aria-hidden="true" />
        </Link>
        <div className="v2-listhead__text">
          <h1 className="v2-page__title v2-listhead__title">
            {list ? (
              list.title
            ) : listError ? (
              t('v2list.untitled')
            ) : (
              <>
                <span className="v2-sr">{t('common.loading')}</span>
                <span className="v2-skline" aria-hidden="true" />
              </>
            )}
          </h1>
          {ready && (
            <p className="v2-listhead__meta">{[counts.items(live.length), eventDay].filter(Boolean).join(' · ')}</p>
          )}
        </div>
        <button
          type="button"
          className="v2-iconbtn"
          aria-label={t('v2list.menu')}
          onClick={() => setListMenu(true)}
          disabled={!list}
        >
          <MoreHorizontal size={24} strokeWidth={STROKE} aria-hidden="true" />
        </button>
      </div>

      {listError && <NoteV2 tone="error">{listError}</NoteV2>}
      {staleAt && (
        <NoteV2 tone="info">{t('v2app.lists.stale', { time: formatDateTime(staleAt, locale) ?? '' })}</NoteV2>
      )}
      {actionError && <NoteV2 tone="error">{actionError}</NoteV2>}

      {ready && live.length > 0 && (
        <p className="v2-sum">
          {activePriced && <strong className="v2-sum__value">{moneyShort(totals.active_price, currency, locale)}</strong>}
          {sumParts.length > 0 && <span className="v2-sum__line">{sumParts.join(' · ')}</span>}
        </p>
      )}

      {ready && tools && (
        <div className="v2-tools">
          <div className="v2-search">
            <Search className="v2-search__icon" size={20} strokeWidth={STROKE} aria-hidden="true" />
            <input
              type="search"
              className="v2-input v2-search__input"
              aria-label={t('v2list.search.label')}
              placeholder={counts.searchIn(live.length)}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            {search && (
              <button
                type="button"
                className="v2-iconbtn v2-search__clear"
                aria-label={t('v2list.search.clear')}
                onClick={() => setSearch('')}
              >
                <X size={20} strokeWidth={STROKE} aria-hidden="true" />
              </button>
            )}
          </div>
          <div className="v2-tools__row">
            <button type="button" className="v2-chip v2-chip--tool" onClick={() => setSortOpen(true)}>
              <ArrowDownUp size={18} strokeWidth={STROKE} aria-hidden="true" />
              <span className="v2-sr">{t('v2list.sort.button')}: </span>
              {sortLabel(sort)}
            </button>
          </div>
          <div className="v2-chips" role="radiogroup" aria-label={t('v2list.filter.label')}>
            <button
              type="button"
              role="radio"
              aria-checked={viewFilter === 'all'}
              className="v2-chip v2-chip--toggle"
              onClick={() => setFilter('all')}
            >
              {t('v2list.filter.all')}
            </button>
            {noPriceCount > 0 && (
              <button
                type="button"
                role="radio"
                aria-checked={viewFilter === 'noPrice'}
                className="v2-chip v2-chip--toggle"
                onClick={() => setFilter('noPrice')}
              >
                {t('v2list.filter.noPrice')} <span className="v2-chip__count">{noPriceCount}</span>
              </button>
            )}
          </div>
          {filtering && (
            <p className="v2-found" aria-live="polite">
              {t('v2list.found', { n: shown.length, m: live.length })}
            </p>
          )}
        </div>
      )}

      {loading ? (
        <ItemSkeletonsV2 label={t('v2list.loading')} />
      ) : error ? (
        <div className="v2-empty">
          <span className="v2-circle v2-circle--warm" aria-hidden="true">
            <AlertCircle size={32} strokeWidth={STROKE} />
          </span>
          <h2 className="v2-empty__title">{t('v2list.errorTitle')}</h2>
          {/* Спершу справжня причина, потім заспокійливий рядок. */}
          <p className="v2-lede" role="alert">
            {error}
          </p>
          <p className="v2-hint">{t('v2list.errorBody')}</p>
          <button type="button" className="v2-btn v2-btn--primary" onClick={() => void reload()}>
            {t('common.retry')}
          </button>
        </div>
      ) : live.length === 0 ? (
        <div className="v2-empty">
          <span className="v2-circle v2-circle--calm" aria-hidden="true">
            <ListPlus size={32} strokeWidth={STROKE} />
          </span>
          <h2 className="v2-empty__title">{t('v2list.empty.title')}</h2>
          <p className="v2-lede">{t('v2list.empty.body')}</p>
          <button type="button" className="v2-btn v2-btn--primary" onClick={() => openNew()}>
            {t('v2list.add')}
          </button>
        </div>
      ) : filtering && shown.length === 0 ? (
        /* Нічого не знайшлось — це не порожній список: позиції є, їх ховає
           пошук чи фільтр. Кажемо, що саме звужує, і даємо два ходи (O, гілка). */
        <div className="v2-noresults" role="status">
          <h2 className="v2-noresults__title">
            {viewSearch.trim() ? t('v2list.noResults.title', { q: viewSearch.trim() }) : t('v2list.noResults.titlePlain')}
          </h2>
          {viewFilter === 'noPrice' && <p className="v2-hint">{t('v2list.noResults.alsoNoPrice')}</p>}
          <button
            type="button"
            className="v2-btn v2-btn--outline v2-btn--block"
            onClick={() => {
              setSearch('');
              setFilter('all');
            }}
          >
            {t('v2list.noResults.reset')}
          </button>
          {viewSearch.trim() && (
            <button type="button" className="v2-btn v2-btn--ghost" onClick={() => openNew(viewSearch.trim())}>
              {t('v2list.noResults.addAsNew')}
            </button>
          )}
        </div>
      ) : (
        <div className="v2-groups" data-stale={staleAt ? 'true' : undefined}>
          {activeShown === 0 && !filtering && <p className="v2-hint v2-hint--start">{t('v2list.allDone')}</p>}
          {groups.map((g, index) =>
            g.kind === 'all' ? (
              g.items.length > 0 && (
                <ul key={g.key} className="v2-items" aria-label={t('v2list.itemsLabel')}>
                  {g.items.map(card)}
                </ul>
              )
            ) : (
              <section key={g.key} className="v2-group" aria-labelledby={`v2-group-${index}`}>
                {groupHeading(g, index)}
                {g.items.length > 0 ? (
                  <ul className="v2-items">{g.items.map(card)}</ul>
                ) : (
                  <p className="v2-hint v2-hint--start">{t('v2list.group.emptySection')}</p>
                )}
              </section>
            ),
          )}
          {done.length > 0 && (
            <details className="v2-done" open={activeShown === 0 || undefined}>
              <summary className="v2-done__summary">
                {t('v2list.group.done')} · {done.length}
              </summary>
              <ul className="v2-items">{done.map(card)}</ul>
            </details>
          )}
        </div>
      )}

      {/* Плаваюча «+» — під великим пальцем. Поки видно тост, її немає: вони
          ділять одне місце, а «Відмінити» важливіше ці шість секунд. */}
      {ready && live.length > 0 && !undo.pending && (
        <button type="button" className="v2-fab v2-fab--float" aria-label={t('v2list.add')} onClick={() => openNew()}>
          <Plus size={26} strokeWidth={STROKE} aria-hidden="true" />
        </button>
      )}

      <UndoToastV2 pending={undo.pending} until={undo.until} onUndo={undo.undo} />

      <ItemSheetV2
        open={sheet.open}
        item={sheet.item}
        presetTitle={sheet.presetTitle}
        items={live}
        sections={sections}
        currency={currency}
        onClose={() => setSheet((s) => ({ ...s, open: false }))}
        onSave={saveItem}
        onOpenExisting={openEdit}
        onBumpQuantity={bumpQuantity}
      />

      <ItemMenuV2
        item={menuItem}
        onClose={() => setMenuItem(null)}
        onEdit={openEdit}
        onStatus={(item, status) => void setStatus(item, status)}
        onDelete={removeItem}
      />

      <SortSheetV2 open={sortOpen} value={sort} onClose={() => setSortOpen(false)} onChange={changeSort} />

      <SheetV2 open={listMenu} onClose={() => setListMenu(false)} labelledBy="v2-list-menu-title">
        <h2 className="v2-sheet__title v2-sheet__title--item" id="v2-list-menu-title">
          {list?.title}
        </h2>
        <div className="v2-menu">
          <button
            type="button"
            className="v2-menu__item"
            onClick={() => {
              setListMenu(false);
              setSectionSheet({ open: true, section: null });
            }}
          >
            <FolderPlus size={20} strokeWidth={STROKE} aria-hidden="true" />
            {t('v2list.menuList.newSection')}
          </button>
        </div>
        {/* Поділитися, оформлення й решта — крок 3б-2; поки дорога до v1 з тим самим списком. */}
        <p className="v2-hint v2-hint--start">
          {t('v2list.menuList.laterBody')}{' '}
          <a href={designSwitchHref(`/lists/${id}`, '', 'v1')} className="v2-link">
            {t('v2list.menuList.inV1')}
          </a>
        </p>
      </SheetV2>

      <SheetV2 open={sectionMenu !== null} onClose={() => setSectionMenu(null)} labelledBy="v2-section-menu-title">
        <h2 className="v2-sheet__title v2-sheet__title--item" id="v2-section-menu-title">
          {sectionMenu?.title}
        </h2>
        <div className="v2-menu">
          <button
            type="button"
            className="v2-menu__item"
            onClick={() => {
              setSectionSheet({ open: true, section: sectionMenu });
              setSectionMenu(null);
            }}
          >
            {t('v2list.section.rename')}
          </button>
          <button
            type="button"
            className="v2-menu__item v2-menu__item--danger"
            onClick={() => {
              setSectionToDelete(sectionMenu);
              setSectionMenu(null);
            }}
          >
            {t('v2list.section.delete')}
          </button>
        </div>
      </SheetV2>

      <SectionSheetV2
        open={sectionSheet.open}
        section={sectionSheet.section}
        onClose={() => setSectionSheet((s) => ({ ...s, open: false }))}
        onSave={saveSection}
      />

      <ConfirmSheetV2
        open={sectionToDelete !== null}
        id="v2-section-delete-title"
        title={t('sections.confirmDeleteTitle', { title: sectionToDelete?.title ?? '' })}
        body={t('sections.confirmDeleteBody')}
        confirmLabel={t('sections.confirmDelete')}
        busyLabel={t('sections.deleting')}
        busy={deletingSection}
        onConfirm={() => void confirmDeleteSection()}
        onClose={() => setSectionToDelete(null)}
      />
    </main>
  );
}
