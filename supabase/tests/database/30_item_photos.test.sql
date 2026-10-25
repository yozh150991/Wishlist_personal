-- Своє фото позиції (ADR-073): адресу видає reserve_item_photo, завантажити
-- можна лише у свою видану адресу, ліміти рахує база, а прибирання файлів
-- без посилань — лише для service_role.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(19);

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

-- Видана адреса між викликами — у тимчасовій таблиці: \gset у pgTAP-файлі немає.
create table tests.paths (who text primary key, path text);
grant all on tests.paths to authenticated;

grant execute on all functions in schema tests to anon, authenticated;

insert into auth.users (id, email) values
  ('a3011111-0000-4000-8000-00000000000a', 'photo-a@test.local'),
  ('a3011111-0000-4000-8000-00000000000b', 'photo-b@test.local');

insert into public.lists (id, owner_id, title, currency) values
  ('a3011111-0000-4000-8000-0000000000aa', 'a3011111-0000-4000-8000-00000000000a', 'Фото', 'PLN');

-- ── Бакет ────────────────────────────────────

select is((select public from storage.buckets where id = 'item-photos'), true,
          'бакет item-photos публічний: фото читається за адресою, як і з магазину');
select is((select file_size_limit::bigint from storage.buckets where id = 'item-photos'), 2097152::bigint,
          'бакет приймає до 2 МБ');

-- ── Видача адреси ────────────────────────────

select tests.as_anon();
select throws_ok($$ select public.reserve_item_photo('webp') $$, '42501', null,
                 'гість без акаунта адреси не отримує');

select tests.as_user('a3011111-0000-4000-8000-00000000000a');
insert into tests.paths values ('a1', public.reserve_item_photo('webp'));
insert into tests.paths values ('a2', public.reserve_item_photo('jpg'));
select matches((select path from tests.paths where who = 'a1'), '^[0-9a-f]{32}\.webp$',
               'адреса — 32 випадкові шістнадцяткові символи й розширення');
select isnt((select path from tests.paths where who = 'a1'), (select path from tests.paths where who = 'a2'),
            'кожна адреса нова');
select throws_ok($$ select public.reserve_item_photo('png') $$, '22023', 'bad_request',
                 'розширення — лише webp чи jpg');

-- ── Завантаження ─────────────────────────────

select lives_ok(
  $$ insert into storage.objects (bucket_id, name, owner)
     values ('item-photos', (select path from tests.paths where who = 'a1'), auth.uid()) $$,
  'власник завантажує у свою видану адресу (owner — як ставить сервіс сховища)');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('item-photos', 'ffffffffffffffffffffffffffffffff.webp') $$,
  '42501', null, 'в адресу, якої ніхто не видавав, — ні');

select tests.as_user('a3011111-0000-4000-8000-00000000000b');
select is((select count(*)::int from public.item_photos), 0, 'чужих виданих адрес не видно');
select throws_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('item-photos', (select path from tests.paths where who = 'a2')) $$,
  '42501', null, 'у чужу видану адресу — ні');

select tests.as_anon();
select throws_ok(
  $$ insert into storage.objects (bucket_id, name)
     values ('item-photos', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee.webp') $$,
  '42501', null, 'гість нічого не завантажує');

-- ── Ліміти ───────────────────────────────────

select tests.as_postgres();
insert into public.item_photos (path, owner_id, created_at)
select replace(gen_random_uuid()::text, '-', '') || '.webp', 'a3011111-0000-4000-8000-00000000000a', now()
  from generate_series(1, 58);

select tests.as_user('a3011111-0000-4000-8000-00000000000a');
select throws_ok($$ select public.reserve_item_photo('webp') $$, 'P0001', 'photo_rate',
                 'шістдесят адрес за годину — далі photo_rate');

select tests.as_postgres();
update public.item_photos set created_at = now() - interval '2 hours'
 where owner_id = 'a3011111-0000-4000-8000-00000000000a';
insert into public.item_photos (path, owner_id, created_at)
select replace(gen_random_uuid()::text, '-', '') || '.webp', 'a3011111-0000-4000-8000-00000000000a', now() - interval '3 hours'
  from generate_series(1, 940);

select tests.as_user('a3011111-0000-4000-8000-00000000000a');
select throws_ok($$ select public.reserve_item_photo('webp') $$, 'P0001', 'photo_quota',
                 'тисяча фото на акаунт — далі photo_quota');

-- ── Прибирання ───────────────────────────────

select tests.as_postgres();
delete from public.item_photos
 where owner_id = 'a3011111-0000-4000-8000-00000000000a'
   and path not in (select path from tests.paths);
update public.item_photos set created_at = now() - interval '2 days';
insert into public.items (list_id, owner_id, title, image_url) values
  ('a3011111-0000-4000-8000-0000000000aa', 'a3011111-0000-4000-8000-00000000000a', 'З фото',
   'http://127.0.0.1:54321/storage/v1/object/public/item-photos/' || (select path from tests.paths where who = 'a1'));

select tests.as_user('a3011111-0000-4000-8000-00000000000a');
select throws_ok($$ select * from public.item_photo_orphans(10) $$, '42501', null,
                 'власник не викликає пошук сиріт');
select throws_ok($$ select public.forget_item_photos(array['x']) $$, '42501', null,
                 'і забування адрес — теж');

set local role service_role;
select results_eq($$ select * from public.item_photo_orphans(10) $$,
                  $$ select path from tests.paths where who = 'a2' $$,
                  'сирота — лише фото, на яке не посилається жодна позиція');
select public.forget_item_photos(array[(select path from tests.paths where who = 'a2')]);

select tests.as_postgres();
select is((select count(*)::int from public.item_photos), 1, 'забуто лише прибране');

-- Акаунт видалено — рядок лишається без власника, щоб файл прибрався.
-- Заодно: файл у сховищі з owner цього акаунта видаленню не заважає (ADR-072).
select lives_ok($$ delete from auth.users where id = 'a3011111-0000-4000-8000-00000000000a' $$,
                'акаунт із завантаженим фото видаляється');
select is((select count(*)::int from public.item_photos where owner_id is null), 1,
          'після видалення акаунта адреса лишається для прибирання');

select * from finish();
rollback;
