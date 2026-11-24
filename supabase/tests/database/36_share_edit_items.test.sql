-- Зима, пункт 8.9: змінити склад опублікованої добірки (edit_share_items,
-- тригер share_items_unshared).
-- §3.3 — гість бачить лише позиції з набору посилання, нову — за старим URL.
-- §3.2 — власник змінює лише своє посилання; відповідь і помилки однакові, є
--        броні чи ні; прибрана позиція знімає бронь лише тоді, коли її вже не
--        видно за жодним живим посиланням списку, і ставить лист у чергу.
-- Броні не губляться: невдала зміна (no_items) відкочує й зняття броні, а
-- відкликання чи видалення посилання цілком броней не чіпає, як і досі.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(37);

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

-- Ідентифікатори позицій, які гість бачить за токеном.
create function tests.guest_ids(p_token text) returns uuid[] language sql security definer as $$
  select coalesce(array_agg((e->>'id')::uuid order by e->>'id'), '{}')
    from jsonb_array_elements(public.get_guest_list(p_token, null)->'items') e
$$;

-- Поле позиції у відповіді гостьової з певним ключем.
create function tests.item(p_token text, p_key text, p_item uuid) returns jsonb language sql security definer as $$
  select e from jsonb_array_elements(public.get_guest_list(p_token, p_key)->'items') e
   where (e->>'id')::uuid = p_item
$$;

create function tests.claims_on(p_item uuid) returns integer language sql security definer as $$
  select count(*)::int from public.claims where item_id = p_item
$$;

create function tests.mail(p_kind text) returns table (email text, details jsonb, share_id uuid, item_id uuid)
language sql security definer as $$
  select g.email, m.details, m.share_id, m.item_id
    from public.guest_mail m join public.guest_identities g on g.id = m.identity_id
   where m.kind = p_kind
   order by m.created_at, g.email
$$;

create function tests.pool_of(p_item uuid) returns uuid language sql security definer as $$
  select id from public.gift_pools where item_id = p_item
$$;

-- Відповідь власника як текст: void → «<void>», виняток → його код і текст.
create function tests.owner_answer(p_share uuid, p_add uuid[], p_remove uuid[]) returns text language plpgsql as $$
begin
  perform public.edit_share_items(p_share, p_add, p_remove);
  return '<void>';
exception when others then
  return sqlstate || ':' || sqlerrm;
end $$;

grant execute on all functions in schema tests to anon, authenticated;

-- ── Дані ─────────────────────────────────────
-- Власник O, список L: c1 Кавоварка, c2 Тостер, c3 Ваза, c4 Плед (для збору),
-- c5 Лампа (поза посиланнями), c6 — чернетка. Чужий власник X зі своєю
-- позицією x1.
-- Посилання O: d1 живе (c1–c4), d2 живе (c2), d3 відкликане (c3).

insert into auth.users (id, email, email_confirmed_at) values
  ('a3611111-0000-4000-8000-00000000000f', 'owner36@test.local', now()),
  ('a3611111-0000-4000-8000-0000000000ff', 'other36@test.local', now());

insert into public.lists (id, owner_id, title, currency) values
  ('a3611111-0000-4000-8000-00000000000a', 'a3611111-0000-4000-8000-00000000000f', 'Новосілля', 'PLN'),
  ('a3611111-0000-4000-8000-0000000000aa', 'a3611111-0000-4000-8000-0000000000ff', 'Чужий', 'PLN');

