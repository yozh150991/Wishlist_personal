-- 20260928100000_list_appearances.sql
-- Оформлення списку: подія як іменований відтінок (ADR-034).
--
-- Другий шар вигляду поверх схеми глядача. Оформлення перевизначає лише
-- акцентну рампу; нейтраль, полотно й небезпека лишаються від схеми. Відкритий
-- параметр один — відтінок H. Світлість і насиченість кожного кроку задає
-- застосунок (app/src/lib/hue-ramp.js), тож контраст — властивість конструкції,
-- а не результат перевірки, і в базі немає жодного кольору.
--
-- Три вбудовані події — рядки тієї самої таблиці з owner_id = null. Свої —
-- назва + відтінок, належать власникові й доступні всім його спискам.
--
-- Назва оформлення приватна: вона потрібна власникові в переліку й нікуди
-- більше не йде. Гість отримує лише відтінок.

create type public.appearance_source as enum ('builtin', 'manual', 'cover');

comment on type public.appearance_source is
  'Звідки відтінок: вбудована подія, обраний людиною, взятий з обкладинки (поки не використовується в інтерфейсі).';

create table public.appearances (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid references auth.users(id) on delete cascade,
  name        text not null check (length(btrim(name)) between 1 and 24),
  hue         smallint not null check (hue between 0 and 359),
  source      public.appearance_source not null default 'manual',
  builtin_key text unique check (builtin_key in ('birthday', 'wedding', 'housewarming')),
  created_at  timestamptz not null default now(),
  -- Вбудована подія не має власника, а своя — завжди має.
  constraint appearances_builtin_shape check (
    (owner_id is null) = (source = 'builtin')
    and (builtin_key is null) = (owner_id is not null)
  ),
  -- Перелік набраний Rubik, у ньому емодзі читається як чужа наліпка.
  -- Ті самі діапазони перевіряє форма (lib/appearances.ts).
  constraint appearances_name_no_emoji check (
    name !~ '[\U0001F000-\U0001FAFF☀-➿️‍]'
  )
);

comment on table public.appearances is
  'Оформлення списку: назва + відтінок. owner_id = null — вбудована подія. Гість не читає таблицю: відтінок приходить у get_shared_list.';
comment on column public.appearances.name is
  'Приватна назва для переліку власника. Гостю не віддається. У вбудованих — службове імʼя, підпис перекладає застосунок за builtin_key.';

create index appearances_owner_idx on public.appearances (owner_id, created_at);

insert into public.appearances (id, owner_id, name, hue, source, builtin_key) values
  ('0a0a0a0a-0000-4000-8000-000000000001', null, 'birthday',     358, 'builtin', 'birthday'),
  ('0a0a0a0a-0000-4000-8000-000000000002', null, 'wedding',       75, 'builtin', 'wedding'),
  ('0a0a0a0a-0000-4000-8000-000000000003', null, 'housewarming', 150, 'builtin', 'housewarming');

-- ─────────────────────────────────────────────
-- Доступ: власник — свої й вбудовані; гість — нічого
-- ─────────────────────────────────────────────

alter table public.appearances enable row level security;
revoke all on public.appearances from anon;

create policy appearances_select_own_or_builtin on public.appearances
  for select to authenticated using (owner_id is null or owner_id = auth.uid());

create policy appearances_insert_own on public.appearances
  for insert to authenticated with check (owner_id = auth.uid() and source <> 'builtin');

create policy appearances_update_own on public.appearances
  for update to authenticated using (owner_id = auth.uid())
  with check (owner_id = auth.uid() and source <> 'builtin');

create policy appearances_delete_own on public.appearances
  for delete to authenticated using (owner_id = auth.uid());

-- ─────────────────────────────────────────────
-- lists.appearance_id
-- ─────────────────────────────────────────────
-- Видалення оформлення ставить спискам null, а не осиротілий id: список не
-- ламається, просто повертається до схеми глядача.

alter table public.lists
  add column appearance_id uuid references public.appearances(id) on delete set null;

comment on column public.lists.appearance_id is
  'Оформлення списку (ADR-034). null — без оформлення, гість бачить чисту схему власника.';

create index lists_appearance_idx on public.lists (appearance_id) where appearance_id is not null;

-- Посилатися можна лише на своє або вбудоване оформлення. Зовнішній ключ
-- власника не перевіряє, тож без цього чужий id (якщо його вгадати) ліг би
-- в список. Обмежувальна політика додається до наявних lists_*_own через AND.
create policy lists_appearance_own_or_builtin on public.lists
  as restrictive
  for all to authenticated
  using (true)
  with check (
    appearance_id is null
    or exists (select 1 from public.appearances a
                where a.id = appearance_id
                  and (a.owner_id is null or a.owner_id = auth.uid()))
  );

-- ─────────────────────────────────────────────
-- get_shared_list — відтінок оформлення й дата події
-- ─────────────────────────────────────────────
--
-- Гість бачить схему власника й оформлення списку (resolveAppearance, правило
-- 3). Віддається лише відтінок — назва оформлення приватна. Оформлення не
-- кешується в токені: власник змінив його — наступне відкриття посилання
-- покаже нове.
--
-- Дата події йде в шапку гостьової («14 червня»): гість і так запрошений на
-- цю подію, а без дати листівка втрачає головне.
--
-- Решта тіла не змінилася відносно 20260928090000_schemes_and_contrast.sql.

create or replace function public.get_shared_list(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share  public.shares;
  v_list   public.lists;
  v_is_owner boolean;
  v_items  jsonb;
begin
  select * into v_share from public.shares where token = p_token;

  if v_share.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_share.revoked_at is not null then
    raise exception 'revoked' using errcode = 'P0002';
  end if;
  if v_share.expires_at is not null and v_share.expires_at < now() then
    raise exception 'expired' using errcode = 'P0002';
  end if;

  select * into v_list from public.lists where id = v_share.source_list_id;

  v_is_owner := (auth.uid() is not null and auth.uid() = v_share.owner_id);
  -- Власнику броні не показуємо навіть у власному посиланні (ADR-009).

  select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb)
  into v_items
  from (
    select jsonb_build_object(
      'id',        i.id,
      'title',     i.title,
      'url',       i.url,
      'price',     case when v_share.hide_prices then null else i.price end,
      'quantity',  i.quantity,
      'priority',  i.priority,
      'note',      i.note,
      'variants',  i.variants,
      'image_url', i.image_url,
      'status',    i.status,
      'created_at', i.created_at,
      'reserved_qty', case
        when v_is_owner then null
        else coalesce((select sum(r.quantity)::int from public.reservations r
                       where r.share_id = v_share.id and r.item_id = i.id), 0)
      end
    ) as x
    from public.share_items si
    join public.items i on i.id = si.item_id
    where si.share_id = v_share.id
      and i.status = 'active'
  ) t;

  return jsonb_build_object(
    'title',              v_share.title,
    'message',            v_share.message,
    'currency',           v_list.currency,
    'event_date',         v_list.event_date,
    'owner_scheme',       (select p.scheme from public.profiles p where p.id = v_share.owner_id),
    'appearance_hue',     (select a.hue from public.appearances a where a.id = v_list.appearance_id),
    'hide_prices',        v_share.hide_prices,
    'allow_reservations', v_share.allow_reservations and not v_is_owner,
    'viewer_is_owner',    v_is_owner,
    'items',              v_items
  );
end;
$$;

revoke all on function public.get_shared_list(text) from public;
grant execute on function public.get_shared_list(text) to anon, authenticated;
