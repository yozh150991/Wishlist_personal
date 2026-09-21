import { useEffect, useRef } from 'react';
import { useI18n } from '../lib/i18n';
import { useMediaQuery } from '../lib/media';
import { DEFAULT_QUERY, PAGE_SIZES, SORT_KEYS, STATUSES } from '../lib/types';
import type { ItemQuery, ItemStatus, PageSize, SortKey } from '../lib/types';
import { Icon } from './Icon';

/**
 * Скільки фільтрів відрізняються від усталених. Пошук сюди не входить: він
 * завжди на екрані й видно його сам.
 */
export function activeFilterCount(q: ItemQuery): number {
  let n = 0;
  if (q.sort !== DEFAULT_QUERY.sort || q.desc !== DEFAULT_QUERY.desc) n++;
  if (q.pageSize !== DEFAULT_QUERY.pageSize) n++;
  if (q.statuses.length !== DEFAULT_QUERY.statuses.length) n++;
  if (q.priceMin) n++;
  if (q.priceMax) n++;
  return n;
}

export function isFiltered(q: ItemQuery): boolean {
  return activeFilterCount(q) > 0 || q.search.trim() !== '';
}

/**
 * Ширина, з якої фільтри стоять розгорнутою панеллю, а не листом. Те саме
 * число — у `styles.css` (`.filters__panel`, `.filters__toggle`): там воно
 * задає оформлення, тут — яку з двох оправ узагалі малювати. Розійдуться —
 * людина побачить порожнє місце замість фільтрів.
 */
const PANEL_FROM = '(min-width: 56rem)';

