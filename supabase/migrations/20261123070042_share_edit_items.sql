-- 20261123070042_share_edit_items.sql
-- Зима, пункт 8.9 ROADMAP: змінити склад опублікованої добірки.
--
-- Що змінюється:
--   * edit_share_items(посилання, додати[], прибрати[]) — власник змінює набір
--     позицій живого посилання однією транзакцією. SECURITY INVOKER: чуже
--     посилання RLS просто не показує (not_found), а вставку стереже
--     share_items_insert_own (позиція лише зі списку посилання, ADR-070);
--     чернетку мовчки не пускає share_items_skip_drafts (ADR-046);
--   * тригер share_items_unshared: позицію прибрали з живого посилання, і
--     вона більше не стоїть у жодному іншому живому посиланні свого списку —
--     броні гостей на ній знімаються мовчки, гостям із поштою йде лист через
--     чергу (вид 'deleted' з reason = 'unshared'), а збір на ній скасовується
--     так само, як за видалення позиції (ADR-055, ADR-064);
--   * gift_pool_cancel_trg розрізняє «позицію прибрано з посилання»
--     (reason = 'unshared') — лист учасникам каже про це, а не про скасування
--     організатором.
--
-- Позначка — на позицію списку, не на посилання (ADR-035): два посилання
-- одного списку бачать ті самі броні. Тому бронь знімається лише тоді, коли
-- позицію вже не видно за жодним живим посиланням; лишилась в іншому — бронь
-- лишається. Відкликання й видалення посилання цілком броней не чіпають, як і
-- досі: тригер дивиться лише на посилання, яке ще існує й живе.
--
-- ІНВАРІАНТ (CLAUDE.md §3.2; ADR-038, ADR-040): власник не дізнається, чи
-- позицію хтось узяв. edit_share_items повертає void; тригер пише лише в
-- закриті гостьові таблиці, нічого не повертає й ковтає будь-яку свою
-- помилку, тож відповідь і помилки власника однакові, є броні чи ні. Лист не
-- відправляється в його запиті — лише стає в чергу (ADR-040, п. 4; ADR-054).

-- ─────────────────────────────────────────────
-- Позицію прибрали з посилання — броні й лист
-- ─────────────────────────────────────────────
--
-- AFTER DELETE: рядка вже немає, тож «чи стоїть позиція ще десь живою» —
-- це просто live_share_of_item. Кілька рядків одним запитом (позицію
-- прибрали з двох посилань разом): AFTER ROW спрацьовує після всього
-- запиту, тож кожен виклик бачить уже кінцевий склад; другий бронь уже не
-- знайде й нічого не зробить.
--
-- Каскад від видалення позиції чи посилання сюди теж приходить — тоді
-- позиції або посилання вже немає, і тригер мовчить: про видалену позицію
-- лист ставить guest_item_deleted_trg, а видалене посилання броней не знімає.

create or replace function public.guest_item_unshared_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_title text;
  v_share public.shares;
  r       record;
begin
  begin
    select i.title into v_title from public.items i where i.id = old.item_id;
    if not found then
      return null;
    end if;
    select s.* into v_share from public.shares s where s.id = old.share_id;
    if not found
       or v_share.revoked_at is not null
       or (v_share.expires_at is not null and v_share.expires_at <= now()) then
      -- Мертве посилання гості й так не бачили: склад нічого не змінив.
      return null;
    end if;
    if public.live_share_of_item(old.item_id) is not null then
      -- Позиція лишилась в іншому живому посиланні списку — бронь теж.
      return null;
    end if;
    if not exists (select 1 from public.claims where item_id = old.item_id) then
      return null;
    end if;

    for r in
      select c.identity_id, c.purchased_at, g.locale
        from public.claims c
        join public.guest_identities g on g.id = c.identity_id
       where c.item_id = old.item_id
    loop
      perform public.enqueue_guest_mail(
        r.identity_id, old.share_id, 'deleted', null, coalesce(r.locale, 'uk'),
        jsonb_build_object('title', v_title, 'reason', 'unshared')
          || case when r.purchased_at is not null
                  then jsonb_build_object('bought', (r.purchased_at at time zone 'Europe/Warsaw')::date)
                  else '{}'::jsonb end);
    end loop;

    -- Збір на позиції зникне разом із бронню організатора (gift_pool_release);
    -- лист учасникам має сказати «позицію прибрано», а не «скасовано».
    perform set_config('wishlist.unshared_item', old.item_id::text, true);
    delete from public.claims where item_id = old.item_id;
    perform set_config('wishlist.unshared_item', '', true);
  exception when others then
    -- Зміна складу ніколи не залежить від позначок (ADR-038).
    null;
  end;
  return null;
