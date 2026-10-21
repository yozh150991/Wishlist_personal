-- QA-регресія за техніками тест-дизайну (ADR-069): класи еквівалентності (EP)
-- і граничні значення (BVA) для всього, що має межу в схемі чи RPC.
--
-- Кожна межа перевіряється трьома точками: остання допустима, перша
-- недопустима і, де має сенс, мінімальна. Відомі баги — `todo` з номером із
-- docs/QA_REPORT.md: набір лишається зеленим, а виправлення стає видно як
-- «TODO passed», після чого `todo` прибирається.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(87);

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

-- ── Дані ─────────────────────────────────────

insert into auth.users (id, email, email_confirmed_at) values
  ('c0250000-0000-4000-8000-0000000000f1', 'qa25-owner@test.local', now());

insert into public.lists (id, owner_id, title, currency) values
  ('c0250000-0000-4000-8000-0000000000a1', 'c0250000-0000-4000-8000-0000000000f1', 'QA межі', 'PLN');

-- Позиція на 3 штуки — межі бронювання; по одній позиції на кожен збір.
insert into public.items (id, list_id, owner_id, title, price, quantity) values
  ('c0250000-0000-4000-8000-0000000000b1', 'c0250000-0000-4000-8000-0000000000a1', 'c0250000-0000-4000-8000-0000000000f1', 'Тарілки', 30, 3),
  ('c0250000-0000-4000-8000-0000000000b2', 'c0250000-0000-4000-8000-0000000000a1', 'c0250000-0000-4000-8000-0000000000f1', 'Збір 1', 100, 1),
  ('c0250000-0000-4000-8000-0000000000b3', 'c0250000-0000-4000-8000-0000000000a1', 'c0250000-0000-4000-8000-0000000000f1', 'Збір 2', 100, 1),
  ('c0250000-0000-4000-8000-0000000000b4', 'c0250000-0000-4000-8000-0000000000a1', 'c0250000-0000-4000-8000-0000000000f1', 'Збір 3', 100, 1),
  ('c0250000-0000-4000-8000-0000000000b5', 'c0250000-0000-4000-8000-0000000000a1', 'c0250000-0000-4000-8000-0000000000f1', 'Збір 4', 100, 1),
  ('c0250000-0000-4000-8000-0000000000b6', 'c0250000-0000-4000-8000-0000000000a1', 'c0250000-0000-4000-8000-0000000000f1', 'Збір 5', 100, 1),
  ('c0250000-0000-4000-8000-0000000000b7', 'c0250000-0000-4000-8000-0000000000a1', 'c0250000-0000-4000-8000-0000000000f1', 'Імена', 10, 9);

insert into public.shares (id, owner_id, source_list_id, token, title) values
  ('c0250000-0000-4000-8000-0000000000d1', 'c0250000-0000-4000-8000-0000000000f1', 'c0250000-0000-4000-8000-0000000000a1', 'qa25Token0000000000000001', 'Межі'),
  ('c0250000-0000-4000-8000-0000000000d2', 'c0250000-0000-4000-8000-0000000000f1', 'c0250000-0000-4000-8000-0000000000a1', 'qa25Token0000000000000002', 'Скарги');

insert into public.share_items (share_id, item_id)
select 'c0250000-0000-4000-8000-0000000000d1'::uuid, id from public.items
 where list_id = 'c0250000-0000-4000-8000-0000000000a1';

-- ═════════════════════════════════════════════
-- 1. Довжини текстових полів власника (BVA)
-- ═════════════════════════════════════════════

select tests.as_user('c0250000-0000-4000-8000-0000000000f1');

-- lists.title: 1…120 після обрізання пробілів
select lives_ok($$ insert into public.lists (owner_id, title) values (auth.uid(), 'Я') $$,
                'BVA lists.title: 1 символ — мінімум');
select lives_ok($$ insert into public.lists (owner_id, title) values (auth.uid(), repeat('Л', 120)) $$,
                'BVA lists.title: 120 — остання допустима');
select throws_ok($$ insert into public.lists (owner_id, title) values (auth.uid(), repeat('Л', 121)) $$,
                 '23514', null, 'BVA lists.title: 121 — перша недопустима');
