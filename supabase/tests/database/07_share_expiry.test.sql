-- Термін посилання в часовому поясі власника (ADR-037).
-- «Діє до 20 грудня» — остання секунда 20 грудня там, де живе власник, з
-- урахуванням літнього часу. Зона — справжнє IANA-імʼя; гість бачить і момент,
-- і зону; мертве посилання, як і раніше, неможливо відрізнити від неіснуючого.

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

create function tests.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'anon', true);
end $$;

-- Рік наперед: тест не має старіти разом із календарем.
create function tests.next_year(p_month int, p_day int) returns date language sql as $$
  select make_date(extract(year from now())::int + 1, p_month, p_day)
$$;

create function tests.share(p_on date, p_tz text) returns public.shares language sql as $$
  select public.create_share('a7a7a7a7-0000-4000-8000-00000000000a',
                             array['a7a7a7a7-0000-4000-8000-0000000000c1']::uuid[],
                             'Термін', p_expires_on => p_on, p_expires_tz => p_tz)
$$;

create table tests.created (label text primary key, token text);
grant all on tests.created to anon, authenticated;
grant execute on all functions in schema tests to anon, authenticated;

insert into auth.users (id, email) values
  ('a7a7a7a7-0000-4000-8000-000000000001', 'expiry-a@test.local');

insert into public.lists (id, owner_id, title) values
  ('a7a7a7a7-0000-4000-8000-00000000000a', 'a7a7a7a7-0000-4000-8000-000000000001', 'Новий рік');

insert into public.items (id, list_id, owner_id, title) values
  ('a7a7a7a7-0000-4000-8000-0000000000c1', 'a7a7a7a7-0000-4000-8000-00000000000a',
   'a7a7a7a7-0000-4000-8000-000000000001', 'Гірлянда');

-- ── create_share: дата + зона → момент ───────

select tests.as_user('a7a7a7a7-0000-4000-8000-000000000001');

insert into tests.created select 'kyiv-winter', token from tests.share(tests.next_year(12, 20), 'Europe/Kyiv');
insert into tests.created select 'kyiv-summer', token from tests.share(tests.next_year(7, 1), 'Europe/Kyiv');
insert into tests.created select 'vancouver',   token from tests.share(tests.next_year(12, 20), 'America/Vancouver');
insert into tests.created select 'kiev-icu',    token from tests.share(tests.next_year(12, 20), 'Europe/Kiev');
insert into tests.created select 'calcutta',    token from tests.share(tests.next_year(12, 20), 'Asia/Calcutta');
insert into tests.created select 'kyiv-today',  token
  from tests.share((now() at time zone 'Europe/Kyiv')::date, 'Europe/Kyiv');
insert into tests.created select 'legacy', token
  from public.create_share('a7a7a7a7-0000-4000-8000-00000000000a',
                           array['a7a7a7a7-0000-4000-8000-0000000000c1']::uuid[], 'Старий клієнт',
                           p_expires_at => (tests.next_year(3, 1) + time '12:00')::timestamptz);
insert into tests.created select 'forever', token
  from public.create_share('a7a7a7a7-0000-4000-8000-00000000000a',
                           array['a7a7a7a7-0000-4000-8000-0000000000c1']::uuid[], 'Без терміну');

select is(
  (select expires_at from shares where token = (select token from tests.created where label = 'kyiv-winter')),
  (tests.next_year(12, 20) + time '21:59:59') at time zone 'UTC',
  'Київ узимку (UTC+2): 20 грудня 23:59:59 — це 21:59:59 UTC'
);

select is(
  (select expires_at from shares where token = (select token from tests.created where label = 'kyiv-summer')),
  (tests.next_year(7, 1) + time '20:59:59') at time zone 'UTC',
  'Київ улітку (UTC+3): літній час враховано'
);

-- Зсув Ванкувера взято з бази поясів, а не зашито: tzdata 2026c перевела
-- Британську Колумбію на UTC−7 цілий рік, і зашите «07:59:59» падало на
-- новій базі. Перевіряємо саме правило — доба за поясом власника.
select is(
  (select expires_at from shares where token = (select token from tests.created where label = 'vancouver')),
  (tests.next_year(12, 20) + time '23:59:59') at time zone 'America/Vancouver',
  'Ванкувер: доба власника закінчується за його поясом — за UTC це вже 21-ше'
);

select is(
  (select expires_tz from shares where token = (select token from tests.created where label = 'kyiv-winter')),
  'Europe/Kyiv',
  'зона власника збережена поруч із моментом'
);

