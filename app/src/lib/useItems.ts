import { useCallback, useEffect, useRef, useState } from 'react';
import { cursorFrom, fetchItemsPage, fetchTotals } from './db';
import type { Cursor } from './db';
import type { Item, ItemQuery, Totals } from './types';
import { useI18n } from './i18n';
import { errorText, isNetworkError } from './errors';
import { itemsKey, readSnapshot, saveSnapshot } from './cache';
import type { ItemsSnapshot } from './cache';

/**
 * Керує сторінкою позицій: keyset-курсор, довантаження, підсумки.
 * Будь-яка зміна запиту скидає курсор — інакше сторінки перемішаються.
 */
/**
 * Чи це та сама вибірка, яку показує щойно відкритий список.
 *
 * Кешуємо лише її: знімок із чужим пошуком або фільтром офлайн виглядав би як
 * увесь список, і людина вирішила б, що позиції зникли. Сортування й розмір
 * партії на склад позицій не впливають, тож їх не звіряємо.
 */
function isPlainQuery(q: ItemQuery): boolean {
  return q.search.trim() === '' && q.statuses.length === 0 && q.priceMin === '' && q.priceMax === '';
}

export function useItems(listId: string, query: ItemQuery, userId: string | undefined) {
  const { t } = useI18n();
  // Через ref: зміна мови не має перезавантажувати позиції.
  const tRef = useRef(t);
  tRef.current = t;
  const [items, setItems] = useState<Item[]>([]);
  const [totals, setTotals] = useState<Totals | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Час збереження знімка, якщо показано саме його. */
  const [staleAt, setStaleAt] = useState<string | null>(null);

  // Номер запиту: відповідь від застарілого запиту ігнорується.
  const runId = useRef(0);
  const cursor = useRef<Cursor>(null);

  const loadFirst = useCallback(async () => {
    const id = ++runId.current;
    setLoading(true);
    setError(null);
    // Позначка копії належить конкретній вибірці: нова вибірка починає без неї,
    // інакше пошук офлайн виглядав би як «показано збережену копію пошуку».
    setStaleAt(null);
    cursor.current = null;
    try {
      const [page, pageTotals] = await Promise.all([
        fetchItemsPage(listId, query, null),
        fetchTotals(listId),
      ]);
      if (id !== runId.current) return;
      setItems(page);
      setTotals(pageTotals);
      setStaleAt(null);
      setDone(page.length < query.pageSize);
      const last = page[page.length - 1];
      cursor.current = last ? cursorFrom(last, query.sort) : null;
      if (isPlainQuery(query) && userId) {
        void saveSnapshot<ItemsSnapshot>(itemsKey(listId), userId, {
          items: page,
          totals: pageTotals,
        });
      }
    } catch (e) {
      if (id !== runId.current) return;
      // Мережі немає — показуємо збережену копію, але лише для тієї самої
      // вибірки, яку кешували. Відмову сервера кешем не прикриваємо.
      const snapshot =
        isNetworkError(e) && isPlainQuery(query) && userId
          ? await readSnapshot<ItemsSnapshot>(itemsKey(listId), userId)
          : null;
      if (id !== runId.current) return;
      if (snapshot) {
        setItems(snapshot.data.items);
        setTotals(snapshot.data.totals);
        setStaleAt(snapshot.savedAt);
        // Довантажувати нічого: у знімку лише перша партія.
        setDone(true);
        setError(null);
      } else {
        setError(errorText(e, tRef.current));
      }
    } finally {
      if (id === runId.current) setLoading(false);
    }
  }, [listId, query, userId]);

  const loadMore = useCallback(async () => {
    if (loading || loadingMore || done || !cursor.current) return;
    const id = runId.current;
    setLoadingMore(true);
    try {
      const page = await fetchItemsPage(listId, query, cursor.current);
      if (id !== runId.current) return;
      setItems((prev) => [...prev, ...page]);
      setDone(page.length < query.pageSize);
      const last = page[page.length - 1];
      if (last) cursor.current = cursorFrom(last, query.sort);
    } catch (e) {
      if (id === runId.current) setError(errorText(e, tRef.current));
    } finally {
      if (id === runId.current) setLoadingMore(false);
    }
  }, [listId, query, loading, loadingMore, done]);

  useEffect(() => {
    void loadFirst();
  }, [loadFirst]);

  return { items, totals, loading, loadingMore, done, error, staleAt, reload: loadFirst, loadMore };
}

/** Відкладає значення — щоб пошук не бив у базу на кожну літеру. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}
