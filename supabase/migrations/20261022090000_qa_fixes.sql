-- Виправлення за QA-звітом (docs/QA_REPORT.md, ADR-069, ADR-070).
--
-- Схема:
--   BUG-QA-03  guest_code_attempts.kind — окремі лічильники «ввести код» і
--              «надіслати код», по 10 на годину на список (ADR-070).
--   BUG-QA-05  межі довжини назв — на сирому рядку, а не після btrim.
--   BUG-QA-07  items.list_id і sections.list_id незмінні; у посилання — лише
--              позиції його ж списку (політика share_items і get_shared_list).
--   BUG-QA-11  імена гостей і учасників збору без невидимих символів і
--              керування напрямом тексту (ZWJ у емодзі лишається дозволеним).
-- Функції (тіла — поточні, змінено лише позначене BUG-QA-NN):
--   BUG-QA-01  pledge_pool        округлення до перевірки суми
--   BUG-QA-02  start_pool         округлення до перевірки цілі
--   BUG-QA-03  redeem_guest_code, send_guest_code
--   BUG-QA-04  list_items_page    пошук буквально: \, % і _ екрановано
--   BUG-QA-06  create_share       без жодної позиції — no_items
--   BUG-QA-07  get_shared_list    лише позиції списку посилання
--   BUG-QA-08  close_pool         p_closed = NULL нічого не змінює
--   BUG-QA-09  claim_item         сума броней у bigint
--   BUG-QA-10  list_items_page    p_limit = NULL — bad_limit
--   BUG-QA-11  claim_item_v2, start_pool, pledge_pool
--
-- Нових функцій немає, тож гранти не змінюються (CREATE OR REPLACE їх зберігає).
-- Інваріанти §3 не зачеплено: власник, як і раніше, не бачить позначок, а
-- нові відмови (immutable_column, no_items) від позначок не залежать (ADR-038).

-- ═════════════════════════════════════════════
-- BUG-QA-03: окремі лічильники спроб коду
-- ═════════════════════════════════════════════

alter table public.guest_code_attempts
  add column kind text not null default 'redeem'
  constraint guest_code_attempts_kind_check check (kind in ('redeem', 'send'));

comment on column public.guest_code_attempts.kind is
  'redeem — невдала спроба ввести код (ліміт 10 на годину на список); send — запит «надіслати код на пошту» (окремо, теж 10). ADR-070.';

-- ═════════════════════════════════════════════
-- BUG-QA-05: межа довжини — на сирому рядку
-- ═════════════════════════════════════════════
-- Спершу обрізаємо те, що вже могло потрапити з пробілами довкола, — інакше
-- нове обмеження не стане.

update public.lists       set title = btrim(title) where char_length(title) > 120;
update public.items       set title = btrim(title) where char_length(title) > 200;
update public.sections    set title = btrim(title) where char_length(title) > 60;
update public.shares      set title = btrim(title) where char_length(title) > 120;
update public.appearances set name  = btrim(name)  where char_length(name)  > 24;

alter table public.lists drop constraint lists_title_check,
  add constraint lists_title_check check (char_length(title) <= 120 and char_length(btrim(title)) >= 1);
alter table public.items drop constraint items_title_check,
  add constraint items_title_check check (char_length(title) <= 200 and char_length(btrim(title)) >= 1);
alter table public.sections drop constraint sections_title_check,
  add constraint sections_title_check check (char_length(title) <= 60 and char_length(btrim(title)) >= 1);
alter table public.shares drop constraint shares_title_check,
  add constraint shares_title_check check (char_length(title) <= 120 and char_length(btrim(title)) >= 1);
alter table public.appearances drop constraint appearances_name_check,
  add constraint appearances_name_check check (char_length(name) <= 24 and char_length(btrim(name)) >= 1);

-- ═════════════════════════════════════════════
-- BUG-QA-07: позиція не переходить між списками
-- ═════════════════════════════════════════════

drop trigger items_keep_identity on public.items;
create trigger items_keep_identity
  before update on public.items
  for each row execute function public.keep_columns('id', 'list_id');

create trigger sections_keep_identity
  before update on public.sections
  for each row execute function public.keep_columns('id', 'list_id');

-- Рядки, що вже вказують на позицію чужого для посилання списку.
delete from public.share_items si
 using public.shares s, public.items i
 where s.id = si.share_id and i.id = si.item_id and i.list_id <> s.source_list_id;

drop policy share_items_insert_own on public.share_items;
create policy share_items_insert_own on public.share_items
  for insert to authenticated
  with check (
    exists (select 1
              from public.shares s
              join public.items i on i.id = item_id
             where s.id = share_id
               and s.owner_id = auth.uid()
               and i.owner_id = auth.uid()
               and i.list_id = s.source_list_id)
  );

-- ═════════════════════════════════════════════
-- BUG-QA-11: невидимі символи в іменах
-- ═════════════════════════════════════════════

update public.guest_identities
   set name = nullif(btrim(regexp_replace(name, '[\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]', '', 'g')), '')
 where name ~ '[\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]';
