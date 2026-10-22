-- QA-регресія за техніками тест-дизайну (ADR-069): переходи станів.
--
-- П'ять автоматів продукту, кожен — і дозволені переходи, і заборонені:
--   A. Посилання: живе → відкликане / протерміноване. З будь-якого мертвого
--      стану кожна гостьова дія дає ту саму відповідь `not_found` (§3.3).
--   B. Бронь гостя на позицію: немає → взято(q) → взято(q') → куплено →
--      знову взято → немає; «зняти» й «куплено» без броні — нічого.
--   C. Позиція власника: актуальна ↔ куплена/подарована; список ↔ архів.
--   D. Спільний збір: немає → відкритий ↔ закритий → скасований.
--   E. Код гостя: старий код спрацьовує раз і змінюється; чернетка → назва.
-- Виправлені баги (ADR-070) — з номером із docs/QA_REPORT.md в описі перевірки.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(57);

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

-- Позиція з гостьової відповіді за токеном і ключем.
create function tests.item(p_token text, p_key text, p_item uuid) returns jsonb language sql as $$
  select e from jsonb_array_elements(public.get_guest_list(p_token, p_key)->'items') e
   where (e->>'id')::uuid = p_item
$$;

-- SQLSTATE і текст помилки виклику, або 'ok' / 'null'. Для таблиці переходів.
create function tests.outcome(p_sql text) returns text language plpgsql as $$
declare v jsonb;
begin
  execute p_sql into v;
  return case when v is null then 'null' else 'ok' end;
exception when others then
  return sqlstate || ':' || sqlerrm;
end $$;

grant execute on all functions in schema tests to anon, authenticated;

-- ── Дані ─────────────────────────────────────

insert into auth.users (id, email, email_confirmed_at) values
  ('c0260000-0000-4000-8000-0000000000f1', 'qa26-owner@test.local', now());

insert into public.lists (id, owner_id, title) values
  ('c0260000-0000-4000-8000-0000000000a1', 'c0260000-0000-4000-8000-0000000000f1', 'QA стани');

insert into public.items (id, list_id, owner_id, title, price, quantity) values
  ('c0260000-0000-4000-8000-0000000000b1', 'c0260000-0000-4000-8000-0000000000a1', 'c0260000-0000-4000-8000-0000000000f1', 'Чашки', 20, 4),
  ('c0260000-0000-4000-8000-0000000000b2', 'c0260000-0000-4000-8000-0000000000a1', 'c0260000-0000-4000-8000-0000000000f1', 'Кавоварка', 400, 1),
  ('c0260000-0000-4000-8000-0000000000b3', 'c0260000-0000-4000-8000-0000000000a1', 'c0260000-0000-4000-8000-0000000000f1', 'Плед', 120, 1);

insert into public.items (id, list_id, owner_id, title, url, needs_title) values
  ('c0260000-0000-4000-8000-0000000000b4', 'c0260000-0000-4000-8000-0000000000a1', 'c0260000-0000-4000-8000-0000000000f1',
   'shop.pl/lampa', 'https://shop.pl/lampa', true);

-- Живе, відкликане, протерміноване посилання на той самий список.
insert into public.shares (id, owner_id, source_list_id, token, title) values
  ('c0260000-0000-4000-8000-0000000000d1', 'c0260000-0000-4000-8000-0000000000f1', 'c0260000-0000-4000-8000-0000000000a1', 'qa26Live000000000000001', 'Живе'),
  ('c0260000-0000-4000-8000-0000000000d2', 'c0260000-0000-4000-8000-0000000000f1', 'c0260000-0000-4000-8000-0000000000a1', 'qa26Revoked0000000000001', 'Відкличу'),
  ('c0260000-0000-4000-8000-0000000000d3', 'c0260000-0000-4000-8000-0000000000f1', 'c0260000-0000-4000-8000-0000000000a1', 'qa26Expired0000000000001', 'Мине');

insert into public.share_items (share_id, item_id)
select s.id, i.id
  from public.shares s cross join public.items i
 where s.source_list_id = 'c0260000-0000-4000-8000-0000000000a1'
   and i.list_id = 'c0260000-0000-4000-8000-0000000000a1';

-- ═════════════════════════════════════════════
-- A. Посилання: живе → мертве
-- ═════════════════════════════════════════════

select tests.as_anon();
-- Бронь на відкликаному й протермінованому посиланні — до переходу.
select lives_ok($$ select public.claim_item_v2('qa26Revoked0000000000001', 'c0260000-0000-4000-8000-0000000000b3', 'qa26KeyDead0000000000000', 1) $$,
                'A: у живому стані посилання бронювати можна');

select tests.as_postgres();
update public.shares set revoked_at = now() where id = 'c0260000-0000-4000-8000-0000000000d2';
update public.shares set expires_at = now() - interval '1 second' where id = 'c0260000-0000-4000-8000-0000000000d3';
-- Звільнити позицію: бронь лишилась від мертвого посилання, а далі вона потрібна живому.
delete from public.claims where item_id = 'c0260000-0000-4000-8000-0000000000b3';

select tests.as_anon();

-- Таблиця переходів: кожна гостьова подія в кожному мертвому стані.
create temp table dead_events (event text, sql text);
insert into dead_events values
  ('get_guest_list',   $$ select public.get_guest_list('%s', 'qa26KeyDead0000000000000') $$),
  ('claim_item_v2',    $$ select public.claim_item_v2('%s', 'c0260000-0000-4000-8000-0000000000b1', 'qa26KeyDead0000000000000', 1) $$),
  ('release_claim',    $$ select public.release_claim('%s', 'c0260000-0000-4000-8000-0000000000b3', 'qa26KeyDead0000000000000') $$),
  ('set_claim_bought', $$ select to_jsonb(public.set_claim_bought('%s', 'c0260000-0000-4000-8000-0000000000b3', 'qa26KeyDead0000000000000', true)) $$),
  ('ack_claim_change', $$ select to_jsonb(public.ack_claim_change('%s', 'c0260000-0000-4000-8000-0000000000b3', 'qa26KeyDead0000000000000')) $$),
  ('start_pool',       $$ select public.start_pool('%s', 'c0260000-0000-4000-8000-0000000000b2', 'qa26KeyDead0000000000000', 'Оля', 'BLIK', 100) $$),
  ('redeem_guest_code',$$ select public.redeem_guest_code('%s', 'ABCDE') $$),
  ('send_guest_code',  $$ select public.send_guest_code('%s', 'a@b.cd') $$),
  ('report_share',     $$ select to_jsonb(public.report_share('%s', 'spam')) $$);
grant select on dead_events to anon, authenticated;

select is(
  (select array_agg(distinct tests.outcome(format(e.sql, 'qa26Revoked0000000000001'))) from dead_events e),
  array['P0002:not_found'],
  'A: відкликане — кожна з 9 гостьових дій дає той самий not_found');
select is(
  (select array_agg(distinct tests.outcome(format(e.sql, 'qa26Expired0000000000001'))) from dead_events e),
  array['P0002:not_found'],
  'A: протерміноване — кожна з 9 гостьових дій дає той самий not_found');
select is(
  (select array_agg(distinct tests.outcome(format(e.sql, 'qa26NeverExisted00000001'))) from dead_events e),
  array['P0002:not_found'],
  'A: неіснуюче — та сама відповідь, тож мертве не відрізнити від вигаданого');
select is(public.get_share_card('qa26Revoked0000000000001'), null, 'A: картка відкликаного посилання — null');
select is(public.get_share_card('qa26Expired0000000000001'), null, 'A: картка протермінованого посилання — null');
select isnt(public.get_share_card('qa26Live000000000000001'), null, 'A: картка живого посилання — є');

-- ═════════════════════════════════════════════
-- B. Бронь гостя: життєвий цикл
-- ═════════════════════════════════════════════

-- Стан NONE: «зняти» й «куплено» без броні — нічого й без помилки.
select is((public.release_claim('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b1', 'qa26KeyGuestA00000000000')->>'taken_qty')::int, 0,
          'B: NONE --зняти--> NONE, без помилки');
select lives_ok($$ select public.set_claim_bought('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b1', 'qa26KeyGuestA00000000000', true) $$,
                'B: NONE --куплено--> NONE, без помилки');
select is(tests.item('qa26Live000000000000001', 'qa26KeyGuestA00000000000', 'c0260000-0000-4000-8000-0000000000b1')->>'bought', null,
          'B: «куплено» без броні не створює позначки');

-- NONE → CLAIMED(1) → CLAIMED(3)
select is((public.claim_item_v2('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b1', 'qa26KeyGuestA00000000000', 1)->>'mine_qty')::int, 1,
          'B: NONE --взяти 1--> CLAIMED(1)');
select is((public.claim_item_v2('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b1', 'qa26KeyGuestA00000000000', 3)->>'mine_qty')::int, 3,
          'B: CLAIMED(1) --змінити на 3--> CLAIMED(3), не 4');
select is((tests.item('qa26Live000000000000001', null, 'c0260000-0000-4000-8000-0000000000b1')->>'taken_qty')::int, 3,
          'B: гість без ключа бачить 3 з 4 взятих');

-- CLAIMED → BOUGHT → CLAIMED
select public.set_claim_bought('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b1', 'qa26KeyGuestA00000000000', true);
select is(tests.item('qa26Live000000000000001', 'qa26KeyGuestA00000000000', 'c0260000-0000-4000-8000-0000000000b1')->>'bought', 'true',
          'B: CLAIMED --куплено--> BOUGHT');
select is((tests.item('qa26Live000000000000001', 'qa26KeyGuestA00000000000', 'c0260000-0000-4000-8000-0000000000b1')->>'mine_qty')::int, 3,
          'B: BOUGHT зберігає кількість');

select tests.as_postgres();
create temp table bought_at as select purchased_at from public.claims
 where item_id = 'c0260000-0000-4000-8000-0000000000b1';
select tests.as_anon();
select public.set_claim_bought('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b1', 'qa26KeyGuestA00000000000', true);
select tests.as_postgres();
select is((select purchased_at from public.claims where item_id = 'c0260000-0000-4000-8000-0000000000b1'),
          (select purchased_at from bought_at),
          'B: BOUGHT --куплено ще раз--> BOUGHT, час першої покупки не переписано');
select tests.as_anon();

select public.set_claim_bought('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b1', 'qa26KeyGuestA00000000000', false);
select is(tests.item('qa26Live000000000000001', 'qa26KeyGuestA00000000000', 'c0260000-0000-4000-8000-0000000000b1')->>'bought', null,
          'B: BOUGHT --не куплено--> CLAIMED');
select public.set_claim_bought('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b1', 'qa26KeyGuestA00000000000', null);
select is(tests.item('qa26Live000000000000001', 'qa26KeyGuestA00000000000', 'c0260000-0000-4000-8000-0000000000b1')->>'bought', null,
          'B: «куплено» з NULL — як «не куплено»');

-- Інший гість не може змінити чужий стан.
select public.release_claim('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b1', 'qa26KeyGuestB00000000000');
select is((tests.item('qa26Live000000000000001', 'qa26KeyGuestA00000000000', 'c0260000-0000-4000-8000-0000000000b1')->>'mine_qty')::int, 3,
          'B: «зняти» чужим ключем — бронь A лишається');

-- CLAIMED → NONE
select is((public.release_claim('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b1', 'qa26KeyGuestA00000000000')->>'taken_qty')::int, 0,
          'B: CLAIMED --зняти--> NONE, позиція вільна');
select is((tests.item('qa26Live000000000000001', 'qa26KeyGuestA00000000000', 'c0260000-0000-4000-8000-0000000000b1')->>'mine_qty')::int, 0,
          'B: після зняття mine_qty = 0');

-- BOUGHT → NONE напряму («зняти» купленої броні)
select public.claim_item_v2('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b1', 'qa26KeyGuestA00000000000', 1);
select public.set_claim_bought('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b1', 'qa26KeyGuestA00000000000', true);
select public.release_claim('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b1', 'qa26KeyGuestA00000000000');
select is(tests.item('qa26Live000000000000001', 'qa26KeyGuestA00000000000', 'c0260000-0000-4000-8000-0000000000b1')->>'bought', null,
          'B: BOUGHT --зняти--> NONE, позначка покупки теж зникає');

-- Власник: сліпе скидання з будь-якого стану → NONE.
select public.claim_item_v2('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b1', 'qa26KeyGuestA00000000000', 2);
select tests.as_user('c0260000-0000-4000-8000-0000000000f1');
select public.release_item_claims('c0260000-0000-4000-8000-0000000000b1');
select tests.as_anon();
select is((tests.item('qa26Live000000000000001', null, 'c0260000-0000-4000-8000-0000000000b1')->>'taken_qty')::int, 0,
          'B: CLAIMED --сліпе скидання власником--> NONE');

-- ═════════════════════════════════════════════
-- C. Позиція й список власника
-- ═════════════════════════════════════════════

select public.claim_item_v2('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b1', 'qa26KeyGuestA00000000000', 2);

select tests.as_user('c0260000-0000-4000-8000-0000000000f1');
update public.items set status = 'purchased' where id = 'c0260000-0000-4000-8000-0000000000b1';
select tests.as_anon();
select is(tests.item('qa26Live000000000000001', 'qa26KeyGuestA00000000000', 'c0260000-0000-4000-8000-0000000000b1'), null,
          'C: active --куплено власником--> гість позиції не бачить');
select throws_ok($$ select public.claim_item_v2('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b1', 'qa26KeyGuestB00000000000', 1) $$,
                 'P0002', 'item_not_in_share', 'C: куплену власником позицію не забронювати');

select tests.as_user('c0260000-0000-4000-8000-0000000000f1');
update public.items set status = 'gifted' where id = 'c0260000-0000-4000-8000-0000000000b1';
update public.items set status = 'active' where id = 'c0260000-0000-4000-8000-0000000000b1';
select tests.as_anon();
select is((tests.item('qa26Live000000000000001', 'qa26KeyGuestA00000000000', 'c0260000-0000-4000-8000-0000000000b1')->>'mine_qty')::int, 2,
          'C: purchased → gifted → active: позиція повертається з бронню гостя');

-- Список: active → archived → active
select tests.as_user('c0260000-0000-4000-8000-0000000000f1');
update public.lists set is_archived = true where id = 'c0260000-0000-4000-8000-0000000000a1';
select tests.as_anon();
select is((public.get_guest_list('qa26Live000000000000001', null)->>'allow_reservations')::boolean, false,
          'C: archived — бронювання вимкнене для гостя');
select throws_ok($$ select public.claim_item_v2('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b3', 'qa26KeyGuestB00000000000', 1) $$,
                 '22023', 'list_archived', 'C: archived --взяти--> list_archived');
select throws_ok($$ select public.claim_item_v2('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b1', 'qa26KeyGuestA00000000000', 3) $$,
                 '22023', 'list_archived', 'C: archived --збільшити свою бронь--> list_archived');
select lives_ok($$ select public.set_claim_bought('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b1', 'qa26KeyGuestA00000000000', true) $$,
                'C: archived --куплено--> дозволено');
select throws_ok($$ select public.start_pool('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b2', 'qa26KeyGuestB00000000000', 'Оля', 'BLIK', 100) $$,
                 '22023', 'list_archived', 'C: archived --відкрити збір--> list_archived');
select tests.as_user('c0260000-0000-4000-8000-0000000000f1');
update public.lists set is_archived = false where id = 'c0260000-0000-4000-8000-0000000000a1';
select tests.as_anon();
select lives_ok($$ select public.claim_item_v2('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b3', 'qa26KeyGuestB00000000000', 1) $$,
                'C: archived --повернути--> active, бронювати знову можна');

-- ═════════════════════════════════════════════
-- D. Спільний збір
-- ═════════════════════════════════════════════

create temp table pool as
select (public.start_pool('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b2',
                          'qa26KeyOrganizer00000000', 'Оля', 'BLIK', 400)->>'pool_id')::uuid as id;
grant select on pool to anon, authenticated;

select isnt((select id from pool), null, 'D: NONE --відкрити--> OPEN');
select lives_ok($$ select public.pledge_pool('qa26Live000000000000001', (select id from pool), 'qa26KeyMember00000000000', 'Ігор', 100) $$,
                'D: OPEN --внесок--> OPEN');
select throws_ok($$ select public.close_pool('qa26Live000000000000001', (select id from pool), 'qa26KeyMember00000000000', true) $$,
                 '42501', 'not_organizer', 'D: учасник не закриває збір');
select public.close_pool('qa26Live000000000000001', (select id from pool), 'qa26KeyOrganizer00000000', true);
select is(tests.item('qa26Live000000000000001', 'qa26KeyMember00000000000', 'c0260000-0000-4000-8000-0000000000b2')->'pool'->>'closed', 'true',
          'D: OPEN --закрити--> CLOSED');
select throws_ok($$ select public.pledge_pool('qa26Live000000000000001', (select id from pool), 'qa26KeyLate0000000000000', 'Ліза', 50) $$,
                 '22023', 'pool_closed', 'D: CLOSED --новий внесок--> pool_closed');
select throws_ok($$ select public.pledge_pool('qa26Live000000000000001', (select id from pool), 'qa26KeyMember00000000000', 'Ігор', 150) $$,
                 '22023', 'pool_closed', 'D: CLOSED --змінити свій внесок--> pool_closed');

select public.close_pool('qa26Live000000000000001', (select id from pool), 'qa26KeyOrganizer00000000', null);
select is(tests.item('qa26Live000000000000001', 'qa26KeyMember00000000000', 'c0260000-0000-4000-8000-0000000000b2')->'pool'->>'closed', 'true',
          'D: CLOSED --NULL--> лишається CLOSED (BUG-QA-08)');

select public.close_pool('qa26Live000000000000001', (select id from pool), 'qa26KeyOrganizer00000000', false);
select is(tests.item('qa26Live000000000000001', 'qa26KeyMember00000000000', 'c0260000-0000-4000-8000-0000000000b2')->'pool'->>'closed', 'false',
          'D: CLOSED --відкрити--> OPEN');
select lives_ok($$ select public.pledge_pool('qa26Live000000000000001', (select id from pool), 'qa26KeyLate0000000000000', 'Ліза', 50) $$,
                'D: знову OPEN — внесок проходить');
select lives_ok($$ select public.leave_pool('qa26Live000000000000001', (select id from pool), 'qa26KeyLate0000000000000') $$,
                'D: учасник виходить зі збору');
select is((tests.item('qa26Live000000000000001', null, 'c0260000-0000-4000-8000-0000000000b2')->'pool'->>'count')::int, 1,
          'D: після виходу — один учасник');
select lives_ok($$ select public.leave_pool('qa26Live000000000000001', (select id from pool), 'qa26KeyLate0000000000000') $$,
                'D: вихід удруге — нічого, без помилки');

select public.cancel_pool('qa26Live000000000000001', (select id from pool), 'qa26KeyOrganizer00000000');
select is(tests.item('qa26Live000000000000001', null, 'c0260000-0000-4000-8000-0000000000b2')->'pool', null,
          'D: OPEN --скасувати--> NONE, збору немає');
select is((tests.item('qa26Live000000000000001', null, 'c0260000-0000-4000-8000-0000000000b2')->>'taken_qty')::int, 0,
          'D: після скасування позиція вільна');
select throws_ok($$ select public.pledge_pool('qa26Live000000000000001', (select id from pool), 'qa26KeyMember00000000000', 'Ігор', 10) $$,
                 'P0002', 'pool_not_found', 'D: CANCELLED --внесок--> pool_not_found');

-- Організатор «знімає» свою бронь — збір зникає разом із нею.
create temp table pool2 as
select (public.start_pool('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b2',
                          'qa26KeyOrganizer00000000', 'Оля', 'BLIK', 400)->>'pool_id')::uuid as id;
grant select on pool2 to anon, authenticated;
select public.pledge_pool('qa26Live000000000000001', (select id from pool2), 'qa26KeyMember00000000000', 'Ігор', 100);
select public.release_claim('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b2', 'qa26KeyOrganizer00000000');
select is(tests.item('qa26Live000000000000001', null, 'c0260000-0000-4000-8000-0000000000b2')->'pool', null,
          'D: OPEN --організатор знімає бронь--> NONE');
select tests.as_postgres();
select is((select count(*)::int from public.gift_pool_pledges where pool_id = (select id from pool2)), 0,
          'D: з видаленим збором видалено й обіцянки');
select tests.as_anon();

-- ═════════════════════════════════════════════
-- E. Код гостя і чернетка
-- ═════════════════════════════════════════════

select public.claim_item_v2('qa26Live000000000000001', 'c0260000-0000-4000-8000-0000000000b1', 'qa26KeyCode000000000000', 1);
select tests.as_postgres();
create temp table code1 as
select g.short_code from public.guest_identities g
  join public.guest_keys k on k.identity_id = g.id
 where k.key_hash = public.guest_key_hash('c0260000-0000-4000-8000-0000000000a1', 'qa26KeyCode000000000000');
grant select on code1 to anon;
select tests.as_anon();

create temp table redeemed as
select public.redeem_guest_code('qa26Live000000000000001', lower((select short_code from code1))) as r;
grant select on redeemed to anon;
select is((select (r->>'claims')::int from redeemed), 1, 'E: код (малими літерами) переносить бронь на новий пристрій');
select isnt((select r->>'code' from redeemed), (select short_code from code1), 'E: після використання код змінився');
select is((public.redeem_guest_code('qa26Live000000000000001', (select short_code from code1)))->>'error', 'code_not_found',
          'E: старий код удруге — code_not_found');
select is((tests.item('qa26Live000000000000001', (select r->>'key' from redeemed), 'c0260000-0000-4000-8000-0000000000b1')->>'mine_qty')::int, 1,
          'E: новий ключ бачить бронь');
select is((tests.item('qa26Live000000000000001', 'qa26KeyCode000000000000', 'c0260000-0000-4000-8000-0000000000b1')->>'mine_qty')::int, 1,
          'E: старий ключ теж лишається робочим');

-- Чернетка: DRAFT --назва--> ITEM; ITEM --назад у чернетку--> заборонено.
select is(tests.item('qa26Live000000000000001', null, 'c0260000-0000-4000-8000-0000000000b4'), null,
          'E: DRAFT гостям не видно, навіть якщо рядок у share_items з''явився б');
select tests.as_user('c0260000-0000-4000-8000-0000000000f1');
update public.items set title = 'Лампа керамічна' where id = 'c0260000-0000-4000-8000-0000000000b4';
select is((select needs_title from public.items where id = 'c0260000-0000-4000-8000-0000000000b4'), false,
          'E: DRAFT --нова назва--> ITEM');
select throws_ok($$ update public.items set needs_title = true where id = 'c0260000-0000-4000-8000-0000000000b4' $$,
                 '22023', null, 'E: ITEM --назад у DRAFT--> заборонено');

select * from finish();
rollback;
