-- Розділи й ручний порядок (ADR-036).
-- Розділ — мітка власника; порядок, який він задав, бачить гість. Чужі розділи
-- не видно й не змінити, розділ чужого списку не причепити, видалений розділ
-- лишає позиції в «Інше».

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(16);

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

grant execute on all functions in schema tests to anon, authenticated;

insert into auth.users (id, email) values
  ('a6a6a6a6-0000-4000-8000-000000000001', 'sections-a@test.local'),
  ('b6b6b6b6-0000-4000-8000-000000000001', 'sections-b@test.local');

insert into public.lists (id, owner_id, title) values
  ('a6a6a6a6-0000-4000-8000-00000000000a', 'a6a6a6a6-0000-4000-8000-000000000001', 'Новосілля'),
  ('a6a6a6a6-0000-4000-8000-00000000000b', 'a6a6a6a6-0000-4000-8000-000000000001', 'Інший список A'),
  ('b6b6b6b6-0000-4000-8000-00000000000a', 'b6b6b6b6-0000-4000-8000-000000000001', 'Список B');

insert into public.items (id, list_id, owner_id, title, created_at) values
  ('a6a6a6a6-0000-4000-8000-0000000000c1', 'a6a6a6a6-0000-4000-8000-00000000000a', 'a6a6a6a6-0000-4000-8000-000000000001', 'Сковорода', now() - interval '5 min'),
  ('a6a6a6a6-0000-4000-8000-0000000000c2', 'a6a6a6a6-0000-4000-8000-00000000000a', 'a6a6a6a6-0000-4000-8000-000000000001', 'Дошка',     now() - interval '4 min'),
  ('a6a6a6a6-0000-4000-8000-0000000000c3', 'a6a6a6a6-0000-4000-8000-00000000000a', 'a6a6a6a6-0000-4000-8000-000000000001', 'Постіль',   now() - interval '3 min'),
  ('a6a6a6a6-0000-4000-8000-0000000000c4', 'a6a6a6a6-0000-4000-8000-00000000000a', 'a6a6a6a6-0000-4000-8000-000000000001', 'Лампа',     now() - interval '2 min'),
  ('a6a6a6a6-0000-4000-8000-0000000000c5', 'a6a6a6a6-0000-4000-8000-00000000000a', 'a6a6a6a6-0000-4000-8000-000000000001', 'Не в шері', now() - interval '1 min');

insert into public.shares (id, owner_id, source_list_id, token, title) values
  ('a6a6a6a6-0000-4000-8000-0000000000d1', 'a6a6a6a6-0000-4000-8000-000000000001',
   'a6a6a6a6-0000-4000-8000-00000000000a', 'sectionsToken0000000000', 'Новосілля');
insert into public.share_items (share_id, item_id)
select 'a6a6a6a6-0000-4000-8000-0000000000d1', id from public.items
 where list_id = 'a6a6a6a6-0000-4000-8000-00000000000a' and title <> 'Не в шері';

-- ── Власник ──────────────────────────────────

select tests.as_user('a6a6a6a6-0000-4000-8000-000000000001');

insert into sections (id, list_id, title, position) values
  ('a6a6a6a6-0000-4000-8000-0000000000e1', 'a6a6a6a6-0000-4000-8000-00000000000a', 'Кухня',   1),
  ('a6a6a6a6-0000-4000-8000-0000000000e2', 'a6a6a6a6-0000-4000-8000-00000000000a', 'Спальня', 2),
  ('a6a6a6a6-0000-4000-8000-0000000000e3', 'a6a6a6a6-0000-4000-8000-00000000000a', 'Порожній', 3),
  ('a6a6a6a6-0000-4000-8000-0000000000e9', 'a6a6a6a6-0000-4000-8000-00000000000b', 'Чужий список', 1);

select is((select owner_id from sections where id = 'a6a6a6a6-0000-4000-8000-0000000000e1'),
          'a6a6a6a6-0000-4000-8000-000000000001'::uuid, 'власника розділу проставляє база');

select throws_ok($$ insert into sections (list_id, title) values ('a6a6a6a6-0000-4000-8000-00000000000a', repeat('я', 61)) $$,
                 '23514', null, 'назва розділу довша за 60 символів не приймається');

select throws_ok($$ update items set section_id = 'a6a6a6a6-0000-4000-8000-0000000000e9'
                     where id = 'a6a6a6a6-0000-4000-8000-0000000000c1' $$,
                 '23514', 'section_not_in_list', 'розділ іншого списку до позиції не причепити');

