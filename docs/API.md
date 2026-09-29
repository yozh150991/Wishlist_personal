# API

Два джерела: RPC-функції Supabase (Postgres) і REST парсера.

## Supabase RPC

### `create_share` — authenticated
```ts
const { data } = await supabase.rpc('create_share', {
  p_list_id: listId,
  p_item_ids: selectedIds,      // uuid[]
  p_title: 'Мій день народження',
  p_message: null,
  p_hide_prices: false,
  p_allow_reservations: true,
  p_expires_on: '2026-12-20',       // день або null — «поки не відкличеш»
  p_expires_tz: 'Europe/Kyiv',      // IANA-зона з браузера власника (ADR-037)
});
// → { id, token, title, expires_at, expires_tz, ... }
// URL для гостя: `${origin}/s/${data.token}`
```
Чужі позиції та позиції з іншого списку мовчки відсіюються (RLS). Чернетки без назви (`items.needs_title`, ADR-046) теж мовчки пропускає тригер `share_items_skip_drafts` — тіло функції не змінилось, v1 про чернетки не знає й помилки не отримує. Порожній масив → помилка `22023`.

Термін — **день і зона**, момент рахує база: 23:59:59 того дня за зоною власника (`expires_at`, UTC) плюс сама зона (`expires_tz`). ICU-імена, які дає браузер (`Europe/Kiev`, `Asia/Calcutta`), записуються сучасними. Помилки, обидві `22023`:
- `bad_time_zone` — день без зони або зона, якої база не знає. Клієнт (`lib/shares.ts`) тоді повторює запит зі старим `p_expires_at` — кінцем дня за годинником пристрою, без зони.
- `expires_in_past` — момент уже минув: посилання, мертве з народження, не створюється. Форма перевіряє те саме до відправки.

`p_expires_at` (момент без зони) лишився для вкладок зі старою версією застосунку.

### `get_shared_list` — anon + authenticated
```ts
const { data } = await supabase.rpc('get_shared_list', { p_token: token, p_key: guestKey /* або null */ });
```
```jsonc
{
  "title": "Мій день народження",
  "message": null,
  "currency": "PLN",
  "event_date": "2026-06-14",   // дата події списку або null — для шапки гостьової
  "expires_at": "2026-12-20T21:59:59+00:00",   // до коли діє посилання або null
  "expires_tz": "Europe/Kyiv",  // зона власника, у якій показувати термін; null — старе посилання (ADR-037)
  "owner_scheme": "sage",   // схема власника: sage | slyva | polotno | cytrus | nich (ADR-033)
  "appearance_hue": 75,     // відтінок оформлення списку або null (ADR-034)
  "hide_prices": false,
  "allow_reservations": true,
  "viewer_is_owner": false,
  "guest": { "code": "7K4M2" },   // ключ упізнано; null — ключа немає або він чужий
  "sections": [{ "id": "…", "title": "Кухня" }],   // лише розділи зі спільними позиціями, у порядку власника (ADR-036)
  "items": [{
    "id": "…", "title": "Навушники", "url": "https://…",
    "price": "399.00", "quantity": 1, "priority": "high",
    "note": null, "image_url": "https://…", "status": "active",
    "variants": [{ "label": "Розмір", "value": "M" }],   // до 5 пар, ADR-030
    "section_id": "…",       // розділ або null — «Інше»
    "taken_qty": 1,          // скільки взяли всі разом; null, якщо дивиться власник
    "mine_qty": 0            // скільки взяв цей гість; null для власника
  }]
}
```
Помилка одна: `not_found` (код `P0002`) — і для неіснуючого, і для відкликаного, і для протермінованого токена (ADR-035). Відповідь не має підтверджувати, що токен колись існував.

Показуються лише позиції зі `status = 'active'`. При `hide_prices: true` поле `price` повертається як `null` — ціна не їде на клієнт узагалі, не ховається стилями.

`variants` від `hide_prices` не залежить: розмір і колір — не ціна, і саме заради них гість і дивиться картку.

`appearance_hue` — відтінок оформлення списку (ADR-034); назва оформлення приватна й не віддається. Рампу з відтінку рахує клієнт. `event_date` — дата події списку для шапки гостьової: гість і так запрошений саме на цю подію.

