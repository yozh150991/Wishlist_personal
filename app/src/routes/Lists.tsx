import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { createList, deleteList, fetchLists } from '../lib/db';
import type { ListInput } from '../lib/db';
import { useAuth } from '../lib/auth';
import { useI18n } from '../lib/i18n';
import { formatDate } from '../lib/format';
import { ListDialog } from '../components/ListDialog';
import { Note } from '../components/ui';
import type { List } from '../lib/types';

export default function Lists() {
  const { t, locale } = useI18n();
  const { session } = useAuth();
  const [lists, setLists] = useState<List[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dialog, setDialog] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLists(await fetchLists());
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate(input: ListInput) {
    const userId = session?.user.id;
    if (!userId) return;
    await createList(input, userId);
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
        <button className="btn" onClick={() => setDialog(true)}>
          {t('lists.create')}
        </button>
      </div>

      {error && <Note tone="error">{error}</Note>}

      {loading ? (
        <p className="small">{t('common.loading')}…</p>
      ) : lists.length === 0 ? (
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
    </div>
  );
}
