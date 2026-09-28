-- 20260928130000_share_expiry_zone.sql
-- Термін посилання — доба в часовому поясі власника (ADR-037).
--
-- «Діє до 20 грудня» — це 20 грудня там, де живе власник. Досі браузер
-- власника сам рахував кінець дня й надсилав лише момент: база не знала, у
-- якій зоні той день, і гість не міг побачити, коли саме посилання згасне.
-- Гість у Ванкувері бачив би «до 20 грудня», хоча для власника в Києві
-- посилання вмирає 20-го о 23:59 — у Ванкувері це ще 13:59.
--
-- Тепер зберігаємо обидва: момент (expires_at, UTC — його й перевіряє
-- live_share) і IANA-зону власника (expires_tz, `Europe/Kyiv`). Момент
-- рахує база з дати й зони: 23:59:59 того дня за зоною власника, з
-- урахуванням переходу на літній час. Гостю — «діє до 20 грудня, 23:59 за
-- Києвом».

-- ─────────────────────────────────────────────
-- shares.expires_tz
-- ─────────────────────────────────────────────

alter table public.shares
  add column expires_tz text;

-- Форма IANA-імені, а не довільний рядок: власник може писати в shares напряму
-- (RLS дозволяє оновлювати свої). Чи зона справді існує, перевіряє
-- create_share за pg_timezone_names; check так не вміє — підзапити в ньому
-- заборонені. Зона без моменту безглузда.
alter table public.shares
  add constraint shares_expires_tz_shape check (
    expires_tz is null
    or (expires_at is not null
        and length(expires_tz) between 1 and 64
        and expires_tz ~ '^[A-Za-z][A-Za-z0-9_+-]*(/[A-Za-z0-9_+-]+)*$')
  );

comment on column public.shares.expires_tz is
  'IANA-зона власника, у якій рахується «діє до» (ADR-037). null — посилання без терміну або створене до ADR-037.';

-- ─────────────────────────────────────────────
-- create_share — дата + зона
-- ─────────────────────────────────────────────
-- Стара сигнатура йде: інакше PostgREST бачив би дві перевантажені функції
-- й не знав, яку викликати. Параметр p_expires_at лишається в новій — ним
-- користуються вкладки зі старою версією застосунку, доки Service Worker не
-- оновить їх; такі посилання отримують момент без зони, як і раніше.

drop function public.create_share(uuid, uuid[], text, text, boolean, boolean, timestamptz);

create function public.create_share(
  p_list_id            uuid,
  p_item_ids           uuid[],
  p_title              text,
  p_message            text default null,
  p_hide_prices        boolean default false,
  p_allow_reservations boolean default true,
  p_expires_at         timestamptz default null,
  p_expires_on         date default null,
  p_expires_tz         text default null
)
returns public.shares
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_share   public.shares;
  v_expires timestamptz;
  v_tz      text;
begin
  if p_item_ids is null or array_length(p_item_ids, 1) is null then
    raise exception 'Потрібно вибрати хоча б одну позицію' using errcode = '22023';
  end if;

  if p_expires_on is not null then
    -- Браузери називають зону за ICU, а там канонічні — старі імена:
    -- Chrome у Києві каже `Europe/Kiev`, в Індії — `Asia/Calcutta`. Сучасна
    -- tzdata без пакета зі старими посиланнями (Ubuntu 24.04) таких імен не
    -- знає. Тож спершу сучасне імʼя для старого, далі як є, далі навпаки —
    -- для бази зі старою tzdata. Зберігаємо те, що база справді знає.
    with aliases(old, new) as (values
      ('Europe/Kiev',          'Europe/Kyiv'),
      ('Europe/Uzhgorod',      'Europe/Kyiv'),
      ('Europe/Zaporozhye',    'Europe/Kyiv'),
      ('Asia/Calcutta',        'Asia/Kolkata'),
      ('Asia/Saigon',          'Asia/Ho_Chi_Minh'),
      ('Asia/Katmandu',        'Asia/Kathmandu'),
      ('Asia/Rangoon',         'Asia/Yangon'),
      ('Atlantic/Faeroe',      'Atlantic/Faroe'),
      ('America/Godthab',      'America/Nuuk'),
      ('America/Buenos_Aires', 'America/Argentina/Buenos_Aires'),
      ('America/Indianapolis', 'America/Indiana/Indianapolis'),
      ('America/Louisville',   'America/Kentucky/Louisville'),
      ('Pacific/Enderbury',    'Pacific/Kanton'),
      ('Pacific/Ponape',       'Pacific/Pohnpei'),
      ('Pacific/Truk',         'Pacific/Chuuk'),
      ('Africa/Asmera',        'Africa/Asmara')
    ),
    candidates(name, rank) as (
      select new, 0 from aliases where old = p_expires_tz
      union all
      select p_expires_tz, 1
      union all
      select old, 2 from aliases where new = p_expires_tz
    )
    select c.name into v_tz
      from candidates c
      join pg_catalog.pg_timezone_names z on z.name = c.name
     order by c.rank, c.name
     limit 1;

    if v_tz is null then
      raise exception 'bad_time_zone' using errcode = '22023';
    end if;
    -- Останню секунду дня за зоною власника. `timestamp at time zone` читає
    -- годинник як місцевий у цій зоні, тож літній час враховано.
    v_expires := (p_expires_on + time '23:59:59') at time zone v_tz;
  elsif p_expires_at is not null then
    v_expires := p_expires_at;
  end if;

  -- Посилання, мертве з народження, нікому не потрібне: власник надішле його
  -- й не зрозуміє, чому гість бачить «недоступне».
  if v_expires is not null and v_expires <= now() then
    raise exception 'expires_in_past' using errcode = '22023';
  end if;

  insert into public.shares (owner_id, source_list_id, token, title, message,
                             hide_prices, allow_reservations, expires_at, expires_tz)
  values (auth.uid(), p_list_id, public.gen_share_token(), p_title, p_message,
          p_hide_prices, p_allow_reservations, v_expires, v_tz)
  returning * into v_share;
  -- RLS shares_insert_own перевіряє, що список належить викликачу.

  insert into public.share_items (share_id, item_id)
  select v_share.id, i.id
  from public.items i
  where i.id = any(p_item_ids)
    and i.list_id = p_list_id;
  -- RLS items_select_own відсіє чужі позиції.

  return v_share;
end;
$$;

revoke execute on function public.create_share(uuid, uuid[], text, text, boolean, boolean, timestamptz, date, text)
  from public, anon;
grant execute on function public.create_share(uuid, uuid[], text, text, boolean, boolean, timestamptz, date, text)
  to authenticated;

-- ─────────────────────────────────────────────
-- get_shared_list — термін для гостя
-- ─────────────────────────────────────────────
-- Гість бачить, до коли діє посилання, і в чиїй зоні цей час. Мертве
-- посилання, як і раніше, дає однакове not_found (CLAUDE.md §3.3): термін
-- показується лише живому.
--
-- Решта тіла не змінилася відносно 20260928120000_sections_and_order.sql.

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