`owner_scheme` — схема смаку власника: гість бачить список у ній (ADR-033). Висока контрастність власника гостю не віддається — це налаштування глядача, а не списку; свою гість вмикає сам. Схема читається щоразу, а не запікається в токен: власник змінив її — наступне відкриття посилання покаже нову.

`expires_at` + `expires_tz` — термін живого посилання. Гість бачить його годинником власника: «Діє до 20 грудня, 23:59 за Києвом» (`lib/zones.ts`), хоч сам у Ванкувері, — бо саме тоді посилання згасне для всіх. Мертве посилання терміну не показує: для нього відповідь та сама `not_found`.

Позиції йдуть у **ручному порядку власника** (ADR-036): розділи за порядком, «Інше» в кінці, усередині — `position`, неупорядковані зверху, новіші першими.

Ні хто, ні коли позначив — у відповіді немає: лише скільки. Виклик із ключем оновлює `last_seen` його ідентичності.

### `register_share_view` — anon + authenticated
```ts
await supabase.rpc('register_share_view', { p_token: token });
```
Викликати один раз на сесію перегляду. Перегляди власника не рахуються.

### `claim_item` / `release_claim` — anon + authenticated
```ts
const { data } = await supabase.rpc('claim_item', {
  p_token: token, p_item_id: itemId, p_key: guestKey, p_quantity: 1,
});
// → { "taken_qty": 1, "mine_qty": 1, "code": "7K4M2" }
await supabase.rpc('release_claim', { p_token: token, p_item_id: itemId, p_key: guestKey });
```
Ключ генерує браузер гостя (`lib/guest.ts`) і зберігає **до** виклику: обірвана відповідь не лишить позначку без власника. Перша позначка з новим ключем тихо створює ідентичність і короткий код. `p_quantity` — підсумкова кількість цього гостя, не приріст; позиція блокується на час перевірки, тож двоє одночасних гостей не візьмуть більше, ніж треба.

Помилки `claim_item`: `not_found`, `reservations_disabled`, `owner_cannot_reserve`, `bad_key`, `bad_quantity`, `item_not_in_share`, `not_enough_left` (гонку програно).

`release_claim` повертає `{ "taken_qty": … }` — суму позначок усіх гостей, тож власнику (увійшов і відкрив своє посилання) відповідає `owner_cannot_reserve`, як і `claim_item` (ADR-038). Решта помилок: `not_found`, `item_not_in_share`.

### `redeem_guest_code` — anon + authenticated
```ts
const { data } = await supabase.rpc('redeem_guest_code', { p_token: token, p_code: '7K4M2' });
// → { "key": "…", "code": "N5F9K", "claims": 2 }  або  { "error": "code_not_found" | "too_many_attempts" }
```
Код переносить позначки на новий пристрій одноразово: сервер видає новий ключ тієї самої ідентичності, старі ключі лишаються робочими, код змінюється. П'ять спроб на годину на список — зараховуються всі, і після п'ятої не приймається навіть правильний. Невдача — у тілі відповіді, а не винятком: виняток відкотив би запис спроби.

### `release_item_claims` — authenticated
```ts
await supabase.rpc('release_item_claims', { p_item_id: itemId });   // 204, без тіла
```
Сліпе «скинути позицію» власником: знімає позначки гостей, якщо вони є, і не повертає нічого — ні скільки, ні чи були. Чужа позиція — `not_found`. У інтерфейсі кнопка стоїть на кожній позиції завжди однаково: інакше сама її поява була б індикатором.

### `reorder_items` / `reorder_sections` — authenticated
```ts
await supabase.rpc('reorder_items', { p_list_id: listId, p_section_id: sectionId /* або null */, p_item_ids: ids });
await supabase.rpc('reorder_sections', { p_list_id: listId, p_section_ids: ids });
```
Ставлять розділ і `position` = номер у масиві для кожної переданої позиції (розділу). `SECURITY INVOKER`: чужі рядки RLS відсіює мовчки, і виклик просто нічого не змінює.

