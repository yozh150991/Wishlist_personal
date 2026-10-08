-- Гостьова v2, крок 5б-2 (ADR-055): зміна чи видалення позиції, яку взяли
-- (потік J), і нагадування за 7 днів (P5).
-- §3.2 — власник править і видаляє як завжди: нічого не бачить, нічого не
--        дізнається, а «Змінено» отримує лише той гість, що взяв позицію.
-- Листи — лише з поштою й без відписки; правки поспіль зливаються в один;
-- зняв бронь — лист про зміну вже не піде; нагадування — один раз на дату.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(31);

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

-- Поле позиції у відповіді гостьової v2 з певним ключем.
create function tests.item(p_key text, p_item uuid) returns jsonb language sql as $$
  select e from jsonb_array_elements(public.get_guest_list('guestChangesToken000001', p_key)->'items') e
   where (e->>'id')::uuid = p_item
$$;

grant execute on all functions in schema tests to anon, authenticated;

-- ── Дані ─────────────────────────────────────
-- Власник O, список L із датою рівно через 7 днів за Варшавою.
-- c1 Кавоварка, c2 Тостер, c3 Ваза (ніхто не бере), c4 Келихи (2 шт.).
-- Гість A — з поштою й польською; гість B — без пошти.

insert into auth.users (id, email) values
  ('a1611111-0000-4000-8000-000000000001', 'owner16@test.local');

insert into public.lists (id, owner_id, title, currency, event_date) values
  ('a1611111-0000-4000-8000-00000000000a', 'a1611111-0000-4000-8000-000000000001', 'Новосілля', 'PLN',
   (now() at time zone 'Europe/Warsaw')::date + 7);

insert into public.items (id, list_id, owner_id, title, price, quantity, status) values
  ('a1611111-0000-4000-8000-0000000000c1', 'a1611111-0000-4000-8000-00000000000a', 'a1611111-0000-4000-8000-000000000001', 'Кавоварка', 900, 1, 'active'),
  ('a1611111-0000-4000-8000-0000000000c2', 'a1611111-0000-4000-8000-00000000000a', 'a1611111-0000-4000-8000-000000000001', 'Тостер',    200, 1, 'active'),
  ('a1611111-0000-4000-8000-0000000000c3', 'a1611111-0000-4000-8000-00000000000a', 'a1611111-0000-4000-8000-000000000001', 'Ваза',      150, 1, 'active'),
  ('a1611111-0000-4000-8000-0000000000c4', 'a1611111-0000-4000-8000-00000000000a', 'a1611111-0000-4000-8000-000000000001', 'Келихи',    50,  2, 'active');

insert into public.shares (id, owner_id, source_list_id, token, title, revoked_at) values
  ('a1611111-0000-4000-8000-0000000000d1', 'a1611111-0000-4000-8000-000000000001', 'a1611111-0000-4000-8000-00000000000a', 'guestChangesToken000001', 'Новосілля', null),
  ('a1611111-0000-4000-8000-0000000000d2', 'a1611111-0000-4000-8000-000000000001', 'a1611111-0000-4000-8000-00000000000a', 'guestChangesRevoked0001', 'Старе', now());

insert into public.share_items (share_id, item_id)
select 'a1611111-0000-4000-8000-0000000000d1'::uuid, id from public.items
 where list_id = 'a1611111-0000-4000-8000-00000000000a';

select tests.as_anon();
select claim_item_v2('guestChangesToken000001', 'a1611111-0000-4000-8000-0000000000c1',
                     'guestChangesKeyAAAAAAAAA', 1, 'Іра', 'ira16@pochta.ua', 'pl');
select claim_item_v2('guestChangesToken000001', 'a1611111-0000-4000-8000-0000000000c2',
                     'guestChangesKeyBBBBBBBBB', 1, null, null, 'uk');
reset role;
delete from guest_mail;

-- ── Незначна правка й чужа позиція — тиша ────