select throws_ok($$ insert into public.lists (owner_id, title) values (auth.uid(), '   ') $$,
                 '23514', null, 'EP lists.title: самі пробіли — порожня назва');

-- items.title: 1…200
select lives_ok($$ insert into public.items (list_id, title) values ('c0250000-0000-4000-8000-0000000000a1', repeat('П', 200)) $$,
                'BVA items.title: 200 — остання допустима');
select throws_ok($$ insert into public.items (list_id, title) values ('c0250000-0000-4000-8000-0000000000a1', repeat('П', 201)) $$,
                 '23514', null, 'BVA items.title: 201 — перша недопустима');

-- sections.title: 1…60
select lives_ok($$ insert into public.sections (list_id, title) values ('c0250000-0000-4000-8000-0000000000a1', repeat('Р', 60)) $$,
                'BVA sections.title: 60 — остання допустима');
select throws_ok($$ insert into public.sections (list_id, title) values ('c0250000-0000-4000-8000-0000000000a1', repeat('Р', 61)) $$,
                 '23514', null, 'BVA sections.title: 61 — перша недопустима');

-- items.note ≤ 1000, lists.description ≤ 2000
select lives_ok($$ insert into public.items (list_id, title, note) values ('c0250000-0000-4000-8000-0000000000a1', 'N', repeat('н', 1000)) $$,
                'BVA items.note: 1000 — остання допустима');
select throws_ok($$ insert into public.items (list_id, title, note) values ('c0250000-0000-4000-8000-0000000000a1', 'N', repeat('н', 1001)) $$,
                 '23514', null, 'BVA items.note: 1001 — перша недопустима');
select lives_ok($$ insert into public.lists (owner_id, title, description) values (auth.uid(), 'D', repeat('о', 2000)) $$,
                'BVA lists.description: 2000 — остання допустима');
select throws_ok($$ insert into public.lists (owner_id, title, description) values (auth.uid(), 'D', repeat('о', 2001)) $$,
                 '23514', null, 'BVA lists.description: 2001 — перша недопустима');

-- Посилання: ≤ 2048 і лише http(s)
select lives_ok($$ insert into public.items (list_id, title, url) values ('c0250000-0000-4000-8000-0000000000a1', 'U',
                      'https://shop.pl/' || repeat('a', 2048 - 16)) $$,
                'BVA items.url: 2048 — остання допустима');
select throws_ok($$ insert into public.items (list_id, title, url) values ('c0250000-0000-4000-8000-0000000000a1', 'U',
                      'https://shop.pl/' || repeat('a', 2049 - 16)) $$,
                 '23514', null, 'BVA items.url: 2049 — перша недопустима');
select throws_ok($$ insert into public.items (list_id, title, url) values ('c0250000-0000-4000-8000-0000000000a1', 'U', 'ftp://shop.pl/x') $$,
                 '23514', null, 'EP items.url: схема ftp — недопустимий клас');
select throws_ok($$ insert into public.items (list_id, title, url) values ('c0250000-0000-4000-8000-0000000000a1', 'U', 'javascript:alert(1)') $$,
                 '23514', null, 'EP items.url: javascript: — недопустимий клас');

-- Подяка гостям: 1…1000
select lives_ok($$ update public.lists set thanks_message = repeat('д', 1000) where id = 'c0250000-0000-4000-8000-0000000000a1' $$,
                'BVA lists.thanks_message: 1000 — остання допустима');
select throws_ok($$ update public.lists set thanks_message = repeat('д', 1001) where id = 'c0250000-0000-4000-8000-0000000000a1' $$,
                 '23514', null, 'BVA lists.thanks_message: 1001 — перша недопустима');
update public.lists set thanks_message = null where id = 'c0250000-0000-4000-8000-0000000000a1';

-- BUG-QA-05: межа рахується після btrim, тож пробіли довкола — безмежні.
select todo('BUG-QA-05: межа довжини назви не обмежує пробіли довкола', 2);
select throws_ok($$ insert into public.lists (owner_id, title) values (auth.uid(), repeat(' ', 5000) || 'x') $$,
                 '23514', null, 'BVA lists.title: 5001 символ (пробіли + «x») не мав би пройти');
