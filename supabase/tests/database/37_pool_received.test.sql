-- ROADMAP 8.14: збір — «обіцяно» й «отримано».
-- Позначку «отримано» ставить і знімає лише організатор збору; гості бачать
-- «отримано X з Y» сумою, учасник — що його внесок отримано; власник списку —
-- нічого, і жодна його відповідь від позначки не залежить (CLAUDE.md §3.2, ADR-038).

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(40);

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

-- Збір позиції з гостьової відповіді за ключем.
create function tests.pool(p_key text) returns jsonb language sql as $$
  select e->'pool' from jsonb_array_elements(public.get_guest_list('recvToken00000000000001', p_key)->'items') e
   where (e->>'id')::uuid = 'a3711111-0000-4000-8000-0000000000c1'
$$;

-- Ідентифікатор внеску за іменем — так, як його бачить організатор.
create function tests.pledge(p_name text) returns uuid language sql as $$
  select (e->>'id')::uuid from jsonb_array_elements(tests.pool('recvKeyOrganizerAAAAAAAA')->'pledges') e
   where e->>'name' = p_name
$$;

create function tests.pool_id() returns uuid language sql security definer as $$
  select id from public.gift_pools where item_id = 'a3711111-0000-4000-8000-0000000000c1'
$$;

create function tests.mails(p_kind text) returns table (email text, details jsonb)
language sql security definer as $$
  select g.email, m.details
    from public.guest_mail m join public.guest_identities g on g.id = m.identity_id
   where m.kind = p_kind
   order by m.created_at, g.email
$$;

-- Усе, що власник може спитати про свій список: позиції, підсумки, свою
-- гостьову, «Я дарую», сирі рядки. Знімок до позначки має збігтися з після.
create function tests.owner_view() returns text language sql as $$
  select concat_ws(' | ',
    (select jsonb_agg(to_jsonb(i) order by i.id)::text
       from public.list_items_page('a3711111-0000-4000-8000-00000000000a') i),
    (select jsonb_agg(to_jsonb(t))::text from public.list_totals('a3711111-0000-4000-8000-00000000000a') t),
    public.get_guest_list('recvToken00000000000001', null)::text,
    public.get_my_gifts()::text,
    (select jsonb_agg(to_jsonb(i) order by i.id)::text from public.items i
      where i.list_id = 'a3711111-0000-4000-8000-00000000000a'),
    (select to_jsonb(l)::text from public.lists l where l.id = 'a3711111-0000-4000-8000-00000000000a'))
$$;

grant execute on all functions in schema tests to anon, authenticated;
create temp table snap (k text primary key, v text);
grant all on snap to anon, authenticated;

insert into auth.users (id, email, email_confirmed_at) values
  ('a3711111-0000-4000-8000-00000000000f', 'owner37@test.local', now()),
  ('a3711111-0000-4000-8000-0000000000aa', 'taras37@test.local', now());

insert into public.lists (id, owner_id, title, currency, event_date) values
  ('a3711111-0000-4000-8000-00000000000a', 'a3711111-0000-4000-8000-00000000000f', 'Ювілей', 'PLN', current_date + 14);

insert into public.items (id, list_id, owner_id, title, price, quantity, status) values
  ('a3711111-0000-4000-8000-0000000000c1', 'a3711111-0000-4000-8000-00000000000a', 'a3711111-0000-4000-8000-00000000000f', 'Кавоварка', 400, 1, 'active');

insert into public.shares (id, owner_id, source_list_id, token, title) values
  ('a3711111-0000-4000-8000-0000000000d1', 'a3711111-0000-4000-8000-00000000000f', 'a3711111-0000-4000-8000-00000000000a', 'recvToken00000000000001', 'Ювілей тата'),
  ('a3711111-0000-4000-8000-0000000000d2', 'a3711111-0000-4000-8000-00000000000f', 'a3711111-0000-4000-8000-00000000000a', 'recvTokenRevoked0000001', 'Старе');
update public.shares set revoked_at = now() where id = 'a3711111-0000-4000-8000-0000000000d2';

