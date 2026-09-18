export type ItemStatus = 'active' | 'purchased' | 'gifted';
export type ItemPriority = 'low' | 'medium' | 'high';
export type Currency = 'PLN' | 'UAH' | 'EUR' | 'USD';

export const CURRENCIES: Currency[] = ['PLN', 'UAH', 'EUR', 'USD'];
export const PRIORITIES: ItemPriority[] = ['low', 'medium', 'high'];
export const STATUSES: ItemStatus[] = ['active', 'purchased', 'gifted'];

export type List = {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  currency: Currency;
  event_date: string | null;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
};

export type Item = {
  id: string;
  list_id: string;
  owner_id: string;
  title: string;
  url: string | null;
  price: number | string | null;
  quantity: number;
  priority: ItemPriority;
  note: string | null;
  image_url: string | null;
  status: ItemStatus;
  source_site: string | null;
  parsed_at: string | null;
  created_at: string;
  updated_at: string;
};

/**
 * Поля позиції, які задає людина. Живе тут, а не в `db.ts`, щоб чисті модулі
 * (`outboxOps.ts`) могли на нього спиратися, не тягнучи за собою клієнт бази.
 */
export type ItemInput = Pick<Item, 'title'> &
  Partial<Pick<Item, 'url' | 'price' | 'quantity' | 'priority' | 'note' | 'image_url' | 'status'>>;

export type Totals = {
  items_count: number;
  active_count: number;
  purchased_count: number;
  gifted_count: number;
  total_price: number | string;
  active_price: number | string;
  items_no_price: number;
};

export type SortKey = 'created_at' | 'title' | 'price' | 'priority';
export const SORT_KEYS: SortKey[] = ['created_at', 'title', 'price', 'priority'];
export const PAGE_SIZES = [10, 25, 50, 100] as const;
export type PageSize = (typeof PAGE_SIZES)[number];

export type ItemQuery = {
  sort: SortKey;
  desc: boolean;
  pageSize: PageSize;
  search: string;
  statuses: ItemStatus[];
  priceMin: string;
  priceMax: string;
};

export const DEFAULT_QUERY: ItemQuery = {
  sort: 'created_at',
  desc: true,
  pageSize: 25,
  search: '',
  statuses: [],
  priceMin: '',
  priceMax: '',
};