select throws_ok($$ insert into public.items (list_id, title) values ('c0250000-0000-4000-8000-0000000000a1', 'x' || repeat(' ', 5000)) $$,
                 '23514', null, 'BVA items.title: 5001 символ (пробіли + «x») не мав би пройти');

-- ═════════════════════════════════════════════
-- 2. Числа: кількість і ціна (BVA), валюта (EP)
-- ═════════════════════════════════════════════

select throws_ok($$ insert into public.items (list_id, title, quantity) values ('c0250000-0000-4000-8000-0000000000a1', 'Q', 0) $$,
                 '23514', null, 'BVA items.quantity: 0 — нижче мінімуму');
select lives_ok($$ insert into public.items (list_id, title, quantity) values ('c0250000-0000-4000-8000-0000000000a1', 'Q', 1) $$,
                'BVA items.quantity: 1 — мінімум');
select lives_ok($$ insert into public.items (list_id, title, quantity) values ('c0250000-0000-4000-8000-0000000000a1', 'Q', 999) $$,
                'BVA items.quantity: 999 — максимум');
select throws_ok($$ insert into public.items (list_id, title, quantity) values ('c0250000-0000-4000-8000-0000000000a1', 'Q', 1000) $$,
                 '23514', null, 'BVA items.quantity: 1000 — вище максимуму');

select throws_ok($$ insert into public.items (list_id, title, price) values ('c0250000-0000-4000-8000-0000000000a1', 'P', -0.01) $$,
                 '23514', null, 'BVA items.price: −0,01 — нижче нуля');
select lives_ok($$ insert into public.items (list_id, title, price) values ('c0250000-0000-4000-8000-0000000000a1', 'P', 0) $$,
                'BVA items.price: 0 — мінімум');
select lives_ok($$ insert into public.items (list_id, title, price) values ('c0250000-0000-4000-8000-0000000000a1', 'P', 9999999999.99) $$,
                'BVA items.price: 9 999 999 999,99 — максимум numeric(12,2)');
select throws_ok($$ insert into public.items (list_id, title, price) values ('c0250000-0000-4000-8000-0000000000a1', 'P', 10000000000) $$,
                 '22003', null, 'BVA items.price: 10 000 000 000 — переповнення');

select lives_ok($$ insert into public.items (list_id, title, currency) values ('c0250000-0000-4000-8000-0000000000a1', 'C', 'UAH') $$,
                'EP items.currency: валюта з переліку');
select lives_ok($$ insert into public.items (list_id, title, currency) values ('c0250000-0000-4000-8000-0000000000a1', 'C', null) $$,
                'EP items.currency: NULL — валюта списку');
select throws_ok($$ insert into public.items (list_id, title, currency) values ('c0250000-0000-4000-8000-0000000000a1', 'C', 'GBP') $$,
                 '23514', null, 'EP items.currency: справжня, але не підтримана валюта');
select throws_ok($$ insert into public.items (list_id, title, currency) values ('c0250000-0000-4000-8000-0000000000a1', 'C', 'pln') $$,
                 '23514', null, 'EP items.currency: малі літери — інший клас');

-- ═════════════════════════════════════════════
-- 3. list_items_page: білі списки параметрів (EP)
-- ═════════════════════════════════════════════

select lives_ok($$ select * from public.list_items_page('c0250000-0000-4000-8000-0000000000a1', 'created_at', true, 10) $$,  'EP p_limit = 10');
select lives_ok($$ select * from public.list_items_page('c0250000-0000-4000-8000-0000000000a1', 'created_at', true, 25) $$,  'EP p_limit = 25');
select lives_ok($$ select * from public.list_items_page('c0250000-0000-4000-8000-0000000000a1', 'created_at', true, 50) $$,  'EP p_limit = 50');
select lives_ok($$ select * from public.list_items_page('c0250000-0000-4000-8000-0000000000a1', 'created_at', true, 100) $$, 'EP p_limit = 100');
select throws_ok($$ select * from public.list_items_page('c0250000-0000-4000-8000-0000000000a1', 'created_at', true, 9) $$,
                 '22023', 'bad_limit', 'BVA p_limit = 9 — поза білим списком');
