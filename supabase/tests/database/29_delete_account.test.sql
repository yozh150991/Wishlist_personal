-- Видалення акаунта (ADR-072): delete_my_account звіряє пароль, рахує
-- невдалі спроби й стирає рядок auth.users. Решта — каскад: списки,
-- позиції, розділи й посилання власника зникають, посилання стає мертвим
-- (not_found, як відкликане), а позначки гостей на його списках і черга
-- листів гостям — разом зі списками, без листа «список закрито». Позначки,
-- які ця людина сама лишила гостем на чужому списку, і скарги на її
-- посилання — лишаються.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(20);

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

-- O — той, хто видаляє акаунт; G — інша людина зі своїм списком;
-- N — акаунт без пароля (лише Google).
insert into auth.users (id, email, email_confirmed_at, encrypted_password) values
  ('a2911111-0000-4000-8000-00000000000f', 'owner29@test.local', now(),
   extensions.crypt('correct horse 29', extensions.gen_salt('bf'))),
  ('a2911111-0000-4000-8000-0000000000aa', 'galia29@test.local', now(),
   extensions.crypt('galia password 29', extensions.gen_salt('bf'))),
  ('a2911111-0000-4000-8000-0000000000bb', 'nopass29@test.local', now(), null);

insert into public.lists (id, owner_id, title, currency, event_date) values
  ('a2911111-0000-4000-8000-00000000000a', 'a2911111-0000-4000-8000-00000000000f', 'Мій день народження', 'PLN', current_date + 10),
  ('a2911111-0000-4000-8000-00000000000b', 'a2911111-0000-4000-8000-0000000000aa', 'Список Галі',         'PLN', current_date + 20);

insert into public.sections (id, list_id, title) values
  ('a2911111-0000-4000-8000-0000000000e1', 'a2911111-0000-4000-8000-00000000000a', 'Кухня');

insert into public.items (id, list_id, owner_id, title, price, quantity, status, section_id) values
  ('a2911111-0000-4000-8000-0000000000c1', 'a2911111-0000-4000-8000-00000000000a', 'a2911111-0000-4000-8000-00000000000f', 'Чайник', 150, 1, 'active', 'a2911111-0000-4000-8000-0000000000e1'),
  ('a2911111-0000-4000-8000-0000000000c2', 'a2911111-0000-4000-8000-00000000000a', 'a2911111-0000-4000-8000-00000000000f', 'Келихи',  20, 6, 'active', null),
  ('a2911111-0000-4000-8000-0000000000c3', 'a2911111-0000-4000-8000-00000000000b', 'a2911111-0000-4000-8000-0000000000aa', 'Книга',   60, 1, 'active', null);

insert into public.shares (id, owner_id, source_list_id, token, title) values
  ('a2911111-0000-4000-8000-0000000000d1', 'a2911111-0000-4000-8000-00000000000f', 'a2911111-0000-4000-8000-00000000000a', 'deleteMeToken0000000001', 'День народження'),
  ('a2911111-0000-4000-8000-0000000000d2', 'a2911111-0000-4000-8000-0000000000aa', 'a2911111-0000-4000-8000-00000000000b', 'galiaToken0000000000001', 'Галя');

insert into public.share_items (share_id, item_id) values
  ('a2911111-0000-4000-8000-0000000000d1', 'a2911111-0000-4000-8000-0000000000c1'),
  ('a2911111-0000-4000-8000-0000000000d1', 'a2911111-0000-4000-8000-0000000000c2'),
  ('a2911111-0000-4000-8000-0000000000d2', 'a2911111-0000-4000-8000-0000000000c3');

select vault.create_secret('https://guestmail.test.local/wake', 'guest_mail_url');
select vault.create_secret('test-wake-secret-0123456789abcdef', 'guest_mail_secret');

-- Гість бере чайник у O з поштою — у черзі з'являється лист про бронь.
-- O сам бере книгу в Галі зі своєю поштою, а «Я дарую» прив'язує бронь до
-- його акаунта (ADR-062). Хтось скаржиться на посилання O (ADR-061).
select tests.as_anon();
select claim_item_v2('deleteMeToken0000000001', 'a2911111-0000-4000-8000-0000000000c1',
                     'delGuestKeyAAAAAAAAAAAAA', 1, null, 'guest29@test.local', 'uk');
select claim_item_v2('galiaToken0000000000001', 'a2911111-0000-4000-8000-0000000000c3',
                     'delOwnerAsGuestBBBBBBBBB', 1, null, 'owner29@test.local', 'uk');
select report_share('deleteMeToken0000000001', 'spam', null, 'uk');

select tests.as_user('a2911111-0000-4000-8000-00000000000f');
select public.get_my_gifts();

