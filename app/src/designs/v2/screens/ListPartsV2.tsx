import { useEffect, useRef, useState } from 'react';
import type { PointerEvent, ReactNode, MouseEvent as ReactMouseEvent } from 'react';
import { ExternalLink, MoreHorizontal, Pencil, Trash2 } from 'lucide-react';
import { useI18n } from '../../../lib/i18n';
import { hostOf, moneyShort } from '../../../lib/format';
import { STATUSES } from '../../../lib/types';
import type { Currency, Item, ItemPriority, ItemStatus } from '../../../lib/types';
import { SECTION_TITLE_MAX } from '../../../lib/sections';
import type { Section } from '../../../lib/sections';
import { VIEW_SORTS } from '../../../lib/itemsView';
import type { ViewSort } from '../../../lib/itemsView';
import type { Pending } from '../../../lib/undo';
import { errorText } from '../../../lib/errors';
import { FieldV2, NoteV2, SubmitV2, useCountdown } from './AuthPartsV2';
import { SheetV2 } from './CommonV2';

/**
 * Частини сторінки списку v2 (потоки C, F, O, V): картка позиції, її меню,
 * вибір сортування, розділи, тост «Відмінити». Лише розмітка й стан вікон —
 * дані й правила вигляду в `lib/` (`useItems`, `itemsView`, `undo`).
 */

const STROKE = 2.75;

/** Назви рівнів пріоритету v2: «Дуже хочу», «Було б добре», «Просто ідея». */
export function usePriorityLabel() {
  const { t } = useI18n();
  return (p: ItemPriority) =>
    p === 'high' ? t('v2list.priority.high') : p === 'low' ? t('v2list.priority.low') : t('v2list.priority.medium');
}

export function useStatusLabel() {
  const { t } = useI18n();
  return (s: ItemStatus) =>
    s === 'purchased' ? t('item.status.purchased') : s === 'gifted' ? t('item.status.gifted') : t('item.status.active');
}

export function useSortLabel() {
  const { t } = useI18n();
  return (s: ViewSort) => {
    switch (s) {
      case 'priority':
        return t('v2list.sort.priority');
      case 'priceAsc':
        return t('v2list.sort.priceAsc');
      case 'priceDesc':
        return t('v2list.sort.priceDesc');
      case 'recent':
        return t('v2list.sort.recent');
      default:
        return t('v2list.sort.manual');
    }
  };
}

/* ── Картка позиції ────────────────────────────────────────── */

/** Скільки відкриває свайп: рівно кнопка «Видалити». */
const REVEAL = 96;

/**
 * Свайп ліворуч відкриває «Видалити» за карткою (F1). Лише дотик і перо:
 * миша має «⋯». Вертикальний рух віддаємо прокрутці (`touch-action: pan-y`),
 * горизонтальний — картці; рух, що став свайпом, не відкриває позицію.
 */
function useSwipe(enabled: boolean) {
  const [open, setOpen] = useState(false);
  const [drag, setDrag] = useState<number | null>(null);
  const start = useRef<{ x: number; y: number; base: number; axis: 'x' | null } | null>(null);
  const swiped = useRef(false);
  // Останній зсув — у ref: події дотику можуть прийти пачкою між двома
  // рендерами, і відпускання мусить бачити справжнє положення, а не старе.
  const last = useRef(0);

  useEffect(() => {
    if (!enabled) setOpen(false);
  }, [enabled]);

  const handlers = enabled
    ? {
        onPointerDown(e: PointerEvent<HTMLDivElement>) {
          if (e.pointerType === 'mouse') return;
          start.current = { x: e.clientX, y: e.clientY, base: open ? -REVEAL : 0, axis: null };
          swiped.current = false;
        },
        onPointerMove(e: PointerEvent<HTMLDivElement>) {
          const s = start.current;
          if (!s) return;
          const dx = e.clientX - s.x;
          const dy = e.clientY - s.y;
          if (!s.axis) {
            if (Math.abs(dx) > 10 && Math.abs(dx) > Math.abs(dy)) {
              s.axis = 'x';
              swiped.current = true;
              try {
                e.currentTarget.setPointerCapture(e.pointerId);
              } catch {
                /* без захоплення свайп просто коротший */
              }
            } else if (Math.abs(dy) > 10) {
              start.current = null;
              return;
            } else return;
          }
          last.current = Math.max(-REVEAL * 1.4, Math.min(0, s.base + dx));
          setDrag(last.current);
        },
        onPointerUp() {
          const s = start.current;
          start.current = null;
          if (s?.axis === 'x') setOpen(last.current < -REVEAL / 2);
          setDrag(null);
        },
        onPointerCancel() {
          start.current = null;
          setDrag(null);
        },
        // Свайп — не дотик: картка не відкривається. Дотик по відкритій — закриває.
        onClickCapture(e: ReactMouseEvent<HTMLDivElement>) {
          if (swiped.current) {
            swiped.current = false;
            e.preventDefault();
            e.stopPropagation();
          } else if (open) {
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
          }
        },
      }
    : {};

  return {
    handlers,
    offset: drag ?? (open ? -REVEAL : 0),
    revealed: open || (drag ?? 0) < 0,
    dragging: drag !== null,
    close: () => setOpen(false),
  };
}

