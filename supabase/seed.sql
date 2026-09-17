-- supabase/seed.sql — тестові дані для ЛОКАЛЬНОЇ бази.
--
-- Застосовується лише командою `npx supabase db reset` після міграцій.
-- `db push` сід не чіпає: на бойову базу він не потрапляє ніколи.
--
-- Що всередині (TESTING.md, «Тестові дані»):
--   Анна (uk)   anna@wishlist.test   / password123
--     «Великий список» — 60 позицій: пагінація, сортування, фільтри, пошук
--     «День народження» — подія в минулому: підсумки етапу 6
--     «Для дому» — валюта UAH
--     посилання: активне з бронню, відкликане, прострочене, без цін
--   Богдан (pl) bohdan@wishlist.test / password123
--     власний список — щоб руками перевірити, що чуже не видно
--
-- Ідентифікатори й токени фіксовані, щоб на них можна було посилатися
-- з документації й тестів. Префікс 5eed… не перетинається з pgTAP-тестами.

-- ─────────────────────────────────────────────
-- Користувачі
-- ─────────────────────────────────────────────
-- Порожні рядки замість NULL у полях токенів обовʼязкові: сервіс
-- автентифікації Supabase не вміє читати NULL у цих колонках і
-- відмовляє у вході з внутрішньою помилкою.

insert into auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
select
  '00000000-0000-0000-0000-000000000000', u.id, 'authenticated', 'authenticated', u.email,
  extensions.crypt('password123', extensions.gen_salt('bf')), now(),
  '{"provider": "email", "providers": ["email"]}'::jsonb,
  jsonb_build_object('locale', u.locale),
  now() - interval '30 days', now(),
  '', '', '', ''
from (values
  ('5eed0000-0000-4000-8000-00000000a001'::uuid, 'anna@wishlist.test',   'uk'),
  ('5eed0000-0000-4000-8000-00000000b001'::uuid, 'bohdan@wishlist.test', 'pl')
) as u(id, email, locale);

-- Без запису в identities вхід за паролем не працює.
insert into auth.identities (id, user_id, provider_id, provider, identity_data, last_sign_in_at, created_at, updated_at)
select
  gen_random_uuid(), u.id, u.id::text, 'email',
  jsonb_build_object('sub', u.id::text, 'email', u.email, 'email_verified', true),
  now(), now(), now()
from auth.users u
where u.id in ('5eed0000-0000-4000-8000-00000000a001', '5eed0000-0000-4000-8000-00000000b001');

-- Профілі створив тригер handle_new_user; уточнюємо мову.
update public.profiles set display_name = 'Анна', locale = 'uk'
 where id = '5eed0000-0000-4000-8000-00000000a001';
update public.profiles set display_name = 'Bohdan', locale = 'pl'
 where id = '5eed0000-0000-4000-8000-00000000b001';

-- ─────────────────────────────────────────────
-- Списки
-- ─────────────────────────────────────────────

insert into public.lists (id, owner_id, title, description, currency, event_date, created_at) values
  ('5eed0000-0000-4000-8000-0000000001a1', '5eed0000-0000-4000-8000-00000000a001',
   'Великий список', 'Шістдесят позицій для перевірки пагінації, сортування й пошуку.',
   'PLN', null, now() - interval '20 days'),
  ('5eed0000-0000-4000-8000-0000000001a2', '5eed0000-0000-4000-8000-00000000a001',
   'День народження', 'Подія вже минула — тут перевіряється підбиття підсумків.',
   'PLN', current_date - 10, now() - interval '40 days'),
  ('5eed0000-0000-4000-8000-0000000001a3', '5eed0000-0000-4000-8000-00000000a001',
   'Для дому', null,
   'UAH', null, now() - interval '5 days'),
  ('5eed0000-0000-4000-8000-0000000001b1', '5eed0000-0000-4000-8000-00000000b001',
   'Lista Bohdana', 'Cudzej listy Anna nie powinna widzieć.',
   'PLN', current_date + 60, now() - interval '3 days');

