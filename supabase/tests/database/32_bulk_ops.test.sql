-- Масові дії однією транзакцією (ROADMAP 8.26).
-- import_list, repeat_list, copy_items, set_items_status, delete_items:
-- усе або нічого — штучна помилка посередині не лишає жодного рядка; чужий
-- список — відмова без часткового запису; права — лише власник; RLS і
-- check-обмеження діють як для одиночних запитів.
-- §3.2 — масове видалення й статус зачіпають позначки лише так, як одиночні:
-- мовчки, тригерами; відповідь власнику однакова, є позначки чи ні.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(56);

create schema tests;
grant usage on schema tests to anon, authenticated;

create function tests.as_user(p_id uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

create function tests.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'anon', true);
end $$;

-- Скільки рядків у списках із цією назвою — як бачить база, а не власник.
create function tests.lists_titled(p_title text) returns integer language sql security definer as $$
  select count(*)::int from public.lists where title = p_title
$$;
create function tests.items_titled(p_title text) returns integer language sql security definer as $$
  select count(*)::int from public.items where title = p_title
$$;
create function tests.sections_titled(p_title text) returns integer language sql security definer as $$
  select count(*)::int from public.sections where title = p_title
$$;

-- Позиції для payload: n штук «Річ k», k-та — з полями `bad`.
create function tests.payload(n integer, bad_at integer default null, bad jsonb default '{}') returns jsonb
language sql as $$
  select jsonb_agg(case when k = bad_at then jsonb_build_object('title', 'Річ ' || k) || bad
                        else jsonb_build_object('title', 'Річ ' || k) end order by k)
    from generate_series(1, n) k
$$;

grant execute on all functions in schema tests to anon, authenticated;

-- ── Дані ─────────────────────────────────────
-- O — власник: L (поширений, у c1 і c2 є позначки гостя), L2, Y (щорічний,
-- з розділом). X — інший користувач зі своїм XL.

insert into auth.users (id, email) values
  ('c3200000-0000-4000-8000-000000000001', 'bulk-o@test.local'),
  ('c3200000-0000-4000-8000-000000000002', 'bulk-x@test.local');

insert into public.lists (id, owner_id, title, currency, repeats_yearly, event_date) values
  ('c3200000-0000-4000-8000-00000000000a', 'c3200000-0000-4000-8000-000000000001', 'Масові L',  'PLN', false, null),
  ('c3200000-0000-4000-8000-00000000000b', 'c3200000-0000-4000-8000-000000000001', 'Масові L2', 'PLN', false, null),
  ('c3200000-0000-4000-8000-00000000000d', 'c3200000-0000-4000-8000-000000000001', 'Масові Y',  'EUR', true, '2026-12-24'),
  ('c3200000-0000-4000-8000-00000000000c', 'c3200000-0000-4000-8000-000000000002', 'Чужий XL',  'PLN', false, null);

insert into public.items (id, list_id, owner_id, title, quantity) values
  ('c3200000-0000-4000-8000-0000000000c1', 'c3200000-0000-4000-8000-00000000000a', 'c3200000-0000-4000-8000-000000000001', 'Взяте 1', 1),
  ('c3200000-0000-4000-8000-0000000000c2', 'c3200000-0000-4000-8000-00000000000a', 'c3200000-0000-4000-8000-000000000001', 'Взяте 2', 1),
  ('c3200000-0000-4000-8000-0000000000c3', 'c3200000-0000-4000-8000-00000000000a', 'c3200000-0000-4000-8000-000000000001', 'Вільне 3', 1),
  ('c3200000-0000-4000-8000-0000000000c4', 'c3200000-0000-4000-8000-00000000000a', 'c3200000-0000-4000-8000-000000000001', 'Вільне 4', 1),
  ('c3200000-0000-4000-8000-0000000000c5', 'c3200000-0000-4000-8000-00000000000a', 'c3200000-0000-4000-8000-000000000001', 'Вільне 5', 1),
  ('c3200000-0000-4000-8000-0000000000b1', 'c3200000-0000-4000-8000-00000000000b', 'c3200000-0000-4000-8000-000000000001', 'З L2', 1),
  ('c3200000-0000-4000-8000-0000000000f1', 'c3200000-0000-4000-8000-00000000000c', 'c3200000-0000-4000-8000-000000000002', 'Чуже', 1);

insert into public.shares (id, owner_id, source_list_id, token, title) values
  ('c3200000-0000-4000-8000-0000000000d1', 'c3200000-0000-4000-8000-000000000001',
   'c3200000-0000-4000-8000-00000000000a', 'bulkOpsToken0000000001', 'Масові L');
