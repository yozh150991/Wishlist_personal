# Публікація

Від локального застосунку до адреси, яку можна надіслати рідним. Приблизно дві години, більшість із них — очікування.

Порядок важливий: адреси взаємозалежні, і якщо йти не по черзі, доведеться повертатись і перенастроювати.

```
1. Фронтенд на Vercel        -> отримуємо адресу застосунку
2. Парсер на Cloud Run       -> дозволяємо їй звертатись до парсера
3. Vercel: адреса парсера    -> перезбірка
4. Supabase: адреси листів
5. Пошта для листів
6. Перевірка
...
9. Фонові задачі (wishlist-jobs) -> щоденна перевірка посилань (ADR-048)
```

---

## 0. Що знадобиться

| Що | Навіщо | Ціна |
|---|---|---|
| Акаунт GitHub | репозиторій уже є | — |
| Акаунт Vercel | фронтенд | безкоштовно |
| Акаунт Google Cloud | парсер на Cloud Run | безкоштовний рівень, потрібна платіжна картка |
| `gcloud` CLI | деплой парсера | — |

Про картку в Google Cloud: вона потрібна для активації, але Cloud Run має постійний безкоштовний рівень, і парсер, який викликають кілька разів на день, у нього вкладається з великим запасом. Щоб спати спокійно, у кроці 2 стоїть обмеження на кількість інстансів і бюджетне сповіщення.

**Домен не потрібен.** Vercel дасть адресу виду `wishlist-personal.vercel.app` із сертифікатом. Свій домен можна причепити будь-коли пізніше, без переїзду.

Перед початком переконайся, що все запушено:

```powershell
git status          # має бути чисто
git push
```

---

## 1. Фронтенд на Vercel

