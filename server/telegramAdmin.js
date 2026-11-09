/*
  Telegram-бот Афины: бесшовная привязка администратора (Марии) и уведомления ей.

  Как это работает
    1. POST /api/admin/generate-link выдаёт ПОСТОЯННУЮ ссылку  https://t.me/<бот>?start=activate_<токен>
       Токен хранится в конфигурации (bookingState) и не имеет срока жизни: сколько ни запрашивай ссылку, она одна и та же,
       пока кто-то не пройдёт по ней успешно.
    2. Мария открывает ссылку и жмёт «Start» - бот получает /start activate_<токен>.
    3. Если администратор ещё не привязан, telegram id чата записывается как admin_chat_id в конфигурацию, а токен сгорает
       (одноразовый: вечный до первого успешного использования).
    4. Афина здоровается с Марией, присылает отчёт об активации и тестовое подтверждение через sendAdminNotification().
  Если администратор уже привязан, ссылка ничего не меняет (чужой /start не перехватит управление). Для осознанной
  перепривязки на другой аккаунт: POST /api/admin/generate-link?rebind=1 (нужен ADMIN_TOKEN).
  Пока привязки нет, уведомления идут на TELEGRAM_CHAT_ID из окружения (как раньше).

  Бот получает сообщения long polling-ом (getUpdates): публичный адрес и вебхук не нужны. Токен в логи не пишется.
*/
'use strict';

const crypto = require('node:crypto');

const GREETING = 'Здравствуйте, Мария! Я — Афина. Управление салоном MS Nails Academy переведено на ваш аккаунт. Теперь все отчеты и уведомления о записях будут приходить сюда.';
const REPORT = [
  '✅ Активация завершена: управление салоном MS Nails Academy привязано к этому аккаунту.',
  '',
  'Сюда будут приходить:',
  '• новые записи с сайта и от Афины;',
  '• внешние брони (Treatwell, почта, календарь) и наложения слотов;',
  '• заявки гостей на ручное оформление и их телефоны.',
  '',
  'Это сообщение отправлено через уведомления Афины, значит доставка работает.'
].join('\n');
const INVALID_MESSAGE = 'Эта ссылка недействительна или уже использована. Попросите новую ссылку авторизации.';
const ALREADY_MESSAGE = 'Управление салоном уже привязано к другому аккаунту, поэтому эта ссылка ничего не изменила.';
const PRIVATE_MESSAGE = 'Это служебный бот студии MS Nails Academy.';
const KEY = 'activate_';

