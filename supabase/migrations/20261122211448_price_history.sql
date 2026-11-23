-- 20261122211448_price_history.sql
-- Історія ціни й своя ціль (ROADMAP 8.16; ADR «Історія ціни — точка на день,
-- ціль на позиції, сповіщення раз на падіння»).
--
-- Що тут:
--   item_prices                  — що щоденна перевірка (ADR-048) бачила в
--                                  магазині: одна точка на позицію на день;
--   items.price_target           — «Повідомити, коли ціна ≤ X», у валюті позиції;
--   items.price_target_set_at    — коли ціль задано востаннє;
--   items.price_target_hit_at    — з якого моменту ціна в магазині не вища за
--                                  ціль (поточне «падіння»); NULL — вище або
--                                  невідомо. Обидва стани веде лише тригер;
--   notification_settings.target_* і подія `target` у notification_log —
--                                  сповіщення наявними каналами (ADR-049).
--
-- Розширюємо, а не міняємо (CLAUDE.md §7): ціль усталено NULL — поведінка,
-- як досі; без цілі тригер нічого не рахує, і жодна подія не виникає.
--
-- Інваріант 1: історію ціни читає лише власник позиції — політикою через
-- `items.owner_id`. Інваріант 2: нічого тут не стосується позначок гостей;
-- сповіщення лише про ціну. Гостьові RPC збирають позицію з явних полів
-- (`jsonb_build_object`), тож нові колонки гостям не потрапляють, а нових
-- функцій для клієнтів немає: власник читає таблицю під RLS, сервіс пише
-- secret-ключем (service_role).

-- ─────────────────────────────────────────────
-- Ціль на позиції
-- ─────────────────────────────────────────────

alter table public.items
  add column price_target numeric(12,2)
    constraint items_price_target_check check (price_target is null or price_target > 0),
  add column price_target_set_at timestamptz,
  add column price_target_hit_at timestamptz;

comment on column public.items.price_target is
  '«Повідомити, коли ціна ≤ X» (8.16): у валюті позиції, без конвертації (ADR-051). NULL — без цілі, як досі.';
comment on column public.items.price_target_set_at is
  'Коли ціль задано чи змінено. Пише лише тригер items_price_target_state.';
comment on column public.items.price_target_hit_at is
  'Від якого моменту ціна в магазині не вища за ціль; NULL — вища або невідомо. Пише лише тригер. Одне падіння — одне сповіщення.';

-- ─────────────────────────────────────────────
-- Стан цілі — тригером, для будь-якого автора зміни
-- ─────────────────────────────────────────────
--
-- Пишуть позицію троє: власник (ціль, валюта, посилання), сервіс перевірки
-- (`link_*`) і старі клієнти, які про ціль не знають. Стан рахується тут,
-- щоб він був однаковий для всіх і щоб його не можна було підробити з
-- клієнта: власні значення `price_target_set_at` / `price_target_hit_at` у
-- запиті тригер завжди перетирає.
--
-- Правило:
--   - ціль зникла — стану немає;
--   - ціль, валюта чи посилання змінились — стан наново, `set_at = now()`;
--   - сторінка є (`ok`), ціна в магазині відома й у валюті позиції:
--       ≤ цілі — `hit_at` ставиться, якщо ще не стоїть (початок падіння);
--       > цілі — `hit_at` знімається (наступне падіння — нове сповіщення);
--   - інакше (немає в наявності, сторінки немає, нічого певного, інша
--     валюта) — стан не міняється: про ціну це нічого не каже.
--
-- Ціль, яку вже досягнуто в момент, коли її задали, дає `hit_at = set_at`:
-- людина бачить ціну у формі, тож сервіс сповіщень такого не шле — лише
-- падіння після цього (`hit_at > set_at`).

create or replace function public.item_price_target_state()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_currency text;
begin
  if tg_op = 'UPDATE' then
    new.price_target_set_at := old.price_target_set_at;
    new.price_target_hit_at := old.price_target_hit_at;
  else
    new.price_target_set_at := null;
    new.price_target_hit_at := null;
  end if;

  if new.price_target is null then
    new.price_target_set_at := null;
    new.price_target_hit_at := null;
    return new;
  end if;

  -- Окремими гілками: на INSERT старого рядка немає.
  if tg_op = 'INSERT' then
    new.price_target_set_at := now();
  elsif new.price_target is distinct from old.price_target
        or new.currency is distinct from old.currency
        or new.url is distinct from old.url
        or old.price_target_set_at is null then
    new.price_target_set_at := now();
    new.price_target_hit_at := null;
  end if;

  if new.link_status = 'ok' and new.link_price is not null and new.link_price > 0 then
    v_currency := coalesce(new.currency::text, (select l.currency::text from public.lists l where l.id = new.list_id));
    if new.link_currency is null or new.link_currency = v_currency then
      if new.link_price <= new.price_target then
        new.price_target_hit_at := coalesce(new.price_target_hit_at, now());
      else
        new.price_target_hit_at := null;
      end if;
    end if;
  end if;

  return new;
