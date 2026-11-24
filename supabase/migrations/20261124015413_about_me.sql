-- 20261124015413_about_me.sql
-- ROADMAP 8.10: профіль «Про мене» — розміри, що люблю, «не дарувати».
--
-- Що змінюється:
--   * profiles.about_sizes, about_likes, about_avoid — короткий вільний текст
--     власника. Усталено null — «нічого не заповнено», як і досі. Читає й пише
--     лише власник через наявні profiles_select_own / profiles_update_own;
--   * shares.show_about — дозвіл показати «Про мене» гостям саме цього
--     посилання. Усталено false — як і досі, гість нічого з профілю не бачить.
--     Дозвіл на посиланні, а не на профілі: власник роздає різні посилання
--     різним людям (колегам — без розмірів, рідним — з ними);
--   * get_guest_list додає `about` лише тоді, коли дозвіл увімкнено на цьому
--     посиланні й у профілі щось заповнено. Інакше ключа `about` у відповіді
--     немає зовсім — не порожні рядки й не null. Мертве посилання — як і
--     раніше, not_found із get_shared_list ще до читання профілю (§3.3).
--     Власник на своєму посиланні бачить те саме, що гість.
--   * get_share_card (картка для ботів месенджерів, ADR-060) — без змін:
--     «Про мене» туди не потрапляє.
--
-- Нова гостьова поведінка — в обгортці (CLAUDE.md §7): нового прямого входу
-- немає. Помічник guest_about — внутрішній, клієнтам недоступний.

-- ─────────────────────────────────────────────
-- Поля профілю
-- ─────────────────────────────────────────────
--
-- Межі — на тексті без пробілів по краях; самі пробіли тригер робить null,
-- щоб поле можна було прибрати, просто стерши текст. Відповідники у формі —
-- ABOUT_LIMITS у app/src/lib/about.ts (CLAUDE.md §4).

alter table public.profiles
  add column about_sizes text
    constraint profiles_about_sizes_check
      check (about_sizes is null or char_length(btrim(about_sizes)) between 1 and 120),
  add column about_likes text
    constraint profiles_about_likes_check
      check (about_likes is null or char_length(btrim(about_likes)) between 1 and 500),
  add column about_avoid text
    constraint profiles_about_avoid_check
      check (about_avoid is null or char_length(btrim(about_avoid)) between 1 and 500);

comment on column public.profiles.about_sizes is
  '«Про мене» (ROADMAP 8.10): розміри одягу й взуття вільним текстом. Гість бачить лише на посиланні з shares.show_about.';
comment on column public.profiles.about_likes is
  '«Про мене»: що людина любить. Гість бачить лише на посиланні з shares.show_about.';
comment on column public.profiles.about_avoid is
  '«Про мене»: чого не дарувати. Гість бачить лише на посиланні з shares.show_about.';

create or replace function public.profiles_about_tidy()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.about_sizes := nullif(btrim(new.about_sizes), '');
  new.about_likes := nullif(btrim(new.about_likes), '');
  new.about_avoid := nullif(btrim(new.about_avoid), '');
  return new;
end;
$$;

revoke all on function public.profiles_about_tidy() from public, anon, authenticated;

create trigger profiles_about_tidy
  before insert or update of about_sizes, about_likes, about_avoid on public.profiles
  for each row execute function public.profiles_about_tidy();

-- ─────────────────────────────────────────────
-- Дозвіл — на посиланні
-- ─────────────────────────────────────────────

alter table public.shares
  add column show_about boolean not null default false;

comment on column public.shares.show_about is
  'Показати гостям цього посилання «Про мене» власника (ROADMAP 8.10). Усталено false. Пише власник через shares_update_own.';

-- ─────────────────────────────────────────────
-- Помічник: що з профілю бачить гість цього посилання
-- ─────────────────────────────────────────────
--
-- null — нічого: дозволу немає або профіль порожній. Інакше обʼєкт лише з
-- заповненими полями. Викликає тільки get_guest_list (SECURITY DEFINER від
-- postgres); прямого виклику в клієнтів немає (CLAUDE.md §3.4).

