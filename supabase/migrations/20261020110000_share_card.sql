-- 20261020110000_share_card.sql
-- Гостьова v2, крок 5д (ADR-060): картка посилання в месенджері (потік W2).
--
-- get_share_card — вузька RPC для edge-функції `app/api/card.ts`, яка
-- відповідає ботам месенджерів на `/l/…` і `/s/…`. Віддає рівно те, що
-- потрібно картці: назву посилання (її власник сам дав гостям), дату події
-- й мову власника для підпису. Ні позицій, ні цін, ні позначок, ні ключа
-- гостя; не рахує перегляду й не торкається ідентичностей.
--
-- Мертве посилання (відкликане, протерміноване, неіснуюче) — null, однаково
-- для всіх трьох причин (ADR-035, п. 7): картка тоді загальна.

create or replace function public.get_share_card(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_share public.shares;
begin
  if p_token is null or length(p_token) > 128 then
    return null;
  end if;
  v_share := public.live_share(p_token);
  if v_share.id is null then
    return null;
  end if;
  return (
    select jsonb_build_object(
             'title',      v_share.title,
             'event_date', l.event_date,
             'locale',     coalesce(p.locale::text, 'uk')
           )
      from public.lists l
      left join public.profiles p on p.id = v_share.owner_id
     where l.id = v_share.source_list_id
  );
end;
$$;

revoke all on function public.get_share_card(text) from public;
grant execute on function public.get_share_card(text) to anon, authenticated;
