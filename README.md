# Wishlist_personal

Приватні списки бажань з можливістю поділитися вибраними позиціями за секретним посиланням.

Головний список **завжди приватний**. Назовні потрапляє тільки те, що користувач свідомо вибрав і зашерив.

## Стек

| Шар | Технологія |
|---|---|
| Фронтенд | React 18 + Vite + TypeScript, власний CSS без фреймворку, PWA (offline-first) |
| Бекенд даних | Supabase (Postgres + Auth + RLS) |
| Парсер посилань | FastAPI (Python), окремий сервіс |
| Хостинг фронту | Vercel |
| Хостинг парсера | Google Cloud VM (Docker + nginx) |
| Тести | Playwright + TypeScript |

## Ключові рішення

- Автентифікація: email + пароль, з підтвердженням email.
- Спільний список — **живе посилання**: показує актуальний стан вибраних елементів.
- Гості бронюють подарунки анонімно. **Власник не бачить броней** — це навмисно.
- Ціни й картинки з посилання підтягуються через OpenGraph / schema.org.
- Мови: `uk` (за замовчуванням), `pl`, `en`.

## Документація

| Файл | Про що |
|---|---|
| [CLAUDE.md](./CLAUDE.md) | Правила роботи для AI-агентів. Читати першим. |
| [docs/SETUP.md](./docs/SETUP.md) | Розгортання з нуля: репозиторій, Supabase, перевірка RLS |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Компоненти, потоки даних, межі довіри |
| [docs/DATA_MODEL.md](./docs/DATA_MODEL.md) | Таблиці, зв'язки, RLS, індекси |
| [docs/API.md](./docs/API.md) | RPC-функції Supabase та REST парсера |
| [docs/DECISIONS.md](./docs/DECISIONS.md) | ADR — чому обрано саме так |
| [docs/TESTING.md](./docs/TESTING.md) | Стратегія тестування |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | Етапи 1–6 |
| [CHANGELOG.md](./CHANGELOG.md) | Історія змін |

## Швидкий старт

Перше розгортання — покроково в [docs/SETUP.md](./docs/SETUP.md).

```bash
npm install --save-dev supabase
npx supabase login
npx supabase link --project-ref <project-ref>
npx supabase db push
```

## Статус

Етап 2 з 6 — автентифікація і каркас фронтенду. Див. [docs/ROADMAP.md](./docs/ROADMAP.md).
