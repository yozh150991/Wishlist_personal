import { supabase, publicOrigin } from './supabase';
import type { Currency, ItemPriority, ItemStatus, ItemVariant } from './types';
import { isScheme } from './appearance';
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
  expiresAt?: string | null;
};

export function shareUrl(token: string): string {
  return `${publicOrigin.replace(/\/$/, '')}/s/${token}`;
}

export async function createShare(input: ShareInput): Promise<Share> {
  const { data, error } = await supabase.rpc('create_share', {
    p_list_id: input.listId,
    p_item_ids: input.itemIds,
    p_title: input.title,
    p_message: input.message ?? null,
    p_hide_prices: input.hidePrices ?? false,
    p_allow_reservations: input.allowReservations ?? true,
    p_expires_at: input.expiresAt ?? null,
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

/* ── Гостьова частина ───────────────────────── */

export type SharedItem = {
  id: string;
  title: string;
  url: string | null;
  price: number | string | null;
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
  hide_prices: boolean;
  allow_reservations: boolean;
  viewer_is_owner: boolean;
  /** Ключ гостя впізнано — ось його короткий код. null — ключа немає або він чужий. */
  guest: { code: string } | null;
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
  const list = data as SharedList & { owner_scheme: unknown; appearance_hue: unknown };
  // Старий бекенд або несподіване значення — усталена Шавлія без оформлення,
  // а не зламана сторінка.
  return {
    ...list,
    owner_scheme: isScheme(list.owner_scheme) ? list.owner_scheme : 'sage',
    appearance_hue: typeof list.appearance_hue === 'number' ? list.appearance_hue : null,
    event_date: list.event_date ?? null,
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
