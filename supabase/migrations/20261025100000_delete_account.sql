-- Видалення акаунта власником (ADR-072).
--
-- Одна функція, яка звіряє пароль і стирає рядок `auth.users`. Решту робить
-- каскад, який уже є в схемі: профіль, списки, позиції, розділи, посилання,
-- оформлення, сповіщення й push-підписки мають `on delete cascade` на
-- `auth.users`, а все гостьове, що висить на списках і посиланнях власника
-- (позначки, черга листів, збори), — каскад від них. Тож видалення акаунта —
-- це те саме, що видалення кожного його списку, і гостям поводиться так
-- само: посилання стає мертвим (`not_found`, CLAUDE.md §3.3), листів немає.
--
-- Що НЕ стирається, і це навмисно:
--   * позначки, які ця людина сама лишила гостем на чужих списках: це
--     частина чужого свята, а не її даних. `guest_identities.user_id` має
--     `on delete set null` (ADR-062) — бронь лишається, лише без акаунта;
--   * скарги на її посилання (`share_reports`, ADR-061) — без зовнішнього
--     ключа, щоб видалення акаунта не стирало скаргу на нього.
--
-- Пароль звіряється тут, а не в браузері: інакше для видалення досить було
-- б чужої відкритої сесії. Невдалі спроби рахуються — п'ять на годину, як і
-- для коду гостя (ADR-070); без ліміту функція стала б перевіркою пароля
-- для того, хто має сесію, але не пароль. Невдача повертається в тілі, а не
-- винятком: виняток відкотив би й запис спроби.

-- ─────────────────────────────────────────────
-- Журнал невдалих спроб
-- ─────────────────────────────────────────────

create table public.account_delete_attempts (
  owner_id     uuid not null references auth.users(id) on delete cascade,
  attempted_at timestamptz not null default now()
);

comment on table public.account_delete_attempts is
  'Невдалі спроби підтвердити видалення акаунта паролем — для ліміту 5 на годину (ADR-072). Без IP і без пароля; старше години стирається при кожній спробі.';

create index account_delete_attempts_owner_idx
  on public.account_delete_attempts (owner_id, attempted_at);

alter table public.account_delete_attempts enable row level security;
-- Політик немає: таблицю читає й пише лише delete_my_account.
revoke all on public.account_delete_attempts from public, anon, authenticated;

-- ─────────────────────────────────────────────
-- delete_my_account
-- ─────────────────────────────────────────────

create or replace function public.delete_my_account(p_password text)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid  uuid := auth.uid();
  v_hash text;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;

  select u.encrypted_password into v_hash from auth.users u where u.id = v_uid;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  -- Акаунт без пароля (лише вхід через Google) підтвердити паролем нічим.
  -- Інтерфейс радить задати пароль через «Не памʼятаєш пароль?».
  if coalesce(v_hash, '') = '' then
    return 'no_password';
  end if;

  delete from public.account_delete_attempts where attempted_at < now() - interval '1 hour';
  if (select count(*) from public.account_delete_attempts where owner_id = v_uid) >= 5 then
    return 'too_many';
  end if;

  -- bcrypt бере лише перші 72 байти; довший рядок — не пароль із форми.
  if p_password is null or p_password = '' or octet_length(p_password) > 1024
     or extensions.crypt(p_password, v_hash) <> v_hash then
    insert into public.account_delete_attempts (owner_id) values (v_uid);
    return 'wrong_password';
  end if;

  delete from auth.users where id = v_uid;
  return 'deleted';
end;
$$;

comment on function public.delete_my_account(text) is
  'Видаляє акаунт викликача після звірки пароля (ADR-072). Повертає deleted | wrong_password | too_many | no_password. Решту даних стирає каскад від auth.users.';

revoke execute on function public.delete_my_account(text) from public, anon;
grant execute on function public.delete_my_account(text) to authenticated;
