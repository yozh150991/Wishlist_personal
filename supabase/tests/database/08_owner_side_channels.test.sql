-- Побічні канали власника (ADR-038, CLAUDE.md §3.2).
-- Власник не має вирахувати позначки ні з відповіді release_claim, ні з
-- помилки при зміні ключа позиції чи списку; посилання не переписати на
-- інший список; код гостя — з криптографічного джерела й потрібної форми.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(11);

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
  ('a8a8a8a8-0000-4000-8000-000000000001', 'side-a@test.local'),
  ('b8b8b8b8-0000-4000-8000-000000000001', 'side-b@test.local');

insert into public.lists (id, owner_id, title) values
  ('a8a8a8a8-0000-4000-8000-00000000000a', 'a8a8a8a8-0000-4000-8000-000000000001', 'Весілля'),
  ('a8a8a8a8-0000-4000-8000-00000000000b', 'a8a8a8a8-0000-4000-8000-000000000001', 'Інший список A'),
  ('b8b8b8b8-0000-4000-8000-00000000000a', 'b8b8b8b8-0000-4000-8000-000000000001', 'Список B');

insert into public.items (id, list_id, owner_id, title) values
  ('a8a8a8a8-0000-4000-8000-0000000000c1', 'a8a8a8a8-0000-4000-8000-00000000000a', 'a8a8a8a8-0000-4000-8000-000000000001', 'Взяте'),
  ('a8a8a8a8-0000-4000-8000-0000000000c2', 'a8a8a8a8-0000-4000-8000-00000000000a', 'a8a8a8a8-0000-4000-8000-000000000001', 'Вільне');

insert into public.shares (id, owner_id, source_list_id, token, title) values
  ('a8a8a8a8-0000-4000-8000-0000000000d1', 'a8a8a8a8-0000-4000-8000-000000000001',
   'a8a8a8a8-0000-4000-8000-00000000000a', 'sideChannelsToken000000', 'Весілля');
insert into public.share_items (share_id, item_id) values
  ('a8a8a8a8-0000-4000-8000-0000000000d1', 'a8a8a8a8-0000-4000-8000-0000000000c1'),
  ('a8a8a8a8-0000-4000-8000-0000000000d1', 'a8a8a8a8-0000-4000-8000-0000000000c2');

-- Гість бере першу позицію.
select tests.as_anon();
select lives_ok(
  $$ select public.claim_item('sideChannelsToken000000', 'a8a8a8a8-0000-4000-8000-0000000000c1',
                              'side-channel-guest-key-01', 1) $$,
  'гість позначає позицію'
);

-- ── 1. release_claim ─────────────────────────

select tests.as_user('a8a8a8a8-0000-4000-8000-000000000001');

select throws_ok(
  $$ select public.release_claim('sideChannelsToken000000', 'a8a8a8a8-0000-4000-8000-0000000000c1', 'owner-has-no-key-000000') $$,
  '22023', 'owner_cannot_reserve', 'власник не отримує taken_qty з release_claim (взята позиція)'
);

select throws_ok(
  $$ select public.release_claim('sideChannelsToken000000', 'a8a8a8a8-0000-4000-8000-0000000000c2', 'owner-has-no-key-000000') $$,
  '22023', 'owner_cannot_reserve', '…і та сама відповідь на вільну'
);

-- ── 2. Незмінні ключі ────────────────────────
-- Та сама відмова для взятої й вільної позиції: інакше помилка зовнішнього
-- ключа claims видавала б позначку.

select throws_ok(
  $$ update items set id = gen_random_uuid() where id = 'a8a8a8a8-0000-4000-8000-0000000000c1' $$,
  '42501', 'immutable_column', 'id взятої позиції не змінити'
);

select throws_ok(
  $$ update items set id = gen_random_uuid() where id = 'a8a8a8a8-0000-4000-8000-0000000000c2' $$,
  '42501', 'immutable_column', 'id вільної позиції не змінити — відповідь та сама'
);

select throws_ok(
  $$ update lists set id = gen_random_uuid() where id = 'a8a8a8a8-0000-4000-8000-00000000000a' $$,
  '42501', 'immutable_column', 'id списку не змінити (на ньому ідентичності гостей)'
);

select lives_ok(
  $$ update items set title = 'Взяте, перейменоване', status = 'purchased'
      where id = 'a8a8a8a8-0000-4000-8000-0000000000c1' $$,
  'решта полів позиції змінюється як і раніше'
);

-- ── 3. Посилання не переписати на інший список ─

select throws_ok(
  $$ update shares set source_list_id = 'b8b8b8b8-0000-4000-8000-00000000000a'
      where id = 'a8a8a8a8-0000-4000-8000-0000000000d1' $$,
  '42501', 'immutable_column', 'посилання не переписати на чужий список'
);

select throws_ok(
  $$ update shares set source_list_id = 'a8a8a8a8-0000-4000-8000-00000000000b'
      where id = 'a8a8a8a8-0000-4000-8000-0000000000d1' $$,
  '42501', 'immutable_column', '…і на свій інший теж: гості побачили б інший набір під старим токеном'
);

select lives_ok(
  $$ update shares set revoked_at = now() where id = 'a8a8a8a8-0000-4000-8000-0000000000d1' $$,
  'відкликання працює як і раніше'
);

-- ── 4. Код гостя ─────────────────────────────

reset role;

select is(
  (select count(*)::int from generate_series(1, 200) g
    where public.gen_guest_code('a8a8a8a8-0000-4000-8000-00000000000a') ~ '^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{5}$'),
  200,
  'код — пʼять символів з алфавіту без схожих 0/O, 1/I/L'
);

select * from finish();
rollback;
