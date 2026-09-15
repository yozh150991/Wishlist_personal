import { useI18n } from '../lib/i18n';
import { PAGE_SIZES, SORT_KEYS, STATUSES } from '../lib/types';
import type { ItemQuery, ItemStatus, PageSize, SortKey } from '../lib/types';

export function Toolbar({
  query,
  onChange,
}: {
  query: ItemQuery;
  onChange: (patch: Partial<ItemQuery>) => void;
}) {
  const { t } = useI18n();

  function toggleStatus(s: ItemStatus) {
    const has = query.statuses.includes(s);
    onChange({ statuses: has ? query.statuses.filter((x) => x !== s) : [...query.statuses, s] });
  }

  return (
    <div className="toolbar">
      <input
        className="toolbar__search"
        type="search"
        placeholder={t('toolbar.search')}
        aria-label={t('toolbar.search')}
        value={query.search}
        onChange={(e) => onChange({ search: e.target.value })}
      />

      <div className="toolbar__group">
        <label className="small" htmlFor="sort">
          {t('toolbar.sort')}
        </label>
        <select
          id="sort"
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
          className="btn btn--quiet"
          onClick={() => onChange({ desc: !query.desc })}
          aria-label={t(query.desc ? 'toolbar.desc' : 'toolbar.asc')}
          title={t(query.desc ? 'toolbar.desc' : 'toolbar.asc')}
        >
          {query.desc ? '↓' : '↑'}
        </button>
      </div>

      <div className="toolbar__group">
        <label className="small" htmlFor="pageSize">
          {t('toolbar.pageSize')}
        </label>
        <select
          id="pageSize"
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

      <div className="picker toolbar__statuses">
        {STATUSES.map((s) => (
          <button
            key={s}
            aria-pressed={query.statuses.includes(s)}
            onClick={() => toggleStatus(s)}
          >
            {t(`item.status.${s}`)}
          </button>
        ))}
      </div>

      <div className="toolbar__group">
        <label className="small" htmlFor="priceMin">
          {t('toolbar.price')}
        </label>
        <input
          id="priceMin"
          className="toolbar__num"
          type="number"
          min="0"
          inputMode="decimal"
          placeholder={t('toolbar.from')}
          value={query.priceMin}
          onChange={(e) => onChange({ priceMin: e.target.value })}
        />
        <input
          className="toolbar__num"
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
  );
}
