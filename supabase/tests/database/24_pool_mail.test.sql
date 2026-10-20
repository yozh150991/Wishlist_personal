-- Дизайн v2, крок 7б (ADR-064): листи про спільний збір і внески в «Я дарую».

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

-- Листи певного виду: кому (пошта) і знімок.
create function tests.mail(p_kind text) returns table (email text, locale text, details jsonb, share_id uuid, item_id uuid)
language sql security definer as $$
  select g.email, m.locale, m.details, m.share_id, m.item_id
    from public.guest_mail m join public.guest_identities g on g.id = m.identity_id
   where m.kind = p_kind
   order by m.created_at, g.email
$$;

create function tests.pool_of(p_item uuid) returns uuid language sql security definer as $$
  select id from public.gift_pools where item_id = p_item
$$;

grant execute on all functions in schema tests to anon, authenticated;

insert into auth.users (id, email, email_confirmed_at) values
  ('a2411111-0000-4000-8000-00000000000f', 'owner24@test.local', now()),
  ('a2411111-0000-4000-8000-0000000000aa', 'taras24@test.local', now());

insert into public.lists (id, owner_id, title, currency) values
  ('a2411111-0000-4000-8000-00000000000a', 'a2411111-0000-4000-8000-00000000000f', 'Новосілля', 'PLN');

insert into public.items (id, list_id, owner_id, title, price, quantity, status) values
  ('a2411111-0000-4000-8000-0000000000c1', 'a2411111-0000-4000-8000-00000000000a', 'a2411111-0000-4000-8000-00000000000f', 'Кавоварка', 400, 1, 'active'),
  ('a2411111-0000-4000-8000-0000000000c2', 'a2411111-0000-4000-8000-00000000000a', 'a2411111-0000-4000-8000-00000000000f', 'Плед',      300, 1, 'active');

insert into public.shares (id, owner_id, source_list_id, token, title) values
  ('a2411111-0000-4000-8000-0000000000d1', 'a2411111-0000-4000-8000-00000000000f', 'a2411111-0000-4000-8000-00000000000a', 'poolMailToken0000000001', 'Новосілля');

insert into public.share_items (share_id, item_id)
select 'a2411111-0000-4000-8000-0000000000d1'::uuid, id from public.items
 where list_id = 'a2411111-0000-4000-8000-00000000000a';

-- ── Відкрили й долучаються ───────────────────

select tests.as_anon();
select public.start_pool('poolMailToken0000000001', 'a2411111-0000-4000-8000-0000000000c1',
                         'poolMailKeyOrganizerAAAA', 'Оля', 'BLIK на +48 500 000 000', null, 'olia24@pochta.ua', 'pl');

-- Тарас — увійшов, з поштою; Ніна — без пошти.
select tests.as_user('a2411111-0000-4000-8000-0000000000aa');
select public.pledge_pool('poolMailToken0000000001', tests.pool_of('a2411111-0000-4000-8000-0000000000c1'),
                          'poolMailKeyTarasBBBBBBBB', 'Тарас', 100, 'uk', 'taras24@test.local');
select tests.as_anon();
select public.pledge_pool('poolMailToken0000000001', tests.pool_of('a2411111-0000-4000-8000-0000000000c1'),
                          'poolMailKeyNinaCCCCCCCCC', 'Ніна', 50);

select tests.as_postgres();
select is((select count(*)::int from tests.mail('pool_join')), 2, 'організатору — лист про кожного нового учасника');
select is((select email || '|' || locale || '|' || (details->>'name') || '|' || (details->>'amount') || '|' || (details->>'title')
             from tests.mail('pool_join') where details->>'name' = 'Тарас'),
          'olia24@pochta.ua|pl|Тарас|100.00|Кавоварка', 'кому, мовою організатора, ім''я, сума й позиція');
select ok((select share_id = 'a2411111-0000-4000-8000-0000000000d1' and item_id is null from tests.mail('pool_join') limit 1),
          'лист веде на посилання збору');

