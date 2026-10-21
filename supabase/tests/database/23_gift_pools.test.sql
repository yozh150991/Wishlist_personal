-- Дизайн v2, крок 7а (ADR-063): спільний подарунок.
-- Збір бере позицію, як «Беру»; учасники обіцяють суми; імена бачить лише
-- організатор, свою суму — учасник, підсумок — усі гості; власник — нічого.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(29);

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

-- Позиція з гостьової відповіді за ключем.
create function tests.item(p_key text, p_item uuid) returns jsonb language sql as $$
  select e from jsonb_array_elements(public.get_guest_list('poolToken00000000000001', p_key)->'items') e
   where (e->>'id')::uuid = p_item
$$;

grant execute on all functions in schema tests to anon, authenticated;

insert into auth.users (id, email, email_confirmed_at) values
  ('a2311111-0000-4000-8000-00000000000f', 'owner23@test.local', now());

insert into public.lists (id, owner_id, title, currency, event_date) values
  ('a2311111-0000-4000-8000-00000000000a', 'a2311111-0000-4000-8000-00000000000f', 'Ювілей', 'PLN', current_date + 14);

insert into public.items (id, list_id, owner_id, title, price, quantity, status) values
  ('a2311111-0000-4000-8000-0000000000c1', 'a2311111-0000-4000-8000-00000000000a', 'a2311111-0000-4000-8000-00000000000f', 'Кавоварка', 400,  1, 'active'),
  ('a2311111-0000-4000-8000-0000000000c2', 'a2311111-0000-4000-8000-00000000000a', 'a2311111-0000-4000-8000-00000000000f', 'Тарілки',    30,  3, 'active'),
  ('a2311111-0000-4000-8000-0000000000c3', 'a2311111-0000-4000-8000-00000000000a', 'a2311111-0000-4000-8000-00000000000f', 'Велосипед', null, 1, 'active');

insert into public.shares (id, owner_id, source_list_id, token, title) values
  ('a2311111-0000-4000-8000-0000000000d1', 'a2311111-0000-4000-8000-00000000000f', 'a2311111-0000-4000-8000-00000000000a', 'poolToken00000000000001', 'Ювілей тата');

insert into public.share_items (share_id, item_id)
select 'a2311111-0000-4000-8000-0000000000d1'::uuid, id from public.items
 where list_id = 'a2311111-0000-4000-8000-00000000000a';

-- ── Відкрити збір ────────────────────────────

select tests.as_anon();
create temp table pool_a as
select (public.start_pool('poolToken00000000000001', 'a2311111-0000-4000-8000-0000000000c1',
                          'poolKeyOrganizerAAAAAAAA', 'Оля', 'BLIK на +48 500 000 000')->>'pool_id')::uuid as id;
grant select on pool_a to anon, authenticated;

select isnt((select id from pool_a), null, 'збір відкрито');
select is((tests.item('poolKeyOrganizerAAAAAAAA', 'a2311111-0000-4000-8000-0000000000c1')->'pool'->>'goal')::numeric, 400::numeric,
          'ціль без значення — ціна позиції');
select is(tests.item('poolKeyOrganizerAAAAAAAA', 'a2311111-0000-4000-8000-0000000000c1')->>'mine_qty', '1',
          'збір бере позицію, як «Беру»');
select is(tests.item('poolKeyOrganizerAAAAAAAA', 'a2311111-0000-4000-8000-0000000000c1')->'pool'->>'is_organizer', 'true',
          'організатор бачить себе організатором');

select throws_ok(
  $$ select public.start_pool('poolToken00000000000001', 'a2311111-0000-4000-8000-0000000000c1',
                              'poolKeyOtherBBBBBBBBBBBB', 'Ігор', 'Картка') $$,
  '22023', 'not_enough_left', 'другий збір на ту саму позицію — гонку програно');
select throws_ok(
  $$ select public.start_pool('poolToken00000000000001', 'a2311111-0000-4000-8000-0000000000c2',
                              'poolKeyOtherBBBBBBBBBBBB', 'Ігор', 'Картка') $$,
  '22023', 'pool_single_only', 'на позицію з кількістю 3 — ні');
select throws_ok(
  $$ select public.start_pool('poolToken00000000000001', 'a2311111-0000-4000-8000-0000000000c3',
                              'poolKeyOtherBBBBBBBBBBBB', 'Ігор', 'Картка') $$,
  '22023', 'bad_goal', 'без ціни й без цілі — bad_goal');
select throws_ok(
  $$ select public.start_pool('poolToken00000000000001', 'a2311111-0000-4000-8000-0000000000c3',
                              'poolKeyOtherBBBBBBBBBBBB', '  ', 'Картка', 1500) $$,
  '22023', 'bad_name', 'без імені організатора — ні');

-- ── Долучитися ───────────────────────────────

select isnt(public.pledge_pool('poolToken00000000000001', (select id from pool_a), 'poolKeyGuestTwoCCCCCCCCC', 'Тарас', 100)->>'code', null,
            'новий гість долучається й отримує код');
select public.pledge_pool('poolToken00000000000001', (select id from pool_a), 'poolKeyGuestThreeDDDDDDD', 'Марія', 150);
select public.pledge_pool('poolToken00000000000001', (select id from pool_a), 'poolKeyGuestTwoCCCCCCCCC', 'Тарас', 120);

