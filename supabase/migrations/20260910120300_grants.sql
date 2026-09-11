-- 20260910120300_grants.sql — звуження прав на виклик функцій.
--
-- Postgres за замовчуванням дає EXECUTE ролі PUBLIC на кожну нову функцію,
-- а PostgREST публікує всю схему public як RPC. Функції для власника мають
-- бути недоступні анонімно навіть попри те, що RLS усе одно їх знешкоджує.

-- Функції власника: тільки для автентифікованих
revoke execute on function
  public.create_share(uuid, uuid[], text, text, boolean, boolean, timestamptz)
  from public;
grant execute on function
  public.create_share(uuid, uuid[], text, text, boolean, boolean, timestamptz)
  to authenticated;

revoke execute on function
  public.list_items_page(uuid, text, boolean, integer, text, uuid, text,
                         public.item_status[], numeric, numeric)
  from public;
grant execute on function
  public.list_items_page(uuid, text, boolean, integer, text, uuid, text,
                         public.item_status[], numeric, numeric)
  to authenticated;

revoke execute on function public.list_totals(uuid) from public;
grant  execute on function public.list_totals(uuid) to authenticated;

-- Генератор токенів — внутрішній, назовні не потрібен нікому
revoke execute on function public.gen_share_token() from public;

-- Гостьові функції лишаються доступними anon (гранти видані в попередній
-- міграції). Тут лише прибираємо надлишковий PUBLIC, залишаючи явні ролі.
revoke execute on function public.get_shared_list(text) from public;
revoke execute on function public.register_share_view(text) from public;
revoke execute on function public.reserve_item(text, uuid, text, integer) from public;
revoke execute on function public.unreserve_item(text, uuid, text) from public;

grant execute on function public.get_shared_list(text)                     to anon, authenticated;
grant execute on function public.register_share_view(text)                 to anon, authenticated;
grant execute on function public.reserve_item(text, uuid, text, integer)   to anon, authenticated;
grant execute on function public.unreserve_item(text, uuid, text)          to anon, authenticated;
