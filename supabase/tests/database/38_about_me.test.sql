-- ROADMAP 8.10: профіль «Про мене» (розміри, що люблю, «не дарувати»).
-- Гість бачить його лише на посиланні, де власник увімкнув shares.show_about.
-- Без дозволу ключа `about` у відповіді немає зовсім, і жоден рядок профілю
-- не протікає в інші поля. Дозвіл на посиланні A не відкриває профіль через
-- посилання B. Мертве посилання — not_found, як і раніше (§3.3). Чужий
-- профіль не читається й не пишеться. Картка для ботів (ADR-060) — без нього.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(37);

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

grant execute on all functions in schema tests to anon, authenticated;

-- Власник O (два списки), сторонній власник X зі своїм профілем.
insert into auth.users (id, email) values
  ('a3811111-0000-4000-8000-000000000001', 'owner38@test.local'),
  ('a3811111-0000-4000-8000-000000000002', 'other38@test.local');

insert into public.lists (id, owner_id, title, currency) values
  ('a3811111-0000-4000-8000-00000000000a', 'a3811111-0000-4000-8000-000000000001', 'День народження', 'PLN'),
  ('a3811111-0000-4000-8000-00000000000b', 'a3811111-0000-4000-8000-000000000001', 'Новий рік',       'PLN'),
  ('a3811111-0000-4000-8000-00000000000c', 'a3811111-0000-4000-8000-000000000002', 'Чужий',           'PLN');

insert into public.items (id, list_id, owner_id, title, price, quantity, status) values
  ('a3811111-0000-4000-8000-0000000000c1', 'a3811111-0000-4000-8000-00000000000a', 'a3811111-0000-4000-8000-000000000001', 'Книга', 80, 1, 'active'),
  ('a3811111-0000-4000-8000-0000000000c2', 'a3811111-0000-4000-8000-00000000000b', 'a3811111-0000-4000-8000-000000000001', 'Чай',   40, 1, 'active'),
  ('a3811111-0000-4000-8000-0000000000c3', 'a3811111-0000-4000-8000-00000000000c', 'a3811111-0000-4000-8000-000000000002', 'Лампа', 90, 1, 'active');

-- A і B — два посилання одного списку; C — інший список того самого власника;
-- D — посилання стороннього X; E — уже протерміноване.
insert into public.shares (id, owner_id, source_list_id, token, title) values
  ('a3811111-0000-4000-8000-0000000000d1', 'a3811111-0000-4000-8000-000000000001', 'a3811111-0000-4000-8000-00000000000a', 'aboutTokenA00000000001', 'Рідним'),
  ('a3811111-0000-4000-8000-0000000000d2', 'a3811111-0000-4000-8000-000000000001', 'a3811111-0000-4000-8000-00000000000a', 'aboutTokenB00000000002', 'Колегам'),
  ('a3811111-0000-4000-8000-0000000000d3', 'a3811111-0000-4000-8000-000000000001', 'a3811111-0000-4000-8000-00000000000b', 'aboutTokenC00000000003', 'Новий рік'),
  ('a3811111-0000-4000-8000-0000000000d4', 'a3811111-0000-4000-8000-000000000002', 'a3811111-0000-4000-8000-00000000000c', 'aboutTokenD00000000004', 'Чужий');

insert into public.share_items (share_id, item_id) values
  ('a3811111-0000-4000-8000-0000000000d1', 'a3811111-0000-4000-8000-0000000000c1'),
  ('a3811111-0000-4000-8000-0000000000d2', 'a3811111-0000-4000-8000-0000000000c1'),
  ('a3811111-0000-4000-8000-0000000000d3', 'a3811111-0000-4000-8000-0000000000c2'),
  ('a3811111-0000-4000-8000-0000000000d4', 'a3811111-0000-4000-8000-0000000000c3');

-- ── Усталені значення = поточна поведінка ────

select is((select row(about_sizes, about_likes, about_avoid)::text from public.profiles
            where id = 'a3811111-0000-4000-8000-000000000001'),
          '(,,)', 'новий профіль: «Про мене» порожнє');
select is((select count(*)::int from public.shares where owner_id = 'a3811111-0000-4000-8000-000000000001' and show_about),
          0, 'нове посилання: show_about = false');

-- ── Власник заповнює ─────────────────────────

select tests.as_user('a3811111-0000-4000-8000-000000000001');
select lives_ok(
  $$ update public.profiles
        set about_sizes = '  M / 42 / EU 43  ', about_likes = 'Чай пуер', about_avoid = 'Парфуми'
      where id = 'a3811111-0000-4000-8000-000000000001' $$,
  'власник зберігає «Про мене»');
