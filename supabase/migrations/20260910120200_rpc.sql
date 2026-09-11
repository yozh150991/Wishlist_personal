-- 0003_rpc.sql — RPC-функції: шеринг, гостьовий доступ, бронювання, пагінація.

-- ─────────────────────────────────────────────
-- Генерація токена шеру (22 символи base64url)
-- ─────────────────────────────────────────────

-- 16 випадкових байтів з gen_random_uuid() (ядро Postgres 14+, CSPRNG),
-- перекодованих у base64url без padding -> рівно 22 символи.
-- Не залежить від pgcrypto: у Supabase воно живе у схемі extensions і
-- не резолвиться під час компіляції функції (ADR-014).
create or replace function public.gen_share_token()
returns text
language sql
volatile
set search_path = public
as $$
  select translate(
           encode(decode(replace(gen_random_uuid()::text, '-', ''), 'hex'), 'base64'),
           '+/=', '-_');
$$;

-- ─────────────────────────────────────────────
-- create_share — власник створює посилання з вибраних позицій
-- ─────────────────────────────────────────────

create or replace function public.create_share(
  p_list_id            uuid,
  p_item_ids           uuid[],
  p_title              text,
  p_message            text default null,
  p_hide_prices        boolean default false,
  p_allow_reservations boolean default true,
  p_expires_at         timestamptz default null
)
returns public.shares
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_share public.shares;
begin
  if p_item_ids is null or array_length(p_item_ids, 1) is null then
    raise exception 'Потрібно вибрати хоча б одну позицію' using errcode = '22023';
  end if;

  insert into public.shares (owner_id, source_list_id, token, title, message,
                             hide_prices, allow_reservations, expires_at)
  values (auth.uid(), p_list_id, public.gen_share_token(), p_title, p_message,
          p_hide_prices, p_allow_reservations, p_expires_at)
  returning * into v_share;
  -- RLS shares_insert_own перевіряє, що список належить викликачу.

  insert into public.share_items (share_id, item_id)
  select v_share.id, i.id
  from public.items i
  where i.id = any(p_item_ids)
    and i.list_id = p_list_id;
  -- RLS items_select_own відсіє чужі позиції.

  return v_share;
end;
$$;

-- ─────────────────────────────────────────────
-- get_shared_list — публічний перегляд за токеном
-- ─────────────────────────────────────────────

create or replace function public.get_shared_list(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share  public.shares;
  v_is_owner boolean;
  v_items  jsonb;
begin
  select * into v_share from public.shares where token = p_token;

  if v_share.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_share.revoked_at is not null then
    raise exception 'revoked' using errcode = 'P0002';
  end if;
  if v_share.expires_at is not null and v_share.expires_at < now() then
    raise exception 'expired' using errcode = 'P0002';
  end if;

  v_is_owner := (auth.uid() is not null and auth.uid() = v_share.owner_id);
  -- Власнику броні не показуємо навіть у власному посиланні (ADR-009).

  select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb)
  into v_items
  from (
    select jsonb_build_object(
      'id',        i.id,
      'title',     i.title,
      'url',       i.url,
      'price',     case when v_share.hide_prices then null else i.price end,
      'quantity',  i.quantity,
      'priority',  i.priority,
      'note',      i.note,
      'image_url', i.image_url,
      'status',    i.status,
      'created_at', i.created_at,
      'reserved_qty', case
        when v_is_owner then null
        else coalesce((select sum(r.quantity)::int from public.reservations r
                       where r.share_id = v_share.id and r.item_id = i.id), 0)
      end
    ) as x
    from public.share_items si
    join public.items i on i.id = si.item_id
    where si.share_id = v_share.id
      and i.status = 'active'
  ) t;

  return jsonb_build_object(
    'title',              v_share.title,
    'message',            v_share.message,
    'currency',           (select l.currency from public.lists l where l.id = v_share.source_list_id),
    'hide_prices',        v_share.hide_prices,
    'allow_reservations', v_share.allow_reservations and not v_is_owner,
    'viewer_is_owner',    v_is_owner,
    'items',              v_items
  );
end;
$$;

revoke all on function public.get_shared_list(text) from public;
grant execute on function public.get_shared_list(text) to anon, authenticated;

-- ─────────────────────────────────────────────
-- register_share_view — лічильник переглядів
-- ─────────────────────────────────────────────

