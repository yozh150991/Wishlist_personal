-- 20260930090000_notifications.sql
-- Сповіщення власника: push і листи (дизайн v2, крок 4г-2; потік P; ADR-049).
--
-- Що й коли надсилати, вирішує закритий сервіс wishlist-jobs (ADR-048): раз
-- на годину він дивиться на списки, позиції й посилання власників, які
-- ввімкнули сповіщення, і шле те, чого ще не слав. Тут — лише три речі:
--   notification_settings — що людина хоче отримувати й яким каналом;
--   push_subscriptions    — пристрої, на які можна слати push;
--   notification_log      — що вже надіслано, щоб не повторюватись.
--
-- Розширюємо, а не міняємо (ADR-039): рядка налаштувань немає — сповіщень
-- немає, як у v1. Усі канали усталено вимкнені; вмикає їх лише інтерфейс v2.
--
-- Позначок гостей тут немає й бути не може (CLAUDE.md §3.2, ADR-040): жодна
-- подія не стосується того, що взяли гості, і сервіс таблиць позначок не читає.

-- ─────────────────────────────────────────────
-- notification_settings
-- ─────────────────────────────────────────────

create table public.notification_settings (
  owner_id          uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  -- Тиша 22:00–9:00 рахується за цим поясом. Пише застосунок із браузера
  -- (deviceTimeZone); сервіс, який пояса не знає, бере UTC.
  time_zone         text not null default 'UTC'
                    check (length(time_zone) between 1 and 64 and time_zone ~ '^[A-Za-z0-9_+/-]+$'),
  after_event_push  boolean not null default false,
  after_event_email boolean not null default false,
  yearly_push       boolean not null default false,
  yearly_email      boolean not null default false,
  link_push         boolean not null default false,
  link_email        boolean not null default false,
  price_push        boolean not null default false,
  price_email       boolean not null default false,
  share_push        boolean not null default false,
  share_email       boolean not null default false,
  -- Коли сервіс востаннє щось надіслав: наступне — не раніше ніж за 3 години,
  -- і все, що назбиралось, приходить одним сповіщенням.
  last_sent_at      timestamptz,
  created_at        timestamptz not null default now()
);

comment on table public.notification_settings is
  'Сповіщення власника (ADR-049): подія × канал. Немає рядка — немає сповіщень, як у v1.';

alter table public.notification_settings enable row level security;
revoke all on public.notification_settings from anon;

create policy notification_settings_select_own on public.notification_settings
  for select to authenticated using (owner_id = auth.uid());

create policy notification_settings_insert_own on public.notification_settings
  for insert to authenticated with check (owner_id = auth.uid());

create policy notification_settings_update_own on public.notification_settings
  for update to authenticated using (owner_id = auth.uid()) with check (owner_id = auth.uid());

create policy notification_settings_delete_own on public.notification_settings
  for delete to authenticated using (owner_id = auth.uid());

-- ─────────────────────────────────────────────
-- push_subscriptions
-- ─────────────────────────────────────────────
--
-- Адреса підписки — секрет рівня токена: хто її знає, той може слати push на
-- пристрій. Тому лише власник її бачить, і ні сервіс, ні застосунок її не
-- логують (CLAUDE.md §3.5 — за аналогією з токенами).

create table public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null default auth.uid() references auth.users(id) on delete cascade,
  -- Адреса служби push: https, без пробілів і керівних символів.
  endpoint   text not null unique check (endpoint ~ '^https://[^[:space:][:cntrl:]]+$' and length(endpoint) <= 1024),
  -- Ключі браузера в base64url: p256dh — 65 байтів точки P-256 (0x04…, тобто
  -- «B» і ще 86 знаків), auth — 16 байтів (22 знаки). Інша форма зламала б
  -- шифрування на боці сервісу, тож вона сюди не потрапляє.
  p256dh     text not null check (p256dh ~ '^B[A-Za-z0-9_-]{86}=?$'),
  auth       text not null check (auth ~ '^[A-Za-z0-9_-]{22}(==)?$'),
  created_at timestamptz not null default now(),
  last_ok_at timestamptz
);

