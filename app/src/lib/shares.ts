import { supabase, publicOrigin } from './supabase';
import type { Currency, ItemPriority, ItemStatus, ItemVariant } from './types';
import { isScheme } from './appearance';
import { deviceTimeZone } from './zones';
import { isNetworkError } from './errors';
import type { Scheme } from './appearance';

export type Share = {
  id: string;
  owner_id: string;
  source_list_id: string;
  token: string;
  title: string;
  message: string | null;
  hide_prices: boolean;
  allow_reservations: boolean;
  expires_at: string | null;
  /** IANA-зона власника, у якій рахується «діє до» (ADR-037); null — без зони. */
  expires_tz: string | null;
  revoked_at: string | null;
  view_count: number;
  last_viewed_at: string | null;
  created_at: string;
};

export type ShareWithCount = Share & { share_items: { count: number }[] };

export type ShareInput = {
  listId: string;
  itemIds: string[];
  title: string;
  message?: string | null;
  hidePrices?: boolean;
  allowReservations?: boolean;
  /** День `YYYY-MM-DD`, до кінця якого діє посилання, — за зоною власника. */
  expiresOn?: string | null;
};

export function shareUrl(token: string): string {
  return `${publicOrigin.replace(/\/$/, '')}/s/${token}`;
}

export async function createShare(input: ShareInput): Promise<Share> {
  const base = {
    p_list_id: input.listId,
    p_item_ids: input.itemIds,
    p_title: input.title,
    p_message: input.message ?? null,
    p_hide_prices: input.hidePrices ?? false,
    p_allow_reservations: input.allowReservations ?? true,
  };
  const on = input.expiresOn ?? null;
  const tz = on ? deviceTimeZone() : null;

  // Звичайний шлях: дата + зона, момент рахує база (ADR-037).
  if (!on || tz) {
    const { data, error } = await supabase.rpc('create_share', {
      ...base,
      ...(on ? { p_expires_on: on, p_expires_tz: tz } : {}),
    });
    if (!error) return data as Share;
    // PGRST202 — у базі ще стара create_share без p_expires_on: фронтенд
    // уже задеплоєно, а міграцію ще ні (DEPLOY.md, розділ 7).
    const retry = /bad_time_zone/.test(error.message ?? '') || error.code === 'PGRST202';
    if (!on || !retry) throw error;
  }

  // Браузер не назвав зону, база її не знає або ще не вміє зон: кінець дня
  // за годинником пристрою, як до ADR-037. Посилання згасне вчасно, просто
  // гість не побачить назви зони.
  const { data, error } = await supabase.rpc('create_share', {
    ...base,
    p_expires_at: new Date(`${on}T23:59:59`).toISOString(),
  });
  if (error) throw error;
  return data as Share;
}

