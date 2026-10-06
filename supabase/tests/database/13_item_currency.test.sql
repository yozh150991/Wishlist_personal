-- Валюта на позиції й курс НБП (ADR-051).
-- Порожня валюта — валюта списку; гість отримує вже розгорнуту валюту
-- кожної позиції; сума v1 не складає злоті з євро; курс читає лише власник,
-- пише лише сервіс.

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

create table tests.created (token text);
grant all on tests.created to anon, authenticated;
grant execute on all functions in schema tests to anon, authenticated;

insert into auth.users (id, email) values
  ('a1311111-0000-4000-8000-000000000001', 'currency-a@test.local'),
  ('a1311111-0000-4000-8000-000000000002', 'currency-b@test.local');

insert into public.lists (id, owner_id, title, currency) values
  ('a1311111-0000-4000-8000-00000000000a', 'a1311111-0000-4000-8000-000000000001', 'Новий рік', 'PLN');

insert into public.items (id, list_id, owner_id, title, price, quantity) values
  ('a1311111-0000-4000-8000-0000000000c1', 'a1311111-0000-4000-8000-00000000000a',
   'a1311111-0000-4000-8000-000000000001', 'Чашка', 50, 2);

select is((select currency from items where id = 'a1311111-0000-4000-8000-0000000000c1'), null,
          'усталено валюти в позиції немає — це валюта списку, як у v1');

select throws_ok(
  $$ update items set currency = 'GBP' where id = 'a1311111-0000-4000-8000-0000000000c1' $$,
  '23514', null,
  'лише валюти, які знає застосунок'
);

select tests.as_user('a1311111-0000-4000-8000-000000000001');

insert into public.items (id, list_id, owner_id, title, price, currency) values
  ('a1311111-0000-4000-8000-0000000000c2', 'a1311111-0000-4000-8000-00000000000a',
   'a1311111-0000-4000-8000-000000000001', 'Навушники', 85, 'EUR'),
  ('a1311111-0000-4000-8000-0000000000c3', 'a1311111-0000-4000-8000-00000000000a',
   'a1311111-0000-4000-8000-000000000001', 'Книга', 40, 'PLN');

select is((select active_price from list_totals('a1311111-0000-4000-8000-00000000000a')), 140.00::numeric,
          'сума v1 — лише у валюті списку: 50 × 2 + 40, без 85 €');
select is((select items_count from list_totals('a1311111-0000-4000-8000-00000000000a')), 3,
          'кількість позицій рахує всі, і в іншій валюті теж');

insert into tests.created
select token from public.create_share('a1311111-0000-4000-8000-00000000000a',
  array['a1311111-0000-4000-8000-0000000000c1', 'a1311111-0000-4000-8000-0000000000c2']::uuid[], 'Для гостей');

select tests.as_anon();

select is(
  (select x->>'currency' from jsonb_array_elements(get_shared_list((select token from tests.created))->'items') x
    where x->>'id' = 'a1311111-0000-4000-8000-0000000000c2'),
  'EUR',
  'гість бачить валюту позиції'
);
select is(
  (select x->>'currency' from jsonb_array_elements(get_shared_list((select token from tests.created))->'items') x
    where x->>'id' = 'a1311111-0000-4000-8000-0000000000c1'),
  'PLN',
  'позиція без своєї валюти приходить гостю з валютою списку'
);
select is(get_shared_list((select token from tests.created))->>'currency', 'PLN',
          'валюта списку у відповіді лишилась на місці');

-- ── Курс НБП ────────────────────────────────

reset role;
set local role service_role;
select lives_ok(
  $$ insert into fx_rates (currency, pln_per_unit, rate_date) values ('EUR', 4.2765, '2026-10-05') $$,
  'сервіс записує курс'
);
select lives_ok(
  $$ insert into fx_rates (currency, pln_per_unit, rate_date) values ('EUR', 4.2801, '2026-10-06')
     on conflict (currency) do update set pln_per_unit = excluded.pln_per_unit, rate_date = excluded.rate_date $$,
  'сервіс оновлює курс наступного дня'
);
reset role;

select throws_ok(
  $$ insert into fx_rates (currency, pln_per_unit, rate_date) values ('PLN', 1, '2026-10-06') $$,
  '23514', null,
  'злотого в таблиці немає — для нього курс завжди 1'
);

select tests.as_user('a1311111-0000-4000-8000-000000000002');
select is((select pln_per_unit from fx_rates where currency = 'EUR'), 4.280100::numeric,
          'будь-який власник читає курс — він публічний');
select throws_ok(
  $$ update fx_rates set pln_per_unit = 1 where currency = 'EUR' $$,
  '42501', null,
  'власник курс не змінює'
);

select tests.as_anon();
select throws_ok(
  $$ select * from fx_rates $$,
  '42501', null,
  'гість курсу не читає — anon не має прав на жодну таблицю'
);

reset role;
select is(
  (select count(*)::int from pg_policies where tablename = 'fx_rates' and cmd <> 'SELECT'),
  0,
  'на курс немає політик запису для клієнтів'
);

select * from finish();
rollback;