end;
$$;

-- Ім'я після items_link_reset: BEFORE-тригери йдуть за абеткою, тож нове
-- посилання спершу скидає висновок перевірки, а тоді рахується ціль.
create trigger items_price_target_state
  before insert or update on public.items
  for each row execute function public.item_price_target_state();

revoke execute on function public.item_price_target_state() from public, anon, authenticated;

-- ─────────────────────────────────────────────
-- item_prices
-- ─────────────────────────────────────────────
--
-- Одна точка на позицію на день: перевірка й так ходить раз на добу, а
-- повтор у той самий день (ручний запуск, позиція, що не встигла вчора)
-- замінює точку, а не додає другу. Зберігаємо 180 днів — прибирає сервіс
-- тим самим щоденним викликом. На екрані — 30 днів; пів року — запас, щоб
-- побачити, чи нинішня «знижка» не була звичайною ціною два місяці тому.
-- Межа росту: ≤ 180 рядків на позицію.
--
-- `currency` — як сказав магазин; NULL — не сказав, тоді це валюта позиції
-- (так само читає `linkPriceChange`). Валюти не конвертуються (ADR-051).
-- `source` — звідки ціна. Поки лише `check` — щоденна перевірка; ціни з
-- «Заповнити з посилання» й кнопки «У вішліст» сюди не пишуться.

create table public.item_prices (
  item_id    uuid not null references public.items(id) on delete cascade,
  day        date not null,
  price      numeric(12,2) not null check (price > 0),
  currency   text check (currency is null or currency ~ '^[A-Z]{3}$'),
  source     text not null default 'check' check (source in ('check')),
  checked_at timestamptz not null default now(),
  primary key (item_id, day)
);

comment on table public.item_prices is
  'Історія ціни в магазині (8.16): точка на позицію на день, 180 днів. Пише wishlist-jobs, читає лише власник позиції.';

-- Прибирання старих точок — за днем.
create index item_prices_day_idx on public.item_prices (day);

alter table public.item_prices enable row level security;
revoke all on public.item_prices from anon;
-- Пише лише сервіс (service_role обходить RLS і має свої гранти).
revoke insert, update, delete, truncate, references, trigger on public.item_prices from authenticated;

create policy item_prices_select_own on public.item_prices
  for select to authenticated
  using (exists (select 1 from public.items i where i.id = item_prices.item_id and i.owner_id = auth.uid()));

-- ─────────────────────────────────────────────
-- Нове посилання — нова історія
-- ─────────────────────────────────────────────
--
-- Як і висновок перевірки (item_link_reset), історія належить адресі: замінили
-- посилання — точки старого товару вже не про цю позицію. SECURITY DEFINER:
-- власник сам видаляти точки не може (прав на запис у нього немає).

create or replace function public.item_prices_reset()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from public.item_prices where item_id = new.id;
  return null;
end;
$$;

create trigger items_prices_reset
  after update of url on public.items
  for each row
  when (old.url is distinct from new.url)
  execute function public.item_prices_reset();

revoke execute on function public.item_prices_reset() from public, anon, authenticated;

-- ─────────────────────────────────────────────
-- Сповіщення: подія `target` (ADR-049)
-- ─────────────────────────────────────────────
--
-- Окрема подія, а не `price`: «ціна змінилась на 15 %» усталено вимкнена як
-- шум, а ціль людина ставить сама — це важливе. Тому `target` — серед
-- важливих: «Увімкнути сповіщення» вмикає її разом із посиланням і святом.
-- Наявним рядкам канали копіюються з `link_*` (та сама група важливого): ціль
-- ще не задано ніде, тож поведінка до першої цілі не змінюється; без рядка
-- налаштувань сповіщень, як і раніше, немає.

alter table public.notification_settings
  add column target_push  boolean not null default false,
  add column target_email boolean not null default false;

update public.notification_settings set target_push = link_push, target_email = link_email;

alter table public.notification_log drop constraint notification_log_kind_check;
alter table public.notification_log add constraint notification_log_kind_check
  check (kind in ('after_event', 'yearly', 'link', 'price', 'share', 'target'));
