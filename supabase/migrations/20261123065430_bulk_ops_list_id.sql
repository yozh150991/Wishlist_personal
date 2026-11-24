-- 20261123065430_bulk_ops_list_id.sql — id нового списку задає клієнт (ROADMAP 8.26).
--
-- Імпорт, «Повторити список» і «Ще хочу» в новий список — одна транзакція
-- (20261122210328_bulk_ops_rpc.sql), але відповідь може не дійти: список уже
-- в базі, а людина бачить «немає з'єднання» й натискає ще раз. Без ключа
-- ідемпотентності другий виклик створював другий такий самий список.
--
-- Тепер клієнт генерує id списку один раз на дію (`crypto.randomUUID()`) і
-- шле той самий id у кожному повторі:
--   - списку з цим id ще немає — створюється, як і раніше;
--   - є, і він свій (RLS lists_select_own) — нічого не створюється вдруге,
--     повертається той самий список, як успіх;
--   - зайнятий чужим — `list_id_taken` (`23505`), без жодного запису. Помилка
--     не несе нічого, крім самого факту: ні власника, ні назви, ні вмісту.
--     Що випадковий uuid, який викликач уже знає, зайнятий, — неминучий біт
--     (інакше повтор не впізнати), і він нічого не відкриває: `lists.id` —
--     122 випадкові біти, а зайнятий id не дає жодного доступу.
--   - не uuid — помилка приведення типу ще до тіла (`22P02`); null —
--     `bad_payload`.
--
-- `lists.id` і далі незмінний після створення (ADR-038, тригер
-- lists_keep_identity): тут id лише задається при вставці.
--
-- Старі сигнатури import_list(jsonb, jsonb, jsonb), repeat_list(uuid, jsonb,
-- jsonb, jsonb) і insert_owner_list(jsonb) прибрано, а не закрито: вони жили
-- лише в гілці `winter` і CI, бойова база й жоден застосунок у браузерах їх не
-- викликали (CLAUDE.md §7, «спершу закрити, потім прибрати» — про RPC, які вже
-- кличуть роздані клієнти). Дві перевантажені сигнатури з різними іменами
-- параметрів PostgREST розрізнив би, але друга, ніким не викликана, лише
-- лишала б шлях без ключа ідемпотентності.
--
-- copy_items зберігає сигнатуру: p_list_id — список, у який лягають копії;
-- з p_new_list цей список створюється з цим id (повтор — той самий список).

drop function public.import_list(jsonb, jsonb, jsonb);
drop function public.repeat_list(uuid, jsonb, jsonb, jsonb);
drop function public.insert_owner_list(jsonb);

-- ─────────────────────────────────────────────
-- Новий список з id від клієнта
-- ─────────────────────────────────────────────
--
-- Свій наявний список з цим id викликач перевіряє сам ДО виклику (і тоді
-- нічого не вставляє). Тут — лише вставка: конфлікт за id означає, що id
-- зайнятий, і все. ON CONFLICT DO NOTHING чекає на паралельну транзакцію з
-- тим самим id, тож подвійне натискання не дає ні двох списків, ні помилки
-- ключа з деталями рядка.

create function public.insert_owner_list(p_id uuid, p_list jsonb)
returns public.lists
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_list public.lists;
begin
  if p_id is null or p_list is null or jsonb_typeof(p_list) <> 'object' then
    raise exception 'bad_payload' using errcode = '22023';
  end if;
  insert into public.lists (id, owner_id, title, description, currency, event_date, repeats_yearly, appearance_id)
  select p_id, auth.uid(), x.title, x.description, coalesce(x.currency, 'PLN'), x.event_date,
         coalesce(x.repeats_yearly, false), x.appearance_id
    from jsonb_to_record(p_list) as x(
      title text, description text, currency text, event_date date, repeats_yearly boolean, appearance_id uuid
    )
  on conflict (id) do nothing
  returning * into v_list;
  if not found then
    raise exception 'list_id_taken' using errcode = '23505';
  end if;
  return v_list;
end;
$$;

-- ─────────────────────────────────────────────
-- import_list
-- ─────────────────────────────────────────────