select is((select about_sizes from public.profiles where id = 'a3811111-0000-4000-8000-000000000001'),
          'M / 42 / EU 43', 'пробіли по краях обрізано');

select tests.as_user('a3811111-0000-4000-8000-000000000002');
update public.profiles set about_sizes = 'XL', about_likes = 'Секрет X'
 where id = 'a3811111-0000-4000-8000-000000000002';

-- ── Без дозволу гість не отримує нічого ──────

select tests.as_anon();
select ok(not (public.get_guest_list('aboutTokenA00000000001', null) ? 'about'),
          'без дозволу: ключа about немає (гість без ключа)');
select ok(not (public.get_guest_list('aboutTokenA00000000001', 'aboutKeyAAAAAAAAAAAAAAAA') ? 'about'),
          'без дозволу: ключа about немає (гість із ключем)');
select ok(position('EU 43' in public.get_guest_list('aboutTokenA00000000001', null)::text) = 0
          and position('пуер' in public.get_guest_list('aboutTokenA00000000001', null)::text) = 0
          and position('Парфуми' in public.get_guest_list('aboutTokenA00000000001', null)::text) = 0,
          'без дозволу: жоден рядок профілю не протікає в інші поля відповіді');
select is((public.get_guest_list('aboutTokenA00000000001', null)->'items'->0->>'title'), 'Книга',
          'решта відповіді на місці');

select tests.as_user('a3811111-0000-4000-8000-000000000001');
select ok(not (public.get_guest_list('aboutTokenA00000000001', null) ? 'about'),
          'власник на своєму посиланні без дозволу теж не бачить about — як гість');

-- ── Дозвіл на посиланні A ────────────────────

select lives_ok(
  $$ update public.shares set show_about = true where id = 'a3811111-0000-4000-8000-0000000000d1' $$,
  'власник вмикає «Показати гостям» на посиланні A');

select tests.as_anon();
select is(public.get_guest_list('aboutTokenA00000000001', null)->'about',
          '{"sizes": "M / 42 / EU 43", "likes": "Чай пуер", "avoid": "Парфуми"}'::jsonb,
          'з дозволом: гість бачить «Про мене»');
select is(public.get_guest_list('aboutTokenA00000000001', 'aboutKeyAAAAAAAAAAAAAAAA')->'about'->>'sizes',
          'M / 42 / EU 43', 'з дозволом: і гість із ключем');

select tests.as_user('a3811111-0000-4000-8000-000000000001');
select is(public.get_guest_list('aboutTokenA00000000001', null)->'about'->>'avoid', 'Парфуми',
          'власник на своєму посиланні бачить те саме, що гість');
select is((public.get_guest_list('aboutTokenA00000000001', null)->>'viewer_is_owner')::boolean, true,
          '…і це справді відповідь власнику');

-- Сторонній користувач з акаунтом відкриває посилання як гість.
select tests.as_user('a3811111-0000-4000-8000-000000000002');
select is(public.get_guest_list('aboutTokenA00000000001', null)->'about'->>'likes', 'Чай пуер',
          'з дозволом: гість з акаунтом бачить «Про мене» власника, а не своє');

-- ── A не відкриває B ─────────────────────────

select tests.as_anon();
select ok(not (public.get_guest_list('aboutTokenB00000000002', null) ? 'about'),
          'посилання B того самого списку — без about');
select ok(position('EU 43' in public.get_guest_list('aboutTokenB00000000002', null)::text) = 0,
          'посилання B — жодного рядка профілю');
select ok(not (public.get_guest_list('aboutTokenC00000000003', null) ? 'about'),
          'посилання іншого списку того самого власника — без about');

-- ── Чужий профіль ────────────────────────────

select ok(not (public.get_guest_list('aboutTokenD00000000004', null) ? 'about'),
          'посилання X без дозволу — без about X');

select tests.as_user('a3811111-0000-4000-8000-000000000002');
select is((select count(*)::int from public.profiles where id = 'a3811111-0000-4000-8000-000000000001'), 0,
          'X не читає профіль O');
update public.profiles set about_avoid = 'Зламано' where id = 'a3811111-0000-4000-8000-000000000001';
update public.shares set show_about = true where id = 'a3811111-0000-4000-8000-0000000000d2';

select tests.as_postgres();
select is((select about_avoid from public.profiles where id = 'a3811111-0000-4000-8000-000000000001'), 'Парфуми',
          'X не змінює профіль O');