select tests.as_user('a1611111-0000-4000-8000-000000000001');
update items set note = 'Біла', priority = 'high' where id = 'a1611111-0000-4000-8000-0000000000c1';
update items set title = 'Скляна ваза' where id = 'a1611111-0000-4000-8000-0000000000c3';
reset role;

select is((select count(*)::int from guest_mail), 0, 'нотатка й пріоритет проходять мовчки; позиція без позначок — без листів');
select is((select count(*)::int from claims where changed_at is not null), 0, 'позначка «Змінено» — лише від значущої зміни');

-- ── J: значуща зміна ─────────────────────────

select tests.as_user('a1611111-0000-4000-8000-000000000001');
select lives_ok(
  $$ update items set title = 'Кавоварка Delonghi', price = 1290 where id = 'a1611111-0000-4000-8000-0000000000c1' $$,
  'власник змінює назву й ціну позиції, яку взяли, — як завжди'
);
select throws_ok($$ select changed_at from claims $$, '42501', null, 'власник не бачить позначок і «Змінено»');
reset role;

select is((select count(*)::int from guest_mail where kind = 'changed'), 1, 'гостю з поштою — лист про зміну');
select is((select locale from guest_mail where kind = 'changed'), 'pl', 'мовою його останньої броні');
select is((select details->'old'->>'title' from guest_mail where kind = 'changed'), 'Кавоварка', 'у листі — як було');
select is((select details->'new'->>'title' from guest_mail where kind = 'changed'), 'Кавоварка Delonghi', 'і як стало');

select tests.as_user('a1611111-0000-4000-8000-000000000001');
update items set price = 1390 where id = 'a1611111-0000-4000-8000-0000000000c1';
reset role;
select is((select count(*)::int from guest_mail where kind = 'changed'), 1, 'правки поспіль до відправки — один лист');
select is((select (details->'new'->>'price')::numeric from guest_mail where kind = 'changed'), 1390::numeric,
          '«стало» — з останньої правки');
select is((select details->'old'->>'title' from guest_mail where kind = 'changed'), 'Кавоварка',
          '«було» — з першої');

-- ── «Змінено» бачить лише той, хто взяв ──────

select tests.as_anon();
select is(tests.item('guestChangesKeyAAAAAAAAA', 'a1611111-0000-4000-8000-0000000000c1')->>'changed', 'true',
          'гість, що взяв позицію, бачить «Змінено»');
select ok(not (tests.item('guestChangesKeyBBBBBBBBB', 'a1611111-0000-4000-8000-0000000000c1') ? 'changed'),
          'інший гість — ні');
select ok(not (tests.item(null, 'a1611111-0000-4000-8000-0000000000c1') ? 'changed'),
          'гість без ключа — ні');

select tests.as_user('a1611111-0000-4000-8000-000000000001');
select ok(get_guest_list('guestChangesToken000001', 'guestChangesKeyAAAAAAAAA')::text !~ '"changed"',
          'власник навіть із ключем гостя «Змінено» не отримує');
select throws_ok(
  $$ select ack_claim_change('guestChangesToken000001', 'a1611111-0000-4000-8000-0000000000c1', 'guestChangesKeyAAAAAAAAA') $$,
  '22023', 'owner_cannot_reserve', 'власник не знімає «Змінено» за гостя'
);

-- ── «Лишити» ─────────────────────────────────

select tests.as_anon();
select ack_claim_change('guestChangesToken000001', 'a1611111-0000-4000-8000-0000000000c1', 'guestChangesKeyBBBBBBBBB');
select is(tests.item('guestChangesKeyAAAAAAAAA', 'a1611111-0000-4000-8000-0000000000c1')->>'changed', 'true',
          'чужий ключ «Змінено» не знімає');
