-- Історія ціни й своя ціль (ROADMAP 8.16).
-- Точки пише лише сервіс wishlist-jobs (service_role), читає лише власник
-- позиції; гість і чужий власник — нічого. Ціль — додатна, у межах
-- numeric(12,2); її стан (`price_target_set_at`, `price_target_hit_at`) веде
-- лише тригер: одне падіння до цілі — один привід для сповіщення.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(31);

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

insert into auth.users (id, email) values
  ('a3211111-0000-4000-8000-00000000000a', 'prices-a@test.local'),
  ('a3211111-0000-4000-8000-00000000000b', 'prices-b@test.local');

insert into public.lists (id, owner_id, title, currency) values
  ('a3211111-0000-4000-8000-0000000000aa', 'a3211111-0000-4000-8000-00000000000a', 'Свято', 'PLN');

insert into public.items (id, list_id, owner_id, title, url, price) values
  ('a3211111-0000-4000-8000-0000000000c1', 'a3211111-0000-4000-8000-0000000000aa',
   'a3211111-0000-4000-8000-00000000000a', 'Лампа', 'https://shop.pl/lampa', 200);

-- ── Ціль: усталено як досі ───────────────────

select is(
  (select row(price_target, price_target_set_at, price_target_hit_at)::text from items
    where id = 'a3211111-0000-4000-8000-0000000000c1'),
  '(,,)',
  'усталено цілі немає — поведінка, як досі'
);

select tests.as_user('a3211111-0000-4000-8000-00000000000a');

select throws_ok(
  $$ update items set price_target = 0 where id = 'a3211111-0000-4000-8000-0000000000c1' $$,
  '23514', null,
  'ціль 0 не записати: «ціна ≤ 0» нічого не означає'
);
select throws_ok(
  $$ update items set price_target = -5 where id = 'a3211111-0000-4000-8000-0000000000c1' $$,
  '23514', null,
  'від’ємну ціль не записати'
);
select throws_ok(
  $$ update items set price_target = 10000000000 where id = 'a3211111-0000-4000-8000-0000000000c1' $$,
  '22003', null,
  'ціль понад numeric(12,2) не записати'
);
select lives_ok(
  $$ update items set price_target = 9999999999.99 where id = 'a3211111-0000-4000-8000-0000000000c1' $$,
  'найбільша ціль numeric(12,2) записується'
);

update items set price_target = 150 where id = 'a3211111-0000-4000-8000-0000000000c1';
select isnt((select price_target_set_at from items where id = 'a3211111-0000-4000-8000-0000000000c1'), null,
            'задана ціль має час');
select is((select price_target_hit_at from items where id = 'a3211111-0000-4000-8000-0000000000c1'), null,
          'ціни з магазину ще немає — і досягнення немає');

-- Свої значення стану з клієнта тригер перетирає.
update items set price_target_hit_at = '2020-01-01', price_target_set_at = '2020-01-01'
 where id = 'a3211111-0000-4000-8000-0000000000c1';
select is(
  (select row(price_target_hit_at is null, price_target_set_at > '2021-01-01')::text from items
    where id = 'a3211111-0000-4000-8000-0000000000c1'),
  '(t,t)',
  'стан цілі з клієнта не підробити'
);
reset role;

-- ── Перевірка бачить ціну: падіння до цілі ───
-- Окремі транзакції не відкриєш, тож «час» стану ставимо назад вручну як
-- суперкористувач (тригер працює й тоді, тому вимикаємо його на мить).

alter table items disable trigger items_price_target_state;
update items set price_target_set_at = now() - interval '2 days'
 where id = 'a3211111-0000-4000-8000-0000000000c1';
alter table items enable trigger items_price_target_state;

set local role service_role;
update items set link_status = 'ok', link_price = 180, link_currency = 'PLN', link_checked_at = now()
 where id = 'a3211111-0000-4000-8000-0000000000c1';
select is((select price_target_hit_at from items where id = 'a3211111-0000-4000-8000-0000000000c1'), null,
          'ціна вища за ціль — не досягнуто');

update items set link_price = 149.99 where id = 'a3211111-0000-4000-8000-0000000000c1';
select ok(
  (select price_target_hit_at > price_target_set_at from items where id = 'a3211111-0000-4000-8000-0000000000c1'),
  'ціна впала до цілі — початок падіння пізніше за ціль: привід для сповіщення'
);

create temp table hit as select price_target_hit_at as at from items where id = 'a3211111-0000-4000-8000-0000000000c1';
grant select on hit to service_role, authenticated;

update items set link_price = 120 where id = 'a3211111-0000-4000-8000-0000000000c1';
select is((select price_target_hit_at from items where id = 'a3211111-0000-4000-8000-0000000000c1'), (select at from hit),
          'ще нижче — те саме падіння, другого сповіщення не буде');

update items set link_status = 'out', link_price = 300 where id = 'a3211111-0000-4000-8000-0000000000c1';
select is((select price_target_hit_at from items where id = 'a3211111-0000-4000-8000-0000000000c1'), (select at from hit),
          'немає в наявності — про ціну нічого певного, стан лишається');

update items set link_status = 'ok', link_price = 30, link_currency = 'EUR' where id = 'a3211111-0000-4000-8000-0000000000c1';
select is((select price_target_hit_at from items where id = 'a3211111-0000-4000-8000-0000000000c1'), (select at from hit),
          'ціна в іншій валюті з ціллю не порівнюється (ADR-051)');

