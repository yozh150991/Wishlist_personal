-- QA-регресія за техніками тест-дизайну (ADR-069): вгадування помилок.
--
-- Типові місця, де ламаються такі системи: спецсимволи в пошуку, ін'єкції в
-- параметрах, спільні лічильники, «порожні» сутності, невидимі символи в
-- іменах, переміщення між власниками даних, ліміти ємності. Що з цього вже
-- зламано — `todo` з номером із docs/QA_REPORT.md; решта — захист від регресії.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(30);

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

create function tests.titles(p_token text) returns text[] language sql as $$
  select coalesce(array_agg(e->>'title' order by e->>'title'), '{}')
    from jsonb_array_elements(public.get_guest_list(p_token, null)->'items') e
$$;

create function tests.page_titles(p_search text) returns text[] language sql as $$
  select coalesce(array_agg(title order by title), '{}')
    from public.list_items_page('c0280000-0000-4000-8000-0000000000a1', 'title', false, 100, null, null, p_search)
$$;

grant execute on all functions in schema tests to anon, authenticated;

insert into auth.users (id, email, email_confirmed_at) values
  ('c0280000-0000-4000-8000-0000000000f1', 'qa28-owner@test.local', now()),
  ('c0280000-0000-4000-8000-0000000000f2', 'qa28-other@test.local', now());

insert into public.lists (id, owner_id, title) values
  ('c0280000-0000-4000-8000-0000000000a1', 'c0280000-0000-4000-8000-0000000000f1', 'QA помилки'),
  ('c0280000-0000-4000-8000-0000000000a2', 'c0280000-0000-4000-8000-0000000000f1', 'Приватний, без посилань'),
  ('c0280000-0000-4000-8000-0000000000a3', 'c0280000-0000-4000-8000-0000000000f2', 'Чужий список');

insert into public.items (id, list_id, owner_id, title, price, quantity) values
  ('c0280000-0000-4000-8000-0000000000b1', 'c0280000-0000-4000-8000-0000000000a1', 'c0280000-0000-4000-8000-0000000000f1', 'Знижка 50%', 10, 1),
  ('c0280000-0000-4000-8000-0000000000b2', 'c0280000-0000-4000-8000-0000000000a1', 'c0280000-0000-4000-8000-0000000000f1', 'snake_case кружка', 20, 1),
  ('c0280000-0000-4000-8000-0000000000b3', 'c0280000-0000-4000-8000-0000000000a1', 'c0280000-0000-4000-8000-0000000000f1', 'Лампа', 30, 1),
  ('c0280000-0000-4000-8000-0000000000b4', 'c0280000-0000-4000-8000-0000000000a1', 'c0280000-0000-4000-8000-0000000000f1', 'Шлях C:\temp', 40, 1),
  ('c0280000-0000-4000-8000-0000000000b5', 'c0280000-0000-4000-8000-0000000000a1', 'c0280000-0000-4000-8000-0000000000f1', 'Подарунок на 50 гостей', 500, 1),
  ('c0280000-0000-4000-8000-0000000000b6', 'c0280000-0000-4000-8000-0000000000a1', 'c0280000-0000-4000-8000-0000000000f1', 'Листи', 1, 20),
  ('c0280000-0000-4000-8000-0000000000c1', 'c0280000-0000-4000-8000-0000000000a3', 'c0280000-0000-4000-8000-0000000000f2', 'Чуже', 1, 1);

insert into public.items (id, list_id, owner_id, title, url, needs_title) values
  ('c0280000-0000-4000-8000-0000000000b7', 'c0280000-0000-4000-8000-0000000000a1', 'c0280000-0000-4000-8000-0000000000f1',
   'shop.pl/x', 'https://shop.pl/x', true);

insert into public.shares (id, owner_id, source_list_id, token, title) values
  ('c0280000-0000-4000-8000-0000000000d1', 'c0280000-0000-4000-8000-0000000000f1', 'c0280000-0000-4000-8000-0000000000a1', 'qa28Token0000000000000001', 'Помилки');
insert into public.share_items (share_id, item_id)
select 'c0280000-0000-4000-8000-0000000000d1'::uuid, id from public.items
 where list_id = 'c0280000-0000-4000-8000-0000000000a1' and not needs_title;

-- ═════════════════════════════════════════════
-- 1. Пошук: спецсимволи LIKE і ін'єкції
-- ═════════════════════════════════════════════

select tests.as_user('c0280000-0000-4000-8000-0000000000f1');

