-- 20261007090000_guest_contact.sql
-- Гостьова v2, крок 5а: необовʼязкові підпис і пошта гостя (ADR-041, п. 2;
-- ADR-053).
--
-- Підпис і пошта належать ідентичності гостя в одному списку, а не окремій
-- позначці: наступна бронь підставляє їх у форму. Обидві колонки nullable —
-- гостьова v1 їх не питає й не показує, і для неї нічого не змінюється.
--
-- ІНВАРІАНТ (CLAUDE.md §3.2): ні власник, ні інші гості не бачать ні підпису,
-- ні пошти. guest_identities, як і раніше, без жодної RLS-політики й без
-- грантів anon/authenticated — читають і пишуть лише гостьові RPC нижче, і
-- лише для ідентичності, чий ключ пред'явлено.
--
-- RPC v1 заморожені (ADR-039, п. 10), тож у v2 — власні функції з іншими
-- іменами. Логіку позначок вони не копіюють: get_guest_list і claim_item_v2
-- викликають get_shared_list і claim_item і лише додають підпис і пошту.
-- Коли v1 піде (крок 9), тіла переїдуть сюди, а v1-імена зникнуть.
--
-- Листів ще немає — вони прийдуть у кроці 5б через чергу (ADR-041, п. 8).
-- До того пошту застосунок не питає; колонка готова заздалегідь, щоб 5б не
-- міняв гостьову ідентичність удруге.

-- ─────────────────────────────────────────────
-- Колонки
-- ─────────────────────────────────────────────

alter table public.guest_identities
  add column name  text check (
    name is null or (char_length(name) between 1 and 60 and name !~ '[[:cntrl:]]')
  ),
  add column email text check (
    email is null or (
      char_length(email) <= 254
      and email = lower(email)
      and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
    )
  );

comment on table public.guest_identities is
  'Гість одного списку. Код для переносу на інший пристрій і, якщо гість сам вписав, підпис і пошта (ADR-041). Ні IP, ні часу позначок. ІНВАРІАНТ: власник і інші гості не мають доступу (CLAUDE.md §3.2).';
comment on column public.guest_identities.name is
  'Як гість сам себе підписав — щоб упізнати свої броні. Нікому, крім нього, не показується.';
comment on column public.guest_identities.email is
  'Пошта гостя для листів про його броні (крок 5б). Нижній регістр. Видаляється разом з ідентичністю, тобто щонайпізніше зі списком.';

-- ─────────────────────────────────────────────
-- get_guest_list — гостьовий перегляд v2
-- ─────────────────────────────────────────────
--
-- Те саме, що get_shared_list, плюс підпис і пошта в полі guest — лише
-- гостю з ключем цієї ідентичності. Власнику на власному посиланні guest
-- приходить null, як і в v1, тож нічого гостьового він не отримує.

create or replace function public.get_guest_list(p_token text, p_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_body     jsonb;
  v_share    public.shares;
  v_identity uuid;
  v_contact  jsonb;
begin
  -- Мертве посилання, власник, порядок і поля — рівно як у v1.
  v_body := public.get_shared_list(p_token, p_key);
  if jsonb_typeof(v_body->'guest') is distinct from 'object' then
    return v_body;
  end if;

  v_share := public.live_share(p_token);
  v_identity := public.guest_identity_of(v_share.source_list_id, p_key);

  select jsonb_build_object('name', g.name, 'email', g.email)
    into v_contact
    from public.guest_identities g
   where g.id = v_identity;

  return jsonb_set(v_body, '{guest}', (v_body->'guest') || coalesce(v_contact, '{}'::jsonb));
end;
$$;

-- ─────────────────────────────────────────────
-- claim_item_v2 — «Беру» з підписом і поштою
-- ─────────────────────────────────────────────
--
-- p_name, p_email: null — лишити як є; порожній рядок — прибрати; інше —
-- записати. Перевірка — до позначки: хибна пошта не лишає позначку без
-- того, що гість хотів вписати. Помилки: bad_name, bad_email, решта — як
-- у claim_item (not_found, owner_cannot_reserve, not_enough_left…).

create or replace function public.claim_item_v2(
  p_token    text,
  p_item_id  uuid,
  p_key      text,
  p_quantity integer default 1,
  p_name     text default null,
  p_email    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name     text;
  v_email    text;
  v_result   jsonb;
  v_share    public.shares;
  v_identity uuid;
begin
  if p_name is not null then
    v_name := nullif(btrim(p_name), '');
    if v_name is not null and (char_length(v_name) > 60 or v_name ~ '[[:cntrl:]]') then
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
     set name  = case when p_name  is null then name  else v_name  end,
         email = case when p_email is null then email else v_email end
   where id = v_identity
  returning name, email into v_name, v_email;

  return v_result || jsonb_build_object('name', v_name, 'email', v_email);
end;
$$;

-- ─────────────────────────────────────────────
-- Права (CLAUDE.md §3.4)
-- ─────────────────────────────────────────────

revoke all on function public.get_guest_list(text, text)                              from public;
revoke all on function public.claim_item_v2(text, uuid, text, integer, text, text)    from public;
grant execute on function public.get_guest_list(text, text)                           to anon, authenticated;
grant execute on function public.claim_item_v2(text, uuid, text, integer, text, text) to anon, authenticated;
