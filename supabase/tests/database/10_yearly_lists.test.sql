-- Щорічні свята (ADR-047).
-- Позначка «повторювати щороку» — звичайне поле списку власника: усталено
-- вимкнена, як у v1, і змінити її може лише власник.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(4);

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
  ('a1010101-0000-4000-8000-000000000001', 'yearly-a@test.local'),
  ('b1010101-0000-4000-8000-000000000001', 'yearly-b@test.local');

insert into public.lists (id, owner_id, title, event_date) values
  ('a1010101-0000-4000-8000-00000000000a', 'a1010101-0000-4000-8000-000000000001', 'День народження', '2026-10-18');

select is((select repeats_yearly from lists where id = 'a1010101-0000-4000-8000-00000000000a'), false,
          'усталено список не щорічний — поведінка v1');

select throws_ok(
  $$ update lists set repeats_yearly = null where id = 'a1010101-0000-4000-8000-00000000000a' $$,
  '23502', null,
  'позначка не буває порожньою'
);

select tests.as_user('b1010101-0000-4000-8000-000000000001');
update lists set repeats_yearly = true where id = 'a1010101-0000-4000-8000-00000000000a';
reset role;
select is((select repeats_yearly from lists where id = 'a1010101-0000-4000-8000-00000000000a'), false,
          'чужий список щорічним не зробити');

select tests.as_user('a1010101-0000-4000-8000-000000000001');
update lists set repeats_yearly = true where id = 'a1010101-0000-4000-8000-00000000000a';
reset role;
select is((select repeats_yearly from lists where id = 'a1010101-0000-4000-8000-00000000000a'), true,
          'власник вмикає «Повторювати щороку»');

select * from finish();
rollback;
