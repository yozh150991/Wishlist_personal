-- 20261008100000_guest_purchase.sql
-- Гостьова v2, крок 5в: гість купує (потік S, ADR-056).
--
-- Що змінюється:
--   * claims.purchased_at — гість сам позначив свою бронь «Уже куплено». Це
--     окремий крок після броні: на картці «Зняти» після нього ховається, щоб
--     скасувати покупку випадково не вийшло. Бачить лише цей гість;
--   * лист про видалення позиції, яку гість уже купив, каже про це прямо
--     (тригер items_guest_deleted кладе дату покупки в details);
--   * нагадування за 7 днів — лише тим, у кого лишилось щось некуплене, і
--     окремо називає вже куплене.
--
-- ІНВАРІАНТ (CLAUDE.md §3.2): власник не бачить ні броні, ні покупки —
-- для нього нічого не змінюється. «Куплено» гостя — не статус позиції
-- власника (items.status), і одне на інше не впливає.

alter table public.claims add column purchased_at timestamptz;

comment on column public.claims.purchased_at is
  'Гість позначив свою бронь «Уже куплено» (потік S). Бачить лише цей гість; власник не має доступу (CLAUDE.md §3.2).';

-- ─────────────────────────────────────────────
-- set_claim_bought — «Уже куплено» і назад
-- ─────────────────────────────────────────────

create or replace function public.set_claim_bought(p_token text, p_item_id uuid, p_key text, p_bought boolean)
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
    update public.claims
       set purchased_at = case when coalesce(p_bought, false) then coalesce(purchased_at, now()) else null end
     where item_id = p_item_id and identity_id = v_identity;
  end if;
end;
$$;

-- ─────────────────────────────────────────────
-- get_guest_list — «Змінено» й «Куплено» на своїх позиціях
-- ─────────────────────────────────────────────

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
           t.e
             || case when c.changed_at   is not null then jsonb_build_object('changed', true) else '{}'::jsonb end
             || case when c.purchased_at is not null then jsonb_build_object('bought',  true) else '{}'::jsonb end
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
-- Видалення: куплене — окремим рядком у листі
-- ─────────────────────────────────────────────

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
      select c.identity_id, c.purchased_at, g.locale
        from public.claims c
        join public.guest_identities g on g.id = c.identity_id
       where c.item_id = old.id
    loop
      perform public.enqueue_guest_mail(
        r.identity_id, v_share, 'deleted', null, coalesce(r.locale, 'uk'),
        jsonb_build_object('title', old.title)
          || case when r.purchased_at is not null
                  then jsonb_build_object('bought', (r.purchased_at at time zone 'Europe/Warsaw')::date)
                  else '{}'::jsonb end);
    end loop;
  exception when others then
    null;
  end;
  return old;
end;
$$;

-- ─────────────────────────────────────────────
-- Нагадування: лише коли лишилось щось некуплене
-- ─────────────────────────────────────────────

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
           coalesce(jsonb_agg(i.title order by i.position nulls first, i.created_at)
                      filter (where c.purchased_at is null), '[]'::jsonb) as titles,
           coalesce(jsonb_agg(i.title order by i.position nulls first, i.created_at)
                      filter (where c.purchased_at is not null), '[]'::jsonb) as bought,
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
    having count(*) filter (where c.purchased_at is null) > 0
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
                                   jsonb_build_object('event_date', r.event_date, 'items', r.titles,
                                                      'bought', r.bought)) then
        v_count := v_count + 1;
      end if;
    exception when others then
      null;
    end;
  end loop;
  return v_count;
end;
$$;

-- ─────────────────────────────────────────────
-- Права (CLAUDE.md §3.4)
-- ─────────────────────────────────────────────

revoke all on function public.set_claim_bought(text, uuid, text, boolean) from public;
grant execute on function public.set_claim_bought(text, uuid, text, boolean) to anon, authenticated;
revoke all on function public.guest_item_deleted_trg()   from public, anon, authenticated;
revoke all on function public.enqueue_guest_reminders()  from public, anon, authenticated;