select tests.as_user('a2411111-0000-4000-8000-0000000000aa');
select public.pledge_pool('poolMailToken0000000001', tests.pool_of('a2411111-0000-4000-8000-0000000000c1'),
                          'poolMailKeyTarasBBBBBBBB', 'Тарас', 120, 'uk', null);
select tests.as_anon();
select public.pledge_pool('poolMailToken0000000001', tests.pool_of('a2411111-0000-4000-8000-0000000000c1'),
                          'poolMailKeyOrganizerAAAA', 'Оля', 80);
select tests.as_postgres();
select is((select count(*)::int from tests.mail('pool_join')), 2,
          'зміна суми й власна обіцянка організатора листа не дають');

-- ── «Я дарую» учасника ───────────────────────

select tests.as_user('a2411111-0000-4000-8000-0000000000aa');
select is(jsonb_array_length(public.get_my_gifts()), 1, 'список, де скидаєшся, — у «Я дарую»');
select is((public.get_my_gifts()->0->'items'->0->'pool'->>'mine')::numeric, 120::numeric, 'з моєю сумою');
select is(public.get_my_gifts()->0->'items'->0->'pool'->>'organizer', 'Оля', 'і хто збирає');
select is(public.get_my_gifts()->0->'items'->0->'pool'->>'is_organizer', 'false', 'я не організатор');
select ok(public.get_my_gifts()::text !~ 'Ніна', 'чужих учасників там немає');

-- ── Закрили ──────────────────────────────────

select tests.as_anon();
select public.close_pool('poolMailToken0000000001', tests.pool_of('a2411111-0000-4000-8000-0000000000c1'),
                         'poolMailKeyOrganizerAAAA', true);
select public.close_pool('poolMailToken0000000001', tests.pool_of('a2411111-0000-4000-8000-0000000000c1'),
                         'poolMailKeyOrganizerAAAA', true);
select tests.as_postgres();
select is((select count(*)::int from tests.mail('pool_closed')), 1,
          'закриття — лист учасникам з поштою, раз; не організатору й не тим, хто без пошти');
select is((select (details->>'amount') || '|' || (details->>'instructions') || '|' || (details->>'organizer') from tests.mail('pool_closed')),
          '120.00|BLIK на +48 500 000 000|Оля', 'скільки обіцяв, як скинутися і хто збирає');

-- ── Скасували ────────────────────────────────

select tests.as_anon();
select public.cancel_pool('poolMailToken0000000001', tests.pool_of('a2411111-0000-4000-8000-0000000000c1'),
                          'poolMailKeyOrganizerAAAA');
select tests.as_postgres();
select is((select count(*)::int from tests.mail('pool_cancel')), 1, 'скасування — лист учаснику з поштою');
select is((select (details->>'reason') || '|' || (details->>'title') from tests.mail('pool_cancel')),
          'cancelled|Кавоварка', 'причина — скасовано');

-- ── Позицію прибрали ─────────────────────────

select tests.as_anon();
select public.start_pool('poolMailToken0000000001', 'a2411111-0000-4000-8000-0000000000c2',
                         'poolMailKeyOrganizerAAAA', 'Оля', 'Картка', null, null, 'uk');
select tests.as_user('a2411111-0000-4000-8000-0000000000aa');
select public.pledge_pool('poolMailToken0000000001', tests.pool_of('a2411111-0000-4000-8000-0000000000c2'),
                          'poolMailKeyTarasBBBBBBBB', 'Тарас', 70);

select tests.as_user('a2411111-0000-4000-8000-00000000000f');
select lives_ok($$ delete from public.items where id = 'a2411111-0000-4000-8000-0000000000c2' $$,
                'власник видаляє позицію зі збором — запит як завжди');

select tests.as_postgres();
select is((select (details->>'reason') || '|' || (details->>'title') from tests.mail('pool_cancel')
            where details->>'reason' = 'deleted'),
          'deleted|Плед', 'лист: позицію прибрано — назва знімком');
select is((select count(*)::int from public.gift_pools), 0, 'зборів не лишилось');

select has_trigger('public', 'gift_pools', 'gift_pool_cancel_mail', 'лист про скасування — тригером');

select * from finish();
rollback;
