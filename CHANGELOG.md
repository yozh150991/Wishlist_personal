# Історія змін

Формат за [Keep a Changelog](https://keepachangelog.com/uk/1.1.0/).

## [Unreleased]

### Додано — 2026-09-11 (Етап 2)
- `scripts/place-files.ps1`: розкладає завантажені пласким списком файли по папках репозиторію, підтримує `-WhatIf` і повідомляє, чого бракує. Код і повідомлення лише ASCII — Windows PowerShell 5.1 читає `.ps1` у системному кодуванні й ламається на кирилиці без BOM.
- Каркас фронтенду: Vite + React 18 + TypeScript у строгому режимі, збірка і перевірка типів проходять чисто.
- Дизайн-система у `src/styles.css`: токени кольору, шкала розмірів 1.25, радіус за рівнем ієрархії; світла, темна і системна теми без спалаху при завантаженні. ADR-015.
- Шрифти Commissioner і Source Serif 4 самохостяться через `@fontsource-variable`; підмножини `cyrillic` і `latin-ext` покривають українську й польську.
- i18n на власному провайдері без зовнішніх залежностей: uk / pl / en, визначення мови з localStorage і `navigator.languages`, запасна мова — українська.
- Сторінки `/login`, `/register`, `/reset`, `/update-password`; помилки Supabase перекладаються за кодом, а не за текстом повідомлення.
- `RequireAuth` показує скелетон, поки завантажується сесія, і зберігає початковий шлях у `?next=`. ADR-016.
- Каркас застосунку, порожній `/lists`, сторінка налаштувань із вибором теми і мови.
- Playwright: шість сценаріїв навігації та захисту роутів, профілі Desktop Chrome і Pixel 7.

### Додано — 2026-09-09 (Етап 1)
- Набір документації: `README.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/API.md`, `docs/DECISIONS.md`, `docs/TESTING.md`, `docs/ROADMAP.md`.
- Міграція `0001_init.sql`: таблиці `profiles`, `lists`, `items`, `shares`, `share_items`, `reservations`; типи `item_status`, `item_priority`, `app_locale`, `app_theme`; тригери створення профілю, синхронізації `owner_id` і `updated_at`.
- Міграція `0002_rls.sql`: RLS на всіх таблицях, повне відкликання прав у `anon`, ізоляція `reservations` від власника.
- Міграція `0003_rpc.sql`: `create_share`, `get_shared_list`, `register_share_view`, `reserve_item`, `unreserve_item`, `list_items_page`, `list_totals`.
- ADR-001 … ADR-012.
### Безпека — 2026-09-10
- Міграція `20260910120300_grants.sql`: відкликано неявний `EXECUTE` ролі `PUBLIC` на всі RPC. Функції власника (`create_share`, `list_items_page`, `list_totals`) тепер доступні лише ролі `authenticated`, `gen_share_token` — нікому ззовні, гостьові функції — явно `anon, authenticated`.

### Виправлено — 2026-09-10
- `gen_share_token()` більше не залежить від pgcrypto: джерело випадковості — `gen_random_uuid()` з ядра Postgres. Раніше міграція падала з `function gen_random_bytes(integer) does not exist`, бо в Supabase pgcrypto лежить у схемі `extensions`. ADR-014.
- Міграції перейменовано у формат Supabase CLI `<timestamp>_name.sql`: `20260910120000_init`, `20260910120100_rls`, `20260910120200_rpc`. Попередні імена `0001_*` CLI ігнорував без повідомлення, через що `db push` рапортував `Remote database is up to date` на порожній базі.
- `docs/SETUP.md`: додано пропущений крок `supabase init` і обовʼязкову перевірку `migration list` перед `db push`.
- `CLAUDE.md`: уточнено конвенцію іменування міграцій.

### Змінено — 2026-09-10
- `.env.example`, `docs/SETUP.md`: перехід на publishable-ключ Supabase (`VITE_SUPABASE_PUBLISHABLE_KEY`) замість `anon`; уточнено, де в дашборді брати project ref, URL і ключі. ADR-013.

### Додано — 2026-09-09 (продовження)
- `docs/SETUP.md`: покрокове розгортання, налаштування Auth, шість SQL-перевірок інваріантів RLS, чекліст готовності до етапу 2.