select tests.as_postgres();
select is((select count(*)::int from public.guest_identities
            where user_id = 'a2911111-0000-4000-8000-00000000000f'),
          1, 'передумова: бронь O на списку Галі прив''язана до його акаунта');
select ok((select count(*) from public.guest_mail where share_id = 'a2911111-0000-4000-8000-0000000000d1') > 0,
          'передумова: у черзі є лист гостю O');

-- ── Хто може викликати ───────────────────────

select tests.as_anon();
select throws_ok($$ select public.delete_my_account('correct horse 29') $$, '42501', null,
                 'гість без акаунта функцію не викликає');

select tests.as_user('a2911111-0000-4000-8000-00000000000f');
select throws_ok($$ select count(*) from public.account_delete_attempts $$, '42501', null,
                 'журнал спроб власнику не видно');

-- ── Хибний пароль і ліміт ────────────────────

select is(public.delete_my_account('wrong horse'), 'wrong_password', 'хибний пароль — wrong_password');
select is(public.delete_my_account(''), 'wrong_password', 'порожній пароль — wrong_password');

select tests.as_postgres();
select is((select count(*)::int from public.lists where owner_id = 'a2911111-0000-4000-8000-00000000000f'),
          1, 'після хибного пароля нічого не стерто');
select is((select count(*)::int from public.account_delete_attempts), 2, 'обидві невдалі спроби записано');

select tests.as_user('a2911111-0000-4000-8000-00000000000f');
select public.delete_my_account('wrong horse');
select public.delete_my_account('wrong horse');
select public.delete_my_account('wrong horse');
select is(public.delete_my_account('correct horse 29'), 'too_many',
          'після п''яти невдалих за годину — too_many навіть із правильним паролем');

-- Минула година: старі спроби вже не рахуються.
select tests.as_postgres();
update public.account_delete_attempts set attempted_at = now() - interval '2 hours';

-- ── Акаунт без пароля ────────────────────────

select tests.as_user('a2911111-0000-4000-8000-0000000000bb');
select is(public.delete_my_account('anything'), 'no_password', 'акаунт без пароля — no_password');
select tests.as_postgres();
select is((select count(*)::int from auth.users where id = 'a2911111-0000-4000-8000-0000000000bb'),
          1, 'акаунт без пароля лишився');

-- ── Видалення ────────────────────────────────

select tests.as_user('a2911111-0000-4000-8000-00000000000f');
select is(public.delete_my_account('correct horse 29'), 'deleted', 'правильний пароль — deleted');

select tests.as_postgres();
select is((select count(*)::int from auth.users where id = 'a2911111-0000-4000-8000-00000000000f'),
          0, 'рядка auth.users більше немає');
select is(
  (select count(*)::int from public.lists    where owner_id = 'a2911111-0000-4000-8000-00000000000f')
  + (select count(*)::int from public.items    where owner_id = 'a2911111-0000-4000-8000-00000000000f')
  + (select count(*)::int from public.sections where owner_id = 'a2911111-0000-4000-8000-00000000000f')
  + (select count(*)::int from public.shares   where owner_id = 'a2911111-0000-4000-8000-00000000000f')
  + (select count(*)::int from public.profiles where id       = 'a2911111-0000-4000-8000-00000000000f')
  + (select count(*)::int from public.account_delete_attempts),
  0, 'списки, позиції, розділи, посилання, профіль і журнал спроб стерто');
select is(
  (select count(*)::int from public.claims where item_id in
     ('a2911111-0000-4000-8000-0000000000c1', 'a2911111-0000-4000-8000-0000000000c2'))
  + (select count(*)::int from public.guest_mail where share_id = 'a2911111-0000-4000-8000-0000000000d1'),
  0, 'позначки гостей на списках O і черга листів до них зникли разом зі списками');

select tests.as_anon();
select throws_ok($$ select public.get_guest_list('deleteMeToken0000000001', 'delGuestKeyAAAAAAAAAAAAA') $$,
                 'P0002', 'not_found', 'посилання O — мертве, як відкликане');

select tests.as_postgres();
select is((select count(*)::int from public.claims c
             join public.guest_identities g on g.id = c.identity_id
            where c.item_id = 'a2911111-0000-4000-8000-0000000000c3' and g.user_id is null),
          1, 'бронь O на списку Галі лишилась — уже без акаунта');
select is((select count(*)::int from public.items where list_id = 'a2911111-0000-4000-8000-00000000000b'),
          1, 'список Галі не зачеплено');
select is((select count(*)::int from public.share_reports where owner_id = 'a2911111-0000-4000-8000-00000000000f'),
          1, 'скарга на посилання O лишилась (ADR-061)');

select ok(
  (select p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres'
     from pg_proc p where p.oid = 'public.delete_my_account(text)'::regprocedure),
  'delete_my_account — SECURITY DEFINER від postgres');

select * from finish();
rollback;