1. [vercel.com](https://vercel.com) → увійти через GitHub.
2. **Add New → Project** → вибрати репозиторій `Wishlist_personal`.
3. **Root Directory** → `app`. Це головне: фронтенд лежить не в корені репозиторію.
   Framework, команду збірки і теку виводу Vercel візьме з `app/vercel.json`.
4. **Environment Variables** — додати два рядки:

   | Name | Value |
   |---|---|
   | `VITE_SUPABASE_URL` | `https://<project-ref>.supabase.co` |
   | `VITE_SUPABASE_PUBLISHABLE_KEY` | `sb_publishable_...` |

   `VITE_PARSER_URL` і `VITE_PUBLIC_ORIGIN` поки **не** додаємо — перший зʼявиться в кроці 3, другий не потрібен взагалі, бо код бере адресу з браузера.
5. **Deploy**. Через хвилину-дві отримаєш адресу. Запиши її — вона знадобиться далі.

Відкрий адресу: має перекинути на `/login`. Увійти ще не вийде, листи ведуть на `localhost` — це полагодимо в кроці 4.

**Чому потрібен `vercel.json`.** Застосунок — односторінковий: усі шляхи обробляє браузер. Без правила перезапису пряме відкриття `/s/<токен>` дало б 404, бо такого файлу на сервері немає. Заразом там вимкнено індексацію гостьових сторінок пошуковиками: секретні посилання не мають потрапляти в Google.

---

## 2. Парсер на Google Cloud Run

Чому саме він: Docker без переробок, масштабування до нуля (не працює — не витрачає), HTTPS одразу, регіон Варшава. Fly.io безкоштовний рівень скасував, Render на безкоштовному тарифі засинає і прокидається 30–60 секунд — для кнопки «Заповнити» це неприйнятно.

### 2.1. Підготовка

Встанови [gcloud CLI](https://cloud.google.com/sdk/docs/install), потім:

```powershell
gcloud auth login
gcloud projects create wishlist-parser-<щось-унікальне>
gcloud config set project wishlist-parser-<щось-унікальне>
```

Увімкни оплату для проєкту через консоль (Billing → Link a billing account) і потрібні служби:

```powershell
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

### 2.2. Деплой

З теки `services\parser`:

```powershell
gcloud run deploy wishlist-parser `
  --source . `
  --region europe-central2 `
  --allow-unauthenticated `
  --memory 256Mi `
  --cpu 1 `
  --min-instances 0 `
  --max-instances 2 `
  --concurrency 20 `
  --timeout 30s `
  --set-env-vars "SUPABASE_URL=https://<project-ref>.supabase.co,SUPABASE_PUBLISHABLE_KEY=sb_publishable_...,PARSER_ALLOWED_ORIGINS=https://<твоя-адреса>.vercel.app"
```

`europe-central2` — Варшава, найближчий регіон.

**`--allow-unauthenticated` тут не дірка.** Вона знімає перевірку від самого Google, бо звертатись до сервісу має браузер користувача, а не інша служба GCP. Свою автентифікацію парсер робить сам: кожен запит має нести дійсний токен Supabase (ADR-018).

**`--max-instances 2`** — страховка від рахунку. Навіть якщо хтось почне бомбардувати сервіс запитами, більше двох копій не запуститься.

Перша збірка триває 3–5 хвилин. У кінці отримаєш адресу виду `https://wishlist-parser-xxxxx.europe-central2.run.app`.

### 2.3. Перевірка

```powershell
curl.exe https://wishlist-parser-xxxxx.europe-central2.run.app/health
```

Очікуємо `"supabase_configured":true` і свою адресу Vercel у `allowed_origins`.

### 2.4. Бюджетне сповіщення

Billing → Budgets & alerts → Create budget на 1 євро з оповіщенням на 50%. Так ти дізнаєшся про несподіванку з листа, а не з рахунку.

---

## 3. Повернутись у Vercel і додати адресу парсера

Settings → Environment Variables → додати:

| Name | Value |
|---|---|
| `VITE_PARSER_URL` | `https://wishlist-parser-xxxxx.europe-central2.run.app` |

Далі **Deployments → останній → Redeploy**. Змінні `VITE_*` вшиваються у файли під час збірки, тож без перезбірки нова адреса нікуди не потрапить.

---

## 4. Supabase: адреси для листів

Authentication → URL Configuration:

- **Site URL**: `https://<твоя-адреса>.vercel.app`
- **Redirect URLs**: `https://<твоя-адреса>.vercel.app/**`

Локальну адресу `http://localhost:5173/**` лиши в списку другим рядком — інакше зламається розробка.

Без цього кроку посилання в листах підтвердження й скидання пароля вестимуть на `localhost`, тобто в нікуди для всіх, крім тебе.

Адреси повернення несуть версію дизайну: `…/lists?design=v1`, `…/login?design=v2&from=confirm`, `…/update-password?design=v2` (ADR-039, п. 5). Шаблон із `/**` пропускає їх разом із параметрами. Якщо колись заміниш його точними адресами — підтвердження й скидання пароля мовчки поведуть на Site URL.

### 4.1. Вхід через Google (дизайн v2)

Кнопка «Продовжити з Google» є лише на екранах входу й реєстрації v2 і з'являється тільки тоді, коли у Vercel стоїть `VITE_AUTH_GOOGLE=1`. Спершу провайдер, потім змінна: кнопка, що веде на «provider is not enabled», гірша за відсутню.

1. **Google Cloud Console** (той самий проєкт, що й для парсера, або окремий) → **APIs & Services → OAuth consent screen**: тип *External*, назва застосунку, пошта підтримки. Досить базових доступів `openid`, `email`, `profile`. Поки застосунок у статусі *Testing*, увійти зможуть лише додані тестові користувачі — для рідних або додай їхні адреси, або переведи застосунок у *Production*.
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**: тип *Web application*. У **Authorized redirect URIs** — рівно одна адреса: `https://<project-ref>.supabase.co/auth/v1/callback`. Google повертає людину до Supabase, а вже Supabase — у застосунок за Redirect URLs з розділу 4.
3. **Supabase → Authentication → Sign In / Providers → Google**: увімкнути, вставити *Client ID* і *Client Secret*, зберегти. Секрет живе лише тут — ні в репозиторії, ні у Vercel його немає.
4. **Vercel → Settings → Environment Variables**: `VITE_AUTH_GOOGLE` = `1`, далі **Redeploy** — змінні `VITE_*` вшиваються під час збірки.

Хто зареєструвався через Google, пароля не має: у v1, де кнопки Google немає, він увійде лише через «Забув пароль» (ADR-039, п. 7). Apple — окремим рішенням: для нього потрібен платний Apple Developer Program.

---

## 5. Пошта

Вбудований відправник Supabase шле близько трьох листів на годину і тільки на адреси, повʼязані з проєктом. Для тебе одного вистачало, для сімʼї — ні.

Є два шляхи, і для вішліста на 3–5 людей другий чесніше.

### Варіант А: створити акаунти вручну

Authentication → Users → **Add user**, обовʼязково з `Auto Confirm`. Задаєш пошту й тимчасовий пароль, передаєш людині особисто. Жодних листів, жодного SMTP.

Підходить, якщо коло користувачів закрите й ти знаєш усіх поіменно. Мінус — скидання пароля без пошти теж не працюватиме, доведеться міняти вручну.

### Варіант Б: свій SMTP

Для довільної реєстрації потрібен зовнішній відправник. Важливий нюанс: Resend і Postmark вимагають підтвердженого **домену**, якого в тебе немає. Brevo дозволяє підтвердити окрему **адресу** відправника — саме тому раджу його (ADR-022).

1. Зареєструватись у Brevo. **Settings → Senders, domains, IPs → Senders**: додати свою адресу як відправника і підтвердити її кодом з листа.
2. **Settings → SMTP & API → SMTP**: створити SMTP-ключ. Brevo показує його повністю **лише один раз** — одразу скопіюй. Якщо не встиг, створи новий, а старий видали.
3. **Settings → Security → Authorized IPs**: вимкнути блокування невідомих IP. Supabase надсилає листи зі своїх серверів, адреси яких не можна внести в список наперед. Без цього кроку все налаштовано правильно, а листи мовчки не йдуть.
4. Вимкнути відстеження кліків і відкриттів для транзакційних листів (розділ **Transactional → Settings**, пункти зі словом *tracking*). Інакше Brevo обгортає посилання в листах своїм редиректом, і одноразовий токен входу проходить через сторонній сервер.
5. Supabase → **Authentication → Emails → SMTP Settings** → увімкнути Custom SMTP:

   | Поле в Supabase | Звідки взяти |
   |---|---|
   | Sender email | адреса з кроку 1 — та, біля якої в Brevo стоїть позначка підтвердження |
   | Sender name | `Wishlist` |
   | Host | `smtp-relay.brevo.com` |
   | Port | `587` |
   | Username | поле **Login** на сторінці SMTP у Brevo, виду `xxxxxxx@smtp-brevo.com` |
   | Password | SMTP-ключ із кроку 2 |

   Найчастіша плутанина: `…@smtp-brevo.com` — це **логін**, його місце в Username, а не в Sender email. Назва ключа в Brevo (наприклад, «Wishlist») логіном не є.

6. Перевірити доставку: зареєструватись на бойовій адресі новою поштою. Зручно взяти свою Gmail з плюсом — `адреса+test1@gmail.com`: Supabase вважає її новою, а лист прийде в звичайну скриньку. Перевірити «Вхідні» і «Спам», потім натиснути посилання — воно має відкрити бойову адресу.

**Що побачать рідні.** Відправник виглядатиме як `адреса@<число>.brevosend.com`: Gmail не дозволяє стороннім серверам слати від імені `@gmail.com`, тож Brevo підставляє свій домен, а справжню адресу кладе в «відповісти». Попередь рідних, що лист може бути в «Спамі».

**Якщо лист не прийшов:**
- Brevo → **Transactional → Logs**: лист є — Brevo його прийняв, дивись спам і фільтри пошти.
- Supabase → **Logs → Auth**: `authentication failed` — неправильні Username або Password; згадка про IP — не вимкнено крок 3.
- Supabase → **Authentication → Rate Limits**: із власним SMTP діє окремий ліміт листів на годину. При частих тестах поспіль листи перестають іти саме через нього.
- Brevo додає до листів посилання «Скасувати підписку». Натиснувши його, людина потрапляє в список блокування Brevo і більше не отримає навіть скидання пароля. На скаргу «лист не приходить» — перевір контакти в блокуванні.

### Шаблони листів мовою користувача

Шаблони лежать у `supabase/templates/` і містять усі три мови застосунку. Яку показати, шаблон вирішує сам за `user_metadata.locale` (ADR-024):

- мова відома (`uk`, `pl` або `en`) — лист лише цією мовою;
- мова невідома — лист усіма трьома: українською, польською, англійською.

Мову в `user_metadata` записує застосунок: при реєстрації — мову, обрану на екрані реєстрації, а далі — щоразу, коли мова інтерфейсу відрізняється від збереженої. Хто зареєструвався до цієї зміни, отримає мову після першого входу; до того листи прийдуть усіма трьома мовами. Запрошені з дашборду користувачі мови не мають, тож лист запрошення завжди тримовний.

Бойовий проєкт файли з репозиторію **не** читає — текст копіюється в дашборд вручну. Supabase → **Authentication → Emails → Templates**. Для кожного: вибрати вкладку, вставити тему, у полі тіла замінити весь вміст на вміст файлу, **Save**.

| Вкладка в дашборді | Тема | Файл |
|---|---|---|
| Confirm sign up | `Підтверди пошту · Potwierdź e-mail · Confirm your email — Wishlist` | `confirmation.html` |
| Reset password | `Новий пароль · Nowe hasło · New password — Wishlist` | `recovery.html` |
| Invite user | `Запрошення · Zaproszenie · Invitation — Wishlist` | `invite.html` |

Тема лишається тримовною: тіло шаблону точно обробляється як Go-шаблон, а для теми це не перевірено.

Сповіщення про зміну пароля вимкнене за замовчуванням. Воно корисне: якщо хтось скине пароль замість власника, власник дізнається. У тому ж меню Emails, у розділі сповіщень безпеки, увімкнути **Password changed** з темою `Пароль змінено · Hasło zmienione · Password changed — Wishlist` і файлом `password_changed.html`. Кнопка в ньому веде на `{{ .SiteURL }}/reset`, тож Site URL з кроку 4 має бути бойовою адресою.

Шаблони «Magic link», «Change email address» і «Reauthentication» застосунок не використовує: входу за посиланням, зміни пошти й повторної автентифікації в ньому немає. Їх можна лишити англійськими.

**Що важливо в текстах.** Застосунок використовує PKCE: після переходу за посиланням сесія створюється лише в тому браузері, де починалась дія. Звідси дві примітки в листах:
- підтвердження реєстрації на іншому пристрої спрацює — пошта підтвердиться, але увійти доведеться паролем;
- скидання пароля на іншому пристрої не спрацює взагалі, тому лист прямо просить відкрити його там само, звідки був запит.

Листи кажуть, що посилання діє годину. Це значення за замовчуванням (**Authentication → Sign In / Providers → Email → Email OTP Expiration**, 3600 с); якщо його змінити — виправ і текст у шаблонах.

Запрошений користувач створюється без пароля. Лист запрошення тому одразу пояснює, як його задати через «Забув пароль». Для рідних звичайна реєстрація простіша за запрошення.

**Перевірка мов.** Шаблони перевірено рендером Go `html/template` для `uk`, `pl`, `en`, відсутньої і незнайомої мови. На бойовому проєкті:
1. Відкрити `/register`, перемкнути мову кнопкою **PL** угорі праворуч і зареєструвати адресу з плюсом — лист має прийти лише польською.
2. Для свого акаунта: увійти, перемкнути мову в налаштуваннях на англійську, вийти й скинути пароль — лист англійською.
3. Supabase → **Authentication → Users** → користувач → **Raw user meta data** має показувати `"locale"`.

---

## 6. Перевірка після публікації

Пройди в такому порядку, з телефона, а не з компʼютера — рідні відкриватимуть саме так.

- [ ] `https://<адреса>.vercel.app` відкривається, перекидає на `/login`
- [ ] Реєстрація новою адресою, лист приходить, посилання веде на бойову адресу
- [ ] Після входу F5 на `/lists` не викидає на вхід
- [ ] Створення списку й позиції
- [ ] Кнопка «Заповнити» працює на посиланні з IKEA
- [ ] Створення посилання, копіювання
- [ ] Посилання відкривається в режимі інкогніто, видно лише вибрані позиції
- [ ] Бронювання гостем працює
- [ ] Те саме посилання у твоєму вікні показує банер власника і жодної броні
- [ ] Відкликане посилання перестає відкриватись
- [ ] Встановлення на телефон: Android — меню Chrome «Встановити застосунок» або кнопка в налаштуваннях; iPhone — Safari, «Поділитися» → «На початковий екран». Застосунок відкривається з іконки без рядка браузера
- [ ] Режим польоту: встановлений застосунок відкривається й показує «Немає зʼєднання», а не білий екран

Перевірка SSRF на бойовому парсері — обовʼязково.

**Спершу — справжній токен.** Буквальний текст `<токен>` у заголовку нічого не перевіряє: запит відхиляється на автентифікації (`401 invalid_token`) і до SSRF-фільтра не доходить. Токен береться з браузера, де ти увійшов у застосунок: F12 → Console:

```js
copy(JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token')))).access_token)
```

Токен скопіюється в буфер. Діє приблизно годину. Не вставляй його в чати й на скріншоти — це твій вхід.

**Три запити.** `-i` показує код відповіді:

```powershell
$api = "https://wishlist-parser-xxxxx.europe-central2.run.app/parse"
$token = "встав_сюди_токен"

# 1. Без токена — очікуємо 401 missing_token
curl.exe -i -X POST $api -H "content-type: application/json" `
  -d '{\"url\":\"https://www.ikea.com/pl/pl/\"}'

# 2. Контрольний: справжній магазин — очікуємо 200
curl.exe -i -X POST $api -H "authorization: Bearer $token" -H "content-type: application/json" `
  -d '{\"url\":\"https://www.ikea.com/pl/pl/\"}'

# 3. SSRF — очікуємо 403 blocked_host
curl.exe -i -X POST $api -H "authorization: Bearer $token" -H "content-type: application/json" `
  -d '{\"url\":\"http://169.254.169.254/computeMetadata/v1/\"}'
```

Другий запит доводить, що токен дійсний, і лише тоді третій щось означає.

- Третій дав `403` з `blocked_host` у тілі — захист працює.
- Будь-що інше при `200` на другому — **видали сервіс негайно**: за цією адресою в Google Cloud лежать токени сервісного акаунта.

```powershell
gcloud run services delete wishlist-parser --region europe-central2
```

Логи парсера, якщо щось незрозуміло:

```powershell
gcloud run services logs read wishlist-parser --region europe-central2 --limit 30
```

## 7. Як оновлювати далі

**Фронтенд.** `git push` у `main` — Vercel збирає сам. Гілки дають попередні збірки на окремих адресах; щоб вхід на них працював, додай `https://*.vercel.app/**` у Redirect URLs Supabase.

**Парсер.** `git push` його не чіпає: новий код парсера доходить до людей лише після деплою з твого комп'ютера. Деплой бере файли з робочої копії, а не з GitHub — тобто ту гілку й той стан, які зараз на диску.

1. Робоча копія — з потрібним кодом. З кореня репозиторію:
   ```powershell
   git status              # чисто, без незакомічених змін
   git log --oneline -1    # останній коміт — той, що деплоїш
   ```
2. Той самий проєкт GCP, що й під час першого деплою:
   ```powershell
   gcloud config get-value project          # wishlist-parser-<…>
   ```
3. Деплой — лише назва, джерело й регіон:
   ```powershell
   cd services\parser
   gcloud run deploy wishlist-parser --source . --region europe-central2
   cd ..\..
   ```
   Решта налаштувань зберігається з першого деплою (розділ 2.2): змінні оточення, пам'ять, `--max-instances`, відкритий доступ. **Команду з 2.2 цілком не повторюй**: `--set-env-vars` спершу стирає всі наявні змінні й лишає тільки перелічені. Змінити одну змінну — `gcloud run services update wishlist-parser --region europe-central2 --update-env-vars KEY=VALUE`.
   Збірка — 3–5 хвилин. Нова ревізія отримує весь трафік, щойно стартує; до того відповідає стара.
4. Перевірка:
   ```powershell
   $PARSER_URL = gcloud run services describe wishlist-parser --region europe-central2 --format="value(status.url)"
   curl.exe "$PARSER_URL/health"
   ```
   Очікуємо `"supabase_configured":true`, свою адресу Vercel в `allowed_origins` і `"secret_key_present":false`. Потім у застосунку — «Заповнити» на будь-якому посиланні.
5. Якщо нова ревізія зламалась — повернути попередню:
   ```powershell
   gcloud run revisions list --service wishlist-parser --region europe-central2
   gcloud run services update-traffic wishlist-parser --region europe-central2 --to-revisions wishlist-parser-000NN-xxx=100
   ```
   Поки трафік прикутий до ревізії, нові деплої його не отримують. Після виправлення й нового деплою поверни звичайний режим: `gcloud run services update-traffic wishlist-parser --region europe-central2 --to-latest`.

Порядок відносно фронтенду й міграцій: парсер ні від того, ні від іншого не залежить, доки відповідь `/parse` не міняє форми. Зміна, що міняє форму відповіді, — окремий випадок, і про нього скаже CHANGELOG.

**Сервіс задач `wishlist-jobs`** збирається з того самого коду, тож після змін у `services/parser` його теж передеплоїти — так само, як парсер, лише назва інша (розділ 9.4):
```powershell
cd services\parser
gcloud run deploy wishlist-jobs --source . --region europe-central2
```
Закритий доступ, обліковий запис, змінні й секрет зберігаються. Поки сервіс не створено за розділом 9, цей крок пропускаєш.

**База.** `npx supabase db push` як і раніше. Міграції накочуються на той самий проєкт Supabase — окремої бойової бази в нас немає, і для особистого застосунку це нормально. Але з цього моменту редагувати вже застосовані міграції не можна: тільки нові файли.

**Міграція, що міняє гостьові RPC, — разом із фронтендом.** `20260928110000_guest_keys_and_claims.sql` видаляє `reserve_item` / `unreserve_item` і змінює сигнатуру `get_shared_list` (ADR-035). Між `db push` і деплоєм фронтенду гості бачитимуть помилку бронювання, тож порядок такий: злити PR у `main`, дочекатися збірки Vercel (хвилина-дві) і одразу `npx supabase db push`. Гостьові сторінки Service Worker не кешує, тож гості отримують новий код першим же відкриттям.

**Оновлення дизайну від 28 вересня — пʼять міграцій одним `db push`** (`20260928090000` … `20260928130000`, ADR-033–037), у тому ж порядку: спершу збірка Vercel, одразу за нею `npx supabase db push`. Поки міграцій немає, новий фронтенд не знаходить `sections`, `claims` і нових колонок — частина дій (розділи, позначки гостей, збереження позиції) відмовлятиме; хвилина-дві — прийнятно, година — ні. `20260928130000_share_expiry_zone.sql` міняє сигнатуру `create_share`, але лишає старий параметр `p_expires_at` — вкладки зі старою версією застосунку й далі створюють посилання, а новий фронтенд на старій базі повторює запит по-старому (ADR-037).

---

## 8. Захист гілки `main`

Мета: у бойову версію потрапляє лише те, що пройшло CI. Vercel збирає `main`, тож досить заборонити в `main` усе, крім pull request із зеленими перевірками.

**Спершу** CI має хоча б раз успішно пройти на GitHub: GitHub пропонує в налаштуваннях лише ті перевірки, які вже бачив.

**Обмеження безкоштовного тарифу.** Правила працюють для публічного репозиторію. Якщо зробити його приватним на тарифі Free, правило лишиться в налаштуваннях, але GitHub перестане його застосовувати — і захист мовчки зникне.

### Налаштування

GitHub → репозиторій → **Settings → Rules → Rulesets → New ruleset → New branch ruleset**:

| Поле | Значення |
|---|---|
| Ruleset name | `protect-main` |
| Enforcement status | **Active** |
| Bypass list | порожній — інакше правило не діє на власника |
| Target branches → Add target | **Include default branch** |
| Restrict deletions | ✓ |
| Block force pushes | ✓ |
| Require a pull request before merging | ✓, **Required approvals: 0** — схвалювати свій PR нікому |
| Require status checks to pass | ✓, додати три перевірки нижче |

Перевірки (**Add checks**, пошук за назвою):
- `Frontend · typecheck і build`
- `Parser · pytest`
- `Database · pgTAP і Playwright`

«Require branches to be up to date before merging» для одного розробника не потрібне — лише додає зайвий перезапуск CI.

**Create.**

### Як тепер працювати

```powershell
git switch -c fix/short-name          # нова гілка від main
# ...зміни...
git add -A
git commit -m "fix: ..."
git push -u origin fix/short-name
```

GitHub покаже посилання **Compare & pull request** — створити PR. Коли три перевірки зелені, **Merge pull request** → **Delete branch**. Потім локально:

```powershell
git switch main
git pull
git branch -d fix/short-name
```

Vercel збирає кожну гілку на окремій адресі — PR можна перевірити в браузері ще до злиття. Щоб на такій адресі працював вхід, у Supabase → Authentication → URL Configuration → Redirect URLs має бути `https://*.vercel.app/**` (розділ 7).

Якщо спробувати `git push` прямо в `main`, GitHub відмовить із `GH013: Repository rule violations`. Це правило працює, а не зламалось.

---

## 9. Фонові задачі: сервіс `wishlist-jobs` (ADR-048)

Задачі без людини — поки одна: щоденна перевірка посилань на товар («Сторінки немає», «Немає в наявності», «Ціна змінилась»). Далі тут з'являться сповіщення й листи гостям (ROADMAP, 4г-2 і крок 5).

Як це влаштовано:

```
Cloud Scheduler — щодня о 04:15 за Варшавою
   │  POST /jobs/check-links з ID-токеном облікового запису wishlist-scheduler
   ▼
wishlist-jobs — Cloud Run, ЗАКРИТИЙ (без --allow-unauthenticated)
   │  той самий код, що й парсер, але APP_MODULE=app.jobs_main:app
   │  secret-ключ Supabase — із Secret Manager, читає лише обліковий запис wishlist-jobs
   ▼
Supabase — пише лише поля перевірки в items (link_status, link_checked_at, link_price, link_currency)
```

Відкритий парсер **нічого з цього не отримує**: ключа бази в ньому як не було, так і нема (ADR-012).

Займе хвилин 30–40. Усі команди — у PowerShell, у тому ж проєкті Google Cloud, що й парсер.

### 9.0. Перед початком

1. **Міграції вже в базі.** Застосуй до бою:
   ```powershell
   npx supabase db push
   ```
   Без міграції `20260929090000_link_checks.sql` сервіс отримає від бази `400`: колонок перевірки ще немає.
2. **Той самий проєкт GCP**, що й парсер:
   ```powershell
   gcloud config get-value project          # має бути wishlist-parser-<…>
   ```
   Якщо не той — `gcloud config set project wishlist-parser-<…>`.
3. **Змінні для наступних команд** — один раз на сесію PowerShell:
   ```powershell
   $PROJECT = gcloud config get-value project
   $REGION  = "europe-central2"
   $JOBS_SA = "wishlist-jobs@$PROJECT.iam.gserviceaccount.com"
   $SCHED_SA = "wishlist-scheduler@$PROJECT.iam.gserviceaccount.com"
   ```
   Закрив вікно — повтори цей блок, решта команд на ці змінні спирається.
4. **Три служби Google** (одноразово):
   ```powershell
   gcloud services enable secretmanager.googleapis.com cloudscheduler.googleapis.com iam.googleapis.com
   ```

### 9.1. Secret-ключ Supabase — звідки взяти

Це ключ, який обходить RLS, тобто бачить **усі** списки всіх людей. Тому окремий ключ саме для цього сервісу — щоб його можна було відкликати, нічого не зламавши.

1. [supabase.com/dashboard](https://supabase.com/dashboard) → твій проєкт.
2. Ліворуч унизу **⚙ Project Settings** → **API Keys**.
3. Вкладка з новими ключами (**Publishable and secret API keys**; не **Legacy**). Блок **Secret keys** → **+ New secret key**.
4. Назва: `wishlist-jobs` → **Create**.
5. Скопіюй значення — рядок, що починається з **`sb_secret_`**. Поки не закриєш вікно, тримай його під рукою: наступний крок — одразу в Secret Manager.

**Куди його НЕ класти:** у `.env` репозиторію, у Vercel, у `--set-env-vars` парсера, у чат чи лист. Єдине місце — Secret Manager (9.2).

Не плутай із **publishable**-ключем (`sb_publishable_…`): той публічний, він у фронтенді й парсері. Сервіс задач із publishable-ключем не запуститься — `/health` покаже `"configured": false`.

### 9.2. Покласти ключ у Secret Manager

**Через консоль (простіше):**
1. [console.cloud.google.com](https://console.cloud.google.com) → угорі вибрати проєкт `wishlist-parser-<…>`.
2. Пошук угорі: **Secret Manager** → **+ Create secret**.
3. **Name:** `wishlist-supabase-secret`.
4. **Secret value:** встав `sb_secret_…`. Перевір, що в кінці немає пробілу чи переносу рядка (сервіс їх і так обріже, але краще без них).
5. Решту не чіпай (Replication — Automatic) → **Create secret**.

**Або з PowerShell** — без переносу рядка в кінці, який дав би `echo`:
```powershell
$key = Read-Host "Встав sb_secret_ і натисни Enter"
[IO.File]::WriteAllText("$env:TEMP\wl-key.txt", $key)
gcloud secrets create wishlist-supabase-secret --replication-policy=automatic --data-file="$env:TEMP\wl-key.txt"
Remove-Item "$env:TEMP\wl-key.txt"
Remove-Variable key
```
`Read-Host` не пише введене в історію PowerShell — на відміну від ключа, вставленого прямо в команду.

### 9.3. Два облікові записи: хто виконує і хто викликає

```powershell
gcloud iam service-accounts create wishlist-jobs --display-name "wishlist-jobs: runtime"
gcloud iam service-accounts create wishlist-scheduler --display-name "Cloud Scheduler -> wishlist-jobs"
```

- **`wishlist-jobs`** — від його імені працює сервіс. Єдине право — читати секрет:
  ```powershell
  gcloud secrets add-iam-policy-binding wishlist-supabase-secret `
    --member "serviceAccount:$JOBS_SA" `
    --role roles/secretmanager.secretAccessor
  ```
- **`wishlist-scheduler`** — від його імені Cloud Scheduler стукає в сервіс. Право `run.invoker` він отримає в 9.5, коли сервіс уже існуватиме. Ключа він не бачить.

Якщо `add-iam-policy-binding` одразу після створення каже, що обліковий запис не існує, — Google ще не розніс його по своїх системах. Зачекай пів хвилини й повтори ту саму команду.

Чому не один спільний: тоді той, хто запускає задачу за розкладом, міг би й читати ключ бази.

### 9.4. Деплой `wishlist-jobs`

З теки `services\parser` (того самого коду, що й парсер):

```powershell
cd services\parser
gcloud run deploy wishlist-jobs `
  --source . `
  --region $REGION `
  --no-allow-unauthenticated `
  --service-account $JOBS_SA `
  --memory 512Mi `
  --cpu 1 `
  --min-instances 0 `
  --max-instances 1 `
  --concurrency 1 `
  --timeout 900 `
  --set-env-vars "APP_MODULE=app.jobs_main:app,SUPABASE_URL=https://<project-ref>.supabase.co" `
  --set-secrets "SUPABASE_SECRET_KEY=wishlist-supabase-secret:latest"
```

Що тут важливо:
- **`--no-allow-unauthenticated`** — головний захист: без ID-токена з правом виклику Google відповідає `403` ще до контейнера. Якщо gcloud спитає «Allow unauthenticated invocations?» — **N**.
- **`APP_MODULE=app.jobs_main:app`** — той самий образ запускає не парсер, а сервіс задач.
- **`--set-secrets`** кладе ключ у змінну оточення `SUPABASE_SECRET_KEY` під час старту. `:latest` — остання версія секрету.
- `<project-ref>` — той самий, що в `SUPABASE_URL` парсера (видно в адресі дашборду: `supabase.com/dashboard/project/<project-ref>`).
- **`--max-instances 1`, `--concurrency 1`** — одна перевірка за раз: два одночасні запуски перевіряли б ті самі позиції.
- **`--timeout 900`** — запас понад 300 секунд, які задача сама собі відводить.

Збірка триває 3–5 хвилин. Адреса сервісу:
```powershell
$JOBS_URL = gcloud run services describe wishlist-jobs --region $REGION --format="value(status.url)"
$JOBS_URL
```

Якщо деплой падає з `Permission 'iam.serviceaccounts.actAs' denied` — у твого акаунта Google немає права діяти від імені `wishlist-jobs`. Власник проєкту це право має. Якщо ти не власник, попроси роль **Service Account User** на цей обліковий запис.

### 9.5. Дозволити Cloud Scheduler викликати сервіс

```powershell
gcloud run services add-iam-policy-binding wishlist-jobs `
  --region $REGION `
  --member "serviceAccount:$SCHED_SA" `
  --role roles/run.invoker
```

### 9.6. Розклад у Cloud Scheduler

```powershell
gcloud scheduler jobs create http wishlist-check-links `
  --location $REGION `
  --schedule "15 4 * * *" `
  --time-zone "Europe/Warsaw" `
  --http-method POST `
  --uri "$JOBS_URL/jobs/check-links" `
  --oidc-service-account-email $SCHED_SA `
  --oidc-token-audience $JOBS_URL `
  --attempt-deadline 600s
```

- **`15 4 * * *`** — щодня о 04:15. Вночі магазини найменш завантажені, а до ранку висновки вже в списках.
- **`--oidc-token-audience`** — рівно адреса сервісу, без `/jobs/check-links`. Інакше Cloud Run відхилить токен (`401`/`403`).
- Якщо gcloud скаже, що Cloud Scheduler у `europe-central2` недоступний, — постав `--location europe-west1`. Розклад може жити в іншому регіоні, ніж сервіс.

### 9.7. Перевірка

1. **Сервіс закритий** — запит без токена Google відхиляє:
   ```powershell
   curl.exe -i -X POST -H "Content-Length: 0" "$JOBS_URL/jobs/check-links"
   ```
   Очікуємо `403 Forbidden` (сторінка Google, не наша відповідь). Без `Content-Length: 0` фронтенд Google відповідає `411 Length Required` ще до перевірки доступу — це про форму запиту, а не про закритість сервісу. `-d ""` замість заголовка не підходить: Windows PowerShell 5.1 викидає порожній аргумент, і curl відправить адресу як тіло.
2. **Сервіс налаштований** — з твоїм токеном (власник проєкту має право виклику):
   ```powershell
   curl.exe -H "Authorization: Bearer $(gcloud auth print-identity-token)" "$JOBS_URL/health"
   ```
   Очікуємо `{"status":"ok","service":"wishlist-jobs","configured":true}`. `false` — ключ не `sb_secret_…` або `SUPABASE_URL` лишився шаблоном.
3. **Задача працює** — запустити розклад позачергово й глянути журнал:
   ```powershell
   gcloud scheduler jobs run wishlist-check-links --location $REGION
   Start-Sleep 60
   gcloud run services logs read wishlist-jobs --region $REGION --limit 20
   ```
   У журналі має бути рядок `check-links {'ok': …, 'checked': …}` — лише лічильники, адрес товарів там немає. `PostgREST відхилив ключ` — у секреті не той ключ (9.1). `400` від бази — не застосована міграція (9.0).
4. **Парсер без ключа** — після передеплою парсера з новим кодом (розділ 7):
   ```powershell
   curl.exe https://wishlist-parser-xxxxx.europe-central2.run.app/health
   ```
   Має бути `"secret_key_present": false`. `true` означає, що ключ бази випадково опинився в парсері: прибери його (`gcloud run services update wishlist-parser --region $REGION --remove-env-vars SUPABASE_SECRET_KEY`).
5. **У застосунку v2** наступного ранку в позицій із посиланням з'являються мітки «Сторінки немає», «Немає в наявності» чи «Ціна змінилась», якщо є що сказати. Здебільшого їх немає — і це нормально.

### 9.8. Якщо ключ треба замінити

Витік чи просто профілактика:
1. Supabase → API Keys → **Secret keys** → створити новий `wishlist-jobs-2` (9.1).
2. Нова версія секрету:
   - консоль: Secret Manager → `wishlist-supabase-secret` → **+ New version**;
   - або PowerShell, як у 9.2, але `gcloud secrets versions add wishlist-supabase-secret --data-file=…`.
3. Перезапустити сервіс, щоб він узяв нову версію:
   ```powershell
   gcloud run services update wishlist-jobs --region $REGION --update-secrets "SUPABASE_SECRET_KEY=wishlist-supabase-secret:latest"
   ```
4. Supabase → API Keys → старий ключ → **Delete**. Від цієї миті він не працює ніде.

### 9.9. Ключі для наступного кроку (сповіщення, 4г-2)

Поки не потрібні — їх підключить наступний крок. Але якщо зручно, підготуй зараз: процедура та сама.

**Brevo API-ключ** — для листів (не плутай із паролем SMTP з розділу 5: це інша річ).
1. [app.brevo.com](https://app.brevo.com) → праворуч угорі ім'я профілю → **SMTP & API**.
2. Вкладка **API Keys** → **Generate a new API key** → назва `wishlist-jobs` → **Generate**.
3. Скопіюй `xkeysib-…` — Brevo покаже його **один раз**.
4. Secret Manager → **Create secret** `wishlist-brevo-key` зі значенням ключа, далі:
   ```powershell
   gcloud secrets add-iam-policy-binding wishlist-brevo-key --member "serviceAccount:$JOBS_SA" --role roles/secretmanager.secretAccessor
   ```
Адреса відправника — та сама, що вже підтверджена в Brevo для листів Supabase (розділ 5).

**VAPID-ключі** — для push у браузері. Це пара, яку генеруєш сам, нікому не платячи:
```powershell
npx web-push generate-vapid-keys --json
```
- `publicKey` — не секрет: піде у Vercel як `VITE_VAPID_PUBLIC_KEY` (наступний крок скаже, коли).
- `privateKey` — секрет: Secret Manager `wishlist-vapid-private` і такий самий `add-iam-policy-binding` для `$JOBS_SA`.

Пару генеруй **один раз**. Нова пара робить недійсними всі підписки на push, і людям доведеться вмикати сповіщення знову.

### 9.10. Скільки коштує

| Що | Безкоштовно | У нас |
|---|---|---|
| Cloud Scheduler | 3 задачі на платіжний акаунт | 1 |
| Secret Manager | 6 активних версій, 10 000 звернень на місяць | 1–3 версії, ~30 звернень |
| Cloud Run | 180 000 vCPU-секунд на місяць | ≤ 5 хвилин на добу |

Бюджетне сповіщення з розділу 2.4 покриває й цей сервіс.

---

## Скільки це коштує

| Що | Тариф | Реально |
|---|---|---|
| Vercel | Hobby | 0 |
| Cloud Run | безкоштовний рівень | 0 при кількох викликах на день; `wishlist-jobs` — кілька хвилин на добу |
| Cloud Scheduler, Secret Manager | безкоштовні квоти | 0 (розділ 9.10) |
| Supabase | Free | 0; проєкт засинає після тижня бездіяльності |
| Brevo | безкоштовний | 0 |

Єдиний реальний ризик — Cloud Run при аномальному навантаженні. Його закривають `--max-instances 2` і бюджетне сповіщення.

Про сон Supabase: на безкоштовному тарифі проєкт паузиться після тижня без запитів, і перший запит після цього довго чекає. Для сімейного вішліста, яким користуються сплесками під свята, це може здивувати — просто знай причину.