insert into public.share_items (share_id, item_id)
select 'c3200000-0000-4000-8000-0000000000d1'::uuid, id from public.items
 where list_id = 'c3200000-0000-4000-8000-00000000000a';

select tests.as_anon();
select claim_item_v2('bulkOpsToken0000000001', 'c3200000-0000-4000-8000-0000000000c1',
                     'bulkOpsGuestKeyAAAAAAAAA', 1, 'Іра', 'ira32@pochta.ua', 'uk');
select claim_item_v2('bulkOpsToken0000000001', 'c3200000-0000-4000-8000-0000000000c2',
                     'bulkOpsGuestKeyAAAAAAAAA', 1, 'Іра', 'ira32@pochta.ua', 'uk');
reset role;
delete from guest_mail;

-- ── Права (§3.4) ─────────────────────────────

select ok(
  not has_function_privilege('anon', 'public.import_list(jsonb, jsonb, jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.repeat_list(uuid, jsonb, jsonb, jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.copy_items(uuid, jsonb, jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.set_items_status(uuid, uuid[], public.item_status)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.delete_items(uuid, uuid[])', 'EXECUTE')
  and not has_function_privilege('anon', 'public.insert_owner_list(jsonb)', 'EXECUTE')
  and not has_function_privilege('anon', 'public.insert_list_contents(uuid, jsonb, jsonb)', 'EXECUTE'),
  'anon не викликає жодної масової дії'
);
select ok(
  has_function_privilege('authenticated', 'public.import_list(jsonb, jsonb, jsonb)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.repeat_list(uuid, jsonb, jsonb, jsonb)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.copy_items(uuid, jsonb, jsonb)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.set_items_status(uuid, uuid[], public.item_status)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.delete_items(uuid, uuid[])', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.insert_owner_list(jsonb)', 'EXECUTE')
  and has_function_privilege('authenticated', 'public.insert_list_contents(uuid, jsonb, jsonb)', 'EXECUTE'),
  'власник викликає всі'
);
select is_empty(
  $$ select proname::text from pg_proc
      where pronamespace = 'public'::regnamespace and prosecdef
        and proname in ('import_list', 'repeat_list', 'copy_items', 'set_items_status', 'delete_items',
                        'insert_owner_list', 'insert_list_contents') $$,
  'усі — SECURITY INVOKER: прав понад RLS не додають'
);

select tests.as_anon();
select throws_ok(
  $$ select import_list('{"title":"Анонім"}', '[]', '[]') $$,
  '42501', null, 'anon отримує permission denied'
);
reset role;

-- ── import_list: щасливий шлях ───────────────

select tests.as_user('c3200000-0000-4000-8000-000000000001');
select lives_ok(
  $$ select import_list(
       '{"title":"Імпорт добрий","description":"з файлу","currency":"UAH","event_date":"2026-12-31","owner_id":"c3200000-0000-4000-8000-000000000002"}',
       '[{"key":"Кухня","title":"Кухня","position":1},{"key":"Балкон","title":"Балкон","position":2}]',
       '[{"title":"Сковорода","section_key":"Кухня","position":1,"price":120.5,"priority":"high"},
         {"title":"Дошка","section_key":"Кухня","position":2,"variants":[{"label":"Колір","value":"дуб"}]},
         {"title":"Лампа","section_key":null,"position":1,"status":"purchased","owner_id":"c3200000-0000-4000-8000-000000000002","id":"c3200000-0000-4000-8000-0000000000f1"}]'
     ) $$,
  'імпорт списку з розділами й позиціями — одним викликом'
);
reset role;

select is(
  (select owner_id from lists where title = 'Імпорт добрий'),
  'c3200000-0000-4000-8000-000000000001'::uuid,
  'власник — той, хто викликав, а не owner_id із payload'
);
select is(
  (select array_agg(title || ':' || position order by position) from sections
    where list_id = (select id from lists where title = 'Імпорт добрий')),
  array['Кухня:1', 'Балкон:2'],
  'розділи — у порядку з файлу, порожній теж'
);
select is(
  (select array_agg(i.title || ':' || coalesce(s.title, '—') || ':' || i.position order by i.title)
     from items i left join sections s on s.id = i.section_id
    where i.list_id = (select id from lists where title = 'Імпорт добрий')),
  array['Дошка:Кухня:2', 'Лампа:—:1', 'Сковорода:Кухня:1'],
  'позиції — у своїх розділах, на своїх місцях'
);
select is(
  (select count(*)::int from items where list_id = (select id from lists where title = 'Імпорт добрий')
      and owner_id = 'c3200000-0000-4000-8000-000000000001'),
  3, 'усі позиції — власника (тригер items_sync_owner)'
);
select is(tests.items_titled('Чуже'), 1, 'id з payload не перезаписав чужу позицію');
select is(
  (select status::text from items where title = 'Лампа'
      and list_id = (select id from lists where title = 'Імпорт добрий')),
  'purchased', 'статус з файлу збережено'
);

