import { useCallback, useEffect, useRef, useState } from 'react';
import { cursorFrom, fetchItemsPage, fetchTotals } from './db';
import type { Cursor } from './db';
import type { Item, ItemQuery, Totals } from './types';
import { useI18n } from './i18n';
import { errorText } from './errors';

/**
 * Керує сторінкою позицій: keyset-курсор, довантаження, підсумки.
 * Будь-яка зміна запиту скидає курсор — інакше сторінки перемішаються.
 */
export function useItems(listId: string, query: ItemQuery) {
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

  // Номер запиту: відповідь від застарілого запиту ігнорується.
  const runId = useRef(0);
  const cursor = useRef<Cursor>(null);

  const loadFirst = useCallback(async () => {
    const id = ++runId.current;
    setLoading(true);
    setError(null);
    cursor.current = null;
    try {
      const [page, pageTotals] = await Promise.all([
        fetchItemsPage(listId, query, null),
        fetchTotals(listId),
      ]);
      if (id !== runId.current) return;
      setItems(page);
      setTotals(pageTotals);
      setDone(page.length < query.pageSize);
      const last = page[page.length - 1];
      cursor.current = last ? cursorFrom(last, query.sort) : null;
    } catch (e) {
      if (id === runId.current) setError(errorText(e, tRef.current));
    } finally {
      if (id === runId.current) setLoading(false);
    }
  }, [listId, query]);

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

  return { items, totals, loading, loadingMore, done, error, reload: loadFirst, loadMore };
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