insert into public.items (id, list_id, owner_id, title, price, quantity, status) values
  ('a3611111-0000-4000-8000-0000000000c1', 'a3611111-0000-4000-8000-00000000000a', 'a3611111-0000-4000-8000-00000000000f', 'Кавоварка', 900, 1, 'active'),
  ('a3611111-0000-4000-8000-0000000000c2', 'a3611111-0000-4000-8000-00000000000a', 'a3611111-0000-4000-8000-00000000000f', 'Тостер',    200, 1, 'active'),
  ('a3611111-0000-4000-8000-0000000000c3', 'a3611111-0000-4000-8000-00000000000a', 'a3611111-0000-4000-8000-00000000000f', 'Ваза',      150, 1, 'active'),
  ('a3611111-0000-4000-8000-0000000000c4', 'a3611111-0000-4000-8000-00000000000a', 'a3611111-0000-4000-8000-00000000000f', 'Плед',      300, 1, 'active'),
  ('a3611111-0000-4000-8000-0000000000c5', 'a3611111-0000-4000-8000-00000000000a', 'a3611111-0000-4000-8000-00000000000f', 'Лампа',     120, 1, 'active'),
  ('a3611111-0000-4000-8000-0000000000e1', 'a3611111-0000-4000-8000-0000000000aa', 'a3611111-0000-4000-8000-0000000000ff', 'Чуже',      10,  1, 'active');

insert into public.items (id, list_id, owner_id, title, quantity, status, needs_title) values
  ('a3611111-0000-4000-8000-0000000000c6', 'a3611111-0000-4000-8000-00000000000a', 'a3611111-0000-4000-8000-00000000000f', 'shop.ua/lampa', 1, 'active', true);

insert into public.shares (id, owner_id, source_list_id, token, title, revoked_at) values
  ('a3611111-0000-4000-8000-0000000000d1', 'a3611111-0000-4000-8000-00000000000f', 'a3611111-0000-4000-8000-00000000000a', 'shareEditToken00000001', 'Новосілля', null),
  ('a3611111-0000-4000-8000-0000000000d2', 'a3611111-0000-4000-8000-00000000000f', 'a3611111-0000-4000-8000-00000000000a', 'shareEditToken00000002', 'Для колег', null),
  ('a3611111-0000-4000-8000-0000000000d3', 'a3611111-0000-4000-8000-00000000000f', 'a3611111-0000-4000-8000-00000000000a', 'shareEditToken00000003', 'Старе', now());

insert into public.share_items (share_id, item_id) values
  ('a3611111-0000-4000-8000-0000000000d1', 'a3611111-0000-4000-8000-0000000000c1'),
  ('a3611111-0000-4000-8000-0000000000d1', 'a3611111-0000-4000-8000-0000000000c2'),
  ('a3611111-0000-4000-8000-0000000000d1', 'a3611111-0000-4000-8000-0000000000c3'),
  ('a3611111-0000-4000-8000-0000000000d1', 'a3611111-0000-4000-8000-0000000000c4'),
  ('a3611111-0000-4000-8000-0000000000d2', 'a3611111-0000-4000-8000-0000000000c2'),
  ('a3611111-0000-4000-8000-0000000000d3', 'a3611111-0000-4000-8000-0000000000c3');

-- Гість A (пошта, польська) бере c1 і c3; гість B (пошта) — c2; Оля відкриває
-- збір на c4, Тарас долучається.
select tests.as_anon();
select claim_item_v2('shareEditToken00000001', 'a3611111-0000-4000-8000-0000000000c1',
                     'shareEditKeyAAAAAAAAAAAA', 1, 'Іра', 'ira36@pochta.ua', 'pl');
select claim_item_v2('shareEditToken00000001', 'a3611111-0000-4000-8000-0000000000c3',
                     'shareEditKeyAAAAAAAAAAAA', 1, null, null, 'pl');
select claim_item_v2('shareEditToken00000001', 'a3611111-0000-4000-8000-0000000000c2',
                     'shareEditKeyBBBBBBBBBBBB', 1, null, 'bohdan36@pochta.ua', 'uk');
select start_pool('shareEditToken00000001', 'a3611111-0000-4000-8000-0000000000c4',
                  'shareEditKeyOlyaCCCCCCCC', 'Оля', 'BLIK на +48 500 000 000', null, 'olia36@pochta.ua', 'uk');