export async function fetchShares(): Promise<ShareWithCount[]> {
  const { data, error } = await supabase
    .from('shares')
    .select('*, share_items(count)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as ShareWithCount[];
}

/** Посилання з назвою списку, з якого його створено, — для «Моїх посилань» v2. */
export type ShareOverview = ShareWithCount & { list_title: string | null };

/**
 * Посилання разом із назвою їхнього списку. Список — власника, тож RLS
 * пропускає вкладення так само, як і самі посилання. Якщо сервер вкладення не
 * прийме, картки просто лишаються без назви списку: помилка мережі йде нагору,
 * решта — у запасний `fetchShares()`.
 */
export async function fetchSharesOverview(): Promise<ShareOverview[]> {
  const { data, error } = await supabase
    .from('shares')
    .select('*, share_items(count), list:lists(title)')
    .order('created_at', { ascending: false });
  if (error) {
    if (isNetworkError(error)) throw error;
    return (await fetchShares()).map((s) => ({ ...s, list_title: null }));
  }
  type Row = ShareWithCount & { list?: { title: string } | null };
  return ((data ?? []) as Row[]).map(({ list, ...s }) => ({ ...s, list_title: list?.title ?? null }));
}

/** Відкликання, а не видалення: історія і лічильник переглядів лишаються. */
export async function revokeShare(id: string): Promise<void> {
  const { error } = await supabase
    .from('shares')
    .update({ revoked_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function deleteShare(id: string): Promise<void> {
  const { error } = await supabase.from('shares').delete().eq('id', id);
  if (error) throw error;
}

/**
 * Скільки разів відкривали посилання на цей список — усі, зокрема відкликані й
 * протерміновані. Потрібно видаленню списку в v2 (потік F3): назву рукою
 * просимо ввести, щойно список хтось бачив, — а не за позначками, щоб діалог
 * не видав сюрприз. Це лічильник переглядів самих посилань: його власник і
 * так бачить у «Моїх посиланнях», позначок гостей він не торкається.
 */
export async function fetchListViews(listId: string): Promise<number> {
  const { data, error } = await supabase.from('shares').select('view_count').eq('source_list_id', listId);
  if (error) throw error;
  return ((data ?? []) as { view_count: number | null }[]).reduce((n, r) => n + (r.view_count ?? 0), 0);
}

/* ── Гостьова частина ───────────────────────── */

export type SharedItem = {
  id: string;
  title: string;
  url: string | null;
  price: number | string | null;
  /**
   * Валюта ціни позиції (ADR-051), уже розгорнута сервером: валюта позиції
   * або списку. Необовʼязкова — відповідь до ADR-051 її не мала.
   */
  currency?: Currency;
  quantity: number;
  priority: ItemPriority;
  note: string | null;
  /** Ознаки товару (ADR-030). Від `hide_prices` не залежать — це не ціна. */
  variants: ItemVariant[];
  image_url: string | null;
  status: ItemStatus;
  created_at: string;
  /** Розділ (ADR-036); null — «Інше». */
  section_id: string | null;
  /** Скільки штук узяли всі гості разом; null, коли дивиться власник (ADR-009). */
  taken_qty: number | null;
  /** Скільки взяв саме цей гість (за ключем); null для власника. */
  mine_qty: number | null;
};

export type GuestInfo = { code: string; name?: string | null; email?: string | null };

export type SharedList = {
  title: string;
  message: string | null;
  currency: Currency;
  /** Схема власника: гість бачить список у ній (resolveAppearance, правило 3). */
  owner_scheme: Scheme;
  /** Відтінок оформлення списку або null (ADR-034). Назва оформлення гостю не йде. */
  appearance_hue: number | null;
  /** Дата події для шапки гостьової. */
  event_date: string | null;
  /** До коли діє посилання (момент) і в чиїй зоні це рахувати (ADR-037). */
  expires_at: string | null;
  expires_tz: string | null;
  hide_prices: boolean;
  allow_reservations: boolean;
  viewer_is_owner: boolean;
  /**
   * Ключ гостя впізнано — ось його короткий код. null — ключа немає або він
   * чужий. Гостьова v2 (`get_guest_list`) додає підпис і пошту, які гість
   * вписав сам (ADR-053); v1 їх не отримує й не показує.
   */
  guest: GuestInfo | null;
  /** Розділи зі спільними позиціями, у порядку власника (ADR-036). */
  sections: { id: string; title: string }[];
  /** У ручному порядку власника: розділи, усередині — його порядок, «Інше» в кінці. */
  items: SharedItem[];
};

/**
 * Посилання недоступне — одна відповідь на всі три причини (ADR-035): сервер
 * не каже, чи токен не існував, відкликаний, чи протермінований, і сторінка
 * теж не має цього підтверджувати.
 */
export class GoneError extends Error {
  constructor() {
    super('not_found');
  }
}

function rpcError(error: { message?: string; code?: string } | null): Error {
  const msg = (error?.message || '').toLowerCase();
  if (msg.includes('not_found')) return new GoneError();
  return new Error(error?.message || 'unknown');
}

export async function fetchSharedList(token: string, key: string | null): Promise<SharedList> {
  const { data, error } = await supabase.rpc('get_shared_list', { p_token: token, p_key: key });
  if (error) throw rpcError(error);
  return normalizeShared(data);
}

/**
 * Гостьова v2 (ADR-053): те саме, що `get_shared_list`, плюс підпис і пошта
 * гостя в `guest` — лише для його ключа. Власнику `guest` приходить null.
 */
export async function fetchGuestList(token: string, key: string | null): Promise<SharedList> {
  const { data, error } = await supabase.rpc('get_guest_list', { p_token: token, p_key: key });
  if (error) throw rpcError(error);
  return normalizeShared(data);
}

function normalizeShared(data: unknown): SharedList {
  const list = data as SharedList & { owner_scheme: unknown; appearance_hue: unknown };
  // Старий бекенд або несподіване значення — усталена Шавлія без оформлення,
  // а не зламана сторінка.
  return {
    ...list,
    owner_scheme: isScheme(list.owner_scheme) ? list.owner_scheme : 'sage',
    appearance_hue: typeof list.appearance_hue === 'number' ? list.appearance_hue : null,
    event_date: list.event_date ?? null,
    expires_at: list.expires_at ?? null,
    expires_tz: typeof list.expires_tz === 'string' ? list.expires_tz : null,
    guest: list.guest ?? null,
    sections: Array.isArray(list.sections) ? list.sections : [],
    items: list.items.map((i) => ({ ...i, section_id: i.section_id ?? null })),
  };
}

export async function registerView(token: string): Promise<void> {
  await supabase.rpc('register_share_view', { p_token: token });
}

export type ClaimResult = { taken_qty: number; mine_qty: number; code: string };

/**
 * «Я візьму це». `quantity` — підсумкова кількість цього гостя, не приріст:
 * сервер робить upsert і рахує межу як «чужі позначки + твоя нова».
 * Помилки, які сторінка показує по-людськи: `not_enough_left` (гонку
 * програно), `reservations_disabled`.
 */
export async function claimItem(
  token: string,
  itemId: string,
  key: string,
  quantity = 1,
): Promise<ClaimResult> {
  const { data, error } = await supabase.rpc('claim_item', {
    p_token: token,
    p_item_id: itemId,
    p_key: key,
    p_quantity: quantity,
  });
  if (error) throw rpcError(error);
  return data as ClaimResult;
}

export type ClaimV2Result = ClaimResult & { name: string | null; email: string | null };

/**
 * «Беру» гостьової v2 (ADR-053): як `claimItem`, плюс підпис і пошта гостя.
 * `name` / `email`: null — лишити як є, порожній рядок — прибрати. Помилки
 * `bad_name` і `bad_email` приходять до позначки — тоді її не зроблено.
 */
export async function claimItemV2(
  token: string,
  itemId: string,
  key: string,
  quantity: number,
  name: string | null,
  email: string | null,
): Promise<ClaimV2Result> {
  const { data, error } = await supabase.rpc('claim_item_v2', {
    p_token: token,
    p_item_id: itemId,
    p_key: key,
    p_quantity: quantity,
    p_name: name,
    p_email: email,
  });
  if (error) throw rpcError(error);
  return data as ClaimV2Result;
}

export async function releaseClaim(token: string, itemId: string, key: string): Promise<void> {
  const { error } = await supabase.rpc('release_claim', {
    p_token: token,
    p_item_id: itemId,
    p_key: key,
  });
  if (error) throw rpcError(error);
}

export type RedeemResult =
  | { key: string; code: string; claims: number }
  | { error: 'code_not_found' | 'too_many_attempts' };

/**
 * Короткий код переносить позначки на цей пристрій: сервер видає новий ключ
 * тієї самої ідентичності, старий пристрій лишається робочим, код змінюється.
 */
export async function redeemCode(token: string, code: string): Promise<RedeemResult> {
  const { data, error } = await supabase.rpc('redeem_guest_code', { p_token: token, p_code: code });
  if (error) throw rpcError(error);
  return data as RedeemResult;
}

/**
 * Сліпе «скинути позицію» власником (ADR-035): знімає позначки гостей, якщо
 * вони є, і нічого не повертає — ні скільки, ні чи були.
 */
export async function releaseItemClaims(itemId: string): Promise<void> {
  const { error } = await supabase.rpc('release_item_claims', { p_item_id: itemId });
  if (error) throw error;
}
