-- Гостьовий доступ, позначки й ключ гостя.
-- §3.2 — власник не бачить позначок, навіть у власному посиланні (ADR-008, ADR-009),
--        і нічого, з чого їх можна вирахувати: ні лічильника, ні зміни відповіді.
-- §3.3 — гість бачить лише те, що вибрано, і лише актуальне (ADR-007).
-- ADR-035 — ключ гостя обмежений одним списком; код переносить позначки
--        одноразово, 5 спроб на годину; скидання власником — сліпе; мертве
--        посилання — одна відповідь на всі причини.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(52);

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

-- Поле позиції у відповіді гостю з певним ключем.
create function tests.item_field(p_token text, p_key text, p_item uuid, p_field text) returns jsonb
language sql as $$
  select e->p_field from jsonb_array_elements(public.get_shared_list(p_token, p_key)->'items') e
   where (e->>'id')::uuid = p_item
$$;

grant execute on all functions in schema tests to anon, authenticated;

-- Токен посилання, створеного власником через RPC.
create table tests.created (token text);
grant select on tests.created to anon, authenticated;
grant insert on tests.created to authenticated;

-- Відповіді власника до й після позначки гостя — для порівняння байт у байт.
create table tests.owner_view (stage text, body text);
grant select, insert on tests.owner_view to authenticated;

-- Коди й ключі, отримані гостем, — щоб передавати між кроками.
create table tests.guest (name text primary key, value text);
grant select, insert, update on tests.guest to anon, authenticated;

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

-- Мертве посилання — одна відповідь на всі три причини (ADR-035).
select throws_ok($$ select get_shared_list('noSuchToken000000000000') $$, 'P0002', 'not_found', 'невідомий токен — not_found');
select throws_ok($$ select get_shared_list('revokedToken00000000000') $$, 'P0002', 'not_found', 'відкликане посилання — теж not_found');
select throws_ok($$ select get_shared_list('expiredToken00000000000') $$, 'P0002', 'not_found', 'прострочене посилання — теж not_found');
select throws_ok($$ select claim_item('revokedToken00000000000', 'cccccccc-0000-4000-8000-0000000000c1', 'guest-one-key-000000000001', 1) $$,
                 'P0002', 'not_found', 'позначка на відкликаному посиланні — та сама відповідь');

-- ── Позначки ─────────────────────────────────

select is(
  (claim_item((select token from tests.created), 'cccccccc-0000-4000-8000-0000000000c1', 'guest-one-key-000000000001', 1)->>'taken_qty')::int,
  1, 'гість 1 бере позицію — взято 1'
);
insert into tests.guest (name, value)
select 'code1', get_shared_list((select token from tests.created), 'guest-one-key-000000000001')->'guest'->>'code';
select ok((select value from tests.guest where name = 'code1') ~ '^[2-9ABCDEFGHJKMNPQRSTUVWXYZ]{5}$',
          'перша позначка тихо створює короткий код із 5 символів');

select throws_ok(
  $$ select claim_item((select token from tests.created), 'cccccccc-0000-4000-8000-0000000000c1', 'guest-two-key-000000000002', 1) $$,
  '22023', 'not_enough_left', 'гість 2 не бере те, що вже розібрано'
);
select throws_ok(
  $$ select claim_item((select token from tests.created), 'cccccccc-0000-4000-8000-0000000000c5', 'guest-two-key-000000000002', 1) $$,
  'P0002', 'item_not_in_share', 'не можна позначити позицію, якої немає в посиланні'
);
select throws_ok(
  $$ select claim_item('noReservationsToken0000', 'cccccccc-0000-4000-8000-0000000000c1', 'guest-two-key-000000000002', 1) $$,
  '22023', 'reservations_disabled', 'позначки вимкнені власником'
);
select throws_ok(
  $$ select claim_item((select token from tests.created), 'cccccccc-0000-4000-8000-0000000000c2', 'short', 1) $$,
  '22023', 'bad_key', 'ключ не тієї форми не приймається'
);
select is(
  (release_claim((select token from tests.created), 'cccccccc-0000-4000-8000-0000000000c1', 'guest-two-key-000000000002')->>'taken_qty')::int,
  1, 'чужий ключ не знімає позначку іншого гостя'
);
select is(tests.item_field((select token from tests.created), null, 'cccccccc-0000-4000-8000-0000000000c1', 'taken_qty'),
          '1'::jsonb, 'гість без ключа бачить, що позицію взято');