/** Групи фільтрів. Однакові на телефоні й десктопі — різниться лише оправа. */
function Groups({
  query,
  onChange,
}: {
  query: ItemQuery;
  onChange: (patch: Partial<ItemQuery>) => void;
}) {
  const { t } = useI18n();

  function toggleStatus(s: ItemStatus) {
    const has = query.statuses.includes(s);
    // Останній статус не знімається: порожній набір дав би порожній екран,
    // на якому незрозуміло, що робити далі.
    if (has && query.statuses.length === 1) return;
    onChange({ statuses: has ? query.statuses.filter((x) => x !== s) : [...query.statuses, s] });
  }

  return (
    <>
      <div className="filters__group" role="group" aria-labelledby="f-status">
        <span className="filters__label" id="f-status">
          {t('toolbar.status')}
        </span>
        <div className="filters__row">
          {STATUSES.map((s) => (
            <button
              key={s}
              type="button"
              className={
                query.statuses.includes(s) ? 'btn btn--primary' : 'btn btn--secondary'
              }
              aria-pressed={query.statuses.includes(s)}
              onClick={() => toggleStatus(s)}
            >
              {t(`item.status.${s}`)}
            </button>
          ))}
        </div>
      </div>

      <div className="filters__group">
        <label className="filters__label" htmlFor="f-sort">
          {t('toolbar.sort')}
        </label>
        <div className="filters__row">
          <select
            id="f-sort"
            className="input"
            value={query.sort}
            onChange={(e) => onChange({ sort: e.target.value as SortKey })}
          >
            {SORT_KEYS.map((k) => (
              <option key={k} value={k}>
                {t(`toolbar.sortBy.${k}`)}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="btn btn--secondary btn--icon"
            aria-label={t(query.desc ? 'toolbar.desc' : 'toolbar.asc')}
            onClick={() => onChange({ desc: !query.desc })}
          >
            {query.desc ? '↓' : '↑'}
          </button>
        </div>
      </div>

      <div className="filters__group">
        <span className="filters__label" id="f-price">
          {t('toolbar.price')}
        </span>
        <div className="filters__row filters__row--price">
          <input
            className="input"
            type="number"
            min="0"
            inputMode="decimal"
            placeholder={t('toolbar.from')}
            aria-label={t('toolbar.from')}
            value={query.priceMin}
            onChange={(e) => onChange({ priceMin: e.target.value })}
          />
          <span className="muted" aria-hidden="true">
            —
          </span>
          <input
            className="input"
            type="number"
            min="0"
            inputMode="decimal"
            placeholder={t('toolbar.to')}
            aria-label={t('toolbar.to')}
            value={query.priceMax}
            onChange={(e) => onChange({ priceMax: e.target.value })}
          />
        </div>
      </div>

      <div className="filters__group">
        <label className="filters__label" htmlFor="f-size">
          {t('toolbar.pageSize')}
        </label>
        <div className="filters__row">
          <select
            id="f-size"
            className="input"
            value={query.pageSize}
            onChange={(e) => onChange({ pageSize: Number(e.target.value) as PageSize })}
          >
            {PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
      </div>
    </>
  );
}

/**
 * Пошук завжди на екрані, решта фільтрів — за кнопкою.
 *
 * Значок кількості активних фільтрів стоїть **усередині** кнопки: при звуженні
 * до самої іконки він переїде в кут, а не зникне.
 *
 * Відхилення від макета, свідоме: фільтри застосовуються одразу, а не після
 * кнопки «Показати N позицій». Наш список і так перечитується на кожну зміну,
 * тож відкладене застосування означало б показувати число, яке ще ніхто не
 * рахував, — довелося б заводити окремий запит на кількість лише заради
 * підпису кнопки. Натомість людина бачить результат за фільтрами одразу, а
 * кнопка внизу листа просто закриває його.
 */
export function Filters({
  query,
  onChange,
  onReset,
  open,
  onOpen,
  onClose,
}: {
  query: ItemQuery;
  onChange: (patch: Partial<ItemQuery>) => void;
  onReset: () => void;
  open: boolean;
  onOpen: () => void;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const sheet = useRef<HTMLDialogElement>(null);
  const count = activeFilterCount(query);
  // Оправа рівно одна: або панель, або лист. Групи всередині однакові, і
  // намальовані двічі вони дали б по два контроли з тим самим `id`.
  const wide = useMediaQuery(PANEL_FROM);

  useEffect(() => {
    const el = sheet.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  // Вікно розтягнули, поки лист відкритий: фільтри вже в панелі, а стан
  // «лист відкрито» лишився б висіти й не дав би відкрити його знову.
  useEffect(() => {
    if (wide && open) onClose();
  }, [wide, open, onClose]);

  return (
    <>
      <search className="filters__search">
        <span className="filters__search-field">
          <span className="filters__search-icon">
            <Icon name="search" size={16} />
          </span>
          <input
            className="input"
            type="search"
            placeholder={t('toolbar.search')}
            aria-label={t('toolbar.search')}
            value={query.search}
            onChange={(e) => onChange({ search: e.target.value })}
          />
        </span>
        {!wide && (
          <button
            type="button"
            className={count > 0 ? 'btn btn--primary filters__toggle' : 'btn btn--secondary filters__toggle'}
            aria-expanded={open}
            aria-haspopup="dialog"
            onClick={onOpen}
          >
            <Icon name="filter" size={16} />
            {t('toolbar.filters')}
            {count > 0 && <span className="filters__badge">{count}</span>}
          </button>
        )}
      </search>

      {wide ? (
        /* Десктоп: ті самі групи в один ряд, без листа. */
        <div className="filters__panel">
          <Groups query={query} onChange={onChange} />
          {count > 0 && (
            <button type="button" className="btn btn--ghost" onClick={onReset}>
              {t('toolbar.reset')}
            </button>
          )}
        </div>
      ) : (
        /* Телефон: нижній лист. */
        <dialog className="dialog sheet" ref={sheet} onClose={onClose} onCancel={onClose}>
          <div className="dialog__head">
            <h2>{t('toolbar.filters')}</h2>
            <button type="button" className="btn btn--ghost btn--compact" onClick={onReset}>
              {t('toolbar.resetAll')}
            </button>
            <button
              type="button"
              className="btn btn--icon btn--secondary"
              onClick={onClose}
              aria-label={t('common.close')}
            >
              <Icon name="x" size={18} />
            </button>
          </div>
          <div className="dialog__body filters__sheet-body">
            <Groups query={query} onChange={onChange} />
          </div>
          <div className="dialog__foot">
            <button type="button" className="btn btn--primary btn--block" onClick={onClose}>
              {t('toolbar.done')}
            </button>
          </div>
        </dialog>
      )}
    </>
  );
}
