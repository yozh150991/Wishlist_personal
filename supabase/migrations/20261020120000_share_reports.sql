-- 20261020120000_share_reports.sql
-- Гостьова v2, крок 5д (ADR-061): «Поскаржитись» на гостьовій (потік W3).
--
-- Що змінюється:
--   * share_reports — скарги гостей на посилання: причина з переліку,
--     необов'язковий коментар, мова. Читає й позначає лише сервіс
--     wishlist-guestmail secret-ключем; ні власник, ні гості доступу не мають
--     (RLS без політик, гранти лише service_role);
--   * report_share — гостьова RPC: скарга на живе посилання, з лімітом
--     частоти на посилання й загальним. Власник на своєму посиланні
--     скаржитись не може. Нічого не повертає;
--   * wake_guest_mail будить сервіс і тоді, коли в черзі є лише скарги:
--     той самий сигнал pg_net і той самий добір pg_cron раз на 10 хвилин.
--
-- Скарга йде операторові застосунку листом на адресу MAIL_FROM. Власник
-- списку про скаргу не дізнається; токена посилання в листі немає — лише
-- id посилання, за яким оператор знайде його в базі (CLAUDE.md §3.5).

create table public.share_reports (
  id         uuid primary key default gen_random_uuid(),
  -- Посилання могли вже видалити — скарга лишається з тим, що відомо.
  share_id   uuid references public.shares(id) on delete set null,
  -- Знімок на момент скарги: оператор має знати, чий це список, навіть коли
  -- посилання вже немає. Без FK — видалення акаунта скаргу не стирає.
  owner_id   uuid not null,
  reason     text not null check (reason in ('spam', 'scam', 'offensive', 'illegal', 'other')),
  comment    text check (comment is null or char_length(comment) between 1 and 1000),
  locale     text not null check (locale in ('uk', 'pl', 'en')),
  created_at timestamptz not null default now(),
  locked_at  timestamptz,
  attempts   integer not null default 0 check (attempts between 0 and 10),
  sent_at    timestamptz
);

comment on table public.share_reports is
  'Скарги гостей на посилання (ADR-061). Читає лише wishlist-guestmail secret-ключем; власник і гості доступу не мають.';

create index share_reports_due_idx   on public.share_reports (created_at) where sent_at is null;
create index share_reports_share_idx on public.share_reports (share_id, created_at);

alter table public.share_reports enable row level security;
revoke all on public.share_reports from anon, authenticated;
grant select, insert, update, delete on public.share_reports to service_role;
-- ↑ ІНВАРІАНТ: жодної політики. Пише report_share, читає й позначає — лише
--   сервіс wishlist-guestmail.

-- ─────────────────────────────────────────────
-- report_share — гостьова RPC
-- ─────────────────────────────────────────────
--
-- Ліміти без IP (його ми не зберігаємо): не більше 5 скарг на посилання за
-- годину і не більше 50 на весь застосунок — щоб форма не стала способом
-- засипати оператора листами.

create or replace function public.report_share(
  p_token   text,
  p_reason  text,
  p_comment text default null,
  p_locale  text default 'uk'
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share   public.shares;
  v_comment text := nullif(btrim(coalesce(p_comment, '')), '');
begin
  v_share := public.live_share(p_token);
  if v_share.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if auth.uid() is not null and auth.uid() = v_share.owner_id then
    raise exception 'owner_cannot_report' using errcode = '22023';
  end if;
  if p_reason is null or p_reason not in ('spam', 'scam', 'offensive', 'illegal', 'other') then
    raise exception 'bad_reason' using errcode = '22023';
  end if;
  if v_comment is not null and char_length(v_comment) > 1000 then
    raise exception 'bad_comment' using errcode = '22023';
  end if;

  if (select count(*) from public.share_reports
       where share_id = v_share.id and created_at > now() - interval '1 hour') >= 5
     or (select count(*) from public.share_reports
          where created_at > now() - interval '1 hour') >= 50 then
    raise exception 'rate_limited' using errcode = '22023';
  end if;

  insert into public.share_reports (share_id, owner_id, reason, comment, locale)
  values (v_share.id, v_share.owner_id, p_reason, v_comment,
          case when p_locale in ('uk', 'pl', 'en') then p_locale else 'uk' end);

  -- Сигнал сервісу; без налаштувань чи pg_net — тихо нічого, скаргу забере pg_cron.
  perform public.wake_guest_mail();
end;
$$;

revoke all on function public.report_share(text, text, text, text) from public;
grant execute on function public.report_share(text, text, text, text) to anon, authenticated;

-- ─────────────────────────────────────────────
-- wake_guest_mail — будить і на скарги
-- ─────────────────────────────────────────────
--
-- Те саме, що в 20261007100000_guest_mail, крім умови «є що робити».

create or replace function public.wake_guest_mail()
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_url    text;
  v_secret text;
begin
  if to_regclass('vault.decrypted_secrets') is null
     or not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                     where n.nspname = 'net' and p.proname = 'http_post') then
    return;
  end if;
  if not exists (select 1 from public.guest_mail where sent_at is null)
     and not exists (select 1 from public.share_reports where sent_at is null) then
    return;
  end if;

  begin
    select decrypted_secret into v_url    from vault.decrypted_secrets where name = 'guest_mail_url'    limit 1;
    select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'guest_mail_secret' limit 1;
    if v_url is null or v_secret is null or v_url !~ '^https://' then
      return;
    end if;
    perform net.http_post(
      url                  := v_url,
      body                 := '{}'::jsonb,
      headers              := jsonb_build_object('content-type', 'application/json', 'x-wake-secret', v_secret),
      timeout_milliseconds := 5000
    );
  exception when others then
    -- Лист дочекається наступного сигналу або pg_cron.
    return;
  end;
end;
$$;

revoke all on function public.wake_guest_mail() from public, anon, authenticated;
