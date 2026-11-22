-- 20261122210328_bulk_ops_rpc.sql — масові дії власника однією транзакцією (ROADMAP 8.26).
--
-- Імпорт, «Повторити список», «Ще хочу» і масові статус та видалення були
-- серіями запитів PostgREST із ручним відкотом у `lib/db.ts`: обрив мережі
-- посередині лишав напівзроблене — список без половини позицій, а відкат
-- (видалити щойно створений список) теж міг не дійти. Тепер кожна операція —
-- один виклик RPC, тіло якого — одна транзакція: усе або нічого.
--
-- Усі функції — SECURITY INVOKER. Вони діють від імені власника, і RLS,
-- `check`-обмеження та тригери таблиць (`items_sync_owner`,
-- `items_check_section`, `items_guest_deleted`, `items_guest_changed`…)
-- працюють рівно так само, як для одиночних запитів: функції прав не
-- додають, лише збирають кілька кроків у транзакцію. Колонки беруться з
-- payload поіменно — `id`, `owner_id`, `link_*`, `created_at` з тіла запиту
-- ігноруються.
--
-- Позначки гостей (CLAUDE.md §3.2, ADR-038, ADR-055): масове видалення
-- зачіпає `claims` лише каскадом і тригером `items_guest_deleted`, який
-- нічого не повертає й ніколи не падає. Масовий статус позначок не чіпає
-- зовсім. Відповідь власнику — `void` або його ж новий список — однакова,
-- є позначки чи ні.

-- ─────────────────────────────────────────────
-- Спільне: розділи й позиції в наявний список
-- ─────────────────────────────────────────────
--
-- p_sections — масив {key, title, position}: `key` — довільна мітка клієнта
-- (назва з файлу, id розділу-джерела), на яку посилаються позиції.
-- p_items — масив позицій у полях `items` плюс `section_key`.
-- Невідомий `section_key` — помилка, а не мовчазне «Інше»: клієнт сам вирішує,
-- що позиція без розділу, і шле null.
--
-- Доступна authenticated: її викликають SECURITY INVOKER функції нижче, а
-- викликач мусить мати право її виконати (CLAUDE.md §3.4). Прав вона не
-- додає — це те саме, що вставки власника в `sections` і `items` під RLS.

create or replace function public.insert_list_contents(
  p_list_id  uuid,
  p_sections jsonb,
  p_items    jsonb
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_map jsonb := '{}'::jsonb;
begin
  if p_sections is not null and jsonb_typeof(p_sections) <> 'array'
     or p_items is not null and jsonb_typeof(p_items) <> 'array' then
    raise exception 'bad_payload' using errcode = '22023';
  end if;

  if jsonb_array_length(coalesce(p_sections, '[]'::jsonb)) > 0 then
    if exists (select 1 from jsonb_array_elements(p_sections) e
                where jsonb_typeof(e) <> 'object' or (e->>'key') is null) then
      raise exception 'bad_payload' using errcode = '22023';
    end if;
    if (select count(distinct e->>'key') <> count(*) from jsonb_array_elements(p_sections) e) then
      raise exception 'duplicate_section' using errcode = '22023';
    end if;

    -- id генеруємо тут, щоб зіставити мітку клієнта з новим розділом.
    -- CTE з volatile-функцією матеріалізується один раз: id однакові в
    -- обох місцях. owner_id проставляє тригер sections_sync_owner.
    with src as (
      select x.key, x.title, coalesce(x.position, e.ord::int) as position, gen_random_uuid() as id
        from jsonb_array_elements(p_sections) with ordinality as e(v, ord),
             jsonb_to_record(e.v) as x(key text, title text, position integer)
    ), ins as (
      insert into public.sections (id, list_id, title, position)
      select id, p_list_id, title, position from src
      returning id
    )
    select coalesce(jsonb_object_agg(src.key, src.id), '{}'::jsonb) into v_map
      from src
     where exists (select 1 from ins where ins.id = src.id);
  end if;

  if jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 then
    return;
  end if;

  if exists (select 1 from jsonb_array_elements(p_items) e where jsonb_typeof(e) <> 'object') then
    raise exception 'bad_payload' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) e
              where (e->>'section_key') is not null and not v_map ? (e->>'section_key')) then
    raise exception 'section_not_in_list' using errcode = '23514';
  end if;

  -- owner_id проставляє тригер items_sync_owner; чужий список не пропустить
  -- політика items_insert_own — уся транзакція відкочується.
  insert into public.items (
    list_id, title, url, price, quantity, priority, note, variants, image_url,
    status, section_id, position, needs_title, currency
  )
  select p_list_id,
         x.title, x.url, x.price,
         coalesce(x.quantity, 1),
         coalesce(x.priority, 'medium'),
         x.note,
         coalesce(x.variants, '[]'::jsonb),
         x.image_url,
         coalesce(x.status, 'active'),
         (v_map->>x.section_key)::uuid,
         x.position,
         coalesce(x.needs_title, false),
         x.currency
    from jsonb_array_elements(p_items) with ordinality as e(v, ord),
         jsonb_to_record(e.v) as x(
           title text, url text, price numeric, quantity integer, priority public.item_priority,
           note text, variants jsonb, image_url text, status public.item_status,
           section_key text, position integer, needs_title boolean, currency text
         )
   order by e.ord;
