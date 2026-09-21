-- 20260921100000_item_variants.sql
-- Варіанти позиції: розмір, колір, модель — пари «підпис → значення» (ADR-030).
--
-- Зберігаються в jsonb, а не окремими колонками чи таблицею: набір ознак у
-- кожного товару свій, і в списку побажань він потрібен лише щоб показати
-- гостю підпис на картці. Причини й відхилені варіанти — в ADR-030.

alter table public.items
  add column variants jsonb not null default '[]'::jsonb;

-- Форма значення перевіряється вбудованими операторами jsonpath, без власної
-- SQL-функції. Це навмисно: кожна нова функція в `public` вимагає явних
-- грантів і запису в білий список `01_schema_guards.test.sql` (CLAUDE.md §3.4),
-- а перевірка форми даних такої ціни не варта.
--
-- `strict` у першій умові обовʼязковий: у режимі `lax` вираз `$[*]` розгортає
-- вкладені масиви, і `[[{...}]]` пройшло б як обʼєкт.
--
-- Межі: до 5 пар, підпис до 40 символів, значення до 80, обидва не порожні й
-- без переносів рядка — інакше вони ламають рядок чипів на картці.
alter table public.items
  add constraint items_variants_shape check (
    jsonb_typeof(variants) = 'array'
    and jsonb_array_length(variants) <= 5
    and not (variants @? 'strict $[*] ? (@.type() != "object")')
    and not (variants @? '$[*].keyvalue() ? (@.key != "label" && @.key != "value")')
    and not (variants @? '$[*] ? (!(exists(@.label) && exists(@.value)))')
    and not (variants @? '$[*] ? (@.label.type() != "string" || @.value.type() != "string")')
    and not (variants @? '$[*].label ? (!(@ like_regex "\\S"))')
    and not (variants @? '$[*].value ? (!(@ like_regex "\\S"))')
    and not (variants @? '$[*].label ? (@ like_regex "^.{41,}$" flag "s")')
    and not (variants @? '$[*].value ? (@ like_regex "^.{81,}$" flag "s")')
    and not (variants @? '$[*].label ? (@ like_regex "[\\r\\n\\t]")')
    and not (variants @? '$[*].value ? (@ like_regex "[\\r\\n\\t]")')
  );

comment on column public.items.variants is
  'Ознаки товару: масив {label, value}, до 5 пар. Показуються гостю на картці.';

-- ─────────────────────────────────────────────
-- get_shared_list — варіанти йдуть гостю
-- ─────────────────────────────────────────────
--
-- Заради них усе й робиться: гість має бачити «Розмір: M», інакше подарунок
-- вгадують. Від `hide_prices` не залежать — це не ціна.
--
-- Решта тіла не змінилася відносно 20260910120200_rpc.sql.

create or replace function public.get_shared_list(p_token text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share  public.shares;
  v_is_owner boolean;
  v_items  jsonb;
begin
  select * into v_share from public.shares where token = p_token;

  if v_share.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_share.revoked_at is not null then
    raise exception 'revoked' using errcode = 'P0002';
  end if;
  if v_share.expires_at is not null and v_share.expires_at < now() then
    raise exception 'expired' using errcode = 'P0002';
  end if;

  v_is_owner := (auth.uid() is not null and auth.uid() = v_share.owner_id);
  -- Власнику броні не показуємо навіть у власному посиланні (ADR-009).

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
      'reserved_qty', case
        when v_is_owner then null
        else coalesce((select sum(r.quantity)::int from public.reservations r
                       where r.share_id = v_share.id and r.item_id = i.id), 0)
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
    'currency',           (select l.currency from public.lists l where l.id = v_share.source_list_id),
    'hide_prices',        v_share.hide_prices,
    'allow_reservations', v_share.allow_reservations and not v_is_owner,
    'viewer_is_owner',    v_is_owner,
    'items',              v_items
  );
end;
$$;

-- `create or replace` зберігає наявні права, але §3.4 вимагає, щоб гранти на
-- кожну функцію в `public` стояли в міграції явно.
revoke all on function public.get_shared_list(text) from public;
grant execute on function public.get_shared_list(text) to anon, authenticated;
