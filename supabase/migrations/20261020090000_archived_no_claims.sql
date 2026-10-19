-- 20261020090000_archived_no_claims.sql
-- Гостьова v2, крок 5д (ADR-058): архівний список гості бачать, але не бронюють.
--
-- Що змінюється:
--   * get_shared_list віддає `archived` і рахує `allow_reservations` з
--     урахуванням архіву. Гостьова v2 (get_guest_list — обгортка) і v1 на
--     `/s/…` ховають «Беру» однаково. Більше в тілі нічого не змінено;
--   * тригер claims_archived_guard не пускає нову позначку чи зміну кількості
--     на позиції архівного списку — помилка `list_archived`. Тригер, а не
--     правка claim_item: заморожене тіло v1 лишається як є, а захист стоїть на
--     самій таблиці. Зняти бронь («Зняти», release_claim), «Уже куплено» й
--     «Лишити» можна й на архівному: це справи гостя з його власною бронню.
--
-- Власник нічого нового не дізнається: архів — його власна дія, а помилка
-- `list_archived` однакова для будь-якої позиції списку (CLAUDE.md §3.2).

-- ─────────────────────────────────────────────
-- get_shared_list — `archived` і бронювання лише на неархівному
-- ─────────────────────────────────────────────

create or replace function public.get_shared_list(p_token text, p_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share    public.shares;
  v_list     public.lists;
  v_is_owner boolean;
  v_identity uuid;
  v_code     text;
  v_items    jsonb;
  v_sections jsonb;
begin
  v_share := public.live_share(p_token);
  if v_share.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  select * into v_list from public.lists where id = v_share.source_list_id;

  v_is_owner := (auth.uid() is not null and auth.uid() = v_share.owner_id);
  -- Власнику позначок не показуємо навіть у власному посиланні (ADR-009).

  if not v_is_owner then
    v_identity := public.guest_identity_of(v_list.id, p_key);
    if v_identity is not null then
      update public.guest_identities set last_seen = now()
       where id = v_identity
       returning short_code into v_code;
    end if;
  end if;

  select coalesce(jsonb_agg(x order by rn), '[]'::jsonb)
  into v_items
  from (
    select jsonb_build_object(
      'id',         i.id,
      'title',      i.title,
      'url',        i.url,
      'price',      case when v_share.hide_prices then null else i.price end,
      'currency',   coalesce(i.currency, v_list.currency),
      'quantity',   i.quantity,
      'priority',   i.priority,
      'note',       i.note,
      'variants',   i.variants,
      'image_url',  i.image_url,
      'status',     i.status,
      'created_at', i.created_at,
      'section_id', i.section_id,
      'taken_qty', case
        when v_is_owner then null
        else coalesce((select sum(c.quantity)::int from public.claims c where c.item_id = i.id), 0)
      end,
      'mine_qty', case
        when v_is_owner then null
        else coalesce((select c.quantity from public.claims c
                        where c.item_id = i.id and c.identity_id = v_identity), 0)
      end
    ) as x,
    row_number() over (
      order by (s.id is null), s.position, s.created_at,
               i.position asc nulls first, i.created_at desc, i.id
    ) as rn
    from public.share_items si
    join public.items i on i.id = si.item_id
    left join public.sections s on s.id = i.section_id
    where si.share_id = v_share.id
      and i.status = 'active'
  ) t;

  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title)
                            order by s.position, s.created_at), '[]'::jsonb)
  into v_sections
  from public.sections s
  where s.list_id = v_list.id
    and exists (select 1 from public.share_items si
                  join public.items i on i.id = si.item_id
                 where si.share_id = v_share.id and i.status = 'active' and i.section_id = s.id);

  return jsonb_build_object(
    'title',              v_share.title,
    'message',            v_share.message,
    'currency',           v_list.currency,
    'event_date',         v_list.event_date,
    'expires_at',         v_share.expires_at,
    'expires_tz',         v_share.expires_tz,
    'owner_scheme',       (select p.scheme from public.profiles p where p.id = v_share.owner_id),
    'appearance_hue',     (select a.hue from public.appearances a where a.id = v_list.appearance_id),
    'hide_prices',        v_share.hide_prices,
    -- ADR-058: архівний список гості бачать, але не бронюють.
    'allow_reservations', v_share.allow_reservations and not v_list.is_archived and not v_is_owner,
    'archived',           v_list.is_archived,
    'viewer_is_owner',    v_is_owner,
    'guest',              case when v_code is null then null else jsonb_build_object('code', v_code) end,
    'sections',           v_sections,
    'items',              v_items
  );
end;
$$;

revoke all on function public.get_shared_list(text, text) from public;
grant execute on function public.get_shared_list(text, text) to anon, authenticated;

-- ─────────────────────────────────────────────
-- Позначки на архівному списку — ні
-- ─────────────────────────────────────────────
--
-- Лише INSERT і зміна кількості: службові поля броні (changed_at,
-- purchased_at) міняються й на архівному. Порожній результат підзапиту
-- (позиції вже немає) — не наша справа: FK скаже своє.

create or replace function public.claims_archived_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (select 1
               from public.items i
               join public.lists l on l.id = i.list_id
              where i.id = new.item_id
                and l.is_archived) then
    raise exception 'list_archived' using errcode = '22023';
  end if;
  return new;
end;
$$;

revoke all on function public.claims_archived_guard() from public, anon, authenticated;

create trigger claims_archived_guard
  before insert or update of quantity on public.claims
  for each row execute function public.claims_archived_guard();
