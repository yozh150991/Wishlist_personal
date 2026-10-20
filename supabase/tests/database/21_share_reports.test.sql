-- Гостьова v2, крок 5д (ADR-061): «Поскаржитись».
-- Скарга — лише на живе посилання, з переліку причин, з лімітом частоти;
-- власник на своєму посиланні не скаржиться; таблицю скарг не бачать ні
-- власник, ні гості; сервіс будиться тим самим сигналом, що й гостьові листи.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(16);

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

create function tests.wakes() returns integer language sql security definer as $$
  select count(*)::int from net.http_request_queue where url = 'https://guestmail.test.local/wake'
$$;

grant execute on all functions in schema tests to anon, authenticated;

insert into auth.users (id, email) values
  ('a2111111-0000-4000-8000-000000000001', 'owner21@test.local'),
  ('a2111111-0000-4000-8000-000000000002', 'other21@test.local');

insert into public.lists (id, owner_id, title, currency) values
  ('a2111111-0000-4000-8000-00000000000a', 'a2111111-0000-4000-8000-000000000001', 'Підозрілий список', 'PLN');

insert into public.shares (id, owner_id, source_list_id, token, title, revoked_at) values
  ('a2111111-0000-4000-8000-0000000000d1', 'a2111111-0000-4000-8000-000000000001', 'a2111111-0000-4000-8000-00000000000a', 'reportToken000000000001', 'Виграй айфон', null),
  ('a2111111-0000-4000-8000-0000000000d2', 'a2111111-0000-4000-8000-000000000001', 'a2111111-0000-4000-8000-00000000000a', 'reportRevoked0000000001', 'Старе', now());

select vault.create_secret('https://guestmail.test.local/wake', 'guest_mail_url');
select vault.create_secret('test-wake-secret-0123456789abcdef', 'guest_mail_secret');

-- ── Гість скаржиться ─────────────────────────

select tests.as_anon();
select lives_ok(
  $$ select report_share('reportToken000000000001', 'scam', '  Просять гроші на картку  ', 'pl') $$,
  'гість без акаунта скаржиться на живе посилання');

select tests.as_postgres();
select is((select reason || '|' || comment || '|' || locale || '|' || owner_id::text from public.share_reports),
          'scam|Просять гроші на картку|pl|a2111111-0000-4000-8000-000000000001',
          'причина, коментар без пробілів по краях, мова й власник — знімком');
select is(tests.wakes(), 1, 'скарга будить сервіс листів');

-- ── Що не приймається ────────────────────────

select tests.as_anon();
select throws_ok($$ select report_share('reportRevoked0000000001', 'spam') $$, 'P0002', 'not_found',
                 'на мертве посилання — not_found');
select throws_ok($$ select report_share('reportNoSuch00000000001', 'spam') $$, 'P0002', 'not_found',
                 'на неіснуюче — так само');
select throws_ok($$ select report_share('reportToken000000000001', 'boring') $$, '22023', 'bad_reason',
                 'причина лише з переліку');
select throws_ok($$ select report_share('reportToken000000000001', 'other', repeat('я', 1001)) $$, '22023', 'bad_comment',
                 'коментар понад 1000 символів — ні');

select tests.as_user('a2111111-0000-4000-8000-000000000001');
select throws_ok($$ select report_share('reportToken000000000001', 'spam') $$, '22023', 'owner_cannot_report',
                 'власник на своєму посиланні не скаржиться');

select tests.as_user('a2111111-0000-4000-8000-000000000002');
select lives_ok($$ select report_share('reportToken000000000001', 'offensive') $$,
                'інший користувач з акаунтом — може');

-- ── Ліміт ────────────────────────────────────

select tests.as_anon();
select report_share('reportToken000000000001', 'spam');
select report_share('reportToken000000000001', 'spam', '');
select report_share('reportToken000000000001', 'other', 'ще одна');
select throws_ok($$ select report_share('reportToken000000000001', 'spam') $$, '22023', 'rate_limited',
                 'шоста скарга на посилання за годину — rate_limited');

select tests.as_postgres();
select is((select count(*)::int from public.share_reports), 5, 'у таблиці — п''ять скарг');
select is((select count(*)::int from public.share_reports where comment is null), 3,
          'порожній коментар — null');

-- ── Ніхто, крім сервісу, таблиці не бачить ───

select tests.as_user('a2111111-0000-4000-8000-000000000001');
select throws_ok($$ select count(*) from public.share_reports $$, '42501', null,
                 'власник не читає скарг на свої посилання');
select tests.as_anon();
select throws_ok($$ select count(*) from public.share_reports $$, '42501', null, 'гість — теж');

-- ── Посилання видалили — скарга лишається ────

select tests.as_postgres();
delete from public.shares where id = 'a2111111-0000-4000-8000-0000000000d1';
select is((select count(*)::int from public.share_reports where share_id is null), 5,
          'видалене посилання не стирає скарг: share_id — null, власник — знімком');

-- ── Сигнал і на самі скарги ──────────────────

delete from public.guest_mail;
delete from net.http_request_queue;
select public.wake_guest_mail();
select is(tests.wakes(), 1, 'черга гостьових листів порожня, але є скарги — сервіс будиться');

select * from finish();
rollback;