end;
$$;

-- Новий список власника з полів p_list. Порожнього власника не буває:
-- без auth.uid() політика lists_insert_own не пропустить вставку.
create or replace function public.insert_owner_list(p_list jsonb)
returns public.lists
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_list public.lists;
begin
  if p_list is null or jsonb_typeof(p_list) <> 'object' then
    raise exception 'bad_payload' using errcode = '22023';
  end if;
  insert into public.lists (owner_id, title, description, currency, event_date, repeats_yearly, appearance_id)
  select auth.uid(), x.title, x.description, coalesce(x.currency, 'PLN'), x.event_date,
         coalesce(x.repeats_yearly, false), x.appearance_id
    from jsonb_to_record(p_list) as x(
      title text, description text, currency text, event_date date, repeats_yearly boolean, appearance_id uuid
    )
  returning * into v_list;
  return v_list;
end;
$$;

-- ─────────────────────────────────────────────
-- import_list — імпорт файлу (ROADMAP 6.3, ADR-036, ADR-050)
-- ─────────────────────────────────────────────
--
-- Межа 1000 позицій — та сама, що MAX_IMPORT_ITEMS у `lib/transfer.ts`:
-- попередній перегляд обрізає файл до неї й каже про це людині.

create or replace function public.import_list(p_list jsonb, p_sections jsonb, p_items jsonb)
returns public.lists
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_list public.lists;
begin
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) = 'array'
     and jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 1000 then
    raise exception 'too_many_items' using errcode = '22023';
  end if;
  v_list := public.insert_owner_list(p_list);
  perform public.insert_list_contents(v_list.id, p_sections, p_items);
  return v_list;
end;
$$;

-- ─────────────────────────────────────────────
-- repeat_list — «Повторити на наступний рік» (S3, ADR-045, ADR-047)
-- ─────────────────────────────────────────────
--
-- Новий список, його розділи й копії позицій, а щорічна позначка списку-
-- джерела переходить до нового — тепер у тій самій транзакції. Джерело
-- мусить бути списком власника: чужий чи видалений — list_not_found, і
-- нічого не створено.

create or replace function public.repeat_list(
  p_source_list_id uuid,
  p_list           jsonb,
  p_sections       jsonb,
  p_items          jsonb
)
returns public.lists
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_list public.lists;
begin
  -- RLS lists_select_own: чужий список для власника не існує.
  if not exists (select 1 from public.lists where id = p_source_list_id) then
    raise exception 'list_not_found' using errcode = 'P0002';
  end if;
  v_list := public.insert_owner_list(p_list);
  perform public.insert_list_contents(v_list.id, p_sections, p_items);
  update public.lists set repeats_yearly = false
   where id = p_source_list_id and repeats_yearly;
  return v_list;
end;
$$;

-- ─────────────────────────────────────────────
-- copy_items — «Ще хочу» з картки «Як минуло свято?» (M4, ADR-045)
-- ─────────────────────────────────────────────
--
-- У наявний список (p_list_id) або в новий (p_list_id = null, поля — у
-- p_new_list). Розділів не переносить: копії стають в «Інше».

create or replace function public.copy_items(p_list_id uuid, p_items jsonb, p_new_list jsonb default null)
returns public.lists
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_list public.lists;
begin
  if p_list_id is null then
    v_list := public.insert_owner_list(p_new_list);
  else
    select * into v_list from public.lists where id = p_list_id;
    if not found then
      raise exception 'list_not_found' using errcode = 'P0002';
    end if;
  end if;
  perform public.insert_list_contents(v_list.id, null, p_items);
  return v_list;
