-- 20261020100000_list_thanks.sql
-- Гостьова v2, крок 5д (ADR-059): «Подякувати гостям» (потік M).
--
-- Що змінюється:
--   * lists.thanks_message — подяка власника гостям, одна на список; гість
--     бачить її на сторінці за будь-яким живим посиланням списку
--     (get_guest_list віддає `thanks`);
--   * lists.thanks_sent_at — коли подяку вперше збережено. Ставить і тримає
--     лише тригер: власник не може скинути її й розіслати листи вдруге;
--   * за першим збереженням тригер ставить у чергу лист `thanks` кожному
--     гостю цього списку, який щось брав, лишив пошту й не відписався.
--     Хто ці гості й чи є вони взагалі, власник не дізнається: тригер нічого
--     не повертає й ніколи не падає (ADR-040, п. 4; CLAUDE.md §3.2), а
--     thanks_sent_at ставиться однаково, є кому писати чи ні.
--   * guest_mail.kind — ще й `thanks`; текст подяки — знімком у details.

-- ─────────────────────────────────────────────
-- Поля списку
-- ─────────────────────────────────────────────

alter table public.lists
  add column thanks_message text
    constraint lists_thanks_message_check
      check (thanks_message is null or char_length(btrim(thanks_message)) between 1 and 1000),
  add column thanks_sent_at timestamptz;

comment on column public.lists.thanks_message is
  'Подяка власника гостям (ADR-059): гість бачить на сторінці списку; за першим збереженням — лист тим, хто брав і лишив пошту.';
comment on column public.lists.thanks_sent_at is
  'Коли подяку вперше збережено (ADR-059). Ставить лише тригер lists_thanks_stamp; листи вдруге не йдуть.';

-- ─────────────────────────────────────────────
-- Черга листів — новий вид `thanks`
-- ─────────────────────────────────────────────

alter table public.guest_mail drop constraint guest_mail_kind_check;
alter table public.guest_mail
  add constraint guest_mail_kind_check
    check (kind in ('claim', 'code', 'changed', 'deleted', 'reminder', 'thanks'));

-- ─────────────────────────────────────────────
-- Позначка часу: лише тригер, лише раз
-- ─────────────────────────────────────────────
--
-- Порожній рядок і самі пробіли — «подяки немає»: так у формі простіше
-- прибрати подяку, а обмеження не падає на випадковому пробілі.

create or replace function public.lists_thanks_stamp()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.thanks_message is not null and btrim(new.thanks_message) = '' then
    new.thanks_message := null;
  end if;
  if tg_op = 'INSERT' then
    -- Новий список гостей не має: подяка в ньому листів не шле.
    new.thanks_sent_at := case when new.thanks_message is null then null else now() end;
  else
    new.thanks_sent_at := coalesce(old.thanks_sent_at,
                                   case when new.thanks_message is null then null else now() end);
  end if;
  return new;
end;
$$;

revoke all on function public.lists_thanks_stamp() from public, anon, authenticated;

create trigger lists_thanks_stamp
  before insert or update on public.lists
  for each row execute function public.lists_thanks_stamp();

-- ─────────────────────────────────────────────
-- Листи подяки — один раз, за першим збереженням
-- ─────────────────────────────────────────────

create or replace function public.lists_thanks_mail_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_share uuid;
  r       record;
begin
  begin
    for r in
      select g.id as identity_id, g.locale, array_agg(c.item_id) as item_ids
        from public.guest_identities g
        join public.claims c on c.identity_id = g.id
       where g.list_id = new.id
         and g.email is not null
         and not g.mail_off
       group by g.id, g.locale
    loop
      select s.id into v_share
        from public.share_items si
        join public.shares s on s.id = si.share_id
       where si.item_id = any (r.item_ids)
         and s.revoked_at is null
         and (s.expires_at is null or s.expires_at > now())
       order by s.created_at desc
       limit 1;
      if v_share is not null then
        perform public.enqueue_guest_mail(r.identity_id, v_share, 'thanks', null, coalesce(r.locale, 'uk'),
                                          jsonb_build_object('message', new.thanks_message));
      end if;
    end loop;
  exception when others then
    -- Збій гостьового кроку не має бути видимим власнику (ADR-040, п. 4).
    null;
  end;
  return null;
end;
$$;

revoke all on function public.lists_thanks_mail_trg() from public, anon, authenticated;

create trigger lists_thanks_mail
  after update of thanks_message on public.lists
  for each row
  when (old.thanks_sent_at is null and new.thanks_sent_at is not null)
  execute function public.lists_thanks_mail_trg();

-- ─────────────────────────────────────────────
-- get_guest_list — ще й `thanks`
-- ─────────────────────────────────────────────
--
-- Подяку бачать усі, хто відкрив живе посилання: і гість без ключа, і власник
-- на своєму посиланні. Решта — як у 20261008100000_guest_purchase.

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
  v_identity uuid;
  v_contact  jsonb;
  v_items    jsonb;
begin
  v_body := public.get_shared_list(p_token, p_key);
  v_share := public.live_share(p_token);
  select l.thanks_message into v_thanks from public.lists l where l.id = v_share.source_list_id;
  v_body := v_body || jsonb_build_object('thanks', v_thanks);

  if jsonb_typeof(v_body->'guest') is distinct from 'object' then
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
           order by t.ord), '[]'::jsonb)
    into v_items
    from jsonb_array_elements(v_body->'items') with ordinality as t(e, ord)
    left join public.claims c
      on c.identity_id = v_identity and c.item_id = (t.e->>'id')::uuid;

  return jsonb_set(
    jsonb_set(v_body, '{guest}', (v_body->'guest') || coalesce(v_contact, '{}'::jsonb)),
    '{items}', v_items
  );
end;
$$;

revoke all on function public.get_guest_list(text, text) from public;
grant execute on function public.get_guest_list(text, text) to anon, authenticated;