select pledge_pool('shareEditToken00000001', tests.pool_of('a3611111-0000-4000-8000-0000000000c4'),
                   'shareEditKeyTarasDDDDDDD', 'Тарас', 100, 'uk', 'taras36@pochta.ua');
select tests.as_postgres();
delete from guest_mail;

-- ── Гість бачить лише набір ──────────────────

select tests.as_anon();
select ok(not ('a3611111-0000-4000-8000-0000000000c5'::uuid = any(tests.guest_ids('shareEditToken00000001'))),
          'позиції поза набором гість не бачить');
select throws_ok(
  $$ select claim_item_v2('shareEditToken00000001', 'a3611111-0000-4000-8000-0000000000c5',
                          'shareEditKeyAAAAAAAAAAAA', 1, null, null, 'pl') $$,
  'P0002', 'item_not_in_share', 'і взяти її не може'
);
select throws_ok(
  $$ select edit_share_items('a3611111-0000-4000-8000-0000000000d1', array['a3611111-0000-4000-8000-0000000000c5']::uuid[], '{}') $$,
  '42501', null, 'anon складу не змінює'
);

-- ── Чуже посилання ───────────────────────────

select tests.as_user('a3611111-0000-4000-8000-0000000000ff');
select throws_ok(
  $$ select edit_share_items('a3611111-0000-4000-8000-0000000000d1', array['a3611111-0000-4000-8000-0000000000c5']::uuid[], '{}') $$,
  'P0002', 'not_found', 'чужий власник не додає в моє посилання'
);
select throws_ok(
  $$ select edit_share_items('a3611111-0000-4000-8000-0000000000d1', '{}', array['a3611111-0000-4000-8000-0000000000c1']::uuid[]) $$,
  'P0002', 'not_found', 'і не прибирає з нього'
);
select is(tests.owner_answer('a3611111-0000-4000-8000-0000000000d1', '{}', array['a3611111-0000-4000-8000-0000000000c1']::uuid[]),
          tests.owner_answer('a3611111-0000-4000-8000-0000000000d1', '{}', array['a3611111-0000-4000-8000-0000000000c5']::uuid[]),
          'чужому — та сама відповідь, є на позиції бронь чи ні');
select tests.as_postgres();
select is(tests.claims_on('a3611111-0000-4000-8000-0000000000c1'), 1, 'бронь на моїй позиції після чужих спроб — на місці');
select is((select count(*)::int from share_items where share_id = 'a3611111-0000-4000-8000-0000000000d1'), 4,
          'склад мого посилання не змінився');

-- ── Додати в посилання: нова позиція за старим URL ──

select tests.as_user('a3611111-0000-4000-8000-00000000000f');
select lives_ok(
  $$ select edit_share_items('a3611111-0000-4000-8000-0000000000d1',
                             array['a3611111-0000-4000-8000-0000000000c5',
                                   'a3611111-0000-4000-8000-0000000000c6',
                                   'a3611111-0000-4000-8000-0000000000e1']::uuid[], '{}') $$,
  'власник додає позиції у своє живе посилання'
);
select lives_ok(
  $$ select edit_share_items('a3611111-0000-4000-8000-0000000000d1', array['a3611111-0000-4000-8000-0000000000c5']::uuid[], '{}') $$,
  'повторне додавання — без помилки'
);
select tests.as_anon();
select ok('a3611111-0000-4000-8000-0000000000c5'::uuid = any(tests.guest_ids('shareEditToken00000001')),
          'нову позицію гість бачить за старим посиланням');
select ok(not ('a3611111-0000-4000-8000-0000000000c6'::uuid = any(tests.guest_ids('shareEditToken00000001'))),
          'чернетка в посилання не потрапляє');
select ok(not ('a3611111-0000-4000-8000-0000000000e1'::uuid = any(tests.guest_ids('shareEditToken00000001'))),
          'позиція іншого списку — теж');
