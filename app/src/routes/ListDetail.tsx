import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { fetchList, updateList } from '../lib/db';
import type { ItemInput, ListInput } from '../lib/db';
import { useDebounced, useItems } from '../lib/useItems';
import { useI18n } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { errorText, isNetworkError } from '../lib/errors';
import { money } from '../lib/format';
import { DEFAULT_QUERY, STATUSES } from '../lib/types';
import type { Item, ItemQuery, ItemStatus, List } from '../lib/types';
import { Filters, isFiltered } from '../components/Filters';
import { ItemCard } from '../components/ItemCard';
import { ItemDialog } from '../components/ItemDialog';
import { ListDialog } from '../components/ListDialog';
import { ShareDialog } from '../components/ShareDialog';
import { EventSummary } from '../components/EventSummary';
import { ExportDialog } from '../components/ExportDialog';
import { useStale } from '../components/Banners';
import { ConfirmDialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { UndoToast, useUndo } from '../components/UndoToast';
import { newId, run } from '../lib/outbox';
import type { Op } from '../lib/outbox';
import { listKey, readSnapshot, saveSnapshot } from '../lib/cache';
import { Note } from '../components/ui';

export default function ListDetail() {
  const { id = '' } = useParams();
  const { t, locale } = useI18n();
  const { session } = useAuth();

  const [list, setList] = useState<List | null>(null);
  const [listError, setListError] = useState<string | null>(null);
  const [draft, setDraft] = useState<ItemQuery>(DEFAULT_QUERY);
  const [itemDialog, setItemDialog] = useState<{ open: boolean; item: Item | null }>({
    open: false,
    item: null,
  });
  const [listDialog, setListDialog] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [shareDialog, setShareDialog] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulkError, setBulkError] = useState<string | null>(null);
  // Після натискання «Підбити підсумки» фільтр перемикається на актуальні,
  // а вибір треба поставити вже на перезавантажену вибірку.
  const [selectActiveOnLoad, setSelectActiveOnLoad] = useState(false);
  const [exportDialog, setExportDialog] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const undoDelete = useUndo();
  const [confirmBulk, setConfirmBulk] = useState(false);

  // Пошук відкладається, решта фільтрів застосовується одразу.
  const search = useDebounced(draft.search, 300);
  const query = useMemo<ItemQuery>(() => ({ ...draft, search }), [draft, search]);

  const userId = session?.user.id;
  const { items, totals, loading, loadingMore, done, error, staleAt, reload, loadMore, applyLocal } =
    useItems(id, query, userId);

  /**
   * Одна дорога для всіх змін позицій (етап 6.5).
   *
   * Дійшло до сервера — перечитуємо дані; лягло в чергу — показуємо зміну самі:
   * перечитувати нема звідки, а знімок у кеші черга вже підправила.
   */
  async function change(op: Op) {
    if ((await run(userId ?? '', op)) === 'queued') applyLocal(op);
    else await reload();
  }

  useEffect(() => {
    let alive = true;
    fetchList(id)
      .then((fresh) => {
        if (!alive) return;
        setList(fresh);
        setListError(null);
        if (fresh && userId) void saveSnapshot(listKey(id), userId, fresh);
      })
      .catch(async (e: unknown) => {
        // Назва й валюта списку теж мають пережити відсутність мережі —
        // інакше офлайн сторінка була б без заголовка й із цінами не в тій валюті.
        const snapshot = isNetworkError(e) && userId ? await readSnapshot<List>(listKey(id), userId) : null;
        if (!alive) return;
        if (snapshot) setList(snapshot.data);
        else setListError(errorText(e, t));
      });
    return () => {
      alive = false;
    };
  }, [id, userId]);

  // Нескінченний скрол: маячок унизу сітки.
  const sentinel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = sentinel.current;
    if (!el || done) return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMore();
      },
      { rootMargin: '400px' },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [loadMore, done]);

  const patch = useCallback((p: Partial<ItemQuery>) => setDraft((q) => ({ ...q, ...p })), []);
  const resetFilters = useCallback(() => setDraft(DEFAULT_QUERY), []);

  // Банер про збережену копію живе в оболонці — на екрані завжди один банер.
  useStale(staleAt ? new Date(staleAt) : null);

  /** Підбити підсумки: показати лише актуальні позиції й вибрати їх усі. */
  function startSummary() {
    patch({ statuses: ['active'], search: '' });
    setSelecting(true);
    setSelectActiveOnLoad(true);
  }

  function toggleSelect(item: Item) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(item.id)) next.delete(item.id);
      else next.add(item.id);
      return next;
    });
  }

  function exitSelection() {
    setSelecting(false);
    setSelected(new Set());
    setBulkError(null);
  }

  /*
   * Вибір — лише серед показаних позицій. Коли пошук чи фільтр ховає вибрану
   * позицію, вона випадає з вибору: масова дія не має зачепити те, чого людина
   * зараз не бачить.
   */
  useEffect(() => {
    setSelected((prev) => {
      const visible = new Set(items.map((i) => i.id));
      const next = new Set([...prev].filter((id) => visible.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [items]);

  useEffect(() => {
    if (!selecting) return;
    const onKey = (e: KeyboardEvent) => {
      // Діалог теж слухає Escape; поки він відкритий, вибір не чіпаємо.
      if (e.key === 'Escape' && !document.querySelector('dialog[open]')) exitSelection();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selecting]);

  useEffect(() => {
    if (!selectActiveOnLoad || loading) return;
    setSelected(new Set(items.filter((i) => i.status === 'active').map((i) => i.id)));
    setSelectActiveOnLoad(false);
  }, [selectActiveOnLoad, loading, items]);

  const selectedItems = items.filter((i) => selected.has(i.id));
  /** Куплене й подароване гостям не показується, тож у посилання йде лише актуальне. */
  const selectedActiveIds = selectedItems.filter((i) => i.status === 'active').map((i) => i.id);

  async function bulk(op: Op) {
    if (bulkBusy) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      await change(op);
      exitSelection();
    } catch (e) {
      setBulkError(errorText(e, t));
    } finally {
      setBulkBusy(false);
    }
  }

  function bulkDelete() {
    setConfirmBulk(true);
  }

  function bulkStatus(status: ItemStatus) {
    void bulk({ kind: 'status', listId: id, ids: [...selected], status });
  }

  async function saveItem(input: ItemInput) {
    await change(
      itemDialog.item
        ? { kind: 'update', listId: id, id: itemDialog.item.id, input }
        : { kind: 'create', listId: id, id: newId(), input },
    );
  }

  /**
   * Видалення однієї позиції — зворотна дія, тож вона йде через тост
   * «Скасувати», а не через діалог. Позиція зникає з екрана одразу, запит
   * летить через сім секунд; поки відлік іде, скасування миттєве й не
   * залежить від мережі.
   */
  function removeItem(item: Item) {
    applyLocal({ kind: 'delete', listId: id, ids: [item.id] });
    undoDelete.schedule({
      label: t('undo.itemDeleted'),
      commit: () => void change({ kind: 'delete', listId: id, ids: [item.id] }),
      revert: () => void reload(),
    });
  }

  async function setStatus(item: Item, status: ItemStatus) {
    if (status === item.status) return;
    await change({ kind: 'status', listId: id, ids: [item.id], status });
  }

  async function saveList(input: ListInput) {
    await updateList(id, input);
    setList(await fetchList(id));
  }

  const currency = list?.currency ?? 'PLN';

  const filtered = isFiltered(query);
  const statusNames = query.statuses.map((x) => t(`item.status.${x}`)).join(', ');

  return (
    <div className="page">
      {selecting ? (
        <header className="select-head">
          <button
            type="button"
            className="btn btn--icon select-head__btn"
            aria-label={t('select.exit')}
            onClick={exitSelection}
          >
            <Icon name="x" size={18} />
          </button>
          <div className="select-head__text">
            <strong>{t('select.selected', { n: selected.size })}</strong>
            <span className="small">
              {t('select.activeAmong', { n: selectedActiveIds.length })}
            </span>
          </div>
          <button
            type="button"
            className="btn select-head__btn"
            disabled={bulkBusy}
            onClick={() => setSelected(new Set(items.map((i) => i.id)))}
          >
            {t('select.selectAll')}
          </button>
        </header>
      ) : (
      <header className="list-head">
        <Link className="btn btn--icon btn--secondary" to="/lists" aria-label={t('lists.title')}>
          <Icon name="chevronDown" size={18} />
        </Link>
        <div className="list-head__text">
          <h1>{list?.title ?? '…'}</h1>
          {list?.description && <p className="muted small">{list.description}</p>}
        </div>
        <div className="page__actions">
          <button
            type="button"
            className="btn btn--secondary btn--compact"
            onClick={() => setListDialog(true)}
            disabled={!list}
          >
            {t('lists.edit')}
          </button>
          <button
            type="button"
            className="btn btn--secondary btn--compact"
            onClick={() => setExportDialog(true)}
            disabled={!list || items.length === 0}
          >
            {t('transfer.export.open')}
          </button>
          <button
            type="button"
            className="btn btn--secondary btn--compact"
            onClick={() => setSelecting(true)}
            disabled={items.length === 0}
          >
            {t('select.start')}
          </button>
        </div>
      </header>
      )}

      {listError && <Note tone="error">{listError}</Note>}

      {totals && (
        <p className="summary">
          <strong className="summary__sum">{money(totals.active_price, currency, locale)}</strong>
          <span className="small muted">
            {t('totals.active', { n: totals.active_count })}
            {totals.items_no_price > 0 && ` · ${t('totals.noPrice', { n: totals.items_no_price })}`}
            {totals.gifted_count > 0 && ` · ${t('totals.gifted', { n: totals.gifted_count })}`}
          </span>
        </p>
      )}

      <EventSummary list={list} totals={totals} onStart={startSummary} />

      <Filters
        query={draft}
        onChange={patch}
        onReset={resetFilters}
        open={filtersOpen}
        onOpen={() => setFiltersOpen(true)}
        onClose={() => setFiltersOpen(false)}
      />

      {/* Постійний рядок під фільтрами: скільки видно з усього списку.
          Без фільтрів він просто називає розмір списку. */}
      {totals && !loading && (
        <div className="counter">
          <span className="small muted" aria-live="polite">
            {filtered
              ? t('item.counter', { n: items.length, m: totals.items_count })
              : t('item.countAll', { n: totals.items_count })}
          </span>
          {filtered && (
            <button type="button" className="btn btn--ghost btn--compact" onClick={resetFilters}>
              {t('toolbar.reset')}
            </button>
          )}
        </div>
      )}

      {loading ? (
        <main aria-busy="true">
          <span className="visually-hidden">{t('item.loading')}</span>
          <ul className="item-list">
            {[0, 1, 2].map((i) => (
              <li className="item sk" key={i}>
                <span className="sk__thumb" />
                <span className="sk__stack">
                  <span className="sk__line" style={{ width: '70%' }} />
                  <span className="sk__line" style={{ width: '40%' }} />
                  <span className="sk__line sk__line--row" style={{ width: '60%' }} />
                </span>
              </li>
            ))}
          </ul>
        </main>
      ) : error ? (
        /* Помилка позицій окремо від помилки заголовка: якщо впали лише
           позиції, назва й опис списку лишаються на місці. */
        <main className="empty">
          <span className="empty__icon empty__icon--danger">
            <Icon name="alert" size={36} />
          </span>
          <h2>{t('item.errorTitle')}</h2>
          <p className="lede">{t('item.errorBody')}</p>
          <button type="button" className="btn btn--primary" onClick={() => void reload()}>
            {t('common.retry')}
          </button>
        </main>
      ) : items.length === 0 && filtered ? (
        /* Фільтр нічого не знайшов — це не те саме, що порожній список:
           позиції є, їх просто ховають. Тому чипи активних фільтрів. */
        <main className="empty">
          <span className="empty__icon empty__icon--accent">
            <Icon name="search" size={36} />
          </span>
          <h2>{t('item.noResultsTitle')}</h2>
          <p className="lede">{t('item.noResultsBody')}</p>
          <div className="chips">
            {query.search.trim() && (
              <span className="chip">
                {t('item.chip.search', { q: query.search })}
                <button
                  type="button"
                  className="chip__x"
                  aria-label={t('item.chip.clearSearch')}
                  onClick={() => patch({ search: '' })}
                >
                  <Icon name="x" size={12} />
                </button>
              </span>
            )}
            {(query.priceMin || query.priceMax) && (
              <span className="chip">
                {t('item.chip.price', { from: query.priceMin || '0', to: query.priceMax || '∞' })}
                <button
                  type="button"
                  className="chip__x"
                  aria-label={t('item.chip.clearPrice')}
                  onClick={() => patch({ priceMin: '', priceMax: '' })}
                >
                  <Icon name="x" size={12} />
                </button>
              </span>
            )}
            {query.statuses.length !== DEFAULT_QUERY.statuses.length && (
              <span className="chip">
                {t('item.chip.status', { list: statusNames })}
                <button
                  type="button"
                  className="chip__x"
                  aria-label={t('item.chip.clearStatus')}
                  onClick={() => patch({ statuses: DEFAULT_QUERY.statuses })}
                >
                  <Icon name="x" size={12} />
                </button>
              </span>
            )}
          </div>
          <button type="button" className="btn btn--primary" onClick={resetFilters}>
            {t('item.resetFilters')}
          </button>
        </main>
      ) : items.length === 0 ? (
        <main className="empty">
          <h2>{t('item.emptyTitle')}</h2>
          <p className="lede">{t('item.emptyBody')}</p>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setItemDialog({ open: true, item: null })}
          >
            {t('item.add')}
          </button>
        </main>
      ) : (
        <main>
          <h2 className="visually-hidden">{t('item.listLabel')}</h2>
          <ul
            className="item-list"
            data-stale={staleAt ? 'true' : 'false'}
            data-selecting={selecting}
          >
            {items.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                currency={currency}
                onEdit={(i) => setItemDialog({ open: true, item: i })}
                onDelete={(i) => removeItem(i)}
                onSetStatus={(i, s) => void setStatus(i, s)}
                selectable={selecting}
                selected={selected.has(item.id)}
                onToggleSelect={toggleSelect}
              />
            ))}
          </ul>

          <div ref={sentinel} />

          {/* Запасний шлях: скрол може не спрацювати з клавіатури або при reduce-motion. */}
          {!done && (
            <button
              type="button"
              className="btn btn--secondary btn--block"
              disabled={loadingMore}
              onClick={() => void loadMore()}
            >
              {loadingMore && <span className="spinner" />}
              {loadingMore ? `${t('common.loading')}…` : t('item.loadMore')}
            </button>
          )}
          {done && items.length > 0 && <p className="small muted center">{t('item.end')}</p>}
        </main>
      )}

      {/* Плаваюча кнопка: додавання — найчастіша дія на цьому екрані, і на
          телефоні вона має бути під великим пальцем, а не в шапці.
          На порожньому списку її немає: дія вже стоїть у тілі екрана, а
          друга кнопка з тим самим підписом лише плутає — і людину, і
          зчитувач екрана. */}
      {!selecting && !undoDelete.pending && items.length > 0 && (
        <button
          type="button"
          className="fab"
          aria-label={t('item.add')}
          onClick={() => setItemDialog({ open: true, item: null })}
        >
          <Icon name="plus" size={25} />
        </button>
      )}

      {/* Панель вибору притиснута донизу екрана: вибір іде згори вниз,
          а дія має лишатись під рукою на будь-якій довжині списку. */}
      {selecting && (
        <div className="selectbar" role="region" aria-label={t('select.region')}>
          <p className="small muted">{t('select.shareActiveOnly', { n: selectedActiveIds.length })}</p>
          {bulkError && <Note tone="error">{bulkError}</Note>}
          <div className="selectbar__actions">
            {/* Статус застосовується одразу після вибору: дія оборотна, підтвердження зайве.
                Порожній перший пункт потрібен, щоб вибір того самого статусу теж спрацьовував. */}
            <select
              className="selectbar__status"
              aria-label={t('select.statusLabel')}
              value=""
              disabled={bulkBusy || selected.size === 0}
              onChange={(e) => {
                if (e.target.value) bulkStatus(e.target.value as ItemStatus);
              }}
            >
              <option value="" disabled>
                {t('select.statusPlaceholder')}
              </option>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(`item.status.${s}`)}
                </option>
              ))}
            </select>
            <button
              type="button"
              className="btn btn--secondary btn--compact btn--danger"
              disabled={bulkBusy || selected.size === 0}
              onClick={bulkDelete}
            >
              {t('common.delete')}
            </button>
            <button
              type="button"
              className="btn btn--primary btn--compact"
              disabled={bulkBusy || selectedActiveIds.length === 0}
              onClick={() => setShareDialog(true)}
            >
              {t('share.create')}
            </button>
          </div>
        </div>
      )}

      <ShareDialog
        open={shareDialog}
        listId={id}
        itemIds={selectedActiveIds}
        defaultTitle={list?.title ?? ''}
        onClose={() => {
          setShareDialog(false);
          exitSelection();
        }}
        onCreated={() => undefined}
      />

      <ItemDialog
        open={itemDialog.open}
        item={itemDialog.item}
        onClose={() => setItemDialog({ open: false, item: null })}
        onSave={saveItem}
      />
      <ListDialog open={listDialog} list={list} onClose={() => setListDialog(false)} onSave={saveList} />
      <ExportDialog
        open={exportDialog}
        list={list}
        total={totals?.items_count}
        onClose={() => setExportDialog(false)}
      />

      <UndoToast pending={undoDelete.pending} onUndo={undoDelete.undo} />

      <ConfirmDialog
        open={confirmBulk}
        title={t('select.confirmTitle', { n: selected.size })}
        body={t('select.confirmBody')}
        confirmLabel={t('common.delete')}
        busy={bulkBusy}
        onConfirm={() => {
          setConfirmBulk(false);
          void bulk({ kind: 'delete', listId: id, ids: [...selected] });
        }}
        onClose={() => setConfirmBulk(false)}
      />
    </div>
  );
}