end;
$$;

-- ─────────────────────────────────────────────
-- set_items_status / delete_items — «Вибрати кілька», «Позначити отримане»
-- ─────────────────────────────────────────────
--
-- Список — обовʼязково свій (інакше list_not_found). Позиції, яких у ньому
-- вже немає, пропускаються мовчки: так черга змін (ADR-029) лишається
-- ідемпотентною — повтор видалення після обриву не падає.

create or replace function public.set_items_status(
  p_list_id  uuid,
  p_item_ids uuid[],
  p_status   public.item_status
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (select 1 from public.lists where id = p_list_id) then
    raise exception 'list_not_found' using errcode = 'P0002';
  end if;
  if p_status is null then
    raise exception 'bad_payload' using errcode = '22023';
  end if;
  update public.items
     set status = p_status
   where list_id = p_list_id
     and id = any(coalesce(p_item_ids, '{}'))
     and status is distinct from p_status;
end;
$$;

create or replace function public.delete_items(p_list_id uuid, p_item_ids uuid[])
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  if not exists (select 1 from public.lists where id = p_list_id) then
    raise exception 'list_not_found' using errcode = 'P0002';
  end if;
  -- Позначки зникають каскадом; лист гостю ставить у чергу тригер
  -- items_guest_deleted — так само, як при одиночному видаленні.
  delete from public.items
   where list_id = p_list_id
     and id = any(coalesce(p_item_ids, '{}'));
end;
$$;

-- ─────────────────────────────────────────────
-- Права (CLAUDE.md §3.4): лише власник, anon — ні
-- ─────────────────────────────────────────────

revoke execute on function public.insert_list_contents(uuid, jsonb, jsonb)       from public, anon;
revoke execute on function public.insert_owner_list(jsonb)                       from public, anon;
revoke execute on function public.import_list(jsonb, jsonb, jsonb)               from public, anon;
revoke execute on function public.repeat_list(uuid, jsonb, jsonb, jsonb)         from public, anon;
revoke execute on function public.copy_items(uuid, jsonb, jsonb)                 from public, anon;
revoke execute on function public.set_items_status(uuid, uuid[], public.item_status) from public, anon;
revoke execute on function public.delete_items(uuid, uuid[])                     from public, anon;

grant execute on function public.insert_list_contents(uuid, jsonb, jsonb)       to authenticated;
grant execute on function public.insert_owner_list(jsonb)                       to authenticated;
grant execute on function public.import_list(jsonb, jsonb, jsonb)               to authenticated;
grant execute on function public.repeat_list(uuid, jsonb, jsonb, jsonb)         to authenticated;
grant execute on function public.copy_items(uuid, jsonb, jsonb)                 to authenticated;
grant execute on function public.set_items_status(uuid, uuid[], public.item_status) to authenticated;
grant execute on function public.delete_items(uuid, uuid[])                     to authenticated;

comment on function public.import_list(jsonb, jsonb, jsonb) is
  'Імпорт файлу одним викликом (ROADMAP 8.26): список, розділи й до 1000 позицій — усе або нічого.';
comment on function public.repeat_list(uuid, jsonb, jsonb, jsonb) is
  '«Повторити список» одним викликом (ROADMAP 8.26): новий список, розділи, копії позицій і перенесення щорічної позначки.';
comment on function public.copy_items(uuid, jsonb, jsonb) is
  '«Ще хочу» одним викликом (ROADMAP 8.26): копії позицій у наявний або новий список.';
comment on function public.set_items_status(uuid, uuid[], public.item_status) is
  'Статус кількох позицій списку власника однією транзакцією (ROADMAP 8.26). Позначок не чіпає.';
comment on function public.delete_items(uuid, uuid[]) is
  'Видалення кількох позицій списку власника однією транзакцією (ROADMAP 8.26). Позначки — лише тригерами й каскадом, відповідь від них не залежить.';
comment on function public.insert_list_contents(uuid, jsonb, jsonb) is
  'Внутрішня частина import_list, repeat_list і copy_items: розділи й позиції в список власника під RLS.';
comment on function public.insert_owner_list(jsonb) is
  'Внутрішня частина import_list, repeat_list і copy_items: новий список власника під RLS.';
