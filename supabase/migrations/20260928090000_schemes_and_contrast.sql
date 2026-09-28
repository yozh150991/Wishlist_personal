-- 20260928090000_schemes_and_contrast.sql
-- П'ять схем смаку й висока контрастність як окремий вхід у Вугіль (ADR-033).
--
-- Було: три схеми в одному переліку — Шавлія, Слива, Вугіль. Людина могла
-- обрати Вугіль «щоб було видно», не вмикаючи нічого, і тоді оформлення списку
-- спокійно б її перефарбувало. Стало: п'ять схем смаку (Шавлія, Слива,
-- Полотно, Цитрус, Ніч) і прапорець «Висока контрастність» над ними — єдиний
-- вхід у Вугіль. Прапорець не перезаписує схему: вимкнув — повернувся до
-- свого смаку, а не до усталеного.
--
-- Гостьова сторінка тепер у схемі власника (гість схеми не обирає), тож
-- get_shared_list віддає її разом зі списком.

-- ─────────────────────────────────────────────
-- Схеми смаку
-- ─────────────────────────────────────────────
-- Нові значення в enum не можна вжити в тій самій транзакції, де їх додано,
-- тож тут вони лише оголошуються; нижче використано тільки старі.

alter type public.app_scheme add value if not exists 'polotno';
alter type public.app_scheme add value if not exists 'cytrus';
alter type public.app_scheme add value if not exists 'nich';

comment on type public.app_scheme is
  'Схема смаку інтерфейсу. vuhil лишився в типі історично й заборонений у profiles.scheme перевіркою: у Вугіль веде лише profiles.high_contrast (ADR-033).';

-- ─────────────────────────────────────────────
-- Висока контрастність
-- ─────────────────────────────────────────────

alter table public.profiles
  add column high_contrast boolean not null default false;

comment on column public.profiles.high_contrast is
  'Тумблер доступності, єдиний вхід у схему Вугіль. Не перезаписує scheme. Читає й пише лише власник через наявні політики profiles_*_own.';

-- Хто вже обрав Вугіль, обирав контраст — переносимо як увімкнений тумблер,
-- а смак повертаємо до усталеного.
update public.profiles
   set high_contrast = true,
       scheme = 'sage'
 where scheme = 'vuhil';

alter table public.profiles
  add constraint profiles_scheme_is_taste check (scheme <> 'vuhil');

-- ─────────────────────────────────────────────
-- get_shared_list — віддає схему власника
-- ─────────────────────────────────────────────
--
-- Гість бачить список у схемі власника (resolveAppearance, правило 3). Схема
-- не кешується в токені й не запікається в посилання: власник змінить її — і
-- наступне відкриття посилання покаже нову.
--
-- Решта тіла не змінилася відносно 20260921100000_item_variants.sql.

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
    'owner_scheme',       (select p.scheme from public.profiles p where p.id = v_share.owner_id),
    'hide_prices',        v_share.hide_prices,
    'allow_reservations', v_share.allow_reservations and not v_is_owner,
    'viewer_is_owner',    v_is_owner,
    'items',              v_items
  );
end;
$$;

revoke all on function public.get_shared_list(text) from public;
grant execute on function public.get_shared_list(text) to anon, authenticated;
