-- Гостьові листи, крок 5б-1 (ADR-041, п. 3–4, 8; ADR-054).
-- §3.2 — черга листів закрита від власника й гостей так само, як позначки.
-- Лист на бронь — лише з поштою й без відписки; адреси в черзі немає.
-- «Надіслати код на пошту» відповідає однаково, є адреса чи ні; ліміт —
-- спільний зі спробами коду. Сигнал сервісу — через pg_net, із секретом
-- з Vault, і без налаштувань він нічого не ламає.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(25);

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

-- Скільки сигналів сервісу пішло на нашу тестову адресу.
create function tests.wakes() returns integer language sql security definer as $$
  select count(*)::int from net.http_request_queue where url = 'https://guestmail.test.local/wake'
$$;
grant execute on function tests.wakes() to anon, authenticated;

-- ── Дані ─────────────────────────────────────

insert into auth.users (id, email) values
  ('a1511111-0000-4000-8000-000000000001', 'owner15@test.local');

insert into public.lists (id, owner_id, title, currency) values
  ('a1511111-0000-4000-8000-00000000000a', 'a1511111-0000-4000-8000-000000000001', 'Весілля', 'PLN');

insert into public.items (id, list_id, owner_id, title, price, quantity, status) values
  ('a1511111-0000-4000-8000-0000000000c1', 'a1511111-0000-4000-8000-00000000000a', 'a1511111-0000-4000-8000-000000000001', 'Кавоварка', 900, 1, 'active'),
  ('a1511111-0000-4000-8000-0000000000c2', 'a1511111-0000-4000-8000-00000000000a', 'a1511111-0000-4000-8000-000000000001', 'Келихи',    50,  20, 'active');

insert into public.shares (id, owner_id, source_list_id, token, title, revoked_at) values
  ('a1511111-0000-4000-8000-0000000000d1', 'a1511111-0000-4000-8000-000000000001', 'a1511111-0000-4000-8000-00000000000a', 'guestMailToken000000001', 'Весілля', null),
  ('a1511111-0000-4000-8000-0000000000d2', 'a1511111-0000-4000-8000-000000000001', 'a1511111-0000-4000-8000-00000000000a', 'guestMailRevoked0000001', 'Старе',   now());

insert into public.share_items (share_id, item_id) values
  ('a1511111-0000-4000-8000-0000000000d1', 'a1511111-0000-4000-8000-0000000000c1'),
  ('a1511111-0000-4000-8000-0000000000d1', 'a1511111-0000-4000-8000-0000000000c2');

-- ── Без налаштувань сигнал мовчить, бронь не ламається ─

select tests.as_anon();
select lives_ok(
  $$ select claim_item_v2('guestMailToken000000001', 'a1511111-0000-4000-8000-0000000000c2',
                          'guestMailKeyAAAAAAAAAAAAA', 1, null, 'ira@pochta.ua', 'pl') $$,
  'без секретів у Vault бронь із поштою проходить'
);
select is(tests.wakes(), 0, 'без секретів сервіс не будять');

reset role;
select vault.create_secret('https://guestmail.test.local/wake', 'guest_mail_url');
select vault.create_secret('test-wake-secret-0123456789abcdef', 'guest_mail_secret');

-- ── Лист на бронь ────────────────────────────

select tests.as_anon();
select lives_ok(
  $$ select claim_item_v2('guestMailToken000000001', 'a1511111-0000-4000-8000-0000000000c1',
                          'guestMailKeyAAAAAAAAAAAAA', 1, null, null, 'pl') $$,
  'бронь гостя з поштою'
);

reset role;
select is(
  (select count(*)::int from guest_mail where kind = 'claim' and item_id = 'a1511111-0000-4000-8000-0000000000c1'),
  1,
  'бронь гостя з поштою ставить лист у чергу'
);
select is(
  (select locale from guest_mail where item_id = 'a1511111-0000-4000-8000-0000000000c1'),
  'pl',
  'мова листа — мова гостьової в момент броні'
);
select is(
  (select count(*)::int from information_schema.columns
    where table_schema = 'public' and table_name = 'guest_mail' and column_name ~ 'email|key|token'),
  0,
  'у черзі немає ні адреси, ні ключа, ні токена'
);
select ok(tests.wakes() >= 1, 'лист у черзі будить сервіс через pg_net');
select is(
  (select headers->>'x-wake-secret' from net.http_request_queue
    where url = 'https://guestmail.test.local/wake' order by id desc limit 1),
  'test-wake-secret-0123456789abcdef',
  'сигнал несе секрет із Vault'
);
select is(
  (select convert_from(body, 'UTF8')::jsonb from net.http_request_queue
    where url = 'https://guestmail.test.local/wake' order by id desc limit 1),
  '{}'::jsonb,
  'сигнал не несе даних'
);

