-- 20261007100000_guest_mail.sql
-- Гостьова v2, крок 5б-1: черга гостьових листів, «Надіслати код на пошту»,
-- відписка від листів списку (ADR-041, п. 3, 4, 8; ADR-054).
--
-- Як іде лист:
--   1. Гостьова RPC (бронь із поштою, «Надіслати код») кладе рядок у
--      guest_mail — у тій самій транзакції, що й сама дія. Адреси в рядку
--      немає: вона береться з ідентичності в момент відправки, тож відписка
--      чи прибрана пошта діють і на те, що вже стоїть у черзі.
--   2. Тригер на guest_mail будить сервіс wishlist-guestmail через pg_net:
--      net.http_post кладе запит у свою чергу, а відправляє його фоновий
--      процес уже після коміту. Гість не чекає на Brevo, і запит гостя чи
--      власника не стає повільнішим через те, чи є кому писати (ADR-040, п. 4).
--   3. Сигнал не несе даних — лише секрет із Vault. Сервіс сам читає чергу
--      secret-ключем, відправляє через Brevo й позначає надіслане.
--   4. pg_cron раз на 10 хвилин будить сервіс ще раз, якщо в черзі щось
--      лишилось: pg_net не повторює запитів («вистрілив і забув»).
--
-- Адреса сервісу й секрет живуть у Supabase Vault ('guest_mail_url',
-- 'guest_mail_secret'), а не в цій міграції (DEPLOY.md, розділ 10). Поки їх
-- немає, листи просто чекають у черзі — жодна гостьова дія не ламається.
--
-- ІНВАРІАНТ (CLAUDE.md §3.2): guest_mail, як і решта гостьових таблиць, без
-- політик і без грантів anon/authenticated. Власник не дізнається ні про
-- листи, ні про пошту гостей.

-- ─────────────────────────────────────────────
-- Розширення (на Supabase є; на голому Postgres — пропускаємо)
-- ─────────────────────────────────────────────

do $$
begin
  if exists (select 1 from pg_available_extensions where name = 'pg_net') then
    create extension if not exists pg_net;
  end if;
  if exists (select 1 from pg_available_extensions where name = 'pg_cron') then
    create extension if not exists pg_cron;
  end if;
end $$;

-- ─────────────────────────────────────────────
-- Відписка: на ідентичність, тобто на один список
-- ─────────────────────────────────────────────

alter table public.guest_identities
  add column mail_off   boolean not null default false,
  -- Секрет посилання «Не надсилати листів про цей список». Окремий від ключа
  -- гостя: лист — постійне сховище, а ключ туди не йде ніколи (ADR-041, п. 3).
  add column mail_token text not null default public.gen_share_token();

create unique index guest_identities_mail_token_key on public.guest_identities (mail_token);

comment on column public.guest_identities.mail_off is
  'Гість відписався від листів про цей список (одним натиском з листа). Код на пошту на прохання гостя все одно йде.';
comment on column public.guest_identities.mail_token is
  'Секрет посилання відписки в листі. Дає лише право вимкнути чи ввімкнути листи цієї ідентичності.';

-- ─────────────────────────────────────────────
-- Черга
-- ─────────────────────────────────────────────

create table public.guest_mail (
  id          uuid primary key default gen_random_uuid(),
  identity_id uuid not null references public.guest_identities(id) on delete cascade,
  -- Посилання, з якого гість діяв: адреса /l/{токен} у листі — саме його.
  share_id    uuid not null references public.shares(id) on delete cascade,
  kind        text not null check (kind in ('claim', 'code')),
  item_id     uuid references public.items(id) on delete cascade,
  locale      text not null check (locale in ('uk', 'pl', 'en')),
  created_at  timestamptz not null default now(),
  -- Сервіс бере рядок, ставлячи locked_at; узятий понад 10 хвилин тому
  -- вважається загубленим і береться знову.
  locked_at   timestamptz,
  attempts    integer not null default 0 check (attempts between 0 and 10),
  sent_at     timestamptz,
  -- sent — пішов у Brevo; skipped — нікому чи нема про що (пошту прибрано,
  -- відписка, посилання згасло).
  outcome     text check (outcome in ('sent', 'skipped')),
  check ((kind = 'claim') = (item_id is not null)),
  check ((sent_at is null) = (outcome is null))
);

