-- 20261123070305_pool_received.sql
-- ROADMAP 8.14: збір — «обіцяно» й «отримано» (доповнює ADR-063, ADR-064).
--
-- Організатор збору сам позначає внесок отриманим, коли гроші до нього
-- дійшли; застосунок їх, як і раніше, не переказує й не перевіряє (ADR-063).
--
-- Що змінюється:
--   * gift_pool_pledges.received_at — коли організатор позначив внесок
--     отриманим; null (усталене) — як досі: лише обіцянка. І gift_pool_pledges.id —
--     непрозорий ідентифікатор внеску, щоб організатор міг на нього вказати,
--     не знаючи ідентичності учасника;
--   * set_pledge_received(token, pool, key, pledge, received) — ставить і знімає
--     позначку. Лише організатор цього збору, за ключем гостя й живим токеном.
--     Мертве посилання — not_found, як скрізь. Решта — власник списку, інший
--     гість, гість без ключа, чужий чи неіснуючий збір — одна відповідь
--     not_organizer, і вона не залежить від того, чи є такий збір і внесок;
--   * pledge_pool: зміна суми знімає позначку (організатор отримав іншу суму);
--     та сама сума — позначка лишається;
--   * get_guest_list: у `pool` ще `received` (скільки отримано, сума) і
--     `mine_received` (мій внесок отримано); організатору в `pledges` — ще `id`
--     і `received`. Власник, як і раніше, отримує відповідь до збагачення;
--   * get_my_gifts: у `pool` — `received` і `mine_received`;
--   * лист `pool_received` учаснику з поштою через ту саму чергу guest_mail
--     (ADR-064): один на внесок у зборі, організатору про себе — ні.
--
-- Інваріант CLAUDE.md §3.2 не зачеплено: власник не бачить ні позначки, ні
-- сум; жодна його відповідь від позначки не залежить. Таблиці, як і раніше,
-- без політик і грантів для anon/authenticated.

-- ─────────────────────────────────────────────
-- Колонки
-- ─────────────────────────────────────────────

alter table public.gift_pool_pledges
  add column id          uuid not null default gen_random_uuid(),
  add column received_at timestamptz;

alter table public.gift_pool_pledges
  add constraint gift_pool_pledges_id_key unique (id);

comment on column public.gift_pool_pledges.id is
  'Непрозорий ідентифікатор внеску (ROADMAP 8.14): ним організатор вказує внесок у set_pledge_received. Бачить лише організатор.';
comment on column public.gift_pool_pledges.received_at is
  'Коли організатор позначив внесок отриманим (ROADMAP 8.14); null — лише обіцянка. Застосунок грошей не перевіряє. ІНВАРІАНТ: власник не має доступу.';

alter table public.guest_mail drop constraint guest_mail_kind_check;
alter table public.guest_mail
  add constraint guest_mail_kind_check
    check (kind in ('claim', 'code', 'changed', 'deleted', 'reminder', 'thanks',
                    'pool_join', 'pool_closed', 'pool_cancel', 'pool_received'));

-- ─────────────────────────────────────────────
-- Позначити внесок отриманим / зняти позначку
-- ─────────────────────────────────────────────
--
-- Не через gift_pool_of: та відповідає власнику owner_cannot_reserve, а гостю
-- з поганим ключем — bad_key. Тут кожен, хто не організатор, отримує одне й те
-- саме not_organizer, і до пошуку збору власник не доходить зовсім (ADR-038).
-- Архівний список і закритий збір не заважають: гроші часто доходять після свята.

