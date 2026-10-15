# Онлайн-запись MS Nails Academy

```
 Сайт (GitHub Pages)            Cloudflare Worker                 Приватный репозиторий
 iOS-виджет в index.html  ──►   booking/worker  ──── коммит ───►  ms-nails-bookings/bookings.json
   GET  /availability            проверка слота                          ▲
   POST /book                    └─► Telegram-бот Марии                  │ читает и помечает
                                                                         │
                              GitHub Actions (каждые 15 мин) ────────────┘
                              booking/reminder/send-reminders.mjs ──► SMS.to / Twilio
```

* **Виджет** показывает только свободное время и не хранит секретов.
* **Worker** — серверная функция на чистом `fetch`: проверяет, что слот свободен, сохраняет запись коммитом
  в приватный репозиторий и сразу пишет Марии в Telegram. Сервисов вроде Make или n8n нет.
* **GitHub Actions** раз в 15 минут шлёт SMS на греческом тем, у кого визит **завтра** и до него осталось **≤ 24 часов**:
  `MS Nails Academy: Υπενθύμιση για το ραντεβού σας αύριο 16/10 στις 14:00 (Μανικιούρ). Σας περιμένουμε!`
* Пока Worker не подключён (`BOOKING_API` пустой), виджет работает в резервном режиме: заявка открывается
  у клиента в WhatsApp Марии.

Расписание (часы работы, длительность услуг, шаг, буфер) хранится в одном файле: [shared/schedule.mjs](shared/schedule.mjs).

---

## Запуск: один раз, около 20 минут

### 1. Приватный репозиторий для записей
На GitHub создайте **приватный** репозиторий `ms-nails-bookings` и при создании поставьте галочку «Add a README»,
чтобы появилась ветка `main`. Файл `bookings.json` создастся сам при первой записи.

> Имена и телефоны клиентов нельзя хранить в публичном репозитории сайта (GDPR), поэтому записи живут отдельно.

### 2. Токен GitHub
GitHub → Settings → Developer settings → **Fine-grained tokens** → Generate new token:
* Repository access: **Only select repositories** → `ms-nails-bookings`
* Permissions → Repository → **Contents: Read and write**
* Срок действия — максимальный (поставьте себе напоминание продлить)

Этот токен понадобится дважды: для Worker (`GITHUB_TOKEN`) и для Actions (`BOOKINGS_TOKEN`).

### 3. Telegram-бот Марии
1. В Telegram откройте [@BotFather](https://t.me/BotFather), отправьте `/newbot` и сохраните **токен**.
2. Мария открывает своего бота и нажимает **Start**.
3. Откройте в браузере `https://api.telegram.org/bot<ТОКЕН>/getUpdates` и возьмите число из `"chat":{"id": …}`: это **chat_id**.

### 4. Cloudflare Worker (бесплатный тариф: 100 000 запросов в день)
```bash
cd booking/worker
npx wrangler login
npx wrangler secret put GITHUB_TOKEN         # токен из шага 2
npx wrangler secret put TELEGRAM_BOT_TOKEN   # токен из шага 3
npx wrangler secret put TELEGRAM_CHAT_ID     # chat_id из шага 3
npx wrangler deploy
```
Wrangler выведет адрес вида `https://ms-nails-booking.<ваш-аккаунт>.workers.dev`.
Если сайт переедет на свой домен, добавьте его в `ALLOWED_ORIGINS` в [worker/wrangler.toml](worker/wrangler.toml).

### 5. Подключить виджет
В `index.html`, в последнем `<script>`, впишите адрес Worker:
```js
var BOOKING_API = 'https://ms-nails-booking.<ваш-аккаунт>.workers.dev';
```
Закоммитьте и запушьте: сайт начнёт принимать записи.

### 6. SMS-напоминания
1. Зарегистрируйтесь на [sms.to](https://sms.to), пополните баланс и создайте **API key**.
   Sender ID по умолчанию — `MSNails` (до 11 латинских символов); проверьте в кабинете, что он разрешён для Греции.
2. В репозитории сайта: Settings → Secrets and variables → **Actions** → New repository secret:

| Secret | Значение |
|---|---|
| `BOOKINGS_TOKEN` | токен GitHub из шага 2 |
| `SMSTO_API_KEY` | ключ SMS.to |
| `TELEGRAM_BOT_TOKEN` | токен бота (для предупреждений, если SMS не ушло) |
| `TELEGRAM_CHAT_ID` | chat_id Марии |

Необязательные **Variables** на той же странице: `BOOKINGS_REPO` (по умолчанию `rustams060575-bot/ms-nails-bookings`),
`SMS_SENDER_ID`, `SMS_PROVIDER`.

3. Проверка: Actions → **SMS reminders** → Run workflow (галочка «dry run» включена). В логе будет видно,
   кому ушло бы SMS; номера в логе замаскированы.

**Twilio вместо SMS.to:** variable `SMS_PROVIDER=twilio`, secrets `TWILIO_ACCOUNT_SID` и `TWILIO_AUTH_TOKEN`,
variable `TWILIO_FROM` (номер или Sender ID) либо `TWILIO_MESSAGING_SERVICE_SID`.

---

## Как Мария управляет записями

Всё делается в файле `bookings.json` приватного репозитория: прямо на github.com или в приложении GitHub Mobile.

* **Отменить запись:** у нужной записи поменять `"status": "confirmed"` на `"status": "cancelled"`.
  Время сразу освободится на сайте, SMS не уйдёт.
* **Закрыть время** (обед, личные дела, отпуск) — добавить элемент в массив:
  ```json
  { "type": "block", "date": "2026-10-20", "time": "13:00", "minutes": 120 }
  ```
  Закрыть день целиком: `"time": "09:00", "minutes": 720`.
* **Изменить график или длительность услуг:** правка в [shared/schedule.mjs](shared/schedule.mjs), затем
  `npx wrangler deploy`. Если меняется длительность, обновите ещё подпись в массиве `SVC` в `index.html`.

## Детали

* **Двойная запись невозможна:** Worker повторно проверяет слот перед коммитом, а коммит идёт с `sha` версии файла.
  Если два клиента нажали одновременно, второй получит «время только что заняли».
* **Защита от спама:** скрытое поле-ловушка, запросы принимаются только с сайта (`ALLOWED_ORIGINS`),
  не больше 3 будущих записей на один номер.
* **SMS уходит один раз:** после отправки в запись ставится `reminderSentAt`. Если провайдер вернул ошибку,
  будет до 3 попыток, после чего Мария получит в Telegram просьбу напомнить клиенту вручную.
* **Когда SMS не отправляется:** при записи на сегодня, потому что текст «αύριο» был бы неправдой. Если клиент записался
  на завтра меньше чем за сутки, напоминание уйдёт при ближайшем запуске.
* **Стоимость:** Cloudflare и GitHub Actions бесплатны (Actions в публичном репозитории не тратят минуты).
  Греческий текст отправляется в кодировке Unicode, поэтому одно напоминание (~115 символов) — это 2 SMS-сегмента.
* **Cron GitHub** иногда опаздывает на 5–15 минут, поэтому правило «завтра и ≤ 24 ч» устойчиво к задержкам.
  GitHub отключает cron в публичных репозиториях после 60 дней без коммитов; workflow раз в сутки
  переподтверждает себя (шаг Keepalive). Если GitHub всё же пришлёт письмо об отключении, достаточно нажать «Enable workflow».
* Записи старше 120 дней удаляются из файла автоматически, но остаются в истории коммитов.
