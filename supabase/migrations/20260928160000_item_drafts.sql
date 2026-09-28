-- 20260928160000_item_drafts.sql
-- Чернетки позицій (дизайн v2, крок 4б; потік L; ADR-046).
--
-- Магазин не віддав опису, а людина не хоче зупинятися й вигадувати назву —
-- посилання зберігається чернеткою «Потрібна назва», а назва — пізніше.
-- Чернетка невидима гостям, доки її не назвуть.
--
-- Розширюємо, а не міняємо (ADR-039): `title` лишається обовʼязковим, у
-- чернетки там стоїть адреса без протоколу й міток («shop.ua/lampa»). v1 про
-- чернетки не знає й показує цю адресу як назву; перейменування у v1 знімає
-- позначку чернетки тригером нижче. Нова колонка має усталене `false` —
-- поведінку v1.
--
-- Гостям чернетка недоступна жодним шляхом: гість бачить лише позиції з
-- `share_items`, а туди чернетка не потрапляє — ні через `create_share`
-- (заморожена RPC v1, її тіло не змінюється), ні прямою вставкою. І назад
-- дороги немає: позиція, яка вже могла потрапити в посилання, чернеткою
-- стати не може.
--
-- Позначок гостей це не стосується ніяк: жодна перевірка тут не читає
-- `claims`, тож відповіді власнику від них не залежать (CLAUDE.md §3.2).

alter table public.items
  add column needs_title boolean not null default false;

comment on column public.items.needs_title is
  'Чернетка без назви (ADR-046): у title — адреса. Гостям невидима: у share_items не потрапляє. Стає false, щойно назву змінено.';

-- ─────────────────────────────────────────────
-- Позиція стає чернеткою лише при створенні; назва знімає позначку
-- ─────────────────────────────────────────────

create or replace function public.item_draft_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.needs_title and not old.needs_title then
    raise exception 'Позиція стає чернеткою лише при створенні' using errcode = '22023';
  end if;
  -- Перейменували — назва є. Так працює й перейменування у v1, яка про
  -- чернетки не знає.
  if old.needs_title and new.title is distinct from old.title then
    new.needs_title := false;
  end if;
  return new;
end;
$$;

create trigger items_draft_guard
  before update of needs_title, title on public.items
  for each row execute function public.item_draft_guard();

-- ─────────────────────────────────────────────
-- Чернетка не потрапляє в посилання
-- ─────────────────────────────────────────────
--
-- Мовчки пропускаємо, а не відмовляємо: `create_share` у v1 не знає про
-- чернетки, і власник, що вибрав її серед інших, отримав би незрозумілу
-- помилку замість посилання на решту. v2 чернеток до вибору не пропонує.

create or replace function public.share_items_skip_drafts()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if exists (select 1 from public.items i where i.id = new.item_id and i.needs_title) then
    return null;
  end if;
  return new;
end;
$$;

create trigger share_items_skip_drafts
  before insert on public.share_items
  for each row execute function public.share_items_skip_drafts();

-- Тригерні функції через PostgREST не викликаються, але гранти — явно (CLAUDE.md §3.4).
revoke execute on function public.item_draft_guard()        from public, anon, authenticated;
revoke execute on function public.share_items_skip_drafts() from public, anon, authenticated;