insert into public.share_items (share_id, item_id) values
  ('a3711111-0000-4000-8000-0000000000d1', 'a3711111-0000-4000-8000-0000000000c1'),
  ('a3711111-0000-4000-8000-0000000000d2', 'a3711111-0000-4000-8000-0000000000c1');

-- ── Збір: Оля організовує, Тарас (з акаунтом і поштою) і Ніна скидаються ──

select tests.as_anon();
select public.start_pool('recvToken00000000000001', 'a3711111-0000-4000-8000-0000000000c1',
                         'recvKeyOrganizerAAAAAAAA', 'Оля', 'BLIK на +48 500 000 000', null, 'olia37@pochta.ua', 'uk');
select tests.as_user('a3711111-0000-4000-8000-0000000000aa');
select public.pledge_pool('recvToken00000000000001', tests.pool_id(), 'recvKeyTarasBBBBBBBBBBBB', 'Тарас', 120, 'pl', 'taras37@test.local');
select tests.as_anon();
select public.pledge_pool('recvToken00000000000001', tests.pool_id(), 'recvKeyNinaCCCCCCCCCCCCC', 'Ніна', 80.5);

select is((tests.pool(null)->>'received')::numeric, 0::numeric, 'усталено: отримано 0 — як до 8.14');
select is(tests.pool('recvKeyTarasBBBBBBBBBBBB')->>'mine_received', 'false', 'і внесок учасника — лише обіцянка');
select is((select count(*)::int from jsonb_array_elements(tests.pool('recvKeyOrganizerAAAAAAAA')->'pledges') e
            where e ? 'id' and e->>'received' = 'false'), 2,
          'організатор бачить у кожного внеску ідентифікатор і «не отримано»');
select ok(tests.pool('recvKeyTarasBBBBBBBBBBBB')->'pledges' = 'null'::jsonb, 'учасник ідентифікаторів чужих внесків не бачить');

-- Знімок власника до позначки.
select tests.as_user('a3711111-0000-4000-8000-00000000000f');
insert into snap values ('owner_before', tests.owner_view());

-- ── Хто не організатор — одна відповідь ─────

select tests.as_anon();
insert into snap values ('taras', tests.pledge('Тарас')::text), ('nina', tests.pledge('Ніна')::text);

select throws_ok(
  $$ select public.set_pledge_received('recvToken00000000000001', tests.pool_id(), 'recvKeyTarasBBBBBBBBBBBB',
                                       (select v::uuid from snap where k = 'nina'), true) $$,
  '42501', 'not_organizer', 'учасник чужий внесок не позначає');
select throws_ok(
  $$ select public.set_pledge_received('recvToken00000000000001', tests.pool_id(), 'recvKeyTarasBBBBBBBBBBBB',
                                       (select v::uuid from snap where k = 'taras'), true) $$,
  '42501', 'not_organizer', '…і свій теж');
select throws_ok(
  $$ select public.set_pledge_received('recvToken00000000000001', tests.pool_id(), 'recvKeyStrangerDDDDDDDD',
                                       (select v::uuid from snap where k = 'nina'), true) $$,
  '42501', 'not_organizer', 'гість поза збором — not_organizer');
select throws_ok(
  $$ select public.set_pledge_received('recvToken00000000000001', tests.pool_id(), null,
                                       (select v::uuid from snap where k = 'nina'), true) $$,
  '42501', 'not_organizer', 'анонім без ключа — not_organizer');
select throws_ok(
  $$ select public.set_pledge_received('recvToken00000000000001', tests.pool_id(), 'короткий',
                                       (select v::uuid from snap where k = 'nina'), true) $$,
  '42501', 'not_organizer', 'ключ не тієї форми — теж not_organizer, а не bad_key');
select throws_ok(
  $$ select public.set_pledge_received('recvToken00000000000001', gen_random_uuid(), 'recvKeyTarasBBBBBBBBBBBB',
                                       (select v::uuid from snap where k = 'nina'), true) $$,
  '42501', 'not_organizer', 'неіснуючий збір — та сама відповідь');

