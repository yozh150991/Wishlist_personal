-- 20260928120000_sections_and_order.sql
-- Розділи всередині списку й ручний порядок позицій (ADR-036).
--
-- Весільні й новосільні списки — це 40+ позицій, а плаский перелік на такій
-- довжині перестає читатись. Розділ — одна мітка на позицію («Кухня»,
-- «Спальня»); позиції без розділу падають у «Інше» в кінці й ніколи не
-- зникають. Порядок розділів і позицій усередині них задає власник вручну —
-- саме його бачить гість. Сортування власника за ціною чи пріоритетом — лише
-- вигляд на його екрані, а не порядок у базі.
--
-- Закриває ROADMAP 7.2 («Теги всередині списку»): розділ і є групуванням без
-- окремого списку, лише одна мітка на позицію.

-- ─────────────────────────────────────────────
-- sections
-- ─────────────────────────────────────────────

create table public.sections (
  id         uuid primary key default gen_random_uuid(),
  list_id    uuid not null references public.lists(id) on delete cascade,
  owner_id   uuid not null references auth.users(id) on delete cascade,
  title      text not null check (length(btrim(title)) between 1 and 60),
  position   integer not null default 0,
  created_at timestamptz not null default now()
);

comment on table public.sections is
  'Розділ списку (ADR-036): одна мітка на позицію. Назву бачить гість, якщо в розділі є спільні позиції.';
comment on column public.sections.owner_id is
  'Денормалізовано з lists.owner_id заради дешевої RLS без JOIN, як і в items. Підтримується тригером.';

create index sections_list_idx on public.sections (list_id, position);
create index sections_owner_idx on public.sections (owner_id);

-- Власника проставляє база, як і в items: із клієнта його не шлемо й не віримо.
create or replace function public.sync_section_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select owner_id into new.owner_id from public.lists where id = new.list_id;
  if new.owner_id is null then
    raise exception 'Список % не знайдено', new.list_id;
  end if;
  return new;
end;
$$;

create trigger sections_sync_owner
  before insert or update of list_id on public.sections
  for each row execute function public.sync_section_owner();

alter table public.sections enable row level security;
revoke all on public.sections from anon;

create policy sections_select_own on public.sections
  for select to authenticated using (owner_id = auth.uid());

create policy sections_insert_own on public.sections
  for insert to authenticated
  with check (exists (select 1 from public.lists l where l.id = list_id and l.owner_id = auth.uid()));

create policy sections_update_own on public.sections
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy sections_delete_own on public.sections
  for delete to authenticated using (owner_id = auth.uid());

-- ─────────────────────────────────────────────
-- items.section_id, items.position
-- ─────────────────────────────────────────────
-- Видалення розділу ставить позиціям null: вони переходять у «Інше», а не
-- зникають. Порядок у розділі — position за зростанням; позиції без нього
-- (щойно додані, ще не впорядковані) стоять зверху, новіші першими.

alter table public.items
  add column section_id uuid references public.sections(id) on delete set null,
  add column position   integer;

comment on column public.items.section_id is 'Розділ (ADR-036); null — «Інше».';
comment on column public.items.position is
  'Ручний порядок у розділі — його бачить гість. null — ще не впорядковано: зверху, новіші першими.';

create index items_section_idx on public.items (section_id) where section_id is not null;

-- Розділ має належати тому самому списку. Зовнішній ключ цього не перевіряє,
-- а RLS на sections — лише власника; позиція з розділом чужого списку того
-- самого власника мовчки ламала б групування.
create or replace function public.check_item_section()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.section_id is not null
     and not exists (select 1 from public.sections s
                      where s.id = new.section_id and s.list_id = new.list_id) then
    raise exception 'section_not_in_list' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger items_check_section
  before insert or update of section_id, list_id on public.items
  for each row execute function public.check_item_section();

-- ─────────────────────────────────────────────
-- Упорядкування: одним викликом на групу
-- ─────────────────────────────────────────────
-- PostgREST не вміє оновити різні рядки різними значеннями одним запитом, а
-- перетягування міняє порядок цілої групи. SECURITY INVOKER: RLS items і
-- sections відсіє чуже саме, функція прав не додає.

create or replace function public.reorder_items(
  p_list_id    uuid,
  p_section_id uuid,
  p_item_ids   uuid[]
)
returns void
language sql
security invoker
set search_path = public
as $$
  update public.items i
     set section_id = p_section_id,
         position   = o.ord::int
    from unnest(p_item_ids) with ordinality as o(id, ord)
   where i.id = o.id and i.list_id = p_list_id;
$$;

create or replace function public.reorder_sections(p_list_id uuid, p_section_ids uuid[])
returns void
language sql
security invoker
set search_path = public
as $$
  update public.sections s
     set position = o.ord::int
    from unnest(p_section_ids) with ordinality as o(id, ord)
   where s.id = o.id and s.list_id = p_list_id;
$$;

revoke execute on function public.reorder_items(uuid, uuid, uuid[])  from public, anon;
revoke execute on function public.reorder_sections(uuid, uuid[])     from public, anon;
grant  execute on function public.reorder_items(uuid, uuid, uuid[])  to authenticated;
grant  execute on function public.reorder_sections(uuid, uuid[])     to authenticated;

revoke execute on function public.sync_section_owner() from public, anon, authenticated;
revoke execute on function public.check_item_section()  from public, anon, authenticated;

-- ─────────────────────────────────────────────
-- get_shared_list — розділи й ручний порядок
-- ─────────────────────────────────────────────
--
-- Гість бачить порядок, заданий власником вручну: розділи за їхнім порядком,
-- «Інше» (без розділу) в кінці, усередині — position, а неупорядковані зверху,
-- новіші першими. Розділи віддаються лише ті, у яких є спільні актуальні
-- позиції: назва порожнього чи неподіленого розділу гостю ні до чого.
--
-- Решта тіла не змінилася відносно 20260928110000_guest_keys_and_claims.sql.

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
    'owner_scheme',       (select p.scheme from public.profiles p where p.id = v_share.owner_id),
    'appearance_hue',     (select a.hue from public.appearances a where a.id = v_list.appearance_id),
    'hide_prices',        v_share.hide_prices,
    'allow_reservations', v_share.allow_reservations and not v_is_owner,
    'viewer_is_owner',    v_is_owner,
    'guest',              case when v_code is null then null else jsonb_build_object('code', v_code) end,
    'sections',           v_sections,
    'items',              v_items
  );
end;
$$;

revoke all on function public.get_shared_list(text, text) from public;
grant execute on function public.get_shared_list(text, text) to anon, authenticated;