select ok(not ('a3611111-0000-4000-8000-0000000000c5'::uuid = any(tests.guest_ids('shareEditToken00000002'))),
          'інше посилання того самого списку нової позиції не отримало');

-- ── Прибрати, але позиція лишилась в іншому живому посиланні ──

select tests.as_user('a3611111-0000-4000-8000-00000000000f');
select edit_share_items('a3611111-0000-4000-8000-0000000000d1', '{}', array['a3611111-0000-4000-8000-0000000000c2']::uuid[]);
select tests.as_anon();
select ok(not ('a3611111-0000-4000-8000-0000000000c2'::uuid = any(tests.guest_ids('shareEditToken00000001'))),
          'прибрану позицію гість за цим посиланням більше не бачить');
select tests.as_postgres();
select is(tests.claims_on('a3611111-0000-4000-8000-0000000000c2'), 1,
          'позиція лишилась у живому «Для колег» — бронь не знято: позначка на позиції списку');
select is((select count(*)::int from guest_mail), 0, 'і листа немає');

-- ── Прибрати з єдиного живого: бронь знімається, лист у чергу ──

select tests.as_user('a3611111-0000-4000-8000-00000000000f');
select is(tests.owner_answer('a3611111-0000-4000-8000-0000000000d1', '{}', array['a3611111-0000-4000-8000-0000000000c1']::uuid[]),
          '<void>', 'власник прибирає позицію з бронню — відповідь порожня');
select is(tests.owner_answer('a3611111-0000-4000-8000-0000000000d1', '{}', array['a3611111-0000-4000-8000-0000000000c5']::uuid[]),
          '<void>', 'і без броні — та сама');
select throws_ok($$ select count(*) from claims $$, '42501', null, 'власник позначок не бачить і після зміни');
select tests.as_postgres();
select is(tests.claims_on('a3611111-0000-4000-8000-0000000000c1'), 0, 'бронь на прибраній позиції знято');
select is((select email || '|' || (details->>'title') || '|' || (details->>'reason') from tests.mail('deleted')),
          'ira36@pochta.ua|Кавоварка|unshared', 'гостю з поштою — лист «позицію прибрано» з назвою знімком');
select ok((select share_id = 'a3611111-0000-4000-8000-0000000000d1' and item_id is null from tests.mail('deleted')),
          'лист веде на посилання, звідки прибрали');
select is((select count(*)::int from items where id = 'a3611111-0000-4000-8000-0000000000c1'), 1,
          'сама позиція лишилась у списку власника');

-- Відкликане посилання позицію не тримає: c3 лишилась лише в d3.
select tests.as_user('a3611111-0000-4000-8000-00000000000f');
select edit_share_items('a3611111-0000-4000-8000-0000000000d1', '{}', array['a3611111-0000-4000-8000-0000000000c3']::uuid[]);
select tests.as_postgres();
select is(tests.claims_on('a3611111-0000-4000-8000-0000000000c3'), 0,
          'відкликане посилання не тримає броні: гості його не бачать');

-- ── Збір: як за видалення позиції ────────────

delete from guest_mail;
-- Разом повертаємо Лампу, щоб посилання не лишилось порожнім.
select tests.as_user('a3611111-0000-4000-8000-00000000000f');
select edit_share_items('a3611111-0000-4000-8000-0000000000d1', array['a3611111-0000-4000-8000-0000000000c5']::uuid[],
                        array['a3611111-0000-4000-8000-0000000000c4']::uuid[]);
select tests.as_postgres();
select is(tests.pool_of('a3611111-0000-4000-8000-0000000000c4'), null::uuid, 'збір на прибраній позиції зник разом із бронню організатора');
select is((select email || '|' || (details->>'reason') from tests.mail('pool_cancel')),
          'taras36@pochta.ua|unshared', 'учаснику — лист: позицію прибрано, переказувати не треба');
select is((select email from tests.mail('deleted')), 'olia36@pochta.ua', 'організатору — лист про зняту бронь');

-- ── Повернули — знову вільна ─────────────────

