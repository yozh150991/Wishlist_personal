-- Перевірка посилань на товар (ADR-048).
-- Поля пише закритий сервіс wishlist-jobs (роль service_role), власник їх
-- лише читає разом із позицією. Заміна посилання скидає висновок, гостьова
-- відповідь цих полів не містить.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(8);

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
  ('a1111111-0000-4000-8000-000000000001', 'links-a@test.local');

insert into public.lists (id, owner_id, title) values
  ('a1111111-0000-4000-8000-00000000000a', 'a1111111-0000-4000-8000-000000000001', 'День народження');

insert into public.items (id, list_id, owner_id, title, url, price) values
  ('a1111111-0000-4000-8000-0000000000c1', 'a1111111-0000-4000-8000-00000000000a',
   'a1111111-0000-4000-8000-000000000001', 'Лампа', 'https://shop.ua/lampa', 1240);

select is((select link_status from items where id = 'a1111111-0000-4000-8000-0000000000c1'), 'unknown',
          'усталено посилання не перевірене — поведінка v1');

select throws_ok(
  $$ update items set link_status = 'broken' where id = 'a1111111-0000-4000-8000-0000000000c1' $$,
  '23514', null,
  'невідомий стан не записати'
);

-- Так пише сервіс перевірки: secret-ключ — роль service_role.
set local role service_role;
select lives_ok(
  $$ update items set link_status = 'ok', link_checked_at = now(), link_price = 1390, link_currency = 'UAH'
      where id = 'a1111111-0000-4000-8000-0000000000c1' $$,
  'сервіс перевірки записує висновок'
);
reset role;

select throws_ok(
  $$ update items set link_currency = 'uah' where id = 'a1111111-0000-4000-8000-0000000000c1' $$,
  '23514', null,
  'валюта — три великі літери'
);

select tests.as_user('a1111111-0000-4000-8000-000000000001');
update items set title = 'Керамічна лампа' where id = 'a1111111-0000-4000-8000-0000000000c1';
select is((select link_price from items where id = 'a1111111-0000-4000-8000-0000000000c1'), 1390.00::numeric,
          'зміна назви висновок перевірки не чіпає');

update items set url = 'https://shop.ua/lampa-2' where id = 'a1111111-0000-4000-8000-0000000000c1';
select is(
  (select row(link_status, link_checked_at, link_price, link_currency)::text from items
    where id = 'a1111111-0000-4000-8000-0000000000c1'),
  '(unknown,,,)',
  'нове посилання — висновок скинуто: він стосувався старої адреси'
);
reset role;

-- Гість не бачить нічого з перевірки.
insert into public.shares (id, owner_id, source_list_id, token, title) values
  ('a1111111-0000-4000-8000-0000000000d1', 'a1111111-0000-4000-8000-000000000001',
   'a1111111-0000-4000-8000-00000000000a', 'linksToken000000000000', 'Для родини');
insert into public.share_items (share_id, item_id) values
  ('a1111111-0000-4000-8000-0000000000d1', 'a1111111-0000-4000-8000-0000000000c1');
update items set link_status = 'gone', link_price = 1 where id = 'a1111111-0000-4000-8000-0000000000c1';

select tests.as_user('b1111111-0000-4000-8000-000000000001');
select is(
  (select count(*)::int
     from jsonb_array_elements(get_shared_list('linksToken000000000000')->'items') as t(e),
          jsonb_object_keys(e) as k
    where k like 'link%'),
  0,
  'у гостьовій відповіді немає жодного поля перевірки'
);
select is(
  jsonb_array_length(get_shared_list('linksToken000000000000')->'items'),
  1,
  'і позиція лишається видимою гостю: висновок перевірки нічого не ховає'
);
reset role;

select * from finish();
rollback;