select ack_claim_change('guestChangesToken000001', 'a1611111-0000-4000-8000-0000000000c1', 'guestChangesKeyAAAAAAAAA');
select ok(not (tests.item('guestChangesKeyAAAAAAAAA', 'a1611111-0000-4000-8000-0000000000c1') ? 'changed'),
          '«Лишити» знімає позначку');
select throws_ok(
  $$ select ack_claim_change('guestChangesRevoked0001', 'a1611111-0000-4000-8000-0000000000c1', 'guestChangesKeyAAAAAAAAA') $$,
  'P0002', 'not_found', 'мертве посилання — not_found'
);

-- ── Зняв бронь — лист про зміну не піде ──────

select release_claim('guestChangesToken000001', 'a1611111-0000-4000-8000-0000000000c1', 'guestChangesKeyAAAAAAAAA');
reset role;
select is((select count(*)::int from guest_mail where kind = 'changed' and sent_at is null), 0,
          'гість зняв бронь — лист про зміну, що чекав, прибрано');

-- ── Видалення позиції ────────────────────────

select tests.as_anon();
select claim_item_v2('guestChangesToken000001', 'a1611111-0000-4000-8000-0000000000c3',
                     'guestChangesKeyAAAAAAAAA', 1, null, null, 'pl');
reset role;
delete from guest_mail;

select tests.as_user('a1611111-0000-4000-8000-000000000001');
select lives_ok($$ delete from items where id = 'a1611111-0000-4000-8000-0000000000c3' $$,
                'власник видаляє позицію, яку взяли, — як завжди');
reset role;
select is((select details->>'title' from guest_mail where kind = 'deleted'), 'Скляна ваза',
          'гостю — лист про видалення з назвою знімком');
select is((select item_id from guest_mail where kind = 'deleted'), null::uuid,
          'лист про видалення не тримається за позицію, якої вже немає');

-- ── Відписка діє і тут ───────────────────────

select tests.as_anon();
select claim_item_v2('guestChangesToken000001', 'a1611111-0000-4000-8000-0000000000c4',
                     'guestChangesKeyAAAAAAAAA', 1, null, null, 'pl');
reset role;
select set_config('tests.mail_token',
  (select mail_token from guest_identities where email = 'ira16@pochta.ua'), true);
delete from guest_mail;

select tests.as_anon();
select guest_mail_set(current_setting('tests.mail_token'), false);
select tests.as_user('a1611111-0000-4000-8000-000000000001');
update items set title = 'Келихи для вина' where id = 'a1611111-0000-4000-8000-0000000000c4';
reset role;
select is((select count(*)::int from guest_mail), 0, 'відписаний гість листа про зміну не отримує');
select isnt((select changed_at from claims c join guest_identities g on g.id = c.identity_id
              where g.email = 'ira16@pochta.ua' and c.item_id = 'a1611111-0000-4000-8000-0000000000c4'),
            null, 'але «Змінено» на сторінці бачить');

select is(enqueue_guest_reminders(), 0, 'відписаному — і нагадування немає');

-- ── Нагадування за 7 днів ────────────────────

select tests.as_anon();
select guest_mail_set(current_setting('tests.mail_token'), true);
reset role;

select is(enqueue_guest_reminders(), 1, 'за 7 днів — нагадування гостю з поштою, у якого щось узято');
select is((select details->'items' from guest_mail where kind = 'reminder'), '["Келихи для вина"]'::jsonb,
          'що саме взято — знімком назв');
select is(enqueue_guest_reminders(), 0, 'на ту саму дату — один раз');

update lists set event_date = event_date + 1 where id = 'a1611111-0000-4000-8000-00000000000a';
delete from guest_mail;
select is(enqueue_guest_reminders(), 0, 'за 8 днів — ще ні');

select tests.as_user('a1611111-0000-4000-8000-000000000001');
select throws_ok($$ select enqueue_guest_reminders() $$, '42501', null, 'нагадування ставить лише розклад у базі');

select * from finish();
rollback;