### `list_items_page` — authenticated
```ts
const { data } = await supabase.rpc('list_items_page', {
  p_list_id: listId,
  p_sort: 'created_at',        // created_at | title | price | priority
  p_desc: true,
  p_limit: 25,                 // 10 | 25 | 50 | 100
  p_cursor_key: last?.created_at ?? null,
  p_cursor_id: last?.id ?? null,
  p_search: query || null,
  p_status: ['active'],
  p_price_min: null,
  p_price_max: null,
});
```
Повернулося менше `p_limit` рядків → кінець списку.

### `list_totals` — authenticated
```ts
const { data } = await supabase.rpc('list_totals', { p_list_id: listId });
// → { items_count, active_count, purchased_count, gifted_count,
//     total_price, active_price, items_no_price }
```

### `save_push_subscription` — authenticated
```ts
const json = subscription.toJSON();   // PushSubscription браузера
await supabase.rpc('save_push_subscription', {
  p_endpoint: json.endpoint, p_p256dh: json.keys.p256dh, p_auth: json.keys.auth,
});                                    // 204, без тіла
```
Пристрій для push (ADR-049). `SECURITY DEFINER`: та сама адреса підписки від іншого власника прибирає його рядок — пристрій належить тому, хто ввімкнув push останнім, і наступна людина за пристроєм не отримує чужих сповіщень. Що адреса комусь належала, з відповіді не видно: функція нічого не повертає. Щонайбільше 10 пристроїв на власника — найстаріші відпадають. База перевіряє форму (`check`, `23514`): адреса — `https://` без пробілів і керівних символів, до 1024; `p256dh` — 65 байтів точки P-256 у base64url (`B…`, 87 знаків); `auth` — 16 байтів (22 знаки).

### `forget_push_subscription` — authenticated
```ts
await supabase.rpc('forget_push_subscription', { p_endpoint: subscription.endpoint });   // 204
```
«Вимкнути push тут» і вихід з акаунта. Прибирає лише свій рядок; чужий із тією самою адресою не чіпає й не видає. Напряму ні вставити, ні змінити, ні видалити рядок `push_subscriptions` клієнт не може: адреса підписки — секрет рівня токена, і в тілі запиту вона не осідає в журналах шлюзу API, як осів би фільтр `?endpoint=eq.…`.

### Права на виклик

| Функція | Ролі |
|---|---|
| `create_share`, `list_items_page`, `list_totals` | `authenticated` |
| `get_shared_list`, `register_share_view`, `claim_item`, `release_claim`, `redeem_guest_code` | `anon`, `authenticated` |
| `release_item_claims`, `reorder_items`, `reorder_sections`, `save_push_subscription`, `forget_push_subscription` | `authenticated` |
| `gen_share_token` | `authenticated` — лише тому, що її викликає `create_share` з правами викликача; сама даних не читає |

Права задано міграціями `20260910120300_grants.sql` і `20260916220000_revoke_default_function_grants.sql`. Перша відкликала лише `PUBLIC`, і функції власника лишались доступними `anon` через явні гранти Supabase за замовчуванням; друга це закрила. Кожна нова RPC-функція отримує гранти явно й відкликає їх у конкретних ролей (CLAUDE.md §3.4). Таблицю вище перевіряє `supabase/tests/database/01_schema_guards.test.sql`.

## Звичайні запити (через RLS)

CRUD списків і позицій — прямо через PostgREST, RLS усе відсіює:
```ts
await supabase.from('items').insert({ list_id, title, url, price });
await supabase.from('items').update({ status: 'gifted' }).eq('id', id);
await supabase.from('shares').update({ revoked_at: new Date().toISOString() }).eq('id', shareId);
```

Масові дії — ті самі запити з фільтром `in`. Ідентифікатори їдуть у рядку адреси, тож `lib/db.ts` ділить їх на частини по 100:
```ts
await supabase.from('items').update({ status: 'gifted' }).in('id', ids);
await supabase.from('items').delete().in('id', ids);
```
Окремої RPC не потрібно: RLS так само відсіює чужі позиції, як і в одиночних запитах.