select throws_ok($$ select * from public.list_items_page('c0250000-0000-4000-8000-0000000000a1', 'created_at', true, 101) $$,
                 '22023', 'bad_limit', 'BVA p_limit = 101 — поза білим списком');
select throws_ok($$ select * from public.list_items_page('c0250000-0000-4000-8000-0000000000a1', 'created_at', true, 0) $$,
                 '22023', 'bad_limit', 'EP p_limit = 0');

select todo('BUG-QA-10: p_limit = NULL проходить повз білий список', 1);
select throws_ok($$ select * from public.list_items_page('c0250000-0000-4000-8000-0000000000a1', 'created_at', true, null) $$,
                 '22023', 'bad_limit', 'EP p_limit = NULL мав би бути bad_limit, а не сторінкою без меж');

select lives_ok($$ select * from public.list_items_page('c0250000-0000-4000-8000-0000000000a1', 'title', false, 25) $$,    'EP p_sort = title');
select lives_ok($$ select * from public.list_items_page('c0250000-0000-4000-8000-0000000000a1', 'price', false, 25) $$,    'EP p_sort = price');
select lives_ok($$ select * from public.list_items_page('c0250000-0000-4000-8000-0000000000a1', 'priority', false, 25) $$, 'EP p_sort = priority');
select throws_ok($$ select * from public.list_items_page('c0250000-0000-4000-8000-0000000000a1', 'updated_at', true, 25) $$,
                 '22023', 'bad_sort', 'EP p_sort: справжня колонка поза білим списком');
select throws_ok($$ select * from public.list_items_page('c0250000-0000-4000-8000-0000000000a1', null, true, 25) $$,
                 '22023', 'bad_sort', 'EP p_sort = NULL');

-- ═════════════════════════════════════════════
-- 4. Бронювання: кількість і ключ гостя (BVA)
-- ═════════════════════════════════════════════

select tests.as_anon();

select is((public.claim_item_v2('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b1',
                                'qa25KeyGuestA00000000000', 3)->>'mine_qty')::int, 3,
          'BVA бронь: рівно стільки, скільки потрібно (3 з 3)');
select throws_ok($$ select public.claim_item_v2('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b1',
                                               'qa25KeyGuestB00000000000', 1) $$,
                 '22023', 'not_enough_left', 'BVA бронь: на одну більше за залишок (0 + 1)');
select is((public.claim_item_v2('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b1',
                                'qa25KeyGuestA00000000000', 2)->>'taken_qty')::int, 2,
          'зменшення своєї броні звільняє залишок');
select is((public.claim_item_v2('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b1',
                                'qa25KeyGuestB00000000000', 1)->>'taken_qty')::int, 3,
          'BVA бронь: залишок 1 — рівно 1');
select throws_ok($$ select public.claim_item_v2('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b1',
                                               'qa25KeyGuestB00000000000', 2) $$,
                 '22023', 'not_enough_left', 'BVA бронь: власна 1 → 2, коли інші вже тримають 2 з 3');
select throws_ok($$ select public.claim_item_v2('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b7',
                                               'qa25KeyGuestB00000000000', 0) $$,
                 '22023', 'bad_quantity', 'BVA кількість броні: 0');
select throws_ok($$ select public.claim_item_v2('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b7',
                                               'qa25KeyGuestB00000000000', -1) $$,
                 '22023', 'bad_quantity', 'BVA кількість броні: −1');
select throws_ok($$ select public.claim_item_v2('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b7',
                                               'qa25KeyGuestB00000000000', null) $$,
                 '22023', 'bad_quantity', 'EP кількість броні: NULL');

select todo('BUG-QA-09: кількість біля межі integer дає 22003 замість not_enough_left', 1);
select throws_ok($$ select public.claim_item_v2('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b1',
                                               'qa25KeyGuestC00000000000', 2147483647) $$,
                 '22023', 'not_enough_left', 'BVA кількість броні: 2 147 483 647 — та сама відповідь, що й на 4');

