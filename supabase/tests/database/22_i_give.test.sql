-- Дизайн v2, крок 6 (ADR-062): «Я дарую» для гостей з акаунтом.
-- Прив'язка — за підтвердженою поштою або бронею після входу; ніколи на
-- власних списках; «Я дарую» показує лише свої броні на чужих списках;
-- attach_guest_key відкриває свої броні на новому пристрої без коду.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(22);

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

grant execute on all functions in schema tests to anon, authenticated;

-- O — власник списку «Новосілля»; U — гість з акаунтом і підтвердженою поштою;
-- V — акаунт з непідтвердженою поштою.
insert into auth.users (id, email, email_confirmed_at) values
  ('a2211111-0000-4000-8000-00000000000f', 'owner22@test.local', now()),
  ('a2211111-0000-4000-8000-0000000000aa', 'ira22@test.local',   now()),
  ('a2211111-0000-4000-8000-0000000000bb', 'vova22@test.local',  null);

insert into public.lists (id, owner_id, title, currency, event_date) values
  ('a2211111-0000-4000-8000-00000000000a', 'a2211111-0000-4000-8000-00000000000f', 'Внутрішня назва', 'PLN', current_date + 10),
  ('a2211111-0000-4000-8000-00000000000b', 'a2211111-0000-4000-8000-0000000000aa', 'Список Іри',       'PLN', current_date + 20),
  ('a2211111-0000-4000-8000-00000000000c', 'a2211111-0000-4000-8000-00000000000f', 'Старе свято',      'PLN', current_date - 30);

insert into public.items (id, list_id, owner_id, title, price, quantity, status) values
  ('a2211111-0000-4000-8000-0000000000c1', 'a2211111-0000-4000-8000-00000000000a', 'a2211111-0000-4000-8000-00000000000f', 'Чайник', 150, 1, 'active'),
  ('a2211111-0000-4000-8000-0000000000c2', 'a2211111-0000-4000-8000-00000000000a', 'a2211111-0000-4000-8000-00000000000f', 'Келихи',  20, 6, 'active'),
  ('a2211111-0000-4000-8000-0000000000c3', 'a2211111-0000-4000-8000-00000000000a', 'a2211111-0000-4000-8000-00000000000f', 'Плед',   300, 1, 'active'),
  ('a2211111-0000-4000-8000-0000000000c4', 'a2211111-0000-4000-8000-00000000000b', 'a2211111-0000-4000-8000-0000000000aa', 'Книга',   60, 1, 'active'),
  ('a2211111-0000-4000-8000-0000000000c5', 'a2211111-0000-4000-8000-00000000000c', 'a2211111-0000-4000-8000-00000000000f', 'Лампа',   90, 1, 'active');

insert into public.shares (id, owner_id, source_list_id, token, title, hide_prices, revoked_at) values
  ('a2211111-0000-4000-8000-0000000000d1', 'a2211111-0000-4000-8000-00000000000f', 'a2211111-0000-4000-8000-00000000000a', 'giveToken00000000000001', 'Новосілля', true, null),
  ('a2211111-0000-4000-8000-0000000000d2', 'a2211111-0000-4000-8000-0000000000aa', 'a2211111-0000-4000-8000-00000000000b', 'giveOwnList000000000001', 'Мій день', false, null),
  ('a2211111-0000-4000-8000-0000000000d3', 'a2211111-0000-4000-8000-00000000000f', 'a2211111-0000-4000-8000-00000000000c', 'giveRevoked000000000001', 'Старе', false, null);

insert into public.share_items (share_id, item_id) values
  ('a2211111-0000-4000-8000-0000000000d1', 'a2211111-0000-4000-8000-0000000000c1'),
  ('a2211111-0000-4000-8000-0000000000d1', 'a2211111-0000-4000-8000-0000000000c2'),
  ('a2211111-0000-4000-8000-0000000000d1', 'a2211111-0000-4000-8000-0000000000c3'),
  ('a2211111-0000-4000-8000-0000000000d2', 'a2211111-0000-4000-8000-0000000000c4'),
  ('a2211111-0000-4000-8000-0000000000d3', 'a2211111-0000-4000-8000-0000000000c5');

-- ── Броні без входу ──────────────────────────
-- Іра бронює чайник анонімно, з поштою великими літерами; хтось — книгу в
-- списку самої Іри з її ж поштою; Вова — плед зі своєю непідтвердженою поштою.

select tests.as_anon();
select claim_item_v2('giveToken00000000000001', 'a2211111-0000-4000-8000-0000000000c1',
                     'giveKeyIraPhoneAAAAAAAAA', 1, null, 'IRA22@Test.Local', 'uk');
select claim_item_v2('giveOwnList000000000001', 'a2211111-0000-4000-8000-0000000000c4',
                     'giveKeyOtherBBBBBBBBBBBB', 1, null, 'ira22@test.local', 'uk');
select claim_item_v2('giveToken00000000000001', 'a2211111-0000-4000-8000-0000000000c3',
                     'giveKeyVovaCCCCCCCCCCCCC', 1, null, 'vova22@test.local', 'uk');
select claim_item_v2('giveRevoked000000000001', 'a2211111-0000-4000-8000-0000000000c5',
                     'giveKeyIraOldDDDDDDDDDDD', 1, null, 'ira22@test.local', 'uk');

