-- 20260929090000_link_checks.sql
-- Щоденна перевірка посилань на товар (дизайн v2, крок 4г-1; потік R; ADR-048).
--
-- Раз на добу закритий сервіс wishlist-jobs відкриває сторінки товарів тим
-- самим безпечним завантажувачем, що й парсер (SSRF-захист, ADR-012), і
-- записує, що побачив: сторінка є, товару немає в наявності, сторінки немає.
-- Ціну з магазину він лише запам'ятовує — міняє її в списку власник сам.
--
-- Розширюємо, а не міняємо (ADR-039): усталене 'unknown' — поведінка v1,
-- яка про перевірку не знає. Нових функцій для клієнта немає: сервіс пише
-- secret-ключем (роль service_role), власник читає поля разом із позицією
-- під тим самим RLS.
--
-- Позначок гостей перевірка не читає й не пише; гостьові RPC цих полів не
-- віддають (CLAUDE.md §3.2, §3.3). Що з цього покаже гостьова v2 — вирішиться
-- на кроці 5.

alter table public.items
  add column link_status text not null default 'unknown'
    check (link_status in ('unknown', 'ok', 'out', 'gone')),
  add column link_checked_at timestamptz,
  add column link_price numeric(12,2) check (link_price is null or link_price >= 0),
  add column link_currency text check (link_currency is null or link_currency ~ '^[A-Z]{3}$');

comment on column public.items.link_status is
  'Остання перевірка сторінки товару (ADR-048): unknown — ще не перевіряли чи не вдалося, ok — є, out — немає в наявності, gone — сторінки немає.';
comment on column public.items.link_price is
  'Ціна, яку побачила перевірка на сторінці магазину. У списку ціну не міняє — лише підказує власнику.';

-- Черга перевірки: найдавніше перевірене — першим. Лише позиції з посиланням.
create index items_link_check_idx on public.items (link_checked_at nulls first)
  where url is not null;

-- ─────────────────────────────────────────────
-- Нове посилання — нова перевірка
-- ─────────────────────────────────────────────
--
-- Стан належить адресі, а не позиції: замінили посилання (у v2 чи у v1, яка
-- про перевірку не знає) — старий висновок уже нічого не каже.

create or replace function public.item_link_reset()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.url is distinct from old.url then
    new.link_status := 'unknown';
    new.link_checked_at := null;
    new.link_price := null;
    new.link_currency := null;
  end if;
  return new;
end;
$$;

create trigger items_link_reset
  before update of url on public.items
  for each row execute function public.item_link_reset();

revoke execute on function public.item_link_reset() from public, anon, authenticated;