-- Ключ гостя: ^[A-Za-z0-9_-]{22,64}$
select throws_ok($$ select public.claim_item_v2('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b7', repeat('k', 21), 1) $$,
                 '22023', 'bad_key', 'BVA ключ гостя: 21 символ');
select lives_ok($$ select public.claim_item_v2('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b7', repeat('k', 22), 1) $$,
                'BVA ключ гостя: 22 символи — мінімум');
select lives_ok($$ select public.claim_item_v2('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b7', repeat('m', 64), 1) $$,
                'BVA ключ гостя: 64 символи — максимум');
select throws_ok($$ select public.claim_item_v2('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b7', repeat('n', 65), 1) $$,
                 '22023', 'bad_key', 'BVA ключ гостя: 65 символів');
select throws_ok($$ select public.claim_item_v2('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b7', repeat('k', 21) || '.', 1) $$,
                 '22023', 'bad_key', 'EP ключ гостя: символ поза base64url');

-- ═════════════════════════════════════════════
-- 5. Контакт гостя: ім'я ≤ 60, пошта ≤ 254 (BVA, EP)
-- ═════════════════════════════════════════════

select is(public.claim_item_v2('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b7',
                               'qa25KeyName600000000000', 1, repeat('І', 60))->>'name', repeat('І', 60),
          'BVA імʼя гостя: 60 — остання допустима');
select throws_ok($$ select public.claim_item_v2('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b7',
                                               'qa25KeyName610000000000', 1, repeat('І', 61)) $$,
                 '22023', 'bad_name', 'BVA імʼя гостя: 61 — перша недопустима');
select is(public.claim_item_v2('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b7',
                               'qa25KeyName620000000000', 1, '  ' || repeat('І', 60) || '  ')->>'name', repeat('І', 60),
          'BVA імʼя гостя: 60 + пробіли довкола — рахується обрізане');
select throws_ok($$ select public.claim_item_v2('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b7',
                                               'qa25KeyName630000000000', 1, E'Ім\nя') $$,
                 '22023', 'bad_name', 'EP імʼя гостя: керівний символ');

select is(public.claim_item_v2('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b7',
                               'qa25KeyMail254000000000', 1, null, repeat('a', 245) || '@mail.com')->>'email',
          repeat('a', 245) || '@mail.com', 'BVA пошта гостя: 254 — остання допустима');
select throws_ok($$ select public.claim_item_v2('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b7',
                                               'qa25KeyMail255000000000', 1, null, repeat('a', 246) || '@mail.com') $$,
                 '22023', 'bad_email', 'BVA пошта гостя: 255 — перша недопустима');
select throws_ok($$ select public.claim_item_v2('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b7',
                                               'qa25KeyMailNoDot0000000', 1, null, 'a@localhost') $$,
                 '22023', 'bad_email', 'EP пошта гостя: домен без крапки');
select is(public.claim_item_v2('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b7',
                               'qa25KeyMailCase00000000', 1, null, '  Anna@Mail.COM ')->>'email', 'anna@mail.com',
          'EP пошта гостя: регістр і пробіли нормалізуються');

-- ═════════════════════════════════════════════
-- 6. Спільний подарунок: ціль і внесок (BVA)
-- ═════════════════════════════════════════════

select isnt(public.start_pool('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b2',
                              'qa25KeyPool100000000000', 'Оля', 'BLIK', 0.01)->>'pool_id', null,
            'BVA ціль збору: 0,01 — мінімум');
select isnt(public.start_pool('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b3',
                              'qa25KeyPool200000000000', 'Оля', 'BLIK', 1000000)->>'pool_id', null,
            'BVA ціль збору: 1 000 000 — максимум');
select throws_ok($$ select public.start_pool('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b4',
                                            'qa25KeyPool300000000000', 'Оля', 'BLIK', 1000000.01) $$,
                 '22023', 'bad_goal', 'BVA ціль збору: 1 000 000,01');
select throws_ok($$ select public.start_pool('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b4',
                                            'qa25KeyPool300000000000', 'Оля', 'BLIK', 0) $$,
                 '22023', 'bad_goal', 'BVA ціль збору: 0');
select throws_ok($$ select public.start_pool('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b4',
                                            'qa25KeyPool300000000000', repeat('О', 61), 'BLIK', 10) $$,
                 '22023', 'bad_name', 'BVA імʼя організатора: 61');
