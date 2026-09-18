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
import { Note } from '../components/ui';
import { StaleNotice } from '../components/StaleNotice';
import { LISTS_KEY, readSnapshot, saveSnapshot } from '../lib/cache';
import type { List } from '../lib/types';
import type { TransferItem, TransferList } from '../lib/transfer';

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

  async function onDelete(list: List) {
    if (!window.confirm(t('lists.confirmDelete', { title: list.title }))) return;
    await deleteList(list.id);
    await load();
  }

  return (
    <div className="page">
      <div className="page__head page__head--row">
        <h1>{t('lists.title')}</h1>
        <div className="page__actions">
          <button className="btn btn--quiet" onClick={() => setImportDialog(true)}>
            {t('transfer.import.open')}
          </button>
          <button className="btn" onClick={() => setDialog(true)}>
            {t('lists.create')}
          </button>
        </div>
      </div>

      {error && <Note tone="error">{error}</Note>}
      {staleAt && <StaleNotice savedAt={staleAt} />}

      {loading ? (
        <p className="small">{t('common.loading')}…</p>
      ) : lists.length === 0 && !error ? (
        <div className="empty">
          <h2>{t('lists.emptyTitle')}</h2>
          <p className="lede">{t('lists.emptyBody')}</p>
          <button className="btn" onClick={() => setDialog(true)}>
            {t('lists.create')}
          </button>
        </div>
      ) : (
        <ul className="list-grid">
          {lists.map((l) => (
            <li className="list-card" key={l.id}>
              <Link className="list-card__link" to={`/lists/${l.id}`}>
                <h2>{l.title}</h2>
                {l.description && <p className="small">{l.description}</p>}
                <p className="small list-card__meta">
                  {l.currency}
                  {l.event_date && ` · ${formatDate(l.event_date, locale)}`}
                </p>
              </Link>
              <button className="btn btn--bare" onClick={() => void onDelete(l)}>
                {t('common.delete')}
              </button>
            </li>
          ))}
        </ul>
      )}

      <ListDialog open={dialog} list={null} onClose={() => setDialog(false)} onSave={onCreate} />
      <ImportDialog
        open={importDialog}
        onClose={() => setImportDialog(false)}
        onImport={onImport}
      />
    </div>
  );
}
