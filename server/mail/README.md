# Почта Афины: приём писем Treatwell

> **Основной способ уже работает: IMAP.** Сервер сам читает ящик `athena.msnails@gmail.com` раз в 60 секунд (`IMAP_USER`/`IMAP_PASSWORD`), адрес для
> Treatwell Connect — этот ящик (`ATHENA_EMAIL` необязателен, по умолчанию берётся `IMAP_USER`). Вебхук ниже — запасной вариант
> для случая, когда письма пересылаются сервисом (Cloudflare, Mailgun, SendGrid), и для тестов.

Treatwell Connect шлёт уведомления о бронях на адрес, который вы укажете. Чтобы это был не личный ящик Марии, заводится
выделенный адрес Афины (например `booking@msnails.eu`), а входящие письма пересылаются на вебхук:

    POST https://ms-nails-academy.onrender.com/api/external-booking/email?key=<EXTERNAL_BOOKING_TOKEN>

Сервер принимает письма в трёх форматах: JSON, `application/x-www-form-urlencoded`, `multipart/form-data`.
Принимаются только письма с адресов `*@treatwell.*`; остальные отклоняются (400 `bad_sender`), поэтому адрес можно не прятать.

## Вариант 1 (рекомендуется): Cloudflare Email Routing
Бесплатно, если DNS домена msnails.eu на Cloudflare.
1. Email → Email Routing → Enable, адрес `booking@msnails.eu`.
2. Workers → Create → Email Worker, вставьте `cloudflare-email-worker.js`, задайте `WEBHOOK_URL` и `API_KEY`.
3. В Email Routing у адреса `booking` действие «Send to a Worker».

## Вариант 2: Mailgun / SendGrid
- Mailgun: Receiving → Create Route, Forward to `…/api/external-booking/email?key=…`.
- SendGrid: Inbound Parse → Destination URL тот же (без «send raw»).
Оба требуют MX-записей домена.

## Настройки сервера (Render → Environment)
| Переменная | Значение |
|---|---|
| `EXTERNAL_BOOKING_TOKEN` | длинный случайный ключ (обязателен в продакшене) |
| `ATHENA_EMAIL` | `booking@msnails.eu` (только для вывода в консоль) |
| `PUBLIC_BASE_URL` | адрес бэкенда, если отличается от `https://ms-nails-academy.onrender.com` |

Когда письмо пришло: бронь разбирается, слот блокируется на сайте, Мария получает сообщение в Telegram с кнопками
«Принято» и «Снять блок». При наложении слотов сообщение приходит с пометкой о конфликте.
