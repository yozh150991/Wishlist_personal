-- Пошук по всіх списках (ROADMAP 8.11): search_my_items.
--
-- Стережемо: чужі позиції не знаходяться (§3.1), анонім — відмова, архів
-- входить у пошук, збіг за нотаткою, магазином і ознаками, регістр і
-- діакритика не важать, а символи % і _ — звичайні літери.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(24);

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

/** Назви знайденого — у порядку відповіді. */
create function tests.found(p_query text) returns text[] language sql as $$
  select coalesce(array_agg(title order by n), '{}')
    from (select title, row_number() over () as n from public.search_my_items(p_query)) s
$$;

grant execute on all functions in schema tests to anon, authenticated;

insert into auth.users (id, email) values
  ('a3211111-0000-4000-8000-000000000001', 'owner32a@test.local'),
  ('a3211111-0000-4000-8000-000000000002', 'owner32b@test.local');

-- Власник A: живий список і архів минулого року.
insert into public.lists (id, owner_id, title, currency, event_date, is_archived) values
  ('a3211111-0000-4000-8000-00000000000a', 'a3211111-0000-4000-8000-000000000001', 'Новосілля', 'PLN', null, false),
  ('a3211111-0000-4000-8000-00000000000b', 'a3211111-0000-4000-8000-000000000001', 'Різдво минулого року', 'PLN',
   (date_trunc('year', current_date) - interval '7 days')::date, true);

insert into public.items (id, list_id, owner_id, title, note, url, source_site, variants, updated_at) values
  ('a3211111-0000-4000-8000-0000000000c1', 'a3211111-0000-4000-8000-00000000000b', 'a3211111-0000-4000-8000-000000000001',
   'Плед', 'Той самий, що в Олі на ЗИМОВІ свята', 'https://www.Allegro.pl/oferta/plaid-1', null,
   '[{"label": "Колір", "value": "Червоний"}]'::jsonb, now() - interval '300 days'),
  ('a3211111-0000-4000-8000-0000000000c2', 'a3211111-0000-4000-8000-00000000000a', 'a3211111-0000-4000-8000-000000000001',
   'Łyżka drewniana', null, null, 'Rozetka', '[]'::jsonb, now()),
  ('a3211111-0000-4000-8000-0000000000c3', 'a3211111-0000-4000-8000-00000000000a', 'a3211111-0000-4000-8000-000000000001',
   'Їжак іграшка', 'під плед на диван', null, null, '[]'::jsonb, now()),
  ('a3211111-0000-4000-8000-0000000000c4', 'a3211111-0000-4000-8000-00000000000a', 'a3211111-0000-4000-8000-000000000001',
   'Ваза axb', null, null, null, '[]'::jsonb, now());

-- Власник B: позиція з тим самим словом у нотатці.
insert into public.lists (id, owner_id, title, currency) values
  ('a3211111-0000-4000-8000-00000000000c', 'a3211111-0000-4000-8000-000000000002', 'Чужий', 'PLN');
insert into public.items (id, list_id, owner_id, title, note) values
  ('a3211111-0000-4000-8000-0000000000d1', 'a3211111-0000-4000-8000-00000000000c', 'a3211111-0000-4000-8000-000000000002',
   'Плед B', 'зимові свята');

-- ── Гранти ───────────────────────────────────

select ok(not has_function_privilege('anon', 'public.search_my_items(text, integer)', 'EXECUTE'),
          'анонім не може викликати search_my_items');
select ok(has_function_privilege('authenticated', 'public.search_my_items(text, integer)', 'EXECUTE'),
          'власник може');

select tests.as_anon();
select throws_ok($$ select * from public.search_my_items('плед') $$, '42501', null,
                 'анонім отримує відмову');

-- ── Власник A ────────────────────────────────

select tests.as_user('a3211111-0000-4000-8000-000000000001');

select is(tests.found('зимові'), array['Плед'],
          'позиція з архіву минулого року знаходиться за словом із нотатки, чужа — ні');
select is(tests.found('ЗиМоВі СвЯтА'), array['Плед'], 'регістр не важить');
select is(tests.found('allegro'), array['Плед'], 'магазин: хост посилання без www.');
select is(tests.found('www'), '{}'::text[], 'www. до хоста не входить');
select is(tests.found('oferta'), '{}'::text[], 'шлях адреси — не магазин');
select is(tests.found('rozetka'), array['Łyżka drewniana'], 'магазин: source_site, коли посилання немає');
select is(tests.found('червоний'), array['Плед'], 'значення ознаки');
select is(tests.found('колір'), array['Плед'], 'підпис ознаки');
select is(tests.found('червоний плед'), array['Плед'], 'кожне слово — у своєму полі');
select is(tests.found('плед зелений'), '{}'::text[], 'усі слова мусять знайтися');
select is(tests.found('lyzka'), array['Łyżka drewniana'], 'польська діакритика не важить');
select is(tests.found('ŁYŻKA'), array['Łyżka drewniana'], 'і в запиті, і великими');
select is(tests.found('іжак'), array['Їжак іграшка'], 'ї згортається в і');
select is(tests.found('плед'), array['Плед', 'Їжак іграшка'],
          'усе в назві — першим, хоч і з архіву; збіг лише в нотатці — далі');
select is(tests.found('a_b'), '{}'::text[], '_ — звичайна літера, не шаблон');
select is(tests.found('a%b'), '{}'::text[], '% — звичайна літера, не шаблон');
select is(tests.found('   '), '{}'::text[], 'порожній запит — нічого');
select throws_ok($$ select * from public.search_my_items('плед', 101) $$, '22023', 'bad_limit',
                 'ліміт понад 100 — bad_limit');
select throws_ok($$ select * from public.search_my_items(repeat('я', 101)) $$, '22023', 'bad_query',
                 'запит понад 100 символів — bad_query');

-- ── Власник B ────────────────────────────────

select tests.as_user('a3211111-0000-4000-8000-000000000002');
select is(tests.found('зимові'), array['Плед B'], 'B знаходить лише своє');
select is(tests.found('allegro'), '{}'::text[], 'і не бачить чужих магазинів');

select * from finish();
rollback;
