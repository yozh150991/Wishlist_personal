-- 20261020140000_gift_pools.sql
-- Дизайн v2, крок 7а (ADR-063): спільний подарунок (потік N).
--
-- Гість на будь-якій вільній позиції (кількість 1) може замість «Беру»
-- відкрити збір: вказати своє ім'я, текст «як скинутися» (BLIK, картка,
-- телефон) і ціль — ціну позиції або свою, якщо ціна прихована чи не вказана.
-- Позиція при цьому береться ним, як після «Беру»: інші гості бачать не
-- «Уже взяли», а «Збір: зібрано X з Y» і можуть долучитися — ім'я й сума.
-- Застосунок грошей не переказує: це обіцянки, домовляються люди самі.
--
-- Хто що бачить:
--   * організатор — ім'я й суму кожного учасника, закрити чи скасувати збір;
--   * учасник — свою суму, ім'я організатора, «як скинутися», підсумок;
--   * інший гість — ім'я організатора, «як скинутися», підсумок і число
--     учасників (без імен);
--   * власник списку — нічого: ні на своєму посиланні, ні в превʼю, ні
--     числом (CLAUDE.md §3.2, ADR-040, п. 2 N). Таблиці без політик.
--
-- Збір живе на позначці організатора: зняв бронь (будь-яким шляхом, зокрема
-- сліпим скиданням власника) — збору немає. Видалили позицію — теж.

-- ─────────────────────────────────────────────
-- Таблиці
-- ─────────────────────────────────────────────

create table public.gift_pools (
  id           uuid primary key default gen_random_uuid(),
  item_id      uuid not null unique references public.items(id) on delete cascade,
  organizer_id uuid not null references public.guest_identities(id) on delete cascade,
  organizer    text not null check (char_length(organizer) between 1 and 60 and organizer !~ '[[:cntrl:]]'),
  instructions text not null check (char_length(instructions) between 1 and 500),
  goal         numeric(12,2) not null check (goal > 0 and goal <= 1000000),
  currency     char(3) not null,
  closed_at    timestamptz,
  created_at   timestamptz not null default now()
);

comment on table public.gift_pools is
  'Спільний збір гостей на позицію (ADR-063). Живе на позначці організатора. ІНВАРІАНТ: власник не має доступу (CLAUDE.md §3.2).';

