# Розгортання з нуля

Покроково: від порожньої папки до робочої бази з увімкненим RLS. Час — приблизно година, більшість з неї чекання.

Позначення: 💻 — на твоєму компʼютері, ☁️ — у браузері на сайті сервісу.

---

## 0. Що де живе

| Компонент | Де | Коли зʼявляється |
|---|---|---|
| Код і документація | локальна папка + GitHub `yozh150991/Wishlist_personal` | зараз |
| База, авторизація | Supabase Cloud (регіон Frankfurt) | зараз |
| Фронтенд | локально `app/`, потім Vercel | етап 2 |
| Парсер | локально `services/parser/`, потім GCP VM | етап 4 |

Один репозиторій на все (монорепо). Фронт і парсер — окремі папки в ньому.

---

## 1. 💻 Передумови

| Що | Версія | Перевірка |
|---|---|---|
| Node.js | 20 LTS або 22 | `node -v` |
| Git | будь-яка свіжа | `git --version` |
| Docker Desktop | опційно, для локальної БД | `docker -v` |

Supabase CLI **не** ставимо глобально через npm — це не підтримується. Ставимо в проєкт як devDependency і викликаємо через `npx` (крок 3).

---

## 2. 💻 Репозиторій

```bash
mkdir Wishlist_personal && cd Wishlist_personal
# розпакувати сюди файли етапу 1

git init
git add .
git commit -m "docs: skeleton, schema, RLS, RPC (етап 1)"
```

☁️ Створити на GitHub **приватний** репозиторій `Wishlist_personal` (без README, .gitignore і ліцензії — вони вже є).

```bash
git remote add origin https://github.com/yozh150991/Wishlist_personal.git
git branch -M main
git push -u origin main
```

Структура після цього:
```
Wishlist_personal/
├── README.md
├── CLAUDE.md
├── CHANGELOG.md
├── .env.example
├── .gitignore
├── docs/
└── supabase/migrations/
    ├── 0001_init.sql
    ├── 0002_rls.sql
    └── 0003_rpc.sql
```

---

## 3. ☁️ Проєкт Supabase