select throws_ok($$ select public.start_pool('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b4',
                                            'qa25KeyPool300000000000', 'Оля', repeat('і', 501), 10) $$,
                 '22023', 'bad_instructions', 'BVA «як скинутися»: 501');

select todo('BUG-QA-02: ціль, що округлюється до 0,00, падає на check-обмеженні', 1);
select throws_ok($$ select public.start_pool('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b5',
                                            'qa25KeyPool400000000000', 'Оля', 'BLIK', 0.004) $$,
                 '22023', 'bad_goal', 'BVA ціль збору: 0,004 → bad_goal, а не 23514');

create temp table qa25_pool as
select (public.start_pool('qa25Token0000000000000001', 'c0250000-0000-4000-8000-0000000000b6',
                          'qa25KeyPool500000000000', 'Оля', 'BLIK', 500)->>'pool_id')::uuid as id;
grant select on qa25_pool to anon, authenticated;

select lives_ok($$ select public.pledge_pool('qa25Token0000000000000001', (select id from qa25_pool),
                                            'qa25KeyPledge1000000000', 'Ігор', 0.01) $$,
                'BVA внесок: 0,01 — мінімум');
select lives_ok($$ select public.pledge_pool('qa25Token0000000000000001', (select id from qa25_pool),
                                            'qa25KeyPledge2000000000', 'Ігор', 1000000) $$,
                'BVA внесок: 1 000 000 — максимум');
select throws_ok($$ select public.pledge_pool('qa25Token0000000000000001', (select id from qa25_pool),
                                             'qa25KeyPledge3000000000', 'Ігор', 1000000.01) $$,
                 '22023', 'bad_amount', 'BVA внесок: 1 000 000,01');
select throws_ok($$ select public.pledge_pool('qa25Token0000000000000001', (select id from qa25_pool),
                                             'qa25KeyPledge3000000000', 'Ігор', 0) $$,
                 '22023', 'bad_amount', 'BVA внесок: 0');
select throws_ok($$ select public.pledge_pool('qa25Token0000000000000001', (select id from qa25_pool),
                                             'qa25KeyPledge3000000000', 'Ігор', 'NaN'::numeric) $$,
                 '22023', 'bad_amount', 'EP внесок: NaN');

select todo('BUG-QA-01: внесок, що округлюється до 0,00, падає на check-обмеженні', 1);
select throws_ok($$ select public.pledge_pool('qa25Token0000000000000001', (select id from qa25_pool),
                                             'qa25KeyPledge4000000000', 'Ігор', 0.004) $$,
                 '22023', 'bad_amount', 'BVA внесок: 0,004 → bad_amount, а не 23514');

-- ═════════════════════════════════════════════
-- 7. Скарга: причина (EP) і коментар (BVA)
-- ═════════════════════════════════════════════

select lives_ok($$ select public.report_share('qa25Token0000000000000002', 'spam') $$,      'EP причина скарги: spam');
select lives_ok($$ select public.report_share('qa25Token0000000000000002', 'other', repeat('к', 1000)) $$,
                'BVA коментар скарги: 1000 — остання допустима');
select throws_ok($$ select public.report_share('qa25Token0000000000000002', 'other', repeat('к', 1001)) $$,
                 '22023', 'bad_comment', 'BVA коментар скарги: 1001');
select throws_ok($$ select public.report_share('qa25Token0000000000000002', 'SPAM') $$,
                 '22023', 'bad_reason', 'EP причина скарги: інший регістр — поза переліком');
select throws_ok($$ select public.report_share('qa25Token0000000000000002', null) $$,
                 '22023', 'bad_reason', 'EP причина скарги: NULL');
select lives_ok($$ select public.report_share('qa25Token0000000000000002', 'other', '   ') $$,
                'EP коментар із самих пробілів — як без коментаря');

select tests.as_postgres();
select is((select count(*)::int from public.share_reports where share_id = 'c0250000-0000-4000-8000-0000000000d2' and comment is null), 2,
          'коментар із пробілів зберігається як NULL');

select * from finish();
rollback;