update items set link_price = 151, link_currency = 'PLN' where id = 'a3211111-0000-4000-8000-0000000000c1';
select is((select price_target_hit_at from items where id = 'a3211111-0000-4000-8000-0000000000c1'), null,
          'ціна знову вища — стан знято: наступне падіння — нове сповіщення');

update items set link_price = 150 where id = 'a3211111-0000-4000-8000-0000000000c1';
select isnt((select price_target_hit_at from items where id = 'a3211111-0000-4000-8000-0000000000c1'), null,
            '«≤ X» включно: ціна, що дорівнює цілі, — досягнуто');
reset role;

-- ── Ціль, яку вже досягнуто, коли її задали ──

select tests.as_user('a3211111-0000-4000-8000-00000000000a');
update items set price_target = 160 where id = 'a3211111-0000-4000-8000-0000000000c1';
select is(
  (select price_target_hit_at = price_target_set_at from items where id = 'a3211111-0000-4000-8000-0000000000c1'),
  true,
  'нова ціль, якої ціна вже досягла: стан з моменту цілі — сповіщення не буде, людина бачить ціну у формі'
);

update items set price_target = null where id = 'a3211111-0000-4000-8000-0000000000c1';
select is(
  (select row(price_target_set_at, price_target_hit_at)::text from items where id = 'a3211111-0000-4000-8000-0000000000c1'),
  '(,)',
  'ціль прибрано — стану немає'
);
update items set price_target = 150 where id = 'a3211111-0000-4000-8000-0000000000c1';
reset role;

-- ── item_prices: пише сервіс, читає власник ──

set local role service_role;
select lives_ok(
  $$ insert into item_prices (item_id, day, price, currency)
     values ('a3211111-0000-4000-8000-0000000000c1', current_date - 1, 180, 'PLN'),
            ('a3211111-0000-4000-8000-0000000000c1', current_date, 150, 'PLN') $$,
  'сервіс перевірки пише точки'
);
select throws_ok(
  $$ insert into item_prices (item_id, day, price, currency)
     values ('a3211111-0000-4000-8000-0000000000c1', current_date, 140, 'PLN') $$,
  '23505', null,
  'одна точка на позицію на день'
);
select lives_ok(
  $$ insert into item_prices (item_id, day, price, currency)
     values ('a3211111-0000-4000-8000-0000000000c1', current_date, 140, 'PLN')
     on conflict (item_id, day) do update set price = excluded.price $$,
  'повтор у той самий день замінює точку'
);
select throws_ok(
  $$ insert into item_prices (item_id, day, price) values ('a3211111-0000-4000-8000-0000000000c1', current_date - 2, 0) $$,
  '23514', null,
  'ціна точки — додатна'
);
select throws_ok(
  $$ insert into item_prices (item_id, day, price, source) values ('a3211111-0000-4000-8000-0000000000c1', current_date - 3, 10, 'guess') $$,
  '23514', null,
  'джерело — лише відоме'
);
reset role;

select tests.as_user('a3211111-0000-4000-8000-00000000000a');
select is((select count(*)::int from item_prices), 2, 'власник бачить історію своєї позиції');
select throws_ok(
  $$ insert into item_prices (item_id, day, price) values ('a3211111-0000-4000-8000-0000000000c1', current_date - 5, 1) $$,
  '42501', null,
  'власник точок не пише — лише сервіс'
);
-- Без права на запис видалення мовчки нічого не робить або відмовляє — так чи так, точки цілі.
select throws_ok(
  $$ delete from item_prices $$,
  '42501', null,
  'власник точок не видаляє'
);
reset role;

select tests.as_user('a3211111-0000-4000-8000-00000000000b');
select is((select count(*)::int from item_prices), 0, 'чужий власник не бачить нічого (інваріант 1)');
reset role;

select tests.as_anon();
select throws_ok($$ select count(*) from item_prices $$, '42501', null, 'гість без акаунта не має доступу до історії');
reset role;

-- ── Нове посилання — нова історія ────────────

select tests.as_user('a3211111-0000-4000-8000-00000000000a');
update items set url = 'https://shop.pl/lampa-2' where id = 'a3211111-0000-4000-8000-0000000000c1';
select is((select count(*)::int from item_prices), 0, 'нове посилання стирає точки старого товару');
select is(
  (select price_target_hit_at from items where id = 'a3211111-0000-4000-8000-0000000000c1'),
  null,
  'і стан цілі теж: ціна старого товару вже нічого не каже'
);
reset role;

-- ── Видалення позиції — каскадом ─────────────

insert into item_prices (item_id, day, price) values ('a3211111-0000-4000-8000-0000000000c1', current_date, 99);
delete from items where id = 'a3211111-0000-4000-8000-0000000000c1';
select is((select count(*)::int from item_prices), 0, 'видалення позиції видаляє її історію');

-- ── Подія `target` у журналі сповіщень ───────

set local role service_role;
select lives_ok(
  $$ insert into notification_log (owner_id, kind, subject_id, occurrence)
     values ('a3211111-0000-4000-8000-00000000000a', 'target', gen_random_uuid(), '2026-12-03T03:15:00+00:00') $$,
  'сервіс записує надіслане про ціль'
);
reset role;

select * from finish();
rollback;
