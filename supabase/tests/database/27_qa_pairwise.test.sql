-- QA-регресія за техніками тест-дизайну (ADR-069): попарне тестування.
--
-- Повний перебір тут дорогий (сторінки списку: 4·2·4·3·3·2 = 576 комбінацій),
-- а більшість дефектів — від взаємодії двох параметрів. Тому — покривні масиви,
-- у яких кожна пара значень будь-яких двох параметрів трапляється хоч раз.
-- Масиви згенеровано й перевірено на повноту пар (docs/QA_REPORT.md, «Як
-- отримано масиви»); кожен рядок має оракул, що рахує очікуване незалежно.
--
--   P1. Посилання: hide_prices × allow_reservations × архів × хто дивиться × термін
--       (2·2·2·3·2 = 48 → 6 рядків)
--   P2. list_items_page: сортування × напрям × розмір сторінки × статус × ціна × пошук
--       (576 → 16 рядків); оракул — один запит без сторінок; перевіряється й те,
--       що курсор не губить і не дублює рядків на рівних ключах.
--   P3. Контакт гостя в claim_item_v2: імʼя × пошта × мова × нова/наявна ідентичність
--       (3·3·3·2 = 54 → 9 рядків)

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(75);

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

create function tests.as_viewer(p_viewer text) returns void language plpgsql as $$
begin
  case p_viewer
    when 'anon'  then perform tests.as_anon();
    when 'other' then perform tests.as_user('c0270000-0000-4000-8000-0000000000f2');
    when 'owner' then perform tests.as_user('c0270000-0000-4000-8000-0000000000f1');
  end case;
end $$;

grant execute on all functions in schema tests to anon, authenticated;

insert into auth.users (id, email, email_confirmed_at) values
  ('c0270000-0000-4000-8000-0000000000f1', 'qa27-owner@test.local', now()),
  ('c0270000-0000-4000-8000-0000000000f2', 'qa27-other@test.local', now());

-- ═════════════════════════════════════════════
-- P1. Налаштування посилання × хто дивиться
-- ═════════════════════════════════════════════

create temp table p1 (n int primary key, viewer text, hide_prices boolean, allow_res boolean,
                      archived boolean, expires boolean, got jsonb, claim text);
insert into p1 (n, viewer, hide_prices, allow_res, archived, expires) values
  (1, 'anon',  true,  true,  false, false),
  (2, 'anon',  false, false, true,  true),
  (3, 'other', true,  false, true,  false),
  (4, 'other', false, true,  false, true),
  (5, 'owner', true,  true,  true,  true),
  (6, 'owner', false, false, false, false);
grant all on p1 to anon, authenticated;