select is(tests.item_field((select token from tests.created), 'guest-two-key-000000000002', 'cccccccc-0000-4000-8000-0000000000c1', 'mine_qty'),
          '0'::jsonb, 'інший гість бачить її як чужу');
select is(tests.item_field((select token from tests.created), 'guest-one-key-000000000001', 'cccccccc-0000-4000-8000-0000000000c1', 'mine_qty'),
          '1'::jsonb, 'автор позначки впізнаний за ключем');
select set_eq(
  $$ select jsonb_object_keys(e) from jsonb_array_elements(get_shared_list((select token from tests.created), 'guest-two-key-000000000002')->'items') e $$,
  -- currency — валюта позиції (ADR-051): про гостей нічого не каже.
  array['id', 'title', 'url', 'price', 'currency', 'quantity', 'priority', 'note', 'variants', 'image_url',
        'status', 'created_at', 'section_id', 'taken_qty', 'mine_qty'],
  'у відповіді гостю немає ні хто, ні коли позначив — лише скільки'
);

-- Часткова кількість: «Візьму 1 з 2» лишається.
select is((claim_item((select token from tests.created), 'cccccccc-0000-4000-8000-0000000000c2', 'guest-one-key-000000000001', 1)->>'taken_qty')::int,
          1, 'гість 1 бере 1 з 2');
select is((claim_item((select token from tests.created), 'cccccccc-0000-4000-8000-0000000000c2', 'guest-two-key-000000000002', 1)->>'taken_qty')::int,
          2, 'гість 2 бере другу');
select throws_ok(
  $$ select claim_item((select token from tests.created), 'cccccccc-0000-4000-8000-0000000000c2', 'guest-one-key-000000000001', 2) $$,
  '22023', 'not_enough_left', 'гість 1 не збільшить свою частку понад те, що лишилось'
);

-- Ключ обмежений одним списком: ключ зі списку A в списку B не впізнається.
reset role;
insert into public.shares (id, owner_id, source_list_id, token, title) values
  ('dddddddd-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-000000000001', 'bbbbbbbb-0000-4000-8000-00000000000b', 'otherListToken000000000', 'Список B');
insert into public.share_items (share_id, item_id) values ('dddddddd-0000-4000-8000-0000000000b1', 'bbbbbbbb-0000-4000-8000-0000000000b1');
select tests.as_anon();
select is(get_shared_list('otherListToken000000000', 'guest-one-key-000000000001')->'guest', 'null'::jsonb,
          'ключ зі списку A, підставлений у список B, не впізнається');
select is(tests.item_field('otherListToken000000000', 'guest-one-key-000000000001', 'bbbbbbbb-0000-4000-8000-0000000000b1', 'mine_qty'),
          '0'::jsonb, '…і не повертає жодних позначок');

select register_share_view((select token from tests.created));

-- ── Код переносить позначки ──────────────────

select is(redeem_guest_code((select token from tests.created), 'ZZZZZ')->>'error', 'code_not_found',
          'невідомий код — code_not_found, і спробу зараховано');
insert into tests.guest (name, value)
select 'key3', redeem_guest_code((select token from tests.created), (select value from tests.guest where name = 'code1'))->>'key';
select is(tests.item_field((select token from tests.created), (select value from tests.guest where name = 'key3'),
                           'cccccccc-0000-4000-8000-0000000000c1', 'mine_qty'),
          '1'::jsonb, 'код переносить позначки на новий пристрій');
select is(tests.item_field((select token from tests.created), 'guest-one-key-000000000001', 'cccccccc-0000-4000-8000-0000000000c1', 'mine_qty'),
          '1'::jsonb, 'старий пристрій лишається робочим');
select is(redeem_guest_code((select token from tests.created), (select value from tests.guest where name = 'code1'))->>'error',
          'code_not_found', 'код одноразовий: вдруге той самий не спрацьовує');
select is(redeem_guest_code((select token from tests.created), 'YYYYY')->>'error', 'code_not_found',
          'четверта спроба за годину ще приймається');
select is(redeem_guest_code((select token from tests.created), 'XXXXX')->>'error', 'code_not_found',
          'п''ята спроба за годину ще приймається');