comment on table public.guest_mail is
  'Черга гостьових листів (ADR-054). Ні адреси, ні ключа: адреса — з ідентичності в момент відправки. ІНВАРІАНТ: власник не має доступу (CLAUDE.md §3.2).';

create index guest_mail_due_idx on public.guest_mail (created_at) where sent_at is null;
create index guest_mail_identity_idx on public.guest_mail (identity_id, created_at);

alter table public.guest_mail enable row level security;
revoke all on public.guest_mail from anon, authenticated;
grant select, insert, update, delete on public.guest_mail to service_role;
-- ↑ ІНВАРІАНТ: жодної політики. Пишуть гостьові RPC, читає й позначає —
--   лише сервіс wishlist-guestmail secret-ключем.

-- ─────────────────────────────────────────────
-- Розбудити сервіс
-- ─────────────────────────────────────────────
--
-- Нічого не повертає й ніколи не падає: збій сигналу не має відкотити бронь.
-- Без Vault, без pg_net чи без налаштованих секретів — тихо нічого.

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
  if not exists (select 1 from public.guest_mail where sent_at is null) then
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

create or replace function public.guest_mail_wake_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform public.wake_guest_mail();
  return null;
end;
$$;

create trigger guest_mail_wake
  after insert on public.guest_mail
  for each statement execute function public.guest_mail_wake_trg();

-- ─────────────────────────────────────────────
-- Поставити лист у чергу (внутрішнє)
-- ─────────────────────────────────────────────
--
-- Лист на бронь — лише якщо пошта є й гість не відписався. Ліміт — 10 листів
-- на годину на ідентичність: бронь і зняття по колу з чужою адресою не
-- стають розсилкою.

