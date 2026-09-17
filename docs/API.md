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
  p_expires_at: null,
});
// → { id, token, title, ... }
// URL для гостя: `${origin}/s/${data.token}`
```
Чужі позиції та позиції з іншого списку мовчки відсіюються (RLS). Порожній масив → помилка `22023`.

### `get_shared_list` — anon + authenticated
```ts
const { data } = await supabase.rpc('get_shared_list', { p_token: token });
```
```jsonc
{
  "title": "Мій день народження",
  "message": null,
  "currency": "PLN",
  "hide_prices": false,
  "allow_reservations": true,
  "viewer_is_owner": false,
  "items": [{
    "id": "…", "title": "Навушники", "url": "https://…",
    "price": "399.00", "quantity": 1, "priority": "high",
    "note": null, "image_url": "https://…", "status": "active",
    "reserved_qty": 1        // null, якщо переглядає власник
  }]
}
```
Помилки (код `P0002`): `not_found`, `revoked`, `expired`. Фронт показує однакову сторінку «Посилання недоступне» для всіх трьох — щоб не підтверджувати існування токена.

Показуються лише позиції зі `status = 'active'`. При `hide_prices: true` поле `price` повертається як `null` — ціна не їде на клієнт узагалі, не ховається стилями.

### `register_share_view` — anon + authenticated
```ts
await supabase.rpc('register_share_view', { p_token: token });
```
Викликати один раз на сесію перегляду. Перегляди власника не рахуються.

### `reserve_item` / `unreserve_item` — anon + authenticated
```ts
const { data: reservedQty } = await supabase.rpc('reserve_item', {
  p_token: token, p_item_id: itemId, p_guest_key: guestKey, p_quantity: 1,
});
```
Повертає нову загальну кількість броні по позиції.
Помилки: `not_found`, `reservations_disabled`, `owner_cannot_reserve`, `item_not_in_share`, `not_enough_left`.

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

### Права на виклик

| Функція | Ролі |
|---|---|
| `create_share`, `list_items_page`, `list_totals` | `authenticated` |
| `get_shared_list`, `register_share_view`, `reserve_item`, `unreserve_item` | `anon`, `authenticated` |
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
  "allowed_origins": ["https://wishlist-personal.vercel.app", "http://localhost:5173"]
}
```
Без автентифікації. `supabase_configured: false` одразу пояснює `500 supabase_not_configured` на `/parse`; `allowed_origins` показує, звідки дозволено CORS. Секретів тут немає, тож відповідь безпечно відкрита.

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
