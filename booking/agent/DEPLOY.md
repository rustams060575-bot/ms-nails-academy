# Деплой ИИ-ассистента и API записи на Render

## Как это устроено

```
 msnails.eu (GitHub Pages)          Render (Node, этот server.js)             Сервисы
 iOS-виджет + кнопка ассистента ──► /availability  /book  /agent/chat ──┬──► Anthropic API (Claude)
                                                                         ├──► Telegram-бот → сообщение Марии
                                                                         └──► приватный репозиторий ms-nails-bookings
                                                                              (bookings.json) ◄── SMS-напоминания (GitHub Actions)
```

* Сайт остаётся на GitHub Pages. На Render живёт только API.
* Render **заменяет Cloudflare Worker**: тот же формат записей, тот же приватный репозиторий, поэтому SMS-напоминания
  из `.github/workflows/sms-reminders.yml` продолжают работать без изменений. Worker после перехода не нужен.
* Файловая система Render временная, поэтому в продакшене записи **обязательно** хранятся в GitHub (шаг 3).
* Конфигурация сервиса: [`render.yaml`](../../render.yaml) в корне репозитория.

---

## Шаг 1. Telegram-бот через @BotFather

1. В Telegram откройте [@BotFather](https://t.me/BotFather) (с синей галочкой) и отправьте `/newbot`.
2. **Name** (имя в чатах): `MS Nails Записи`.
3. **Username**: латиницей и обязательно с `bot` на конце, например `msnails_booking_bot`. Если занято, BotFather попросит другое.
4. BotFather пришлёт **токен** вида `123456789:AAH...`. Это пароль к боту: не публикуйте его и не вставляйте в код.
   Если токен утёк: у BotFather `/revoke`, выберите бота, и выпустится новый.
5. **Мария** открывает бота по ссылке `t.me/<username>` и нажимает **Start**. Пока она этого не сделала, бот не сможет ей писать.
6. Узнайте **chat_id**: откройте в браузере `https://api.telegram.org/bot<ТОКЕН>/getUpdates`.
   Найдите `"chat":{"id": 123456789 ...}` и скопируйте число. Если ответ пустой (`"result":[]`), отправьте боту любое сообщение и обновите страницу.
   * Хотите получать записи в группу: добавьте бота в группу, напишите там сообщение и возьмите id из `getUpdates`. У групп он отрицательный (`-100…`).
7. Проверка (подставьте свои значения):
   `https://api.telegram.org/bot<ТОКЕН>/sendMessage?chat_id=<CHAT_ID>&text=test`. Сообщение должно прийти в Telegram.

## Шаг 2. Ключ Anthropic

1. [console.anthropic.com](https://console.anthropic.com) → **API keys** → **Create key**, скопируйте `sk-ant-…`.
2. В **Settings → Limits** задайте месячный лимит расходов (например 20 $), чтобы обезопасить бюджет от злоупотреблений чатом.

## Шаг 3. Хранилище записей (GitHub)

Если приватный репозиторий и токен уже созданы по [booking/README.md](../README.md) (шаги 1–2), используйте их.
Иначе:

1. Создайте **приватный** репозиторий `ms-nails-bookings` (с галочкой «Add a README»).
2. GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate:
   Only select repositories → `ms-nails-bookings`, права **Contents: Read and write**, максимальный срок.
   Скопируйте токен: это `GITHUB_TOKEN` для Render.

## Шаг 4. Создание сервиса на Render

1. Зарегистрируйтесь на [render.com](https://render.com) (удобно через GitHub).
2. **New +** → **Blueprint** → подключите репозиторий сайта (`rustams060575-bot/ms-nails-academy`).
   Render найдёт `render.yaml` и покажет сервис `ms-nails-agent`.
3. Render попросит значения секретов. Введите их (в таблице ниже, значения без кавычек):

| Переменная | Значение | Откуда |
|---|---|---|
| `ANTHROPIC_API_KEY` | `sk-ant-…` | шаг 2 |
| `GITHUB_TOKEN` | токен GitHub | шаг 3 |
| `TELEGRAM_BOT_TOKEN` | `123456789:AAH…` | шаг 1 |
| `TELEGRAM_CHAT_ID` | число | шаг 1 |

   Остальные переменные уже заданы в `render.yaml`:

| Переменная | Значение по умолчанию | Назначение |
|---|---|---|
| `NODE_ENV` | `production` | продакшен-режим (слушает `0.0.0.0`, доверяет IP из заголовка прокси) |
| `SERVE_SITE` | `false` | в продакшене сайт не раздаётся: он на GitHub Pages |
| `ALLOWED_ORIGINS` | `https://msnails.eu,https://www.msnails.eu` | с каких сайтов браузер может обращаться к API; остальные получают 403 |
| `ANTHROPIC_MODEL` | `claude-sonnet-5-5` | модель ассистента |
| `BOOKINGS_REPO` | `rustams060575-bot/ms-nails-bookings` | приватный репозиторий с записями |
| `BOOKINGS_PATH`, `BOOKINGS_BRANCH` | `bookings.json`, `main` | файл и ветка |
| `NODE_VERSION` | `22` | версия Node |

4. Нажмите **Apply**. Через 1–2 минуты сервис получит адрес вида `https://ms-nails-agent.onrender.com`.
   Если имя `ms-nails-agent` занято, Render добавит суффикс: используйте тот адрес, который он показал.

> Подсказка: переменные можно менять позже в Render → сервис → **Environment**. После изменения сервис перезапустится сам.

## Шаг 5. Проверка сервера

1. Откройте `https://<ваш-адрес>.onrender.com/healthz`. Ожидаемый ответ:
   `{"ok":true,"service":"ms-nails-agent","mode":"claude","storage":"github","telegram":true}`
   * `mode: "demo"` → не подхватился `ANTHROPIC_API_KEY`.
   * `storage: "file"` → не заданы `GITHUB_TOKEN` или `BOOKINGS_REPO`. Записи пропадут при перезапуске, это недопустимо.
   * `telegram: false` → не заданы `TELEGRAM_BOT_TOKEN` или `TELEGRAM_CHAT_ID`.
2. `https://<ваш-адрес>.onrender.com/availability` должен вернуть JSON со свободными слотами.
3. Логи: Render → сервис → **Logs**. При старте сервер печатает режим, хранилище, Telegram и CORS.

## Шаг 6. Подключение сайта (после успешной проверки)

Сейчас эти правки в репозиторий **не внесены**: сайт на GitHub Pages ещё работает по-старому (резерв через WhatsApp).
Когда сервер проверен, сделайте в `index.html`:

1. В `<head>` перед `</head>` добавьте (подставьте свой адрес Render):
   ```html
   <script>window.MS_AGENT_API='https://ms-nails-agent.onrender.com';</script>
   <link rel="stylesheet" href="/booking/agent/agent.css">
   ```
2. Перед `</body>` добавьте:
   ```html
   <script src="/booking/agent/agent-widget.js" defer></script>
   ```
3. В последнем `<script>` вместо пустого адреса впишите тот же:
   ```js
   var BOOKING_API = 'https://ms-nails-agent.onrender.com';
   ```
4. Пересоберите языковые версии: `node tools/build-seo.mjs` (или `npm run seo`).
5. Закоммитьте и запушьте. Через минуту сайт на msnails.eu покажет кнопку ассистента, а виджет начнёт писать в продакшен-API.
6. Сделайте тестовую запись на сайте и в чате с ассистентом: должно прийти сообщение в Telegram, а в `ms-nails-bookings` появиться коммит.
   Тестовую запись отмените в `bookings.json` (`"status": "cancelled"`).

## Запуск в продакшене: как работает и что учесть

* **Бесплатный тариф засыпает** после 15 минут без запросов, первый запрос после сна занимает около 50 секунд.
  Виджет покажет слоты с задержкой, а при таймауте (10 с) сработает резерв через WhatsApp. Решения:
  тариф **Starter** (~7 $/мес, не засыпает), либо бесплатный пинг `/healthz` каждые 5–10 минут через [UptimeRobot](https://uptimerobot.com).
  Для бизнеса рекомендуется Starter.
* **Автодеплой**: каждый push в `booking/**`, `render.yaml` или `package.json` пересобирает сервис. Правки только в `index.html` его не затрагивают.
* **Защита**: CORS по `ALLOWED_ORIGINS`, лимит 20 запросов в минуту на IP, не больше 3 будущих записей на один номер.
  Лимиты хранятся в памяти и сбрасываются при перезапуске. Установите месячный лимит расходов в консоли Anthropic.
* **Сбой Telegram не отменяет запись**: он попадёт только в логи Render. Запись сохранена в `bookings.json`.
* **Локальная проверка перед деплоем**: скопируйте `.env.example` в `.env`, впишите `ANTHROPIC_API_KEY`, `TELEGRAM_*` и
  **оставьте `GITHUB_TOKEN` пустым**, иначе тестовые записи попадут в боевой репозиторий. Запуск: `node booking/agent/server.js`.
* **Cloudflare Worker** (`booking/worker`) после перехода на Render можно не разворачивать.

## Если что-то не работает

| Симптом | Что проверить |
|---|---|
| В Telegram ничего не приходит | в логах `Telegram failed: 401` → неверный токен; `400 chat not found` → Мария не нажала Start или неверный `chat_id` |
| Виджет показывает «Не удалось отправить» / уходит в WhatsApp | API не отвечает (сервис спит) или домен сайта не входит в `ALLOWED_ORIGINS` (в консоли браузера ошибка CORS) |
| `/healthz` → `storage: "file"` | не заданы `GITHUB_TOKEN`/`BOOKINGS_REPO` |
| Ошибка в логах `GitHub read failed: 404` | неверное имя репозитория или у токена нет доступа к нему |
| Ассистент не отвечает, в логах `Anthropic 401/429` | неверный ключ или исчерпан лимит расходов |
| Сервис не стартует | Render → Logs; проверьте, что `startCommand` = `node booking/agent/server.js` |
