import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  AlertCircle,
  Archive,
  ArchiveRestore,
  ArrowDownUp,
  ChevronLeft,
  Eye,
  FolderPlus,
  ListOrdered,
  ListPlus,
  MoreHorizontal,
  Palette,
  Plus,
  Repeat,
  Search,
  SearchX,
  Settings2,
  Share2,
  X,
} from 'lucide-react';
import { deleteList, fetchList, setListArchived, updateList } from '../../../lib/db';
import type { ListInput } from '../../../lib/db';
import { fetchListViews } from '../../../lib/shares';
import { useItems } from '../../../lib/useItems';
import { useAuth } from '../../../lib/auth';
import { useI18n } from '../../../lib/i18n';
import { errorText, isNetworkError } from '../../../lib/errors';
import { formatDateTime, formatDay, localToday, moneyShort, num } from '../../../lib/format';
import { listKey, readSnapshot, saveSnapshot, sectionsKey } from '../../../lib/cache';
import { newId, run } from '../../../lib/outbox';
import type { Op } from '../../../lib/outbox';
import { useUndo } from '../../../lib/undo';
import { designSwitchHref } from '../../../lib/authFlow';
import { afterEventDue, eventYear, isPastEvent, readSnooze, snoozeNext, writeSnooze } from '../../../lib/afterEvent';
import type { Snooze } from '../../../lib/afterEvent';
import {
  createSection,
  deleteSection,
  fetchSections,
  manualOrder,
  renameSection,
  reorderItems,
  reorderSections,
} from '../../../lib/sections';
import type { Section } from '../../../lib/sections';
import {
  ITEM_QTY_MAX,
  TOOLS_FROM,
  isDraft,
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
import { AppearanceSheetV2 } from './AppearanceSheetV2';
import { DeleteListSheetV2, ListSettingsV2 } from './ListSettingsV2';
import { PreviewSheetV2, useAppearanceHue } from './PreviewV2';
import type { PreviewGroup } from './PreviewV2';
import { ReorderV2 } from './ReorderV2';
import type { OrderGroup } from './ReorderV2';
import { ShareSheetV2 } from './ShareSheetV2';
import { AfterEventCardV2, ArchivedNoteV2, CarrySheetV2, ReceivedSheetV2, RepeatSheetV2 } from './AfterEventV2';
import type { AfterStep } from './AfterEventV2';
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
 * Сторінка списку v2 (потоки C, D, F, O, V, W1; ROADMAP «Дизайн v2», кроки 3б-1 і 3б-2).
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
 * зникли б разом із позицією (ADR-044). Свайп ліворуч — прискорювач того
 * самого видалення.
 *
 * З меню списку: «Поділитися» (вибір видимих позицій і превʼю до створення
 * посилання), «Показати, як бачить гість», «Змінити порядок» — окремий режим
 * із перетягуванням і «Вище / Нижче», оформлення, розділи, налаштування й
 * видалення списку: тостом, якщо список ніхто не відкривав, і з введенням
 * назви, якщо відкривали (F3).
 *
 * Після свята (крок 4а, потоки M, S3; ADR-045) — картка «Як минуло свято?»:
 * позначити отримане, перенести копії того, що ще хочеш, повторити на
 * наступний рік, архівувати або «Пізніше». Архівний список — полиця: без
 * «Поділитися», «+» і правки порядку, з «Повернути з архіву» вгорі.
 */
export default function ListV2() {
  const { id = '' } = useParams();
  const { t, locale } = useI18n();
  const { session } = useAuth();
  const counts = useCounts();
  const sortLabel = useSortLabel();
  const priorityLabel = usePriorityLabel();
  const userId = session?.user.id ?? '';
  const navigate = useNavigate();
  const location = useLocation();

  const [list, setList] = useState<List | null>(null);
  const [listState, setListState] = useState<ListState>('loading');
  const [listError, setListError] = useState<string | null>(null);
  const [sections, setSections] = useState<Section[]>([]);

  const { items, loading, error, staleAt, reload, refresh, applyLocal, patchLocal } = useItems(
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
  const [shareOpen, setShareOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** Видалення списку, який відкривали: скільки разів (null — невідомо). */
  const [deleteAsk, setDeleteAsk] = useState<{ views: number | null } | null>(null);
  /** «Змінити порядок» (V3): окремий режим, щоб перетягування не заважало свайпу. */
  const [ordering, setOrdering] = useState(false);
  const hue = useAppearanceHue(list?.appearance_id);

  /* ── Після свята й архів (ADR-045) ── */
  const [snooze, setSnooze] = useState<Snooze | null>(() => readSnooze(id));
  const [afterStep, setAfterStep] = useState<AfterStep | null>(null);
  const [afterDone, setAfterDone] = useState<Set<AfterStep>>(new Set());
  const [archiving, setArchiving] = useState(false);
  /** «Ще хочу» дійшло: куди й скільки — з посиланням туди. */
  const [carried, setCarried] = useState<{ id: string; title: string; n: number } | null>(null);
  /** Одноразовий рядок, з яким сюди прийшли (напр. «Повторено з …»). */
  const [flash, setFlash] = useState<string | null>(null);

  const undo = useUndo(UNDO_MS);

  useEffect(() => {
    setSort(readSort(id));
    setSearch('');
    setFilter('all');
    setHidden(new Set());
    setFailed(new Map());
    setOrdering(false);
    setSnooze(readSnooze(id));
    setAfterStep(null);
    setAfterDone(new Set());
    setCarried(null);
  }, [id]);

  // Перший запуск «Вставити посилання на річ» (Q2) веде сюди з одразу
  // відкритою формою позиції. Стан історії чистимо, щоб F5 не відкривав її знову.
  useEffect(() => {
    const state = location.state as { add?: boolean; flash?: string } | null;
    if (!state?.add && !state?.flash) {
      setFlash(null);
      return;
    }
    navigate(location.pathname, { replace: true, state: null });
    if (state.add) setSheet({ open: true, item: null });
    setFlash(state.flash ?? null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        shown.filter((i) => i.status === 'active' && !isDraft(i)),
        viewSort,
        sections,
        { keepEmpty: !filtering },
      ),
    [shown, viewSort, sections, filtering],
  );
  /** Чернетки без назви (ADR-046) — окремо згори: їм бракує назви, а гостям їх не видно. */
  const drafts = useMemo(
    () => sortItems(shown.filter((i) => i.status === 'active' && isDraft(i)), 'recent'),
    [shown],
  );
  const done = useMemo(
    () => sortItems(shown.filter((i) => i.status !== 'active'), viewSort === 'priority' ? 'manual' : viewSort),
    [shown, viewSort],
  );
  const activeShown = groups.reduce((n, g) => n + g.items.length, 0) + drafts.length;

  /** Актуальні позиції — для «Після свята»; чернетки теж тут: це бажання власника. */
  const activeLive = useMemo(() => live.filter((i) => i.status === 'active'), [live]);
  /** Те, що можуть побачити гості, у їхньому порядку: без чернеток (ADR-046). */
  const shareable = useMemo(() => activeLive.filter((i) => !isDraft(i)), [activeLive]);
  const guestGroups = useMemo<PreviewGroup[]>(
    () =>
      viewGroups(shareable, 'manual', sections, { keepEmpty: false }).map((g) => ({
        key: g.key,
        title: g.kind === 'section' ? g.section.title : null,
        items: g.items,
      })),
    [shareable, sections],
  );
  const orderGroups = useMemo<OrderGroup[]>(
    () =>
      viewGroups(shareable, 'manual', sections, { keepEmpty: true }).map((g) => ({
        key: g.key,
        section: g.kind === 'section' ? g.section : null,
        items: g.items,
      })),
    [shareable, sections],
  );

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
      label: input.needs_title ? t('v2list.toast.drafted') : t('v2list.toast.added', { title: input.title }),
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

  /* ── Порядок (V3, ADR-036) ── */

  /**
   * Новий порядок позицій розділу. Куплене й подароване гостям не видно, тож
   * у режимі його немає, — але воно стає слідом за актуальним, щоб місця в
   * розділі лишались унікальними й v1 показувала той самий порядок.
   */
  async function moveItems(sectionId: string | null, activeIds: string[]) {
    const known = new Set(sections.map((s) => s.id));
    const inGroup = (i: Item) =>
      sectionId ? i.section_id === sectionId : !i.section_id || !known.has(i.section_id);
    const doneIds = items
      .filter((i) => i.status !== 'active' && inGroup(i))
      .sort(manualOrder)
      .map((i) => i.id);
    const ids = [...activeIds, ...doneIds];
    const pos = new Map(ids.map((itemId, i) => [itemId, i + 1]));
    setActionError(null);
    patchLocal((prev) =>
      prev.map((i) => (pos.has(i.id) ? { ...i, section_id: sectionId, position: pos.get(i.id)! } : i)),
    );
    try {
      await reorderItems(id, sectionId, ids);
    } catch {
      setActionError(t('sections.saveError'));
      void refresh();
    }
  }

  async function moveSections(ids: string[]) {
    const before = sections;
    const pos = new Map(ids.map((sid, i) => [sid, i + 1]));
    setActionError(null);
    setSections((prev) =>
      prev.map((s) => ({ ...s, position: pos.get(s.id) ?? s.position })).sort((a, b) => a.position - b.position),
    );
    try {
      await reorderSections(id, ids);
    } catch {
      setActionError(t('sections.saveError'));
      setSections(before);
    }
  }

  function startOrdering() {
    setListMenu(false);
    setSearch('');
    setFilter('all');
    // Після «Готово» людина бачить той порядок, який щойно склала.
    changeSort('manual');
    setOrdering(true);
  }

  /* ── Список: налаштування й видалення ── */

  async function saveList(input: ListInput) {
    await updateList(id, input);
    const fresh = await fetchList(id);
    if (fresh) setList(fresh);
  }

  /* ── Після свята й архів (M, S3, ADR-045) ── */

  /** «Позначити отримане»: той самий шлях, що й статус з меню, — працює й офлайн. */
  async function markReceived(ids: string[]) {
    const op: Op = { kind: 'status', listId: id, ids, status: 'gifted' };
    setActionError(null);
    const result = await run(userId, op);
    applyLocal(op);
    if (result === 'sent') void refresh();
    setAfterDone((s) => new Set(s).add('received'));
  }

  /** Архів — одним натиском і так само назад: це полиця, а не видалення. */
  async function archive(next: boolean) {
    if (archiving || !list) return;
    setListMenu(false);
    setArchiving(true);
    setActionError(null);
    try {
      await setListArchived(id, next);
      const fresh = { ...list, is_archived: next };
      setList(fresh);
      if (userId) void saveSnapshot(listKey(id), userId, fresh);
    } catch (e) {
      setActionError(t('v2list.actionFailed', { error: errorText(e, t) }));
    } finally {
      setArchiving(false);
    }
  }

  /** «Пізніше»: вперше — на три дні, вдруге — назовсім (M1). */
  function later() {
    if (!list?.event_date) return;
    const next = snoozeNext(snooze, list.event_date, localToday());
    writeSnooze(id, next);
    setSnooze(next);
  }

  /**
   * Видалення списку (F3): три ваги — три захисти. Список, який ніхто не
   * відкривав, іде тостом «Відмінити» на головній; відкривали — вводимо назву
   * рукою. Не вдалося дізнатися — теж вводимо: безпечніше спитати зайвий раз.
   */
  async function askDelete() {
    setSettingsOpen(false);
    let views: number | null = null;
    try {
      views = await fetchListViews(id);
    } catch {
      views = null;
    }
    if (views === 0 && list) {
      navigate('/lists', { replace: true, state: { deleteList: { id, title: list.title } } });
      return;
    }
    setDeleteAsk({ views });
  }

  async function deleteNow() {
    await deleteList(id);
    navigate('/lists', { replace: true, state: { deletedTitle: list?.title ?? '' } });
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
  const today = localToday();
  const archived = Boolean(list?.is_archived);
  const past = list ? isPastEvent(list, today) : false;
  const listYear = list ? eventYear(list) : null;
  const afterDue = list !== null && ready && !ordering && afterEventDue(list, today, snooze);

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
        onDelete={removeItem}
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
          {ordering ? (
            <p className="v2-listhead__meta">{t('v2list.reorder.subtitle')}</p>
          ) : (
            ready && (
              <p className="v2-listhead__meta">{[counts.items(live.length), eventDay].filter(Boolean).join(' · ')}</p>
            )
          )}
        </div>
        {ordering ? (
          <button type="button" className="v2-btn v2-btn--primary v2-btn--small" onClick={() => setOrdering(false)}>
            {t('common.done')}
          </button>
        ) : (
          <span className="v2-listhead__actions">
            {/* Поділитися — головна дія зі списком, тож не лише в меню. Без
                актуальних позицій ділитися нічим: посилання на порожнє не буває. */}
            {ready && shareable.length > 0 && !archived && (
              <button
                type="button"
                className="v2-iconbtn"
                aria-label={t('v2list.share')}
                onClick={() => setShareOpen(true)}
                disabled={!list}
              >
                <Share2 size={22} strokeWidth={STROKE} aria-hidden="true" />
              </button>
            )}
            <button
              type="button"
              className="v2-iconbtn"
              aria-label={t('v2list.menu')}
              onClick={() => setListMenu(true)}
              disabled={!list}
            >
              <MoreHorizontal size={24} strokeWidth={STROKE} aria-hidden="true" />
            </button>
          </span>
        )}
      </div>

      {listError && <NoteV2 tone="error">{listError}</NoteV2>}
      {staleAt && (
        <NoteV2 tone="info">{t('v2app.lists.stale', { time: formatDateTime(staleAt, locale) ?? '' })}</NoteV2>
      )}
      {actionError && <NoteV2 tone="error">{actionError}</NoteV2>}
      {flash && <NoteV2 tone="info">{flash}</NoteV2>}
      {carried && (
        <NoteV2 tone="info">
          {t('v2after.carry.done', { title: carried.title, n: carried.n })}{' '}
          <Link to={`/lists/${carried.id}`} className="v2-link">
            {t('v2after.carry.open')}
          </Link>
        </NoteV2>
      )}
      {archived && !ordering && <ArchivedNoteV2 busy={archiving} onRestore={() => void archive(false)} />}

      {afterDue && list && (
        <AfterEventCardV2
          list={list}
          openCount={activeLive.length}
          done={afterDone}
          archiving={archiving}
          onStep={setAfterStep}
          onArchive={() => void archive(true)}
          onLater={later}
        />
      )}

      {ready && live.length > 0 && !ordering && (
        <p className="v2-sum">
          {activePriced && <strong className="v2-sum__value">{moneyShort(totals.active_price, currency, locale)}</strong>}
          {sumParts.length > 0 && <span className="v2-sum__line">{sumParts.join(' · ')}</span>}
        </p>
      )}

      {ready && tools && !ordering && (
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

      {ordering && ready ? (
        <ReorderV2
          groups={orderGroups}
          currency={currency}
          onMoveItems={(sectionId, ids) => void moveItems(sectionId, ids)}
          onMoveSections={(ids) => void moveSections(ids)}
        />
      ) : loading ? (
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
          {!archived && (
            <>
              <p className="v2-lede">{t('v2list.empty.body')}</p>
              <button type="button" className="v2-btn v2-btn--primary" onClick={() => openNew()}>
                {t('v2list.add')}
              </button>
            </>
          )}
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
          {drafts.length > 0 && (
            <section className="v2-group" aria-labelledby="v2-group-drafts">
              <div className="v2-group__head">
                <h2 className="v2-kicker v2-group__title" id="v2-group-drafts">
                  {t('v2list.item.draft')} · {drafts.length}
                </h2>
              </div>
              <p className="v2-hint v2-hint--start">{t('v2list.group.draftsHint')}</p>
              <ul className="v2-items">{drafts.map(card)}</ul>
            </section>
          )}
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
      {ready && live.length > 0 && !undo.pending && !ordering && !archived && (
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
          {/* Архівний список — полиця: поділитися, змінити порядок чи вигляд уже
              нема для кого. Лишаються повтор, повернення й налаштування. */}
          {!archived && (
            <>
              <button
                type="button"
                className="v2-menu__item"
                aria-disabled={shareable.length === 0 || undefined}
                aria-describedby={shareable.length === 0 ? 'v2-share-empty' : undefined}
                onClick={() => {
                  if (shareable.length === 0) return;
                  setListMenu(false);
                  setShareOpen(true);
                }}
              >
                <Share2 size={20} strokeWidth={STROKE} aria-hidden="true" />
                {t('v2list.share')}
              </button>
              <button
                type="button"
                className="v2-menu__item"
                onClick={() => {
                  setListMenu(false);
                  setPreviewOpen(true);
                }}
              >
                <Eye size={20} strokeWidth={STROKE} aria-hidden="true" />
                {t('appearance.preview')}
              </button>
              <button
                type="button"
                className="v2-menu__item"
                aria-disabled={shareable.length < 2 || Boolean(staleAt) || undefined}
                aria-describedby={staleAt ? 'v2-order-offline' : undefined}
                onClick={() => {
                  if (shareable.length < 2 || staleAt) return;
                  startOrdering();
                }}
              >
                <ListOrdered size={20} strokeWidth={STROKE} aria-hidden="true" />
                {t('v2list.reorder.cta')}
              </button>
              <button
                type="button"
                className="v2-menu__item"
                onClick={() => {
                  setListMenu(false);
                  setAppearanceOpen(true);
                }}
              >
                <Palette size={20} strokeWidth={STROKE} aria-hidden="true" />
                {t('appearance.title')}
              </button>
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
            </>
          )}
          {(archived || past) && (
            <button
              type="button"
              className="v2-menu__item"
              onClick={() => {
                setListMenu(false);
                setAfterStep('repeat');
              }}
            >
              <Repeat size={20} strokeWidth={STROKE} aria-hidden="true" />
              {listYear !== null ? t('v2after.card.repeat', { year: listYear + 1 }) : t('v2after.repeat.titlePlain')}
            </button>
          )}
          <button
            type="button"
            className="v2-menu__item"
            aria-disabled={archiving || undefined}
            onClick={() => void archive(!archived)}
          >
            {archived ? (
              <ArchiveRestore size={20} strokeWidth={STROKE} aria-hidden="true" />
            ) : (
              <Archive size={20} strokeWidth={STROKE} aria-hidden="true" />
            )}
            {archived ? t('v2after.archived.restore') : t('v2after.card.archive')}
          </button>
          <button
            type="button"
            className="v2-menu__item"
            onClick={() => {
              setListMenu(false);
              setSettingsOpen(true);
            }}
          >
            <Settings2 size={20} strokeWidth={STROKE} aria-hidden="true" />
            {t('v2list.settings.title')}
          </button>
        </div>
        {shareable.length === 0 && !archived && (
          <p className="v2-hint v2-hint--start" id="v2-share-empty">
            {activeLive.length > 0 ? t('v2list.menuList.shareDrafts') : t('v2list.menuList.shareEmpty')}
          </p>
        )}
        {staleAt && !archived && (
          <p className="v2-hint v2-hint--start" id="v2-order-offline">
            {t('v2list.reorder.offline')}
          </p>
        )}
        {/* Експорт у файл — поки лише у v1; дорога туди з тим самим списком. */}
        <p className="v2-hint v2-hint--start">
          {t('v2list.menuList.exportBody')}{' '}
          <a href={designSwitchHref(`/lists/${id}`, '', 'v1')} className="v2-link">
            {t('v2list.menuList.inV1')}
          </a>
        </p>
      </SheetV2>

      <ShareSheetV2 open={shareOpen} list={list} groups={guestGroups} onClose={() => setShareOpen(false)} />

      <ReceivedSheetV2
        open={afterStep === 'received'}
        items={activeLive}
        currency={currency}
        onClose={() => setAfterStep(null)}
        onSave={markReceived}
      />

      {list && (
        <CarrySheetV2
          open={afterStep === 'carry'}
          list={list}
          items={activeLive}
          userId={userId}
          onClose={() => setAfterStep(null)}
          onDone={(target, n) => {
            setCarried({ ...target, n });
            setAfterDone((s) => new Set(s).add('carry'));
          }}
        />
      )}

      {list && (
        <RepeatSheetV2
          open={afterStep === 'repeat'}
          list={list}
          sections={sections}
          items={activeLive}
          userId={userId}
          onClose={() => setAfterStep(null)}
          onCreated={(created) => {
            setAfterStep(null);
            navigate(`/lists/${created.id}`, { state: { flash: t('v2after.repeat.done', { title: list.title }) } });
          }}
        />
      )}

      <PreviewSheetV2
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={list?.title ?? ''}
        eventDate={list?.event_date ?? null}
        message={list?.description ?? null}
        groups={guestGroups}
        currency={currency}
        hue={hue}
      />

      <AppearanceSheetV2
        open={appearanceOpen}
        list={list}
        onClose={() => setAppearanceOpen(false)}
        onChanged={(appearanceId) => setList((l) => (l ? { ...l, appearance_id: appearanceId } : l))}
        onPreview={() => {
          setAppearanceOpen(false);
          setPreviewOpen(true);
        }}
      />

      <ListSettingsV2
        open={settingsOpen}
        list={list}
        onClose={() => setSettingsOpen(false)}
        onSave={saveList}
        onDelete={() => void askDelete()}
      />

      <DeleteListSheetV2
        open={deleteAsk !== null}
        list={list}
        itemCount={live.length}
        views={deleteAsk?.views ?? null}
        onClose={() => setDeleteAsk(null)}
        onConfirm={deleteNow}
      />

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
