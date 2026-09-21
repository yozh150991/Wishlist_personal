-- Варіанти позиції: форма значення і шлях до гостя (ADR-030).
--
-- Обмеження `items_variants_shape` — єдине, що стоїть між формою в браузері
-- та даними: воно перевіряється вбудованими операторами jsonpath, без власної
-- функції, тож помилка в одному рядку виразу тихо пропустила б сміття.
-- Звідси матриця значень нижче.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(19);

-- ── Дані ─────────────────────────────────────

insert into auth.users (id, email) values
  ('eeeeeeee-0000-4000-8000-000000000001', 'variants@test.local');

insert into public.lists (id, owner_id, title, currency) values
  ('eeeeeeee-0000-4000-8000-00000000000a', 'eeeeeeee-0000-4000-8000-000000000001', 'Варіанти', 'PLN');

insert into public.items (id, list_id, owner_id, title, status) values
  ('eeeeeeee-0000-4000-8000-0000000000c1', 'eeeeeeee-0000-4000-8000-00000000000a',
   'eeeeeeee-0000-4000-8000-000000000001', 'Светр', 'active');

-- Скорочує вставку до одного значення, яке й перевіряється.
create schema tests;
create function tests.put(p_variants jsonb) returns void language sql as $$
  insert into public.items (list_id, owner_id, title, variants)
  values ('eeeeeeee-0000-4000-8000-00000000000a',
          'eeeeeeee-0000-4000-8000-000000000001', 'проба', p_variants);
$$;

-- Той самий спосіб стати гостем, що і в 03: роль плюс порожні claims,
-- щоб auth.uid() повертала null, а не значення від попереднього тесту.
create function tests.as_anon() returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', '', true);
  perform set_config('role', 'anon', true);
end $$;

-- ── Значення за замовчуванням ────────────────

select is(
  (select variants from public.items where id = 'eeeeeeee-0000-4000-8000-0000000000c1'),
  '[]'::jsonb,
  'позиція без варіантів отримує порожній масив, а не null'
);

-- ── Що приймається ───────────────────────────

select lives_ok(
  $$ select tests.put('[{"label":"Розмір","value":"M"}]'::jsonb) $$,
  'одна пара'
);
select lives_ok(
  $$ select tests.put('[{"label":"Розмір","value":"M"},{"label":"Колір","value":"чорний"}]'::jsonb) $$,
  'дві пари'
);
select lives_ok(
  $$ select tests.put('[{"value":"M","label":"Розмір"}]'::jsonb) $$,
  'порядок ключів в обʼєкті не має значення'
);
select lives_ok(
  $$ select tests.put(jsonb_build_array(jsonb_build_object('label', repeat('x', 40), 'value', 'M'))) $$,
  'підпис рівно 40 символів'
);
select lives_ok(
  $$ select tests.put((select jsonb_agg(jsonb_build_object('label', 'п' || n, 'value', 'з'))
                         from generate_series(1, 5) n)) $$,
  'рівно пʼять пар'
);

-- ── Що відхиляється ──────────────────────────

select throws_ok(
  $$ select tests.put((select jsonb_agg(jsonb_build_object('label', 'п' || n, 'value', 'з'))
                         from generate_series(1, 6) n)) $$,
  '23514', null, 'шість пар — понад межу'
);
select throws_ok(
  $$ select tests.put('{"label":"Розмір","value":"M"}'::jsonb) $$,
  '23514', null, 'обʼєкт замість масиву'
);
select throws_ok(
  $$ select tests.put('["Розмір: M"]'::jsonb) $$,
  '23514', null, 'елемент — рядок, а не пара'
);
-- Саме тут потрібен режим `strict`: у `lax` вираз $[*] розгорнув би вкладений
-- масив і побачив обʼєкт.
select throws_ok(
  $$ select tests.put('[[{"label":"Розмір","value":"M"}]]'::jsonb) $$,
  '23514', null, 'вкладений масив не проходить як обʼєкт'
);
select throws_ok(
  $$ select tests.put('[{"label":"Розмір"}]'::jsonb) $$,
  '23514', null, 'пара без значення'
);
select throws_ok(
  $$ select tests.put('[{"label":"Розмір","value":"M","extra":"зайве"}]'::jsonb) $$,
  '23514', null, 'зайвий ключ в обʼєкті'
);
select throws_ok(
  $$ select tests.put('[{"label":"Розмір","value":42}]'::jsonb) $$,
  '23514', null, 'значення — число, а не рядок'
);
select throws_ok(
  $$ select tests.put('[{"label":"   ","value":"M"}]'::jsonb) $$,
  '23514', null, 'підпис із самих пробілів'
);
select throws_ok(
  $$ select tests.put(jsonb_build_array(jsonb_build_object('label', repeat('x', 41), 'value', 'M'))) $$,
  '23514', null, 'підпис 41 символ'
);
select throws_ok(
  $$ select tests.put(jsonb_build_array(jsonb_build_object('label', 'Розмір', 'value', repeat('x', 81)))) $$,
  '23514', null, 'значення 81 символ'
);
select throws_ok(
  $$ select tests.put('[{"label":"Розмір","value":"M\nL"}]'::jsonb) $$,
  '23514', null, 'перенос рядка у значенні'
);

-- ── Варіанти доходять до гостя ───────────────
--
-- Заради цього все й робиться: підпис на картці бачить той, хто дарує.

update public.items
   set variants = '[{"label":"Розмір","value":"M"}]'::jsonb
 where id = 'eeeeeeee-0000-4000-8000-0000000000c1';

insert into public.shares (id, owner_id, source_list_id, token, title, hide_prices) values
  ('eeeeeeee-0000-4000-8000-0000000000d1', 'eeeeeeee-0000-4000-8000-000000000001',
   'eeeeeeee-0000-4000-8000-00000000000a', 'variantsToken0000000000', 'Гостям', false),
  ('eeeeeeee-0000-4000-8000-0000000000d2', 'eeeeeeee-0000-4000-8000-000000000001',
   'eeeeeeee-0000-4000-8000-00000000000a', 'variantsNoPrices000000', 'Без цін', true);

insert into public.share_items (share_id, item_id) values
  ('eeeeeeee-0000-4000-8000-0000000000d1', 'eeeeeeee-0000-4000-8000-0000000000c1'),
  ('eeeeeeee-0000-4000-8000-0000000000d2', 'eeeeeeee-0000-4000-8000-0000000000c1');

select tests.as_anon();

select is(
  (select e->'variants' from jsonb_array_elements(
      public.get_shared_list('variantsToken0000000000')->'items') e limit 1),
  '[{"label":"Розмір","value":"M"}]'::jsonb,
  'get_shared_list віддає варіанти гостю'
);

-- Варіанти — не ціна: приховування цін їх не стосується.
select is(
  (select e->'variants' from jsonb_array_elements(
      public.get_shared_list('variantsNoPrices000000')->'items') e limit 1),
  '[{"label":"Розмір","value":"M"}]'::jsonb,
  'hide_prices не ховає варіанти'
);

reset role;

select * from finish();
rollback;
