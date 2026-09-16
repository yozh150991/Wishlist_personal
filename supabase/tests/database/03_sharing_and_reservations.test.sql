-- Гостьовий доступ і броні.
-- §3.2 — власник не бачить броней, навіть у власному посиланні (ADR-008, ADR-009).
-- §3.3 — гість бачить лише те, що вибрано, і лише актуальне (ADR-007).

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(26);

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

-- Ідентифікатори позицій у відповіді get_shared_list.
create function tests.shared_ids(p_token text) returns setof uuid language sql as $$
  select (e->>'id')::uuid from jsonb_array_elements(public.get_shared_list(p_token)->'items') e
$$;

grant execute on all functions in schema tests to anon, authenticated;

-- Токен посилання, створеного власником через RPC.
create table tests.created (token text);
grant select on tests.created to anon, authenticated;
grant insert on tests.created to authenticated;

-- ── Дані ─────────────────────────────────────
-- A — власник. B — інший користувач. Позиції A:
--   c1 актуальна, 1 шт.     c2 актуальна, 2 шт.
--   c3 куплена сама         c4 подарована
--   c5 актуальна, але не в посиланні

insert into auth.users (id, email) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a@test.local'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'b@test.local');

insert into public.lists (id, owner_id, title, currency) values
  ('aaaaaaaa-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 'День народження', 'PLN'),
  ('bbbbbbbb-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-000000000001', 'Список B', 'PLN');

insert into public.items (id, list_id, owner_id, title, price, quantity, status) values
  ('cccccccc-0000-4000-8000-0000000000c1', 'aaaaaaaa-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 'Навушники', 399, 1, 'active'),
  ('cccccccc-0000-4000-8000-0000000000c2', 'aaaaaaaa-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 'Келихи',     50,  2, 'active'),
  ('cccccccc-0000-4000-8000-0000000000c3', 'aaaaaaaa-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 'Куплене',    10,  1, 'purchased'),
  ('cccccccc-0000-4000-8000-0000000000c4', 'aaaaaaaa-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 'Подароване', 10,  1, 'gifted'),
  ('cccccccc-0000-4000-8000-0000000000c5', 'aaaaaaaa-0000-4000-8000-00000000000a', 'aaaaaaaa-0000-4000-8000-000000000001', 'Не в шері',  10,  1, 'active'),
  ('bbbbbbbb-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-00000000000b', 'bbbbbbbb-0000-4000-8000-000000000001', 'Чуже',       10,  1, 'active');

-- Посилання зі спецвластивостями — напряму, щоб не залежати від create_share.
insert into public.shares (id, owner_id, source_list_id, token, title, hide_prices, allow_reservations, revoked_at, expires_at) values
  ('dddddddd-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a', 'hiddenPricesToken000000', 'Без цін',  true,  true,  null,  null),
  ('dddddddd-0000-4000-8000-000000000002', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a', 'revokedToken00000000000', 'Відкликане', false, true, now(), null),
  ('dddddddd-0000-4000-8000-000000000003', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a', 'expiredToken00000000000', 'Прострочене', false, true, null, now() - interval '1 day'),
  ('dddddddd-0000-4000-8000-000000000004', 'aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-00000000000a', 'noReservationsToken0000', 'Без броні', false, false, null, null);

insert into public.share_items (share_id, item_id)
select s, 'cccccccc-0000-4000-8000-0000000000c1'::uuid
  from unnest(array['dddddddd-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-000000000002',
                    'dddddddd-0000-4000-8000-000000000003', 'dddddddd-0000-4000-8000-000000000004']::uuid[]) s;

-- ── create_share ─────────────────────────────

select tests.as_user('aaaaaaaa-0000-4000-8000-000000000001');

insert into tests.created (token)
select token from create_share(
  'aaaaaaaa-0000-4000-8000-00000000000a',
  array['cccccccc-0000-4000-8000-0000000000c1', 'cccccccc-0000-4000-8000-0000000000c2',
        'cccccccc-0000-4000-8000-0000000000c3', 'cccccccc-0000-4000-8000-0000000000c4',
        'bbbbbbbb-0000-4000-8000-0000000000b1']::uuid[],
  'Мій день народження'
);

select throws_ok(
  $$ select create_share('aaaaaaaa-0000-4000-8000-00000000000a', array[]::uuid[], 'порожнє') $$,
  '22023', null, 'create_share без позицій — помилка 22023'
);

reset role;

select ok((select token from tests.created) ~ '^[A-Za-z0-9_-]{22}$', 'токен — 22 символи base64url');
select set_eq(
  $$ select item_id from share_items si join shares s on s.id = si.share_id
      where s.token = (select token from tests.created) $$,
  array['cccccccc-0000-4000-8000-0000000000c1', 'cccccccc-0000-4000-8000-0000000000c2',
        'cccccccc-0000-4000-8000-0000000000c3', 'cccccccc-0000-4000-8000-0000000000c4']::uuid[],
  'create_share мовчки відкинув позицію з чужого списку'
);

-- ── Гість бачить лише вибране й актуальне ────

select tests.as_anon();

select set_eq(
  $$ select tests.shared_ids((select token from tests.created)) $$,
  array['cccccccc-0000-4000-8000-0000000000c1', 'cccccccc-0000-4000-8000-0000000000c2']::uuid[],
  'гість бачить лише актуальні вибрані позиції: без купленого, подарованого й невибраного'
);
select is(get_shared_list((select token from tests.created))->>'viewer_is_owner', 'false',
          'гість — не власник');
select is(get_shared_list((select token from tests.created))->>'currency', 'PLN',
          'валюта береться зі списку');
select is_empty(
  $$ select 1 from jsonb_array_elements(get_shared_list('hiddenPricesToken000000')->'items') e
      where e->'price' <> 'null'::jsonb $$,
  'hide_prices: ціна не їде на клієнт узагалі'
);

select throws_ok($$ select get_shared_list('noSuchToken000000000000') $$, 'P0002', 'not_found', 'невідомий токен — not_found');
select throws_ok($$ select get_shared_list('revokedToken00000000000') $$, 'P0002', 'revoked',   'відкликане посилання — revoked');
select throws_ok($$ select get_shared_list('expiredToken00000000000') $$, 'P0002', 'expired',   'прострочене посилання — expired');

-- ── Бронювання ───────────────────────────────

select is(
  reserve_item((select token from tests.created), 'cccccccc-0000-4000-8000-0000000000c1', 'guest-one-0000000000', 1),
  1, 'гість 1 бронює позицію — загальна бронь 1'
);
select throws_ok(
  $$ select reserve_item((select token from tests.created), 'cccccccc-0000-4000-8000-0000000000c1', 'guest-two-0000000000', 1) $$,
  '22023', 'not_enough_left', 'гість 2 не бронює те, що вже розібрано'
);
select throws_ok(
  $$ select reserve_item((select token from tests.created), 'cccccccc-0000-4000-8000-0000000000c5', 'guest-two-0000000000', 1) $$,
  'P0002', 'item_not_in_share', 'не можна забронювати позицію, якої немає в посиланні'
);
select throws_ok(
  $$ select reserve_item('noReservationsToken0000', 'cccccccc-0000-4000-8000-0000000000c1', 'guest-two-0000000000', 1) $$,
  '22023', 'reservations_disabled', 'бронювання вимкнене власником'
);
select is(
  unreserve_item((select token from tests.created), 'cccccccc-0000-4000-8000-0000000000c1', 'guest-two-0000000000'),
  1, 'чужий guest_key не знімає бронь іншого гостя'
);
select is(
  (select (e->>'reserved_qty')::int from jsonb_array_elements(get_shared_list((select token from tests.created))->'items') e
    where e->>'id' = 'cccccccc-0000-4000-8000-0000000000c1'),
  1, 'гість бачить, що позицію заброньовано'
);

select register_share_view((select token from tests.created));

-- ── Власник не бачить броней (§3.2) ──────────

reset role;
select tests.as_user('aaaaaaaa-0000-4000-8000-000000000001');

select register_share_view((select token from tests.created));

select is(get_shared_list((select token from tests.created))->>'viewer_is_owner', 'true',
          'власник упізнаний у власному посиланні');
select is(get_shared_list((select token from tests.created))->>'allow_reservations', 'false',
          'власнику бронювання вимкнене');
select is_empty(
  $$ select 1 from jsonb_array_elements(get_shared_list((select token from tests.created))->'items') e
      where e->'reserved_qty' <> 'null'::jsonb $$,
  'власник отримує reserved_qty = null на кожній позиції (ADR-009)'
);
select throws_ok($$ select * from reservations $$, '42501', null, 'власник не читає reservations напряму');
select throws_ok(
  $$ select count(*) from items i join reservations r on r.item_id = i.id $$,
  '42501', null, 'власник не дістає броні через JOIN'
);
select throws_ok(
  $$ select reserve_item((select token from tests.created), 'cccccccc-0000-4000-8000-0000000000c2', 'owner-key-0000000000', 1) $$,
  '22023', 'owner_cannot_reserve', 'власник не бронює у власному посиланні'
);

reset role;
select tests.as_user('bbbbbbbb-0000-4000-8000-000000000001');
select throws_ok($$ select * from reservations $$, '42501', null, 'інший користувач теж не читає reservations');

reset role;

select is(
  (select view_count from shares where token = (select token from tests.created)),
  1, 'перегляд гостя зараховано, перегляд власника — ні'
);

-- ── Живе посилання (ADR-007) ─────────────────

delete from items where id = 'cccccccc-0000-4000-8000-0000000000c2';
update items set status = 'purchased' where id = 'cccccccc-0000-4000-8000-0000000000c1';

select tests.as_anon();
select is_empty(
  $$ select tests.shared_ids((select token from tests.created)) $$,
  'видалена й куплена власником позиції зникли в гостя без перестворення посилання'
);
select is(
  unreserve_item((select token from tests.created), 'cccccccc-0000-4000-8000-0000000000c1', 'guest-one-0000000000'),
  0, 'гість знімає власну бронь'
);

reset role;

select * from finish();
rollback;