select is(tests.page_titles('лампа'), array['Лампа'], 'пошук без регістру — контрольна точка');
select lives_ok($$ select * from public.list_items_page('c0280000-0000-4000-8000-0000000000a1', 'title', false, 25, null, null,
                                                        $x$'; drop table public.items; --$x$) $$,
                'пошук з SQL-ін''єкцією — звичайний рядок, без помилки');
select is((select count(*)::int from public.items where list_id = 'c0280000-0000-4000-8000-0000000000a1'), 7,
          'після «ін''єкції» таблиця й рядки на місці');
select throws_ok($$ select * from public.list_items_page('c0280000-0000-4000-8000-0000000000a1',
                                                         'title; drop table public.items', false, 25) $$,
                 '22023', 'bad_sort', 'ін''єкція в сортування — bad_sort, не SQL');

select todo('BUG-QA-04: пошук трактує %, _ і \ як синтаксис LIKE, а клієнтський фільтр — ні', 4);
select is(tests.page_titles('50%'), array['Знижка 50%'], 'пошук «50%» — лише назва з «50%» буквально');
select is(tests.page_titles('_'), array['snake_case кружка'], 'пошук «_» — лише назва з підкресленням');
select is(tests.page_titles('%'), array['Знижка 50%'], 'пошук «%» — не всі позиції списку');
select is(tests.page_titles('C:\temp'), array['Шлях C:\temp'], 'пошук «C:\temp» знаходить назву зі зворотною скісною рискою');


-- ═════════════════════════════════════════════
-- 2. Посилання: «порожні» й чужі вибори, переміщення
-- ═════════════════════════════════════════════

select throws_ok($$ select public.create_share('c0280000-0000-4000-8000-0000000000a1', '{}'::uuid[], 'Порожнє') $$,
                 '22023', null, 'порожній масив позицій — помилка (контрольна точка)');
select throws_ok($$ select public.create_share('c0280000-0000-4000-8000-0000000000a3',
                                               array['c0280000-0000-4000-8000-0000000000c1']::uuid[], 'Чуже') $$,
                 '42501', null, 'посилання на чужий список — RLS');

select todo('BUG-QA-06: create_share створює живе порожнє посилання, коли жодна позиція не підходить', 3);
select throws_ok($$ select public.create_share('c0280000-0000-4000-8000-0000000000a1',
                                               array['c0280000-0000-4000-8000-0000000000c1']::uuid[], 'Лише чужі') $$,
                 '22023', null, 'лише чужі id — помилка, а не порожнє посилання');
select throws_ok($$ select public.create_share('c0280000-0000-4000-8000-0000000000a1',
                                               array[gen_random_uuid()], 'Вигадані') $$,
                 '22023', null, 'лише вигадані id — помилка, а не порожнє посилання');
select throws_ok($$ select public.create_share('c0280000-0000-4000-8000-0000000000a1',
                                               array['c0280000-0000-4000-8000-0000000000b7']::uuid[], 'Лише чернетка') $$,
                 '22023', null, 'лише чернетка — помилка, а не порожнє посилання');

-- Переміщення позиції в інший (приватний) список через API.
update public.items set list_id = 'c0280000-0000-4000-8000-0000000000a2'
 where id = 'c0280000-0000-4000-8000-0000000000b3';
select tests.as_anon();
select todo('BUG-QA-07: позиція, перенесена в інший список, лишається в посиланні старого', 1);
select ok(not ('Лампа' = any(tests.titles('qa28Token0000000000000001'))),
          'перенесена в приватний список «Лампа» більше не видна гостям старого посилання');

-- ═════════════════════════════════════════════
-- 3. Спільний лічильник спроб коду
-- ═════════════════════════════════════════════

select public.claim_item_v2('qa28Token0000000000000001', 'c0280000-0000-4000-8000-0000000000b1',
                            'qa28KeyHonestGuest000000', 1, 'Оля', 'olya@mail.com');
select tests.as_postgres();
create temp table honest_code as
select short_code from public.guest_identities
 where id = public.guest_identity_of('c0280000-0000-4000-8000-0000000000a1', 'qa28KeyHonestGuest000000');
grant select on honest_code to anon;
select tests.as_anon();

-- Хтось інший п'ять разів просить «надіслати код» на будь-яку адресу.
select public.send_guest_code('qa28Token0000000000000001', 'stranger' || g || '@mail.com') from generate_series(1, 5) g;
select todo('BUG-QA-03: чужі запити «надіслати код» блокують відновлення для всіх гостей списку', 1);
select is(public.redeem_guest_code('qa28Token0000000000000001', (select short_code from honest_code))->>'error', null,
          'чесний гість із правильним кодом не мав би отримати too_many_attempts');

-- ═════════════════════════════════════════════
-- 4. Невидимі й керівні символи в іменах
-- ═════════════════════════════════════════════

select throws_ok($$ select public.claim_item_v2('qa28Token0000000000000001', 'c0280000-0000-4000-8000-0000000000b6',
                                               'qa28KeyCtl0000000000000', 1, E'Оля\u0007') $$,
                 '22023', 'bad_name', 'керівний символ BEL в імені — bad_name (контрольна точка)');
select is(public.claim_item_v2('qa28Token0000000000000001', 'c0280000-0000-4000-8000-0000000000b6',
                               'qa28KeyEmoji000000000000', 1, '👨‍👩‍👧‍👦 Родина')->>'name', '👨‍👩‍👧‍👦 Родина',
          'емодзі з ZWJ в імені — дозволено');
select todo('BUG-QA-11: невидимі символи й керування напрямом тексту проходять у імена', 2);
select throws_ok($$ select public.claim_item_v2('qa28Token0000000000000001', 'c0280000-0000-4000-8000-0000000000b6',
                                               'qa28KeyZw00000000000000', 1, E'\u200B') $$,
                 '22023', 'bad_name', 'імʼя з одного пробілу нульової ширини — bad_name');
select throws_ok($$ select public.claim_item_v2('qa28Token0000000000000001', 'c0280000-0000-4000-8000-0000000000b6',
                                               'qa28KeyBidi000000000000', 1, E'Оля\u202Eлоцк') $$,
                 '22023', 'bad_name', 'імʼя з U+202E (RIGHT-TO-LEFT OVERRIDE) — bad_name');

-- ═════════════════════════════════════════════
-- 5. Мертві й зіпсовані токени
-- ═════════════════════════════════════════════

select throws_ok($$ select public.get_guest_list(null, null) $$, 'P0002', 'not_found', 'токен NULL — not_found');
select throws_ok($$ select public.get_guest_list('', null) $$, 'P0002', 'not_found', 'порожній токен — not_found');
select throws_ok($$ select public.get_guest_list(repeat('A', 100000), null) $$, 'P0002', 'not_found',
                 'токен на 100 000 символів — not_found, без падіння');
select throws_ok($$ select public.get_guest_list('qa28Token0000000000000001''; --', null) $$, 'P0002', 'not_found',
                 'токен з лапкою — not_found');
select is(public.get_share_card(repeat('A', 129)), null, 'картка: токен 129 символів — null без запиту');
select throws_ok($$ select public.claim_item_v2('qa28Token0000000000000001', null, 'qa28KeyNull0000000000000', 1) $$,
                 'P0002', 'item_not_in_share', 'id позиції NULL — item_not_in_share');
select throws_ok($$ select public.claim_item_v2('qa28Token0000000000000001', 'c0280000-0000-4000-8000-0000000000c1',
                                               'qa28KeyForeign0000000000', 1) $$,
                 'P0002', 'item_not_in_share', 'позиція чужого списку через своє посилання — item_not_in_share');

-- ═════════════════════════════════════════════
-- 6. Межі ємності: листи гостю, учасники збору
-- ═════════════════════════════════════════════

-- 12 броней одного гостя з поштою — листів у черзі не більше 10 за годину.
select public.claim_item_v2('qa28Token0000000000000001', 'c0280000-0000-4000-8000-0000000000b6',
                            'qa28KeyMailer00000000000', q, null, 'mailer@mail.com')
  from generate_series(1, 12) q;
select tests.as_postgres();
select is((select count(*)::int from public.guest_mail
            where identity_id = public.guest_identity_of('c0280000-0000-4000-8000-0000000000a1', 'qa28KeyMailer00000000000')),
          10, 'BVA черга листів гостю: 12 подій → рівно 10 листів за годину');

-- Збір: 50 учасників — межа; 51-й — pool_full; наявний учасник міняє суму й на межі.
select tests.as_anon();
create temp table full_pool as
select (public.start_pool('qa28Token0000000000000001', 'c0280000-0000-4000-8000-0000000000b5',
                          'qa28KeyOrganizer00000000', 'Оля', 'BLIK', 500)->>'pool_id')::uuid as id;
grant select on full_pool to anon;
select public.pledge_pool('qa28Token0000000000000001', (select id from full_pool),
                          'qa28KeyMember' || lpad(g::text, 11, '0'), 'Гість ' || g, 1)
  from generate_series(1, 50) g;
select throws_ok($$ select public.pledge_pool('qa28Token0000000000000001', (select id from full_pool),
                                             'qa28KeyMember00000000051', 'Гість 51', 1) $$,
                 '22023', 'pool_full', 'BVA учасники збору: 51-й — pool_full');
select lives_ok($$ select public.pledge_pool('qa28Token0000000000000001', (select id from full_pool),
                                            'qa28KeyMember00000000050', 'Гість 50', 2) $$,
                'BVA учасники збору: 50-й на повному зборі змінює суму');
select is((public.get_guest_list('qa28Token0000000000000001', null)->'items'
           -> (select (ord - 1)::int from jsonb_array_elements(public.get_guest_list('qa28Token0000000000000001', null)->'items')
                 with ordinality t(e, ord) where e->>'title' = 'Подарунок на 50 гостей')->'pool'->>'count')::int,
          50, 'гість без ключа бачить 50 учасників');

select * from finish();
rollback;
