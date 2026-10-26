-- Вхід із нового пристрою (ADR-074): лист типово ввімкнений, пристрої й
-- сесії бачить лише сервіс, а «Вийти на всіх пристроях» прибирає всі
-- push-підписки власника — і лише його.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(14);

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

-- Сесії читаються від імені сервісу — тож і він повертається через tests.as_postgres().
grant usage on schema tests to service_role;
grant execute on all functions in schema tests to anon, authenticated, service_role;

insert into auth.users (id, email) values
  ('a3111111-0000-4000-8000-00000000000a', 'signin-a@test.local'),
  ('a3111111-0000-4000-8000-00000000000b', 'signin-b@test.local');

-- ── Канали за замовчуванням ──────────────────

insert into public.notification_settings (owner_id) values ('a3111111-0000-4000-8000-00000000000a');
select is((select signin_email from public.notification_settings where owner_id = 'a3111111-0000-4000-8000-00000000000a'),
          true, 'лист про вхід із нового пристрою типово ввімкнений');
select is((select signin_push from public.notification_settings where owner_id = 'a3111111-0000-4000-8000-00000000000a'),
          false, 'push про вхід типово вимкнений');

-- ── Пристрої — лише сервісу ──────────────────

insert into public.known_devices (owner_id, device) values ('a3111111-0000-4000-8000-00000000000a', 'Chrome · Android');

select tests.as_user('a3111111-0000-4000-8000-00000000000a');
select throws_ok($$ select count(*) from public.known_devices $$, '42501', null,
                 'власник не читає відомі пристрої напряму');
select tests.as_anon();
select throws_ok($$ select count(*) from public.known_devices $$, '42501', null, 'гість — тим паче');

-- ── Сесії — лише сервісу ─────────────────────

select tests.as_postgres();
insert into auth.sessions (id, user_id, created_at, updated_at, user_agent, ip) values
  ('a3111111-0000-4000-8000-0000000000e1', 'a3111111-0000-4000-8000-00000000000a', now() - interval '5 hours', now(),
   'Mozilla/5.0 (Linux; Android 14) Chrome/131.0 Mobile Safari/537.36', '198.51.100.4'),
  ('a3111111-0000-4000-8000-0000000000e2', 'a3111111-0000-4000-8000-00000000000a', now() - interval '20 minutes', now(),
   'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/132.0', '203.0.113.7'),
  ('a3111111-0000-4000-8000-0000000000e3', 'a3111111-0000-4000-8000-00000000000b', now() - interval '10 minutes', now(),
   null, null);

select tests.as_user('a3111111-0000-4000-8000-00000000000a');
select throws_ok($$ select * from public.recent_sign_ins(now() - interval '1 day') $$, '42501', null,
                 'власник не читає сесії');
select tests.as_anon();
select throws_ok($$ select * from public.recent_sign_ins(now() - interval '1 day') $$, '42501', null,
                 'гість не читає сесії');

select tests.as_postgres();
set local role service_role;
select results_eq(
  $$ select session_id::text, user_agent, ip from public.recent_sign_ins(now() - interval '1 hour') $$,
  $$ values ('a3111111-0000-4000-8000-0000000000e2', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/132.0', '203.0.113.7'),
            ('a3111111-0000-4000-8000-0000000000e3', null, null) $$,
  'сервіс бачить лише сесії після p_since, у порядку входу, IP — без маски');
select is((select count(*)::int from public.recent_sign_ins(now() - interval '1 day', 1)), 1,
          'межа p_limit діє');

-- ── «Вийти на всіх пристроях» ────────────────

select tests.as_postgres();
insert into public.push_subscriptions (owner_id, endpoint, p256dh, auth) values
  ('a3111111-0000-4000-8000-00000000000a', 'https://fcm.googleapis.com/fcm/send/a1',
   'B' || repeat('A', 86), repeat('a', 22)),
  ('a3111111-0000-4000-8000-00000000000a', 'https://fcm.googleapis.com/fcm/send/a2',
   'B' || repeat('C', 86), repeat('c', 22)),
  ('a3111111-0000-4000-8000-00000000000b', 'https://fcm.googleapis.com/fcm/send/b1',
   'B' || repeat('D', 86), repeat('d', 22));

select tests.as_anon();
select throws_ok($$ select public.forget_all_push_subscriptions() $$, '42501', null,
                 'гість нічиїх підписок не прибирає');

select tests.as_user('a3111111-0000-4000-8000-00000000000a');
select lives_ok($$ select public.forget_all_push_subscriptions() $$, 'власник прибирає всі свої підписки');

select tests.as_postgres();
select is((select count(*)::int from public.push_subscriptions where owner_id = 'a3111111-0000-4000-8000-00000000000a'),
          0, 'у власника підписок не лишилось');
select is((select count(*)::int from public.push_subscriptions where owner_id = 'a3111111-0000-4000-8000-00000000000b'),
          1, 'чужі підписки на місці');

-- ── Видалення акаунта ────────────────────────

delete from auth.users where id = 'a3111111-0000-4000-8000-00000000000a';
select is((select count(*)::int from public.known_devices), 0, 'відомі пристрої зникають разом з акаунтом');

select ok(
  (select bool_and(p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres')
     from pg_proc p
    where p.oid in ('public.recent_sign_ins(timestamptz, integer)'::regprocedure,
                    'public.forget_all_push_subscriptions()'::regprocedure)),
  'обидві функції — SECURITY DEFINER від postgres');

select * from finish();
rollback;