-- ─────────────────────────────────────────────
-- «Великий список»: 60 позицій
-- ─────────────────────────────────────────────
-- Розподіл детермінований (від номера), тож кожен db reset дає те саме:
--   кожна 7-ма без ціни, кожна 5-та без посилання;
--   пріоритет по колу low / medium / medium / high;
--   кожна 9-та куплена, кожна 13-та подарована;
--   дати створення розкидані на 60 годин назад.
-- Назви з латиницею, кирилицею й польськими літерами — для сортування за мовою.

insert into public.items (list_id, owner_id, title, url, price, quantity, priority, note, status, created_at)
select
  '5eed0000-0000-4000-8000-0000000001a1',
  '5eed0000-0000-4000-8000-00000000a001',
  format('%s №%s', t.names[1 + (n - 1) % array_length(t.names, 1)], n),
  case when n % 5 = 0 then null else format('https://shop.example.com/p/%s', n) end,
  case when n % 7 = 0 then null else round((19.99 + (n * 37) % 1500)::numeric, 2) end,
  1 + (n % 3),
  (array['low', 'medium', 'medium', 'high'])[1 + n % 4]::public.item_priority,
  case when n % 11 = 0 then 'Колір — будь-який, крім жовтого.' else null end,
  case when n % 13 = 0 then 'gifted'
       when n % 9  = 0 then 'purchased'
       else 'active' end::public.item_status,
  now() - make_interval(hours => n)
from generate_series(1, 60) as n
cross join (select array[
  'Навушники', 'Łyżeczki', 'Air fryer', 'Ковдра', 'Żelazko', 'Книга', 'Єнот плюшевий',
  'Świeczka', 'Ґудзики', 'Blender', 'Їжачок-нічник', 'Śpiwór', 'Термос', 'Zegarek', 'Шарф'
] as names) t;

-- ─────────────────────────────────────────────
-- «День народження»: подія минула
-- ─────────────────────────────────────────────

insert into public.items (id, list_id, owner_id, title, url, price, quantity, priority, status, created_at) values
  ('5eed0000-0000-4000-8000-00000000c001', '5eed0000-0000-4000-8000-0000000001a2', '5eed0000-0000-4000-8000-00000000a001',
   'Навушники Sony WH-1000XM5', 'https://shop.example.com/sony', 1299.00, 1, 'high',   'active',    now() - interval '39 days'),
  ('5eed0000-0000-4000-8000-00000000c002', '5eed0000-0000-4000-8000-0000000001a2', '5eed0000-0000-4000-8000-00000000a001',
   'Келихи для вина', null, 89.90, 6, 'medium', 'active', now() - interval '38 days'),
  ('5eed0000-0000-4000-8000-00000000c003', '5eed0000-0000-4000-8000-0000000001a2', '5eed0000-0000-4000-8000-00000000a001',
   'Набір викруток', null, null, 1, 'low', 'active', now() - interval '37 days'),
  ('5eed0000-0000-4000-8000-00000000c004', '5eed0000-0000-4000-8000-0000000001a2', '5eed0000-0000-4000-8000-00000000a001',
   'Сертифікат у книгарню', null, 200.00, 1, 'medium', 'gifted', now() - interval '36 days'),
  ('5eed0000-0000-4000-8000-00000000c005', '5eed0000-0000-4000-8000-0000000001a2', '5eed0000-0000-4000-8000-00000000a001',
   'Кавоварка', 'https://shop.example.com/coffee', 450.00, 1, 'high', 'purchased', now() - interval '35 days');

-- ─────────────────────────────────────────────
-- «Для дому» (UAH) і список Богдана
-- ─────────────────────────────────────────────

