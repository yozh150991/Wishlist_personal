import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { createList, createListWithItems, deleteList, fetchLists } from '../lib/db';
import type { ListInput } from '../lib/db';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { errorText, isNetworkError } from '../lib/errors';
import { formatDate } from '../lib/format';
import { ListDialog } from '../components/ListDialog';
import { ImportDialog } from '../components/ImportDialog';
import { ConfirmDialog } from '../components/Dialog';
import { Icon } from '../components/Icon';
import { useStale } from '../components/Banners';
import { LISTS_KEY, readSnapshot, saveSnapshot } from '../lib/cache';
import type { List } from '../lib/types';
import type { TransferItem, TransferList } from '../lib/transfer';

/** Три заглушки точної висоти карток — замість слова «Завантаження…». */
function Skeletons() {
  const widths = [
    ['66%', '88%', '40%'],
    ['48%', '80%', '34%'],
    ['58%', '76%', '44%'],
  ];
  return (
    <ul className="list-grid">
      {widths.map((row, i) => (
        <li className="list-card sk" key={i}>
          <span className="sk__line sk__line--title" style={{ width: row[0] }} />
          <span className="sk__line" style={{ width: row[1] }} />
          <span className="sk__line" style={{ width: row[2] }} />
          <span className="sk__tags">
            <span className="sk__line sk__line--tag" />
            <span className="sk__line sk__line--tag" />
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function Lists() {
  const { t, locale } = useI18n();
  const { session } = useAuth();
  const userId = session?.user.id;
  const [lists, setLists] = useState<List[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);
  const [importDialog, setImportDialog] = useState(false);
  /** Коли показане — копія з IndexedDB, а не свіжі дані. */
  const [staleAt, setStaleAt] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<List | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Банер про збережену копію живе в оболонці, щоб їх не було по одному
  // на кожному екрані (правило «на екрані рівно один банер»).
  useStale(staleAt ? new Date(staleAt) : null);

  const load = useCallback(async () => {
    setLoading(true);
    setStaleAt(null);
    try {
      const fresh = await fetchLists();
      setLists(fresh);
      setError(null);
      setStaleAt(null);
      void saveSnapshot(LISTS_KEY, userId ?? '', fresh);
    } catch (e) {
      // Мережі немає — показуємо останній бачений стан, але чесно позначаємо
      // його як копію. Відмова сервера (права, 500) кешем не прикривається.
      const snapshot = isNetworkError(e) ? await readSnapshot<List[]>(LISTS_KEY, userId ?? '') : null;
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
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(input: ListInput) {
    if (!userId) return;
    await createList(input, userId);
    await load();
  }

  async function onImport(list: TransferList, items: TransferItem[]) {
    if (!userId) return;
    await createListWithItems(
      { title: list.title, description: list.description, currency: list.currency, event_date: list.event_date },
      items,
      userId,
    );
    await load();
  }

  async function onDelete() {
    if (!confirm || deleting) return;
    setDeleting(true);
    try {
      await deleteList(confirm.id);
      setConfirm(null);
      await load();
    } finally {
      setDeleting(false);
    }
  }

  const empty = !loading && !error && lists.length === 0;

  return (
    <div className="page">
      <div className="page__head">
        <h1>{t('lists.title')}</h1>
        <div className="page__actions">
          <button
            type="button"
            className="btn btn--secondary"
            disabled={loading}
            onClick={() => setImportDialog(true)}
          >
            {t('transfer.import.open')}
          </button>
          {/* У порожньому стані дія одна — кнопка стоїть у тілі екрана,
              а не дублюється в шапці. */}
          {!empty && (
            <button
              type="button"
              className="btn btn--primary"
              disabled={loading}
              onClick={() => setDialog(true)}
            >
              <Icon name="plus" size={16} />
              {t('lists.create')}
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <main aria-busy="true">
          <span className="visually-hidden">{t('lists.loading')}</span>
          <Skeletons />
        </main>
      ) : error ? (
        <main className="empty">
          <span className="empty__icon empty__icon--danger">
            <Icon name="alert" size={36} />
          </span>
          <h2>{t('lists.errorTitle')}</h2>
          <p className="lede">{error}</p>
          <button type="button" className="btn btn--primary" onClick={() => void load()}>
            {t('common.retry')}
          </button>
        </main>
      ) : empty ? (
        <main className="empty">
          <span className="empty__icon">
            <Icon name="list" size={40} />
          </span>
          <h2>{t('lists.emptyTitle')}</h2>
          <p className="lede">{t('lists.emptyBody')}</p>
          <button type="button" className="btn btn--primary" onClick={() => setDialog(true)}>
            {t('lists.create')}
          </button>
        </main>
      ) : (
        <main>
          <ul className="list-grid" data-stale={staleAt ? 'true' : 'false'}>
            {lists.map((l) => (
              <li className="list-card" key={l.id}>
                <div className="list-card__main">
                  <Link className="list-card__title" to={`/lists/${l.id}`}>
                    {l.title}
                  </Link>
                  {l.description && <p className="muted small">{l.description}</p>}
                  <div className="list-card__tags">
                    <span className="tag tag--neutral">{l.currency}</span>
                    {l.event_date && (
                      // Офлайн дата події перестає бути акцентом: вона може бути
                      // застарілою так само, як і решта копії.
                      <span className={staleAt ? 'tag tag--neutral' : 'tag tag--accent'}>
                        {formatDate(l.event_date, locale)}
                      </span>
                    )}
                    {typeof l.item_count === 'number' && (
                      <span className="tag tag--neutral">{t('lists.itemCount', { n: l.item_count })}</span>
                    )}
                  </div>
                </div>
                {/* Назва списку — в доступній назві кнопки: «Видалити» саме по
                    собі в списку з трьох карток не каже, що буде видалено. */}
                <button
                  type="button"
                  className="btn btn--icon btn--secondary btn--danger"
                  aria-label={t('lists.deleteLabel', { title: l.title })}
                  onClick={() => setConfirm(l)}
                >
                  <Icon name="trash" size={17} />
                </button>
              </li>
            ))}
          </ul>
        </main>
      )}

      <ListDialog open={dialog} list={null} onClose={() => setDialog(false)} onSave={onCreate} />
      <ImportDialog open={importDialog} onClose={() => setImportDialog(false)} onImport={onImport} />
      <ConfirmDialog
        open={confirm !== null}
        title={t('lists.confirmTitle', {
          title: confirm?.title ?? '',
          n: confirm?.item_count ?? 0,
        })}
        body={t('lists.confirmBody')}
        confirmLabel={t('lists.confirmCta')}
        busyLabel={t('lists.deleting')}
        busy={deleting}
        onConfirm={() => void onDelete()}
        onClose={() => setConfirm(null)}
      />
    </div>
  );
}
