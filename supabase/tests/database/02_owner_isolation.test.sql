-- Інваріант §3.1: головний список не доступний нікому, крім власника.
-- Два користувачі, A і B. B пробує всіма шляхами дістатися до даних A,
-- гість пробує прочитати таблиці напряму.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(24);

-- ── Помічники ────────────────────────────────

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

-- ── Дані (як суперкористувач, RLS не заважає) ─

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a@test.local'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'b@test.local');

insert into public.lists (id, owner_id, title) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 'Список A'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-000000000001', 'Список B');

insert into public.items (id, list_id, owner_id, title, price) values
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'aaaaaaaa-0000-4000-8000-00000000000a',
   'aaaaaaaa-0000-4000-8000-000000000001', 'Позиція A', 100),
  ('bbbbbbbb-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-00000000000b',
   'bbbbbbbb-0000-4000-8000-000000000001', 'Позиція B', 50);

insert into public.shares (id, owner_id, source_list_id, token, title) values
  ('aaaaaaaa-0000-4000-8000-0000000005a1', 'aaaaaaaa-0000-4000-8000-000000000001',
   'aaaaaaaa-0000-4000-8000-00000000000a', 'tokenAAAAAAAAAAAAAAAAAAAA', 'Шер A'),
  ('bbbbbbbb-0000-4000-8000-0000000005b1', 'bbbbbbbb-0000-4000-8000-000000000001',
   'bbbbbbbb-0000-4000-8000-00000000000b', 'tokenBBBBBBBBBBBBBBBBBBBB', 'Шер B');

insert into public.share_items (share_id, item_id) values
  ('aaaaaaaa-0000-4000-8000-0000000005a1', 'aaaaaaaa-0000-4000-8000-0000000000a1');

-- ── A бачить своє: тести нижче не порожні за побудовою ──

select tests.as_user('aaaaaaaa-0000-4000-8000-000000000001');

select is((select count(*)::int from lists), 1, 'A бачить рівно свій список');
select is((select count(*)::int from items), 1, 'A бачить рівно свою позицію');
select is(
  (select count(*)::int from list_items_page('aaaaaaaa-0000-4000-8000-00000000000a')),
  1, 'list_items_page повертає позицію власнику'
);

-- ── B не бачить нічого з A ───────────────────

reset role;
select tests.as_user('bbbbbbbb-0000-4000-8000-000000000001');

select is((select count(*)::int from lists  where owner_id = 'aaaaaaaa-0000-4000-8000-000000000001'), 0,
          'B не бачить списків A — 0 рядків, не помилка');
select is((select count(*)::int from items  where owner_id = 'aaaaaaaa-0000-4000-8000-000000000001'), 0,
          'B не бачить позицій A');
select is((select count(*)::int from shares where owner_id = 'aaaaaaaa-0000-4000-8000-000000000001'), 0,
          'B не бачить посилань A');
select is((select count(*)::int from share_items where share_id = 'aaaaaaaa-0000-4000-8000-0000000005a1'), 0,
          'B не бачить складу посилань A');
select is((select count(*)::int from profiles where id = 'aaaaaaaa-0000-4000-8000-000000000001'), 0,
          'B не бачить профілю A');
select is_empty(
  $$ select 1 from list_items_page('aaaaaaaa-0000-4000-8000-00000000000a') $$,
  'list_items_page на чужому списку порожній'
);
select is(
  (select items_count from list_totals('aaaaaaaa-0000-4000-8000-00000000000a')),
  0, 'list_totals на чужому списку нічого не рахує'
);

-- ── B не може змінити дані A ─────────────────

update items set title = 'зламано' where id = 'aaaaaaaa-0000-4000-8000-0000000000a1';
delete from lists where id = 'aaaaaaaa-0000-4000-8000-00000000000a';
update shares set revoked_at = now() where id = 'aaaaaaaa-0000-4000-8000-0000000005a1';

select throws_ok(
  $$ insert into items (list_id, owner_id, title)
     values ('aaaaaaaa-0000-4000-8000-00000000000a', 'bbbbbbbb-0000-4000-8000-000000000001', 'підкинуто') $$,
  '42501', null, 'B не додає позицію в список A'
);
select throws_ok(
  $$ update items set list_id = 'aaaaaaaa-0000-4000-8000-00000000000a'
      where id = 'bbbbbbbb-0000-4000-8000-0000000000b1' $$,
  '42501', null, 'B не переносить свою позицію в список A'
);
select throws_ok(
  $$ select create_share('aaaaaaaa-0000-4000-8000-00000000000a',
                         array['aaaaaaaa-0000-4000-8000-0000000000a1']::uuid[], 'чуже') $$,
  '42501', null, 'B не створює посилання на список A'
);
select throws_ok(
  $$ insert into share_items (share_id, item_id)
     values ('bbbbbbbb-0000-4000-8000-0000000005b1', 'aaaaaaaa-0000-4000-8000-0000000000a1') $$,
  '42501', null, 'B не додає позицію A у своє посилання'
);

reset role;

select is((select title from items where id = 'aaaaaaaa-0000-4000-8000-0000000000a1'), 'Позиція A',
          'UPDATE від B не змінив позицію A');
select ok(exists (select 1 from lists where id = 'aaaaaaaa-0000-4000-8000-00000000000a'),
          'DELETE від B не видалив список A');
select is((select revoked_at from shares where id = 'aaaaaaaa-0000-4000-8000-0000000005a1'), null,
          'UPDATE від B не відкликав посилання A');

-- ── Гість не читає таблиці напряму (§3.3) ────

select tests.as_anon();

select throws_ok($$ select * from lists $$,        '42501', null, 'anon: lists недоступна');
select throws_ok($$ select * from items $$,        '42501', null, 'anon: items недоступна');
select throws_ok($$ select * from shares $$,       '42501', null, 'anon: shares недоступна');
select throws_ok($$ select * from share_items $$,  '42501', null, 'anon: share_items недоступна');
select throws_ok($$ select * from profiles $$,     '42501', null, 'anon: profiles недоступна');
select throws_ok($$ select * from reservations $$, '42501', null, 'anon: reservations недоступна');
select throws_ok(
  $$ select * from list_items_page('aaaaaaaa-0000-4000-8000-00000000000a') $$,
  '42501', null, 'anon не викликає list_items_page'
);

reset role;

select * from finish();
rollback;