-- Кухня: Дошка, Сковорода. Спальня: Постіль. Лампа — без розділу, «Інше».
select lives_ok($$ select reorder_items('a6a6a6a6-0000-4000-8000-00000000000a', 'a6a6a6a6-0000-4000-8000-0000000000e1',
                                        array['a6a6a6a6-0000-4000-8000-0000000000c2', 'a6a6a6a6-0000-4000-8000-0000000000c1']::uuid[]) $$,
                'власник впорядковує позиції розділу одним викликом');
select reorder_items('a6a6a6a6-0000-4000-8000-00000000000a', 'a6a6a6a6-0000-4000-8000-0000000000e2',
                     array['a6a6a6a6-0000-4000-8000-0000000000c3']::uuid[]);

select is((select array_agg(title order by position) from items where section_id = 'a6a6a6a6-0000-4000-8000-0000000000e1'),
          array['Дошка', 'Сковорода'], 'порядок у розділі — той, що задав власник');

-- ── Інший користувач ─────────────────────────

reset role;
select tests.as_user('b6b6b6b6-0000-4000-8000-000000000001');

select is((select count(*)::int from sections where list_id = 'a6a6a6a6-0000-4000-8000-00000000000a'), 0,
          'чужі розділи не видно');
select throws_ok($$ insert into sections (list_id, title) values ('a6a6a6a6-0000-4000-8000-00000000000a', 'Злам') $$,
                 '42501', null, 'у чужий список розділ не додати');
select reorder_items('a6a6a6a6-0000-4000-8000-00000000000a', null,
                     array['a6a6a6a6-0000-4000-8000-0000000000c1', 'a6a6a6a6-0000-4000-8000-0000000000c2']::uuid[]);
select reorder_sections('a6a6a6a6-0000-4000-8000-00000000000a',
                        array['a6a6a6a6-0000-4000-8000-0000000000e2', 'a6a6a6a6-0000-4000-8000-0000000000e1']::uuid[]);

reset role;
select is((select array_agg(title order by position) from items where section_id = 'a6a6a6a6-0000-4000-8000-0000000000e1'),
          array['Дошка', 'Сковорода'], 'чужий reorder_items нічого не змінює — RLS відсіяв');
select is((select array_agg(title order by position) from sections where list_id = 'a6a6a6a6-0000-4000-8000-00000000000a'),
          array['Кухня', 'Спальня', 'Порожній'], 'чужий reorder_sections нічого не змінює');

-- ── Гість ────────────────────────────────────

select tests.as_anon();

select is(
  (select array_agg(e->>'title' order by ord)
     from jsonb_array_elements(get_shared_list('sectionsToken0000000000')->'items') with ordinality as t(e, ord)),
  array['Дошка', 'Сковорода', 'Постіль', 'Лампа'],
  'гість бачить ручний порядок: розділи за порядком, усередині — як задав власник, «Інше» в кінці'
);
select is(
  (select array_agg(e->>'title' order by ord)
     from jsonb_array_elements(get_shared_list('sectionsToken0000000000')->'sections') with ordinality as t(e, ord)),
  array['Кухня', 'Спальня'],
  'розділи без спільних позицій гостю не віддаються'
);
select throws_ok($$ select * from sections $$, '42501', null, 'anon не читає розділи напряму');
select throws_ok($$ select reorder_items('a6a6a6a6-0000-4000-8000-00000000000a', null, array[]::uuid[]) $$,
                 '42501', null, 'anon не впорядковує');

-- Перестановка розділів змінює порядок у гостя.
reset role;
select tests.as_user('a6a6a6a6-0000-4000-8000-000000000001');
select reorder_sections('a6a6a6a6-0000-4000-8000-00000000000a',
                        array['a6a6a6a6-0000-4000-8000-0000000000e2', 'a6a6a6a6-0000-4000-8000-0000000000e1']::uuid[]);
select tests.as_anon();
select is(
  (select array_agg(e->>'title' order by ord)
     from jsonb_array_elements(get_shared_list('sectionsToken0000000000')->'items') with ordinality as t(e, ord)),
  array['Постіль', 'Дошка', 'Сковорода', 'Лампа'],
  'порядок розділів теж той, що задав власник'
);

-- ── Видалення розділу ────────────────────────

reset role;
select tests.as_user('a6a6a6a6-0000-4000-8000-000000000001');
delete from sections where id = 'a6a6a6a6-0000-4000-8000-0000000000e1';
select is((select count(*)::int from items where list_id = 'a6a6a6a6-0000-4000-8000-00000000000a'), 5,
          'видалення розділу не видаляє позицій');
select is((select section_id from items where id = 'a6a6a6a6-0000-4000-8000-0000000000c1'), null,
          'позиції видаленого розділу переходять у «Інше»');

reset role;
select * from finish();
rollback;
