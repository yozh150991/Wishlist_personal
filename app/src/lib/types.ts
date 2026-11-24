export type ItemStatus = 'active' | 'purchased' | 'gifted';
export type ItemPriority = 'low' | 'medium' | 'high';
export type Currency = 'PLN' | 'UAH' | 'EUR' | 'USD';

export const CURRENCIES: Currency[] = ['PLN', 'UAH', 'EUR', 'USD'];
export const PRIORITIES: ItemPriority[] = ['low', 'medium', 'high'];
export const STATUSES: ItemStatus[] = ['active', 'purchased', 'gifted'];

/**
 * Ознака товару: «Розмір → M», «Колір → чорний» (ADR-030).
 *
 * Форму повторює check-обмеження `items_variants_shape`: до пʼяти пар, підпис
 * до 40 символів, значення до 80, обидва непорожні й без переносів рядка.
 * Межі продубльовано тут, щоб форма перевіряла їх до відправки (CLAUDE.md §4).
 */
export type ItemVariant = { label: string; value: string };

export const VARIANTS_MAX = 5;
export const VARIANT_LABEL_MAX = 40;
export const VARIANT_VALUE_MAX = 80;

/** Підписи, які пропонуються в полі: найчастіші й не більше. */
export const VARIANT_LABEL_HINTS = ['size', 'color', 'model'] as const;

export type List = {
  id: string;
  owner_id: string;
  title: string;
  description: string | null;
  currency: Currency;
  event_date: string | null;
  /** Оформлення списку (ADR-034); null — без оформлення. Старий офлайн-знімок його не має. */
  appearance_id?: string | null;
  is_archived: boolean;
  /** Щорічне свято (ADR-047): за місяць до дати v2 пропонує повторити список. Старий знімок поля не має. */
  repeats_yearly?: boolean;
  /**
   * Подяка гостям (ADR-059): гість бачить її на сторінці списку. Старий знімок
   * поля не має.
   */
  thanks_message?: string | null;
  /** Коли подяку вперше збережено — тоді ж пішли листи. Ставить лише база. */
  thanks_sent_at?: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Скільки позицій у списку. Не колонка: агрегат із `fetchLists`, потрібен
   * лише картці на сторінці списків. Старий офлайн-знімок його не має, тому
   * читається як необовʼязковий.
   */
  item_count?: number;
  /** Скільки з них ще актуальні — лише з `fetchListsOverview` (головна v2). */
  active_count?: number;
};

/** unknown — не перевіряли чи нічого певного, ok — є, out — немає в наявності, gone — сторінки немає. */
export type LinkStatus = 'unknown' | 'ok' | 'out' | 'gone';

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
  variants: ItemVariant[];
  image_url: string | null;
  status: ItemStatus;
  source_site: string | null;
  parsed_at: string | null;
  /** Розділ (ADR-036); null — «Інше». Старий офлайн-знімок поля не має. */
  section_id?: string | null;
  /** Ручний порядок у розділі; null — ще не впорядковано. */
  position?: number | null;
  /**
   * Чернетка без назви (ADR-046): у `title` — адреса. Гостям невидима. Старий
   * офлайн-знімок поля не має — тоді це не чернетка.
   */
  needs_title?: boolean;
  /**
   * Щоденна перевірка посилання (ADR-048): що побачив сервіс wishlist-jobs.
   * Пише лише він; старий знімок полів не має — тоді «не перевіряли».
   */
  link_status?: LinkStatus;
  link_checked_at?: string | null;
  link_price?: number | string | null;
  link_currency?: string | null;
  /**
   * Валюта ціни (ADR-051); null — валюта списку, як до ADR-051 і як у v1.
   * Старий офлайн-знімок поля не має — теж валюта списку. Читати через
   * `itemCurrency()` з `lib/itemsView.ts`, а не напряму.
   */
  currency?: Currency | null;
  /**
   * «Повідомити, коли ціна ≤ X» (8.16) — у валюті позиції; null — без цілі.
   * Старий офлайн-знімок поля не має — теж без цілі.
   */
  price_target?: number | string | null;
  /** Коли ціль задано і з якого моменту ціна не вища за неї — веде лише тригер бази. */
  price_target_set_at?: string | null;
  price_target_hit_at?: string | null;
  created_at: string;
  updated_at: string;
};

/** Точка історії ціни в магазині (8.16): одна на позицію на день, пише лише wishlist-jobs. */
export type ItemPrice = {
  item_id: string;
  /** День перевірки, `YYYY-MM-DD` (UTC). */
  day: string;
  price: number | string;
  /** Як сказав магазин; null — не сказав, тоді це валюта позиції. */
  currency: string | null;
  /** Звідки ціна: поки лише `check` — щоденна перевірка посилання. */
  source: 'check';
  checked_at: string;
};

/**
 * Поля позиції, які задає людина. Живе тут, а не в `db.ts`, щоб чисті модулі
 * (`outboxOps.ts`) могли на нього спиратися, не тягнучи за собою клієнт бази.
 */
export type ItemInput = Pick<Item, 'title'> &
  Partial<
    Pick<
      Item,
      | 'url'
      | 'price'
      | 'quantity'
      | 'priority'
      | 'note'
      | 'variants'
      | 'image_url'
      | 'status'
      | 'section_id'
      | 'position'
      | 'needs_title'
      | 'currency'
      | 'price_target'
    >
  >;

/** Розділ списку (ADR-036): одна мітка на позицію, порядок задає власник. */
export type Section = {
  id: string;
  list_id: string;
  title: string;
  position: number;
  created_at: string;
};

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