select is((select show_about from public.shares where id = 'a3811111-0000-4000-8000-0000000000d2'), false,
          'X не вмикає дозвіл на посиланні O');

-- Дозвіл на посиланні X відкриває профіль X — і лише його.
select tests.as_user('a3811111-0000-4000-8000-000000000002');
update public.shares set show_about = true where id = 'a3811111-0000-4000-8000-0000000000d4';
select tests.as_anon();
select is(public.get_guest_list('aboutTokenD00000000004', null)->'about',
          '{"sizes": "XL", "likes": "Секрет X"}'::jsonb,
          'посилання X з дозволом — профіль X, лише заповнені поля');
select ok(position('Секрет X' in public.get_guest_list('aboutTokenA00000000001', null)::text) = 0,
          'посилання O не віддає профіль X');

select throws_ok($$ select * from public.profiles $$, '42501', null,
                 'anon не читає profiles напряму');

-- ── Порожній профіль з дозволом ──────────────

select tests.as_user('a3811111-0000-4000-8000-000000000001');
update public.profiles set about_sizes = '   ', about_likes = '', about_avoid = null
 where id = 'a3811111-0000-4000-8000-000000000001';
select is((select row(about_sizes, about_likes, about_avoid)::text from public.profiles
            where id = 'a3811111-0000-4000-8000-000000000001'),
          '(,,)', 'самі пробіли й порожній рядок — null');
select tests.as_anon();
select ok(not (public.get_guest_list('aboutTokenA00000000001', null) ? 'about'),
          'дозвіл є, а профіль порожній — ключа about немає');

select tests.as_user('a3811111-0000-4000-8000-000000000001');
update public.profiles set about_sizes = 'S' where id = 'a3811111-0000-4000-8000-000000000001';

-- ── Межі ─────────────────────────────────────

select throws_ok(
  $$ update public.profiles set about_sizes = repeat('я', 121) where id = 'a3811111-0000-4000-8000-000000000001' $$,
  '23514', null, 'розміри понад 120 символів — ні');
select throws_ok(
  $$ update public.profiles set about_likes = repeat('я', 501) where id = 'a3811111-0000-4000-8000-000000000001' $$,
  '23514', null, '«що люблю» понад 500 символів — ні');
select throws_ok(
  $$ update public.profiles set about_avoid = repeat('я', 501) where id = 'a3811111-0000-4000-8000-000000000001' $$,
  '23514', null, '«не дарувати» понад 500 символів — ні');

-- ── Картка для ботів — без «Про мене» ────────

select tests.as_anon();
select ok(not (public.get_share_card('aboutTokenA00000000001') ? 'about')
          and position('"S"' in public.get_share_card('aboutTokenA00000000001')::text) = 0,
          'картка посилання з дозволом не несе «Про мене» (ADR-060)');

-- ── Мертве посилання — not_found, як і раніше ─

select tests.as_postgres();
update public.shares set expires_at = now() - interval '1 minute' where id = 'a3811111-0000-4000-8000-0000000000d1';
select tests.as_anon();
select throws_ok($$ select public.get_guest_list('aboutTokenA00000000001', null) $$, 'P0002', 'not_found',
                 'протерміноване посилання з дозволом — not_found');

select tests.as_postgres();
update public.shares set expires_at = null, revoked_at = now() where id = 'a3811111-0000-4000-8000-0000000000d1';
select tests.as_anon();
select throws_ok($$ select public.get_guest_list('aboutTokenA00000000001', null) $$, 'P0002', 'not_found',
                 'відкликане посилання з дозволом — not_found');
select throws_ok($$ select public.get_guest_list('aboutTokenZ00000000099', null) $$, 'P0002', 'not_found',
                 'неіснуюче посилання — та сама відповідь');

-- ── Гранти (§3.4) ────────────────────────────

select tests.as_postgres();
select ok(
  not has_function_privilege('anon', 'public.guest_about(public.shares)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.guest_about(public.shares)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.guest_about(public.shares)', 'EXECUTE'),
  'guest_about — внутрішня, прямого виклику немає');
select ok(
  has_function_privilege('anon', 'public.get_guest_list(text, text)', 'EXECUTE')
  and (select p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres'
         from pg_proc p where p.oid = 'public.get_guest_list(text, text)'::regprocedure),
  'get_guest_list лишається гостьовою обгорткою SECURITY DEFINER');
select ok(
  not has_function_privilege('anon', 'public.profiles_about_tidy()', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.profiles_about_tidy()', 'EXECUTE'),
  'тригер profiles_about_tidy — без грантів клієнтам');

select * from finish();
rollback;
