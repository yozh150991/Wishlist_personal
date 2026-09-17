# Архітектура

## Огляд

```
┌──────────────────────────────┐        ┌─────────────────────────┐
│  Браузер (PWA)               │        │  Гість (без акаунта)    │
│  React + Vite + TS           │        │  /s/:token              │
│  Service Worker + IndexedDB  │        └───────────┬─────────────┘
└──────────┬───────────────────┘                    │
           │ supabase-js (JWT)                      │ supabase-js (anon)
           │                                        │ тільки RPC
           ▼                                        ▼
┌───────────────────────────────────────────────────────────────┐
│  Supabase                                                     │
│  ├── Auth (email+пароль, підтвердження email)                 │
│  ├── Postgres + RLS  ← головний рубіж безпеки                 │
│  └── PostgREST → RPC: get_shared_list, reserve_item, ...      │
└───────────────────────────────────────────────────────────────┘
           ▲
           │ HTTPS + Supabase JWT
           │
┌──────────┴───────────────────┐
│  parser-service (FastAPI)    │   Google Cloud Run
│  POST /parse                 │
│  OpenGraph / schema.org      │
│  SSRF-guard, кеш, таймаути   │
└──────────────────────────────┘
```

## Межі довіри

1. **Клієнт нічому не довіряє.** Уся авторизація — у Postgres RLS. Фронтенд лише зручність.
2. **Anon-роль не має `SELECT` на таблицях.** Гість бачить дані винятково через `SECURITY DEFINER` RPC, які самі перевіряють токен, термін дії та відкликання.
3. **Парсер — окремий процес** із власним мережевим периметром. Він ходить у зовнішній інтернет, тому не має доступу до БД взагалі: повертає JSON клієнту, клієнт зберігає дані через Supabase під своїм JWT.

## Хостинг

| Частина | Де | Особливості |
|---|---|---|
| Фронтенд | Vercel, збірка з теки `app` | `vercel.json`: перезапис шляхів на `index.html`, `noindex` для `/s/*`, заголовки безпеки |
| Парсер | Cloud Run, `europe-central2` (ADR-021) | масштабування до нуля, `--max-instances 2` |
| Supabase | Frankfurt, тариф Free | проєкт засинає після тижня бездіяльності |
| Пошта | Brevo SMTP (ADR-022) | відправник — підтверджена адреса, не домен |

Кеш відповідей, кеш токенів і обмеження частоти в парсері живуть у пам'яті процесу. На Cloud Run це означає: після простою інстанс зупиняється, і кеші зникають; при двох одночасних інстансах кожен рахує ліміт окремо, тож фактична межа — до 40 запитів на хвилину замість 20. Для особистого застосунку це прийнятно.

## Потоки

### Додавання позиції з посилання
```
Користувач вставляє URL
  → фронт: POST /parse {url}   (Authorization: Bearer <supabase JWT>)
  → парсер: перевірка форми токена → GET /auth/v1/user у Supabase (кеш 5 хв)
  → прибирання рекламних параметрів → кеш відповідей (15 хв)
  → GET потоком на перевірену IP, з Host і SNI справжнього домену
    (понад 5 МБ обрізається, таймаут 8 с, до 5 редиректів,
    кожна адреса й кожен редирект проходять SSRF-перевірку)
  → витяг og:title / og:image / product:price / schema.org Offer
  → {title, price, currency, image_url, site_name} або часткові дані
  → фронт заповнює форму, користувач редагує і зберігає
  → supabase.from('items').insert(...)
```
Якщо парсер недоступний або нічого не знайшов — форма відкривається з підставленим URL і порожніми полями. Додавання ніколи не блокується.

### Створення спільного посилання
```
Вибір позицій (чекбокси) → «Поділитися»
  → rpc('create_share', {list_id, item_ids, title, hide_prices, ...})
  → повертає share з token
  → фронт формує https://<host>/s/<token>
```

### Перегляд гостем
```
GET /s/:token
  → rpc('get_shared_list', {token})   [anon]
  → rpc('register_share_view', {token})
  → бронювання: rpc('reserve_item', {token, item_id, guest_key})
```
`guest_key` — випадковий UUID у `localStorage` гостя. Потрібен лише щоб гість міг зняти власну бронь. Не ідентифікує особу.

## PWA і офлайн-режим

### Зроблено (етап 6.1, ADR-025)

- **Встановлення.** `vite-plugin-pwa` генерує `manifest.webmanifest` (`start_url: /lists`, `display: standalone`) та Service Worker. Іконки — `public/icons/`, PNG генеруються з SVG скриптом `scripts/generate-icons.mjs`. У налаштуваннях розділ «Застосунок на телефоні»: кнопка встановлення там, де браузер надсилає `beforeinstallprompt` (`lib/install.ts`), інструкція для iPhone і iPad, де такої події немає.
- **Оболонка офлайн.** Service Worker заздалегідь кешує збірку: код, стилі, шрифти (кирилиця й латиниця; грецькі й вʼєтнамські підмножини виключено), іконки — близько 770 КБ. Будь-яка адреса застосунку відкривається з кешованого `index.html` і без мережі.
- **Гостьові сторінки не кешуються.** `/s/*` виключено з навігації Service Worker: відповідь із токеном в адресі не лягає в кеш пристрою. Перевіряється після збірки `npm run check:pwa`, і в CI теж.
- **Дані не кешуються.** Запити до Supabase і парсера завжди йдуть у мережу. Без мережі сторінки показують «Немає зʼєднання» (`lib/errors.ts`), а не порожній стан. Запити `/rest/v1/` при `navigator.onLine === false` відхиляються одразу, без трьох повторів клієнта PostgREST (`lib/supabase.ts`); запити автентифікації не чіпаються, щоб збій мережі не завершив сесію.
- **Оновлення.** Нова збірка не підміняє відкриту сторінку сама: `UpdatePrompt` показує банер, оновлення — за кнопкою. Відкритий застосунок перевіряє оновлення щогодини. У режимі розробки Service Worker вимкнено.
- **Колір системних панелей** (`theme-color`) збігається з верхньою панеллю застосунку і змінюється разом із темою.

