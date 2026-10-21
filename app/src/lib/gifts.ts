/**
 * «Я дарую» (крок 6, ADR-062): що користувач бере в чужих списках.
 *
 * Прив'язка гостьових броней до акаунта — на сервері: за броню, зроблену
 * після входу, і за підтвердженою поштою акаунта. Власні списки сюди не
 * потрапляють ніколи (ADR-040, п. 3).
 *
 * Без офлайн-копії: у відповіді — токени посилань, а вони не кешуються
 * (CLAUDE.md §3.5).
 */
import { supabase } from './supabase';
import type { Currency } from './types';

export type GiftItem = {
  id: string;
  title: string;
  url: string | null;
  /** null, якщо посилання ховає ціни. */
  price: number | string | null;
  currency: Currency;
  mine_qty: number;
  quantity: number;
  bought: boolean;
  changed: boolean;
  /** Спільний збір на позицію (ADR-063, ADR-064): свій чи той, куди скидаюсь. */
  pool: {
    organizer: string;
    instructions: string;
    goal: number | string;
    currency: Currency;
    closed: boolean;
    raised: number | string;
    is_organizer: boolean;
    /** Моя обіцянка; null — я лише організатор. */
    mine: number | string | null;
  } | null;
};

export type GiftList = {
  token: string;
  /** Назва посилання — та, яку власник дав гостям. */
  title: string;
  event_date: string | null;
  archived: boolean;
  thanks: string | null;
  code: string | null;
  items: GiftItem[];
};

export async function fetchMyGifts(): Promise<GiftList[]> {
  const { data, error } = await supabase.rpc('get_my_gifts');
  if (error) throw error;
  return (data as GiftList[] | null) ?? [];
}

/**
 * Ключ цього браузера — до своїх броней на цьому посиланні, без коду.
 * true — гостьова з ключем покаже броні користувача.
 */
export async function attachGuestKey(token: string, key: string): Promise<boolean> {
  const { data, error } = await supabase.rpc('attach_guest_key', { p_token: token, p_key: key });
  if (error) throw error;
  return data === true;
}
