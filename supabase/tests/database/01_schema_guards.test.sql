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

select plan(13);

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

-- ── Позначки: власник не бачить (§3.2) ───────
-- Позначки й усе, що про гостя (ідентичність, ключі, спроби коду, черга
-- листів, скарги на посилання — ADR-061), закриті від authenticated повністю: жодного права й жодної політики.

select is_empty(
  $$ select t.name || ': ' || p.priv
       from unnest(array['claims', 'guest_identities', 'guest_keys', 'guest_code_attempts', 'guest_mail', 'share_reports', 'gift_pools', 'gift_pool_pledges']) as t(name)
      cross join unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as p(priv)
      where has_table_privilege('authenticated', 'public.' || t.name, p.priv) $$,
  'authenticated не має жодних прав на позначки й дані гостей'
);

select is(
  (select count(*)::int from pg_policies where schemaname = 'public'
      and tablename in ('claims', 'guest_identities', 'guest_keys', 'guest_code_attempts', 'guest_mail', 'share_reports', 'gift_pools', 'gift_pool_pledges')),
  0,
  'на позначках і даних гостей немає жодної RLS-політики'
);

select is_empty(
  $$ select schemaname || '.' || viewname from pg_views
      where schemaname = 'public'
        and definition ~* '(^|[^_[:alnum:]])(claims|guest_identities|guest_keys)([^_[:alnum:]]|$)'
     union all
     select schemaname || '.' || matviewname from pg_matviews
      where schemaname = 'public'
        and definition ~* '(^|[^_[:alnum:]])(claims|guest_identities|guest_keys)([^_[:alnum:]]|$)' $$,
  'жодна вʼю в public не читає позначки чи дані гостей'
);

select set_eq(
  $$ select p.proname::text
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public'
        -- Ціле слово, окремо або як public.claims: request.jwt.claims у
        -- помічниках автентифікації — не таблиця позначок.
        and p.prosrc ~* '(^|[^_.[:alnum:]]|public\.)claims([^_[:alnum:]]|$)'
        and not exists (select 1 from pg_depend d
                         where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e') $$,
  -- ADR-055: «Змінено» для гостя (get_guest_list, ack_claim_change), листи J
  -- і нагадування (тригери позицій і enqueue_guest_reminders) — пишуть лише в
  -- гостьові таблиці й нічого не повертають власнику.
  -- ADR-059: lists_thanks_mail_trg — листи подяки гостям, які брали; тригер
  -- нічого не повертає й ковтає помилки.
  -- ADR-062: get_my_gifts — «Я дарую»: лише власні позначки користувача на
  -- чужих списках.
  array['get_shared_list', 'claim_item', 'release_claim', 'redeem_guest_code', 'release_item_claims',
        'get_guest_list', 'ack_claim_change', 'guest_item_changed_trg', 'guest_item_deleted_trg',
        'enqueue_guest_reminders', 'set_claim_bought', 'lists_thanks_mail_trg', 'get_my_gifts'],
  'claims згадують лише гостьові функції й сліпе скидання; нова функція над позначками має бути додана сюди свідомо'
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
  -- get_guest_list, claim_item_v2 — гостьова (ADR-053). Їхні внутрішні
  -- get_shared_list і claim_item закрито від клієнтів (ADR-065) — див. нижче.
  -- send_guest_code, guest_mail_set — код на пошту й відписка (ADR-054).
  -- get_share_card — картка посилання для ботів месенджерів (ADR-060).
  -- report_share — «Поскаржитись» на гостьовій (ADR-061).
  -- start/pledge/leave/close/cancel_pool — спільний подарунок (ADR-063).
  array['register_share_view', 'release_claim', 'redeem_guest_code',
        'get_guest_list', 'claim_item_v2', 'send_guest_code', 'guest_mail_set', 'ack_claim_change',
        'set_claim_bought', 'get_share_card', 'report_share',
        'start_pool', 'pledge_pool', 'leave_pool', 'close_pool', 'cancel_pool'],
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
  -- release_item_claims — сліпе скидання власником: нічого не повертає.
  -- reorder_items / reorder_sections — SECURITY INVOKER, RLS відсіює чуже.
  -- save_push_subscription / forget_push_subscription — пристрій для push
  -- переходить до того, хто ввімкнув push останнім (ADR-049); нічого не
  -- повертають, адреса підписки — у тілі запиту.
  -- delete_my_account — видалення власного акаунта після звірки пароля (ADR-072).
  array['register_share_view', 'release_claim', 'redeem_guest_code',
        'get_guest_list', 'claim_item_v2', 'send_guest_code', 'guest_mail_set', 'ack_claim_change',
        'set_claim_bought', 'get_share_card', 'report_share', 'get_my_gifts', 'attach_guest_key',
        'start_pool', 'pledge_pool', 'leave_pool', 'close_pool', 'cancel_pool', 'create_share', 'list_items_page', 'list_totals', 'gen_share_token', 'release_item_claims',
        'reorder_items', 'reorder_sections', 'save_push_subscription', 'forget_push_subscription',
        'delete_my_account'],
  'authenticated може викликати лише гостьові RPC і функції власника'
);

-- ADR-065: гостьова v1 — лише всередині get_guest_list і claim_item_v2.
select ok(
  not has_function_privilege('anon', 'public.get_shared_list(text, text)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.get_shared_list(text, text)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.get_shared_list(text, text)', 'EXECUTE'),
  'get_shared_list — внутрішня, прямого виклику немає'
);
select ok(
  not has_function_privilege('anon', 'public.claim_item(text, uuid, text, integer)', 'EXECUTE')
  and not has_function_privilege('authenticated', 'public.claim_item(text, uuid, text, integer)', 'EXECUTE')
  and not has_function_privilege('service_role', 'public.claim_item(text, uuid, text, integer)', 'EXECUTE'),
  'claim_item — внутрішня, прямого виклику немає'
);
select ok(
  (select p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres'
     from pg_proc p where p.oid = 'public.get_guest_list(text, text)'::regprocedure)
  and (select p.prosecdef and pg_get_userbyid(p.proowner) = 'postgres'
     from pg_proc p where p.oid = 'public.claim_item_v2(text, uuid, text, integer, text, text, text)'::regprocedure),
  'обгортки v2 — SECURITY DEFINER від postgres: внутрішні функції їм доступні'
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
