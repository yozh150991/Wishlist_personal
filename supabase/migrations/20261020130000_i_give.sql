-- 20261020130000_i_give.sql
-- Дизайн v2, крок 6 (ADR-062): «Я дарую» для гостей з акаунтом (ADR-041, п. 5).
--
-- Що змінюється:
--   * guest_identities.user_id — ідентичність гостя прив'язана до акаунта.
--     Двома шляхами: (1) гість бронює, уже увійшовши, — тригер на позначках
--     прив'язує одразу; (2) пошта, яку гість лишив у броні, збігається з
--     ПІДТВЕРДЖЕНОЮ поштою акаунта — прив'язка під час відкриття «Я дарую»;
--   * get_my_gifts — вкладка «Я дарую»: що користувач бере в чужих списках;
--   * attach_guest_key — новий пристрій: користувач, що увійшов, отримує
--     доступ до своїх броней на гостьовій без коду (ключ цього браузера
--     додається до його ідентичності), як redeem_guest_code, але за акаунтом.
--
-- Інваріант (ADR-040, п. 3; CLAUDE.md §3.2): ідентичності на списках, власником
-- яких є сам користувач, не прив'язуються ніколи й у «Я дарую» не потрапляють.
-- Власник списку колонки user_id не бачить — таблиця, як і раніше, без політик.

alter table public.guest_identities
  add column user_id uuid references auth.users(id) on delete set null;

comment on column public.guest_identities.user_id is
  'Акаунт гостя (ADR-062): бронював, увійшовши, або його підтверджена пошта збігається з поштою броні. Ніколи — власник списку.';

create index guest_identities_user_idx on public.guest_identities (user_id) where user_id is not null;

-- ─────────────────────────────────────────────
-- Прив'язка за поштою
-- ─────────────────────────────────────────────
--
-- Лише підтверджена пошта акаунта: інакше будь-хто зареєструвався б із чужою
-- адресою й побачив чужі броні. Хто має доступ до скриньки, і так отримує код
-- (ADR-041, п. 5). Уже прив'язане до іншого акаунта не перехоплюється.

