-- 20261006090000_item_currency_and_rates.sql
-- Валюта на позиції й курс НБП для приблизної підказки (ADR-051, переглядає ADR-005).
--
-- Розширюємо, а не міняємо (ADR-039):
-- - `items.currency` порожня = валюта списку. Так поводяться всі наявні
--   позиції й v1, яка про валюту позиції не знає: її форма колонку не шле,
--   тож і не стирає.
-- - Конвертації в базі немає ніде. Суми рахуються окремо по кожній валюті;
--   курс НБП — лише підказка «≈» для власника, яку ніде не зберігаємо в
--   позиціях і не віддаємо гостям.
--
-- Свідомий виняток із «RPC v1 заморожені» (ADR-051): гостьова сторінка поки
-- одна — v1 під `/s/…` і `/l/…` (ROADMAP, крок 5), тож без валюти позиції
-- в `get_shared_list` гість бачив би «85 zł» там, де власник вписав 85 €.
-- Додано лише поле `currency` у кожну позицію; решта відповіді та сама.
-- `list_totals` (сума v1) рахує лише позиції у валюті списку: інакше вона
-- складала б злоті з євро.
--
-- Позначок гостей міграція не торкається (CLAUDE.md §3.2).

-- ─────────────────────────────────────────────
-- Валюта позиції
-- ─────────────────────────────────────────────

alter table public.items
  add column currency char(3)
    check (currency is null or currency in ('PLN', 'UAH', 'EUR', 'USD'));

comment on column public.items.currency is
  'Валюта ціни позиції (ADR-051). NULL — валюта списку (lists.currency), як до ADR-051 і як у v1.';

-- ─────────────────────────────────────────────
-- list_totals — сума v1 лише у валюті списку
-- ─────────────────────────────────────────────
--
-- Сигнатура та сама, змінено лише тіло. `items_no_price` рахує всі позиції
-- без ціни, як і раніше; позиції в іншій валюті в суму не входять — у v1
-- їх видно на картці з власною валютою.

create or replace function public.list_totals(p_list_id uuid)
returns table (
  items_count      integer,
  active_count     integer,
  purchased_count  integer,
  gifted_count     integer,
  total_price      numeric,
  active_price     numeric,
  items_no_price   integer
)
language sql
security invoker
stable
set search_path = public
as $$
  select
    count(*)::int,
    count(*) filter (where i.status = 'active')::int,
    count(*) filter (where i.status = 'purchased')::int,
    count(*) filter (where i.status = 'gifted')::int,
    coalesce(sum(i.price * i.quantity) filter (where coalesce(i.currency, l.currency) = l.currency), 0),
    coalesce(sum(i.price * i.quantity) filter (where i.status = 'active'
                                                 and coalesce(i.currency, l.currency) = l.currency), 0),
    count(*) filter (where i.price is null)::int
  from public.items i
  join public.lists l on l.id = i.list_id
  where i.list_id = p_list_id;
$$;

revoke execute on function public.list_totals(uuid) from public, anon;
grant  execute on function public.list_totals(uuid) to authenticated;

-- ─────────────────────────────────────────────
-- get_shared_list — валюта кожної позиції
-- ─────────────────────────────────────────────
--
-- Копія з 20260928130000_share_expiry_zone.sql з одним новим полем у
-- позиції: `currency` — уже розгорнута (валюта позиції або списку), щоб
-- гостьовій сторінці не треба було знати правило NULL. Поле `currency`
-- верхнього рівня лишається — це валюта списку.

