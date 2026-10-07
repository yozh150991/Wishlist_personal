-- 20261008090000_guest_changes.sql
-- Гостьова v2, крок 5б-2: гостю — про зміну чи видалення позиції, яку він
-- узяв (потік J), і нагадування за 7 днів до свята (P5). ADR-055.
--
-- Що змінюється:
--   * claims.changed_at — власник змінив назву, посилання чи ціну позиції, яку
--     взяв гість. Гість бачить «Змінено» з «Лишити / Зняти»; «Лишити» знімає
--     позначку (ack_claim_change);
--   * тригери на items ставлять у чергу листи 'changed' і 'deleted' — лише
--     гостям, які лишили пошту й не відписались. Кілька правок поспіль до
--     відправки зливаються в один лист;
--   * enqueue_guest_reminders раз на день (pg_cron) ставить 'reminder' гостям,
--     у яких щось узято, за 7 днів до дати списку — один раз на дату.
--
-- ІНВАРІАНТ (CLAUDE.md §3.2; ADR-040, п. 2 J і п. 4): власник не дізнається,
-- чи позицію хтось узяв. Тригери пишуть лише в закриті гостьові таблиці й
-- нічого не повертають; помилка будь-якого гостьового кроку ковтається, тож
-- правка й видалення позиції ніколи не залежать від позначок. Лист не
-- відправляється в запиті власника — лише стає в чергу, а будить сервіс
-- pg_net уже після коміту (ADR-054). Різниця в часі відповіді — вставка
-- кількох рядків, як і в release_item_claims (ADR-035).

-- ─────────────────────────────────────────────
-- Колонки
-- ─────────────────────────────────────────────

alter table public.claims add column changed_at timestamptz;

comment on column public.claims.changed_at is
  'Власник змінив назву, посилання чи ціну після позначки (потік J). Бачить лише цей гість; «Лишити» скидає. Власник не має доступу (CLAUDE.md §3.2).';

alter table public.guest_identities
  add column locale text check (locale is null or locale in ('uk', 'pl', 'en'));

comment on column public.guest_identities.locale is
  'Мова гостьової під час останньої броні — нею пишемо листи, які гість сам не просив (зміна, видалення, нагадування).';

alter table public.guest_mail add column details jsonb;

comment on column public.guest_mail.details is
  'Що сказати в листі, знімком на момент події: для changed — {old, new} (назва, посилання, ціна, валюта), для deleted — {title}, для reminder — {event_date, items}. Ні адреси, ні ключа, ні токена.';

alter table public.guest_mail drop constraint guest_mail_kind_check;
alter table public.guest_mail drop constraint guest_mail_check;
alter table public.guest_mail
  add constraint guest_mail_kind_check
    check (kind in ('claim', 'code', 'changed', 'deleted', 'reminder')),
  add constraint guest_mail_item_check
    check ((kind in ('claim', 'changed')) = (item_id is not null));

-- ─────────────────────────────────────────────
-- Поставити лист у чергу (внутрішнє) — тепер із details
-- ─────────────────────────────────────────────
--
-- Відписка діє на все, крім коду: його людина просить сама. Правка тієї самої
-- позиції, поки попередній лист ще не взятий сервісом, не додає новий рядок,
-- а оновлює «стало» в наявному: «було» лишається з першої правки.

drop function public.enqueue_guest_mail(uuid, uuid, text, uuid, text);