### Ще в плані

- IndexedDB зберігає останній стан списків для читання офлайн (етап 6.4).
- Черга змін (`outbox`): редагування офлайн відправляються при відновленні мережі, конфлікти — last-write-wins за `updated_at` (етап 6.5; спершу вирішити, чи це взагалі потрібно).

## Структура фронтенду

```
app/
├── index.html  vercel.json  vite.config.ts  playwright.config.ts
├── public/icons/         # іконки застосунку; PNG — з SVG через scripts/generate-icons.mjs
├── scripts/              # generate-icons.mjs, check-pwa.mjs
├── tsconfig.json         # src/, без типів Node
├── tsconfig.test.json    # tests/ і playwright.config.ts
├── src/
│   ├── main.tsx  App.tsx  styles.css  vite-env.d.ts
│   ├── routes/           # по файлу на сторінку
│   │   ├── Login.tsx  Register.tsx  ResetPassword.tsx  UpdatePassword.tsx
│   │   ├── Lists.tsx  ListDetail.tsx  Shares.tsx  Settings.tsx
│   │   ├── SharedList.tsx          # /s/:token — гостьовий перегляд
│   │   └── NotFound.tsx
│   ├── components/
│   │   ├── AppShell.tsx  AuthLayout.tsx  RequireAuth.tsx  ui.tsx
│   │   ├── Dialog.tsx  ItemDialog.tsx  ListDialog.tsx  ShareDialog.tsx
│   │   └── ItemCard.tsx  Toolbar.tsx  LocaleSync.tsx  LanguagePicker.tsx  UpdatePrompt.tsx
│   ├── lib/
│   │   ├── supabase.ts  auth.tsx  theme.tsx  i18n.tsx  authErrors.ts
│   │   ├── db.ts  useItems.ts  shares.ts  guest.ts   # дані
│   │   ├── parser.ts                                 # клієнт парсера
│   │   └── format.ts  types.ts  safeNext.ts  errors.ts  install.ts
│   ├── i18n/{uk,pl,en}.json
│   └── types/database.ts # згенеровано, не редагувати
└── tests/e2e/            # Playwright
```

Сторінки лежать пласко в `routes/`, спільні елементи — у `components/`, робота з даними — у `lib/`. Окремої теки `features/` немає: при такому обсязі вона лише додала б рівень вкладеності.

```
services/parser/
├── Dockerfile  docker-compose.yml  requirements*.txt  pytest.ini
├── app/
│   ├── main.py       # роути, CORS
│   ├── auth.py       # перевірка токена (ADR-018, ADR-023)
│   ├── fetcher.py    # SSRF-фільтр, редиректи, ліміти
│   ├── extract.py    # JSON-LD → microdata → OG → Twitter → title → евристика
│   └── cache.py  ratelimit.py  config.py  models.py
└── tests/            # pytest + HTML-фікстури
```

## Стан на клієнті

Три провайдери, вкладені саме в цьому порядку:

```
ThemeProvider        тема; застосовується скриптом в <head> до першого рендера
└── I18nProvider     мова; визначається з localStorage → navigator.languages → uk
    └── BrowserRouter
        └── AuthProvider   сесія Supabase; усередині роутера, бо потребує навігації
            └── LocaleSync мову інтерфейсу → user_metadata.locale, для листів (ADR-024)
```

Зовнішніх бібліотек стану немає — контексту достатньо. Дані позицій живуть у власному хуку `useItems` над supabase-js, без React Query: офлайн-черга з етапу 6 усе одно вимагатиме власного шару.

## Стилі

Без CSS-фреймворку (ADR-015). Токени — кастомні властивості в `:root`, темна тема перевизначає їх у `:root[data-theme='dark']`. Тема застосовується інлайновим скриптом у `<head>` до першого рендера, інакше на холодному старті блимає світлий фон.

Шрифти самохостяться через `@fontsource-variable` — не CDN, бо офлайн-режим на етапі 6 має працювати повністю. Обидві гарнітури мають підмножини `cyrillic` і `latin-ext`, тож українська і польська діакритика покриті.

## Захист роутів

`<RequireAuth>` — обгортка, що читає сесію Supabase. Поки сесія завантажується — скелетон, не редірект (інакше при F5 користувача викидає на логін). Немає сесії → `/login?next=<шлях>`.

Значення `next` приходить з адресного рядка, тож його може підставити будь-хто. Сторінка входу пропускає його через `safeNext` (`src/lib/safeNext.ts`): рядок розбирається тим самим парсером URL, що й у браузері, і приймається лише якщо лишається в межах сайту. Інакше — `/lists`.

Публічні роути: `/login`, `/register`, `/reset`, `/s/:token`. Усе інше — за автентифікацією.
