-- 20261020150000_pool_mail.sql
-- Дизайн v2, крок 7б (ADR-064): листи про спільний збір і внески в «Я дарую».
--
-- Що змінюється:
--   * pledge_pool приймає необов'язкову пошту учасника — як бронь (ADR-054):
--     на неї й ідуть листи нижче. Сигнатура нова, стара прибирається;
--   * листи через ту саму чергу guest_mail (відписка діє):
--       pool_join   — організатору: долучився новий учасник (ім'я й сума);
--       pool_closed — учасникам: організатор закрив збір і купує — скільки
--                     обіцяли й «як скинутися»;
--       pool_cancel — учасникам: збір скасовано (організатор, зняття броні,
--                     сліпе скидання) або позицію прибрано — переказувати не
--                     треба;
--     Зміст — знімком у details; власнику — нічого (ADR-040). Тригер
--     скасування нічого не повертає й ковтає помилки (ADR-040, п. 4);
--   * gift_pools.share_id і item_title — посилання, де відкрили збір, і назва
--     позиції знімком: лист про видалену позицію має що назвати й куди вести;
--   * get_my_gifts — ще й позиції, на які користувач скидається, і стан збору.

alter table public.gift_pools
  add column share_id   uuid references public.shares(id) on delete set null,
  add column item_title text;

comment on column public.gift_pools.share_id is 'Посилання, де відкрили збір (ADR-064): адреса в листах про збір.';
comment on column public.gift_pools.item_title is 'Назва позиції на момент відкриття збору (ADR-064): для листа, коли позиції вже немає.';

update public.gift_pools p
   set item_title = i.title,
       share_id = (select si.share_id from public.share_items si join public.shares s on s.id = si.share_id
                    where si.item_id = p.item_id order by s.created_at desc limit 1)
  from public.items i
 where i.id = p.item_id;

alter table public.guest_mail drop constraint guest_mail_kind_check;
alter table public.guest_mail
  add constraint guest_mail_kind_check
    check (kind in ('claim', 'code', 'changed', 'deleted', 'reminder', 'thanks',
                    'pool_join', 'pool_closed', 'pool_cancel'));

-- ─────────────────────────────────────────────
-- Лист про збір — у чергу
-- ─────────────────────────────────────────────
--
-- Спільний знімок для всіх трьох: назва позиції, ім'я організатора, «як
-- скинутися», ціль і обіцяно. Пошту, відписку й ліміт перевіряє
-- enqueue_guest_mail; без посилання листа немає.

create or replace function public.enqueue_pool_mail(
  p_pool     public.gift_pools,
  p_identity uuid,
  p_kind     text,
  p_extra    jsonb default '{}'::jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_locale text;
begin
  if p_pool.share_id is null then
    return false;
  end if;
  select locale into v_locale from public.guest_identities where id = p_identity;
  return public.enqueue_guest_mail(
    p_identity, p_pool.share_id, p_kind, null, coalesce(v_locale, 'uk'),
    jsonb_build_object(
      'title',        coalesce((select i.title from public.items i where i.id = p_pool.item_id), p_pool.item_title),
      'organizer',    p_pool.organizer,
      'instructions', p_pool.instructions,
      'goal',         p_pool.goal,
      'currency',     p_pool.currency,
      'raised',       coalesce((select sum(x.amount) from public.gift_pool_pledges x where x.pool_id = p_pool.id), 0)
    ) || coalesce(p_extra, '{}'::jsonb));
end;
$$;

revoke all on function public.enqueue_pool_mail(public.gift_pools, uuid, text, jsonb) from public, anon, authenticated;

-- ─────────────────────────────────────────────
-- Збір зникає — учасникам лист
-- ─────────────────────────────────────────────
--
-- BEFORE DELETE: обіцянки ще на місці. Позиції вже немає (каскад із items) —
-- «позицію прибрано»; інакше — «збір скасовано», хто б його не скасував.

create or replace function public.gift_pool_cancel_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text;
  r        record;
begin
  begin
    v_reason := case when exists (select 1 from public.items i where i.id = old.item_id) then 'cancelled' else 'deleted' end;
    for r in
      select x.identity_id, x.amount
        from public.gift_pool_pledges x
       where x.pool_id = old.id and x.identity_id <> old.organizer_id
    loop
      begin
        perform public.enqueue_pool_mail(old, r.identity_id, 'pool_cancel',
                                         jsonb_build_object('reason', v_reason, 'amount', r.amount));
      exception when others then
        null;
      end;
    end loop;
  exception when others then
    null;
  end;
  return old;
end;
$$;

revoke all on function public.gift_pool_cancel_trg() from public, anon, authenticated;

create trigger gift_pool_cancel_mail
  before delete on public.gift_pools
  for each row execute function public.gift_pool_cancel_trg();

-- ─────────────────────────────────────────────
-- start_pool — пам'ятає посилання й назву
-- ─────────────────────────────────────────────

create or replace function public.start_pool(
  p_token        text,
  p_item_id      uuid,
  p_key          text,
  p_name         text,
  p_instructions text,
  p_goal         numeric default null,
  p_email        text default null,
  p_locale       text default 'uk'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share    public.shares;
  v_item     public.items;
  v_currency text;
  v_name     text := public.gift_pool_text(p_name, 60, 'bad_name');
  v_text     text := public.gift_pool_text(p_instructions, 500, 'bad_instructions');
  v_goal     numeric;
  v_result   jsonb;
  v_identity uuid;
  v_pool     uuid;
begin
  v_share := public.live_share(p_token);
  if v_share.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  select i.* into v_item
    from public.items i
    join public.share_items si on si.item_id = i.id and si.share_id = v_share.id
   where i.id = p_item_id and i.status = 'active'
   for update of i;
  if v_item.id is null then
    raise exception 'item_not_in_share' using errcode = 'P0002';
  end if;
  if v_item.quantity <> 1 then
    raise exception 'pool_single_only' using errcode = '22023';
  end if;
  select coalesce(v_item.currency, l.currency) into v_currency from public.lists l where l.id = v_item.list_id;

  v_goal := coalesce(p_goal, case when v_share.hide_prices then null else v_item.price end);
  if v_goal is null or v_goal <= 0 or v_goal > 1000000 then
    raise exception 'bad_goal' using errcode = '22023';
  end if;

  -- Ціла позиція, як «Беру»: зайнята — not_enough_left, архів — list_archived.
  v_result := public.claim_item_v2(p_token, p_item_id, p_key, 1, v_name, p_email, p_locale);
  v_identity := public.guest_identity_of(v_share.source_list_id, p_key);

  insert into public.gift_pools (item_id, organizer_id, organizer, instructions, goal, currency, share_id, item_title)
  values (p_item_id, v_identity, v_name, v_text, round(v_goal, 2), v_currency, v_share.id, v_item.title)
  returning id into v_pool;

  return v_result || jsonb_build_object('pool_id', v_pool);
end;
$$;

-- ─────────────────────────────────────────────
-- pledge_pool — пошта учасника й лист організатору
-- ─────────────────────────────────────────────

drop function public.pledge_pool(text, uuid, text, text, numeric, text);

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

  insert into public.gift_pool_pledges (pool_id, identity_id, name, amount)
  values (p_pool_id, v_identity, v_name, round(p_amount, 2))
  on conflict (pool_id, identity_id)
  do update set name = excluded.name, amount = excluded.amount, updated_at = now()
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
      jsonb_build_object('name', v_name, 'amount', round(p_amount, 2)));
  end if;

  return jsonb_build_object('code', v_code);
end;
$$;

-- ─────────────────────────────────────────────
-- close_pool — лист учасникам за закриття
-- ─────────────────────────────────────────────

create or replace function public.close_pool(p_token text, p_pool_id uuid, p_key text, p_closed boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pool     public.gift_pools;
  v_share    public.shares;
  v_identity uuid;
begin
  v_pool := public.gift_pool_of(p_token, p_pool_id, p_key);
  v_share := public.live_share(p_token);
  v_identity := public.guest_identity_of(v_share.source_list_id, p_key);
  if v_identity is null or v_identity <> v_pool.organizer_id then
    raise exception 'not_organizer' using errcode = '42501';
  end if;
  update public.gift_pools
     set closed_at = case when p_closed then coalesce(closed_at, now()) else null end
   where id = p_pool_id;

  -- Учасникам — один раз за закриття: скільки обіцяли й як переказати.
  if p_closed and v_pool.closed_at is null then
    perform public.enqueue_pool_mail(v_pool, x.identity_id, 'pool_closed',
              jsonb_build_object('amount', x.amount))
       from public.gift_pool_pledges x
      where x.pool_id = p_pool_id and x.identity_id <> v_pool.organizer_id;
  end if;
end;
$$;

-- ─────────────────────────────────────────────
-- «Я дарую» — ще й позиції, на які скидаєшся
-- ─────────────────────────────────────────────
--
-- Як у 20261020130000_i_give, але «мої позиції» — і броні, і обіцянки в
-- зборах. На позиції зі збором — `pool`: хто збирає, як скинутися, ціль,
-- обіцяно, закрито, чи я організатор і моя сума. Імен учасників тут немає.

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
      select m.list_id, c.item_id, c.quantity, c.purchased_at, c.changed_at, null::numeric as pledged
        from mine m join public.claims c on c.identity_id = m.id
      union all
      select m.list_id, p.item_id, 0, null, null, x.amount
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
                                            'organizer',    p.organizer,
                                            'instructions', p.instructions,
                                            'goal',         p.goal,
                                            'currency',     p.currency,
                                            'closed',       p.closed_at is not null,
                                            'raised',       coalesce((select sum(z.amount) from public.gift_pool_pledges z
                                                                       where z.pool_id = p.id), 0),
                                            'is_organizer', p.organizer_id in (select m.id from mine m),
                                            'mine',         t.pledged)
                                            from public.gift_pools p where p.item_id = t.id)
                          ) order by t.position nulls first, t.created_at), '[]'::jsonb)
                     from (
                       select i.id, i.title, i.url, i.price, i.currency, i.quantity, i.position, i.created_at,
                              sum(k.quantity)::int                     as mine_qty,
                              bool_or(k.purchased_at is not null)      as bought,
                              bool_or(k.changed_at is not null)        as changed,
                              sum(k.pledged)                           as pledged
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

revoke all on function public.pledge_pool(text, uuid, text, text, numeric, text, text) from public;
grant execute on function public.pledge_pool(text, uuid, text, text, numeric, text, text) to anon, authenticated;
revoke all on function public.get_my_gifts() from public, anon;
grant execute on function public.get_my_gifts() to authenticated;
