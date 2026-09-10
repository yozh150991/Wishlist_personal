# Історія змін

Формат за [Keep a Changelog](https://keepachangelog.com/uk/1.1.0/).

## [Unreleased]

### Додано — 2026-09-09 (Етап 1)
- Набір документації: `README.md`, `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/DATA_MODEL.md`, `docs/API.md`, `docs/DECISIONS.md`, `docs/TESTING.md`, `docs/ROADMAP.md`.
- Міграція `0001_init.sql`: таблиці `profiles`, `lists`, `items`, `shares`, `share_items`, `reservations`; типи `item_status`, `item_priority`, `app_locale`, `app_theme`; тригери створення профілю, синхронізації `owner_id` і `updated_at`.
- Міграція `0002_rls.sql`: RLS на всіх таблицях, повне відкликання прав у `anon`, ізоляція `reservations` від власника.
- Міграція `0003_rpc.sql`: `create_share`, `get_shared_list`, `register_share_view`, `reserve_item`, `unreserve_item`, `list_items_page`, `list_totals`.
- ADR-001 … ADR-012.
- `docs/SETUP.md`: покрокове розгортання, налаштування Auth, шість SQL-перевірок інваріантів RLS, чекліст готовності до етапу 2.