select tests.as_user('a3711111-0000-4000-8000-00000000000f');
select throws_ok(
  $$ select public.set_pledge_received('recvToken00000000000001', tests.pool_id(), 'recvKeyOrganizerAAAAAAAA',
                                       (select v::uuid from snap where k = 'nina'), true) $$,
  '42501', 'not_organizer', 'власник не позначає навіть із ключем організатора');
select throws_ok(
  $$ select public.set_pledge_received('recvToken00000000000001', gen_random_uuid(), 'recvKeyOwnerEEEEEEEEEEEE',
                                       gen_random_uuid(), true) $$,
  '42501', 'not_organizer', 'власнику — та сама відповідь, є збір чи ні (ADR-038)');
select throws_ok($$ update public.gift_pool_pledges set received_at = now() $$, '42501', null,
                 'власник не пише в таблицю обіцянок напряму');

-- ── Мертве посилання — not_found ────────────

select tests.as_anon();
select throws_ok(
  $$ select public.set_pledge_received('recvTokenRevoked0000001', tests.pool_id(), 'recvKeyOrganizerAAAAAAAA',
                                       (select v::uuid from snap where k = 'nina'), true) $$,
  'P0002', 'not_found', 'відкликане посилання — not_found навіть організатору');
select throws_ok(
  $$ select public.set_pledge_received('recvTokenNoSuch00000001', tests.pool_id(), 'recvKeyOrganizerAAAAAAAA',
                                       (select v::uuid from snap where k = 'nina'), true) $$,
  'P0002', 'not_found', 'неіснуюче — так само');
select tests.as_user('a3711111-0000-4000-8000-00000000000f');
select throws_ok(
  $$ select public.set_pledge_received('recvTokenRevoked0000001', gen_random_uuid(), null, gen_random_uuid(), true) $$,
  'P0002', 'not_found', 'і власнику — так само');

select tests.as_postgres();
select is((select count(*)::int from public.gift_pool_pledges where received_at is not null), 0,
          'жодна відмова нічого не позначила');

-- ── Організатор позначає ────────────────────

select tests.as_anon();
select lives_ok(
  $$ select public.set_pledge_received('recvToken00000000000001', tests.pool_id(), 'recvKeyOrganizerAAAAAAAA',
                                       (select v::uuid from snap where k = 'taras'), true) $$,
  'організатор позначає внесок Тараса отриманим');
select lives_ok(
  $$ select public.set_pledge_received('recvToken00000000000001', tests.pool_id(), 'recvKeyOrganizerAAAAAAAA',
                                       (select v::uuid from snap where k = 'taras'), true) $$,
  'повторна позначка нічого не ламає');
select throws_ok(
  $$ select public.set_pledge_received('recvToken00000000000001', tests.pool_id(), 'recvKeyOrganizerAAAAAAAA',
                                       gen_random_uuid(), true) $$,
  'P0002', 'pledge_gone', 'організатору про неіснуючий внесок — pledge_gone');

select is((tests.pool(null)->>'received')::numeric, 120::numeric, 'гість без ключа бачить «отримано 120»…');
select is((tests.pool(null)->>'raised')::numeric, 200.5::numeric, '…з 200,50 обіцяних');
select ok(tests.pool(null)::text !~ 'Тарас|Ніна|received_at', 'імен і часу позначки гостям немає');
select is(tests.pool('recvKeyTarasBBBBBBBBBBBB')->>'mine_received', 'true', 'Тарас бачить, що його внесок отримано');
select is(tests.pool('recvKeyNinaCCCCCCCCCCCCC')->>'mine_received', 'false', 'Ніна — що її ще ні');
select is((tests.pool('recvKeyNinaCCCCCCCCCCCCC')->>'received')::numeric, 120::numeric, 'і загальне «отримано»');
select is((select string_agg(e->>'name' || '=' || (e->>'received'), ',' order by e->>'name')
             from jsonb_array_elements(tests.pool('recvKeyOrganizerAAAAAAAA')->'pledges') e),
          'Ніна=false,Тарас=true', 'організатор бачить, чий внесок отримано');

