import { useCallback, useEffect, useRef, useState } from 'react';
import { cursorFrom, fetchAllItems, fetchItemsPage, fetchTotals } from './db';
import type { Cursor } from './db';
import type { Item, ItemQuery, Totals } from './types';
import { useI18n } from './i18n';
import { errorText, isNetworkError } from './errors';
import { applyToItems } from './outboxOps';
import type { Op } from './outboxOps';
import { allItemsKey, itemsKey, readSnapshot, saveSnapshot } from './cache';
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

/**
 * `mode = 'all'` — увесь список одним запитом, для режиму «Розділи»
 * (ADR-036): групування й ручний порядок потребують усіх позицій, а фільтри
 * тоді застосовуються на клієнті (`matchesQuery`). Список у такому режимі від
 * запиту не залежить і не перечитується на кожну літеру пошуку.
 */
export function useItems(
  listId: string,
  query: ItemQuery,
  userId: string | undefined,
  mode: 'page' | 'all' = 'page',
) {
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
  /**
   * Яким способом завантажено те, що зараз у `items`. Сторінка вантажить
   * першу партію одразу, паралельно зі списком, і лише потім дізнається, що
   * потрібен цілий список (ADR-036): до того, як прийде він, перша партія —
   * не те, що треба показувати в розділах.
   */
  const [loadedAs, setLoadedAs] = useState<'page' | 'all' | null>(null);

  // Номер запиту: відповідь від застарілого запиту ігнорується.
  const runId = useRef(0);
  const cursor = useRef<Cursor>(null);

  const loadAll = useCallback(async () => {
    const id = ++runId.current;
    setLoading(true);
    setError(null);
    setStaleAt(null);
    cursor.current = null;
    try {
      const [all, allTotals] = await Promise.all([fetchAllItems(listId), fetchTotals(listId)]);
      if (id !== runId.current) return;
      setItems(all);
      setTotals(allTotals);
      setDone(true);
      setLoadedAs('all');
      if (userId) {
        void saveSnapshot<ItemsSnapshot>(allItemsKey(listId), userId, { items: all, totals: allTotals });
      }
    } catch (e) {
      if (id !== runId.current) return;
      // Офлайн — знімок усього списку, а якщо його ще не було, то хоча б
      // перша партія: краще частина з позначкою копії, ніж порожній екран.
      const snapshot =
        isNetworkError(e) && userId
          ? ((await readSnapshot<ItemsSnapshot>(allItemsKey(listId), userId)) ??
            (await readSnapshot<ItemsSnapshot>(itemsKey(listId), userId)))
          : null;
      if (id !== runId.current) return;
      if (snapshot) {
        setItems(snapshot.data.items);
        setTotals(snapshot.data.totals);
        setStaleAt(snapshot.savedAt);
        setDone(true);
        setError(null);
        setLoadedAs('all');
      } else {
        setError(errorText(e, tRef.current));
      }
    } finally {
      if (id === runId.current) setLoading(false);
    }
  }, [listId, userId]);

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
      setLoadedAs('page');
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
        setLoadedAs('page');
      } else {
        setError(errorText(e, tRef.current));
      }
    } finally {
      if (id === runId.current) setLoading(false);
    }
  }, [listId, query, userId]);

  const loadMore = useCallback(async () => {
    if (mode === 'all' || loading || loadingMore || done || !cursor.current) return;
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
  }, [listId, query, loading, loadingMore, done, mode]);

  const reload = mode === 'all' ? loadAll : loadFirst;

  useEffect(() => {
    void reload();
  }, [reload]);

  /**
   * Показати зміну, яка лягла в чергу (етап 6.5).
   *
   * Замість `reload()`: перечитувати нічого, бо мережі немає, а знімок у кеші
   * черга вже підправила. Тут — те саме для того, що на екрані зараз.
   */
  const applyLocal = useCallback((op: Op) => {
    setItems((prev) => applyToItems(prev, op));
  }, []);

  /** Локальна правка без запиту — для оптимістичного перетягування (ADR-036). */
  const patchLocal = useCallback((change: (items: Item[]) => Item[]) => {
    setItems((prev) => change(prev));
  }, []);

  return {
    items,
    totals,
    // Перша партія вже тут, а потрібен цілий список, — ще вантажимо.
    loading: loading || (error === null && loadedAs !== mode),
    loadingMore,
    done,
    error,
    staleAt,
    reload,
    loadMore,
    applyLocal,
    patchLocal,
  };
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
