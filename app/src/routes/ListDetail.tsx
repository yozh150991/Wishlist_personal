import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  createItem,
  deleteItem,
  deleteItems,
  fetchList,
  setItemsStatus,
  updateItem,
  updateList,
} from '../lib/db';
import type { ItemInput, ListInput } from '../lib/db';
import { useDebounced, useItems } from '../lib/useItems';
import { useI18n } from '../lib/i18n';
import { useAuth } from '../lib/auth';
import { errorText, isNetworkError } from '../lib/errors';
import { money } from '../lib/format';
import { DEFAULT_QUERY, STATUSES } from '../lib/types';
import type { Item, ItemQuery, ItemStatus, List } from '../lib/types';
import { Toolbar } from '../components/Toolbar';
import { ItemCard } from '../components/ItemCard';
import { ItemDialog } from '../components/ItemDialog';
import { ListDialog } from '../components/ListDialog';
import { ShareDialog } from '../components/ShareDialog';
import { EventSummary } from '../components/EventSummary';
import { ExportDialog } from '../components/ExportDialog';
import { StaleNotice } from '../components/StaleNotice';
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

  // Пошук відкладається, решта фільтрів застосовується одразу.
  const search = useDebounced(draft.search, 300);
  const query = useMemo<ItemQuery>(() => ({ ...draft, search }), [draft, search]);

  const userId = session?.user.id;
  const { items, totals, loading, loadingMore, done, error, staleAt, reload, loadMore } = useItems(
    id,
    query,
    userId,
  );

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
    if (!selectActiveOnLoad || loading) return;
    setSelected(new Set(items.filter((i) => i.status === 'active').map((i) => i.id)));
    setSelectActiveOnLoad(false);
  }, [selectActiveOnLoad, loading, items]);

  const selectedItems = items.filter((i) => selected.has(i.id));
  /** Куплене й подароване гостям не показується, тож у посилання йде лише актуальне. */
  const selectedActiveIds = selectedItems.filter((i) => i.status === 'active').map((i) => i.id);

  async function bulk(action: () => Promise<void>) {
    if (bulkBusy) return;
    setBulkBusy(true);
    setBulkError(null);
    try {
      await action();
      await reload();
      exitSelection();
    } catch (e) {
      setBulkError(errorText(e, t));
    } finally {
      setBulkBusy(false);
    }
  }

  function bulkDelete() {
    if (!window.confirm(t('select.confirmDelete', { n: selected.size }))) return;
    void bulk(() => deleteItems([...selected]));
  }

  function bulkStatus(status: ItemStatus) {
    void bulk(() => setItemsStatus([...selected], status));
  }

  async function saveItem(input: ItemInput) {
    if (itemDialog.item) await updateItem(itemDialog.item.id, input);
    else await createItem(id, input);
    await reload();
  }

  async function removeItem(item: Item) {
    if (!window.confirm(t('item.confirmDelete', { title: item.title }))) return;
    await deleteItem(item.id);
    await reload();
  }

  async function setStatus(item: Item, status: ItemStatus) {
    if (status === item.status) return;
    await updateItem(item.id, { status });
    await reload();
  }

  async function saveList(input: ListInput) {
    await updateList(id, input);
    setList(await fetchList(id));
  }

  const currency = list?.currency ?? 'PLN';

  return (
    <div className="page">
      <p className="small">
        <Link to="/lists">← {t('lists.title')}</Link>
      </p>

      <div className="page__head page__head--row">
        <div>
          <h1>{list?.title ?? '…'}</h1>
          {list?.description && <p className="lede">{list.description}</p>}
        </div>
        <div className="page__actions">
          {selecting ? (
            <button className="btn btn--quiet" onClick={exitSelection}>
              {t('common.cancel')}
            </button>
          ) : (
            <>
              <button
                className="btn btn--quiet"
                onClick={() => setSelecting(true)}
                disabled={items.length === 0}
              >
                {t('select.start')}
              </button>
              <button className="btn btn--quiet" onClick={() => setListDialog(true)} disabled={!list}>
                {t('lists.edit')}
              </button>
              <button
                className="btn btn--quiet"
                onClick={() => setExportDialog(true)}
                disabled={!list || items.length === 0}
              >
                {t('transfer.export.open')}
              </button>
              <button className="btn" onClick={() => setItemDialog({ open: true, item: null })}>
                {t('item.add')}
              </button>
            </>
          )}
        </div>
      </div>

      {listError && <Note tone="error">{listError}</Note>}
      {error && <Note tone="error">{error}</Note>}
      {staleAt && <StaleNotice savedAt={staleAt} />}

      {totals && (
        <p className="totals">
          <strong>{money(totals.active_price, currency, locale)}</strong>{' '}
          <span className="small">
            {t('totals.active', { n: totals.active_count })}
            {totals.items_no_price > 0 && ` · ${t('totals.noPrice', { n: totals.items_no_price })}`}
            {totals.gifted_count > 0 && ` · ${t('totals.gifted', { n: totals.gifted_count })}`}
          </span>
        </p>
      )}

      <EventSummary list={list} totals={totals} onStart={startSummary} />

      <Toolbar query={draft} onChange={patch} />

      {loading ? (
        <p className="small">{t('common.loading')}…</p>
      ) : items.length === 0 && !error ? (
        <div className="empty">
          <h2>{t('item.emptyTitle')}</h2>
          <p className="lede">{t('item.emptyBody')}</p>
        </div>
      ) : (
        <>
          <div className="card-grid">
            {items.map((item) => (
              <ItemCard
                key={item.id}
                item={item}
                currency={currency}
                onEdit={(i) => setItemDialog({ open: true, item: i })}
                onDelete={(i) => void removeItem(i)}
                onSetStatus={(i, s) => void setStatus(i, s)}
                selectable={selecting}
                selected={selected.has(item.id)}
                onToggleSelect={toggleSelect}
              />
            ))}
          </div>

          <div ref={sentinel} />

          {/* Запасний шлях: скрол може не спрацювати з клавіатури або при reduce-motion. */}
          {!done && (
            <button className="btn btn--quiet btn--wide" disabled={loadingMore} onClick={() => void loadMore()}>
              {loadingMore ? `${t('common.loading')}…` : t('item.loadMore')}
            </button>
          )}
          {done && items.length > 0 && <p className="small center">{t('item.end')}</p>}
        </>
      )}

      {/* Панель вибору притиснута донизу екрана: вибір іде згори вниз,
          а дія має лишатись під рукою на будь-якій довжині списку. */}
      {selecting && (
        <div className="selectbar" role="region" aria-label={t('select.region')}>
          <div className="selectbar__info">
            <span>{t('select.selected', { n: selected.size })}</span>
            {selectedActiveIds.length > 0 && selectedActiveIds.length < selected.size && (
              <span className="small">{t('select.shareActiveOnly', { n: selectedActiveIds.length })}</span>
            )}
          </div>
          {bulkError && <Note tone="error">{bulkError}</Note>}
          <div className="selectbar__actions">
            <button
              className="btn btn--quiet"
              disabled={bulkBusy}
              onClick={() => setSelected(new Set(items.map((i) => i.id)))}
            >
              {t('select.selectAll')}
            </button>
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
              className="btn btn--quiet btn--danger"
              disabled={bulkBusy || selected.size === 0}
              onClick={bulkDelete}
            >
              {t('common.delete')}
            </button>
            <button
              className="btn"
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
      <ListDialog
        open={listDialog}
        list={list}
        onClose={() => setListDialog(false)}
        onSave={saveList}
      />
      <ExportDialog open={exportDialog} list={list} onClose={() => setExportDialog(false)} />
    </div>
  );
}
