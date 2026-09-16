-- 20260916220000_revoke_default_function_grants.sql
--
-- Закриває функції власника від anon і внутрішній генератор токенів від усіх.
--
-- Міграція 20260910120300_grants.sql відкликала EXECUTE лише в PUBLIC. Цього
-- мало: Supabase має default privileges, які при створенні кожної функції в
-- public видають EXECUTE ролям anon, authenticated і service_role ЯВНО,
-- окремими грантами. Відкликання в PUBLIC їх не чіпає, тож create_share,
-- list_items_page, list_totals і gen_share_token лишались доступними анонімно
-- як RPC-ендпоінти PostgREST.
--
-- Даних це не відкривало: функції власника — SECURITY INVOKER, і anon без прав
-- на таблиці отримує permission denied. Але інваріант CLAUDE.md §3.4 порушено,
-- і перша ж SECURITY DEFINER функція з тією самою помилкою стала б діркою.
--
-- Знайдено тестом supabase/tests/database/01_schema_guards.test.sql.

revoke execute on function
  public.create_share(uuid, uuid[], text, text, boolean, boolean, timestamptz)
  from anon;

revoke execute on function
  public.list_items_page(uuid, text, boolean, integer, text, uuid, text,
                         public.item_status[], numeric, numeric)
  from anon;

revoke execute on function public.list_totals(uuid) from anon;

-- gen_share_token: лише для authenticated. Вона викликається зсередини
-- create_share, а та — SECURITY INVOKER, тобто працює з правами викликача,
-- і без EXECUTE у authenticated створення посилання падає. Попередня міграція
-- вважала функцію «внутрішньою, не потрібною нікому» — насправді вона
-- працювала лише завдяки явному гранту за замовчуванням. Сама функція
-- лише повертає випадковий рядок і даних не читає.
revoke execute on function public.gen_share_token() from anon;
grant  execute on function public.gen_share_token() to authenticated;
