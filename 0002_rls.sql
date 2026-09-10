-- 0002_rls.sql — Row Level Security
-- Модель: усе закрито за замовчуванням. Власник бачить лише своє.
-- Гості (anon) НЕ мають прямого доступу до жодної таблиці — тільки через RPC у 0003.

alter table public.profiles     enable row level security;
alter table public.lists        enable row level security;
alter table public.items        enable row level security;
alter table public.shares       enable row level security;
alter table public.share_items  enable row level security;
alter table public.reservations enable row level security;

-- Прибираємо стандартні гранти PostgREST-ролей на рівні таблиць.
revoke all on public.profiles, public.lists, public.items,
              public.shares, public.share_items, public.reservations
  from anon;

revoke all on public.reservations from authenticated;
-- ↑ ІНВАРІАНТ: жодна автентифікована роль не читає броні напряму.
--   Доступ тільки через SECURITY DEFINER RPC для гостя. CLAUDE.md §3.2.

-- ─────────────────────────────────────────────
-- profiles
-- ─────────────────────────────────────────────

create policy profiles_select_own on public.profiles
  for select to authenticated using (id = auth.uid());

create policy profiles_update_own on public.profiles
  for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

-- ─────────────────────────────────────────────
-- lists — тільки власник, без винятків
-- ─────────────────────────────────────────────

create policy lists_select_own on public.lists
  for select to authenticated using (owner_id = auth.uid());

create policy lists_insert_own on public.lists
  for insert to authenticated with check (owner_id = auth.uid());

create policy lists_update_own on public.lists
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy lists_delete_own on public.lists
  for delete to authenticated using (owner_id = auth.uid());

-- ─────────────────────────────────────────────
-- items — owner_id денормалізовано, тому без JOIN
-- ─────────────────────────────────────────────

create policy items_select_own on public.items
  for select to authenticated using (owner_id = auth.uid());

create policy items_insert_own on public.items
  for insert to authenticated
  with check (exists (
    select 1 from public.lists l
    where l.id = list_id and l.owner_id = auth.uid()
  ));

create policy items_update_own on public.items
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy items_delete_own on public.items
  for delete to authenticated using (owner_id = auth.uid());

-- ─────────────────────────────────────────────
-- shares — власник керує своїми посиланнями
-- ─────────────────────────────────────────────

create policy shares_select_own on public.shares
  for select to authenticated using (owner_id = auth.uid());

create policy shares_insert_own on public.shares
  for insert to authenticated
  with check (
    owner_id = auth.uid()
    and exists (select 1 from public.lists l
                where l.id = source_list_id and l.owner_id = auth.uid())
  );

create policy shares_update_own on public.shares
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy shares_delete_own on public.shares
  for delete to authenticated using (owner_id = auth.uid());

-- ─────────────────────────────────────────────
-- share_items
-- ─────────────────────────────────────────────

create policy share_items_select_own on public.share_items
  for select to authenticated
  using (exists (select 1 from public.shares s
                 where s.id = share_id and s.owner_id = auth.uid()));

create policy share_items_insert_own on public.share_items
  for insert to authenticated
  with check (
    exists (select 1 from public.shares s
            where s.id = share_id and s.owner_id = auth.uid())
    and exists (select 1 from public.items i
                where i.id = item_id and i.owner_id = auth.uid())
  );

create policy share_items_delete_own on public.share_items
  for delete to authenticated
  using (exists (select 1 from public.shares s
                 where s.id = share_id and s.owner_id = auth.uid()));

-- ─────────────────────────────────────────────
-- reservations — ЖОДНОЇ політики. Це навмисно.
-- RLS увімкнено + політик нема = доступ заборонено всім ролям.
-- Читання/запис відбувається виключно через SECURITY DEFINER RPC (0003).
-- ─────────────────────────────────────────────
