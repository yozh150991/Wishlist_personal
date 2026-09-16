import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { createItem, deleteItem, fetchList, updateItem, updateList } from '../lib/db';
import type { ItemInput, ListInput } from '../lib/db';
import { useDebounced, useItems } from '../lib/useItems';
import { useI18n } from '../lib/i18n';
import { money } from '../lib/format';
import { DEFAULT_QUERY } from '../lib/types';
import type { Item, ItemQuery, ItemStatus, List } from '../lib/types';
import { Toolbar } from '../components/Toolbar';
import { ItemCard } from '../components/ItemCard';
import { ItemDialog } from '../components/ItemDialog';
import { ListDialog } from '../components/ListDialog';
import { ShareDialog } from '../components/ShareDialog';
import { Note } from '../components/ui';

export default function ListDetail() {
  const { id = '' } = useParams();
  const { t, locale } = useI18n();

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

  // Пошук відкладається, решта фільтрів застосовується одразу.
  const search = useDebounced(draft.search, 300);
  const query = useMemo<ItemQuery>(() => ({ ...draft, search }), [draft, search]);

  const { items, totals, loading, loadingMore, done, error, reload, loadMore } = useItems(id, query);

  useEffect(() => {
    fetchList(id)
      .then(setList)
      .catch((e: unknown) => setListError(e instanceof Error ? e.message : String(e)));
  }, [id]);

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
  }

  /** Подароване й куплене гостям не показується, тож вибирати його нема сенсу. */
  const selectableItems = items.filter((i) => i.status === 'active');

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
                disabled={selectableItems.length === 0}
              >
                {t('share.start')}
              </button>
              <button className="btn btn--quiet" onClick={() => setListDialog(true)} disabled={!list}>
                {t('lists.edit')}
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

      <Toolbar query={draft} onChange={patch} />

      {loading ? (
        <p className="small">{t('common.loading')}…</p>
      ) : items.length === 0 ? (
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
                selectable={selecting && item.status === 'active'}
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
        <div className="selectbar" role="region" aria-label={t('share.start')}>
          <span>{t('share.selected', { n: selected.size })}</span>
          <div className="selectbar__actions">
            <button
              className="btn btn--quiet"
              onClick={() => setSelected(new Set(selectableItems.map((i) => i.id)))}
            >
              {t('share.selectAll')}
            </button>
            <button
              className="btn"
              disabled={selected.size === 0}
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
        itemIds={[...selected]}
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
    </div>
  );
}