create or replace function public.set_pledge_received(
  p_token     text,
  p_pool_id   uuid,
  p_key       text,
  p_pledge_id uuid,
  p_received  boolean
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share    public.shares;
  v_pool     public.gift_pools;
  v_identity uuid;
  v_pledge   public.gift_pool_pledges;
begin
  v_share := public.live_share(p_token);
  if v_share.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  -- Власник списку і гість без ключа — до будь-якого пошуку.
  if (auth.uid() is not null and auth.uid() = v_share.owner_id)
     or p_key is null or p_key !~ '^[A-Za-z0-9_-]{22,64}$' then
    raise exception 'not_organizer' using errcode = '42501';
  end if;

  v_identity := public.guest_identity_of(v_share.source_list_id, p_key);
  select p.* into v_pool
    from public.gift_pools p
    join public.share_items si on si.item_id = p.item_id and si.share_id = v_share.id
    join public.items i on i.id = p.item_id and i.status = 'active'
   where p.id = p_pool_id
   for update of p;
  if v_identity is null or v_pool.id is null or v_pool.organizer_id <> v_identity then
    raise exception 'not_organizer' using errcode = '42501';
  end if;

  -- Як close_pool (BUG-QA-08): без явного «так» чи «ні» нічого не змінюється.
  if p_received is null then
    return;
  end if;

  select x.* into v_pledge
    from public.gift_pool_pledges x
   where x.id = p_pledge_id and x.pool_id = p_pool_id
   for update;
  if v_pledge.id is null then
    -- Сюди доходить лише організатор: учасник вийшов зі збору.
    raise exception 'pledge_gone' using errcode = 'P0002';
  end if;

  update public.gift_pool_pledges
     set received_at = case when p_received then coalesce(received_at, now()) else null end
   where id = v_pledge.id;

  -- Учаснику — лист, коли внесок уперше став отриманим. Зняв і поставив знову —
  -- другого листа немає: організатор, що помилився, не розсилає листи по колу.
  if p_received and v_pledge.received_at is null
     and v_pledge.identity_id <> v_pool.organizer_id
     and not exists (select 1 from public.guest_mail m
                      where m.identity_id = v_pledge.identity_id
                        and m.kind = 'pool_received'
                        and m.details->>'pool_id' = v_pool.id::text) then
    perform public.enqueue_pool_mail(v_pool, v_pledge.identity_id, 'pool_received',
              jsonb_build_object('amount', v_pledge.amount, 'pool_id', v_pool.id));
  end if;
end;
$$;

-- ─────────────────────────────────────────────
-- pledge_pool — нова сума знімає позначку «отримано»
-- ─────────────────────────────────────────────
-- Тіло — з 20261022090000_qa_fixes.sql; змінено лише on conflict.

create or replace function public.pledge_pool(
  p_token   text,
  p_pool_id uuid,
  p_key     text,
  p_name    text,
  p_amount  numeric,
  p_locale  text default 'uk',
  p_email   text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pool     public.gift_pools;
  v_share    public.shares;
  v_name     text := public.gift_pool_text(p_name, 60, 'bad_name');
  v_list     uuid;
  v_identity uuid;
  v_code     text;
  v_email    text;
  v_new      boolean;
begin
  -- BUG-QA-01: межу перевіряємо на тому, що піде в базу (numeric(12,2)).
  p_amount := round(p_amount, 2);
  -- BUG-QA-11: невидимі символи й керування напрямом — не імʼя.
  if v_name ~ '[­؜᠎​‎‏‪-‮⁠-⁤⁦-⁩﻿]' then
    raise exception 'bad_name' using errcode = '22023';
  end if;

  if p_email is not null then
    v_email := lower(nullif(btrim(p_email), ''));
    if v_email is not null
       and (char_length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
      raise exception 'bad_email' using errcode = '22023';
    end if;
  end if;

  v_pool := public.gift_pool_of(p_token, p_pool_id, p_key);
  v_share := public.live_share(p_token);
  v_identity := public.guest_identity_of(v_share.source_list_id, p_key);
  if v_pool.closed_at is not null then
    raise exception 'pool_closed' using errcode = '22023';
  end if;
  if p_amount is null or p_amount <= 0 or p_amount > 1000000 then
    raise exception 'bad_amount' using errcode = '22023';
  end if;
  v_list := v_share.source_list_id;
  if exists (select 1 from public.lists l where l.id = v_list and l.is_archived) then
    raise exception 'list_archived' using errcode = '22023';
  end if;
  if (select count(*) from public.gift_pool_pledges where pool_id = p_pool_id) >= 50
     and not exists (select 1 from public.gift_pool_pledges where pool_id = p_pool_id and identity_id = v_identity) then
    raise exception 'pool_full' using errcode = '22023';
  end if;

  if v_identity is null then
    insert into public.guest_identities (list_id, short_code)
    values (v_list, public.gen_guest_code(v_list))
    returning id into v_identity;
    insert into public.guest_keys (key_hash, identity_id)
    values (public.guest_key_hash(v_list, p_key), v_identity);
  end if;

  insert into public.gift_pool_pledges as pp (pool_id, identity_id, name, amount)
  values (p_pool_id, v_identity, v_name, p_amount)
  on conflict (pool_id, identity_id)
  do update set name        = excluded.name,
                amount      = excluded.amount,
                updated_at  = now(),
                -- 8.14: організатор отримав стару суму — нову він позначить сам.
                received_at = case when pp.amount = excluded.amount then pp.received_at end
  returning (xmax = 0) into v_new;

  update public.guest_identities
     set last_seen = now(),
         name      = coalesce(name, v_name),
         locale    = case when p_locale in ('uk', 'pl', 'en') then p_locale else locale end,
         email     = case when p_email is null then email else v_email end,
         -- «Я дарую» (ADR-062): учасник, що увійшов, — до свого акаунта.
         user_id   = case when user_id is null and auth.uid() is not null then auth.uid() else user_id end
   where id = v_identity
  returning short_code into v_code;

  -- Організатору — лише про нового учасника, не про зміну суми; і не про себе.
  if v_new and v_identity <> v_pool.organizer_id then
    perform public.enqueue_pool_mail(v_pool, v_pool.organizer_id, 'pool_join',
      jsonb_build_object('name', v_name, 'amount', p_amount));
  end if;

  return jsonb_build_object('code', v_code);
end;
$$;

-- ─────────────────────────────────────────────
-- get_guest_list — «отримано» в зборі
-- ─────────────────────────────────────────────
-- Тіло — з 20261020140000_gift_pools.sql; додано `received`, `mine_received`
-- і в `pledges` організатору — `id`, `received`. Імен і часу іншим гостям — ні.

create or replace function public.get_guest_list(p_token text, p_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_body     jsonb;
  v_share    public.shares;
  v_thanks   text;
  v_identity uuid;
  v_contact  jsonb;
  v_items    jsonb;
begin
  v_body := public.get_shared_list(p_token, p_key);
  v_share := public.live_share(p_token);
  select l.thanks_message into v_thanks from public.lists l where l.id = v_share.source_list_id;
  v_body := v_body || jsonb_build_object('thanks', v_thanks);

  if (v_body->>'viewer_is_owner')::boolean then
    return v_body;
  end if;

  v_identity := public.guest_identity_of(v_share.source_list_id, p_key);

  select jsonb_build_object('name', g.name, 'email', g.email)
    into v_contact
    from public.guest_identities g
   where g.id = v_identity;

  select coalesce(jsonb_agg(
           t.e
             || case when c.changed_at   is not null then jsonb_build_object('changed', true) else '{}'::jsonb end
             || case when c.purchased_at is not null then jsonb_build_object('bought',  true) else '{}'::jsonb end
             || case when p.id is null then '{}'::jsonb else jsonb_build_object('pool', jsonb_build_object(
                  'id',            p.id,
                  'organizer',     p.organizer,
                  'instructions',  p.instructions,
                  'goal',          p.goal,
                  'currency',      p.currency,
                  'closed',        p.closed_at is not null,
                  'raised',        coalesce((select sum(x.amount) from public.gift_pool_pledges x where x.pool_id = p.id), 0),
                  'received',      coalesce((select sum(x.amount) from public.gift_pool_pledges x
                                              where x.pool_id = p.id and x.received_at is not null), 0),
                  'count',         (select count(*) from public.gift_pool_pledges x where x.pool_id = p.id),
                  'mine',          (select x.amount from public.gift_pool_pledges x
                                     where x.pool_id = p.id and x.identity_id = v_identity),
                  'mine_received', coalesce((select x.received_at is not null from public.gift_pool_pledges x
                                              where x.pool_id = p.id and x.identity_id = v_identity), false),
                  'is_organizer',  v_identity is not null and p.organizer_id = v_identity,
                  'pledges',       case when v_identity is not null and p.organizer_id = v_identity then
                                     (select coalesce(jsonb_agg(jsonb_build_object(
                                                'id',       x.id,
                                                'name',     x.name,
                                                'amount',   x.amount,
                                                'received', x.received_at is not null)
                                              order by x.created_at), '[]'::jsonb)
                                        from public.gift_pool_pledges x where x.pool_id = p.id)
                                   end
                )) end
           order by t.ord), '[]'::jsonb)
    into v_items
    from jsonb_array_elements(v_body->'items') with ordinality as t(e, ord)
    left join public.claims c
      on c.identity_id = v_identity and c.item_id = (t.e->>'id')::uuid
    left join public.gift_pools p
      on p.item_id = (t.e->>'id')::uuid;

  v_body := jsonb_set(v_body, '{items}', v_items);
  if jsonb_typeof(v_body->'guest') = 'object' then
    v_body := jsonb_set(v_body, '{guest}', (v_body->'guest') || coalesce(v_contact, '{}'::jsonb));
  end if;
  return v_body;
end;
$$;

-- ─────────────────────────────────────────────
-- get_my_gifts — «отримано» в зборі
-- ─────────────────────────────────────────────
-- Тіло — з 20261020150000_pool_mail.sql; у `pool` додано `received` і
-- `mine_received`. Імен учасників тут, як і раніше, немає.

create or replace function public.get_my_gifts()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  perform public.link_guest_identities(v_user);

  return coalesce((
    with mine as (
      -- Мої ідентичності на чужих списках.
      select g.id, g.list_id
        from public.guest_identities g
        join public.lists l on l.id = g.list_id and l.owner_id <> v_user
       where g.user_id = v_user
    ),
    picks as (
      select m.list_id, c.item_id, c.quantity, c.purchased_at, c.changed_at,
             null::numeric as pledged, null::boolean as pledge_received
        from mine m join public.claims c on c.identity_id = m.id
      union all
      select m.list_id, p.item_id, 0, null, null, x.amount, x.received_at is not null
        from mine m
        join public.gift_pool_pledges x on x.identity_id = m.id
        join public.gift_pools p on p.id = x.pool_id
    ),
    my_lists as (
      select l.*
        from public.lists l
       where l.id in (select list_id from picks)
    )
    select jsonb_agg(x.card order by x.past, x.event_date nulls last, x.title)
      from (
        select s.title,
               l.event_date,
               (l.event_date is not null and l.event_date < current_date) as past,
               jsonb_build_object(
                 'token',      s.token,
                 'title',      s.title,
                 'event_date', l.event_date,
                 'archived',   l.is_archived,
                 'thanks',     l.thanks_message,
                 'code',       (select g.short_code from public.guest_identities g
                                 where g.list_id = l.id and g.user_id = v_user
                                 order by g.last_seen desc limit 1),
                 'items', (
                   select coalesce(jsonb_agg(jsonb_build_object(
                            'id',        t.id,
                            'title',     t.title,
                            'url',       t.url,
                            'price',     case when s.hide_prices then null else t.price end,
                            'currency',  coalesce(t.currency, l.currency),
                            'mine_qty',  t.mine_qty,
                            'quantity',  t.quantity,
                            'bought',    t.bought,
                            'changed',   t.changed,
                            'pool',      (select jsonb_build_object(
                                            'organizer',     p.organizer,
                                            'instructions',  p.instructions,
                                            'goal',          p.goal,
                                            'currency',      p.currency,
                                            'closed',        p.closed_at is not null,
                                            'raised',        coalesce((select sum(z.amount) from public.gift_pool_pledges z
                                                                        where z.pool_id = p.id), 0),
                                            'received',      coalesce((select sum(z.amount) from public.gift_pool_pledges z
                                                                        where z.pool_id = p.id and z.received_at is not null), 0),
                                            'is_organizer',  p.organizer_id in (select m.id from mine m),
                                            'mine',          t.pledged,
                                            'mine_received', coalesce(t.pledge_received, false))
                                            from public.gift_pools p where p.item_id = t.id)
                          ) order by t.position nulls first, t.created_at), '[]'::jsonb)
                     from (
                       select i.id, i.title, i.url, i.price, i.currency, i.quantity, i.position, i.created_at,
                              sum(k.quantity)::int                     as mine_qty,
                              bool_or(k.purchased_at is not null)      as bought,
                              bool_or(k.changed_at is not null)        as changed,
                              sum(k.pledged)                           as pledged,
                              bool_or(k.pledge_received)               as pledge_received
                         from picks k
                         join public.items i on i.id = k.item_id and i.status = 'active'
                         join public.share_items si on si.item_id = i.id and si.share_id = s.id
                        where k.list_id = l.id
                        group by i.id
                     ) t
                 )
               ) as card
          from my_lists l
          cross join lateral (
            select sh.*
              from public.shares sh
             where sh.source_list_id = l.id
               and sh.revoked_at is null
               and (sh.expires_at is null or sh.expires_at > now())
               and exists (select 1
                             from picks k2
                             join public.share_items si2 on si2.item_id = k2.item_id and si2.share_id = sh.id
                             join public.items i2 on i2.id = k2.item_id and i2.status = 'active'
                            where k2.list_id = l.id)
             order by sh.created_at desc
             limit 1
          ) s
      ) x
  ), '[]'::jsonb);
end;
$$;

-- ─────────────────────────────────────────────
-- Права (CLAUDE.md §3.4)
-- ─────────────────────────────────────────────
-- pledge_pool, get_guest_list, get_my_gifts — CREATE OR REPLACE зберігає
-- гранти; повторюємо явно, як у попередніх міграціях.

revoke all on function public.set_pledge_received(text, uuid, text, uuid, boolean) from public;
grant execute on function public.set_pledge_received(text, uuid, text, uuid, boolean) to anon, authenticated;

revoke all on function public.pledge_pool(text, uuid, text, text, numeric, text, text) from public;
grant execute on function public.pledge_pool(text, uuid, text, text, numeric, text, text) to anon, authenticated;
revoke all on function public.get_guest_list(text, text) from public;
grant execute on function public.get_guest_list(text, text) to anon, authenticated;
revoke all on function public.get_my_gifts() from public, anon;
grant execute on function public.get_my_gifts() to authenticated;