/**
 * Картка: фото (лише якщо воно є) → назва й ціна → «⋯».
 *
 * Уся картка — кнопка «Змінити»: це найчастіша дія з позицією. Решта — у
 * меню «⋯», яке є на кожній картці однаково (F1): зчитувач екрана знаходить
 * «Видалити» там, де його знаходить палець. Свайп ліворуч — прискорювач
 * того самого «Видалити», не єдиний шлях.
 *
 * На картці немає нічого про позначки гостей — ні пігулки, ні лічильника
 * (ADR-040). Статус «Куплено» / «Подаровано» — власний, його ставить власник.
 */
export function ItemCardV2({
  item,
  currency,
  showPriority,
  highlight,
  failed,
  onOpen,
  onMenu,
  onRetry,
  onDelete,
}: {
  item: Item;
  currency: Currency;
  /** Мітка пріоритету на картці — не в групах «Пріоритет», де його вже каже заголовок. */
  showPriority: boolean;
  /** Щойно додана — контур на 2 с (C4). */
  highlight: boolean;
  /** Видалення не вдалося — пояснення в рядку, не тостом, який уже зник (F, гілка). */
  failed: string | null;
  onOpen: (item: Item) => void;
  onMenu: (item: Item) => void;
  onRetry: (item: Item) => void;
  /** Є — свайп ліворуч відкриває «Видалити». */
  onDelete?: (item: Item) => void;
}) {
  const { t, locale } = useI18n();
  const priority = usePriorityLabel();
  const status = useStatusLabel();
  const swipe = useSwipe(Boolean(onDelete));
  const price = moneyShort(item.price, currency, locale);
  const host = hostOf(item.url);
  const variants = item.variants.map((v) => v.value).join(' · ');
  const tagPriority = showPriority && item.priority !== 'medium';

  return (
    <li
      className="v2-item"
      id={`v2-item-${item.id}`}
      data-status={item.status}
      data-new={highlight || undefined}
      data-failed={failed ? 'true' : undefined}
    >
      <div className="v2-item__row">
        {swipe.revealed && onDelete && (
          <button
            type="button"
            className="v2-item__swipe"
            onClick={() => {
              swipe.close();
              onDelete(item);
            }}
          >
            <Trash2 size={20} strokeWidth={STROKE} aria-hidden="true" />
            {t('v2list.item.delete')}
          </button>
        )}
        <div
          className="v2-item__front"
          data-dragging={swipe.dragging || undefined}
          style={swipe.offset ? { transform: `translateX(${swipe.offset}px)` } : undefined}
          {...swipe.handlers}
        >
          <button type="button" className="v2-item__main" onClick={() => onOpen(item)}>
            {item.image_url && <img className="v2-item__img" src={item.image_url} alt="" loading="lazy" />}
            <span className="v2-item__text">
              <span className="v2-item__title">{item.title}</span>
              <span className="v2-item__meta">
                {price ? <span className="v2-item__price">{price}</span> : t('v2list.item.noPrice')}
                {item.quantity > 1 && ` · × ${item.quantity}`}
                {host && ` · ${host}`}
              </span>
              {variants && <span className="v2-item__meta">{variants}</span>}
              {(tagPriority || item.status !== 'active') && (
                <span className="v2-item__tags">
                  {tagPriority && (
                    <span className="v2-tag" data-tone={item.priority === 'high' ? 'accent' : 'warm'}>
                      {priority(item.priority)}
                    </span>
                  )}
                  {item.status !== 'active' && (
                    <span className="v2-tag" data-tone="neutral">
                      {status(item.status)}
                    </span>
                  )}
                </span>
              )}
            </span>
          </button>
          <button
            type="button"
            className="v2-iconbtn v2-item__more"
            aria-label={t('v2list.item.menu', { title: item.title })}
            onClick={() => onMenu(item)}
          >
            <MoreHorizontal size={22} strokeWidth={STROKE} aria-hidden="true" />
          </button>
        </div>
      </div>
      {failed && (
        <p className="v2-item__failed" role="alert">
          <span>
            {t('v2list.item.deleteFailed')} {failed}
          </span>
          <button type="button" className="v2-btn v2-btn--outline v2-item__retry" onClick={() => onRetry(item)}>
            {t('v2list.item.retry')}
          </button>
        </p>
      )}
    </li>
  );
}