update public.gift_pools
   set organizer = coalesce(nullif(btrim(regexp_replace(organizer, '[\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]', '', 'g')), ''), '—')
 where organizer ~ '[\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]';
update public.gift_pool_pledges
   set name = coalesce(nullif(btrim(regexp_replace(name, '[\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]', '', 'g')), ''), '—')
 where name ~ '[\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]';

alter table public.guest_identities
  add constraint guest_identities_name_visible check (name is null or name !~ '[\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]');
alter table public.gift_pools
  add constraint gift_pools_organizer_visible check (organizer !~ '[\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]');
alter table public.gift_pool_pledges
  add constraint gift_pool_pledges_name_visible check (name !~ '[\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]');

-- ═════════════════════════════════════════════
-- Функції
-- ═════════════════════════════════════════════

-- ── pledge_pool ──
CREATE OR REPLACE FUNCTION public.pledge_pool(p_token text, p_pool_id uuid, p_key text, p_name text, p_amount numeric, p_locale text DEFAULT 'uk'::text, p_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  if v_name ~ '[\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]' then
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

  insert into public.gift_pool_pledges (pool_id, identity_id, name, amount)
  values (p_pool_id, v_identity, v_name, p_amount)
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
      jsonb_build_object('name', v_name, 'amount', p_amount));
  end if;

  return jsonb_build_object('code', v_code);
end;
$function$;