create or replace function public.get_shared_list(p_token text, p_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share    public.shares;
  v_list     public.lists;
  v_is_owner boolean;
  v_identity uuid;
  v_code     text;
  v_items    jsonb;
  v_sections jsonb;
begin
  v_share := public.live_share(p_token);
  if v_share.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  select * into v_list from public.lists where id = v_share.source_list_id;

  v_is_owner := (auth.uid() is not null and auth.uid() = v_share.owner_id);
  -- Власнику позначок не показуємо навіть у власному посиланні (ADR-009).

  if not v_is_owner then
    v_identity := public.guest_identity_of(v_list.id, p_key);
    if v_identity is not null then
      update public.guest_identities set last_seen = now()
       where id = v_identity
       returning short_code into v_code;
    end if;
  end if;

  select coalesce(jsonb_agg(x order by rn), '[]'::jsonb)
  into v_items
  from (
    select jsonb_build_object(
      'id',         i.id,
      'title',      i.title,
      'url',        i.url,
      'price',      case when v_share.hide_prices then null else i.price end,
      'currency',   coalesce(i.currency, v_list.currency),
      'quantity',   i.quantity,
      'priority',   i.priority,
      'note',       i.note,
      'variants',   i.variants,
      'image_url',  i.image_url,
      'status',     i.status,
      'created_at', i.created_at,
      'section_id', i.section_id,
      'taken_qty', case
        when v_is_owner then null
        else coalesce((select sum(c.quantity)::int from public.claims c where c.item_id = i.id), 0)
      end,
      'mine_qty', case
        when v_is_owner then null
        else coalesce((select c.quantity from public.claims c
                        where c.item_id = i.id and c.identity_id = v_identity), 0)
      end
    ) as x,
    row_number() over (
      order by (s.id is null), s.position, s.created_at,
               i.position asc nulls first, i.created_at desc, i.id
    ) as rn
    from public.share_items si
    join public.items i on i.id = si.item_id
    left join public.sections s on s.id = i.section_id
    where si.share_id = v_share.id
      and i.status = 'active'
  ) t;

  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title)
                            order by s.position, s.created_at), '[]'::jsonb)
  into v_sections
  from public.sections s
  where s.list_id = v_list.id
    and exists (select 1 from public.share_items si
                  join public.items i on i.id = si.item_id
                 where si.share_id = v_share.id and i.status = 'active' and i.section_id = s.id);

  return jsonb_build_object(
    'title',              v_share.title,
    'message',            v_share.message,
    'currency',           v_list.currency,
    'event_date',         v_list.event_date,
    'expires_at',         v_share.expires_at,
    'expires_tz',         v_share.expires_tz,
    'owner_scheme',       (select p.scheme from public.profiles p where p.id = v_share.owner_id),
    'appearance_hue',     (select a.hue from public.appearances a where a.id = v_list.appearance_id),
    'hide_prices',        v_share.hide_prices,
    'allow_reservations', v_share.allow_reservations and not v_is_owner,
    'viewer_is_owner',    v_is_owner,
    'guest',              case when v_code is null then null else jsonb_build_object('code', v_code) end,
    'sections',           v_sections,
    'items',              v_items
  );
end;
$$;

revoke all on function public.get_shared_list(text, text) from public;
grant execute on function public.get_shared_list(text, text) to anon, authenticated;

-- ─────────────────────────────────────────────
-- Курс НБП (таблиця A) — для підказки «≈»
-- ─────────────────────────────────────────────
--
-- Пише лише wishlist-jobs (роль service_role) раз на добу. Власник читає:
-- курс публічний, у ньому немає нічого про людей. Гостям — ні: anon не має
-- прав на жодну таблицю (CLAUDE.md §3.3), а гостьова сторінка підказки не
-- показує. PLN у таблиці немає — для нього курс завжди 1.

create table public.fx_rates (
  currency     char(3) primary key check (currency in ('UAH', 'EUR', 'USD')),
  pln_per_unit numeric(14,6) not null check (pln_per_unit > 0),
  rate_date    date not null,
  fetched_at   timestamptz not null default now()
);

comment on table public.fx_rates is
  'Середній курс НБП (таблиця A) до злотого — лише для підказки «≈ … за курсом НБП від …» власнику (ADR-051). Суми й ціни ним не перераховуються.';

alter table public.fx_rates enable row level security;

create policy fx_rates_read on public.fx_rates
  for select to authenticated using (true);

revoke all on table public.fx_rates from public, anon, authenticated;
grant select on table public.fx_rates to authenticated;
grant select, insert, update on table public.fx_rates to service_role;