create function public.import_list(p_list_id uuid, p_list jsonb, p_sections jsonb, p_items jsonb)
returns public.lists
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_list public.lists;
begin
  if p_list_id is null then
    raise exception 'bad_payload' using errcode = '22023';
  end if;
  -- Повтор тієї самої дії: список уже є — той самий результат.
  select * into v_list from public.lists where id = p_list_id;
  if found then
    return v_list;
  end if;
  if jsonb_typeof(coalesce(p_items, '[]'::jsonb)) = 'array'
     and jsonb_array_length(coalesce(p_items, '[]'::jsonb)) > 1000 then
    raise exception 'too_many_items' using errcode = '22023';
  end if;
  v_list := public.insert_owner_list(p_list_id, p_list);
  perform public.insert_list_contents(v_list.id, p_sections, p_items);
  return v_list;
end;
$$;

-- ─────────────────────────────────────────────
-- repeat_list
-- ─────────────────────────────────────────────

create function public.repeat_list(
  p_source_list_id uuid,
  p_list_id        uuid,
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
  if p_list_id is null then
    raise exception 'bad_payload' using errcode = '22023';
  end if;
  -- Повтор: новий список уже створено, і щорічну позначку джерела вже знято
  -- в тій самій транзакції — нічого не робимо вдруге.
  select * into v_list from public.lists where id = p_list_id;
  if found then
    return v_list;
  end if;
  if not exists (select 1 from public.lists where id = p_source_list_id) then
    raise exception 'list_not_found' using errcode = 'P0002';
  end if;
  v_list := public.insert_owner_list(p_list_id, p_list);
  perform public.insert_list_contents(v_list.id, p_sections, p_items);
  update public.lists set repeats_yearly = false
   where id = p_source_list_id and repeats_yearly;
  return v_list;
end;
$$;

-- ─────────────────────────────────────────────
-- copy_items — та сама сигнатура, новий список — з id p_list_id
-- ─────────────────────────────────────────────

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
    raise exception 'bad_payload' using errcode = '22023';
  end if;
  select * into v_list from public.lists where id = p_list_id;
  if p_new_list is not null then
    -- Новий список: уже є — це повтор, копії вже лягли.
    if found then
      return v_list;
    end if;
    v_list := public.insert_owner_list(p_list_id, p_new_list);
  elsif not found then
    raise exception 'list_not_found' using errcode = 'P0002';
  end if;
  perform public.insert_list_contents(v_list.id, null, p_items);
  return v_list;
end;
$$;

-- ─────────────────────────────────────────────
-- Права (CLAUDE.md §3.4)
-- ─────────────────────────────────────────────

revoke execute on function public.insert_owner_list(uuid, jsonb)                  from public, anon;
revoke execute on function public.import_list(uuid, jsonb, jsonb, jsonb)          from public, anon;
revoke execute on function public.repeat_list(uuid, uuid, jsonb, jsonb, jsonb)    from public, anon;
revoke execute on function public.copy_items(uuid, jsonb, jsonb)                  from public, anon;

grant execute on function public.insert_owner_list(uuid, jsonb)                  to authenticated;
grant execute on function public.import_list(uuid, jsonb, jsonb, jsonb)          to authenticated;
grant execute on function public.repeat_list(uuid, uuid, jsonb, jsonb, jsonb)    to authenticated;
grant execute on function public.copy_items(uuid, jsonb, jsonb)                  to authenticated;

comment on function public.import_list(uuid, jsonb, jsonb, jsonb) is
  'Імпорт файлу одним викликом (ROADMAP 8.26): список з id від клієнта, розділи й до 1000 позицій — усе або нічого; повтор з тим самим id повертає той самий список.';
comment on function public.repeat_list(uuid, uuid, jsonb, jsonb, jsonb) is
  '«Повторити список» одним викликом (ROADMAP 8.26): новий список з id від клієнта, розділи, копії позицій і перенесення щорічної позначки; повтор з тим самим id — той самий список.';
comment on function public.copy_items(uuid, jsonb, jsonb) is
  '«Ще хочу» одним викликом (ROADMAP 8.26): копії в наявний список p_list_id або, з p_new_list, у новий список з id p_list_id (повтор — той самий список).';
comment on function public.insert_owner_list(uuid, jsonb) is
  'Внутрішня частина import_list, repeat_list і copy_items: новий список власника з id від клієнта під RLS; зайнятий id — list_id_taken.';
