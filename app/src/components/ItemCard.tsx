import { hostOf, money } from '../lib/format';
import { useI18n } from '../lib/i18n';
import { STATUSES } from '../lib/types';
import type { Currency, Item, ItemStatus } from '../lib/types';

/**
 * Картка позиції — горизонтальна: смужка пріоритету → картинка → текст.
 *
 * Вертикальна сітка плиток гарна на вітрині магазину, але вішліст читають
 * рядками: назва й ціна мають бути на одній лінії сканування.
 *
 * У режимі вибору картка **втрачає** «Змінити» й «Видалити» — щоб не було двох
 * способів діяти з однією позицією, — і замість рядка дій показує компактне
 * «ціна · статус».
 */
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
  const statusLabel = t(`item.status.${item.status}`);

  return (
    <li className="item" data-status={item.status} data-selected={selectable && selected}>
      {selectable && (
        <label className="item__pick">
          <input
            type="checkbox"
            checked={selected}
            onChange={() => onToggleSelect?.(item)}
            aria-label={t('share.selectItem', { title: item.title })}
          />
        </label>
      )}

      {/* Смужка стоїть завжди, навіть прозора на середньому пріоритеті:
          інакше текст карток стрибав би вліво-вправо по списку. */}
      <span className="prio" data-prio={item.priority} aria-hidden="true" />

      {/* Картинка тільки за наявності: порожній прямокутник з'їдає піврядка
          і нічого не каже. */}
      {item.image_url && (
        <img className="item__image" src={item.image_url} alt="" loading="lazy" />
      )}

      <div className="item__body">
        <div className="item__line">
          <h3 className="item__title">
            {item.url ? (
              <a href={item.url} target="_blank" rel="noreferrer noopener">
                {item.title}
              </a>
            ) : (
              item.title
            )}
          </h3>
          {/* Середній пріоритет не позначається ніколи — це більшість карток. */}
          {item.priority !== 'medium' && (
            <span className={item.priority === 'high' ? 'tag tag--accent' : 'tag tag--accent-2'}>
              {t(`item.priority.${item.priority}`)}
            </span>
          )}
        </div>

        {selectable ? (
          <p className="item__compact muted">
            {price ?? t('item.noPrice')}
            {item.quantity > 1 && ` · × ${item.quantity}`}
            {` · ${statusLabel}`}
          </p>
        ) : (
          <>
            <p className="item__meta">
              {price ? (
                <span className="item__price">{price}</span>
              ) : (
                <span className="muted">{t('item.noPrice')}</span>
              )}
              {item.quantity > 1 && <span className="meta muted">× {item.quantity}</span>}
              {host && <span className="meta muted">{host}</span>}
            </p>

            {/* Ознаки йдуть перед нотаткою: це те, за чим подарунок вибирають,
                а нотатка — вільний текст, який може бути довгим. */}
            {item.variants.length > 0 && (
              <ul className="variants-chips">
                {item.variants.map((v, i) => (
                  <li className="tag tag--neutral" key={i}>
                    <span className="muted">{v.label}</span>&nbsp;{v.value}
                  </li>
                ))}
              </ul>
            )}

            {item.note && <p className="small muted">{item.note}</p>}

            <div className="item__actions">
              {/* Статус лишається нативним <select>, хоч і виглядає кнопкою:
                  свій список довелося б навчати клавіатурі й зчитувачам екрана
                  з нуля, а виграш — самі лише трикутник і шрифт. */}
              <select
                className="item__status"
                aria-label={t('item.actions.statusLabel', { title: item.title })}
                value={item.status}
                onChange={(e) => onSetStatus(item, e.target.value as ItemStatus)}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {t(`item.status.${s}`)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn--ghost btn--compact"
                aria-label={t('item.actions.editLabel', { title: item.title })}
                onClick={() => onEdit(item)}
              >
                {t('item.actions.edit')}
              </button>
              <button
                type="button"
                className="btn btn--ghost btn--compact btn--danger"
                aria-label={t('item.actions.deleteLabel', { title: item.title })}
                onClick={() => onDelete(item)}
              >
                {t('item.actions.delete')}
              </button>
            </div>
          </>
        )}
      </div>
    </li>
  );
}