select tests.as_user('a3711111-0000-4000-8000-0000000000aa');
select is(public.get_my_gifts()->0->'items'->0->'pool'->>'mine_received', 'true', '«Я дарую» Тараса: внесок отримано');
select is((public.get_my_gifts()->0->'items'->0->'pool'->>'received')::numeric, 120::numeric, '…і скільки отримано всього');

-- ── Власник — нічого ────────────────────────

select tests.as_user('a3711111-0000-4000-8000-00000000000f');
select is(tests.owner_view(), (select v from snap where k = 'owner_before'),
          'відповіді власника до й після позначки однакові (§3.2, ADR-038)');
select ok(tests.owner_view() !~ 'received|raised|pool|Оля|Тарас', 'і про збір у них ні слова');

-- ── Лист учаснику ───────────────────────────

select tests.as_postgres();
select is((select count(*)::int from tests.mails('pool_received')), 1, 'Тарасу з поштою — один лист');
select is((select email || '|' || (details->>'amount') || '|' || (details->>'title') || '|' || (details->>'organizer')
             from tests.mails('pool_received')),
          'taras37@test.local|120.00|Кавоварка|Оля', 'кому, скільки, на що й від кого');

-- Зняв і поставив знову — другого листа немає.
select tests.as_anon();
select public.set_pledge_received('recvToken00000000000001', tests.pool_id(), 'recvKeyOrganizerAAAAAAAA',
                                  (select v::uuid from snap where k = 'taras'), false);
select is((tests.pool(null)->>'received')::numeric, 0::numeric, 'організатор знімає позначку');
select public.set_pledge_received('recvToken00000000000001', tests.pool_id(), 'recvKeyOrganizerAAAAAAAA',
                                  (select v::uuid from snap where k = 'taras'), true);
select public.set_pledge_received('recvToken00000000000001', tests.pool_id(), 'recvKeyOrganizerAAAAAAAA',
                                  (select v::uuid from snap where k = 'nina'), true);
select public.set_pledge_received('recvToken00000000000001', tests.pool_id(), 'recvKeyOrganizerAAAAAAAA',
                                  (select v::uuid from snap where k = 'nina'), null);
select tests.as_postgres();
select is((select count(*)::int from tests.mails('pool_received')), 1,
          'повторна позначка листа не дає; Ніні без пошти — теж ні');
select is((select count(*)::int from public.gift_pool_pledges where received_at is not null), 2,
          'p_received = NULL нічого не змінює');

-- ── Зміна суми знімає позначку ──────────────

select tests.as_user('a3711111-0000-4000-8000-0000000000aa');
select public.pledge_pool('recvToken00000000000001', tests.pool_id(), 'recvKeyTarasBBBBBBBBBBBB', 'Тарас П.', 120);
select is(tests.pool('recvKeyTarasBBBBBBBBBBBB')->>'mine_received', 'true', 'та сама сума — позначка лишається');
select public.pledge_pool('recvToken00000000000001', tests.pool_id(), 'recvKeyTarasBBBBBBBBBBBB', 'Тарас П.', 150);
select is(tests.pool('recvKeyTarasBBBBBBBBBBBB')->>'mine_received', 'false', 'нова сума — знову лише обіцянка');
select is((tests.pool(null)->>'received')::numeric, 80.5::numeric, 'у підсумку лишився внесок Ніни');

-- Закритий збір і архівний список позначати не заважають: гроші доходять після свята.
select tests.as_anon();
select public.close_pool('recvToken00000000000001', tests.pool_id(), 'recvKeyOrganizerAAAAAAAA', true);
select tests.as_postgres();
update public.lists set is_archived = true where id = 'a3711111-0000-4000-8000-00000000000a';
select tests.as_anon();
select lives_ok(
  $$ select public.set_pledge_received('recvToken00000000000001', tests.pool_id(), 'recvKeyOrganizerAAAAAAAA',
                                       tests.pledge('Тарас П.'), true) $$,
  'на закритому зборі архівного списку — позначає');

select * from finish();
rollback;
