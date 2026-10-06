-- Гостьова v2, крок 5а: підпис і пошта гостя (ADR-041, п. 2; ADR-053).
-- §3.2 — підпис і пошту бачить лише гість із ключем цієї ідентичності:
--        ні власник (навіть на власному посиланні), ні інший гість.
-- ADR-039 — get_guest_list і claim_item_v2 поводяться як v1 у всьому,
--        крім підпису й пошти; мертве посилання — та сама відповідь.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(22);

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

-- ── Дані ─────────────────────────────────────
-- Власник O, список L із двома позиціями: g1 (1 шт.), g2 (2 шт.).
-- Гості: K1 (підпишеться), K2 (без підпису).

insert into auth.users (id, email) values
  ('a1411111-0000-4000-8000-000000000001', 'owner14@test.local');

insert into public.lists (id, owner_id, title, currency) values
  ('a1411111-0000-4000-8000-00000000000a', 'a1411111-0000-4000-8000-000000000001', 'Новосілля', 'PLN');

insert into public.items (id, list_id, owner_id, title, price, quantity, status) values
  ('a1411111-0000-4000-8000-0000000000c1', 'a1411111-0000-4000-8000-00000000000a', 'a1411111-0000-4000-8000-000000000001', 'Чайник', 200, 1, 'active'),
  ('a1411111-0000-4000-8000-0000000000c2', 'a1411111-0000-4000-8000-00000000000a', 'a1411111-0000-4000-8000-000000000001', 'Келихи', 50,  2, 'active');

insert into public.shares (id, owner_id, source_list_id, token, title, revoked_at) values
  ('a1411111-0000-4000-8000-0000000000d1', 'a1411111-0000-4000-8000-000000000001', 'a1411111-0000-4000-8000-00000000000a', 'guestContactToken000001', 'Новосілля', null),
  ('a1411111-0000-4000-8000-0000000000d2', 'a1411111-0000-4000-8000-000000000001', 'a1411111-0000-4000-8000-00000000000a', 'guestContactRevoked0001', 'Старе',     now());

insert into public.share_items (share_id, item_id) values
  ('a1411111-0000-4000-8000-0000000000d1', 'a1411111-0000-4000-8000-0000000000c1'),
  ('a1411111-0000-4000-8000-0000000000d1', 'a1411111-0000-4000-8000-0000000000c2'),
  ('a1411111-0000-4000-8000-0000000000d2', 'a1411111-0000-4000-8000-0000000000c1');

-- ── Перевірка до позначки ────────────────────

select tests.as_anon();

select throws_ok(
  $$ select claim_item_v2('guestContactToken000001', 'a1411111-0000-4000-8000-0000000000c1',
                          'guestKeyOneAAAAAAAAAAAAA', 1, 'Іра', 'не-пошта') $$,
  '22023', 'bad_email', 'хибна пошта — bad_email'
);
select throws_ok(
  $$ select claim_item_v2('guestContactToken000001', 'a1411111-0000-4000-8000-0000000000c1',
                          'guestKeyOneAAAAAAAAAAAAA', 1, repeat('я', 61), null) $$,
  '22023', 'bad_name', 'підпис довший за 60 — bad_name'
);
select throws_ok(
  $$ select claim_item_v2('guestContactToken000001', 'a1411111-0000-4000-8000-0000000000c1',
                          'guestKeyOneAAAAAAAAAAAAA', 1, E'Іра\nІра', null) $$,
  '22023', 'bad_name', 'перенос рядка в підписі — bad_name'
);
select is(
  (get_guest_list('guestContactToken000001', 'guestKeyOneAAAAAAAAAAAAA')->'guest'),
  'null'::jsonb,
  'відхилена спроба не лишила позначки: ключ гостя ще нічий'
);

-- ── Позначка з підписом і поштою ─────────────