create table public.gift_pool_pledges (
  pool_id     uuid not null references public.gift_pools(id) on delete cascade,
  identity_id uuid not null references public.guest_identities(id) on delete cascade,
  name        text not null check (char_length(name) between 1 and 60 and name !~ '[[:cntrl:]]'),
  amount      numeric(12,2) not null check (amount > 0 and amount <= 1000000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (pool_id, identity_id)
);

comment on table public.gift_pool_pledges is
  'Обіцянки учасників збору (ADR-063): ім''я й сума. Бачить лише організатор (імена) і сам учасник. ІНВАРІАНТ: власник не має доступу.';

create index gift_pool_pledges_identity_idx on public.gift_pool_pledges (identity_id);

alter table public.gift_pools        enable row level security;
alter table public.gift_pool_pledges enable row level security;
revoke all on public.gift_pools, public.gift_pool_pledges from anon, authenticated;
grant select, insert, update, delete on public.gift_pools, public.gift_pool_pledges to service_role;
-- ↑ ІНВАРІАНТ: жодної політики. Пишуть і читають лише гостьові RPC нижче.

-- ─────────────────────────────────────────────
-- Збір живе на броні організатора
-- ─────────────────────────────────────────────

create or replace function public.gift_pool_release_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.gift_pools p
   where p.item_id = old.item_id and p.organizer_id = old.identity_id;
  return null;
end;
$$;

revoke all on function public.gift_pool_release_trg() from public, anon, authenticated;

create trigger gift_pool_release
  after delete on public.claims
  for each row execute function public.gift_pool_release_trg();

-- ─────────────────────────────────────────────
-- Спільні перевірки
-- ─────────────────────────────────────────────

-- Збір цього посилання: живе посилання, позиція в ньому й актуальна, не
-- власник, ключ правильної форми. Повертає збір; ідентичність гостя виклична
-- функція бере сама — guest_identity_of.
create or replace function public.gift_pool_of(p_token text, p_pool_id uuid, p_key text)
returns public.gift_pools
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  share public.shares;
  pool  public.gift_pools;
begin
  share := public.live_share(p_token);
  if share.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if auth.uid() is not null and auth.uid() = share.owner_id then
    raise exception 'owner_cannot_reserve' using errcode = '22023';
  end if;
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{22,64}$' then
    raise exception 'bad_key' using errcode = '22023';
  end if;
  select p.* into pool
    from public.gift_pools p
    join public.share_items si on si.item_id = p.item_id and si.share_id = share.id
    join public.items i on i.id = p.item_id and i.status = 'active'
   where p.id = p_pool_id;
  if pool.id is null then
    raise exception 'pool_not_found' using errcode = 'P0002';
  end if;
  return pool;
end;
$$;

revoke all on function public.gift_pool_of(text, uuid, text) from public, anon, authenticated;

create or replace function public.gift_pool_text(p_value text, p_max integer, p_error text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v text := nullif(btrim(coalesce(p_value, '')), '');
begin
  if v is null or char_length(v) > p_max then
    raise exception '%', p_error using errcode = '22023';
  end if;
  return v;
end;
$$;

revoke all on function public.gift_pool_text(text, integer, text) from public, anon, authenticated;

-- ─────────────────────────────────────────────
-- Відкрити збір
-- ─────────────────────────────────────────────
--
-- Позиція — кількість 1 і ще нічия: збір бере її так само, як «Беру»
-- (claim_item_v2 — та сама гонка, ліміти, архів, лист на бронь). Ціль без
-- значення — ціна позиції, якщо посилання її показує; інакше — обов'язкова.

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

  insert into public.gift_pools (item_id, organizer_id, organizer, instructions, goal, currency)
  values (p_item_id, v_identity, v_name, v_text, round(v_goal, 2), v_currency)
  returning id into v_pool;

  return v_result || jsonb_build_object('pool_id', v_pool);
end;
$$;

-- ─────────────────────────────────────────────
-- Долучитися / змінити суму / вийти
-- ─────────────────────────────────────────────

create or replace function public.pledge_pool(
  p_token   text,
  p_pool_id uuid,
  p_key     text,
  p_name    text,
  p_amount  numeric,
  p_locale  text default 'uk'
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
begin
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
  do update set name = excluded.name, amount = excluded.amount, updated_at = now();

  update public.guest_identities
     set last_seen = now(),
         name      = coalesce(name, v_name),
         locale    = case when p_locale in ('uk', 'pl', 'en') then p_locale else locale end,
         -- «Я дарую» (ADR-062): учасник, що увійшов, — до свого акаунта.
         user_id   = case when user_id is null and auth.uid() is not null then auth.uid() else user_id end
   where id = v_identity
  returning short_code into v_code;

  return jsonb_build_object('code', v_code);
end;
$$;

create or replace function public.leave_pool(p_token text, p_pool_id uuid, p_key text)
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
  if v_identity is null then
    return;
  end if;
  delete from public.gift_pool_pledges where pool_id = p_pool_id and identity_id = v_identity;
end;
$$;

-- ─────────────────────────────────────────────
-- Організатор: закрити, відкрити знову, скасувати
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
end;
$$;

-- Скасувати — зняти бронь організатора: тригер gift_pool_release прибирає збір
-- з обіцянками разом із нею.
create or replace function public.cancel_pool(p_token text, p_pool_id uuid, p_key text)
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
  perform public.release_claim(p_token, v_pool.item_id, p_key);
  -- release_claim уже прибрав бронь — і тригером збір; на випадок, якщо броні
  -- не було (скинута раніше), збір прибираємо явно.
  delete from public.gift_pools where id = p_pool_id;
end;
$$;

-- ─────────────────────────────────────────────
-- get_guest_list — ще й `pool` на позиціях зі збором
-- ─────────────────────────────────────────────
--
-- Збір бачать усі гості посилання, власник — ні. Імена учасників — лише
-- організатору; своя сума — учаснику. Решта — як у 20261020100000_list_thanks.

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
                  'id',           p.id,
                  'organizer',    p.organizer,
                  'instructions', p.instructions,
                  'goal',         p.goal,
                  'currency',     p.currency,
                  'closed',       p.closed_at is not null,
                  'raised',       coalesce((select sum(x.amount) from public.gift_pool_pledges x where x.pool_id = p.id), 0),
                  'count',        (select count(*) from public.gift_pool_pledges x where x.pool_id = p.id),
                  'mine',         (select x.amount from public.gift_pool_pledges x
                                    where x.pool_id = p.id and x.identity_id = v_identity),
                  'is_organizer', v_identity is not null and p.organizer_id = v_identity,
                  'pledges',      case when v_identity is not null and p.organizer_id = v_identity then
                                    (select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'amount', x.amount)
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
-- Права (CLAUDE.md §3.4)
-- ─────────────────────────────────────────────

revoke all on function public.start_pool(text, uuid, text, text, text, numeric, text, text) from public;
revoke all on function public.pledge_pool(text, uuid, text, text, numeric, text)              from public;
revoke all on function public.leave_pool(text, uuid, text)                                     from public;
revoke all on function public.close_pool(text, uuid, text, boolean)                            from public;
revoke all on function public.cancel_pool(text, uuid, text)                                    from public;
grant execute on function public.start_pool(text, uuid, text, text, text, numeric, text, text) to anon, authenticated;
grant execute on function public.pledge_pool(text, uuid, text, text, numeric, text)              to anon, authenticated;
grant execute on function public.leave_pool(text, uuid, text)                                     to anon, authenticated;
grant execute on function public.close_pool(text, uuid, text, boolean)                            to anon, authenticated;
grant execute on function public.cancel_pool(text, uuid, text)                                    to anon, authenticated;
revoke all on function public.get_guest_list(text, text) from public;
grant execute on function public.get_guest_list(text, text) to anon, authenticated;
