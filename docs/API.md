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
| `gen_share_token` | внутрішня, ззовні недоступна |

Неявний `EXECUTE` ролі `PUBLIC` відкликано міграцією `20260910120300_grants.sql`. Кожна нова RPC-функція має отримувати гранти явно — інакше вона автоматично стане анонімним ендпоінтом PostgREST.

## Звичайні запити (через RLS)

CRUD списків і позицій — прямо через PostgREST, RLS усе відсіює:
```ts
await supabase.from('items').insert({ list_id, title, url, price });
await supabase.from('items').update({ status: 'gifted' }).eq('id', id);
await supabase.from('shares').update({ revoked_at: new Date().toISOString() }).eq('id', shareId);
```

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
| `401 invalid_token` | токен неправильної форми або Supabase його не прийняв |
| `400 invalid_url` | не http/https, некоректний URL |
| `403 blocked_host` | приватна мережа, localhost, метадані хмари |
| `422 unsupported_content` | не HTML |
| `429 rate_limited` | > 20 запитів/хв на користувача |
| `504 upstream_timeout` | магазин не відповів за 8 с |
| `503 auth_unavailable` | Supabase недоступний, токен перевірити нічим |

Код помилки приходить у полі `detail`. Клієнт зіставляє його з ключем словника, тому текст лишається перекладним.

### `GET /health`
`{ "status": "ok", "version": "0.1.0" }`

### Магазини з антибот-захистом

Allegro, Amazon, OLX та інші великі майданчики відмовляють запитам, що не схожі на справжній браузер: перевіряють виконання JS, cookies, TLS-відбиток. Універсальний парсер їх не проходить, і це не налаштовується.

Такі відповіді (401, 403, 405, 429) повертаються окремим кодом `upstream_forbidden`, щоб інтерфейс міг сказати «магазин блокує автоматичні запити», а не «щось зламалось». Посилання при цьому зберігається — втрачається лише автозаповнення.

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
- Резолв DNS **до** запиту; відмова, якщо хоча б одна з відповідей DNS — приватна адреса. Блокуються `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (метадані GCP!), `::1`, `fc00::/7`, multicast і зарезервовані діапазони.
- Редиректи обробляються вручну, кожен новий URL проходить ту саму перевірку, максимум 3 переходи.
- Лишається вузьке вікно між резолвом і підключенням, у якому DNS може змінити відповідь. Закрити його повністю можна лише підключенням до вже перевіреної IP з підміною заголовка `Host`; поки цього немає — ризик прийнятий свідомо і задокументований тут.
- Заборона схем, крім `http`/`https`.
- Читання потоком із лімітом 5 МБ. Понад ліміт сторінка не відхиляється, а обрізається: мета-теги лежать у `<head>`, тож прочитаного зазвичай достатньо.
- Кеш відповідей 15 хв за нормалізованим URL.