-- ── import_list: усе або нічого ──────────────

select tests.as_user('c3200000-0000-4000-8000-000000000001');
select throws_ok(
  $$ select import_list('{"title":"Імпорт битий 1"}', '[{"key":"Р","title":"Розділ битий"}]',
                        tests.payload(50, 25, '{"priority":"бозна"}')) $$,
  '22P02', null, 'заборонене значення пріоритету в 25-й позиції з 50 — відмова'
);
select throws_ok(
  $$ select import_list('{"title":"Імпорт битий 2"}', '[]', tests.payload(50, 30, '{"quantity":0}')) $$,
  '23514', null, 'кількість 0 посередині — check-обмеження бази спрацьовує'
);
select throws_ok(
  $$ select import_list('{"title":"Імпорт битий 3"}', '[]',
                        tests.payload(10, 5, jsonb_build_object('title', repeat('я', 201)))) $$,
  '23514', null, 'назва довша за 200 — відмова'
);
select throws_ok(
  $$ select import_list('{"title":"Імпорт битий 4"}', '[]', tests.payload(10, 9, '{"url":"ftp://x"}')) $$,
  '23514', null, 'посилання не http(s) — відмова'
);
select throws_ok(
  $$ select import_list('{"title":"Імпорт битий 5"}', '[]', tests.payload(1001)) $$,
  '22023', 'too_many_items', 'понад 1000 позицій — відмова (MAX_IMPORT_ITEMS)'
);
select throws_ok(
  $$ select import_list('{"title":"Імпорт битий 6"}', '[{"key":"A","title":"Розділ битий"}]',
                        '[{"title":"Річ","section_key":"Б"}]') $$,
  '23514', 'section_not_in_list', 'позиція з невідомим розділом — відмова'
);
select throws_ok(
  $$ select import_list('{"title":"Імпорт битий 7"}',
                        '[{"key":"A","title":"Розділ битий"},{"key":"A","title":"Розділ битий"}]', '[]') $$,
  '22023', 'duplicate_section', 'два розділи з однією міткою — відмова'
);
select throws_ok(
  $$ select import_list(jsonb_build_object('title', repeat('н', 121)), '[]', tests.payload(3)) $$,
  '23514', null, 'назва списку довша за 120 — відмова'
);
select throws_ok(
  $$ select import_list('{"title":"Імпорт битий 8"}', '[{"key":"A","title":""}]', tests.payload(3)) $$,
  '23514', null, 'порожня назва розділу — відмова'
);
reset role;

select is(
  (select count(*)::int from lists where title like 'Імпорт битий%' or char_length(title) > 120),
  0, 'жодного списку від невдалих імпортів'
);
select is(tests.sections_titled('Розділ битий'), 0, 'жодного розділу від невдалих імпортів');
select is(
  (select count(*)::int from items where title like 'Річ%'),
  0, 'жодної позиції від невдалих імпортів — і тих, що стояли до помилки'
);

-- ── copy_items («Ще хочу») ───────────────────

select tests.as_user('c3200000-0000-4000-8000-000000000001');
select throws_ok(
  $$ select copy_items('c3200000-0000-4000-8000-00000000000c', '[{"title":"Підкинуте"}]') $$,
  'P0002', 'list_not_found', 'копії в чужий список — відмова'
);
select lives_ok(
  $$ select copy_items('c3200000-0000-4000-8000-00000000000b', '[{"title":"Копія 1"},{"title":"Копія 2","currency":"EUR"}]') $$,
  'копії в свій список'
);
select is(
  (select title from copy_items(null, '[{"title":"Копія 3"}]', '{"title":"Ще хочу новий","currency":"EUR"}')),
  'Ще хочу новий', 'копії в новий список — повертає сам список'
);
select throws_ok(
  $$ select copy_items('c3200000-0000-4000-8000-00000000000b', '[{"title":"Копія битa 1"},{"title":"Копія битa 2","price":-1}]') $$,
  '23514', null, 'від’ємна ціна в другій копії — відмова'
);
select throws_ok(
  $$ select copy_items(null, '[{"title":"Копія битa 3","quantity":1000}]', '{"title":"Ще хочу битий"}') $$,
  '23514', null, 'невдалі копії в новий список — відмова'
);
reset role;

