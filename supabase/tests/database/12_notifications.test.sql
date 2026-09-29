-- Сповіщення власника (ADR-049).
-- Налаштування й пристрої бачить лише власник; журнал надісланого — лише
-- сервіс wishlist-jobs. Підписка на пристрої належить тому, хто зберіг її
-- останнім: чужі сповіщення на спільному пристрої не приходять.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(20);

create schema tests;
grant usage on schema tests to anon, authenticated;

create function tests.as_user(p_id uuid) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_id, 'role', 'authenticated')::text, true);
  perform set_config('role', 'authenticated', true);
end $$;

grant execute on all functions in schema tests to anon, authenticated;

insert into auth.users (id, email) values
  ('c1111111-0000-4000-8000-000000000001', 'notify-a@test.local'),
  ('c1111111-0000-4000-8000-000000000002', 'notify-b@test.local');

-- ── Налаштування ─────────────────────────────

select tests.as_user('c1111111-0000-4000-8000-000000000001');

insert into notification_settings (owner_id, time_zone) values
  ('c1111111-0000-4000-8000-000000000001', 'Europe/Warsaw');

select is(
  (select row(after_event_push, after_event_email, yearly_push, yearly_email, link_push, link_email,
              price_push, price_email, share_push, share_email)::text
     from notification_settings where owner_id = 'c1111111-0000-4000-8000-000000000001'),
  '(f,f,f,f,f,f,f,f,f,f)',
  'усталено всі канали вимкнені: вмикає лише людина з інтерфейсу v2'
);

select throws_ok(
  $$ update notification_settings set time_zone = 'Europe/Warsaw; drop table lists'
      where owner_id = 'c1111111-0000-4000-8000-000000000001' $$,
  '23514', null,
  'пояс — лише ім''я зони IANA'
);

select lives_ok(
  $$ update notification_settings set link_push = true
      where owner_id = 'c1111111-0000-4000-8000-000000000001' $$,
  'власник вмикає канал сам'
);

select tests.as_user('c1111111-0000-4000-8000-000000000002');

select is(
  (select count(*)::int from notification_settings),
  0,
  'чужих налаштувань не видно'
);

select throws_ok(
  $$ insert into notification_settings (owner_id) values ('c1111111-0000-4000-8000-000000000001') $$,
  '42501', null,
  'налаштувань за іншого власника не створити'
);

-- ── Пристрої ─────────────────────────────────

select tests.as_user('c1111111-0000-4000-8000-000000000001');

select throws_ok(
  $$ insert into push_subscriptions (endpoint, p256dh, auth)
     values ('https://fcm.googleapis.com/fcm/send/direct', 'B' || repeat('k', 86), repeat('a', 22)) $$,
  '42501', null,
  'напряму підписку не вставити — лише через save_push_subscription'
);

select lives_ok(
  $$ select save_push_subscription('https://fcm.googleapis.com/fcm/send/shared-device', 'B' || repeat('k', 86), repeat('a', 22)) $$,
  'власник A вмикає push на пристрої'
);

select throws_ok(
  $$ select save_push_subscription('http://169.254.169.254/latest', 'B' || repeat('k', 86), repeat('a', 22)) $$,
  '23514', null,
  'адреса підписки — лише https'
);

select throws_ok(
  $$ select save_push_subscription(E'https://fcm.googleapis.com\t/x', 'B' || repeat('k', 86), repeat('a', 22)) $$,
  '23514', null,
  'у адресі підписки немає пробілів і керівних символів'
);

select throws_ok(
  $$ select save_push_subscription('https://fcm.googleapis.com/fcm/send/short-key', repeat('A', 20), repeat('A', 8)) $$,
  '23514', null,
  'ключі браузера — лише справжньої форми: з іншою сервіс не зміг би шифрувати'
);

select throws_ok(
  $$ delete from push_subscriptions $$,
  '42501', null,
  'напряму пристрій не видалити — адреса підписки йде лише в тілі запиту'
);

select tests.as_user('c1111111-0000-4000-8000-000000000002');

select is(
  (select count(*)::int from push_subscriptions),
  0,
  'чужих пристроїв не видно'
);

-- Той самий браузер, інший акаунт: підписка переходить до B.
select save_push_subscription('https://fcm.googleapis.com/fcm/send/shared-device', 'B' || repeat('k', 86), repeat('a', 22));

select is(
  (select count(*)::int from push_subscriptions),
  1,
  'B зберіг підписку свого пристрою'
);

select tests.as_user('c1111111-0000-4000-8000-000000000001');

select is(
  (select count(*)::int from push_subscriptions),
  0,
  'і A на цьому пристрої більше нічого не отримає: спільний пристрій не бачить чужих сповіщень'
);

-- Понад 10 пристроїв — найстаріші відпадають.
do $$
begin
  for i in 1..11 loop
    perform save_push_subscription('https://fcm.googleapis.com/fcm/send/device-' || i, 'B' || repeat('k', 86), repeat('a', 22));
  end loop;
end $$;

select is(
  (select count(*)::int from push_subscriptions),
  10,
  'щонайбільше 10 пристроїв на власника'
);

select is(
  (select count(*)::int from push_subscriptions where endpoint like '%/device-1'),
  0,
  'відпав найстаріший'
);

select forget_push_subscription('https://fcm.googleapis.com/fcm/send/device-11');
select is(
  (select count(*)::int from push_subscriptions),
  9,
  '«Вимкнути push тут» прибирає свій пристрій'
);

-- ── Журнал надісланого ───────────────────────

select throws_ok(
  $$ select count(*) from notification_log $$,
  '42501', null,
  'журнал надісланого власникові недоступний'
);

reset role;
set local role service_role;

select lives_ok(
  $$ insert into notification_log (owner_id, kind, subject_id, occurrence, channels)
     values ('c1111111-0000-4000-8000-000000000001', 'link', gen_random_uuid(), 'gone:abc', '{push}') $$,
  'сервіс записує надіслане'
);

reset role;

select throws_ok(
  $$ insert into notification_log (owner_id, kind, subject_id, occurrence)
     values ('c1111111-0000-4000-8000-000000000001', 'claims', gen_random_uuid(), 'x') $$,
  '23514', null,
  'подій про позначки гостей не буває (ADR-040)'
);

select * from finish();
rollback;