select is(
  redeem_guest_code((select token from tests.created),
                    get_shared_list((select token from tests.created), 'guest-one-key-000000000001')->'guest'->>'code')->>'error',
  'too_many_attempts', 'після п''яти спроб не приймається навіть правильний код — і про це сказано прямо'
);

-- ── Власник не бачить позначок (§3.2) ────────

reset role;
select tests.as_user('aaaaaaaa-0000-4000-8000-000000000001');

select register_share_view((select token from tests.created));

select is(get_shared_list((select token from tests.created))->>'viewer_is_owner', 'true',
          'власник упізнаний у власному посиланні');
select is(get_shared_list((select token from tests.created))->>'allow_reservations', 'false',
          'власнику позначки вимкнені');
select is_empty(
  $$ select 1 from jsonb_array_elements(get_shared_list((select token from tests.created), 'guest-one-key-000000000001')->'items') e
      where e->'taken_qty' <> 'null'::jsonb or e->'mine_qty' <> 'null'::jsonb $$,
  'власник отримує null замість лічильників на кожній позиції — навіть із ключем гостя (ADR-009)'
);
select throws_ok($$ select * from claims $$,              '42501', null, 'власник не читає claims напряму');
select throws_ok($$ select * from guest_identities $$,    '42501', null, 'власник не читає ідентичності гостей');
select throws_ok($$ select * from guest_keys $$,          '42501', null, 'власник не читає ключі гостей');
select throws_ok(
  $$ select count(*) from items i join claims c on c.item_id = i.id $$,
  '42501', null, 'власник не дістає позначки через JOIN'
);
select throws_ok(
  $$ select claim_item((select token from tests.created), 'cccccccc-0000-4000-8000-0000000000c2', 'owner-key-00000000000000', 1) $$,
  '22023', 'owner_cannot_reserve', 'власник не позначає у власному посиланні'
);

-- Відповіді власника не залежать від позначок: байт у байт до й після.
insert into tests.owner_view
select 'before', (select jsonb_agg(to_jsonb(p) order by p.id)::text from list_items_page('aaaaaaaa-0000-4000-8000-00000000000a') p)
       || (select jsonb_agg(to_jsonb(t))::text from list_totals('aaaaaaaa-0000-4000-8000-00000000000a') t);
reset role;
select tests.as_anon();
select release_claim((select token from tests.created), 'cccccccc-0000-4000-8000-0000000000c2', 'guest-two-key-000000000002');
reset role;
select tests.as_user('aaaaaaaa-0000-4000-8000-000000000001');
insert into tests.owner_view
select 'after', (select jsonb_agg(to_jsonb(p) order by p.id)::text from list_items_page('aaaaaaaa-0000-4000-8000-00000000000a') p)
       || (select jsonb_agg(to_jsonb(t))::text from list_totals('aaaaaaaa-0000-4000-8000-00000000000a') t);
select is((select body from tests.owner_view where stage = 'after'), (select body from tests.owner_view where stage = 'before'),
          'позиції й підсумки власника байт у байт однакові до й після зміни позначки гостя');

-- Сліпе скидання: нічого не повертає, однаково на позиції з позначками й без.
select lives_ok($$ select release_item_claims('cccccccc-0000-4000-8000-0000000000c1') $$,
                'власник скидає позицію з позначкою');
select lives_ok($$ select release_item_claims('cccccccc-0000-4000-8000-0000000000c5') $$,
                'і позицію без позначок — так само, без помилки й без відповіді');
select is((select pg_typeof(release_item_claims('cccccccc-0000-4000-8000-0000000000c1'))::text), 'void',
          'відповідь — void: власник не дізнається, чи було що скидати');

reset role;
select tests.as_user('bbbbbbbb-0000-4000-8000-000000000001');
select throws_ok($$ select * from claims $$, '42501', null, 'інший користувач теж не читає claims');
select throws_ok($$ select release_item_claims('cccccccc-0000-4000-8000-0000000000c1') $$,
                 'P0002', 'not_found', 'чужу позицію скинути не можна');

reset role;
select is((select count(*)::int from claims where item_id = 'cccccccc-0000-4000-8000-0000000000c1'), 0,
          'після скидання позиція вільна');

select tests.as_anon();
select throws_ok($$ select release_item_claims('cccccccc-0000-4000-8000-0000000000c1') $$,
                 '42501', null, 'гість не має доступу до скидання');

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

reset role;

select * from finish();
rollback;
