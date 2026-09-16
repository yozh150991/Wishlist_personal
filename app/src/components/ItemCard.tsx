import { hostOf, money } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { STATUSES } from '../lib/types';
import type { Currency, Item, ItemStatus } from '../lib/types';

export function ItemCard({
  item,
  currency,
  onEdit,
  onDelete,
  onSetStatus,
  selectable = false,
  selected = false,
  onToggleSelect,
}: {
  item: Item;
  currency: Currency;
  onEdit: (item: Item) => void;
  onDelete: (item: Item) => void;
  onSetStatus: (item: Item, status: ItemStatus) => void;
  selectable?: boolean;
  selected?: boolean;
  onToggleSelect?: (item: Item) => void;
}) {
  const { t, locale } = useI18n();
  const price = money(item.price, currency, locale);
  const host = hostOf(item.url);

  return (
    <article
      className="card"
      data-status={item.status}
      data-prio={item.priority}
      data-selected={selectable && selected}
    >
      <span className="card__prio" aria-hidden="true" />

      {selectable && (
        <label className="card__select">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect?.(item)}
            aria-label={t('share.selectItem', { title: item.title })}
          />
        </label>
      )}

      {/* Блок картинки з'являється лише за наявності картинки: інакше
          порожній прямокутник 4:3 займає більшу частину картки. */}
      {item.image_url && (
        <div className="card__media">
          <img src={item.image_url} alt="" loading="lazy" />
        </div>
      )}

      <div className="card__body">
        <h3 className="card__title">
          {item.url ? (
            <a href={item.url} target="_blank" rel="noreferrer noopener">
              {item.title}
            </a>
          ) : (
            item.title
          )}
        </h3>

        <p className="card__meta">
          <span className="card__price">{price ?? t('item.noPrice')}</span>
          {item.quantity > 1 && <span className="small"> × {item.quantity}</span>}
          {host && <span className="small card__host">{host}</span>}
        </p>

        {item.note && <p className="small card__note">{item.note}</p>}

        {/* Пріоритет позначається словом у обох крайніх значеннях;
            середній не позначається взагалі — це норма й більшість карток. */}
        <div className="card__tags">
          {item.priority !== 'medium' && (
            <span className="chip chip--prio" data-prio={item.priority}>
              {t(`item.priority.${item.priority}`)}
            </span>
          )}

          <select
            className="card__status"
            aria-label={t('item.actions.statusLabel', { title: item.title })}
            data-status={item.status}
            value={item.status}
            onChange={(e) => onSetStatus(item, e.target.value as ItemStatus)}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {t(`item.status.${s}`)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="card__actions">
        <button className="btn btn--bare" onClick={() => onEdit(item)}>
          {t('item.actions.edit')}
        </button>
        <button className="btn btn--bare" onClick={() => onDelete(item)}>
          {t('item.actions.delete')}
        </button>
      </div>
    </article>
  );
}
