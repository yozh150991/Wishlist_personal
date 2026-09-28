-- Вигляд: схеми смаку, висока контрастність і що з цього бачить гість (ADR-033).
--
-- Вугіль — не смак, а режим доступності: у profiles.scheme його бути не може,
-- у нього веде лише high_contrast. Гість бачить схему власника, але не його
-- контраст: контраст — налаштування глядача, а не списку.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(7);

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
  ('a5a5a5a5-0000-4000-8000-000000000001', 'appearance-a@test.local');

insert into public.lists (id, owner_id, title, currency) values
  ('a5a5a5a5-0000-4000-8000-00000000000a', 'a5a5a5a5-0000-4000-8000-000000000001', 'Весілля', 'UAH');

insert into public.items (id, list_id, owner_id, title) values
  ('a5a5a5a5-0000-4000-8000-0000000000c1', 'a5a5a5a5-0000-4000-8000-00000000000a',
   'a5a5a5a5-0000-4000-8000-000000000001', 'Келихи');

insert into public.shares (id, owner_id, source_list_id, token, title) values
  ('a5a5a5a5-0000-4000-8000-0000000000d1', 'a5a5a5a5-0000-4000-8000-000000000001',
   'a5a5a5a5-0000-4000-8000-00000000000a', 'appearanceToken00000000', 'Оля та Богдан');

insert into public.share_items (share_id, item_id) values
  ('a5a5a5a5-0000-4000-8000-0000000000d1', 'a5a5a5a5-0000-4000-8000-0000000000c1');

-- ── Профіль ──────────────────────────────────

select tests.as_user('a5a5a5a5-0000-4000-8000-000000000001');

select is((select high_contrast from profiles where id = 'a5a5a5a5-0000-4000-8000-000000000001'),
          false, 'висока контрастність за замовчуванням вимкнена');

select lives_ok($$ update profiles set scheme = 'cytrus', high_contrast = true
                    where id = 'a5a5a5a5-0000-4000-8000-000000000001' $$,
                'власник обирає схему смаку й вмикає контраст');

select throws_ok($$ update profiles set scheme = 'vuhil'
                     where id = 'a5a5a5a5-0000-4000-8000-000000000001' $$,
                 '23514', null,
                 'Вугіль не можна записати як смак — лише через high_contrast');

select is((select scheme::text from profiles where id = 'a5a5a5a5-0000-4000-8000-000000000001'),
          'cytrus', 'контраст не перезаписує схему смаку');

-- ── Гість ────────────────────────────────────

select tests.as_anon();

select is(public.get_shared_list('appearanceToken00000000')->>'owner_scheme', 'cytrus',
          'гість отримує схему власника');

select ok(not (public.get_shared_list('appearanceToken00000000') ? 'high_contrast'),
          'контраст власника гостю не віддається: це налаштування глядача, а не списку');

select throws_ok($$ select * from profiles $$, '42501', null, 'anon не читає профілі напряму');

select * from finish();
rollback;