insert into public.lists (id, owner_id, title, is_archived)
select ('c0270000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid,
       'c0270000-0000-4000-8000-0000000000f1', 'P1 рядок ' || n, archived
  from p1;
insert into public.items (id, list_id, owner_id, title, price, quantity)
select ('c0270000-0000-4000-8000-0000000002' || lpad(n::text, 2, '0'))::uuid,
       ('c0270000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid,
       'c0270000-0000-4000-8000-0000000000f1', 'Річ ' || n, 50, 2
  from p1;
insert into public.shares (id, owner_id, source_list_id, token, title, hide_prices, allow_reservations, expires_at)
select ('c0270000-0000-4000-8000-0000000003' || lpad(n::text, 2, '0'))::uuid,
       'c0270000-0000-4000-8000-0000000000f1',
       ('c0270000-0000-4000-8000-0000000001' || lpad(n::text, 2, '0'))::uuid,
       'qa27PairShare00000000' || lpad(n::text, 2, '0'), 'P1 ' || n, hide_prices, allow_res,
       case when expires then now() + interval '30 days' end
  from p1;
insert into public.share_items (share_id, item_id)
select ('c0270000-0000-4000-8000-0000000003' || lpad(n::text, 2, '0'))::uuid,
       ('c0270000-0000-4000-8000-0000000002' || lpad(n::text, 2, '0'))::uuid
  from p1;

-- Кожен рядок — від імені свого глядача.
do $$
declare r record; v jsonb; c text;
begin
  for r in select * from p1 order by n loop
    perform tests.as_viewer(r.viewer);
    v := public.get_guest_list('qa27PairShare00000000' || lpad(r.n::text, 2, '0'), 'qa27PairKey00000000000' || r.n);
    begin
      perform public.claim_item_v2('qa27PairShare00000000' || lpad(r.n::text, 2, '0'),
                                   ('c0270000-0000-4000-8000-0000000002' || lpad(r.n::text, 2, '0'))::uuid,
                                   'qa27PairKey00000000000' || r.n, 1);
      c := 'ok';
    exception when others then c := sqlerrm;
    end;
    perform tests.as_postgres();
    update p1 set got = v, claim = c where n = r.n;
  end loop;
end $$;
select tests.as_postgres();

-- Оракули: кожне правило — окремим запитом над усіма рядками.
select is(got->'items'->0->>'price', case when hide_prices then null else '50.00' end,
          format('P1 рядок %s (%s, ціни %s): ціна є, лише коли не приховано', n, viewer, case when hide_prices then 'сховані' else 'видно' end))
  from p1 order by n;
select is((got->>'allow_reservations')::boolean, allow_res and not archived and viewer <> 'owner',
          format('P1 рядок %s: allow_reservations = дозволено ∧ ¬архів ∧ ¬власник', n))
  from p1 order by n;
select is(claim,
          case when not allow_res then 'reservations_disabled'
               when viewer = 'owner' then 'owner_cannot_reserve'
               when archived then 'list_archived'
               else 'ok' end,
          format('P1 рядок %s: результат «Беру» за пріоритетом перевірок', n))
  from p1 order by n;
select is(got->'items'->0->>'taken_qty' is null, viewer = 'owner',
          format('P1 рядок %s: taken_qty приховано рівно від власника', n))
  from p1 order by n;
select is(got->>'expires_at' is not null, expires,
          format('P1 рядок %s: термін віддається, лише коли заданий', n))
  from p1 order by n;

-- ═════════════════════════════════════════════
-- P2. Сторінки list_items_page
-- ═════════════════════════════════════════════

-- 60 позицій з навмисними збігами ключів: одна вставка — однаковий created_at;
-- 6 назв на 60 рядків; ціни з повторами й без ціни; три пріоритети.
insert into public.lists (id, owner_id, title) values
  ('c0270000-0000-4000-8000-000000000a01', 'c0270000-0000-4000-8000-0000000000f1', 'P2 сторінки');
insert into public.items (list_id, owner_id, title, price, priority, status)
select 'c0270000-0000-4000-8000-000000000a01', 'c0270000-0000-4000-8000-0000000000f1',
       (array['Абрикос', 'абрикос', 'Ялинка', 'Żaba', 'Book', 'Ваза'])[1 + g % 6],
       case when g % 7 = 0 then null else (g % 5) * 100 + 0.5 end,
       (array['low', 'medium', 'high'])[1 + g % 3]::public.item_priority,
       (array['active', 'active', 'purchased', 'gifted'])[1 + g % 4]::public.item_status
  from generate_series(1, 60) g;
-- Друга хвиля з іншим часом — щоб сортування за датою мало й різні ключі.
update public.items set created_at = created_at - interval '1 day'
 where list_id = 'c0270000-0000-4000-8000-000000000a01' and priority = 'low';

create temp table p2 (n int primary key, sort text, descending boolean, page int,
                      status text, price text, search text);
insert into p2 values
  ( 1, 'priority',   false, 10,  'active', 'min',   null),
  ( 2, 'title',      true,  25,  'all',    'min',   'а'),
  ( 3, 'created_at', false, 50,  'done',   'range', 'а'),
  ( 4, 'price',      true,  100, 'done',   'none',  null),
  ( 5, 'price',      false, 10,  'all',    'none',  'а'),
  ( 6, 'priority',   true,  50,  'all',    'range', null),
  ( 7, 'created_at', true,  25,  'active', 'none',  null),
  ( 8, 'title',      false, 100, 'active', 'range', 'а'),
  ( 9, 'priority',   false, 25,  'done',   'none',  'а'),
  (10, 'title',      true,  10,  'done',   'min',   null),
  (11, 'price',      true,  50,  'active', 'min',   null),
  (12, 'created_at', false, 100, 'all',    'min',   null),
  (13, 'title',      false, 50,  'active', 'none',  'а'),
  (14, 'price',      true,  25,  'active', 'range', null),
  (15, 'created_at', false, 10,  'done',   'range', null),
  (16, 'priority',   false, 100, 'all',    'none',  'а');
grant select on p2 to authenticated;

create function tests.statuses(p text) returns public.item_status[] language sql immutable as $$
  select case p when 'active' then array['active']::public.item_status[]
                when 'done'   then array['purchased', 'gifted']::public.item_status[] end
$$;
create function tests.pmin(p text) returns numeric language sql immutable as $$
  select case when p in ('min', 'range') then 100 end
$$;
create function tests.pmax(p text) returns numeric language sql immutable as $$
  select case when p = 'range' then 300.5 end
$$;

-- Усі сторінки підряд, курсор — як у lib/db.ts (cursorFrom).
create function tests.paginate(r p2) returns uuid[] language plpgsql as $$
declare
  out_ids uuid[] := '{}';
  ck text; cid uuid; got int; last public.items; i int := 0;
begin
  loop
    i := i + 1;
    if i > 100 then raise exception 'нескінченна пагінація'; end if;
    got := 0;
    for last in select * from public.list_items_page(
        'c0270000-0000-4000-8000-000000000a01', r.sort, r.descending, r.page, ck, cid,
        r.search, tests.statuses(r.status), tests.pmin(r.price), tests.pmax(r.price)) loop
      out_ids := out_ids || last.id;
      got := got + 1;
      ck := case r.sort when 'created_at' then last.created_at::text
                        when 'title'      then last.title
                        when 'price'      then coalesce(last.price, -1)::text
                        when 'priority'   then last.priority::text end;
      cid := last.id;
    end loop;
    exit when got < r.page;
  end loop;
  return out_ids;
end $$;

-- Оракул: той самий порядок і фільтр одним запитом, без курсора.
create function tests.expected(r p2) returns uuid[] language plpgsql as $$
declare v uuid[];
begin
  execute format($q$
    select coalesce(array_agg(i.id order by %s %s, i.id %s), '{}')
      from public.items i
     where i.list_id = 'c0270000-0000-4000-8000-000000000a01'
       and ($1::text is null or position(lower($1) in lower(i.title)) > 0)
       and ($2::public.item_status[] is null or i.status = any($2))
       and ($3::numeric is null or i.price >= $3)
       and ($4::numeric is null or i.price <= $4)
  $q$,
    case r.sort when 'created_at' then 'i.created_at' when 'title' then 'i.title'
                when 'price' then 'coalesce(i.price, -1)' when 'priority' then 'i.priority' end,
    case when r.descending then 'desc' else 'asc' end,
    case when r.descending then 'desc' else 'asc' end)
  into v
  using r.search, tests.statuses(r.status), tests.pmin(r.price), tests.pmax(r.price);
  return v;
end $$;
grant execute on all functions in schema tests to authenticated;

select tests.as_user('c0270000-0000-4000-8000-0000000000f1');
create temp table p2_got as
select n, tests.paginate(p2) as got, tests.expected(p2) as want from p2;

select is(got, want,
          format('P2 рядок %s: %s %s, сторінка %s, статус %s, ціна %s, пошук %s — усі рядки, по разу, у порядку',
                 n, p.sort, case when p.descending then '↓' else '↑' end, p.page, p.status, p.price, coalesce(p.search, '—')))
  from p2_got join p2 p using (n) order by n;
select ok((select bool_and(cardinality(want) > 0) from p2_got),
          'P2: жоден рядок масиву не вироджений — оракулу є що порівнювати');
select ok((select count(distinct cardinality(want)) > 4 from p2_got),
          'P2: фільтри справді розрізняють рядки (різні розміри вибірок)');

-- ═════════════════════════════════════════════
-- P3. Контакт гостя: імʼя × пошта × мова × ідентичність
-- ═════════════════════════════════════════════

select tests.as_postgres();
insert into public.lists (id, owner_id, title) values
  ('c0270000-0000-4000-8000-000000000b01', 'c0270000-0000-4000-8000-0000000000f1', 'P3 контакти');
insert into public.items (id, list_id, owner_id, title, quantity) values
  ('c0270000-0000-4000-8000-000000000b11', 'c0270000-0000-4000-8000-000000000b01', 'c0270000-0000-4000-8000-0000000000f1', 'Перша', 99),
  ('c0270000-0000-4000-8000-000000000b12', 'c0270000-0000-4000-8000-000000000b01', 'c0270000-0000-4000-8000-0000000000f1', 'Друга', 99);
insert into public.shares (id, owner_id, source_list_id, token, title) values
  ('c0270000-0000-4000-8000-000000000b21', 'c0270000-0000-4000-8000-0000000000f1', 'c0270000-0000-4000-8000-000000000b01', 'qa27ContactShare0000001', 'P3');
insert into public.share_items (share_id, item_id) values
  ('c0270000-0000-4000-8000-000000000b21', 'c0270000-0000-4000-8000-000000000b11'),
  ('c0270000-0000-4000-8000-000000000b21', 'c0270000-0000-4000-8000-000000000b12');

create temp table p3 (n int primary key, name text, email text, locale text, identity text,
                      got_name text, got_email text, got_locale text);
insert into p3 (n, name, email, locale, identity) values
  (1, 'null',  'blank', 'xx', 'new'),
  (2, 'value', 'blank', 'pl', 'existing'),
  (3, 'value', 'null',  'uk', 'new'),
  (4, 'null',  'valid', 'uk', 'existing'),
  (5, 'blank', 'valid', 'pl', 'new'),
  (6, 'blank', 'null',  'xx', 'existing'),
  (7, 'null',  'null',  'pl', 'existing'),
  (8, 'value', 'valid', 'xx', 'existing'),
  (9, 'blank', 'blank', 'uk', 'existing');
grant all on p3 to anon;

do $$
declare r record; v_key text;
begin
  for r in select * from p3 order by n loop
    v_key := 'qa27ContactKey0000000' || lpad(r.n::text, 2, '0');
    perform tests.as_anon();
    if r.identity = 'existing' then
      -- Наявна ідентичність: уже лишила імʼя, пошту й мову на першій позиції.
      perform public.claim_item_v2('qa27ContactShare0000001', 'c0270000-0000-4000-8000-000000000b11', v_key, 1,
                                   'Стара', 'old@mail.com', 'en');
    end if;
    perform public.claim_item_v2('qa27ContactShare0000001', 'c0270000-0000-4000-8000-000000000b12', v_key, 1,
      case r.name  when 'null' then null when 'blank' then '   ' else 'Нова' end,
      case r.email when 'null' then null when 'blank' then '   ' else 'New@Mail.com' end,
      r.locale);
    perform tests.as_postgres();
    update p3 set (got_name, got_email, got_locale) =
      (select g.name, g.email, g.locale from public.guest_identities g
        where g.id = public.guest_identity_of('c0270000-0000-4000-8000-000000000b01', v_key))
     where n = r.n;
  end loop;
end $$;
select tests.as_postgres();

select is(got_name,
          case name when 'value' then 'Нова' when 'blank' then null
                    else case when identity = 'existing' then 'Стара' end end,
          format('P3 рядок %s: імʼя %s на %s ідентичності', n, name, identity))
  from p3 order by n;
select is(got_email,
          case email when 'valid' then 'new@mail.com' when 'blank' then null
                     else case when identity = 'existing' then 'old@mail.com' end end,
          format('P3 рядок %s: пошта %s на %s ідентичності', n, email, identity))
  from p3 order by n;
select is(got_locale,
          case when locale in ('uk', 'pl') then locale
               else case when identity = 'existing' then 'en' end end,
          format('P3 рядок %s: мова %s на %s ідентичності', n, locale, identity))
  from p3 order by n;

select * from finish();
rollback;
