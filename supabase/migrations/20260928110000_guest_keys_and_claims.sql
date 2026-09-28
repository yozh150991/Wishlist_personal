-- 20260928110000_guest_keys_and_claims.sql
-- Гість без акаунта: ключ у посиланні, короткий код, позначки на рівні
-- списку, сліпе скидання власником (ADR-035).
--
-- Три діри з одного кореня (дизайн, файл 10): у гостя немає імені, тому
-- система не знає, кому належить позначка; не знаючи цього, вона не може ні
-- повернути її на іншому пристрої, ні показати «усе розібрали», ні дати
-- фільтр «вільні». Рішення тримається на обмеженні, яке вже взято: власник
-- не бачить позначок (CLAUDE.md §3.2). Тож ключ гостя — не «людина, яку
-- впізнає власник», а лише носій права на свої позначки в одному списку.
--
-- Що змінюється:
--   * reservations (позначка на посилання, guest_key відкритим текстом) →
--     claims (позначка на позицію списку, через ідентичність гостя);
--   * guest_identities + guest_keys: одна ідентичність гостя в одному списку
--     може мати кілька ключів — по одному на пристрій. Зберігається лише
--     sha256(list_id:ключ), ніколи сам ключ;
--   * короткий код із 5 символів одноразово переносить позначки на новий
--     пристрій; 5 спроб на годину на список;
--   * мертве посилання — однакова відповідь на всі три причини;
--   * release_item_claims — сліпе «скинути позицію» для власника.
--
-- Кількість лишається: позначка несе, скільки штук бере гість («Візьму 1 з 2»).
--
-- Порядок викатки: міграція видаляє старі reserve_item / unreserve_item і
-- змінює сигнатуру get_shared_list. Фронтенд, що їх кличе, після міграції
-- показуватиме гостям помилку, тож міграцію застосовують разом із деплоєм
-- фронтенду (DEPLOY.md).

-- ─────────────────────────────────────────────
-- Ідентичність гостя
-- ─────────────────────────────────────────────

create table public.guest_identities (
  id         uuid primary key default gen_random_uuid(),
  list_id    uuid not null references public.lists(id) on delete cascade,
  -- 5 символів без схожих на око: 0/O, 1/I/L. 31^5 ≈ 28,6 млн на список.
  short_code text not null check (short_code ~ '^[2-9ABCDEFGHJKMNPQRSTUVWXYZ]{5}$'),
  created_at timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  unique (list_id, short_code)
);

comment on table public.guest_identities is
  'Гість одного списку. Ні імені, ні пошти, ні IP — лише код для переносу на інший пристрій. ІНВАРІАНТ: власник не має доступу (CLAUDE.md §3.2).';

create table public.guest_keys (
  -- sha256(list_id || ':' || ключ). list_id у хеші: ключ зі списку A,
  -- підставлений у список B, дає інший хеш і не впізнається.
  key_hash    bytea primary key check (length(key_hash) = 32),
  identity_id uuid not null references public.guest_identities(id) on delete cascade,
  created_at  timestamptz not null default now()
);

comment on table public.guest_keys is
  'Ключі пристроїв гостя. Сам ключ не зберігається — лише sha256(list_id:ключ). Кілька ключів на ідентичність: код переносить позначки на новий пристрій, старий лишається робочим.';

create index guest_keys_identity_idx on public.guest_keys (identity_id);

-- ─────────────────────────────────────────────
-- Позначки
-- ─────────────────────────────────────────────

create table public.claims (
  item_id     uuid not null references public.items(id) on delete cascade,
  identity_id uuid not null references public.guest_identities(id) on delete cascade,
  quantity    integer not null default 1 check (quantity between 1 and 999),
  created_at  timestamptz not null default now(),
  primary key (item_id, identity_id)
);

comment on table public.claims is
  'ІНВАРІАНТ: власник НЕ МАЄ доступу до цієї таблиці — ні через RLS, ні через RPC, ні через вʼю. Час позначки гостям теж не віддається: «взяли 12 хвилин тому» деанонімізує. CLAUDE.md §3.2.';

create index claims_identity_idx on public.claims (identity_id);

-- ─────────────────────────────────────────────
-- Спроби коду: 5 на годину на список
-- ─────────────────────────────────────────────

create table public.guest_code_attempts (
  list_id      uuid not null references public.lists(id) on delete cascade,
  attempted_at timestamptz not null default now()
);

comment on table public.guest_code_attempts is
  'Журнал спроб ввести короткий код — для ліміту 5 на годину на список. Без IP і без ключів; старше години стирається при кожній спробі.';

create index guest_code_attempts_list_idx on public.guest_code_attempts (list_id, attempted_at);

-- ─────────────────────────────────────────────
-- Доступ: нікому напряму
-- ─────────────────────────────────────────────