create or replace function public.enqueue_guest_mail(
  p_identity uuid,
  p_share    uuid,
  p_kind     text,
  p_item     uuid,
  p_locale   text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_off   boolean;
begin
  select email, mail_off into v_email, v_off from public.guest_identities where id = p_identity;
  if v_email is null then
    return false;
  end if;
  if p_kind = 'claim' and v_off then
    return false;
  end if;
  if (select count(*) from public.guest_mail
       where identity_id = p_identity and created_at > now() - interval '1 hour') >= 10 then
    return false;
  end if;
  insert into public.guest_mail (identity_id, share_id, kind, item_id, locale)
  values (p_identity, p_share, p_kind, p_item,
          case when p_locale in ('uk', 'pl', 'en') then p_locale else 'uk' end);
  return true;
end;
$$;

-- ─────────────────────────────────────────────
-- claim_item_v2 — тепер ще й лист на бронь
-- ─────────────────────────────────────────────
--
-- Нова сигнатура з p_locale (мова гостьової в момент броні, ADR-041, п. 3).
-- Стару прибираємо: виклик без p_locale з фронтенду 5а підхоплює усталене.

drop function public.claim_item_v2(text, uuid, text, integer, text, text);

create or replace function public.claim_item_v2(
  p_token    text,
  p_item_id  uuid,
  p_key      text,
  p_quantity integer default 1,
  p_name     text default null,
  p_email    text default null,
  p_locale   text default 'uk'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name     text;
  v_email    text;
  v_result   jsonb;
  v_share    public.shares;
  v_identity uuid;
begin
  if p_name is not null then
    v_name := nullif(btrim(p_name), '');
    if v_name is not null and (char_length(v_name) > 60 or v_name ~ '[[:cntrl:]]') then
      raise exception 'bad_name' using errcode = '22023';
    end if;
  end if;

  if p_email is not null then
    v_email := lower(nullif(btrim(p_email), ''));
    if v_email is not null
       and (char_length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
      raise exception 'bad_email' using errcode = '22023';
    end if;
  end if;

  -- Позначка, ліміт, гонка, власник і мертве посилання — рівно як у v1.
  v_result := public.claim_item(p_token, p_item_id, p_key, p_quantity);

  v_share := public.live_share(p_token);
  v_identity := public.guest_identity_of(v_share.source_list_id, p_key);

  update public.guest_identities
     set name  = case when p_name  is null then name  else v_name  end,
         email = case when p_email is null then email else v_email end
   where id = v_identity
  returning name, email into v_name, v_email;

  perform public.enqueue_guest_mail(v_identity, v_share.id, 'claim', p_item_id, p_locale);

  return v_result || jsonb_build_object('name', v_name, 'email', v_email);
end;
$$;

-- ─────────────────────────────────────────────
-- send_guest_code — «Надіслати код на пошту»
-- ─────────────────────────────────────────────
--
-- Відповідь однакова, є така адреса в цьому списку чи ні (ADR-041, п. 4).
-- Ліміт спільний зі спробами коду — 5 на годину на список, і він так само
-- каже про себе прямо. Відписка тут не діє: код людина просить сама.

create or replace function public.send_guest_code(p_token text, p_email text, p_locale text default 'uk')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share    public.shares;
  v_list_id  uuid;
  v_email    text;
  v_attempts integer;
  r          record;
begin
  v_share := public.live_share(p_token);
  if v_share.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if auth.uid() is not null and auth.uid() = v_share.owner_id then
    raise exception 'owner_cannot_reserve' using errcode = '22023';
  end if;
  v_list_id := v_share.source_list_id;

  -- Той самий журнал і те саме блокування, що в redeem_guest_code.
  perform 1 from public.lists where id = v_list_id for update;
  delete from public.guest_code_attempts
   where list_id = v_list_id and attempted_at < now() - interval '1 hour';
  select count(*) into v_attempts from public.guest_code_attempts where list_id = v_list_id;
  if v_attempts >= 5 then
    return jsonb_build_object('error', 'too_many_attempts');
  end if;
  insert into public.guest_code_attempts (list_id) values (v_list_id);

  v_email := lower(btrim(coalesce(p_email, '')));
  if v_email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
    for r in
      select id from public.guest_identities
       where list_id = v_list_id and email = v_email
       order by last_seen desc
       limit 3
    loop
      perform public.enqueue_guest_mail(r.id, v_share.id, 'code', null, p_locale);
    end loop;
  end if;

  return jsonb_build_object('ok', true);
end;
$$;

-- ─────────────────────────────────────────────
-- guest_mail_set — «Не надсилати листів про цей список» і назад
-- ─────────────────────────────────────────────
--
-- Одним натиском із листа, без входу й без ключа гостя: секрет — mail_token
-- із посилання. Відповідь однакова, чи такий токен є: нічого не підтверджує.

create or replace function public.guest_mail_set(p_mail_token text, p_on boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_mail_token is null or p_mail_token !~ '^[A-Za-z0-9_-]{16,64}$' or p_on is null then
    return;
  end if;
  update public.guest_identities set mail_off = not p_on where mail_token = p_mail_token;
end;
$$;

-- ─────────────────────────────────────────────
-- pg_cron: добір того, що не дійшло
-- ─────────────────────────────────────────────

do $$
begin
  if to_regnamespace('cron') is not null then
    perform cron.schedule('guest-mail-sweep', '*/10 * * * *', 'select public.wake_guest_mail()');
  end if;
end $$;

-- ─────────────────────────────────────────────
-- Права (CLAUDE.md §3.4)
-- ─────────────────────────────────────────────

revoke all on function public.wake_guest_mail()                                    from public, anon, authenticated;
revoke all on function public.guest_mail_wake_trg()                                from public, anon, authenticated;
revoke all on function public.enqueue_guest_mail(uuid, uuid, text, uuid, text)     from public, anon, authenticated;
revoke all on function public.claim_item_v2(text, uuid, text, integer, text, text, text) from public;
revoke all on function public.send_guest_code(text, text, text)                    from public;
revoke all on function public.guest_mail_set(text, boolean)                        from public;

grant execute on function public.claim_item_v2(text, uuid, text, integer, text, text, text) to anon, authenticated;
grant execute on function public.send_guest_code(text, text, text)                    to anon, authenticated;
grant execute on function public.guest_mail_set(text, boolean)                        to anon, authenticated;