create or replace function public.link_guest_identities(p_user uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text;
  v_count integer;
begin
  select lower(u.email) into v_email
    from auth.users u
   where u.id = p_user and u.email_confirmed_at is not null;
  if v_email is null then
    return 0;
  end if;
  update public.guest_identities g
     set user_id = p_user
   where g.user_id is null
     and g.email is not null
     and lower(g.email) = v_email
     and exists (select 1 from public.lists l where l.id = g.list_id and l.owner_id <> p_user);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.link_guest_identities(uuid) from public, anon, authenticated;

-- ─────────────────────────────────────────────
-- Прив'язка під час броні, коли гість увійшов
-- ─────────────────────────────────────────────
--
-- Тригер на позначках: так прив'язуються броні з будь-якої гостьової RPC
-- (v1 і v2), а заморожені тіла не змінюються. Нічого не повертає й ніколи не
-- падає: бронь важливіша за прив'язку.

create or replace function public.guest_identity_link_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    return null;
  end if;
  begin
    update public.guest_identities g
       set user_id = v_user
     where g.id = new.identity_id
       and g.user_id is null
       and exists (select 1 from public.lists l where l.id = g.list_id and l.owner_id <> v_user);
  exception when others then
    null;
  end;
  return null;
end;
$$;

revoke all on function public.guest_identity_link_trg() from public, anon, authenticated;

create trigger guest_identity_link
  after insert on public.claims
  for each row execute function public.guest_identity_link_trg();

-- ─────────────────────────────────────────────
-- «Я дарую»
-- ─────────────────────────────────────────────
--
-- Список за списком: назва посилання (не внутрішня назва списку власника),
-- дата, архів, подяка, код гостя, адреса найсвіжішого живого посилання з його
-- позиціями — і самі позиції, як їх бачить гість цього посилання (ціна — лише
-- якщо посилання її показує). Кілька ідентичностей одного акаунта в одному
-- списку (бронював і без входу з поштою, і увійшовши) — одна картка, позиції
-- разом. Списки без живого посилання не показуються: відкрити їх нема куди.

create or replace function public.get_my_gifts()
returns jsonb
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  perform public.link_guest_identities(v_user);

  return coalesce((
    select jsonb_agg(x.card order by x.past, x.event_date nulls last, x.title)
      from (
        select s.title,
               l.event_date,
               (l.event_date is not null and l.event_date < current_date) as past,
               jsonb_build_object(
                 'token',      s.token,
                 'title',      s.title,
                 'event_date', l.event_date,
                 'archived',   l.is_archived,
                 'thanks',     l.thanks_message,
                 'code',       (select g.short_code from public.guest_identities g
                                 where g.list_id = l.id and g.user_id = v_user
                                 order by g.last_seen desc limit 1),
                 'items', (
                   select coalesce(jsonb_agg(jsonb_build_object(
                            'id',        t.id,
                            'title',     t.title,
                            'url',       t.url,
                            'price',     case when s.hide_prices then null else t.price end,
                            'currency',  coalesce(t.currency, l.currency),
                            'mine_qty',  t.mine_qty,
                            'quantity',  t.quantity,
                            'bought',    t.bought,
                            'changed',   t.changed
                          ) order by t.position nulls first, t.created_at), '[]'::jsonb)
                     from (
                       select i.id, i.title, i.url, i.price, i.currency, i.quantity, i.position, i.created_at,
                              sum(c.quantity)::int              as mine_qty,
                              bool_or(c.purchased_at is not null) as bought,
                              bool_or(c.changed_at is not null)   as changed
                         from public.guest_identities g
                         join public.claims c on c.identity_id = g.id
                         join public.items i on i.id = c.item_id and i.status = 'active'
                         join public.share_items si on si.item_id = i.id and si.share_id = s.id
                        where g.list_id = l.id and g.user_id = v_user
                        group by i.id
                     ) t
                 )
               ) as card
          from public.lists l
          cross join lateral (
            select sh.*
              from public.shares sh
             where sh.source_list_id = l.id
               and sh.revoked_at is null
               and (sh.expires_at is null or sh.expires_at > now())
               and exists (select 1
                             from public.guest_identities g2
                             join public.claims c2 on c2.identity_id = g2.id
                             join public.share_items si2 on si2.item_id = c2.item_id and si2.share_id = sh.id
                             join public.items i2 on i2.id = c2.item_id and i2.status = 'active'
                            where g2.list_id = l.id and g2.user_id = v_user)
             order by sh.created_at desc
             limit 1
          ) s
         where l.owner_id <> v_user
           and exists (select 1 from public.guest_identities g3 where g3.list_id = l.id and g3.user_id = v_user)
      ) x
  ), '[]'::jsonb);
end;
$$;

-- Явно й від anon: Supabase видає EXECUTE ролям окремими грантами (див.
-- 20260916220000_revoke_default_function_grants).
revoke all on function public.get_my_gifts() from public, anon;
grant execute on function public.get_my_gifts() to authenticated;

-- ─────────────────────────────────────────────
-- Ключ цього браузера — до своєї ідентичності
-- ─────────────────────────────────────────────
--
-- true — тепер гостьова з цим ключем показує броні користувача; false —
-- на цьому списку броней цього акаунта немає (або дивиться власник). Ліміту
-- спроб, як у коду, не треба: перебирати тут нічого — права дає сесія.

create or replace function public.attach_guest_key(p_token text, p_key text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user     uuid := auth.uid();
  v_share    public.shares;
  v_identity uuid;
begin
  if v_user is null then
    raise exception 'not_authenticated' using errcode = '28000';
  end if;
  v_share := public.live_share(p_token);
  if v_share.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_share.owner_id = v_user then
    return false;
  end if;
  if p_key is null or p_key !~ '^[A-Za-z0-9_-]{22,64}$' then
    raise exception 'bad_key' using errcode = '22023';
  end if;

  if public.guest_identity_of(v_share.source_list_id, p_key) is not null then
    -- Ключ уже чийсь: свій — нічого робити; чужий — не перехоплюємо.
    return exists (select 1 from public.guest_identities g
                    where g.id = public.guest_identity_of(v_share.source_list_id, p_key)
                      and g.user_id = v_user);
  end if;

  perform public.link_guest_identities(v_user);
  select g.id into v_identity
    from public.guest_identities g
   where g.list_id = v_share.source_list_id and g.user_id = v_user
   order by g.last_seen desc
   limit 1;
  if v_identity is null then
    return false;
  end if;

  insert into public.guest_keys (key_hash, identity_id)
  values (public.guest_key_hash(v_share.source_list_id, p_key), v_identity)
  on conflict (key_hash) do nothing;
  update public.guest_identities set last_seen = now() where id = v_identity;
  return true;
end;
$$;

-- Явно й від anon: Supabase видає EXECUTE ролям окремими грантами (див.
-- 20260916220000_revoke_default_function_grants).
revoke all on function public.attach_guest_key(text, text) from public, anon;
grant execute on function public.attach_guest_key(text, text) to authenticated;