-- Гість без пошти листа не отримує.
select tests.as_anon();
select claim_item_v2('guestMailToken000000001', 'a1511111-0000-4000-8000-0000000000c2',
                     'guestMailKeyBBBBBBBBBBBBB', 1, null, null, 'uk');
reset role;
select is(
  (select count(*)::int from guest_mail m join guest_identities g on g.id = m.identity_id where g.email is null),
  0,
  'без пошти листа немає'
);

-- ── Ліміт: 10 листів на годину на ідентичність ─

select tests.as_anon();
select claim_item_v2('guestMailToken000000001', 'a1511111-0000-4000-8000-0000000000c2',
                     'guestMailKeyAAAAAAAAAAAAA', n, null, null, 'uk')
  from generate_series(1, 15) n;
reset role;
select is(
  (select count(*)::int from guest_mail m join guest_identities g on g.id = m.identity_id
    where g.email = 'ira@pochta.ua'),
  10,
  'бронь по колу не стає розсилкою: не більше 10 листів на годину'
);

-- ── Відписка ─────────────────────────────────

select tests.as_anon();
select lives_ok($$ select guest_mail_set('notARealMailToken000000', false) $$,
                'чужий чи вигаданий токен відписки — та сама тиша');
-- anon не читає guest_identities: токен із «листа» беремо як postgres.
reset role;
select set_config('tests.mail_token', (select mail_token from guest_identities where email = 'ira@pochta.ua'), true);
delete from guest_mail;

select tests.as_anon();
select guest_mail_set(current_setting('tests.mail_token'), false);
reset role;
select is((select mail_off from guest_identities where email = 'ira@pochta.ua'), true,
          'посилання з листа вимикає листи цього списку');

select tests.as_anon();
select claim_item_v2('guestMailToken000000001', 'a1511111-0000-4000-8000-0000000000c2',
                     'guestMailKeyAAAAAAAAAAAAA', 1, null, null, 'uk');
reset role;
select is((select count(*)::int from guest_mail where kind = 'claim'), 0,
          'після відписки листа на бронь немає');

-- ── «Надіслати код на пошту» ─────────────────

select tests.as_anon();
select is(
  send_guest_code('guestMailToken000000001', 'nobody@pochta.ua', 'uk'),
  send_guest_code('guestMailToken000000001', ' IRA@pochta.ua ', 'en'),
  'відповідь однакова, є така адреса в списку чи ні'
);
reset role;
select is((select count(*)::int from guest_mail where kind = 'code'), 1,
          'код іде лише на адресу, що є в списку, — і після відписки теж');
select is((select locale from guest_mail where kind = 'code'), 'en', 'мова листа з кодом — мова запиту');

select tests.as_anon();
select send_guest_code('guestMailToken000000001', 'x@pochta.ua', 'uk') from generate_series(1, 3);
select is(
  send_guest_code('guestMailToken000000001', 'ira@pochta.ua', 'uk')->>'error',
  'too_many_attempts',
  'ліміт спільний зі спробами коду: шоста спроба за годину — too_many_attempts'
);
select throws_ok(
  $$ select send_guest_code('guestMailRevoked0000001', 'ira@pochta.ua', 'uk') $$,
  'P0002', 'not_found', 'мертве посилання — not_found'
);

-- Знову ввімкнути.
select guest_mail_set(current_setting('tests.mail_token'), true);
reset role;
select is((select mail_off from guest_identities where email = 'ira@pochta.ua'), false,
          '«Повернути листи» вмикає їх знову');

-- ── Ні власнику, ні гостям ───────────────────

select tests.as_anon();
select throws_ok($$ select * from guest_mail $$, '42501', null, 'гість не читає чергу листів');

select tests.as_user('a1511111-0000-4000-8000-000000000001');
select throws_ok($$ select * from guest_mail $$, '42501', null, 'власник не читає чергу листів');
select throws_ok(
  $$ select send_guest_code('guestMailToken000000001', 'ira@pochta.ua', 'uk') $$,
  '22023', 'owner_cannot_reserve', 'власник не просить код гостя'
);
select throws_ok(
  $$ select enqueue_guest_mail(null, null, 'code', null, 'uk') $$,
  '42501', null, 'постановка в чергу — лише зсередини гостьових RPC'
);

reset role;
select is(
  (select count(*)::int from pg_policies where tablename = 'guest_mail'),
  0,
  'на черзі листів немає жодної політики'
);

select * from finish();
rollback;