alter table public.guest_identities    enable row level security;
alter table public.guest_keys          enable row level security;
alter table public.claims              enable row level security;
alter table public.guest_code_attempts enable row level security;

revoke all on public.guest_identities, public.guest_keys, public.claims, public.guest_code_attempts
  from anon, authenticated;
-- ↑ ІНВАРІАНТ: жодної політики. Читає й пише лише SECURITY DEFINER RPC гостя
--   й сліпе скидання власника, яке нічого не повертає.

-- ─────────────────────────────────────────────
-- Внутрішні помічники
-- ─────────────────────────────────────────────

-- Хеш ключа, прив'язаний до списку. sha256 — вбудована функція ядра,
-- pgcrypto не потрібне (ADR-014).
create or replace function public.guest_key_hash(p_list_id uuid, p_key text)
returns bytea
language sql
immutable
set search_path = public
as $$
  select sha256(convert_to(p_list_id::text || ':' || p_key, 'UTF8'));
$$;

-- Новий короткий код, унікальний у межах списку.
create or replace function public.gen_guest_code(p_list_id uuid)
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  v_alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  v_code text;
begin
  loop
    select string_agg(substr(v_alphabet, 1 + floor(random() * length(v_alphabet))::int, 1), '')
      into v_code
      from generate_series(1, 5);
    exit when not exists (select 1 from public.guest_identities
                           where list_id = p_list_id and short_code = v_code);
  end loop;
  return v_code;
end;
$$;

-- Живе посилання за токеном або null. Одна перевірка для всіх гостьових
-- функцій, щоб відповідь на неіснуючий, відкликаний і протермінований токен
-- була однакова.
create or replace function public.live_share(p_token text)
returns public.shares
language sql
stable
security definer
set search_path = public
as $$
  select s.* from public.shares s
   where s.token = p_token
     and s.revoked_at is null
     and (s.expires_at is null or s.expires_at > now());
$$;

-- Ідентичність гостя за ключем у межах списку або null.
create or replace function public.guest_identity_of(p_list_id uuid, p_key text)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select k.identity_id
    from public.guest_keys k
    join public.guest_identities g on g.id = k.identity_id
   where p_key is not null
     and k.key_hash = public.guest_key_hash(p_list_id, p_key)
     and g.list_id = p_list_id;
$$;

revoke execute on function public.guest_key_hash(uuid, text)    from public, anon, authenticated;
revoke execute on function public.gen_guest_code(uuid)          from public, anon, authenticated;
revoke execute on function public.live_share(text)              from public, anon, authenticated;
revoke execute on function public.guest_identity_of(uuid, text) from public, anon, authenticated;

-- ─────────────────────────────────────────────
-- Перенесення наявних броней
-- ─────────────────────────────────────────────
-- Старий guest_key — випадковий рядок із localStorage браузера, один на всі
-- списки. Тепер він стає ключем цього браузера в кожному списку, де є його
-- броні: хеш береться зі списку, тож ключі різних списків не перетинаються.
-- Застосунок підхоплює старий ключ сам, і гість бачить свої броні як раніше.
-- Броні того самого гостя через два посилання одного списку складаються.

do $$
declare
  r record;
  v_identity uuid;
begin
  for r in
    select distinct s.source_list_id as list_id, res.guest_key
      from public.reservations res
      join public.shares s on s.id = res.share_id
  loop
    insert into public.guest_identities (list_id, short_code)
    values (r.list_id, public.gen_guest_code(r.list_id))
    returning id into v_identity;

    insert into public.guest_keys (key_hash, identity_id)
    values (public.guest_key_hash(r.list_id, r.guest_key), v_identity);

    insert into public.claims (item_id, identity_id, quantity, created_at)
    select res.item_id, v_identity, least(sum(res.quantity), max(i.quantity))::int, min(res.created_at)
      from public.reservations res
      join public.shares s on s.id = res.share_id
      join public.items i on i.id = res.item_id
     where s.source_list_id = r.list_id and res.guest_key = r.guest_key
     group by res.item_id;
  end loop;
end $$;

-- Старі функції й таблиця йдуть разом: у reservations ключі гостей лежали
-- відкритим текстом, і лишати їх після перенесення нема навіщо.
drop function public.reserve_item(text, uuid, text, integer);
drop function public.unreserve_item(text, uuid, text);
drop function public.get_shared_list(text);
drop table public.reservations;

