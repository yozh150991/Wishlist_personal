import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import {
  DndContext,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { Announcements, DragEndEvent } from '@dnd-kit/core';
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useI18n } from '../lib/i18n';
import type { Group, Section } from '../lib/sections';
import type { Currency, Item, ItemStatus } from '../lib/types';
import { ItemCard } from './ItemCard';
import { Icon } from './Icon';

/**
 * Режим «Розділи» на сторінці списку (ADR-036).
 *
 * Розділи за їхнім порядком, «Інше» в кінці; усередині — ручний порядок,
 * який бачить гість. Перетягування — за ручку, не за всю картку: інакше на
 * телефоні список не прокручувався б пальцем. Клавіатурою — пробіл, стрілки,
 * пробіл (dnd-kit), з оголошеннями українською для зчитувача екрана.
 *
 * Перетягування працює в межах розділу; перенести позицію в інший розділ —
 * поле «Розділ» у діалозі позиції. Розділи переставляються за ручку в шапці.
 */

type Handlers = {
  currency: Currency;
  onEdit: (item: Item) => void;
  onDelete: (item: Item) => void;
  onSetStatus: (item: Item, status: ItemStatus) => void;
  selectable: boolean;
  selected: Set<string>;
  onToggleSelect: (item: Item) => void;
};

function useAnnouncements(titles: Map<string, string>, positions: (id: string) => number): Announcements {
  const { t } = useI18n();
  const title = (id: string | number) => titles.get(String(id)) ?? '';
  return {
    onDragStart: ({ active }) => t('sections.dnd.picked', { title: title(active.id) }),
    onDragOver: ({ active, over }) =>
      over ? t('sections.dnd.over', { title: title(active.id), n: positions(String(over.id)) }) : undefined,
    onDragEnd: ({ active, over }) =>
      over ? t('sections.dnd.dropped', { title: title(active.id), n: positions(String(over.id)) }) : undefined,
    onDragCancel: () => t('sections.dnd.cancelled'),
  };
}

function useDndSensors() {
  return useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
}

function SortableItem({ item, canReorder, h }: { item: Item; canReorder: boolean; h: Handlers }) {
  const { t } = useI18n();
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: item.id,
    disabled: !canReorder,
  });
  const style: CSSProperties = { transform: CSS.Transform.toString(transform), transition };
  return (
    <ItemCard
      item={item}
      currency={h.currency}
      onEdit={h.onEdit}
      onDelete={h.onDelete}
      onSetStatus={h.onSetStatus}
      selectable={h.selectable}
      selected={h.selected.has(item.id)}
      onToggleSelect={h.onToggleSelect}
      nodeRef={setNodeRef}
      nodeStyle={style}
      dragging={isDragging}
      handle={
        canReorder ? (
          <button
            type="button"
            className="drag-handle"
            aria-label={t('sections.dragItem', { title: item.title })}
            {...attributes}
            {...listeners}
          >
            <Icon name="grip" size={18} />
          </button>
        ) : undefined
      }
    />
  );
}

function ItemsOfGroup({
  group,
  canReorder,
  h,
  onReorder,
}: {
  group: Group;
  canReorder: boolean;
  h: Handlers;
  onReorder: (sectionId: string | null, ids: string[]) => void;
}) {
  const { t } = useI18n();
  const sensors = useDndSensors();
  const ids = group.items.map((i) => i.id);
  const titles = useMemo(() => new Map(group.items.map((i) => [i.id, i.title])), [group.items]);
  const announcements = useAnnouncements(titles, (id) => ids.indexOf(id) + 1);

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = ids.indexOf(String(active.id));
    const to = ids.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onReorder(group.section?.id ?? null, arrayMove(ids, from, to));
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{ announcements, screenReaderInstructions: { draggable: t('sections.dnd.instructions') } }}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <ul className="item-list" data-selecting={h.selectable}>
          {group.items.map((item) => (
            <SortableItem key={item.id} item={item} canReorder={canReorder} h={h} />
          ))}
        </ul>
      </SortableContext>
    </DndContext>
  );
}

type GroupProps = {
  group: Group;
  showHead: boolean;
  canReorder: boolean;
  h: Handlers;
  onReorderItems: (sectionId: string | null, ids: string[]) => void;
  onRename: (s: Section) => void;
  onDelete: (s: Section) => void;
};