select is((tests.item('poolKeyGuestTwoCCCCCCCCC', 'a2311111-0000-4000-8000-0000000000c1')->'pool'->>'mine')::numeric, 120::numeric,
          'учасник бачить свою суму — оновлену, а не другу');
select is((tests.item('poolKeyGuestTwoCCCCCCCCC', 'a2311111-0000-4000-8000-0000000000c1')->'pool'->>'raised')::numeric, 270::numeric,
          'зібрано — сума обіцянок');
select is(tests.item('poolKeyGuestTwoCCCCCCCCC', 'a2311111-0000-4000-8000-0000000000c1')->'pool'->'pledges', 'null'::jsonb,
          'учасник не бачить імен інших');
select is(tests.item(null, 'a2311111-0000-4000-8000-0000000000c1')->'pool'->>'count', '2',
          'гість без ключа бачить число учасників');
select ok(tests.item(null, 'a2311111-0000-4000-8000-0000000000c1')::text !~ 'Тарас|Марія',
          'і жодного імені учасника');
select is(tests.item(null, 'a2311111-0000-4000-8000-0000000000c1')->'pool'->>'instructions', 'BLIK на +48 500 000 000',
          '«як скинутися» видно всім гостям');
select is((select string_agg(e->>'name' || '=' || (e->>'amount'), ',' order by e->>'name')
             from jsonb_array_elements(tests.item('poolKeyOrganizerAAAAAAAA', 'a2311111-0000-4000-8000-0000000000c1')->'pool'->'pledges') e),
          'Марія=150.00,Тарас=120.00', 'організатор бачить, хто скільки обіцяв');

-- ── Власник ──────────────────────────────────

select tests.as_user('a2311111-0000-4000-8000-00000000000f');
select ok(public.get_guest_list('poolToken00000000000001', null)::text !~ '"pool"|Оля|BLIK',
          'власник на своєму посиланні не бачить збору (§3.2)');
select throws_ok(
  $$ select public.pledge_pool('poolToken00000000000001', (select id from pool_a), 'poolKeyOwnerEEEEEEEEEEEE', 'Я', 50) $$,
  '22023', 'owner_cannot_reserve', 'власник не скидається на свій подарунок');
select throws_ok($$ select count(*) from public.gift_pools $$, '42501', null, 'власник не читає таблиці зборів');
select throws_ok($$ select count(*) from public.gift_pool_pledges $$, '42501', null, 'і таблиці обіцянок');

-- ── Організатор закриває ─────────────────────

select tests.as_anon();
select throws_ok(
  $$ select public.close_pool('poolToken00000000000001', (select id from pool_a), 'poolKeyGuestTwoCCCCCCCCC', true) $$,
  '42501', 'not_organizer', 'учасник збір не закриває');
select public.close_pool('poolToken00000000000001', (select id from pool_a), 'poolKeyOrganizerAAAAAAAA', true);
select throws_ok(
  $$ select public.pledge_pool('poolToken00000000000001', (select id from pool_a), 'poolKeyGuestFourFFFFFFFF', 'Ніна', 30) $$,
  '22023', 'pool_closed', 'у закритий збір не долучитися');
select public.close_pool('poolToken00000000000001', (select id from pool_a), 'poolKeyOrganizerAAAAAAAA', false);
select public.leave_pool('poolToken00000000000001', (select id from pool_a), 'poolKeyGuestThreeDDDDDDD');
select is(tests.item(null, 'a2311111-0000-4000-8000-0000000000c1')->'pool'->>'count', '1', 'учасник вийшов зі збору');

-- ── Скасувати й сліпе скидання ───────────────

create temp table pool_c as
select (public.start_pool('poolToken00000000000001', 'a2311111-0000-4000-8000-0000000000c3',
                          'poolKeyOtherBBBBBBBBBBBB', 'Ігор', 'Картка 1234', 1500)->>'pool_id')::uuid as id;
grant select on pool_c to anon, authenticated;
select is((tests.item(null, 'a2311111-0000-4000-8000-0000000000c3')->'pool'->>'goal')::numeric, 1500::numeric,
          'без ціни — своя ціль організатора');

select tests.as_postgres();
update public.lists set is_archived = true where id = 'a2311111-0000-4000-8000-00000000000a';
select tests.as_anon();
select throws_ok(
  $$ select public.pledge_pool('poolToken00000000000001', (select id from pool_c), 'poolKeyGuestTwoCCCCCCCCC', 'Тарас', 50) $$,
  '22023', 'list_archived', 'на архівному списку не скидаються');
select tests.as_postgres();
update public.lists set is_archived = false where id = 'a2311111-0000-4000-8000-00000000000a';

select tests.as_anon();
select public.cancel_pool('poolToken00000000000001', (select id from pool_c), 'poolKeyOtherBBBBBBBBBBBB');
select ok(not (tests.item(null, 'a2311111-0000-4000-8000-0000000000c3') ? 'pool')
          and tests.item(null, 'a2311111-0000-4000-8000-0000000000c3')->>'taken_qty' = '0',
          'скасований збір звільняє позицію');

select tests.as_user('a2311111-0000-4000-8000-00000000000f');
select public.release_item_claims('a2311111-0000-4000-8000-0000000000c1');
select tests.as_postgres();
select is((select count(*)::int from public.gift_pools), 0, 'сліпе скидання броней власником прибирає й збір');
select is((select count(*)::int from public.gift_pool_pledges), 0, 'разом з обіцянками');

select has_trigger('public', 'claims', 'gift_pool_release', 'збір живе на броні організатора');

select * from finish();
rollback;