/** Скелет картки точної висоти — поки позиції вантажаться. */
export function ItemSkeletonsV2({ label }: { label: string }) {
  return (
    <>
      <span className="v2-sr">{label}</span>
      <ul className="v2-items" aria-hidden="true">
        {[0, 1, 2].map((i) => (
          <li key={i} className="v2-item v2-item--sk" style={{ animationDelay: `${i * 150}ms` }} />
        ))}
      </ul>
    </>
  );
}

/* ── Меню позиції ──────────────────────────────────────────── */

/**
 * «⋯» на картці: змінити, відкрити в магазині, статус, видалити.
 *
 * Статус — перемикач, а не підтвердження: зміна оборотна тим самим меню.
 * Видалення — без діалогу, тостом «Відмінити» (F1): одна позиція — зворотна дія.
 */
export function ItemMenuV2({
  item,
  onClose,
  onEdit,
  onStatus,
  onDelete,
}: {
  item: Item | null;
  onClose: () => void;
  onEdit: (item: Item) => void;
  onStatus: (item: Item, status: ItemStatus) => void;
  onDelete: (item: Item) => void;
}) {
  const { t } = useI18n();
  const status = useStatusLabel();
  // Поки вікно зачиняється, назва не має блимнути порожнечею: пам'ятаємо
  // останню позицію, але відкрите меню завжди показує ту, що передали.
  const [last, setLast] = useState<Item | null>(item);
  useEffect(() => {
    if (item) setLast(item);
  }, [item]);
  const shown = item ?? last;

  return (
    <SheetV2 open={item !== null} onClose={onClose} labelledBy="v2-item-menu-title">
      <h2 className="v2-sheet__title v2-sheet__title--item" id="v2-item-menu-title">
        {shown?.title}
      </h2>
      {shown && (
        <>
          <div className="v2-menu">
            <button type="button" className="v2-menu__item" onClick={() => onEdit(shown)}>
              <Pencil size={20} strokeWidth={STROKE} aria-hidden="true" />
              {t('v2list.item.edit')}
            </button>
            {shown.url && (
              <a className="v2-menu__item" href={shown.url} target="_blank" rel="noreferrer noopener" onClick={onClose}>
                <ExternalLink size={20} strokeWidth={STROKE} aria-hidden="true" />
                {t('v2list.item.open')}
              </a>
            )}
          </div>
          <fieldset className="v2-seg">
            <legend className="v2-field__label">{t('v2list.item.status')}</legend>
            <div className="v2-seg__row">
              {STATUSES.map((s) => (
                <label key={s} className="v2-seg__opt">
                  <input
                    type="radio"
                    name="v2-item-status"
                    value={s}
                    checked={shown.status === s}
                    onChange={() => onStatus(shown, s)}
                  />
                  <span>{status(s)}</span>
                </label>
              ))}
            </div>
          </fieldset>
          <button type="button" className="v2-menu__item v2-menu__item--danger" onClick={() => onDelete(shown)}>
            <Trash2 size={20} strokeWidth={STROKE} aria-hidden="true" />
            {t('v2list.item.delete')}
          </button>
        </>
      )}
    </SheetV2>
  );
}

/* ── Сортування (O2) ───────────────────────────────────────── */

/**
 * Нижній лист «Сортувати». Вибір застосовується одразу й запам'ятовується
 * для кожного списку окремо. «Вручну» — порядок, який бачать гості.
 */
export function SortSheetV2({
  open,
  value,
  onClose,
  onChange,
}: {
  open: boolean;
  value: ViewSort;
  onClose: () => void;
  onChange: (sort: ViewSort) => void;
}) {
  const { t } = useI18n();
  const label = useSortLabel();
  const hint = (s: ViewSort) =>
    s === 'manual' ? t('v2list.sort.manualHint') : s === 'priority' ? t('v2list.sort.priorityHint') : null;

  return (
    <SheetV2 open={open} onClose={onClose} labelledBy="v2-sort-title">
      <fieldset className="v2-radios">
        <legend className="v2-sheet__title" id="v2-sort-title">
          {t('v2list.sort.title')}
        </legend>
        {VIEW_SORTS.map((s) => (
          <label key={s} className="v2-radio">
            <input
              type="radio"
              name="v2-sort"
              value={s}
              checked={value === s}
              onChange={() => {
                onChange(s);
                onClose();
              }}
            />
            <span className="v2-radio__text">
              <span className="v2-radio__label">{label(s)}</span>
              {hint(s) && <span className="v2-radio__hint">{hint(s)}</span>}
            </span>
          </label>
        ))}
      </fieldset>
    </SheetV2>
  );
}

