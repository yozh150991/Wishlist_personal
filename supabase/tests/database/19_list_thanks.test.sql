-- Гостьова v2, крок 5д (ADR-059): «Подякувати гостям».
-- Подяку бачить кожен, хто відкрив живе посилання; лист — один раз, за першим
-- збереженням, лише тим гостям, які щось брали, лишили пошту й не відписались.
-- §3.2 — власник нічого не дізнається: thanks_sent_at ставиться однаково,
-- є кому писати чи ні, а скинути його й розіслати вдруге не можна.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(18);

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

-- Скільки листів подяки в черзі для цього списку — дивиться лише postgres.
create function tests.thanks_mail() returns integer language sql security definer as $$
  select count(*)::int
    from public.guest_mail m
    join public.guest_identities g on g.id = m.identity_id
   where m.kind = 'thanks' and g.list_id = 'a1911111-0000-4000-8000-00000000000a'
$$;

grant execute on all functions in schema tests to anon, authenticated;

insert into auth.users (id, email) values
  ('a1911111-0000-4000-8000-000000000001', 'owner19@test.local');

insert into public.lists (id, owner_id, title, currency, event_date) values
  ('a1911111-0000-4000-8000-00000000000a', 'a1911111-0000-4000-8000-000000000001', 'Річниця', 'PLN', current_date - 2),
  ('a1911111-0000-4000-8000-00000000000b', 'a1911111-0000-4000-8000-000000000001', 'Без гостей', 'PLN', current_date - 2);

insert into public.items (id, list_id, owner_id, title, price, quantity, status) values
  ('a1911111-0000-4000-8000-0000000000c1', 'a1911111-0000-4000-8000-00000000000a', 'a1911111-0000-4000-8000-000000000001', 'Книга',  80, 1, 'active'),
  ('a1911111-0000-4000-8000-0000000000c2', 'a1911111-0000-4000-8000-00000000000a', 'a1911111-0000-4000-8000-000000000001', 'Свічки', 30, 3, 'active'),
  ('a1911111-0000-4000-8000-0000000000c3', 'a1911111-0000-4000-8000-00000000000a', 'a1911111-0000-4000-8000-000000000001', 'Чай',    40, 1, 'active');

insert into public.shares (id, owner_id, source_list_id, token, title) values
  ('a1911111-0000-4000-8000-0000000000d1', 'a1911111-0000-4000-8000-000000000001', 'a1911111-0000-4000-8000-00000000000a', 'thanksToken000000000001', 'Річниця');

insert into public.share_items (share_id, item_id)
select 'a1911111-0000-4000-8000-0000000000d1'::uuid, id from public.items
 where list_id = 'a1911111-0000-4000-8000-00000000000a';

-- Гості: A — брав, лишив пошту (польська сторінка); B — брав без пошти;
-- C — брав із поштою, але відписався; D — лишив пошту, але бронь зняв.
select tests.as_anon();
select claim_item_v2('thanksToken000000000001', 'a1911111-0000-4000-8000-0000000000c1',
                     'thanksKeyAAAAAAAAAAAAAAA', 1, null, 'a19@pochta.ua', 'pl');
select claim_item_v2('thanksToken000000000001', 'a1911111-0000-4000-8000-0000000000c2',
                     'thanksKeyBBBBBBBBBBBBBBB', 1, null, null, 'uk');
select claim_item_v2('thanksToken000000000001', 'a1911111-0000-4000-8000-0000000000c3',
                     'thanksKeyCCCCCCCCCCCCCCC', 1, null, 'c19@pochta.ua', 'uk');
select claim_item_v2('thanksToken000000000001', 'a1911111-0000-4000-8000-0000000000c2',
                     'thanksKeyDDDDDDDDDDDDDDD', 1, null, 'd19@pochta.ua', 'uk');
select release_claim('thanksToken000000000001', 'a1911111-0000-4000-8000-0000000000c2', 'thanksKeyDDDDDDDDDDDDDDD');

select tests.as_postgres();
update public.guest_identities set mail_off = true
 where list_id = 'a1911111-0000-4000-8000-00000000000a' and email = 'c19@pochta.ua';
delete from public.guest_mail;

-- ── До подяки ────────────────────────────────

select tests.as_anon();
select ok(public.get_guest_list('thanksToken000000000001', null) ? 'thanks'
          and public.get_guest_list('thanksToken000000000001', null)->'thanks' = 'null'::jsonb,
          'поки подяки немає — thanks: null');

-- ── Власник дякує ────────────────────────────