type DragBits = {
  setNodeRef?: (el: HTMLElement | null) => void;
  style?: CSSProperties;
  handleProps?: Record<string, unknown>;
  dragging?: boolean;
};

function GroupShell({ group, showHead, canReorder, h, onReorderItems, onRename, onDelete, drag }: GroupProps & { drag: DragBits }) {
  const { t } = useI18n();
  const section = group.section;
  const title = section ? section.title : t('sections.other');

  return (
    <section
      className="section-group"
      ref={drag.setNodeRef}
      style={drag.style}
      data-dragging={Boolean(drag.dragging)}
      aria-label={title}
    >
      {showHead && (
        <header className="section-group__head">
          {section && canReorder && drag.handleProps && (
            <button
              type="button"
              className="drag-handle"
              aria-label={t('sections.dragSection', { title })}
              {...drag.handleProps}
            >
              <Icon name="grip" size={18} />
            </button>
          )}
          <h3 className="section-group__title">{title}</h3>
          <span className="small muted">{t('sections.count', { n: group.items.length })}</span>
          {section && (
            <span className="section-group__actions">
              <button
                type="button"
                className="btn btn--icon btn--ghost"
                aria-label={t('sections.rename', { title })}
                onClick={() => onRename(section)}
              >
                <Icon name="pencil" size={16} />
              </button>
              <button
                type="button"
                className="btn btn--icon btn--ghost"
                aria-label={t('sections.delete', { title })}
                onClick={() => onDelete(section)}
              >
                <Icon name="trash" size={16} />
              </button>
            </span>
          )}
        </header>
      )}
      {group.items.length > 0 && (
        <ItemsOfGroup group={group} canReorder={canReorder} h={h} onReorder={onReorderItems} />
      )}
    </section>
  );
}

/** Розділ, який можна переставити за ручку в шапці. */
function SortableGroup(props: GroupProps & { section: Section }) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: props.section.id,
    disabled: !props.canReorder,
  });
  return (
    <GroupShell
      {...props}
      drag={{
        setNodeRef,
        style: { transform: CSS.Transform.toString(transform), transition },
        handleProps: { ...attributes, ...listeners },
        dragging: isDragging,
      }}
    />
  );
}

export function SectionsView({
  groups,
  canReorder,
  handlers,
  onReorderItems,
  onReorderSections,
  onRenameSection,
  onDeleteSection,
}: {
  groups: Group[];
  canReorder: boolean;
  handlers: Handlers;
  onReorderItems: (sectionId: string | null, ids: string[]) => void;
  onReorderSections: (ids: string[]) => void;
  onRenameSection: (s: Section) => void;
  onDeleteSection: (s: Section) => void;
}) {
  const { t } = useI18n();
  const sensors = useDndSensors();
  const sectionIds = groups.filter((g) => g.section).map((g) => g.section!.id);
  const titles = useMemo(
    () => new Map(groups.filter((g) => g.section).map((g) => [g.section!.id, g.section!.title])),
    [groups],
  );
  const announcements = useAnnouncements(titles, (id) => sectionIds.indexOf(id) + 1);
  const hasSections = sectionIds.length > 0;

  function onDragEnd(e: DragEndEvent) {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    const from = sectionIds.indexOf(String(active.id));
    const to = sectionIds.indexOf(String(over.id));
    if (from < 0 || to < 0) return;
    onReorderSections(arrayMove(sectionIds, from, to));
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragEnd={onDragEnd}
      accessibility={{ announcements, screenReaderInstructions: { draggable: t('sections.dnd.instructions') } }}
    >
      <SortableContext items={sectionIds} strategy={verticalListSortingStrategy}>
        <div className="section-groups">
          {groups.map((g) => {
            const props: GroupProps = {
              group: g,
              showHead: hasSections,
              canReorder,
              h: handlers,
              onReorderItems,
              onRename: onRenameSection,
              onDelete: onDeleteSection,
            };
            if (g.section) return <SortableGroup key={g.section.id} {...props} section={g.section} />;
            // «Інше» не переставляється: воно завжди в кінці. Без розділів
            // воно без шапки — тоді це просто список.
            return g.items.length > 0 ? <GroupShell key="__other" {...props} drag={{}} /> : null;
          })}
        </div>
      </SortableContext>
    </DndContext>
  );
}