Оформлення списку (ADR-034) — теж звичайними запитами, `lib/appearances.ts`:
```ts
await supabase.from('appearances').select('id, owner_id, name, hue, source, builtin_key, created_at, lists(count)');
await supabase.from('appearances').insert({ owner_id, name, hue, source: 'manual' });
await supabase.from('lists').update({ appearance_id }).eq('id', listId);   // null — без оформлення
```
Вбудовані події видно кожному власникові, змінити чи видалити їх не можна. Посилання на чуже оформлення база відхиляє з `42501`.

Розділи (ADR-036), `lib/sections.ts`:
```ts
await supabase.from('sections').select('id, list_id, title, position, created_at').eq('list_id', listId);
await supabase.from('sections').insert({ list_id, title, position });   // owner_id ставить тригер
await supabase.from('items').update({ section_id, position: null }).eq('id', itemId);
```
Розділ іншого списку база відхиляє з `section_not_in_list` (`23514`).

Сповіщення (ADR-049), `lib/notifications.ts`:
```ts
await supabase.from('notification_settings').select('*').maybeSingle();          // null — нічого не ввімкнено
await supabase.from('notification_settings')
  .upsert({ owner_id, time_zone: 'Europe/Warsaw', link_push: true }, { onConflict: 'owner_id' });
await supabase.from('push_subscriptions').select('id', { count: 'exact', head: true });   // лише число пристроїв
await supabase.from('push_subscriptions').select('endpoint');   // чи цей пристрій ще на сервері — порівняння в браузері
```
Налаштування й пристрої бачить лише власник. `notification_log` (що вже надіслано) клієнту недоступний зовсім.

---

## Parser service (FastAPI)

Base URL: `VITE_PARSER_URL` (env). Автентифікація: `Authorization: Bearer <supabase access token>` — сервіс перевіряє токен запитом `GET /auth/v1/user` до Supabase і кешує результат на 5 хвилин (ADR-018). Жодних секретів у сервісі немає. Перед запитом локально перевіряється лише форма токена (JWT: три частини base64url, до 8 КБ); токен іншої форми відхиляється одразу, без звернення до Supabase.

### `POST /parse`
```json
{ "url": "https://allegro.pl/oferta/..." }
```
**200**
```json
{
  "url": "https://allegro.pl/oferta/...",
  "title": "Sony WH-1000XM5",
  "price": 1299.00,
  "currency": "PLN",
  "image_url": "https://a.allegroimg.com/...",
  "site_name": "allegro.pl",
  "confidence": { "title": "og", "price": "schema", "image": "og" },
  "partial": false
}
```
`partial: true` — щось витягти не вдалося; відсутні поля = `null`. Це **не помилка**: клієнт відкриває форму з тим, що є.

**Помилки**
| Код | Коли |
|---|---|
| `401 missing_token` | немає заголовка `Authorization` або схема не `Bearer` |
| `401 invalid_token` | токен неправильної форми (ADR-023) або Supabase його не прийняв |
| `400 invalid_url` | не http/https, некоректний URL |
| `403 blocked_host` | приватна мережа, localhost, метадані хмари, адреса не резолвиться |
| `422 unsupported_content` | не HTML |
| `429 rate_limited` | > 20 запитів/хв на користувача |
| `502 upstream_forbidden` | магазин відповів 401/403/405/429 — антибот-захист, див. нижче |
| `502 upstream_error` | магазин відповів іншою помилкою або обірвав з'єднання |
| `502 bad_redirect` | редирект без заголовка `Location` |
| `502 too_many_redirects` | понад 5 редиректів |
| `504 upstream_timeout` | магазин не відповів за 8 с |
| `500 supabase_not_configured` | у сервісі не заповнено `SUPABASE_URL` або лишився шаблон |
| `503 auth_unavailable` | Supabase недоступний, токен перевірити нічим |

Код помилки приходить у полі `detail`. Клієнт зіставляє його з ключем словника, тому текст лишається перекладним.