-- Chrome називає зону за ICU: у Києві — `Europe/Kiev`, в Індії — `Asia/Calcutta`.
select is(
  (select row(expires_tz, expires_at)::text from shares
    where token = (select token from tests.created where label = 'kiev-icu')),
  row('Europe/Kyiv', (tests.next_year(12, 20) + time '21:59:59') at time zone 'UTC')::text,
  'ICU-імʼя Europe/Kiev зберігається як Europe/Kyiv, час той самий'
);

select is(
  (select row(expires_tz, expires_at)::text from shares
    where token = (select token from tests.created where label = 'calcutta')),
  row('Asia/Kolkata', (tests.next_year(12, 20) + time '18:29:59') at time zone 'UTC')::text,
  'ICU-імʼя Asia/Calcutta — Asia/Kolkata (UTC+5:30)'
);

select ok(
  (select expires_at > now() from shares where token = (select token from tests.created where label = 'kyiv-today')),
  'сьогоднішня дата — ще живе посилання до кінця дня власника'
);

select is(
  (select row(expires_at, expires_tz)::text from shares
    where token = (select token from tests.created where label = 'legacy')),
  row((tests.next_year(3, 1) + time '12:00')::timestamptz, null::text)::text,
  'старий клієнт із p_expires_at: момент як є, без зони'
);

select is(
  (select row(expires_at, expires_tz)::text from shares
    where token = (select token from tests.created where label = 'forever')),
  row(null::timestamptz, null::text)::text,
  'без терміну — ні моменту, ні зони'
);

-- ── Відмови ──────────────────────────────────

select throws_ok(
  $$ select tests.share(tests.next_year(12, 20), 'Mars/Olympus_Mons') $$,
  '22023', 'bad_time_zone', 'неіснуюча зона — bad_time_zone'
);

select throws_ok(
  $$ select tests.share(tests.next_year(12, 20), '+3') $$,
  '22023', 'bad_time_zone', 'POSIX-зсув замість IANA-імені — bad_time_zone (у POSIX знак навпаки)'
);

select throws_ok(
  $$ select tests.share(tests.next_year(12, 20), null) $$,
  '22023', 'bad_time_zone', 'дата без зони — bad_time_zone'
);

select throws_ok(
  $$ select tests.share(((now() at time zone 'Europe/Kyiv')::date - 1), 'Europe/Kyiv') $$,
  '22023', 'expires_in_past', 'учорашня дата — expires_in_past'
);

select throws_ok(
  $$ select public.create_share('a7a7a7a7-0000-4000-8000-00000000000a',
                                array['a7a7a7a7-0000-4000-8000-0000000000c1']::uuid[], 'x',
                                p_expires_at => now() - interval '1 minute') $$,
  '22023', 'expires_in_past', 'старий клієнт із моментом у минулому — теж expires_in_past'
);

-- Напряму в таблицю (RLS дозволяє власнику оновлювати свої посилання).
select throws_ok(
  $$ update shares set expires_tz = 'Europe/Kyiv; drop table shares'
      where token = (select token from tests.created where label = 'kyiv-winter') $$,
  '23514', null, 'зона довільним рядком не записується й напряму'
);

select throws_ok(
  $$ update shares set expires_tz = 'Europe/Kyiv'
      where token = (select token from tests.created where label = 'forever') $$,
  '23514', null, 'зона без моменту не записується'
);

-- ── Гість ────────────────────────────────────

select tests.as_anon();

select is(
  public.get_shared_list((select token from tests.created where label = 'kyiv-winter'))->>'expires_tz',
  'Europe/Kyiv',
  'гість бачить зону власника'
);

select is(
  (public.get_shared_list((select token from tests.created where label = 'kyiv-winter'))->>'expires_at')::timestamptz,
  (tests.next_year(12, 20) + time '21:59:59') at time zone 'UTC',
  'гість бачить момент, до якого діє посилання'
);

select ok(
  public.get_shared_list((select token from tests.created where label = 'forever')) ? 'expires_at'
  and public.get_shared_list((select token from tests.created where label = 'forever'))->'expires_at' = 'null'::jsonb,
  'без терміну — expires_at: null, а не відсутнє поле'
);

-- Посилання, чия доба вже скінчилась, — те саме not_found, що й неіснуюче.
reset role;
update shares set expires_at = now() - interval '1 second'
 where token = (select token from tests.created where label = 'vancouver');
select tests.as_anon();

select throws_ok(
  $$ select public.get_shared_list((select token from tests.created where label = 'vancouver')) $$,
  'P0002', 'not_found', 'доба власника скінчилась — not_found, як у неіснуючого'
);

select * from finish();
rollback;