select tests.as_user('a1911111-0000-4000-8000-000000000001');
select lives_ok(
  $$ update public.lists set thanks_message = 'Дякуємо, що були з нами!'
      where id = 'a1911111-0000-4000-8000-00000000000a' $$,
  'власник зберігає подяку');
select isnt((select thanks_sent_at from public.lists where id = 'a1911111-0000-4000-8000-00000000000a'), null,
            'thanks_sent_at поставлено');

select tests.as_postgres();
select is(tests.thanks_mail(), 1, 'лист лише одному: брав, лишив пошту, не відписався');
select is((select g.email from public.guest_mail m join public.guest_identities g on g.id = m.identity_id
            where m.kind = 'thanks'), 'a19@pochta.ua', 'лист — гостю A');
select is((select locale || '|' || (details->>'message') || '|' || share_id::text
             from public.guest_mail where kind = 'thanks'),
          'pl|Дякуємо, що були з нами!|a1911111-0000-4000-8000-0000000000d1',
          'мова гостя, текст знімком і живе посилання');

select tests.as_anon();
select is(public.get_guest_list('thanksToken000000000001', null)->>'thanks', 'Дякуємо, що були з нами!',
          'гість без ключа бачить подяку');
select is(public.get_guest_list('thanksToken000000000001', 'thanksKeyAAAAAAAAAAAAAAA')->>'thanks',
          'Дякуємо, що були з нами!', 'гість із ключем бачить подяку');
select is(public.get_guest_list('thanksToken000000000001', 'thanksKeyAAAAAAAAAAAAAAA')->'guest'->>'email',
          'a19@pochta.ua', 'решта відповіді гостя на місці');

select tests.as_user('a1911111-0000-4000-8000-000000000001');
select is(public.get_guest_list('thanksToken000000000001', null)->>'thanks', 'Дякуємо, що були з нами!',
          'власник на своєму посиланні бачить ту саму подяку');

-- ── Лише раз ─────────────────────────────────

create temp table sent_at as
select thanks_sent_at from public.lists where id = 'a1911111-0000-4000-8000-00000000000a';

update public.lists set thanks_message = 'Дякуємо всім від щирого серця!'
 where id = 'a1911111-0000-4000-8000-00000000000a';
update public.lists set thanks_sent_at = null where id = 'a1911111-0000-4000-8000-00000000000a';
update public.lists set thanks_message = null where id = 'a1911111-0000-4000-8000-00000000000a';
update public.lists set thanks_message = 'Ще раз дякуємо!' where id = 'a1911111-0000-4000-8000-00000000000a';

select is((select thanks_sent_at from public.lists where id = 'a1911111-0000-4000-8000-00000000000a'),
          (select thanks_sent_at from sent_at),
          'thanks_sent_at не скинути й не зсунути');

select tests.as_postgres();
select is(tests.thanks_mail(), 1, 'правки, прибирання й нова подяка листів удруге не шлють');

-- ── Межі тексту ──────────────────────────────

select tests.as_user('a1911111-0000-4000-8000-000000000001');
update public.lists set thanks_message = '   ' where id = 'a1911111-0000-4000-8000-00000000000a';
select is((select thanks_message from public.lists where id = 'a1911111-0000-4000-8000-00000000000a'), null,
          'самі пробіли — подяки немає');
select throws_ok(
  $$ update public.lists set thanks_message = repeat('я', 1001)
      where id = 'a1911111-0000-4000-8000-00000000000a' $$,
  '23514', null, 'понад 1000 символів — ні');

-- ── Однаково для списку без гостей ───────────

select lives_ok(
  $$ update public.lists set thanks_message = 'Дякую!' where id = 'a1911111-0000-4000-8000-00000000000b' $$,
  'подяка на списку без гостей зберігається так само');
select isnt((select thanks_sent_at from public.lists where id = 'a1911111-0000-4000-8000-00000000000b'), null,
            'thanks_sent_at ставиться й без жодного гостя — нічого не розкриває');

-- ── Новий список із подякою ──────────────────

insert into public.lists (id, owner_id, title, currency, thanks_message) values
  ('a1911111-0000-4000-8000-00000000000c', 'a1911111-0000-4000-8000-000000000001', 'Імпорт', 'PLN', 'Дякую');
select isnt((select thanks_sent_at from public.lists where id = 'a1911111-0000-4000-8000-00000000000c'), null,
            'новий список із подякою — позначка є, листів слати нікому');

select tests.as_postgres();
select has_trigger('public', 'lists', 'lists_thanks_mail', 'на lists стоїть тригер листів подяки');

select * from finish();
rollback;
