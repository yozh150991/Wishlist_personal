-- Вхід із нового пристрою (ADR-074).
--
-- Хто й звідки увійшов, знає лише Supabase Auth: кожен вхід — новий рядок
-- `auth.sessions` з User-Agent і IP запиту. Сервіс wishlist-jobs щогодини
-- бере нові сесії (`recent_sign_ins`), зводить User-Agent до «браузер ·
-- система» і порівнює з пристроями, які вже бачив (`known_devices`). Новий
-- пристрій у акаунта, що вже мав інші, — лист (і push, якщо ввімкнено),
-- одразу, без тиші 22:00–9:00 і без об'єднання з іншими сповіщеннями.
--
-- Сповіщення бачить лише сервер, тож вхід в обхід застосунку (прямо через API
-- Supabase) теж помітний. Ціна — до години затримки.
--
-- Типово лист увімкнений для всіх, навіть без рядка налаштувань: це
-- сповіщення безпеки, а не новин (рішення власника). Вимкнути можна в
-- картці «Безпека» в Налаштуваннях.

-- ─────────────────────────────────────────────
-- Канали
-- ─────────────────────────────────────────────

alter table public.notification_settings
  add column signin_push  boolean not null default false,
  add column signin_email boolean not null default true;

comment on column public.notification_settings.signin_email is
  'Лист про вхід із нового пристрою (ADR-074). Немає рядка налаштувань — однаково true: сервіс шле лист і без нього.';

-- ─────────────────────────────────────────────
-- Пристрої, які вже бачили
-- ─────────────────────────────────────────────

-- `device` — «браузер · система» (Chrome · Android) без версій: оновлення
-- браузера не робить пристрій новим. Ні IP, ні повного User-Agent тут немає.
create table public.known_devices (
  owner_id   uuid not null references auth.users(id) on delete cascade,
  device     text not null check (length(device) between 1 and 80),
  first_seen timestamptz not null default now(),
  primary key (owner_id, device)
);

comment on table public.known_devices is
  'Пристрої («браузер · система»), з яких уже входили (ADR-074). Пише й читає лише wishlist-jobs.';

alter table public.known_devices enable row level security;
-- Політик немає: таблиця — службова, клієнтам у ній нічого робити.
revoke all on public.known_devices from public, anon, authenticated;

-- ─────────────────────────────────────────────
-- recent_sign_ins — лише для wishlist-jobs
-- ─────────────────────────────────────────────

-- PostgREST схеми auth не публікує, тож сервіс читає сесії лише через цю
-- функцію й лише вузько: коли, з якого браузера й з якої адреси. IP іде в
-- лист власникові й ніде не зберігається.
create or replace function public.recent_sign_ins(p_since timestamptz, p_limit integer default 1000)
returns table (session_id uuid, user_id uuid, created_at timestamptz, user_agent text, ip text)
language sql
stable
security definer
set search_path = public
as $$
  select s.id, s.user_id, s.created_at, s.user_agent, host(s.ip)
    from auth.sessions s
   where s.created_at > p_since
   order by s.created_at
   limit greatest(1, least(coalesce(p_limit, 1000), 5000));
$$;

comment on function public.recent_sign_ins(timestamptz, integer) is
  'Сесії Supabase Auth, створені після p_since (ADR-074): час, User-Agent і IP входу. Лише для wishlist-jobs.';

revoke execute on function public.recent_sign_ins(timestamptz, integer) from public, anon, authenticated;
grant execute on function public.recent_sign_ins(timestamptz, integer) to service_role;

-- ─────────────────────────────────────────────
-- forget_all_push_subscriptions — «Вийти на всіх пристроях»
-- ─────────────────────────────────────────────

-- Вихід скрізь знімає сесії, але push на загублений телефон приходив би й
-- далі — з назвами списків. Тож разом із виходом зникають усі підписки
-- власника. Напряму рядки push_subscriptions клієнт не видаляє (ADR-049).
create or replace function public.forget_all_push_subscriptions()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  delete from public.push_subscriptions where owner_id = auth.uid();
end;
$$;

comment on function public.forget_all_push_subscriptions() is
  'Прибирає всі push-підписки власника — частина «Вийти на всіх пристроях» (ADR-074). Нічого не повертає.';

revoke execute on function public.forget_all_push_subscriptions() from public, anon;
grant execute on function public.forget_all_push_subscriptions() to authenticated;