-- ─────────────────────────────────────────────
-- get_shared_list — гостьовий перегляд
-- ─────────────────────────────────────────────
--
-- p_key — ключ гостя або null. З ним відповідь каже, скільки взяв саме цей
-- гість (mine_qty) і його короткий код; без нього — лише скільки взято всього.
-- Ні хто, ні коли — нічого з того, що видало б гостей одне одному.
--
-- Мертве посилання — одна відповідь на всі три причини: 'not_found'. Сторінка
-- не має підтверджувати, що токен колись існував.

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

  select coalesce(jsonb_agg(x order by x->>'created_at' desc), '[]'::jsonb)
  into v_items
  from (
    select jsonb_build_object(
      'id',        i.id,
      'title',     i.title,
      'url',       i.url,
      'price',     case when v_share.hide_prices then null else i.price end,
      'quantity',  i.quantity,
      'priority',  i.priority,
      'note',      i.note,
      'variants',  i.variants,
      'image_url', i.image_url,
      'status',    i.status,
      'created_at', i.created_at,
      'taken_qty', case
        when v_is_owner then null
        else coalesce((select sum(c.quantity)::int from public.claims c where c.item_id = i.id), 0)
      end,
      'mine_qty', case
        when v_is_owner then null
        else coalesce((select c.quantity from public.claims c
                        where c.item_id = i.id and c.identity_id = v_identity), 0)
      end
    ) as x
    from public.share_items si
    join public.items i on i.id = si.item_id
    where si.share_id = v_share.id
      and i.status = 'active'
  ) t;

  return jsonb_build_object(
    'title',              v_share.title,
    'message',            v_share.message,
    'currency',           v_list.currency,
    'event_date',         v_list.event_date,
    'owner_scheme',       (select p.scheme from public.profiles p where p.id = v_share.owner_id),
    'appearance_hue',     (select a.hue from public.appearances a where a.id = v_list.appearance_id),
    'hide_prices',        v_share.hide_prices,
    'allow_reservations', v_share.allow_reservations and not v_is_owner,
    'viewer_is_owner',    v_is_owner,
    'guest',              case when v_code is null then null else jsonb_build_object('code', v_code) end,
    'items',              v_items
  );
end;
$$;

-- ─────────────────────────────────────────────
-- claim_item — «Я візьму це»
-- ─────────────────────────────────────────────
--
-- Перша позначка нічого не питає: ключ приходить із браузера гостя
-- (згенерований і збережений там до виклику — обірвана відповідь не лишить
-- позначку без власника), а ідентичність і код створюються тут тихо.
--
-- p_quantity — підсумкова кількість цього гостя, не приріст. Позиція
-- блокується на час перевірки: двоє гостей, що тиснуть одночасно, не
-- візьмуть більше, ніж треба.