create or replace function public.register_share_view(p_token text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.shares
     set view_count = view_count + 1, last_viewed_at = now()
   where token = p_token
     and revoked_at is null
     and (expires_at is null or expires_at > now())
     and (auth.uid() is null or auth.uid() <> owner_id);
end;
$$;

grant execute on function public.register_share_view(text) to anon, authenticated;

-- ─────────────────────────────────────────────
-- reserve_item / unreserve_item — анонімна бронь
-- ─────────────────────────────────────────────

create or replace function public.reserve_item(
  p_token     text,
  p_item_id   uuid,
  p_guest_key text,
  p_quantity  integer default 1
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share public.shares;
  v_item_qty integer;
  v_taken integer;
begin
  select * into v_share from public.shares
   where token = p_token and revoked_at is null
     and (expires_at is null or expires_at > now());

  if v_share.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not v_share.allow_reservations then
    raise exception 'reservations_disabled' using errcode = '22023';
  end if;
  if auth.uid() is not null and auth.uid() = v_share.owner_id then
    raise exception 'owner_cannot_reserve' using errcode = '22023';
  end if;
  if not exists (select 1 from public.share_items
                 where share_id = v_share.id and item_id = p_item_id) then
    raise exception 'item_not_in_share' using errcode = 'P0002';
  end if;

  select quantity into v_item_qty from public.items where id = p_item_id;

  select coalesce(sum(quantity), 0) into v_taken
    from public.reservations
   where share_id = v_share.id and item_id = p_item_id and guest_key <> p_guest_key;

  if v_taken + p_quantity > v_item_qty then
    raise exception 'not_enough_left' using errcode = '22023';
  end if;

  insert into public.reservations (share_id, item_id, guest_key, quantity)
  values (v_share.id, p_item_id, p_guest_key, p_quantity)
  on conflict (share_id, item_id, guest_key)
  do update set quantity = excluded.quantity;

  return (select coalesce(sum(quantity), 0)::int from public.reservations
          where share_id = v_share.id and item_id = p_item_id);
end;
$$;

create or replace function public.unreserve_item(
  p_token     text,
  p_item_id   uuid,
  p_guest_key text
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share_id uuid;
begin
  select id into v_share_id from public.shares
   where token = p_token and revoked_at is null;

  if v_share_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  delete from public.reservations
   where share_id = v_share_id and item_id = p_item_id and guest_key = p_guest_key;

  return (select coalesce(sum(quantity), 0)::int from public.reservations
          where share_id = v_share_id and item_id = p_item_id);
end;
$$;

grant execute on function public.reserve_item(text, uuid, text, integer)   to anon, authenticated;
grant execute on function public.unreserve_item(text, uuid, text)          to anon, authenticated;

-- ─────────────────────────────────────────────
-- list_items_page — keyset-пагінація для нескінченного скролу
-- Сортування: created_at | title | price | priority, обидва напрямки.
-- Курсор — (значення_ключа, id) останнього показаного рядка.
-- ─────────────────────────────────────────────

create or replace function public.list_items_page(
  p_list_id     uuid,
  p_sort        text default 'created_at',   -- created_at | title | price | priority
  p_desc        boolean default true,
  p_limit       integer default 25,          -- 10 | 25 | 50 | 100
  p_cursor_key  text default null,
  p_cursor_id   uuid default null,
  p_search      text default null,
  p_status      public.item_status[] default null,
  p_price_min   numeric default null,
  p_price_max   numeric default null
)
returns setof public.items
language plpgsql
security invoker
stable
set search_path = public
as $$
begin
  if p_sort not in ('created_at','title','price','priority') then
    raise exception 'bad_sort' using errcode = '22023';
  end if;
  if p_limit not in (10, 25, 50, 100) then
    raise exception 'bad_limit' using errcode = '22023';
  end if;

  return query
  select i.* from public.items i
  where i.list_id = p_list_id
    and (p_search    is null or i.title ilike '%' || p_search || '%')
    and (p_status    is null or i.status = any(p_status))
    and (p_price_min is null or i.price >= p_price_min)
    and (p_price_max is null or i.price <= p_price_max)
    and (
      p_cursor_id is null
      or case p_sort
           when 'created_at' then
             case when p_desc
               then (i.created_at, i.id) < (p_cursor_key::timestamptz, p_cursor_id)
               else (i.created_at, i.id) > (p_cursor_key::timestamptz, p_cursor_id) end
           when 'title' then
             case when p_desc
               then (i.title, i.id) < (p_cursor_key, p_cursor_id)
               else (i.title, i.id) > (p_cursor_key, p_cursor_id) end
           when 'price' then
             case when p_desc
               then (i.price, i.id) < (p_cursor_key::numeric, p_cursor_id)
               else (i.price, i.id) > (p_cursor_key::numeric, p_cursor_id) end
           when 'priority' then
             case when p_desc
               then (i.priority, i.id) < (p_cursor_key::public.item_priority, p_cursor_id)
               else (i.priority, i.id) > (p_cursor_key::public.item_priority, p_cursor_id) end
         end
    )
  order by
    case when p_desc then
      case p_sort
        when 'created_at' then to_jsonb(i.created_at)
        when 'title'      then to_jsonb(i.title)
        when 'price'      then to_jsonb(i.price)
        when 'priority'   then to_jsonb(i.priority::text)
      end
    end desc nulls last,
    case when not p_desc then
      case p_sort
        when 'created_at' then to_jsonb(i.created_at)
        when 'title'      then to_jsonb(i.title)
        when 'price'      then to_jsonb(i.price)
        when 'priority'   then to_jsonb(i.priority::text)
      end
    end asc nulls last,
    i.id desc
  limit p_limit;
end;
$$;

-- ─────────────────────────────────────────────
-- list_totals — сума по списку (для футера «разом»)
-- ─────────────────────────────────────────────

create or replace function public.list_totals(p_list_id uuid)
returns table (
  items_count      integer,
  active_count     integer,
  purchased_count  integer,
  gifted_count     integer,
  total_price      numeric,
  active_price     numeric,
  items_no_price   integer
)
language sql
security invoker
stable
set search_path = public
as $$
  select
    count(*)::int,
    count(*) filter (where status = 'active')::int,
    count(*) filter (where status = 'purchased')::int,
    count(*) filter (where status = 'gifted')::int,
    coalesce(sum(price * quantity), 0),
    coalesce(sum(price * quantity) filter (where status = 'active'), 0),
    count(*) filter (where price is null)::int
  from public.items where list_id = p_list_id;
$$;