select tests.as_user('a3611111-0000-4000-8000-00000000000f');
select edit_share_items('a3611111-0000-4000-8000-0000000000d1', array['a3611111-0000-4000-8000-0000000000c1']::uuid[], '{}');
select tests.as_anon();
select is((tests.item('shareEditToken00000001', 'shareEditKeyBBBBBBBBBBBB', 'a3611111-0000-4000-8000-0000000000c1')->>'taken_qty')::int, 0,
          'повернута позиція знову вільна');
select lives_ok(
  $$ select claim_item_v2('shareEditToken00000001', 'a3611111-0000-4000-8000-0000000000c1',
                          'shareEditKeyBBBBBBBBBBBB', 1, null, null, 'uk') $$,
  'і її може взяти інший гість'
);

-- ── Пряме видалення з share_items — той самий тригер ──

select tests.as_postgres();
delete from guest_mail;
select tests.as_user('a3611111-0000-4000-8000-00000000000f');
delete from share_items where share_id = 'a3611111-0000-4000-8000-0000000000d1' and item_id = 'a3611111-0000-4000-8000-0000000000c1';
select tests.as_postgres();
select is(tests.claims_on('a3611111-0000-4000-8000-0000000000c1'), 0, 'видалення рядка напряму (RLS) знімає бронь так само');
select is((select count(*)::int from tests.mail('deleted')), 1, 'і ставить лист');

-- ── Невдала зміна нічого не губить ───────────

-- d2 тримає лише c2 з бронню B: прибрати її — посилання без позицій.
select tests.as_user('a3611111-0000-4000-8000-00000000000f');
select throws_ok(
  $$ select edit_share_items('a3611111-0000-4000-8000-0000000000d2', '{}', array['a3611111-0000-4000-8000-0000000000c2']::uuid[]) $$,
  '22023', 'no_items', 'посилання без жодної позиції не буває'
);
select tests.as_postgres();
select is(tests.claims_on('a3611111-0000-4000-8000-0000000000c2'), 1, 'відмова відкочує й зняття броні');

select tests.as_user('a3611111-0000-4000-8000-00000000000f');
select throws_ok(
  $$ select edit_share_items('a3611111-0000-4000-8000-0000000000d3', array['a3611111-0000-4000-8000-0000000000c5']::uuid[], '{}') $$,
  '22023', 'share_not_live', 'склад відкликаного посилання не змінюється'
);

-- ── Видалення позиції — один лист, не два ────

select tests.as_postgres();
delete from guest_mail;
select tests.as_user('a3611111-0000-4000-8000-00000000000f');
delete from items where id = 'a3611111-0000-4000-8000-0000000000c2';
select tests.as_postgres();
select is((select count(*)::int || '|' || coalesce(max(details->>'reason'), '-') from tests.mail('deleted')), '1|-',
          'видалення позиції дає звичайний лист «видалено», без другого «прибрано з посилання»');

-- ── Посилання цілком: броні не чіпаються, як і досі ──

select tests.as_user('a3611111-0000-4000-8000-00000000000f');
select edit_share_items('a3611111-0000-4000-8000-0000000000d2', array['a3611111-0000-4000-8000-0000000000c5']::uuid[], '{}');
select tests.as_anon();
select claim_item_v2('shareEditToken00000002', 'a3611111-0000-4000-8000-0000000000c5',
                     'shareEditKeyEEEEEEEEEEEE', 1, null, null, 'uk');
select tests.as_user('a3611111-0000-4000-8000-00000000000f');
-- Лампа стоїть в обох живих посиланнях; видаляємо обидва.
delete from shares where id in ('a3611111-0000-4000-8000-0000000000d1', 'a3611111-0000-4000-8000-0000000000d2');
select tests.as_postgres();
select is(tests.claims_on('a3611111-0000-4000-8000-0000000000c5'), 1,
          'видалення посилання цілком броней не знімає — як відкликання');

select * from finish();
rollback;