### `GET /health`
```json
{
  "status": "ok",
  "version": "0.1.0",
  "supabase_configured": true,
  "allowed_origins": ["https://wishlist-personal.vercel.app", "http://localhost:5173"],
  "secret_key_present": false
}
```
Без автентифікації. `supabase_configured: false` одразу пояснює `500 supabase_not_configured` на `/parse`; `allowed_origins` показує, звідки дозволено CORS. Секретів тут немає, тож відповідь безпечно відкрита.

`secret_key_present` має бути `false`. `true` означає, що в парсер помилково поклали `SUPABASE_SECRET_KEY`: ключ бази живе лише в закритому `wishlist-jobs` (ADR-012, ADR-048). Сам ключ парсер не читає — лише помічає його й пише помилку в лог при старті. Прибери змінну з сервісу парсера (DEPLOY.md, 9.7).

### Магазини з антибот-захистом

Allegro, Amazon, OLX та інші великі майданчики відмовляють запитам, що не схожі на справжній браузер: перевіряють виконання JS, cookies, TLS-відбиток. Універсальний парсер їх не проходить, і це не налаштовується.

Такі відповіді (401, 403, 405, 429) повертаються як `502` з окремим кодом `upstream_forbidden`, щоб інтерфейс міг сказати «магазин блокує автоматичні запити», а не «щось зламалось». Посилання при цьому зберігається — втрачається лише автозаповнення.

Обхід захисту свідомо не робимо: це гонка, яку сторона з більшими ресурсами виграє завжди. Реальні варіанти для конкретного магазину — його офіційне API (в Allegro таке є, але вимагає реєстрації застосунку й OAuth) або розширення для браузера, яке читає вже відкриту сторінку.

### Порядок витягу даних
1. JSON-LD `schema.org/Product` → `name`, `offers.price`, `offers.priceCurrency`, `image`
2. Microdata `itemprop`
3. OpenGraph: `og:title`, `og:image`, `product:price:amount`, `product:price:currency`
4. Twitter Card
5. `<title>` як остання надія для назви
6. Для ціни — евристика: текст елементів із «price» у `class`, `id` або `data-price`. Текст приймається, лише якщо має десяткову частину з двох цифр або знак валюти поруч — інакше в блок ціни потрапляють сторонні числа на кшталт «IKEA 365+» (ADR-019)

Перше знайдене значення виграє; джерело пишеться в `confidence`. Значення `heuristic` означає, що ціну взято з тексту сторінки, а не з розмітки — таке варто перевірити оком.

Перед запитом з URL прибираються рекламні параметри (ADR-020), тому у відповіді поле `url` може відрізнятись від надісланого.