insert into public.items (list_id, owner_id, title, price, quantity, priority, status) values
  ('5eed0000-0000-4000-8000-0000000001a3', '5eed0000-0000-4000-8000-00000000a001', 'Сковорідка чавунна', 1850.00, 1, 'medium', 'active'),
  ('5eed0000-0000-4000-8000-0000000001a3', '5eed0000-0000-4000-8000-00000000a001', 'Рушники',             640.00, 4, 'low',    'active'),
  ('5eed0000-0000-4000-8000-0000000001b1', '5eed0000-0000-4000-8000-00000000b001', 'Rower miejski',       2400.00, 1, 'high',   'active'),
  ('5eed0000-0000-4000-8000-0000000001b1', '5eed0000-0000-4000-8000-00000000b001', 'Kask',                 199.00, 1, 'medium', 'active'),
  ('5eed0000-0000-4000-8000-0000000001b1', '5eed0000-0000-4000-8000-00000000b001', 'Książka o grzybach',    null, 1, 'low',    'active');

-- ─────────────────────────────────────────────
-- Посилання на «День народження»
-- ─────────────────────────────────────────────
-- Відкриваються за адресою http://localhost:5173/s/<токен>.

insert into public.shares (id, owner_id, source_list_id, token, title, message,
                           hide_prices, allow_reservations, expires_at, revoked_at,
                           view_count, created_at) values
  ('5eed0000-0000-4000-8000-00000000d001', '5eed0000-0000-4000-8000-00000000a001', '5eed0000-0000-4000-8000-0000000001a2',
   'seed-active-share-token', 'Мій день народження', 'Буду рада будь-чому з цього списку!',
   false, true, null, null, 3, now() - interval '30 days'),
  ('5eed0000-0000-4000-8000-00000000d002', '5eed0000-0000-4000-8000-00000000a001', '5eed0000-0000-4000-8000-0000000001a2',
   'seed-revoked-share-token', 'Старе посилання', null,
   false, true, null, now() - interval '20 days', 1, now() - interval '32 days'),
  ('5eed0000-0000-4000-8000-00000000d003', '5eed0000-0000-4000-8000-00000000a001', '5eed0000-0000-4000-8000-0000000001a2',
   'seed-expired-share-token', 'Прострочене посилання', null,
   false, true, now() - interval '1 day', null, 0, now() - interval '31 days'),
  ('5eed0000-0000-4000-8000-00000000d004', '5eed0000-0000-4000-8000-00000000a001', '5eed0000-0000-4000-8000-0000000001a2',
   'seed-no-prices-share-token', 'Без цін', 'Ціни приховано.',
   true, false, null, null, 0, now() - interval '29 days');

-- Активне посилання: усі позиції; купленої й подарованої гість не побачить.
insert into public.share_items (share_id, item_id)
select '5eed0000-0000-4000-8000-00000000d001', i.id
  from public.items i where i.list_id = '5eed0000-0000-4000-8000-0000000001a2';

insert into public.share_items (share_id, item_id)
select s.share_id, i.item_id
  from (values ('5eed0000-0000-4000-8000-00000000d002'::uuid),
               ('5eed0000-0000-4000-8000-00000000d003'::uuid),
               ('5eed0000-0000-4000-8000-00000000d004'::uuid)) s(share_id)
 cross join (values ('5eed0000-0000-4000-8000-00000000c001'::uuid),
                    ('5eed0000-0000-4000-8000-00000000c002'::uuid)) i(item_id);

-- Броні в активному посиланні: навушники розібрано повністю, келихів — 2 з 6.
-- guest_key вигадані: у браузері вони не збігатимуться з твоїм, тож зняти
-- ці броні як гість не вийде — лише побачити.
insert into public.reservations (share_id, item_id, guest_key, quantity) values
  ('5eed0000-0000-4000-8000-00000000d001', '5eed0000-0000-4000-8000-00000000c001', 'seed-guest-key-0000001', 1),
  ('5eed0000-0000-4000-8000-00000000d001', '5eed0000-0000-4000-8000-00000000c002', 'seed-guest-key-0000002', 2);
