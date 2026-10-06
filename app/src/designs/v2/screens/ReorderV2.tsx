import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import { DndContext, KeyboardSensor, PointerSensor, closestCenter, useSensor, useSensors } from '@dnd-kit/core';
import type { Announcements, DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { itemCurrency } from '../../../lib/itemsView';
import { useI18n } from '../../../lib/i18n';
import { moneyShort } from '../../../lib/format';
import type { Currency, Item, Section } from '../../../lib/types';

const STROKE = 2.75;

export type OrderGroup = { key: string; section: Section | null; items: Item[] };

/**
 * «Змінити порядок» — окремий режим (потік V3), щоб перетягування не
 * заважало свайпу й дотику по картці. Порядок той, що бачать гості (ADR-036):
 * розділи за їхнім порядком, «Інше» в кінці, усередині — позиції.
 *
 * Два способи на кожну дію: перетягнути за ручку (мишею, пальцем чи
 * клавіатурою — dnd-kit) і кнопки «Вище / Нижче», які читає зчитувач екрана
 * й натискає той, кому перетягувати незручно. Після кнопки фокус лишається на
 * тій самій позиції, а живий рядок каже, куди вона стала.
 *
 * Переносити між розділами — полем «Розділ» у формі позиції: так само, як у v1.
 */
export function ReorderV2({
  groups,
  currency,
  onMoveItems,
  onMoveSections,
}: {
  groups: OrderGroup[];
  currency: Currency;
  onMoveItems: (sectionId: string | null, ids: string[]) => void;
  onMoveSections: (ids: string[]) => void;
}) {
  const { t } = useI18n();
  const [announce, setAnnounce] = useState('');
  const focusAfter = useRef<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const sectionIds = groups.filter((g) => g.section).map((g) => g.section!.id);
  const heads = sectionIds.length > 0;

  // Фокус — туди ж, де був натиск: DOM переставився, і браузер міг його загубити.
  useEffect(() => {
    const key = focusAfter.current;
    if (!key) return;
    focusAfter.current = null;
    const el = root.current?.querySelector<HTMLButtonElement>(`[data-move="${key}"]`);
    if (el && !el.disabled) el.focus();
    else {
      const [id] = key.split(':');
      root.current?.querySelector<HTMLButtonElement>(`[data-move^="${id}:"]:not(:disabled)`)?.focus();
    }
  }, [groups]);

  function moveItem(group: OrderGroup, index: number, dir: -1 | 1) {
    const ids = group.items.map((i) => i.id);
    const to = index + dir;
    if (to < 0 || to >= ids.length) return;
    const item = group.items[index]!;
    focusAfter.current = `${item.id}:${dir}`;
    setAnnounce(t('sections.dnd.dropped', { title: item.title, n: to + 1 }));
    onMoveItems(group.section?.id ?? null, arrayMove(ids, index, to));
  }

  function moveSection(section: Section, dir: -1 | 1) {
    const from = sectionIds.indexOf(section.id);
    const to = from + dir;
    if (from < 0 || to < 0 || to >= sectionIds.length) return;
    focusAfter.current = `${section.id}:${dir}`;
    setAnnounce(t('sections.dnd.dropped', { title: section.title, n: to + 1 }));
    onMoveSections(arrayMove(sectionIds, from, to));
  }

  return (
    <div className="v2-groups" ref={root}>
      <p className="v2-sr" role="status" aria-live="polite">
        {announce}
      </p>
      {groups.map((g, gi) => {
        const title = g.section ? g.section.title : t('v2list.group.other');
        const headingId = `v2-order-${gi}`;
        const si = g.section ? sectionIds.indexOf(g.section.id) : -1;
        return (
          <section key={g.key} className="v2-group" aria-labelledby={heads ? headingId : undefined}>
            {heads && (
              <div className="v2-group__head">
                <h2 className="v2-kicker v2-group__title" id={headingId}>
                  {title} · {g.items.length}
                </h2>
                {g.section && (
                  <span className="v2-order__arrows">
                    <button
                      type="button"
                      className="v2-iconbtn"
                      data-move={`${g.section.id}:-1`}
                      aria-label={t('v2list.reorder.sectionUp', { title })}
                      disabled={si <= 0}
                      onClick={() => moveSection(g.section!, -1)}
                    >
                      <ArrowUp size={20} strokeWidth={STROKE} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="v2-iconbtn"
                      data-move={`${g.section.id}:1`}
                      aria-label={t('v2list.reorder.sectionDown', { title })}
                      disabled={si >= sectionIds.length - 1}
                      onClick={() => moveSection(g.section!, 1)}
                    >
                      <ArrowDown size={20} strokeWidth={STROKE} aria-hidden="true" />
                    </button>
                  </span>
                )}
              </div>
            )}
            {g.items.length > 0 ? (
              <SortableItems
                group={g}
                currency={currency}
                onDrop={(ids) => onMoveItems(g.section?.id ?? null, ids)}
                onButton={(index, dir) => moveItem(g, index, dir)}
              />
            ) : (
              <p className="v2-hint v2-hint--start">{t('v2list.group.emptySection')}</p>
            )}
          </section>
        );
      })}
    </div>
  );
}

function SortableItems({
  group,
  currency,
  onDrop,
  onButton,
}: {
  group: OrderGroup;
  currency: Currency;
  onDrop: (ids: string[]) => void;
  onButton: (index: number, dir: -1 | 1) => void;
}) {
  const { t } = useI18n();
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const ids = group.items.map((i) => i.id);
  const titles = useMemo(() => new Map(group.items.map((i) => [i.id, i.title])), [group.items]);
  const title = (id: string | number) => titles.get(String(id)) ?? '';
  const place = (id: string | number) => ids.indexOf(String(id)) + 1;
  const announcements: Announcements = {
    onDragStart: ({ active }) => t('sections.dnd.picked', { title: title(active.id) }),
    onDragOver: ({ active, over }) =>
      over ? t('sections.dnd.over', { title: title(active.id), n: place(over.id) }) : undefined,
    onDragEnd: ({ active, over }) =>
      over ? t('sections.dnd.dropped', { title: title(active.id), n: place(over.id) }) : undefined,
    onDragCancel: () => t('sections.dnd.cancelled'),
  };

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onDrop(arrayMove(ids, from, to));
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{ announcements, screenReaderInstructions: { draggable: t('sections.dnd.instructions') } }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className="v2-items">
          {group.items.map((item, index) => (
            <SortableRow
              key={item.id}
              item={item}
              currency={currency}
              first={index === 0}
              last={index === group.items.length - 1}
              onButton={(dir) => onButton(index, dir)}
            />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

function SortableRow({
  item,
  currency,
  first,
  last,
  onButton,
}: {
  item: Item;
  currency: Currency;
  first: boolean;
  last: boolean;
  onButton: (dir: -1 | 1) => void;
}) {
  const { t, locale } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: item.id });
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition };
  const price = moneyShort(item.price, itemCurrency(item, currency), locale);
  return (
    <li ref={setNodeRef} style={style} className="v2-order" data-dragging={isDragging || undefined}>
      <button
        type="button"
        className="v2-iconbtn v2-order__grip"
        aria-label={t('sections.dragItem', { title: item.title })}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={20} strokeWidth={STROKE} aria-hidden="true" />
      </button>
      {item.image_url && <img className="v2-item__img" src={item.image_url} alt="" loading="lazy" />}
      <span className="v2-item__text">
        <span className="v2-item__title">{item.title}</span>
        <span className="v2-item__meta">
          {price ? <span className="v2-item__price">{price}</span> : t('v2list.item.noPrice')}
        </span>
      </span>
      <span className="v2-order__arrows">
        <button
          type="button"
          className="v2-iconbtn"
          data-move={`${item.id}:-1`}
          aria-label={t('v2list.reorder.up', { title: item.title })}
          disabled={first}
          onClick={() => onButton(-1)}
        >
          <ArrowUp size={20} strokeWidth={STROKE} aria-hidden="true" />
        </button>
        <button
          type="button"
          className="v2-iconbtn"
          data-move={`${item.id}:1`}
          aria-label={t('v2list.reorder.down', { title: item.title })}
          disabled={last}
          onClick={() => onButton(1)}
        >
          <ArrowDown size={20} strokeWidth={STROKE} aria-hidden="true" />
        </button>
      </span>
    </li>
  );
}
