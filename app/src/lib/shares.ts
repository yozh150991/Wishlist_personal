import { supabase, publicOrigin } from './supabase';
import type { Currency, ItemPriority, ItemStatus } from './types';

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
  image_url: string | null;
  status: ItemStatus;
  created_at: string;
  /** null, коли переглядає власник: броні від нього приховані (ADR-009). */
  reserved_qty: number | null;
};

export type SharedList = {
  title: string;
  message: string | null;
  currency: Currency;
  hide_prices: boolean;
  allow_reservations: boolean;
  viewer_is_owner: boolean;
  items: SharedItem[];
};

export type SharedListError = 'not_found' | 'revoked' | 'expired' | 'unknown';

export async function fetchSharedList(token: string): Promise<SharedList> {
  const { data, error } = await supabase.rpc('get_shared_list', { p_token: token });
  if (error) {
    const code = (error.message || '').toLowerCase();
    // Гостю показуємо однакову сторінку на всі три випадки: інакше
    // сама різниця відповідей підтверджувала б існування токена.
    const known: SharedListError[] = ['not_found', 'revoked', 'expired'];
    const match = known.find((k) => code.includes(k));
    throw new Error(match ?? 'unknown');
  }
  return data as SharedList;
}

export async function registerView(token: string): Promise<void> {
  await supabase.rpc('register_share_view', { p_token: token });
}

export async function reserveItem(
  token: string,
  itemId: string,
  guest: string,
  quantity = 1,
): Promise<number> {
  const { data, error } = await supabase.rpc('reserve_item', {
    p_token: token,
    p_item_id: itemId,
    p_guest_key: guest,
    p_quantity: quantity,
  });
  if (error) throw new Error(error.message);
  return (data as number) ?? 0;
}

export async function unreserveItem(
  token: string,
  itemId: string,
  guest: string,
): Promise<number> {
  const { data, error } = await supabase.rpc('unreserve_item', {
    p_token: token,
    p_item_id: itemId,
    p_guest_key: guest,
  });
  if (error) throw new Error(error.message);
  return (data as number) ?? 0;
}
