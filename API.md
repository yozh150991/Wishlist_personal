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

## Звичайні запити (через RLS)

CRUD списків і позицій — прямо через PostgREST, RLS усе відсіює:
```ts
await supabase.from('items').insert({ list_id, title, url, price });
await supabase.from('items').update({ status: 'gifted' }).eq('id', id);
await supabase.from('shares').update({ revoked_at: new Date().toISOString() }).eq('id', shareId);
```

---

## Parser service (FastAPI)

Base URL: `PARSER_URL` (env). Автентифікація: `Authorization: Bearer <supabase access token>` — сервіс перевіряє підпис JWT через JWKS Supabase.

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
| `400 invalid_url` | не http/https, некоректний URL |
| `403 blocked_host` | приватна мережа, localhost, метадані хмари |
| `413 too_large` | сторінка > 2 МБ |
| `422 unsupported_content` | не HTML |
| `429 rate_limited` | > 20 запитів/хв на користувача |
| `504 upstream_timeout` | магазин не відповів за 8 с |

### `GET /health`
`{ "status": "ok", "version": "0.1.0" }`

### Порядок витягу даних
1. JSON-LD `schema.org/Product` → `name`, `offers.price`, `offers.priceCurrency`, `image`
2. Microdata `itemprop`
3. OpenGraph: `og:title`, `og:image`, `product:price:amount`, `product:price:currency`
4. Twitter Card
5. `<title>` як остання надія для назви

Перше знайдене значення виграє; джерело пишеться в `confidence`.

### Безпека (SSRF)
- Резолв DNS **до** запиту; блокування `127.0.0.0/8`, `10/8`, `172.16/12`, `192.168/16`, `169.254/16` (метадані GCP!), `::1`, `fc00::/7`.
- Повторна перевірка після кожного редіректу, максимум 3 редіректи.
- Заборона схем, крім `http`/`https`.
- Читання потоком із жорстким лімітом 2 МБ.
- Кеш відповідей 15 хв за нормалізованим URL.
