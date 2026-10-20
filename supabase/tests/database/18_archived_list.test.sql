-- Гостьова v2, крок 5д (ADR-058): архівний список гості бачать, але не бронюють.
-- Перевіряє гостьову відповідь і бронь (get_guest_list, claim_item_v2; до
-- ADR-065 — ще й v1 напряму, тож деякі перевірки йдуть парами), що власні справи гостя
-- з бронню на архівному лишаються можливими, а правки власника — тихими, і що
-- «Повернути з архіву» знову відкриває бронювання.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(17);

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

create function tests.as_postgres() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'postgres', true);
end $$;

grant execute on all functions in schema tests to anon, authenticated;

insert into auth.users (id, email) values
  ('a1811111-0000-4000-8000-000000000001', 'owner18@test.local');

insert into public.lists (id, owner_id, title, currency, event_date) values
  ('a1811111-0000-4000-8000-00000000000a', 'a1811111-0000-4000-8000-000000000001', 'Новосілля', 'PLN',
   current_date - 3);

insert into public.items (id, list_id, owner_id, title, price, quantity, status) values
  ('a1811111-0000-4000-8000-0000000000c1', 'a1811111-0000-4000-8000-00000000000a', 'a1811111-0000-4000-8000-000000000001', 'Сковорідка', 300, 2, 'active'),
  ('a1811111-0000-4000-8000-0000000000c2', 'a1811111-0000-4000-8000-00000000000a', 'a1811111-0000-4000-8000-000000000001', 'Рушники',    120, 1, 'active'),
  ('a1811111-0000-4000-8000-0000000000c3', 'a1811111-0000-4000-8000-00000000000a', 'a1811111-0000-4000-8000-000000000001', 'Ваза',       200, 1, 'active');

insert into public.shares (id, owner_id, source_list_id, token, title) values
  ('a1811111-0000-4000-8000-0000000000d1', 'a1811111-0000-4000-8000-000000000001', 'a1811111-0000-4000-8000-00000000000a', 'archivedToken0000000001', 'Новосілля');

insert into public.share_items (share_id, item_id)
select 'a1811111-0000-4000-8000-0000000000d1'::uuid, id from public.items
 where list_id = 'a1811111-0000-4000-8000-00000000000a';

-- ── До архіву ────────────────────────────────

select tests.as_anon();
select claim_item_v2('archivedToken0000000001', 'a1811111-0000-4000-8000-0000000000c1',
                     'archivedKeyAAAAAAAAAAAAA', 1, null, null, 'uk');
select claim_item_v2('archivedToken0000000001', 'a1811111-0000-4000-8000-0000000000c2',
                     'archivedKeyAAAAAAAAAAAAA', 1, null, null, 'uk');

select is(public.get_guest_list('archivedToken0000000001', 'archivedKeyAAAAAAAAAAAAA')->>'archived', 'false',
          'звичайний список — archived: false');
select is(public.get_guest_list('archivedToken0000000001', 'archivedKeyAAAAAAAAAAAAA')->>'allow_reservations', 'true',
          'звичайний список — бронювати можна');

-- ── Власник архівує ──────────────────────────

select tests.as_user('a1811111-0000-4000-8000-000000000001');
update public.lists set is_archived = true where id = 'a1811111-0000-4000-8000-00000000000a';

select tests.as_anon();
select is(public.get_guest_list('archivedToken0000000001', 'archivedKeyAAAAAAAAAAAAA')->>'archived', 'true',
          'гостьова v2 знає, що список в архіві');
select is(public.get_guest_list('archivedToken0000000001', 'archivedKeyAAAAAAAAAAAAA')->>'allow_reservations', 'false',
          'гостьова v2: бронювати не можна');
select is(public.get_guest_list('archivedToken0000000001', null)->>'allow_reservations', 'false',
          'і гість без ключа: бронювати не можна');
select is(jsonb_array_length(public.get_guest_list('archivedToken0000000001', null)->'items'), 3,
          'позиції архівного списку видно');

select throws_ok(
  $$ select claim_item_v2('archivedToken0000000001', 'a1811111-0000-4000-8000-0000000000c3',
                          'archivedKeyBBBBBBBBBBBBB', 1, null, null, 'uk') $$,
  '22023', 'list_archived', 'нова бронь через v2 — list_archived');
select throws_ok(
  $$ select claim_item_v2('archivedToken0000000001', 'a1811111-0000-4000-8000-0000000000c3',
                       'archivedKeyBBBBBBBBBBBBB', 1) $$,
  '22023', 'list_archived', 'друга спроба броні — теж list_archived');
select throws_ok(
  $$ select claim_item_v2('archivedToken0000000001', 'a1811111-0000-4000-8000-0000000000c1',
                          'archivedKeyAAAAAAAAAAAAA', 2, null, null, 'uk') $$,
  '22023', 'list_archived', 'більше примірників до наявної броні — теж ні');

select tests.as_postgres();
select is((select count(*)::int from public.guest_identities
            where list_id = 'a1811111-0000-4000-8000-00000000000a'), 1,
          'відмова не лишає нової ідентичності гостя');

-- ── Свої справи з бронню — можна ─────────────

select tests.as_anon();
select is(public.get_guest_list('archivedToken0000000001', 'archivedKeyAAAAAAAAAAAAA')->'guest' ? 'code', true,
          'гість із ключем і далі отримує свій код');
select lives_ok(
  $$ select set_claim_bought('archivedToken0000000001', 'a1811111-0000-4000-8000-0000000000c2',
                             'archivedKeyAAAAAAAAAAAAA', true) $$,
  '«Уже куплено» на архівному — можна');
select lives_ok(
  $$ select release_claim('archivedToken0000000001', 'a1811111-0000-4000-8000-0000000000c1',
                          'archivedKeyAAAAAAAAAAAAA') $$,
  '«Зняти» на архівному — можна');

select tests.as_postgres();
select is((select count(*)::int from public.claims
            where item_id = 'a1811111-0000-4000-8000-0000000000c1'), 0,
          'бронь знято');

-- ── Власник править позицію з бронню — тихо ──

select tests.as_user('a1811111-0000-4000-8000-000000000001');
select lives_ok(
  $$ update public.items set title = 'Рушники махрові' where id = 'a1811111-0000-4000-8000-0000000000c2' $$,
  'правка позиції з бронню на архівному не падає (§3.2)');

-- ── «Повернути з архіву» ─────────────────────

update public.lists set is_archived = false where id = 'a1811111-0000-4000-8000-00000000000a';

select tests.as_anon();
select lives_ok(
  $$ select claim_item_v2('archivedToken0000000001', 'a1811111-0000-4000-8000-0000000000c3',
                          'archivedKeyBBBBBBBBBBBBB', 1, null, null, 'uk') $$,
  'після «Повернути з архіву» бронювати знову можна');

select tests.as_postgres();
select has_trigger('public', 'claims', 'claims_archived_guard', 'на claims стоїть стражник архіву');

select * from finish();
rollback;