end;
$$;

revoke all on function public.guest_item_unshared_trg() from public, anon, authenticated;

create trigger share_items_unshared
  after delete on public.share_items
  for each row execute function public.guest_item_unshared_trg();

-- ─────────────────────────────────────────────
-- Збір зникає — тепер і з причиною «прибрано з посилання»
-- ─────────────────────────────────────────────
--
-- Тіло — як у 20261020150000_pool_mail.sql, плюс третя причина. Старий
-- сервіс листів невідому причину пише як «збір скасовано» — правда, хоч і
-- неповна; новий каже, що позицію прибрано.

create or replace function public.gift_pool_cancel_trg()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_reason text;
  r        record;
begin
  begin
    v_reason := case
      when not exists (select 1 from public.items i where i.id = old.item_id) then 'deleted'
      when coalesce(current_setting('wishlist.unshared_item', true), '') = old.item_id::text then 'unshared'
      else 'cancelled'
    end;
    for r in
      select x.identity_id, x.amount
        from public.gift_pool_pledges x
       where x.pool_id = old.id and x.identity_id <> old.organizer_id
    loop
      begin
        perform public.enqueue_pool_mail(old, r.identity_id, 'pool_cancel',
                                         jsonb_build_object('reason', v_reason, 'amount', r.amount));
      exception when others then
        null;
      end;
    end loop;
  exception when others then
    null;
  end;
  return old;
end;
$$;

revoke all on function public.gift_pool_cancel_trg() from public, anon, authenticated;

-- ─────────────────────────────────────────────
-- edit_share_items — «Змінити склад» і «Додати в посилання»
-- ─────────────────────────────────────────────
--
-- Різницею, а не повним набором: аркуш «Змінити склад» шле, що додав і що
-- прибрав, а «Додати в посилання» — одну нову позицію. Так позиція, яку
-- власник щойно додав в іншій вкладці, не зникає через старий набір.
--
-- Помилки залежать лише від посилання й складу, ніколи від позначок:
--   not_found (P0002)      — посилання немає або воно чуже (RLS його не показує);
--   share_not_live (22023) — відкликане чи протерміноване: гості його не бачать;
--   no_items (22023)       — після зміни в посиланні не лишилось жодної позиції,
--                            як і в create_share (BUG-QA-06).
-- Позиції з іншого списку й чужі RLS відсіює ще до вставки, чернетки — тригер.

create or replace function public.edit_share_items(
  p_share_id uuid,
  p_add      uuid[] default '{}',
  p_remove   uuid[] default '{}'
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_share public.shares;
begin
  select s.* into v_share from public.shares s where s.id = p_share_id and s.owner_id = auth.uid();
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_share.revoked_at is not null or (v_share.expires_at is not null and v_share.expires_at <= now()) then
    raise exception 'share_not_live' using errcode = '22023';
  end if;

  delete from public.share_items si
   where si.share_id = v_share.id
     and si.item_id = any(coalesce(p_remove, '{}'))
     and not (si.item_id = any(coalesce(p_add, '{}')));

  insert into public.share_items (share_id, item_id)
  select v_share.id, i.id
    from public.items i
   where i.id = any(coalesce(p_add, '{}'))
     and i.list_id = v_share.source_list_id
     and not exists (select 1 from public.share_items x where x.share_id = v_share.id and x.item_id = i.id);

  if not exists (select 1 from public.share_items x where x.share_id = v_share.id) then
    raise exception 'no_items' using errcode = '22023';
  end if;
end;
$$;

revoke execute on function public.edit_share_items(uuid, uuid[], uuid[]) from public, anon;
grant execute on function public.edit_share_items(uuid, uuid[], uuid[]) to authenticated;

comment on function public.edit_share_items(uuid, uuid[], uuid[]) is
  '8.9: додати й прибрати позиції живого посилання власника однією транзакцією. Нічого не повертає; броні прибраних позицій знімає тригер share_items_unshared, мовчки (CLAUDE.md §3.2).';
