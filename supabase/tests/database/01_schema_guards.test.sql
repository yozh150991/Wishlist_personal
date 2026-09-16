-- Структурні гарантії приватності.
--
-- Ці тести не перевіряють поведінку на даних — вони перевіряють, що схема
-- в цілому не має дірок. Сенс у тому, що вони падають на МАЙБУТНІЙ міграції:
-- нова таблиця без RLS, нова функція, доступна анонімно, нова вʼю над
-- бронями. Кожен такий випадок має бути свідомим рішенням, а не забутим грантом.
--
-- Інваріанти — CLAUDE.md §3.

begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;

select plan(10);

-- ── Таблиці ──────────────────────────────────

select is_empty(
  $$ select c.relname::text
       from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where n.nspname = 'public' and c.relkind in ('r', 'p')
        and not c.relrowsecurity $$,
  'RLS увімкнено на кожній таблиці в public'
);

select is_empty(
  $$ select c.relname || ': ' || p.priv
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as p(priv)
      where n.nspname = 'public' and c.relkind in ('r', 'p', 'v', 'm', 'f')
        and has_table_privilege('anon', c.oid, p.priv) $$,
  'anon не має жодних прав на таблиці й вʼю в public — гість працює лише через RPC (§3.3)'
);

select is_empty(
  $$ select policyname::text || ' on ' || tablename
       from pg_policies
      where schemaname = 'public'
        and (roles && array['anon', 'public']::name[]) $$,
  'жодна RLS-політика не адресована anon чи PUBLIC'
);

-- ── Броні: власник не бачить (§3.2) ──────────

select is_empty(
  $$ select p.priv
       from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as p(priv)
      where has_table_privilege('authenticated', 'public.reservations', p.priv) $$,
  'authenticated не має жодних прав на reservations'
);

select is(
  (select count(*)::int from pg_policies where schemaname = 'public' and tablename = 'reservations'),
  0,
  'на reservations немає жодної RLS-політики'
);

select is_empty(
  $$ select schemaname || '.' || viewname from pg_views
      where schemaname = 'public' and definition ~* '(^|[^_[:alnum:]])reservations([^_[:alnum:]]|$)'
     union all
     select schemaname || '.' || matviewname from pg_matviews
      where schemaname = 'public' and definition ~* '(^|[^_[:alnum:]])reservations([^_[:alnum:]]|$)' $$,
  'жодна вʼю в public не читає reservations'
);

select set_eq(
  $$ select p.proname::text
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        -- Ціле слово: allow_reservations у create_share — не звернення до таблиці.
        and p.prosrc ~* '(^|[^_[:alnum:]])reservations([^_[:alnum:]]|$)'
        and not exists (select 1 from pg_depend d
                         where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e') $$,
  array['get_shared_list', 'reserve_item', 'unreserve_item'],
  'reservations згадують лише гостьові функції; нова функція над бронями має бути додана сюди свідомо'
);

-- ── Функції: гранти явні (§3.4) ──────────────
-- Тригерні функції через PostgREST не викликаються; функції розширень
-- (pg_trgm тощо) даних не читають. Обидві групи виключено.

select set_eq(
  $$ select p.proname::text
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prorettype <> 'trigger'::regtype
        and not exists (select 1 from pg_depend d
                         where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
        and has_function_privilege('anon', p.oid, 'EXECUTE') $$,
  array['get_shared_list', 'register_share_view', 'reserve_item', 'unreserve_item'],
  'anon може викликати лише гостьові RPC'
);

select set_eq(
  $$ select p.proname::text
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        and p.prorettype <> 'trigger'::regtype
        and not exists (select 1 from pg_depend d
                         where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
        and has_function_privilege('authenticated', p.oid, 'EXECUTE') $$,
  -- gen_share_token потрібна authenticated: її викликає create_share,
  -- яка працює з правами викликача (SECURITY INVOKER).
  array['get_shared_list', 'register_share_view', 'reserve_item', 'unreserve_item',
        'create_share', 'list_items_page', 'list_totals', 'gen_share_token'],
  'authenticated може викликати лише гостьові RPC і функції власника'
);

select is_empty(
  $$ select p.proname::text
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prosecdef
        and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c
                         where c like 'search_path=%') $$,
  'кожна SECURITY DEFINER функція фіксує search_path'
);

select * from finish();
rollback;
