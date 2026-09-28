-- Вигляд: схеми смаку, висока контрастність, оформлення списку і що з цього
-- бачить гість (ADR-033, ADR-034).
--
-- Вугіль — не смак, а режим доступності: у profiles.scheme його бути не може,
-- у нього веде лише high_contrast. Гість бачить схему власника й відтінок
-- оформлення, але не контраст власника (це налаштування глядача) і не назву
-- оформлення (вона приватна).

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(21);

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
  ('a5a5a5a5-0000-4000-8000-000000000001', 'appearance-a@test.local'),
  ('b5b5b5b5-0000-4000-8000-000000000001', 'appearance-b@test.local');

-- Своє оформлення іншого власника — щоб перевірити, що на нього не можна послатися.
insert into public.appearances (id, owner_id, name, hue) values
  ('b5b5b5b5-0000-4000-8000-0000000000e1', 'b5b5b5b5-0000-4000-8000-000000000001', 'Чуже', 200);

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

-- ── Оформлення: власник ──────────────────────

select tests.as_user('a5a5a5a5-0000-4000-8000-000000000001');

select set_eq($$ select builtin_key from appearances where owner_id is null $$,
              array['birthday', 'wedding', 'housewarming'],
              'три вбудовані події видно кожному власникові');

select is((select count(*)::int from appearances where id = 'b5b5b5b5-0000-4000-8000-0000000000e1'), 0,
          'чуже оформлення не видно');

select lives_ok($$ insert into appearances (id, owner_id, name, hue)
                   values ('a5a5a5a5-0000-4000-8000-0000000000e1', 'a5a5a5a5-0000-4000-8000-000000000001', 'Мамин ювілей', 15) $$,
                'власник створює своє оформлення: назва + відтінок');

select throws_ok($$ insert into appearances (owner_id, name, hue)
                    values ('a5a5a5a5-0000-4000-8000-000000000001', repeat('я', 25), 15) $$,
                 '23514', null, 'назва довша за 24 символи не приймається');

select throws_ok($$ insert into appearances (owner_id, name, hue)
                    values ('a5a5a5a5-0000-4000-8000-000000000001', 'Свято 🎉', 15) $$,
                 '23514', null, 'емодзі в назві не приймається');

select throws_ok($$ insert into appearances (owner_id, name, hue)
                    values ('a5a5a5a5-0000-4000-8000-000000000001', 'Коло', 360) $$,
                 '23514', null, 'відтінок поза 0–359 не приймається');

select throws_ok($$ insert into appearances (owner_id, name, hue, source)
                    values (null, 'Своя вбудована', 10, 'builtin') $$,
                 '42501', null, 'вбудовану подію власник створити не може');

select lives_ok($$ update lists set appearance_id = '0a0a0a0a-0000-4000-8000-000000000002'
                    where id = 'a5a5a5a5-0000-4000-8000-00000000000a' $$,
                'вбудоване оформлення ставиться на свій список');

select throws_ok($$ update lists set appearance_id = 'b5b5b5b5-0000-4000-8000-0000000000e1'
                     where id = 'a5a5a5a5-0000-4000-8000-00000000000a' $$,
                 '42501', null, 'на чуже оформлення послатися не можна, навіть знаючи id');

select tests.as_anon();
select is((public.get_shared_list('appearanceToken00000000')->>'appearance_hue')::int, 75,
          'гість отримує відтінок оформлення');

select tests.as_user('a5a5a5a5-0000-4000-8000-000000000001');
update lists set appearance_id = 'a5a5a5a5-0000-4000-8000-0000000000e1'
 where id = 'a5a5a5a5-0000-4000-8000-00000000000a';

select tests.as_anon();
select ok(public.get_shared_list('appearanceToken00000000')::text !~ 'Мамин ювілей',
          'назва оформлення гостю не віддається — лише відтінок');
select throws_ok($$ select * from appearances $$, '42501', null, 'anon не читає оформлення напряму');

select tests.as_user('a5a5a5a5-0000-4000-8000-000000000001');
delete from appearances where id = 'a5a5a5a5-0000-4000-8000-0000000000e1';
select is((select appearance_id from lists where id = 'a5a5a5a5-0000-4000-8000-00000000000a'), null,
          'видалене оформлення лишає списку null, а не осиротілий id');

select tests.as_anon();
select is(public.get_shared_list('appearanceToken00000000')->'appearance_hue', 'null'::jsonb,
          'список без оформлення — гість бачить чисту схему власника');

select * from finish();
rollback;