select is(tests.items_titled('Підкинуте'), 0, 'у чужому списку нічого не з’явилось');
select is(
  (select count(*)::int from items where list_id = 'c3200000-0000-4000-8000-00000000000b' and title like 'Копія _'),
  2, 'дві копії в своєму списку'
);
select is(
  (select count(*)::int from items i join lists l on l.id = i.list_id where l.title = 'Ще хочу новий'),
  1, 'копія в новому списку'
);
select is(
  (select count(*)::int from items where title like 'Копія бит%'), 0,
  'від невдалих копій — жодної позиції, і першої теж'
);
select is(tests.lists_titled('Ще хочу битий'), 0, 'від невдалих копій у новий — жодного списку');

-- ── repeat_list ──────────────────────────────

select tests.as_user('c3200000-0000-4000-8000-000000000001');
insert into sections (id, list_id, title, position) values
  ('c3200000-0000-4000-8000-0000000000e1', 'c3200000-0000-4000-8000-00000000000d', 'Кухня Y', 1);

select throws_ok(
  $$ select repeat_list('c3200000-0000-4000-8000-00000000000c', '{"title":"Повтор чужого"}', '[]', '[]') $$,
  'P0002', 'list_not_found', 'повтор чужого списку — відмова'
);
select throws_ok(
  $$ select repeat_list('c3200000-0000-4000-8000-00000000000d', '{"title":"Повтор битий","currency":"EUR"}',
       '[{"key":"c3200000-0000-4000-8000-0000000000e1","title":"Кухня Y","position":1}]',
       '[{"title":"Чайник","section_key":"c3200000-0000-4000-8000-0000000000e1"},{"title":"Тостер","priority":"бозна"}]') $$,
  '22P02', null, 'повтор із забороненим значенням у другій позиції — відмова'
);
reset role;

select is(tests.lists_titled('Повтор чужого') + tests.lists_titled('Повтор битий'), 0, 'невдалі повтори не лишили списків');
select is(tests.sections_titled('Кухня Y'), 1, '… ні розділів');
select is(
  (select repeats_yearly from lists where id = 'c3200000-0000-4000-8000-00000000000d'), true,
  '… а щорічна позначка джерела лишилась на місці'
);

select tests.as_user('c3200000-0000-4000-8000-000000000001');
select is(
  (select title from repeat_list('c3200000-0000-4000-8000-00000000000d',
       '{"title":"Повтор 2027","currency":"EUR","event_date":"2027-12-24","repeats_yearly":true}',
       '[{"key":"c3200000-0000-4000-8000-0000000000e1","title":"Кухня Y","position":1}]',
       '[{"title":"Чайник","section_key":"c3200000-0000-4000-8000-0000000000e1","position":1},{"title":"Тостер"}]')),
  'Повтор 2027', 'повтор власного списку'
);
reset role;

select is(
  (select repeats_yearly from lists where id = 'c3200000-0000-4000-8000-00000000000d'), false,
  'щорічна позначка перейшла від джерела — у тій самій транзакції'
);
select is(
  (select repeats_yearly from lists where title = 'Повтор 2027'), true, '… до нового списку'
);
select is(
  (select array_agg(i.title || ':' || coalesce(s.title, '—') order by i.title)
     from items i left join sections s on s.id = i.section_id
    where i.list_id = (select id from lists where title = 'Повтор 2027')),
  array['Тостер:—', 'Чайник:Кухня Y'],
  'розділ — новий, у новому списку, і позиція в ньому'
);
select isnt(
  (select s.id from sections s join lists l on l.id = s.list_id where l.title = 'Повтор 2027'),
  'c3200000-0000-4000-8000-0000000000e1'::uuid,
  'розділ джерела не перечеплено — створено копію'
);

-- ── set_items_status ─────────────────────────

