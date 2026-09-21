# Wishlist_personal

[![CI](https://github.com/yozh150991/Wishlist_personal/actions/workflows/ci.yml/badge.svg)](https://github.com/yozh150991/Wishlist_personal/actions/workflows/ci.yml)

Приватні списки бажань з можливістю поділитися вибраними позиціями за секретним посиланням.

Головний список **завжди приватний**. Назовні потрапляє тільки те, що користувач свідомо вибрав і зашерив.

## Стек

| Шар | Технологія |
|---|---|
| Фронтенд | React 18 + Vite + TypeScript, власний CSS без фреймворку (шість палітр токенами), PWA (offline-first) |
| Бекенд даних | Supabase (Postgres + Auth + RLS) |
| Парсер посилань | FastAPI (Python), окремий сервіс |
| Хостинг фронту | Vercel |
| Хостинг парсера | Google Cloud Run (Docker, масштабування до нуля) |
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
| [docs/SETUP.md](./docs/SETUP.md) | Локальне розгортання: репозиторій, Supabase, перевірка RLS |
| [docs/DEPLOY.md](./docs/DEPLOY.md) | Публікація: Vercel, Cloud Run, пошта, перевірка |
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | Компоненти, потоки даних, межі довіри |
| [docs/DATA_MODEL.md](./docs/DATA_MODEL.md) | Таблиці, зв'язки, RLS, індекси |
| [docs/API.md](./docs/API.md) | RPC-функції Supabase та REST парсера |
| [docs/DECISIONS.md](./docs/DECISIONS.md) | ADR — чому обрано саме так |
| [docs/TESTING.md](./docs/TESTING.md) | Стратегія тестування |
| [docs/ROADMAP.md](./docs/ROADMAP.md) | Етапи 1–7 |
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

Етапи 1–6 завершено, застосунок опубліковано:

| Що | Де |
|---|---|
| Фронтенд | `https://wishlist-personal.vercel.app` (Vercel) |
| Парсер | Google Cloud Run, регіон `europe-central2` |
| База й автентифікація | Supabase, регіон Frankfurt |
| Пошта | SMTP через Brevo |

Етап 6 завершено: застосунок встановлюється на телефон, нагадує підбити підсумки після події, вивантажує й приймає списки файлом, читається без мережі та зберігає зроблені офлайн зміни до повернення звʼязку. Див. [docs/ROADMAP.md](./docs/ROADMAP.md).

Етап 7 розпочато — дрібніше, чого бракувало проти інших вішлістів. Готове: ознаки товару (розмір, колір, модель) на картці позиції, видимі гостю (ADR-030).

**Редизайн інтерфейсу** (вересень 2026) — новий вигляд усіх екранів і **три кольорові схеми** × дві теми: Шавлія, Слива, Вугіль. Схема й тема незалежні, вибір власника зберігається в профілі; гість обирає вигляд сам. Контраст усіх шести палітр перевіряється в CI — `npm run check:contrast`, 150 перевірок. Деталі — ADR-031 і [docs/ROADMAP.md](./docs/ROADMAP.md).

Застосовані міграції з цього моменту не редагуються — лише нові файли: база одна, і вона бойова.
