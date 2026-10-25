-- Своє фото позиції файлом (ADR-073).
--
-- Фото лежить у публічному бакеті `item-photos` під випадковим ім'ям із
-- 32 шістнадцяткових символів (128 біт від gen_random_uuid): адресу не
-- вгадати, як і токен посилання, а переліку файлів бакет не віддає нікому.
-- Адреса фото йде в той самий `items.image_url`, що й фото з магазину, тож
-- гостьова, офлайн-копія, експорт і листи працюють без змін.
--
-- Завантажити можна лише в адресу, яку щойно видала `reserve_item_photo`
-- саме цьому власникові: політика на `storage.objects` перевіряє рядок
-- `item_photos`. Так ліміти (скільки фото на акаунт і скільки за годину)
-- рахує база, а не браузер, і в чужу адресу файл не покласти.
--
-- Прибирає файли сервіс wishlist-jobs раз на добу: фото, на яке не
-- посилається жодна позиція (видалили позицію, прибрали чи замінили фото,
-- видалили список чи акаунт), стирається зі сховища, а потім і його рядок.

-- ─────────────────────────────────────────────
-- Бакет
-- ─────────────────────────────────────────────

-- 2 МБ — з запасом над тим, що віддає стиснення в браузері (lib/photos.ts,
-- PHOTO_OUTPUT_MAX). Типи — лише те, у що браузер перекодовує.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('item-photos', 'item-photos', true, 2097152, array['image/webp', 'image/jpeg'])
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ─────────────────────────────────────────────
-- Видані адреси
-- ─────────────────────────────────────────────

create table public.item_photos (
  path       text primary key check (path ~ '^[0-9a-f]{32}\.(webp|jpg)$'),
  -- Без каскаду: рядок має пережити акаунт, інакше файл лишився б у
  -- сховищі без жодного запису про себе й ніколи б не прибрався.
  owner_id   uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

comment on table public.item_photos is
  'Адреси для своїх фото позицій, видані reserve_item_photo (ADR-073). Ліміти на власника й прибирання файлів без посилань (wishlist-jobs).';

create index item_photos_owner_idx on public.item_photos (owner_id, created_at);

alter table public.item_photos enable row level security;
revoke all on public.item_photos from public, anon, authenticated;
-- Власник бачить свої рядки: саме так їх перевіряє політика сховища нижче,
-- яка працює з правами того, хто завантажує.
grant select on public.item_photos to authenticated;
create policy item_photos_select_own on public.item_photos
  for select to authenticated
  using (owner_id = auth.uid());

-- ─────────────────────────────────────────────
-- Завантаження: лише у свою видану адресу
-- ─────────────────────────────────────────────

-- Читати файли публічного бакета можна за адресою й без політик, а
-- переліку не дає ніхто. Оновлювати й видаляти клієнтам нічого: заміна
-- фото — нова адреса, видалення — справа wishlist-jobs.
create policy item_photos_upload_reserved on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'item-photos'
    and exists (
      select 1 from public.item_photos p
       where p.path = objects.name
         and p.owner_id = auth.uid()
    )
  );

-- ─────────────────────────────────────────────
-- reserve_item_photo
-- ─────────────────────────────────────────────

create or replace function public.reserve_item_photo(p_ext text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_path text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_ext is null or p_ext not in ('webp', 'jpg') then
    raise exception 'bad_request' using errcode = '22023';
  end if;

  -- Запас на роки особистих списків; більше — це вже не вішліст.
  if (select count(*) from public.item_photos where owner_id = v_uid) >= 1000 then
    raise exception 'photo_quota' using errcode = 'P0001';
  end if;
  -- Шістдесят за годину — більше, ніж людина встигне вибрати й обрізати.
  if (select count(*) from public.item_photos
       where owner_id = v_uid and created_at > now() - interval '1 hour') >= 60 then
    raise exception 'photo_rate' using errcode = 'P0001';
  end if;

  v_path := replace(gen_random_uuid()::text, '-', '') || '.' || p_ext;
  insert into public.item_photos (path, owner_id) values (v_path, v_uid);
  return v_path;
end;
$$;

comment on function public.reserve_item_photo(text) is
  'Видає випадкову адресу для свого фото позиції (ADR-073). Ліміти: 1000 фото на власника, 60 на годину — photo_quota / photo_rate.';

revoke execute on function public.reserve_item_photo(text) from public, anon;
grant execute on function public.reserve_item_photo(text) to authenticated;

-- ─────────────────────────────────────────────
-- Прибирання (лише wishlist-jobs, service_role)
-- ─────────────────────────────────────────────

-- Фото, на які не посилається жодна позиція — будь-кого: файл із «Моїх
-- даних», імпортований в інший акаунт, теж тримає фото живим. Добу після
-- видачі адреси фото не чіпаємо: форма позиції може довго стояти відкритою,
-- а зміна — чекати мережі в черзі офлайн-змін.
create or replace function public.item_photo_orphans(p_limit integer default 200)
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select p.path
    from public.item_photos p
   where p.created_at < now() - interval '1 day'
     and not exists (
       select 1 from public.items i
        where i.image_url like '%/item-photos/' || p.path
     )
   order by p.created_at
   limit greatest(1, least(coalesce(p_limit, 200), 1000));
$$;

create or replace function public.forget_item_photos(p_paths text[])
returns void
language sql
security definer
set search_path = public
as $$
  delete from public.item_photos where path = any(p_paths);
$$;

comment on function public.item_photo_orphans(integer) is
  'Фото без жодної позиції, що на них посилається, старші за добу (ADR-073). Лише для wishlist-jobs.';
comment on function public.forget_item_photos(text[]) is
  'Забуває адреси фото, файли яких wishlist-jobs уже видалив зі сховища (ADR-073).';

revoke execute on function public.item_photo_orphans(integer) from public, anon, authenticated;
revoke execute on function public.forget_item_photos(text[])  from public, anon, authenticated;
grant execute on function public.item_photo_orphans(integer) to service_role;
grant execute on function public.forget_item_photos(text[])  to service_role;