select tests.as_user('c3200000-0000-4000-8000-000000000001');
select throws_ok(
  $$ select set_items_status('c3200000-0000-4000-8000-00000000000c', array['c3200000-0000-4000-8000-0000000000f1']::uuid[], 'gifted') $$,
  'P0002', 'list_not_found', 'статус у чужому списку — відмова'
);
select lives_ok(
  $$ select set_items_status('c3200000-0000-4000-8000-00000000000a',
       array['c3200000-0000-4000-8000-0000000000c4', 'c3200000-0000-4000-8000-0000000000c5',
             'c3200000-0000-4000-8000-0000000000b1', 'c3200000-0000-4000-8000-0000000000f1',
             'c3200000-0000-4000-8000-0000000000aa']::uuid[], 'gifted') $$,
  'статус кількох — позиції з інших списків і неіснуючі пропускаються мовчки'
);
reset role;

select is(
  (select array_agg(title || ':' || status order by title) from items
    where id in ('c3200000-0000-4000-8000-0000000000c4', 'c3200000-0000-4000-8000-0000000000c5',
                 'c3200000-0000-4000-8000-0000000000b1', 'c3200000-0000-4000-8000-0000000000f1')),
  array['Вільне 4:gifted', 'Вільне 5:gifted', 'З L2:active', 'Чуже:active'],
  'змінено лише позиції цього списку'
);

-- ── delete_items ─────────────────────────────

select tests.as_user('c3200000-0000-4000-8000-000000000001');
select throws_ok(
  $$ select delete_items('c3200000-0000-4000-8000-00000000000c', array['c3200000-0000-4000-8000-0000000000f1']::uuid[]) $$,
  'P0002', 'list_not_found', 'видалення в чужому списку — відмова'
);
select lives_ok(
  $$ select delete_items('c3200000-0000-4000-8000-00000000000a',
       array['c3200000-0000-4000-8000-0000000000b1', 'c3200000-0000-4000-8000-0000000000f1']::uuid[]) $$,
  'позиції інших списків через цей список не видаляються'
);
reset role;
select is(tests.items_titled('Чуже') + tests.items_titled('З L2'), 2, 'чужа й позиція з L2 на місці');

-- ── §3.2: позначки — лише тригерами, відповідь однакова ──

select tests.as_user('c3200000-0000-4000-8000-000000000001');
create temp table tests_answers (kind text, answer text);
grant all on tests_answers to authenticated;
insert into tests_answers
select 'status, з позначкою', set_items_status('c3200000-0000-4000-8000-00000000000a',
         array['c3200000-0000-4000-8000-0000000000c2']::uuid[], 'purchased')::text;
insert into tests_answers
select 'status, без позначки', set_items_status('c3200000-0000-4000-8000-00000000000a',
         array['c3200000-0000-4000-8000-0000000000c3']::uuid[], 'purchased')::text;
reset role;

select is(
  (select count(distinct coalesce(answer, '∅'))::int from tests_answers where kind like 'status%'), 1,
  'статус: відповідь власнику однакова з позначкою й без'
);
select is(
  (select count(*)::int from claims where item_id = 'c3200000-0000-4000-8000-0000000000c2' and changed_at is null), 1,
  'масовий статус позначки не чіпає'
);

select tests.as_user('c3200000-0000-4000-8000-000000000001');
insert into tests_answers
select 'delete, з позначками', delete_items('c3200000-0000-4000-8000-00000000000a',
         array['c3200000-0000-4000-8000-0000000000c1', 'c3200000-0000-4000-8000-0000000000c2']::uuid[])::text;
insert into tests_answers
select 'delete, без позначок', delete_items('c3200000-0000-4000-8000-00000000000a',
         array['c3200000-0000-4000-8000-0000000000c3', 'c3200000-0000-4000-8000-0000000000c4']::uuid[])::text;
select throws_ok($$ select * from claims $$, '42501', null, 'власник і далі не бачить позначок');
reset role;

select is(
  (select count(distinct coalesce(answer, '∅'))::int from tests_answers where kind like 'delete%'), 1,
  'видалення: відповідь власнику однакова з позначками й без'
);
select is(
  (select count(*)::int from items where list_id = 'c3200000-0000-4000-8000-00000000000a'), 1,
  'видалено чотири позиції, лишилась одна'
);
select is(
  (select count(*)::int from claims where item_id in ('c3200000-0000-4000-8000-0000000000c1', 'c3200000-0000-4000-8000-0000000000c2')),
  0, 'позначки зникли каскадом, як при одиночному видаленні'
);
select is(
  (select array_agg(details->>'title' order by details->>'title') from guest_mail where kind = 'deleted'),
  array['Взяте 1', 'Взяте 2'],
  'гостю — лист «видалено» на кожну взяту позицію (тригер items_guest_deleted, ADR-055)'
);

select * from finish();
rollback;