create or replace function public.claim_item(
  p_token    text,
  p_item_id  uuid,
  p_key      text,
  p_quantity integer default 1
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share    public.shares;
  v_item     public.items;
  v_identity uuid;
  v_code     text;
  v_others   integer;
begin
  v_share := public.live_share(p_token);
  if v_share.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not v_share.allow_reservations then
    raise exception 'reservations_disabled' using errcode = '22023';
  end if;
  if auth.uid() is not null and auth.uid() = v_share.owner_id then
    raise exception 'owner_cannot_reserve' using errcode = '22023';
  end if;
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{22,64}$' then
    raise exception 'bad_key' using errcode = '22023';
  end if;
  if p_quantity is null or p_quantity < 1 then
    raise exception 'bad_quantity' using errcode = '22023';
  end if;

  select i.* into v_item
    from public.items i
    join public.share_items si on si.item_id = i.id and si.share_id = v_share.id
   where i.id = p_item_id and i.status = 'active'
   for update of i;
  if v_item.id is null then
    raise exception 'item_not_in_share' using errcode = 'P0002';
  end if;

  v_identity := public.guest_identity_of(v_item.list_id, p_key);
  if v_identity is null then
    insert into public.guest_identities (list_id, short_code)
    values (v_item.list_id, public.gen_guest_code(v_item.list_id))
    returning id into v_identity;
    insert into public.guest_keys (key_hash, identity_id)
    values (public.guest_key_hash(v_item.list_id, p_key), v_identity);
  end if;

  select coalesce(sum(quantity), 0) into v_others
    from public.claims
   where item_id = p_item_id and identity_id <> v_identity;

  if v_others + p_quantity > v_item.quantity then
    raise exception 'not_enough_left' using errcode = '22023';
  end if;

  insert into public.claims (item_id, identity_id, quantity)
  values (p_item_id, v_identity, p_quantity)
  on conflict (item_id, identity_id) do update set quantity = excluded.quantity;

  update public.guest_identities set last_seen = now()
   where id = v_identity
   returning short_code into v_code;

  return jsonb_build_object(
    'taken_qty', v_others + p_quantity,
    'mine_qty',  p_quantity,
    'code',      v_code
  );
end;
$$;

-- ─────────────────────────────────────────────
-- release_claim — «звільнити» свою позначку
-- ─────────────────────────────────────────────

create or replace function public.release_claim(
  p_token   text,
  p_item_id uuid,
  p_key     text
)
returns jsonb
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

  select i.list_id into v_list_id
    from public.items i
    join public.share_items si on si.item_id = i.id and si.share_id = v_share.id
   where i.id = p_item_id;
  if v_list_id is null then
    raise exception 'item_not_in_share' using errcode = 'P0002';
  end if;

  v_identity := public.guest_identity_of(v_list_id, p_key);
  if v_identity is not null then
    delete from public.claims where item_id = p_item_id and identity_id = v_identity;
  end if;

  return jsonb_build_object(
    'taken_qty', (select coalesce(sum(quantity), 0)::int from public.claims where item_id = p_item_id)
  );
end;
$$;

-- ─────────────────────────────────────────────
-- redeem_guest_code — «У мене вже щось відкладено»
-- ─────────────────────────────────────────────
--
-- Код переносить позначки на новий пристрій одноразово: пристрій отримує
-- новий ключ тієї самої ідентичності, старий лишається робочим, а код
-- змінюється — вдруге той самий не спрацює.
--
-- Ліміт — 5 спроб на годину на список, враховуються всі. Після п'ятої не
-- приймається навіть правильний — і відповідь прямо про це каже, а не
-- прикидається, що коду немає.
--
-- Невдача повертається у відповіді ({"error": …}), а не винятком: виняток
-- відкотив би й запис спроби, і ліміт рахував би лише вдалі.

create or replace function public.redeem_guest_code(p_token text, p_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share    public.shares;
  v_list_id  uuid;
  v_identity uuid;
  v_key      text;
  v_code     text;
  v_attempts integer;
begin
  v_share := public.live_share(p_token);
  if v_share.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if auth.uid() is not null and auth.uid() = v_share.owner_id then
    raise exception 'owner_cannot_reserve' using errcode = '22023';
  end if;
  v_list_id := v_share.source_list_id;

  -- Блокування списку серіалізує паралельні спроби: інакше шість запитів
  -- одночасно пройшли б перевірку ліміту всі.
  perform 1 from public.lists where id = v_list_id for update;

  delete from public.guest_code_attempts
   where list_id = v_list_id and attempted_at < now() - interval '1 hour';

  select count(*) into v_attempts from public.guest_code_attempts where list_id = v_list_id;
  if v_attempts >= 5 then
    return jsonb_build_object('error', 'too_many_attempts');
  end if;

  insert into public.guest_code_attempts (list_id) values (v_list_id);

  select id into v_identity
    from public.guest_identities
   where list_id = v_list_id and short_code = upper(btrim(coalesce(p_code, '')));
  if v_identity is null then
    return jsonb_build_object('error', 'code_not_found');
  end if;

  v_key := public.gen_share_token();
  insert into public.guest_keys (key_hash, identity_id)
  values (public.guest_key_hash(v_list_id, v_key), v_identity);

  update public.guest_identities
     set short_code = public.gen_guest_code(v_list_id), last_seen = now()
   where id = v_identity
   returning short_code into v_code;

  return jsonb_build_object(
    'key',    v_key,
    'code',   v_code,
    'claims', (select count(*)::int from public.claims where identity_id = v_identity)
  );
end;
$$;

-- ─────────────────────────────────────────────
-- release_item_claims — сліпе «скинути позицію» власником
-- ─────────────────────────────────────────────
--
-- Якщо власник не бачить позначок, він не може прибрати застряглу. Якщо може
-- прибрати — бачить, що вона є. Вихід — дія без відповіді: нічого не
-- повертає, і на позиції з позначками й без робить ту саму роботу.
-- PostgREST відповідає 204 без тіла.

create or replace function public.release_item_claims(p_item_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null
     or not exists (select 1 from public.items where id = p_item_id and owner_id = auth.uid()) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  delete from public.claims where item_id = p_item_id;
end;
$$;

-- ─────────────────────────────────────────────
-- Права
-- ─────────────────────────────────────────────

revoke all on function public.get_shared_list(text, text)             from public;
revoke all on function public.claim_item(text, uuid, text, integer)   from public;
revoke all on function public.release_claim(text, uuid, text)         from public;
revoke all on function public.redeem_guest_code(text, text)           from public;
revoke all on function public.release_item_claims(uuid)               from public, anon;

grant execute on function public.get_shared_list(text, text)           to anon, authenticated;
grant execute on function public.claim_item(text, uuid, text, integer) to anon, authenticated;
grant execute on function public.release_claim(text, uuid, text)       to anon, authenticated;
grant execute on function public.redeem_guest_code(text, text)         to anon, authenticated;
grant execute on function public.release_item_claims(uuid)             to authenticated;

-- register_share_view теж кличе мертве посилання мовчки однаково: вона нічого
-- не повертає й раніше, тож не змінюється.
