-- Гостьова v2, крок 5д (ADR-060): get_share_card — картка посилання в месенджері.
-- Віддає лише назву посилання, дату події й мову власника; мертве посилання —
-- null однаково для всіх причин; нічого не пише (ні перегляду, ні ідентичності).

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(9);

create schema tests;
grant usage on schema tests to anon, authenticated;

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

insert into auth.users (id, email) values
  ('a2011111-0000-4000-8000-000000000001', 'owner20@test.local');
update public.profiles set locale = 'pl' where id = 'a2011111-0000-4000-8000-000000000001';

insert into public.lists (id, owner_id, title, description, currency, event_date) values
  ('a2011111-0000-4000-8000-00000000000a', 'a2011111-0000-4000-8000-000000000001', 'Внутрішня назва списку',
   'Опис лише для власника', 'PLN', '2026-12-24');

insert into public.items (id, list_id, owner_id, title, price, quantity, status) values
  ('a2011111-0000-4000-8000-0000000000c1', 'a2011111-0000-4000-8000-00000000000a', 'a2011111-0000-4000-8000-000000000001', 'Годинник', 900, 1, 'active');

insert into public.shares (id, owner_id, source_list_id, token, title, revoked_at, expires_at) values
  ('a2011111-0000-4000-8000-0000000000d1', 'a2011111-0000-4000-8000-000000000001', 'a2011111-0000-4000-8000-00000000000a', 'cardToken00000000000001', 'Різдво в Кракові', null, null),
  ('a2011111-0000-4000-8000-0000000000d2', 'a2011111-0000-4000-8000-000000000001', 'a2011111-0000-4000-8000-00000000000a', 'cardRevoked000000000001', 'Старе', now(), null),
  ('a2011111-0000-4000-8000-0000000000d3', 'a2011111-0000-4000-8000-000000000001', 'a2011111-0000-4000-8000-00000000000a', 'cardExpired000000000001', 'Згасле', null, now() - interval '1 day');

insert into public.share_items (share_id, item_id) values
  ('a2011111-0000-4000-8000-0000000000d1', 'a2011111-0000-4000-8000-0000000000c1');

select tests.as_anon();

select is(public.get_share_card('cardToken00000000000001'),
          '{"title": "Різдво в Кракові", "event_date": "2026-12-24", "locale": "pl"}'::jsonb,
          'живе посилання — назва посилання, дата й мова власника, і більше нічого');
select ok(public.get_share_card('cardToken00000000000001')::text !~ 'Годинник|900|Внутрішня|Опис',
          'ні позицій, ні цін, ні внутрішньої назви чи опису списку');
select is(public.get_share_card('cardRevoked000000000001'), null, 'відкликане — null');
select is(public.get_share_card('cardExpired000000000001'), null, 'протерміноване — null');
select is(public.get_share_card('cardNoSuchToken00000001'), null, 'неіснуюче — null, так само');
select is(public.get_share_card(repeat('x', 500)), null, 'надто довгий токен — null без пошуку');
select is(public.get_share_card(null), null, 'без токена — null');

select tests.as_postgres();
select is((select view_count from public.shares where id = 'a2011111-0000-4000-8000-0000000000d1'), 0,
          'картка не рахується як перегляд');
select is((select count(*)::int from public.guest_identities
            where list_id = 'a2011111-0000-4000-8000-00000000000a'), 0,
          'картка не створює ідентичностей гостя');

select * from finish();
rollback;