-- ── start_pool ──
CREATE OR REPLACE FUNCTION public.start_pool(p_token text, p_item_id uuid, p_key text, p_name text, p_instructions text, p_goal numeric DEFAULT NULL::numeric, p_email text DEFAULT NULL::text, p_locale text DEFAULT 'uk'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- BUG-QA-11
  if v_name ~ '[\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]' then
    raise exception 'bad_name' using errcode = '22023';
  end if;

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

  -- BUG-QA-02: округлюємо до перевірки, а не після.
  v_goal := round(coalesce(p_goal, case when v_share.hide_prices then null else v_item.price end), 2);
  if v_goal is null or v_goal <= 0 or v_goal > 1000000 then
    raise exception 'bad_goal' using errcode = '22023';
  end if;

  -- Ціла позиція, як «Беру»: зайнята — not_enough_left, архів — list_archived.
  v_result := public.claim_item_v2(p_token, p_item_id, p_key, 1, v_name, p_email, p_locale);
  v_identity := public.guest_identity_of(v_share.source_list_id, p_key);

  insert into public.gift_pools (item_id, organizer_id, organizer, instructions, goal, currency, share_id, item_title)
  values (p_item_id, v_identity, v_name, v_text, v_goal, v_currency, v_share.id, v_item.title)
  returning id into v_pool;

  return v_result || jsonb_build_object('pool_id', v_pool);
end;
$function$;

-- ── claim_item_v2 ──
CREATE OR REPLACE FUNCTION public.claim_item_v2(p_token text, p_item_id uuid, p_key text, p_quantity integer DEFAULT 1, p_name text DEFAULT NULL::text, p_email text DEFAULT NULL::text, p_locale text DEFAULT 'uk'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_name     text;
  v_email    text;
  v_result   jsonb;
  v_share    public.shares;
  v_identity uuid;
begin
  if p_name is not null then
    v_name := nullif(btrim(p_name), '');
    if v_name is not null and (char_length(v_name) > 60 or v_name ~ '[[:cntrl:]]' or v_name ~ '[\u00AD\u061C\u180E\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]') then
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
$function$;

-- ── claim_item ──
CREATE OR REPLACE FUNCTION public.claim_item(p_token text, p_item_id uuid, p_key text, p_quantity integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  if v_others::bigint + p_quantity > v_item.quantity then
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
$function$;

-- ── redeem_guest_code ──
CREATE OR REPLACE FUNCTION public.redeem_guest_code(p_token text, p_code text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- BUG-QA-03 (ADR-070): рахуються лише невдалі коди й лише свої —
  -- запити «надіслати код» мають окремий лічильник у send_guest_code.
  select count(*) into v_attempts
    from public.guest_code_attempts
   where list_id = v_list_id and kind = 'redeem';
  if v_attempts >= 10 then
    return jsonb_build_object('error', 'too_many_attempts');
  end if;

  select id into v_identity
    from public.guest_identities
   where list_id = v_list_id and short_code = upper(btrim(coalesce(p_code, '')));
  if v_identity is null then
    insert into public.guest_code_attempts (list_id, kind) values (v_list_id, 'redeem');
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
$function$;

-- ── send_guest_code ──
CREATE OR REPLACE FUNCTION public.send_guest_code(p_token text, p_email text, p_locale text DEFAULT 'uk'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  -- Той самий журнал і блокування, що в redeem_guest_code, але свій лічильник
  -- (BUG-QA-03, ADR-070): запит листа не перебирає коди, тож не має забирати
  -- спроби в гостя, який вводить свій код.
  perform 1 from public.lists where id = v_list_id for update;
  delete from public.guest_code_attempts
   where list_id = v_list_id and attempted_at < now() - interval '1 hour';
  select count(*) into v_attempts
    from public.guest_code_attempts
   where list_id = v_list_id and kind = 'send';
  if v_attempts >= 10 then
    return jsonb_build_object('error', 'too_many_attempts');
  end if;
  insert into public.guest_code_attempts (list_id, kind) values (v_list_id, 'send');

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
$function$;

-- ── list_items_page ──
CREATE OR REPLACE FUNCTION public.list_items_page(p_list_id uuid, p_sort text DEFAULT 'created_at'::text, p_desc boolean DEFAULT true, p_limit integer DEFAULT 25, p_cursor_key text DEFAULT NULL::text, p_cursor_id uuid DEFAULT NULL::uuid, p_search text DEFAULT NULL::text, p_status item_status[] DEFAULT NULL::item_status[], p_price_min numeric DEFAULT NULL::numeric, p_price_max numeric DEFAULT NULL::numeric)
 RETURNS SETOF items
 LANGUAGE plpgsql
 STABLE
 SET search_path TO 'public'
AS $function$
declare
  v_key  text;
  v_cast text;
  v_dir  text;
  v_cmp  text;
begin
  -- Білий список: у SQL підставляються тільки ці значення, ніколи не введення користувача.
  case p_sort
    when 'created_at' then v_key := 'i.created_at';                   v_cast := '::timestamptz';
    when 'title'      then v_key := 'i.title';                        v_cast := '::text';
    when 'price'      then v_key := 'coalesce(i.price, (-1)::numeric)'; v_cast := '::numeric';
    when 'priority'   then v_key := 'i.priority';                     v_cast := '::public.item_priority';
    else raise exception 'bad_sort' using errcode = '22023';
  end case;

  if p_limit is null or p_limit not in (10, 25, 50, 100) then
    raise exception 'bad_limit' using errcode = '22023';
  end if;

  v_dir := case when p_desc then 'desc' else 'asc' end;
  v_cmp := case when p_desc then '<'    else '>'   end;

  -- Курсор і ORDER BY використовують один і той самий вираз та одні правила
  -- порівняння. Якщо вони розійдуться, пагінація почне губити рядки.
  return query execute format($q$
    select i.*
    from public.items i
    where i.list_id = $1
      and ($2::text is null or i.title ilike '%%' || replace(replace(replace($2, '\', '\\'), '%%', '\%%'), '_', '\_') || '%%')
      and ($3::public.item_status[] is null or i.status = any($3))
      and ($4::numeric is null or i.price >= $4)
      and ($5::numeric is null or i.price <= $5)
      and ($7::uuid is null or (%s, i.id) %s ($6%s, $7::uuid))
    order by %s %s, i.id %s
    limit $8
  $q$, v_key, v_cmp, v_cast, v_key, v_dir, v_dir)
  using p_list_id, p_search, p_status, p_price_min, p_price_max,
        p_cursor_key, p_cursor_id, p_limit;
end;
$function$;

-- ── create_share ──
CREATE OR REPLACE FUNCTION public.create_share(p_list_id uuid, p_item_ids uuid[], p_title text, p_message text DEFAULT NULL::text, p_hide_prices boolean DEFAULT false, p_allow_reservations boolean DEFAULT true, p_expires_at timestamp with time zone DEFAULT NULL::timestamp with time zone, p_expires_on date DEFAULT NULL::date, p_expires_tz text DEFAULT NULL::text)
 RETURNS shares
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_share   public.shares;
  v_expires timestamptz;
  v_tz      text;
  v_count   integer;
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
  -- RLS items_select_own відсіє чужі позиції, тригер — чернетки.
  get diagnostics v_count = row_count;
  -- BUG-QA-06: якщо не лишилось жодної — посилання не створюємо зовсім
  -- (виняток відкочує й рядок shares).
  if v_count = 0 then
    raise exception 'no_items' using errcode = '22023';
  end if;

  return v_share;
end;
$function$;

-- ── close_pool ──
CREATE OR REPLACE FUNCTION public.close_pool(p_token text, p_pool_id uuid, p_key text, p_closed boolean)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  -- BUG-QA-08: без явного «так» чи «ні» стан збору не змінюється.
  if p_closed is null then
    return;
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
$function$;

-- ── get_shared_list ──
CREATE OR REPLACE FUNCTION public.get_shared_list(p_token text, p_key text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
      and i.list_id = v_share.source_list_id
      and i.status = 'active'
  ) t;

  select coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title)
                            order by s.position, s.created_at), '[]'::jsonb)
  into v_sections
  from public.sections s
  where s.list_id = v_list.id
    and exists (select 1 from public.share_items si
                  join public.items i on i.id = si.item_id
                 where si.share_id = v_share.id and i.list_id = v_share.source_list_id
                   and i.status = 'active' and i.section_id = s.id);

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
    -- ADR-058: архівний список гості бачать, але не бронюють.
    'allow_reservations', v_share.allow_reservations and not v_list.is_archived and not v_is_owner,
    'archived',           v_list.is_archived,
    'viewer_is_owner',    v_is_owner,
    'guest',              case when v_code is null then null else jsonb_build_object('code', v_code) end,
    'sections',           v_sections,
    'items',              v_items
  );
end;
$function$;