create or replace function public.guest_about(p_share public.shares)
returns jsonb
language sql
stable
set search_path = public
as $$
  select nullif(jsonb_strip_nulls(jsonb_build_object(
           'sizes', p.about_sizes,
           'likes', p.about_likes,
           'avoid', p.about_avoid)), '{}'::jsonb)
    from public.profiles p
   where p_share.id is not null
     and p_share.show_about
     and p_share.revoked_at is null
     and p.id = p_share.owner_id
$$;

revoke all on function public.guest_about(public.shares) from public, anon, authenticated, service_role;

comment on function public.guest_about(public.shares) is
  'Внутрішня (ROADMAP 8.10): «Про мене» для get_guest_list — лише з дозволу на посиланні. Прямого доступу в клієнтів немає.';

-- ─────────────────────────────────────────────
-- get_guest_list — ще й `about`, лише з дозволу
-- ─────────────────────────────────────────────
--
-- Решта — як у 20261020140000_gift_pools. `about` додається до розгалуження
-- на власника: власник бачить свою сторінку такою, як гість.

create or replace function public.get_guest_list(p_token text, p_key text default null)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_body     jsonb;
  v_share    public.shares;
  v_thanks   text;
  v_about    jsonb;
  v_identity uuid;
  v_contact  jsonb;
  v_items    jsonb;
begin
  -- Мертве посилання падає тут — not_found, до будь-якого читання профілю.
  v_body := public.get_shared_list(p_token, p_key);
  v_share := public.live_share(p_token);
  select l.thanks_message into v_thanks from public.lists l where l.id = v_share.source_list_id;
  v_body := v_body || jsonb_build_object('thanks', v_thanks);

  -- ROADMAP 8.10: без дозволу на цьому посиланні ключа `about` немає зовсім.
  v_about := public.guest_about(v_share);
  if v_about is not null then
    v_body := v_body || jsonb_build_object('about', v_about);
  end if;

  if (v_body->>'viewer_is_owner')::boolean then
    return v_body;
  end if;

  v_identity := public.guest_identity_of(v_share.source_list_id, p_key);

  select jsonb_build_object('name', g.name, 'email', g.email)
    into v_contact
    from public.guest_identities g
   where g.id = v_identity;

  select coalesce(jsonb_agg(
           t.e
             || case when c.changed_at   is not null then jsonb_build_object('changed', true) else '{}'::jsonb end
             || case when c.purchased_at is not null then jsonb_build_object('bought',  true) else '{}'::jsonb end
             || case when p.id is null then '{}'::jsonb else jsonb_build_object('pool', jsonb_build_object(
                  'id',           p.id,
                  'organizer',    p.organizer,
                  'instructions', p.instructions,
                  'goal',         p.goal,
                  'currency',     p.currency,
                  'closed',       p.closed_at is not null,
                  'raised',       coalesce((select sum(x.amount) from public.gift_pool_pledges x where x.pool_id = p.id), 0),
                  'count',        (select count(*) from public.gift_pool_pledges x where x.pool_id = p.id),
                  'mine',         (select x.amount from public.gift_pool_pledges x
                                    where x.pool_id = p.id and x.identity_id = v_identity),
                  'is_organizer', v_identity is not null and p.organizer_id = v_identity,
                  'pledges',      case when v_identity is not null and p.organizer_id = v_identity then
                                    (select coalesce(jsonb_agg(jsonb_build_object('name', x.name, 'amount', x.amount)
                                                               order by x.created_at), '[]'::jsonb)
                                       from public.gift_pool_pledges x where x.pool_id = p.id)
                                  end
                )) end
           order by t.ord), '[]'::jsonb)
    into v_items
    from jsonb_array_elements(v_body->'items') with ordinality as t(e, ord)
    left join public.claims c
      on c.identity_id = v_identity and c.item_id = (t.e->>'id')::uuid
    left join public.gift_pools p
      on p.item_id = (t.e->>'id')::uuid;

  v_body := jsonb_set(v_body, '{items}', v_items);
  if jsonb_typeof(v_body->'guest') = 'object' then
    v_body := jsonb_set(v_body, '{guest}', (v_body->'guest') || coalesce(v_contact, '{}'::jsonb));
  end if;
  return v_body;
end;
$$;

revoke all on function public.get_guest_list(text, text) from public;
grant execute on function public.get_guest_list(text, text) to anon, authenticated;
