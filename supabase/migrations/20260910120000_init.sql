-- 0001_init.sql — базова схема Wishlist_personal
-- Застосовується першою. Не редагувати після застосування.

create extension if not exists "pgcrypto";
create extension if not exists "pg_trgm";

-- ─────────────────────────────────────────────
-- Довідникові типи
-- ─────────────────────────────────────────────

create type public.item_status as enum ('active', 'purchased', 'gifted');
-- active    — ще актуально
-- purchased — власник купив собі сам
-- gifted    — подаровано (підсумки після події)

create type public.item_priority as enum ('low', 'medium', 'high');
create type public.app_locale   as enum ('uk', 'pl', 'en');
create type public.app_theme    as enum ('light', 'dark', 'system');

-- ─────────────────────────────────────────────
-- profiles — розширення auth.users
-- ─────────────────────────────────────────────

create table public.profiles (
  id               uuid primary key references auth.users(id) on delete cascade,
  display_name     text,
  locale           public.app_locale not null default 'uk',
  theme            public.app_theme  not null default 'system',
  default_currency char(3) not null default 'PLN',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

comment on table public.profiles is 'Профіль користувача. Створюється тригером при реєстрації.';

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.profiles (id, display_name)
  values (new.id, split_part(new.email, '@', 1))
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ─────────────────────────────────────────────
-- lists — списки бажань
-- ─────────────────────────────────────────────

create table public.lists (
  id          uuid primary key default gen_random_uuid(),
  owner_id    uuid not null references auth.users(id) on delete cascade,
  title       text not null check (length(btrim(title)) between 1 and 120),
  description text check (length(description) <= 2000),
  currency    char(3) not null default 'PLN'
              check (currency in ('PLN','UAH','EUR','USD')),
  event_date  date,
  is_archived boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on column public.lists.currency is 'Одна валюта на весь список (ADR-005).';
comment on column public.lists.event_date is 'Дата події. Після неї застосунок пропонує підбити підсумки (позначити подароване).';

create index lists_owner_created_idx on public.lists (owner_id, created_at desc);

-- ─────────────────────────────────────────────
-- items — позиції списку
-- ─────────────────────────────────────────────

create table public.items (
  id          uuid primary key default gen_random_uuid(),
  list_id     uuid not null references public.lists(id) on delete cascade,
  owner_id    uuid not null references auth.users(id) on delete cascade,
  title       text not null check (length(btrim(title)) between 1 and 200),
  url         text check (url ~* '^https?://' and length(url) <= 2048),
  price       numeric(12,2) check (price >= 0),
  quantity    integer not null default 1 check (quantity between 1 and 999),
  priority    public.item_priority not null default 'medium',
  note        text check (length(note) <= 1000),
  image_url   text check (image_url ~* '^https?://' and length(image_url) <= 2048),
  status      public.item_status not null default 'active',
  source_site text,
  parsed_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

comment on column public.items.owner_id is
  'Денормалізовано з lists.owner_id заради дешевих RLS-політик без JOIN. Підтримується тригером.';
comment on column public.items.price is
  'NULL = ціна невідома. url і price необов''язкові.';

create index items_list_created_idx on public.items (list_id, created_at desc, id desc);
create index items_list_price_idx   on public.items (list_id, price, id);
create index items_list_title_idx   on public.items (list_id, title, id);
create index items_list_status_idx  on public.items (list_id, status);
create index items_title_trgm_idx   on public.items using gin (title gin_trgm_ops);
create index items_owner_idx        on public.items (owner_id);

create or replace function public.sync_item_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  select owner_id into new.owner_id from public.lists where id = new.list_id;
  if new.owner_id is null then
    raise exception 'Список % не знайдено', new.list_id;
  end if;
  return new;
end;
$$;

create trigger items_sync_owner
  before insert or update of list_id on public.items
  for each row execute function public.sync_item_owner();

-- ─────────────────────────────────────────────
-- shares — секретні посилання на підмножину позицій
-- ─────────────────────────────────────────────

create table public.shares (
  id                 uuid primary key default gen_random_uuid(),
  owner_id           uuid not null references auth.users(id) on delete cascade,
  source_list_id     uuid not null references public.lists(id) on delete cascade,
  token              text not null unique check (token ~ '^[A-Za-z0-9_-]{22,64}$'),
  title              text not null check (length(btrim(title)) between 1 and 120),
  message            text check (length(message) <= 1000),
  hide_prices        boolean not null default false,
  allow_reservations boolean not null default true,
  expires_at         timestamptz,
  revoked_at         timestamptz,
  view_count         integer not null default 0,
  last_viewed_at     timestamptz,
  created_at         timestamptz not null default now()
);

comment on table public.shares is
  'Живе посилання (ADR-007): показує актуальний стан позицій, не знімок.';

create index shares_owner_idx on public.shares (owner_id, created_at desc);
create index shares_list_idx  on public.shares (source_list_id);

create table public.share_items (
  share_id uuid not null references public.shares(id) on delete cascade,
  item_id  uuid not null references public.items(id)  on delete cascade,
  added_at timestamptz not null default now(),
  primary key (share_id, item_id)
);

comment on table public.share_items is
  'ON DELETE CASCADE на item_id і є механізмом «живого» посилання: видалив позицію — вона зникла у гостей.';

create index share_items_item_idx on public.share_items (item_id);

-- ─────────────────────────────────────────────
-- reservations — анонімні броні гостей
-- ─────────────────────────────────────────────

create table public.reservations (
  id         uuid primary key default gen_random_uuid(),
  share_id   uuid not null references public.shares(id) on delete cascade,
  item_id    uuid not null references public.items(id)  on delete cascade,
  guest_key  text not null check (length(guest_key) between 16 and 64),
  quantity   integer not null default 1 check (quantity between 1 and 999),
  created_at timestamptz not null default now(),
  unique (share_id, item_id, guest_key)
);

comment on table public.reservations is
  'ІНВАРІАНТ: власник НЕ МАЄ доступу до цієї таблиці — ні через RLS, ні через RPC, ні через в''ю. CLAUDE.md §3.2.';
comment on column public.reservations.guest_key is
  'Випадковий ідентифікатор із localStorage гостя. Не пов''язаний з особою.';

create index reservations_item_idx  on public.reservations (item_id);
create index reservations_guest_idx on public.reservations (share_id, guest_key);

-- ─────────────────────────────────────────────
-- updated_at
-- ─────────────────────────────────────────────

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();
create trigger lists_touch before update on public.lists
  for each row execute function public.touch_updated_at();
create trigger items_touch before update on public.items
  for each row execute function public.touch_updated_at();