select tests.as_postgres();
update public.shares set revoked_at = now() where id = 'a2211111-0000-4000-8000-0000000000d3';
select is((select count(*)::int from public.guest_identities where user_id is not null), 0,
          'анонімні броні до відкриття «Я дарую» ні до кого не прив''язані');

-- ── Іра відкриває «Я дарую» ──────────────────

select tests.as_user('a2211111-0000-4000-8000-0000000000aa');
select is(jsonb_array_length(public.get_my_gifts()), 1,
          'один список: чужий, з живим посиланням');
select is(public.get_my_gifts()->0->>'title', 'Новосілля', 'назва посилання, не внутрішня назва списку');
select is(public.get_my_gifts()->0->>'token', 'giveToken00000000000001', 'адреса живого посилання');
select is(public.get_my_gifts()->0->'items'->0->>'title', 'Чайник', 'бронь за поштою (без урахування регістру)');
select is(public.get_my_gifts()->0->'items'->0->'price', 'null'::jsonb, 'посилання ховає ціни — і тут без ціни');
select isnt(public.get_my_gifts()->0->>'code', null, 'код гостя є');

select tests.as_postgres();
select is((select count(*)::int from public.guest_identities g
            join public.lists l on l.id = g.list_id
           where g.user_id = 'a2211111-0000-4000-8000-0000000000aa' and l.owner_id = 'a2211111-0000-4000-8000-0000000000aa'), 0,
          'бронь у власному списку Іри до її акаунта не прив''язана (ADR-040, п. 3)');
select is((select count(*)::int from public.guest_identities where user_id = 'a2211111-0000-4000-8000-0000000000aa'), 2,
          'прив''язано й ідентичність на мертвому посиланні — але показу немає');

-- ── Непідтверджена пошта ─────────────────────

select tests.as_user('a2211111-0000-4000-8000-0000000000bb');
select is(public.get_my_gifts(), '[]'::jsonb, 'непідтверджена пошта нічого не прив''язує');

-- ── Бронь після входу — одразу ───────────────

select tests.as_user('a2211111-0000-4000-8000-0000000000aa');
select claim_item_v2('giveToken00000000000001', 'a2211111-0000-4000-8000-0000000000c2',
                     'giveKeyIraLaptopEEEEEEEE', 2, null, null, 'uk');
select tests.as_postgres();
select is((select g.user_id from public.claims c join public.guest_identities g on g.id = c.identity_id
            where c.item_id = 'a2211111-0000-4000-8000-0000000000c2'),
          'a2211111-0000-4000-8000-0000000000aa'::uuid, 'бронь після входу прив''язана тригером одразу');

select tests.as_user('a2211111-0000-4000-8000-0000000000aa');
select is(jsonb_array_length(public.get_my_gifts()), 1, 'дві ідентичності в одному списку — одна картка');
select is(jsonb_array_length(public.get_my_gifts()->0->'items'), 2, 'позиції з обох — разом');
select is((select e->>'mine_qty' from jsonb_array_elements(public.get_my_gifts()->0->'items') e
            where e->>'title' = 'Келихи'), '2', 'кількість своєї броні');

-- ── Новий пристрій без коду ──────────────────

select is(public.attach_guest_key('giveToken00000000000001', 'giveKeyIraTabletFFFFFFFF'), true,
          'attach_guest_key: ключ планшета додано до своєї ідентичності');
select tests.as_anon();
select ok((select (e->>'mine_qty')::int > 0
             from jsonb_array_elements(public.get_guest_list('giveToken00000000000001', 'giveKeyIraTabletFFFFFFFF')->'items') e
            where e->>'title' in ('Чайник', 'Келихи') limit 1),
          'гостьова з ключем планшета бачить броні Іри');

select tests.as_user('a2211111-0000-4000-8000-0000000000aa');
select is(public.attach_guest_key('giveToken00000000000001', 'giveKeyVovaCCCCCCCCCCCCC'), false,
          'чужий ключ не перехоплюється');
select tests.as_user('a2211111-0000-4000-8000-0000000000bb');
select is(public.attach_guest_key('giveToken00000000000001', 'giveKeyVovaNewGGGGGGGGGG'), false,
          'без прив''язаних броней — false, ключ не додано');
select tests.as_user('a2211111-0000-4000-8000-00000000000f');
select is(public.attach_guest_key('giveToken00000000000001', 'giveKeyOwnerHHHHHHHHHHHH'), false,
          'власник на своєму посиланні — false');
select is(public.get_my_gifts(), '[]'::jsonb, 'власник у «Я дарую» своїх списків не бачить');
select tests.as_anon();
select throws_ok($$ select public.attach_guest_key('giveToken00000000000001', 'giveKeyAnonIIIIIIIIIIIII') $$,
                 '42501', null, 'гість без акаунта attach_guest_key не викликає');

-- ── Видалення акаунта ────────────────────────

select tests.as_postgres();
delete from auth.users where id = 'a2211111-0000-4000-8000-0000000000aa';
select is((select count(*)::int from public.claims where item_id = 'a2211111-0000-4000-8000-0000000000c1'), 1,
          'видалення акаунта гостя не знімає його броні в чужих списках');

select * from finish();
rollback;