function createTelegramAdmin(cfg) {
  const tg = cfg.tg;                       // shared/telegram.mjs (sendTelegram, escapeHtml)
  const token = cfg.token || '';           // TELEGRAM_BOT_TOKEN
  const state = cfg.state;                 // bookingState: getConfig / updateConfig / withConfig
  const fallbackChatId = String(cfg.fallbackChatId || '');   // TELEGRAM_CHAT_ID из окружения
  const log = cfg.log || console.log;
  let botUsername = cfg.botUsername || 'AthenaMSNailsBot';

  const digest = function (s) { return crypto.createHash('sha256').update(String(s)).digest(); };
  const same = function (a, b) { return crypto.timingSafeEqual(digest(a), digest(b)); };

  async function chatId() {
    return String((await state.getConfig()).admin_chat_id || '') || fallbackChatId;
  }

  /* ---------- постоянная ссылка ---------- */
  /*
    Токен создаётся один раз и лежит в конфигурации до первого успешного использования, поэтому ссылка стабильна
    и переживает перезапуски сервера. { rebind: true } разрешает привязку, даже если администратор уже есть.
  */
  async function generateActivation(opts) {
    const rebind = Boolean(opts && opts.rebind);
    const out = await state.withConfig(function (c) {
      if (!c.activation_token) { c.activation_token = crypto.randomBytes(24).toString('base64url'); }   // 32 символа: влезает в лимит 64 у start-параметра
      if (rebind && c.admin_chat_id) { c.activation_rebind = true; }
      return { token: c.activation_token, bound: Boolean(c.admin_chat_id), rebind: Boolean(c.activation_rebind) };
    });
    return { link: 'https://t.me/' + botUsername + '?start=' + KEY + out.token, bound: out.bound, rebind: out.rebind };
  }

  /* ---------- отправка администратору ---------- */
  /* sendAdminNotification(message) - на привязанный Telegram ID (текст экранируется; { html: true } - готовая HTML-разметка) */
  async function sendAdminNotification(message, opts) {
    const id = await chatId();
    if (!token || !id) { throw new Error('Telegram: нет TELEGRAM_BOT_TOKEN или администратор не привязан'); }
    const html = opts && opts.html ? String(message) : tg.escapeHtml(message);
    const markup = opts && opts.buttons && opts.buttons.length   // одна строка кнопок: [{ text, data }]
      ? { inline_keyboard: [opts.buttons.map(function (b) { return { text: b.text, callback_data: b.data }; })] } : undefined;
    await tg.sendTelegram({ token: token, chatId: id, html: html, markup: markup });
    return { ok: true, chatId: id };
  }

  function reply(toChat, text) {
    return tg.sendTelegram({ token: token, chatId: toChat, html: tg.escapeHtml(text) });
  }

  /* ---------- обработка сообщений бота ---------- */
  function api(method, body) {
    return fetch('https://api.telegram.org/bot' + token + '/' + method, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000)
    }).then(function (r) { return r.json(); });
  }

  /* нажатие кнопки под уведомлением: только от привязанного администратора */
  async function handleCallback(cb) {
    const chat = String(cb.message && cb.message.chat ? cb.message.chat.id : '');
    const admin = String((await state.getConfig()).admin_chat_id || '');
    if (!admin || chat !== admin || String(cb.from && cb.from.id) !== String((await state.getConfig()).admin_telegram_id || admin)) {
      await api('answerCallbackQuery', { callback_query_id: cb.id, text: 'Нет доступа' }).catch(function () {});
      return { handled: true, ok: false };
    }
    let text = 'Готово';
    try { text = (cfg.onAction ? await cfg.onAction(String(cb.data || '')) : '') || text; } catch (e) { text = 'Ошибка: ' + e.message; }
    await api('answerCallbackQuery', { callback_query_id: cb.id, text: text, show_alert: text.length > 40 }).catch(function () {});
    await api('editMessageReplyMarkup', { chat_id: chat, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } }).catch(function () {});
    await reply(chat, '↳ ' + text).catch(function () {});
    return { handled: true, ok: true, text: text };
  }

  async function handleUpdate(update) {
    if (update && update.callback_query) { return handleCallback(update.callback_query); }
    const msg = update && update.message;
    if (!msg || typeof msg.text !== 'string' || !msg.chat) { return { handled: false }; }
    const m = msg.text.match(/^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/);
    if (!m) { return { handled: false }; }
    const chat = String(msg.chat.id);
    const param = m[1] || '';

    if (param.indexOf(KEY) !== 0) {
      const bound = (await state.getConfig()).admin_chat_id;
      await reply(chat, bound && String(bound) === chat ? 'Я на связи, Мария. Уведомления приходят сюда.' : PRIVATE_MESSAGE);
      return { handled: true, activated: false };
    }
    if (msg.chat.type !== 'private') {
      await reply(chat, INVALID_MESSAGE).catch(function () {});
      return { handled: true, activated: false };
    }

    /* атомарно: проверить токен, проверить, что администратор ещё не привязан, привязать и сжечь токен */
    const from = msg.from || {};
    const given = param.slice(KEY.length);
    const r = await state.withConfig(function (c) {
      if (!c.activation_token || !same(c.activation_token, given)) { return { ok: false, reason: 'invalid' }; }
      const bound = String(c.admin_chat_id || '');
      if (bound && !c.activation_rebind) { return { ok: false, reason: bound === chat ? 'self' : 'already' }; }   // ссылка не сгорает и ничего не меняет
      c.admin_chat_id = chat;
      c.admin_telegram_id = String(from.id || chat);
      c.admin_name = [from.first_name, from.last_name].filter(Boolean).join(' ');
      c.admin_username = from.username || '';
      c.admin_bound_at = new Date().toISOString();
      delete c.activation_token;            // одноразовая: после первого успешного использования токена больше нет
      delete c.activation_rebind;
      return { ok: true, prev: bound };
    });

    if (!r.ok) {
      if (r.reason === 'self') { await reply(chat, 'Вы уже привязаны как администратор. Уведомления приходят сюда.').catch(function () {}); }
      else if (r.reason === 'already') { log('  [Telegram] /start с ключом отклонён: администратор уже привязан'); await reply(chat, ALREADY_MESSAGE).catch(function () {}); }
      else { log('  [Telegram] попытка активации отклонена (неверный ключ)'); await reply(chat, INVALID_MESSAGE).catch(function () {}); }
      return { handled: true, activated: false, reason: r.reason };
    }

    log('  [Telegram] Администратор привязан: admin_chat_id = ' + chat);
    await reply(chat, GREETING);
    await sendAdminNotification(REPORT);     // отчёт об активации и тест доставки на только что привязанный ID
    if (r.prev && r.prev !== chat) { reply(r.prev, 'Управление салоном переведено на другой аккаунт. Уведомления сюда больше не приходят.').catch(function () {}); }
    return { handled: true, activated: true, chatId: chat };
  }

  /* ---------- long polling ---------- */
  let stopped = false;
  function sleep(ms) { return new Promise(function (res) { setTimeout(res, ms); }); }
  async function startPolling() {
    if (!token) { return; }
    try {
      const me = await (await fetch('https://api.telegram.org/bot' + token + '/getMe', { signal: AbortSignal.timeout(8000) })).json();
      if (me.ok && me.result && me.result.username) { botUsername = me.result.username; }
    } catch (e) { /* остаёмся с именем из настроек */ }
    /* вебхук и long polling взаимоисключающи: если бот когда-либо был подключён через вебхук, getUpdates вернёт 409 - снимаем его (непрочитанные сообщения не теряем) */
    try { await fetch('https://api.telegram.org/bot' + token + '/deleteWebhook?drop_pending_updates=false', { signal: AbortSignal.timeout(8000) }); } catch (e) { /* не критично */ }
    let offset = 0;
    log('  Telegram-бот:  @' + botUsername + ' · ждёт /start activate_… (long polling)');
    (async function loop() {
      while (!stopped) {
        try {
          const r = await fetch('https://api.telegram.org/bot' + token + '/getUpdates?timeout=25&offset=' + offset + '&allowed_updates=%5B%22message%22%2C%22callback_query%22%5D');
          const j = await r.json();
          if (!j.ok) {
            if (j.error_code === 409) { log('  [Telegram] getUpdates: конфликт 409 — токен бота сейчас слушает другой экземпляр (обычно старый деплой, который вот-вот остановится, или локальный запуск). Повтор через 15 с.'); await sleep(15000); continue; }
            throw new Error(j.description || r.status);
          }
          for (const u of j.result) {
            offset = u.update_id + 1;
            await handleUpdate(u).catch(function (e) { log('  [Telegram] обработка сообщения: ' + e.message); });
          }
        } catch (e) {
          log('  [Telegram] polling: ' + e.message);
          await sleep(5000);
        }
      }
    })();
  }

  return {
    generateActivation: generateActivation,
    sendAdminNotification: sendAdminNotification,
    handleUpdate: handleUpdate,
    startPolling: startPolling,
    stop: function () { stopped = true; },
    chatId: chatId,
    get botUsername() { return botUsername; },
    GREETING: GREETING
  };
}

module.exports = { createTelegramAdmin: createTelegramAdmin, GREETING: GREETING };