/* ── Розділи (ADR-036) ─────────────────────────────────────── */

/** Новий розділ або перейменування. Межа назви — з бази (`sections.title`). */
export function SectionSheetV2({
  open,
  section,
  onClose,
  onSave,
}: {
  open: boolean;
  section: Section | null;
  onClose: () => void;
  onSave: (title: string) => Promise<void>;
}) {
  const { t } = useI18n();
  const [title, setTitle] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [server, setServer] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setTitle(section?.title ?? '');
    setSubmitted(false);
    setServer(null);
    setBusy(false);
    ref.current?.focus();
  }, [open, section]);

  async function submit() {
    if (busy) return;
    setSubmitted(true);
    if (!title.trim()) return ref.current?.focus();
    setBusy(true);
    setServer(null);
    try {
      await onSave(title.trim());
      onClose();
    } catch (e) {
      setServer(errorText(e, t));
    } finally {
      setBusy(false);
    }
  }

  return (
    <SheetV2 open={open} onClose={onClose} labelledBy="v2-section-title">
      <form
        className="v2-stack"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h2 className="v2-sheet__title" id="v2-section-title">
          {section ? t('v2list.section.renameTitle') : t('v2list.section.newTitle')}
        </h2>
        {server && <NoteV2 tone="error">{server}</NoteV2>}
        <FieldV2
          ref={ref}
          label={t('v2list.section.name')}
          name="section_title"
          placeholder={t('v2list.section.namePlaceholder')}
          maxLength={SECTION_TITLE_MAX}
          autoComplete="off"
          value={title}
          error={submitted && !title.trim() ? t('v2list.section.nameEmpty') : null}
          onChange={(e) => setTitle(e.target.value)}
        />
        <div className="v2-sheet__actions">
          <SubmitV2
            busy={busy}
            label={section ? t('common.save') : t('v2list.section.create')}
            busyLabel={t('common.saving')}
          />
          <button type="button" className="v2-btn v2-btn--ghost" onClick={onClose}>
            {t('common.cancel')}
          </button>
        </div>
      </form>
    </SheetV2>
  );
}

/**
 * Підтвердження важчої дії (F3 без введення назви): заголовок — наслідок,
 * тіло — побічний ефект, кнопка — дієслово. Безпечна дія — нижче.
 */
export function ConfirmSheetV2({
  open,
  id,
  title,
  body,
  confirmLabel,
  busyLabel,
  busy,
  onConfirm,
  onClose,
  children,
}: {
  open: boolean;
  id: string;
  title: string;
  body: string;
  confirmLabel: string;
  busyLabel: string;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
  children?: ReactNode;
}) {
  const { t } = useI18n();
  return (
    <SheetV2 open={open} onClose={onClose} labelledBy={id}>
      <h2 className="v2-sheet__title" id={id}>
        {title}
      </h2>
      <p className="v2-lede">{body}</p>
      {children}
      <div className="v2-sheet__actions">
        <button
          type="button"
          className="v2-btn v2-btn--danger-fill v2-btn--block"
          aria-disabled={busy || undefined}
          data-busy={busy || undefined}
          onClick={() => {
            if (!busy) onConfirm();
          }}
        >
          {busy && <span className="v2-spinner" aria-hidden="true" />}
          {busy ? busyLabel : confirmLabel}
        </button>
        <button type="button" className="v2-btn v2-btn--ghost" onClick={onClose}>
          {t('common.keep')}
        </button>
      </div>
    </SheetV2>
  );
}

/* ── Тост «Відмінити» (C4, F2) ─────────────────────────────── */

/**
 * Єдиний спосіб скасувати без діалогу. Таймер видно — секунди в колі; кнопка
 * завжди «Відмінити» (правки 2.0). Без мережі зміна йде в ту саму чергу, тож
 * тост поводиться однаково — змінюється лише примітка.
 */
export function UndoToastV2({
  pending,
  until,
  onUndo,
}: {
  pending: Pending | null;
  until: number | null;
  onUndo: () => void;
}) {
  const { t } = useI18n();
  const left = useCountdown(until);
  const [online, setOnline] = useState(() => navigator.onLine);

  useEffect(() => {
    const update = () => setOnline(navigator.onLine);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  if (!pending) return null;

  return (
    <div className="v2-toast" role="status">
      <span className="v2-toast__timer" aria-hidden="true">
        {left}
      </span>
      <span className="v2-toast__text">
        <span className="v2-toast__label">{pending.label}</span>
        {!online && <span className="v2-toast__note">{t('undo.offline')}</span>}
      </span>
      <button type="button" className="v2-toast__btn" onClick={onUndo}>
        {t('v2list.toast.undo')}
      </button>
    </div>
  );
}
