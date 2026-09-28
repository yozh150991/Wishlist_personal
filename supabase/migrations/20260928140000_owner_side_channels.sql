-- 20260928140000_owner_side_channels.sql
-- Закриває побічні канали, якими власник міг би вирахувати позначки гостей
-- поза гостьовою сторінкою (ADR-038, CLAUDE.md §3.2), і посилює код гостя.
--
-- Знайдено ревʼю гілки дизайну v1:
--   1. release_claim відповідав власнику сумою позначок позиції, навіть з
--      чужим ключем, — на відміну від claim_item і redeem_guest_code, які
--      власника відсікають.
--   2. Зміна первинного ключа позиції чи списку падала на зовнішньому ключі
--      claims / guest_identities / guest_code_attempts лише тоді, коли
--      позначки є, — і PostgREST віддавав власнику назву таблиці `claims`.
--      Канал живе й після того, як посилання відкликане.
--   3. shares.source_list_id можна було переписати на чужий список: політика
--      shares_update_own перевіряє лише власника посилання, а не списку.
--      Тоді get_shared_list віддавав валюту, дату й відтінок чужого списку,
--      а redeem_guest_code перебирав коди чужих гостей.
--   4. Короткий код генерувався з random() — не криптографічного джерела.

-- ─────────────────────────────────────────────
-- 1. release_claim: власнику — та сама відмова, що й у claim_item
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
  -- Відповідь несе taken_qty — суму позначок усіх гостей. Власнику її не
  -- віддаємо ніде (ADR-009, ADR-038), і тут теж.
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
    delete from public.claims where item_id = p_item_id and identity_id = v_identity;
  end if;

  return jsonb_build_object(
    'taken_qty', (select coalesce(sum(quantity), 0)::int from public.claims where item_id = p_item_id)
  );
end;
$$;

-- ─────────────────────────────────────────────
-- 2–3. Незмінні ідентифікатори
-- ─────────────────────────────────────────────
-- BEFORE-тригер спрацьовує раніше за перевірки зовнішніх ключів (ті йдуть
-- наприкінці оператора), тож відмова однакова — є позначки чи нема.
-- Законної причини міняти id позиції чи списку в застосунку немає; черга
-- змін і імпорт створюють нові рядки, а не переписують ключі.

create or replace function public.keep_columns()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_col text;
begin
  foreach v_col in array tg_argv loop
    if (to_jsonb(new) -> v_col) is distinct from (to_jsonb(old) -> v_col) then
      raise exception 'immutable_column' using errcode = '42501',
        detail = format('%s.%s не змінюється', tg_table_name, v_col);
    end if;
  end loop;
  return new;
end;
$$;

revoke execute on function public.keep_columns() from public, anon, authenticated;

create trigger lists_keep_identity
  before update on public.lists
  for each row execute function public.keep_columns('id');

create trigger items_keep_identity
  before update on public.items
  for each row execute function public.keep_columns('id');

-- Посилання належить тому списку, з якого створене. Переписати його на інший
-- — навіть свій — означало б показати гостям чужий набір позицій під старим
-- токеном; на чужий — віддати чужі дані.
create trigger shares_keep_identity
  before update on public.shares
  for each row execute function public.keep_columns('id', 'source_list_id', 'owner_id');

-- ─────────────────────────────────────────────
-- 4. Код гостя — з криптографічного джерела
-- ─────────────────────────────────────────────
-- gen_random_uuid() бере байти з того самого джерела, що й токени посилань
-- (ADR-014). 31 символ: 256 mod 31 = 8, тож перші вісім символів алфавіту
-- трохи ймовірніші (9/256 проти 8/256) — для коду за лімітом у пʼять спроб на
-- годину це неважливо.

create or replace function public.gen_guest_code(p_list_id uuid)
returns text
language plpgsql
volatile
set search_path = public
as $$
declare
  v_alphabet constant text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  v_bytes bytea;
  v_code  text;
begin
  loop
    v_bytes := uuid_send(gen_random_uuid());
    -- Байти 0..4: у UUIDv4 фіксовані лише біти версії (байт 6) і варіанта (байт 8).
    select string_agg(substr(v_alphabet, 1 + get_byte(v_bytes, n) % length(v_alphabet), 1), '' order by n)
      into v_code
      from generate_series(0, 4) n;
    exit when not exists (select 1 from public.guest_identities
                           where list_id = p_list_id and short_code = v_code);
  end loop;
  return v_code;
end;
$$;

revoke execute on function public.gen_guest_code(uuid) from public, anon, authenticated;