### Безпека (SSRF)
- Резолв DNS **до** запиту; відмова, якщо хоча б одна з відповідей DNS — не публічна адреса. Замість переліку окремих прапорів використовується `is_global` — білий список за реєстром IANA, тож нові зарезервовані діапазони відсікаються самі. Крім нього явно блокуються multicast (`224.0.0.0/4`, `ff00::/8`) і `0.0.0.0`, які `is_global` вважає глобальними. Під забороною, зокрема, `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (метадані хмари), `100.64/10` (CGNAT, туди дивляться VPC-конектори), `::1`, `fc00::/7`.
- Редиректи обробляються вручну, кожен новий URL проходить ту саму перевірку, максимум 5 переходів (`PARSER_MAX_REDIRECTS`): магазини на Shopify часто роблять три-чотири.
- Зʼєднання йде на **вже перевірену IP**, а не на hostname: інакше httpx резолвив би DNS удруге, і домен атакуючого міг би віддати публічну адресу на перевірку й приватну — на зʼєднання (DNS rebinding). Заголовок `Host` і TLS SNI лишаються справжнім доменом, тож магазин віддає ту саму сторінку, а сертифікат перевіряється коректно (ADR-026).
- Адреси хоста пробуються по черзі, спершу IPv4: пін на одну адресу позбавив би запит запасних спроб, а вихідного IPv6 у Cloud Run немає.
- Заборона схем, крім `http`/`https`.
- Читання потоком із лімітом 5 МБ. Понад ліміт сторінка не відхиляється, а обрізається: мета-теги лежать у `<head>`, тож прочитаного зазвичай достатньо.
- Кеш відповідей 15 хв за нормалізованим URL.

---

## Сервіс фонових задач `wishlist-jobs` (ADR-048)

Закритий сервіс Cloud Run з того самого коду, що й парсер (`APP_MODULE=app.jobs_main:app`). Браузер його не викликає і не знає його адреси. Налаштування — DEPLOY.md, розділ 9.

**Хто викликає.** Лише Cloud Scheduler з ID-токеном (OIDC) облікового запису `wishlist-scheduler`; аудиторія токена — адреса сервісу. Запит без токена чи з токеном без ролі `roles/run.invoker` Cloud Run відхиляє сам — `403` ще до контейнера. Друга лінія в застосунку: без `Authorization: Bearer` — `401 missing_token`.

**Як ходить у базу.** PostgREST із secret-ключем (`sb_secret_…`) лише в заголовку `apikey`, без `Authorization`: нові ключі Supabase — не JWT. Роль — `service_role`, тож RLS не діє; тому сервіс пише вузько:
- перевірка посилань — лише поля `link_*` позиції за її `id`;
- сповіщення — `notification_log`, `notification_settings.last_sent_at`, `push_subscriptions.last_ok_at` і видалення мертвих підписок.

Пошту й мову власника сервіс читає з Supabase Auth (`GET /auth/v1/admin/users/{id}` тим самим ключем). З `shares` бере лише назву й термін — без токена. Таблиць позначок гостей (`claims`, `guest_*`) він не торкається.

### `POST /jobs/check-links`
Тіла немає. Перевіряє посилання, яким настала черга (ARCHITECTURE, «Перевірка посилань»), і відповідає лічильниками:
```json
{ "ok": 31, "out": 2, "gone": 1, "kept": 9, "deferred": 0, "checked": 43 }
```
| Поле | Що означає |
|---|---|
| `ok` / `out` / `gone` | висновки: сторінка є / товару немає в наявності / сторінки немає (404, 410) |
| `kept` | нічого певного (антибот, 5xx, тайм-аут, заблокований хост): висновок не змінено, записано лише час |
| `deferred` | не встигли за `JOBS_TIME_BUDGET_SECONDS` — підуть наступного запуску |
| `checked` | скільки позицій записано |

Поля з нулем у відповіді відсутні. Адрес, назв і `id` позицій немає ні у відповіді, ні в логах.

**Помилки**
| Код | Коли |
|---|---|
| `401 missing_token` | немає `Authorization: Bearer` (запит дійшов би сюди, лише якщо сервіс розгорнули відкритим) |
| `503 jobs_not_configured` | не задано `SUPABASE_URL` або `SUPABASE_SECRET_KEY`, чи ключ не починається з `sb_secret_` |
| `500` | Supabase відхилив ключ (401/403) чи недоступний; у лозі — «PostgREST відхилив ключ … перевір SUPABASE_SECRET_KEY» |

### `POST /jobs/notify`
Тіла немає. Сповіщення власникам (ADR-049; ARCHITECTURE, «Сповіщення власника»). Cloud Scheduler кличе щогодини. Відповідь — лічильники:
```json
{ "events": 4, "push": 1, "email": 1, "quiet": 2, "waiting": 1, "dropped": 0, "push_gone": 1, "brevo_ok": 1 }
```
| Поле | Що означає |
|---|---|
| `events` | скільки нових подій знайдено |
| `push` / `email` | скільком власникам дійшов push / лист (один на все, що назбиралось) |
| `quiet` | власників, у яких зараз 22:00–9:00 — чекають ранку |
| `waiting` | власників, яким надсилали менш ніж 3 год тому — чекають |
| `dropped` | подій, яким не було куди піти (push без пристроїв, пошта не підтверджена) — записані як пропущені |
| `push_gone` | підписок, яких більше немає (404/410) — прибрано |
| `push_blocked` | підписок не на службі push чи зі зіпсованими ключами — запиту не було, прибрано |
| `auth_unavailable` | власників, чию пошту й мову Auth зараз не віддав — чекають наступної години |
| `errors` | власників, на яких щось зламалось (збій бази тощо) — решта не постраждала, їхня черга чекає |
| `brevo_ok` / `brevo_refused` / `brevo_unreachable` | щоденна перевірка ключа Brevo о 03:00 UTC |

Поля з нулем відсутні. Назв, адрес, пошт і `id` немає ні у відповіді, ні в логах.

**Помилки**
| Код | Коли |
|---|---|
| `401 missing_token` | немає `Authorization: Bearer` |
| `503 notify_not_configured` | бракує `SUPABASE_*`, `BREVO_API_KEY`, `VAPID_PRIVATE_KEY`, `MAIL_FROM` чи `APP_ORIGIN` — які саме, показує `/health` |
| `500` | Supabase відхилив ключ чи недоступний |

Посилання в push і листах ведуть у v2: `/lists/…?design=v2`, `/settings?design=v2#notifications`.