select is(
  claim_item_v2('guestContactToken000001', 'a1411111-0000-4000-8000-0000000000c1',
                'guestKeyOneAAAAAAAAAAAAA', 1, '  Іра  ', ' Ira@Pochta.UA ')->>'email',
  'ira@pochta.ua',
  'пошта обрізана й у нижньому регістрі'
);
select is(
  get_guest_list('guestContactToken000001', 'guestKeyOneAAAAAAAAAAAAA')->'guest'->>'name',
  'Іра',
  'гість бачить свій підпис, обрізаний'
);
select is(
  get_guest_list('guestContactToken000001', 'guestKeyOneAAAAAAAAAAAAA')->'guest'->>'email',
  'ira@pochta.ua',
  'гість бачить свою пошту'
);
select ok(
  get_guest_list('guestContactToken000001', 'guestKeyOneAAAAAAAAAAAAA')->'guest' ? 'code',
  'код гостя на місці, як у v1'
);

-- null — лишити, '' — прибрати.
select is(
  claim_item_v2('guestContactToken000001', 'a1411111-0000-4000-8000-0000000000c2',
                'guestKeyOneAAAAAAAAAAAAA', 1, null, null)->>'name',
  'Іра',
  'null у підписі — лишити як є'
);
select is(
  claim_item_v2('guestContactToken000001', 'a1411111-0000-4000-8000-0000000000c2',
                'guestKeyOneAAAAAAAAAAAAA', 1, 'Іра', '')->'email',
  'null'::jsonb,
  'порожня пошта — прибрати'
);

-- ── Інший гість нічого не бачить ─────────────

select is(
  claim_item_v2('guestContactToken000001', 'a1411111-0000-4000-8000-0000000000c2',
                'guestKeyTwoBBBBBBBBBBBBB', 1, null, null)->'name',
  'null'::jsonb,
  'другий гість без підпису — null, а не чужий підпис'
);
select ok(
  (get_guest_list('guestContactToken000001', 'guestKeyTwoBBBBBBBBBBBBB')::text !~ 'Іра'),
  'у відповіді іншому гостю немає ні підпису, ні пошти першого'
);
select is(
  get_guest_list('guestContactToken000001', null)->'guest',
  'null'::jsonb,
  'гість без ключа не отримує нічиїх даних'
);

-- ── Те саме, що v1 ───────────────────────────

select is(
  get_guest_list('guestContactToken000001', 'guestKeyTwoBBBBBBBBBBBBB') - 'guest',
  get_shared_list('guestContactToken000001', 'guestKeyTwoBBBBBBBBBBBBB') - 'guest',
  'get_guest_list — це get_shared_list, крім поля guest'
);
select throws_ok(
  $$ select claim_item_v2('guestContactToken000001', 'a1411111-0000-4000-8000-0000000000c1',
                          'guestKeyTwoBBBBBBBBBBBBB', 1, null, null) $$,
  '22023', 'not_enough_left', 'гонку програно — та сама помилка, що й у v1'
);
select throws_ok(
  $$ select get_guest_list('guestContactRevoked0001', null) $$,
  'P0002', 'not_found', 'відкликане посилання — not_found'
);
select throws_ok(
  $$ select get_guest_list('noSuchTokenAAAAAAAAAAAA', null) $$,
  'P0002', 'not_found', 'неіснуюче посилання — та сама відповідь'
);
select throws_ok(
  $$ select claim_item_v2('noSuchTokenAAAAAAAAAAAA', 'a1411111-0000-4000-8000-0000000000c1',
                          'guestKeyOneAAAAAAAAAAAAA', 1, null, null) $$,
  'P0002', 'not_found', 'claim_item_v2 на мертве посилання — not_found'
);

-- ── Власник ──────────────────────────────────

select tests.as_user('a1411111-0000-4000-8000-000000000001');

select is(
  get_guest_list('guestContactToken000001', 'guestKeyOneAAAAAAAAAAAAA')->'guest',
  'null'::jsonb,
  'власник навіть із ключем гостя не отримує ні підпису, ні пошти'
);
select ok(
  (get_guest_list('guestContactToken000001', 'guestKeyOneAAAAAAAAAAAAA')::text !~ 'Іра'),
  'у відповіді власнику підпису гостя немає ніде'
);
select throws_ok(
  $$ select claim_item_v2('guestContactToken000001', 'a1411111-0000-4000-8000-0000000000c2',
                          'guestKeyOneAAAAAAAAAAAAA', 1, null, null) $$,
  '22023', 'owner_cannot_reserve', 'власник не бронює й у v2'
);
select throws_ok(
  $$ select name, email from guest_identities $$,
  '42501', null, 'власник не читає guest_identities напряму'
);

select * from finish();
rollback;
