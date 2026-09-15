-- 20260911100000_items_page_fix.sql
-- Переписує list_items_page: динамічний SQL із білим списком замість
-- ORDER BY через to_jsonb. Причини — в ADR-017.

-- Ключ сортування за ціною: позиції без ціни отримують -1, тож вони
-- завжди групуються з одного боку, а не зникають із курсорної пагінації
-- (порівняння з NULL дає NULL, і рядок випав би зі сторінки).
create index if not exists items_list_price_key_idx
  on public.items (list_id, (coalesce(price, (-1)::numeric)), id);

create index if not exists items_list_priority_idx
  on public.items (list_id, priority, id);

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
declare
  v_key  text;
  v_cast text;
  v_dir  text;
  v_cmp  text;
begin
  -- Білий список: у SQL підставляються тільки ці значення, ніколи не введення користувача.
  case p_sort
    when 'created_at' then v_key := 'i.created_at';                   v_cast := '::timestamptz';
    when 'title'      then v_key := 'i.title';                        v_cast := '::text';
    when 'price'      then v_key := 'coalesce(i.price, (-1)::numeric)'; v_cast := '::numeric';
    when 'priority'   then v_key := 'i.priority';                     v_cast := '::public.item_priority';
    else raise exception 'bad_sort' using errcode = '22023';
  end case;

  if p_limit not in (10, 25, 50, 100) then
    raise exception 'bad_limit' using errcode = '22023';
  end if;

  v_dir := case when p_desc then 'desc' else 'asc' end;
  v_cmp := case when p_desc then '<'    else '>'   end;

  -- Курсор і ORDER BY використовують один і той самий вираз та одні правила
  -- порівняння. Якщо вони розійдуться, пагінація почне губити рядки.
  return query execute format($q$
    select i.*
    from public.items i
    where i.list_id = $1
      and ($2::text is null or i.title ilike '%%' || $2 || '%%')
      and ($3::public.item_status[] is null or i.status = any($3))
      and ($4::numeric is null or i.price >= $4)
      and ($5::numeric is null or i.price <= $5)
      and ($7::uuid is null or (%s, i.id) %s ($6%s, $7::uuid))
    order by %s %s, i.id %s
    limit $8
  $q$, v_key, v_cmp, v_cast, v_key, v_dir, v_dir)
  using p_list_id, p_search, p_status, p_price_min, p_price_max,
        p_cursor_key, p_cursor_id, p_limit;
end;
$$;

revoke execute on function
  public.list_items_page(uuid, text, boolean, integer, text, uuid, text,
                         public.item_status[], numeric, numeric)
  from public;
grant execute on function
  public.list_items_page(uuid, text, boolean, integer, text, uuid, text,
                         public.item_status[], numeric, numeric)
  to authenticated;