**Push** — Web Push: `POST` на адресу підписки з `Authorization: vapid t=<JWT ES256>,k=<публічний ключ>`, `Content-Encoding: aes128gcm`, `TTL: 86400`. Тіло — JSON `{title, body, url, tag}`, зашифроване для браузера (RFC 8291). Адреса — лише https на хостах `fcm.googleapis.com`, `*.push.services.mozilla.com`, `*.push.apple.com`, `*.notify.windows.com`; решта відкидається без запиту.

**Лист** — `POST https://api.brevo.com/v3/smtp/email` з `api-key`, відправник `MAIL_FROM` з ім'ям «Wishlist», тег `wishlist-notify`. Раз на добу — `GET /v3/account`, щоб ключ не згас за 90 днів тиші.

### `GET /health`
```json
{
  "status": "ok", "service": "wishlist-jobs",
  "configured": true, "problems": [],
  "notify_configured": true, "notify_problems": [],
  "brevo": "ok"
}
```
Теж за IAM: без ID-токена — `403` від Cloud Run. Перевірка з консолі — DEPLOY.md, 9.7 і 9.11.

- `problems` — чого бракує перевірці посилань: `SUPABASE_URL` (не `https://…` або лишився шаблон `<project-ref>`) і `SUPABASE_SECRET_KEY` (порожній чи не `sb_secret_…`).
- `notify_problems` — чого бракує сповіщенням: `BREVO_API_KEY` (не `xkeysib-…`), `VAPID_PRIVATE_KEY` (не 43 символи base64url), `MAIL_FROM` (не адреса), `APP_ORIGIN` (не `https://домен`).
- `brevo` — живий виклик `GET /v3/account`: `ok`, `refused` (ключ не той, вимкнений чи заблоковано IP), `unreachable`, `not_configured`.

Назви змінних — без значень. Пробіли й переноси рядка на краях значень і BOM на початку сервіс обрізає сам.

### Змінні оточення
| Змінна | Усталено | Що робить |
|---|---|---|
| `APP_MODULE` | `app.main:app` | для цього сервісу — `app.jobs_main:app` |
| `SUPABASE_URL` | — | адреса проєкту |
| `SUPABASE_SECRET_KEY` | — | з Secret Manager (`wishlist-supabase-secret`), не в `--set-env-vars` |
| `JOBS_BATCH_SIZE` | `50` | розмір партії; запуск бере партію за партією, поки є черга й час |
| `JOBS_TIME_BUDGET_SECONDS` | `300` | межа часу на запуск |
| `JOBS_RECHECK_HOURS` | `20` | не перевіряти частіше |
| `JOBS_HOST_DELAY_SECONDS` | `2` | пауза між сторінками одного магазину |
| `JOBS_CONCURRENCY` | `4` | скільки магазинів одночасно |
| `BREVO_API_KEY` | — | з Secret Manager (`wishlist-brevo-key`), `xkeysib-…` |
| `VAPID_PRIVATE_KEY` | — | з Secret Manager (`wishlist-vapid-private`), пара до `VITE_VAPID_PUBLIC_KEY` у Vercel |
| `MAIL_FROM` | — | підтверджена в Brevo адреса відправника; вона ж — контакт у підписі VAPID (`mailto:`) |
| `APP_ORIGIN` | — | адреса застосунку для посилань у листах, напр. `https://wishlist-personal.vercel.app` |