comment on table public.push_subscriptions is
  'Пристрої власника для push (ADR-049). Один пристрій — один власник: підписку забирає той, хто ввімкнув push останнім.';

create index push_subscriptions_owner_idx on public.push_subscriptions (owner_id);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon;

create policy push_subscriptions_select_own on public.push_subscriptions
  for select to authenticated using (owner_id = auth.uid());

-- Вставки, зміни й видалення з клієнта — лише через функції нижче: адреса
-- підписки йде в тілі запиту, а не в рядку адреси, і не осідає в журналах
-- шлюзу API, як осів би фільтр `?endpoint=eq.…`.
revoke insert, update, delete on public.push_subscriptions from authenticated;

-- ─────────────────────────────────────────────
-- save_push_subscription
-- ─────────────────────────────────────────────
--
-- Браузер на одному пристрої дає ту саму підписку будь-кому, хто в ньому
-- ввімкне push. Якщо попередній власник не вийшов з акаунта як слід (сесія
-- протухла), його рядок лишився б — і новий власник отримував би на цьому
-- пристрої чужі сповіщення з назвами чужих списків. Тому підписка переходить
-- до того, хто зберіг її останнім, а старий рядок зникає. Дізнатися, чи
-- адреса комусь належала, з відповіді не можна: функція нічого не повертає.
--
-- Щонайбільше 10 пристроїв на власника: найстаріші відпадають.

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid := auth.uid();
begin
  if v_owner is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  delete from public.push_subscriptions
   where endpoint = p_endpoint and owner_id <> v_owner;

  -- clock_timestamp, а не now(): у межах однієї транзакції now() однаковий,
  -- і «найстаріший» був би невизначений.
  insert into public.push_subscriptions (owner_id, endpoint, p256dh, auth, created_at)
  values (v_owner, p_endpoint, p_p256dh, p_auth, clock_timestamp())
  on conflict (endpoint) do update
    set owner_id = excluded.owner_id, p256dh = excluded.p256dh, auth = excluded.auth,
        created_at = excluded.created_at;

  delete from public.push_subscriptions
   where owner_id = v_owner
     and id not in (select id from public.push_subscriptions
                     where owner_id = v_owner order by created_at desc limit 10);
end;
$$;

revoke execute on function public.save_push_subscription(text, text, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text) to authenticated;

-- ─────────────────────────────────────────────
-- forget_push_subscription
-- ─────────────────────────────────────────────
--
-- «Вимкнути push тут» і вихід з акаунта: прибрати свій пристрій. Чужий рядок
-- із тією самою адресою не чіпає; що він існує, з відповіді не видно.

create or replace function public.forget_push_subscription(p_endpoint text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  delete from public.push_subscriptions where endpoint = p_endpoint and owner_id = auth.uid();
end;
$$;

revoke execute on function public.forget_push_subscription(text) from public, anon;
grant execute on function public.forget_push_subscription(text) to authenticated;

-- ─────────────────────────────────────────────
-- notification_log
-- ─────────────────────────────────────────────
--
-- Що вже надіслано: подія (kind) про предмет (список, позицію чи посилання) з
-- приводу (occurrence — дата свята, стан сторінки, ціна, термін). Той самий
-- привід удруге не надсилається. Пише й читає лише сервіс (service_role);
-- власникові цей журнал нічого не дає, тож доступу до нього немає.

create table public.notification_log (
  owner_id   uuid not null references auth.users(id) on delete cascade,
  kind       text not null check (kind in ('after_event', 'yearly', 'link', 'price', 'share')),
  subject_id uuid not null,
  occurrence text not null check (length(occurrence) between 1 and 100),
  channels   text[] not null default '{}',
  sent_at    timestamptz not null default now(),
  primary key (owner_id, kind, subject_id, occurrence)
);

comment on table public.notification_log is
  'Надіслані сповіщення (ADR-049): щоб той самий привід не приходив удруге. Лише для сервісу wishlist-jobs.';

alter table public.notification_log enable row level security;
revoke all on public.notification_log from anon, authenticated;
