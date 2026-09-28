-- Чернетки позицій (ADR-046).
-- Чернетка — позиція без назви: у title адреса, needs_title = true. Гостям
-- вона невидима жодним шляхом: у share_items не потрапляє ні через
-- create_share, ні прямою вставкою, і назад у чернетку позиція не стає.
-- Будь-яка зміна назви — у v2 чи у v1, яка про чернетки не знає, — знімає позначку.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(13);

create schema tests;
grant usage on schema tests to anon, authenticated;

create function tests.as_user(p_id uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

grant execute on all functions in schema tests to anon, authenticated;

insert into auth.users (id, email) values
  ('a9a9a9a9-0000-4000-8000-000000000001', 'drafts-a@test.local');

insert into public.lists (id, owner_id, title) values
  ('a9a9a9a9-0000-4000-8000-00000000000a', 'a9a9a9a9-0000-4000-8000-000000000001', 'День народження');

-- ── Власник ──────────────────────────────────

select tests.as_user('a9a9a9a9-0000-4000-8000-000000000001');

insert into items (id, list_id, title, url) values
  ('a9a9a9a9-0000-4000-8000-0000000000c1', 'a9a9a9a9-0000-4000-8000-00000000000a', 'Плед', null);

select is((select needs_title from items where id = 'a9a9a9a9-0000-4000-8000-0000000000c1'), false,
          'звичайна позиція — не чернетка: усталене значення — поведінка v1');

select lives_ok(
  $$ insert into items (id, list_id, title, url, needs_title) values
       ('a9a9a9a9-0000-4000-8000-0000000000c2', 'a9a9a9a9-0000-4000-8000-00000000000a',
        'shop.ua/lampa', 'https://shop.ua/lampa', true) $$,
  'чернетка створюється з адресою замість назви'
);

select lives_ok(
  $$ select create_share('a9a9a9a9-0000-4000-8000-00000000000a',
                         array['a9a9a9a9-0000-4000-8000-0000000000c1', 'a9a9a9a9-0000-4000-8000-0000000000c2']::uuid[],
                         'Для родини') $$,
  'посилання з чернеткою серед вибраних створюється — без незрозумілої помилки для v1'
);

select is(
  (select array_agg(i.title) from share_items si join items i on i.id = si.item_id
    join shares s on s.id = si.share_id where s.title = 'Для родини'),
  array['Плед'],
  'чернетка в посилання не потрапила — лише названа позиція'
);

select lives_ok(
  $$ insert into share_items (share_id, item_id)
     select id, 'a9a9a9a9-0000-4000-8000-0000000000c2' from shares where title = 'Для родини' $$,
  'пряма вставка чернетки в посилання не падає…'
);

select is(
  (select count(*)::int from share_items si join shares s on s.id = si.share_id
    where s.title = 'Для родини' and si.item_id = 'a9a9a9a9-0000-4000-8000-0000000000c2'),
  0,
  '…але й не додає її'
);

select is(
  (select array_agg(e->>'title')
     from jsonb_array_elements(
            get_shared_list((select token from shares where title = 'Для родини'))->'items') as t(e)),
  array['Плед'],
  'гість бачить лише названу позицію'
);

select throws_ok(
  $$ update items set needs_title = true where id = 'a9a9a9a9-0000-4000-8000-0000000000c1' $$,
  '22023', null,
  'позиція, яка вже могла потрапити в посилання, чернеткою не стає'
);

update items set price = 1240 where id = 'a9a9a9a9-0000-4000-8000-0000000000c2';
select is((select needs_title from items where id = 'a9a9a9a9-0000-4000-8000-0000000000c2'), true,
          'зміна ціни чернетку чернеткою й лишає');

-- Так перейменовує v1: лише назва, без позначки.
update items set title = 'Керамічна лампа' where id = 'a9a9a9a9-0000-4000-8000-0000000000c2';
select is((select needs_title from items where id = 'a9a9a9a9-0000-4000-8000-0000000000c2'), false,
          'нова назва знімає позначку чернетки — і з v1, яка про чернетки не знає');

insert into items (id, list_id, title, url, needs_title) values
  ('a9a9a9a9-0000-4000-8000-0000000000c3', 'a9a9a9a9-0000-4000-8000-00000000000a',
   'shop.ua/pled', 'https://shop.ua/pled', true);
-- Так називає v2: назва може й збігтися з адресою, позначка знімається явно.
update items set title = 'shop.ua/pled', needs_title = false where id = 'a9a9a9a9-0000-4000-8000-0000000000c3';
select is((select needs_title from items where id = 'a9a9a9a9-0000-4000-8000-0000000000c3'), false,
          'явне needs_title = false знімає позначку навіть без зміни назви');

select lives_ok(
  $$ select create_share('a9a9a9a9-0000-4000-8000-00000000000a',
                         array['a9a9a9a9-0000-4000-8000-0000000000c2', 'a9a9a9a9-0000-4000-8000-0000000000c3']::uuid[],
                         'Колегам') $$,
  'названа колишня чернетка вже йде в посилання'
);

select is(
  (select count(*)::int from share_items si join shares s on s.id = si.share_id where s.title = 'Колегам'),
  2,
  'в посиланні обидві колишні чернетки'
);

reset role;
select * from finish();
rollback;
