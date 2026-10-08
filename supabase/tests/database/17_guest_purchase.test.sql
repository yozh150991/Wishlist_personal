-- Гостьова v2, крок 5в (ADR-056): «Уже куплено» на броні гостя.
-- §3.2 — бачить лише той гість; власник і інші гості — ні, і статус
--        позиції власника від цього не змінюється.
-- Лист про видалення купленої позиції каже про покупку; нагадування — лише
-- коли лишилось щось некуплене, і куплене в ньому окремо.

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

create function tests.item(p_key text, p_item uuid) returns jsonb language sql as $$
  select e from jsonb_array_elements(public.get_guest_list('guestBuyToken0000000001', p_key)->'items') e
   where (e->>'id')::uuid = p_item
$$;

grant execute on all functions in schema tests to anon, authenticated;

insert into auth.users (id, email) values
  ('a1711111-0000-4000-8000-000000000001', 'owner17@test.local');

insert into public.lists (id, owner_id, title, currency, event_date) values
  ('a1711111-0000-4000-8000-00000000000a', 'a1711111-0000-4000-8000-000000000001', 'Ювілей', 'PLN',
   (now() at time zone 'Europe/Warsaw')::date + 7);

insert into public.items (id, list_id, owner_id, title, price, quantity, status) values
  ('a1711111-0000-4000-8000-0000000000c1', 'a1711111-0000-4000-8000-00000000000a', 'a1711111-0000-4000-8000-000000000001', 'Лампа', 900, 1, 'active'),
  ('a1711111-0000-4000-8000-0000000000c2', 'a1711111-0000-4000-8000-00000000000a', 'a1711111-0000-4000-8000-000000000001', 'Чашки', 200, 1, 'active'),
  ('a1711111-0000-4000-8000-0000000000c3', 'a1711111-0000-4000-8000-00000000000a', 'a1711111-0000-4000-8000-000000000001', 'Плед',  300, 1, 'active');

insert into public.shares (id, owner_id, source_list_id, token, title, revoked_at) values
  ('a1711111-0000-4000-8000-0000000000d1', 'a1711111-0000-4000-8000-000000000001', 'a1711111-0000-4000-8000-00000000000a', 'guestBuyToken0000000001', 'Ювілей', null),
  ('a1711111-0000-4000-8000-0000000000d2', 'a1711111-0000-4000-8000-000000000001', 'a1711111-0000-4000-8000-00000000000a', 'guestBuyRevoked00000001', 'Старе', now());

insert into public.share_items (share_id, item_id)
select 'a1711111-0000-4000-8000-0000000000d1'::uuid, id from public.items
 where list_id = 'a1711111-0000-4000-8000-00000000000a';

select tests.as_anon();
select claim_item_v2('guestBuyToken0000000001', 'a1711111-0000-4000-8000-0000000000c1',
                     'guestBuyKeyAAAAAAAAAAAAA', 1, null, 'buyer17@pochta.ua', 'uk');
select claim_item_v2('guestBuyToken0000000001', 'a1711111-0000-4000-8000-0000000000c2',
                     'guestBuyKeyAAAAAAAAAAAAA', 1, null, null, 'uk');
select claim_item_v2('guestBuyToken0000000001', 'a1711111-0000-4000-8000-0000000000c3',
                     'guestBuyKeyBBBBBBBBBBBBB', 1, null, null, 'uk');

-- ── «Уже куплено» ────────────────────────────

select ok(not (tests.item('guestBuyKeyAAAAAAAAAAAAA', 'a1711111-0000-4000-8000-0000000000c1') ? 'bought'),
          'до позначки «Куплено» немає');
select set_claim_bought('guestBuyToken0000000001', 'a1711111-0000-4000-8000-0000000000c1', 'guestBuyKeyAAAAAAAAAAAAA', true);
select is(tests.item('guestBuyKeyAAAAAAAAAAAAA', 'a1711111-0000-4000-8000-0000000000c1')->>'bought', 'true',
          'гість бачить свою позицію купленою');
select is(tests.item('guestBuyKeyAAAAAAAAAAAAA', 'a1711111-0000-4000-8000-0000000000c1')->>'mine_qty', '1',
          'бронь лишається броню');
select ok(not (tests.item('guestBuyKeyBBBBBBBBBBBBB', 'a1711111-0000-4000-8000-0000000000c1') ? 'bought'),
          'інший гість «Куплено» не бачить');
select set_claim_bought('guestBuyToken0000000001', 'a1711111-0000-4000-8000-0000000000c3', 'guestBuyKeyAAAAAAAAAAAAA', true);
select ok(not (tests.item('guestBuyKeyBBBBBBBBBBBBB', 'a1711111-0000-4000-8000-0000000000c3') ? 'bought'),
          'чужу бронь купленою не позначити');
select throws_ok(
  $$ select set_claim_bought('guestBuyRevoked00000001', 'a1711111-0000-4000-8000-0000000000c1', 'guestBuyKeyAAAAAAAAAAAAA', true) $$,
  'P0002', 'not_found', 'мертве посилання — not_found'
);

reset role;
select is((select status::text from items where id = 'a1711111-0000-4000-8000-0000000000c1'), 'active',
          '«Куплено» гостя не міняє статус позиції власника');

select tests.as_user('a1711111-0000-4000-8000-000000000001');
select ok(get_guest_list('guestBuyToken0000000001', 'guestBuyKeyAAAAAAAAAAAAA')::text !~ '"bought"',
          'власник навіть із ключем гостя «Куплено» не отримує');
select throws_ok($$ select purchased_at from claims $$, '42501', null, 'власник не читає позначок');
select throws_ok(
  $$ select set_claim_bought('guestBuyToken0000000001', 'a1711111-0000-4000-8000-0000000000c1', 'guestBuyKeyAAAAAAAAAAAAA', false) $$,
  '22023', 'owner_cannot_reserve', 'власник не знімає «Куплено» за гостя'
);

-- ── Нагадування ─────────────────────────────

reset role;
delete from guest_mail;
select is(enqueue_guest_reminders(), 1, 'лишилось некуплене — нагадування є');
select is((select details->'items' from guest_mail where kind = 'reminder'), '["Чашки"]'::jsonb,
          'у нагадуванні — що ще купити');
select is((select details->'bought' from guest_mail where kind = 'reminder'), '["Лампа"]'::jsonb,
          'і окремо — що вже куплено');

delete from guest_mail;
select tests.as_anon();
select set_claim_bought('guestBuyToken0000000001', 'a1711111-0000-4000-8000-0000000000c2', 'guestBuyKeyAAAAAAAAAAAAA', true);
reset role;
select is(enqueue_guest_reminders(), 0, 'усе куплено — нагадувати нема про що');

-- ── Видалення купленого ─────────────────────

select tests.as_user('a1711111-0000-4000-8000-000000000001');
select lives_ok($$ delete from items where id = 'a1711111-0000-4000-8000-0000000000c1' $$,
                'власник видаляє позицію, яку вже купили, — як завжди');
reset role;
select ok((select details ? 'bought' from guest_mail where kind = 'deleted'),
          'лист про видалення знає, що гість її вже купив');

-- ── «Ще не куплено» ─────────────────────────

select tests.as_anon();
select set_claim_bought('guestBuyToken0000000001', 'a1711111-0000-4000-8000-0000000000c2', 'guestBuyKeyAAAAAAAAAAAAA', false);
select ok(not (tests.item('guestBuyKeyAAAAAAAAAAAAA', 'a1711111-0000-4000-8000-0000000000c2') ? 'bought'),
          '«Ще не куплено» повертає звичайну бронь');

select * from finish();
rollback;