create or replace function public.enqueue_guest_mail(
  p_identity uuid,
  p_share    uuid,
  p_kind     text,
  p_item     uuid,
  p_locale   text,
  p_details  jsonb default null
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email   text;
  v_off     boolean;
  v_pending uuid;
begin
  select email, mail_off into v_email, v_off from public.guest_identities where id = p_identity;
  if v_email is null or p_share is null then
    return false;
  end if;
  if p_kind <> 'code' and v_off then
    return false;
  end if;

  if p_kind = 'changed' then
    select id into v_pending
      from public.guest_mail
     where identity_id = p_identity and item_id = p_item and kind = 'changed'
       and sent_at is null and locked_at is null
     limit 1
     for update;
    if v_pending is not null then
      update public.guest_mail
         set details = jsonb_build_object('old', details->'old', 'new', p_details->'new')
       where id = v_pending;
      return true;
    end if;
  end if;

  if (select count(*) from public.guest_mail
       where identity_id = p_identity and created_at > now() - interval '1 hour') >= 10 then
    return false;
  end if;
  insert into public.guest_mail (identity_id, share_id, kind, item_id, locale, details)
  values (p_identity, p_share, p_kind, p_item,
          case when p_locale in ('uk', 'pl', 'en') then p_locale else 'uk' end,
          p_details);
  return true;
end;
$$;

-- Найсвіжіше живе посилання з цією позицією: адреса /l/{токен} у листі.
create or replace function public.live_share_of_item(p_item uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select s.id
    from public.share_items si
    join public.shares s on s.id = si.share_id
   where si.item_id = p_item
     and s.revoked_at is null
     and (s.expires_at is null or s.expires_at > now())
   order by s.created_at desc
   limit 1;
$$;

-- ─────────────────────────────────────────────
-- claim_item_v2 — тепер запамʼятовує мову гостя
-- ─────────────────────────────────────────────

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
     set name   = case when p_name  is null then name  else v_name  end,
         email  = case when p_email is null then email else v_email end,
         locale = case when p_locale in ('uk', 'pl', 'en') then p_locale else locale end
   where id = v_identity
  returning name, email into v_name, v_email;

  perform public.enqueue_guest_mail(v_identity, v_share.id, 'claim', p_item_id, p_locale);

  return v_result || jsonb_build_object('name', v_name, 'email', v_email);
end;
$$;

-- ─────────────────────────────────────────────
-- J: власник змінив позицію, яку взяли
-- ─────────────────────────────────────────────
--
-- Значуща зміна — назва, посилання, ціна чи валюта (потік J). Нотатка,
-- пріоритет, порядок і статус проходять мовчки.

create or replace function public.guest_item_changed_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_currency text;
  v_share    uuid;
  v_details  jsonb;
  r          record;
begin
  begin
    if not exists (select 1 from public.claims where item_id = new.id) then
      return null;
    end if;

    update public.claims set changed_at = now() where item_id = new.id;

    v_share := public.live_share_of_item(new.id);
    if v_share is null then
      return null;
    end if;

    select currency into v_currency from public.lists where id = new.list_id;
    v_details := jsonb_build_object(
      'old', jsonb_build_object('title', old.title, 'url', old.url, 'price', old.price,
                                'currency', coalesce(old.currency, v_currency)),
      'new', jsonb_build_object('title', new.title, 'url', new.url, 'price', new.price,
                                'currency', coalesce(new.currency, v_currency))
    );

    for r in
      select c.identity_id, g.locale
        from public.claims c
        join public.guest_identities g on g.id = c.identity_id
       where c.item_id = new.id
    loop
      perform public.enqueue_guest_mail(r.identity_id, v_share, 'changed', new.id, coalesce(r.locale, 'uk'), v_details);
    end loop;
  exception when others then
    -- Правка власника не залежить від позначок ніколи (ADR-038).
    null;
  end;
  return null;
end;
$$;

create trigger items_guest_changed
  after update of title, url, price, currency on public.items
  for each row
  when (old.title is distinct from new.title
        or old.url is distinct from new.url
        or old.price is distinct from new.price
        or old.currency is distinct from new.currency)
  execute function public.guest_item_changed_trg();

-- ─────────────────────────────────────────────
-- J: власник видалив позицію, яку взяли
-- ─────────────────────────────────────────────
--
-- BEFORE: позначки й рядки посилань ще на місці, а після видалення їх зітре
-- каскад. Назва — знімком у details, бо позиції вже не буде.

create or replace function public.guest_item_deleted_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share uuid;
  r       record;
begin
  begin
    if not exists (select 1 from public.claims where item_id = old.id) then
      return old;
    end if;
    v_share := public.live_share_of_item(old.id);
    if v_share is null then
      return old;
    end if;
    for r in
      select c.identity_id, g.locale
        from public.claims c
        join public.guest_identities g on g.id = c.identity_id
       where c.item_id = old.id
    loop
      perform public.enqueue_guest_mail(r.identity_id, v_share, 'deleted', null, coalesce(r.locale, 'uk'),
                                        jsonb_build_object('title', old.title));
    end loop;
  exception when others then
    null;
  end;
  return old;
end;
$$;

create trigger items_guest_deleted
  before delete on public.items
  for each row execute function public.guest_item_deleted_trg();

-- Гість зняв бронь — лист про зміну, що ще чекає, уже ні до чого.
create or replace function public.guest_claim_released_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.guest_mail
   where identity_id = old.identity_id and item_id = old.item_id
     and kind = 'changed' and sent_at is null and locked_at is null;
  return null;
end;
$$;

create trigger claims_guest_released
  after delete on public.claims
  for each row execute function public.guest_claim_released_trg();

-- ─────────────────────────────────────────────
-- ack_claim_change — «Лишити» після зміни
-- ─────────────────────────────────────────────

create or replace function public.ack_claim_change(p_token text, p_item_id uuid, p_key text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share    public.shares;
  v_list_id  uuid;
  v_identity uuid;
begin
  v_share := public.live_share(p_token);
  if v_share.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if auth.uid() is not null and auth.uid() = v_share.owner_id then
    raise exception 'owner_cannot_reserve' using errcode = '22023';
  end if;

  select i.list_id into v_list_id
    from public.items i
    join public.share_items si on si.item_id = i.id and si.share_id = v_share.id
   where i.id = p_item_id;
  if v_list_id is null then
    raise exception 'item_not_in_share' using errcode = 'P0002';
  end if;

  v_identity := public.guest_identity_of(v_list_id, p_key);
  if v_identity is not null then
    update public.claims set changed_at = null
     where item_id = p_item_id and identity_id = v_identity;
  end if;
end;
$$;

-- ─────────────────────────────────────────────
-- get_guest_list — плюс «Змінено» на своїх позиціях
-- ─────────────────────────────────────────────
--
-- `changed: true` — лише на позиціях, які взяв саме цей гість. Інші гості й
-- власник цього поля не отримують ніколи.

create or replace function public.get_guest_list(p_token text, p_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_body     jsonb;
  v_share    public.shares;
  v_identity uuid;
  v_contact  jsonb;
  v_items    jsonb;
begin
  v_body := public.get_shared_list(p_token, p_key);
  if jsonb_typeof(v_body->'guest') is distinct from 'object' then
    return v_body;
  end if;

  v_share := public.live_share(p_token);
  v_identity := public.guest_identity_of(v_share.source_list_id, p_key);

  select jsonb_build_object('name', g.name, 'email', g.email)
    into v_contact
    from public.guest_identities g
   where g.id = v_identity;

  select coalesce(jsonb_agg(
           case when c.changed_at is not null then e || jsonb_build_object('changed', true) else e end
           order by t.ord), '[]'::jsonb)
    into v_items
    from jsonb_array_elements(v_body->'items') with ordinality as t(e, ord)
    left join public.claims c
      on c.identity_id = v_identity and c.item_id = (t.e->>'id')::uuid;

  return jsonb_set(
    jsonb_set(v_body, '{guest}', (v_body->'guest') || coalesce(v_contact, '{}'::jsonb)),
    '{items}', v_items
  );
end;
$$;

-- ─────────────────────────────────────────────
-- Нагадування гостю за 7 днів (P5)
-- ─────────────────────────────────────────────
--
-- Раз на день: списки з датою рівно через 7 днів за поясом власника
-- (налаштування сповіщень, інакше Варшава), не архівні. Гостям, у яких щось
-- узято на актуальних позиціях, є пошта й немає відписки, — один лист на
-- дату. Що саме взято — знімком назв, тож сервіс листів позначок не читає.

create or replace function public.enqueue_guest_reminders()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer := 0;
  v_share uuid;
  r       record;
begin
  for r in
    select l.id as list_id, l.event_date, g.id as identity_id, g.locale,
           jsonb_agg(i.title order by i.position nulls first, i.created_at) as titles,
           array_agg(i.id) as item_ids
      from public.lists l
      left join public.notification_settings ns on ns.owner_id = l.owner_id
      join public.guest_identities g on g.list_id = l.id
      join public.claims c on c.identity_id = g.id
      join public.items i on i.id = c.item_id and i.status = 'active'
     where not l.is_archived
       and l.event_date is not null
       and l.event_date = (now() at time zone coalesce(ns.time_zone, 'Europe/Warsaw'))::date + 7
       and g.email is not null
       and not g.mail_off
     group by l.id, l.event_date, g.id, g.locale
  loop
    begin
      if exists (select 1 from public.guest_mail
                  where identity_id = r.identity_id and kind = 'reminder'
                    and details->>'event_date' = r.event_date::text) then
        continue;
      end if;
      select s.id into v_share
        from public.share_items si
        join public.shares s on s.id = si.share_id
       where si.item_id = any (r.item_ids)
         and s.revoked_at is null
         and (s.expires_at is null or s.expires_at > now())
       order by s.created_at desc
       limit 1;
      if v_share is null then
        continue;
      end if;
      if public.enqueue_guest_mail(r.identity_id, v_share, 'reminder', null, coalesce(r.locale, 'uk'),
                                   jsonb_build_object('event_date', r.event_date, 'items', r.titles)) then
        v_count := v_count + 1;
      end if;
    exception when others then
      null;
    end;
  end loop;
  return v_count;
end;
$$;

do $$
begin
  if to_regnamespace('cron') is not null then
    -- 07:05 UTC — 9:05 улітку й 8:05 узимку за Варшавою.
    perform cron.schedule('guest-reminders', '5 7 * * *', 'select public.enqueue_guest_reminders()');
  end if;
end $$;

-- ─────────────────────────────────────────────
-- Права (CLAUDE.md §3.4)
-- ─────────────────────────────────────────────

revoke all on function public.enqueue_guest_mail(uuid, uuid, text, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function public.live_share_of_item(uuid)                                 from public, anon, authenticated;
revoke all on function public.guest_item_changed_trg()                                  from public, anon, authenticated;
revoke all on function public.guest_item_deleted_trg()                                  from public, anon, authenticated;
revoke all on function public.guest_claim_released_trg()                                from public, anon, authenticated;
revoke all on function public.enqueue_guest_reminders()                                 from public, anon, authenticated;
revoke all on function public.ack_claim_change(text, uuid, text)                        from public;
grant execute on function public.ack_claim_change(text, uuid, text)                     to anon, authenticated;