1. [supabase.com](https://supabase.com) → **New project**
2. Name: `wishlist-personal`
3. **Region: Central EU (Frankfurt)** — найближчий до Кракова, ~20 мс проти ~120 мс з США
4. Database password — згенерувати і покласти в менеджер паролів. Він знадобиться при `db push` і не показується вдруге.
5. Plan: Free

Ініціалізація займає 2–3 хвилини.

### Де взяти значення

**Project ref** — просто в адресному рядку, коли відкритий проєкт:
```
https://supabase.com/dashboard/project/abcdefghijklmnop
                                       └──── project ref ────┘
```
З нього виводиться **Project URL**: `https://<project-ref>.supabase.co`.

**Ключі** — кнопка **Connect** угорі дашборду (віддає URL і ключ готовим блоком для `.env`), або **Settings → API Keys**. URL окремо також лежить у **Integrations → Data API**.

| Значення | Куди | Секретність |
|---|---|---|
| Project ref | для `supabase link` | публічне |
| Project URL | `VITE_SUPABASE_URL` | публічне |
| Publishable key `sb_publishable_…` | `VITE_SUPABASE_PUBLISHABLE_KEY` | **публічне, це нормально** |
| Secret key `sb_secret_…` | нікуди в цьому проєкті | **ніколи не в код і не в браузер** |

Якщо проєкт створено на старих ключах і ти бачиш кнопку **Create new API keys** — натисни її. Це безпечно: нові ключі додаються поряд зі старими, `anon` і `service_role` продовжують працювати (ADR-013).

Publishable-ключ безпечно віддавати в браузер саме тому, що вся авторизація в RLS: без входу він дає роль `anon`, після входу — `authenticated`, і політики з `0002_rls.sql` застосовуються як є. Secret-ключ має атрибут `BYPASSRLS` і обходить політики повністю — якщо він потрапить у фронтенд, уся модель безпеки проєкту зникає.

---

## 4. 💻 Застосувати міграції

```bash
npm init -y                     # якщо package.json ще нема
npm install --save-dev supabase

npx supabase login              # відкриє браузер
npx supabase link --project-ref <твій-project-ref>
npx supabase db push
```

`db push` застосує 0001 → 0002 → 0003 по порядку і запамʼятає їх у таблиці міграцій. Повторний запуск нічого не зламає — вже застосовані пропускаються.

Очікуваний вивід — три рядки `Applying migration ...` без помилок.

**Якщо впало:** повідомлення покаже файл і рядок. Виправляй у файлі міграції та роби `db push` знову — на цьому етапі, поки БД порожня і в проді нічого нема, редагувати міграції ще можна. Після першого реального користувача — вже ні, тільки нові файли (правило з `CLAUDE.md`).

---

## 5. ☁️ Налаштувати автентифікацію

**Authentication → Sign In / Providers**
- Email — увімкнено
- **Confirm email — увімкнено** (ADR-002)
- Мінімальна довжина пароля — 8
- Перевірка на злиті паролі (HaveIBeenPwned) — увімкнути, вона безкоштовна

**Authentication → URL Configuration**
- Site URL: `http://localhost:5173` (на час розробки; після Vercel — бойовий домен)
- Redirect URLs: `http://localhost:5173/**`

Без цього листи підтвердження вестимуть у нікуди.

**Authentication → Emails** — шаблони поки англійські. Українські й польські версії робимо на етапі 2, коли зʼявляться i18n-ключі. Безкоштовний тариф шле ~3 листи на годину — для розробки достатньо, для релізу треба свій SMTP (Resend, Postmark).

---

## 6. ☁️ Перевірити, що RLS справді працює

**SQL Editor** — це найважливіша перевірка етапу 1. Запусти кожен блок окремо.

Спершу створи двох тестових користувачів через **Authentication → Users → Add user** (обидва з `Auto Confirm`), скопіюй їхні UUID.

```sql
-- A створює список і позицію
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<UUID-A>","role":"authenticated"}';

insert into lists (owner_id, title, currency)
values ('<UUID-A>', 'Тест A', 'PLN') returning id;
-- скопіюй id, підстав нижче
insert into items (list_id, owner_id, title, price)
values ('<LIST-ID>', '<UUID-A>', 'Навушники', 399);

select count(*) from lists;   -- очікуємо 1
commit;
```

```sql
-- B не бачить нічого чужого
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<UUID-B>","role":"authenticated"}';

select count(*) from lists;   -- очікуємо 0, НЕ помилку
select count(*) from items;   -- очікуємо 0
rollback;
```

```sql
-- Гість не має доступу взагалі
begin;
set local role anon;
select * from items;          -- очікуємо: permission denied for table items
rollback;
```

```sql
-- ІНВАРІАНТ: власник не читає броні
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<UUID-A>","role":"authenticated"}';
select * from reservations;   -- очікуємо: permission denied
rollback;
```

```sql
-- Шер і гостьовий доступ
begin;
set local role authenticated;
set local request.jwt.claims = '{"sub":"<UUID-A>","role":"authenticated"}';
select token from create_share('<LIST-ID>', array['<ITEM-ID>']::uuid[], 'Мій ДР');
commit;
```
```sql
-- той самий токен від імені гостя
begin;
set local role anon;
select get_shared_list('<TOKEN>');   -- очікуємо JSON з однією позицією
rollback;
```

Якщо всі шість блоків дали очікуване — фундамент коректний. Якщо якийсь ні, **зупинись і покажи мені вивід**; на цьому не можна будувати далі.

---

## 7. 💻 Локальні змінні оточення

```bash
cp .env.example app/.env.local     # папку app/ створимо на етапі 2
```
Заповнити `VITE_SUPABASE_URL` і `VITE_SUPABASE_PUBLISHABLE_KEY`. Файл уже в `.gitignore` — перевір `git status`, його не має бути серед відстежуваних.

---

## 8. 💻 Локальна база (опційно, знадобиться на етапі 3)

Потрібен запущений Docker.

```bash
npx supabase start     # перший запуск тягне образи, 5–10 хв
npx supabase db reset  # накатує міграції + seed.sql з нуля
```
Дає власний Postgres на `localhost:54322` і Studio на `localhost:54323`. Потрібно для pgTAP-тестів і щоб експериментувати зі схемою, не чіпаючи хмару.

`supabase stop` зупиняє контейнери.

---

## 9. Як користуватися цим репозиторієм з AI-агентами

Сенс `.md`-документації — щоб агент у новій сесії не переспитував базові речі.

**Claude Code / Cowork:** `CLAUDE.md` у корені підхоплюється автоматично.

**Чат:** на початку сесії дай `CLAUDE.md` + файл, релевантний задачі (`DATA_MODEL.md` для схеми, `API.md` для інтеграцій). Не завантажуй усе — витрачає контекст без користі.

Робочий цикл на кожній задачі:
1. Агент читає `CLAUDE.md` і релевантний документ
2. Пише код
3. **У тому ж коміті** оновлює документ і `CHANGELOG.md`
4. Нетривіальне рішення → новий ADR у `DECISIONS.md`

Якщо агент пропонує щось, що суперечить інваріантам з `CLAUDE.md §3` (наприклад «додамо власнику панель броней») — це сигнал, що він не прочитав файл. Вкажи на розділ і попроси перечитати.

---

## Чекліст готовності до етапу 2

- [ ] Репозиторій на GitHub, перший коміт запушено
- [ ] Проєкт Supabase у Frankfurt створено
- [ ] `npx supabase db push` пройшов без помилок
- [ ] Confirm email увімкнено, Site URL і Redirect URLs заповнено
- [ ] Усі шість перевірок з розділу 6 дали очікуваний результат
- [ ] `.env.local` заповнено і **не** відстежується git
