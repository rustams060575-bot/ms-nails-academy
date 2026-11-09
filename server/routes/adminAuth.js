/*
  Авторизация администратора (Марии) в Telegram-боте Афины.

  POST /api/admin/generate-link   -> { ok, link, bound, rebind }   ПОСТОЯННАЯ ссылка вида
                                     https://t.me/AthenaMSNailsBot?start=activate_<токен>
                                     без срока жизни; один и тот же токен, пока Мария не пройдёт по ссылке (первое успешное
                                     использование сжигает его). ?rebind=1 - ссылка для перепривязки, если администратор уже есть.
  GET  /api/admin/status          -> { ok, bound, admin_name, bound_at }   привязан ли администратор
  POST /api/admin/test-notification -> отправляет тестовое сообщение на привязанный аккаунт (sendAdminNotification)

  Доступ: Authorization: Bearer <ADMIN_TOKEN>. Локально без токена открыто; в продакшене без ADMIN_TOKEN выключено (503).
*/
'use strict';

const crypto = require('node:crypto');

function createAdminAuthRoute(cfg) {
  const bot = cfg.bot;                    // telegramAdmin
  const state = cfg.state;                // bookingState
  const token = cfg.token || '';
  const prod = Boolean(cfg.prod);
  const send = cfg.send;
  const limited = cfg.limited || function () { return false; };

  function authorized(req) {
    if (!token) { return !prod; }
    const h = String(req.headers.authorization || '');
    const given = h.indexOf('Bearer ') === 0 ? h.slice(7).trim() : String(req.headers['x-admin-token'] || '');
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(token).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /* возвращает true, если запрос обработан этим маршрутом */
  async function handle(req, res, url, ip) {
    if (url.pathname.indexOf('/api/admin/') !== 0) { return false; }
    const route = url.pathname.slice('/api/admin/'.length);
    if (['generate-link', 'status', 'test-notification'].indexOf(route) < 0) { return false; }
    if (!token && prod) { send(res, 503, { error: 'admin_disabled' }); return true; }
    if (limited(ip, 'adminauth', 20)) { send(res, 429, { error: 'rate_limited' }); return true; }
    if (!authorized(req)) { send(res, 401, { error: 'unauthorized' }); return true; }

    if (route === 'status' && req.method === 'GET') {
      const c = await state.getConfig();
      send(res, 200, { ok: true, bound: Boolean(c.admin_chat_id), admin_name: c.admin_name || '', bound_at: c.admin_bound_at || null });
      return true;
    }
    if (route === 'generate-link' && req.method === 'POST') {
      const a = await bot.generateActivation({ rebind: url.searchParams.get('rebind') === '1' });
      send(res, 200, { ok: true, link: a.link, permanent: true, one_time: true, bound: a.bound, rebind: a.rebind });
      return true;
    }
    if (route === 'test-notification' && req.method === 'POST') {
      try {
        await bot.sendAdminNotification('🔔 Тестовое уведомление от Афины: соединение с вашим аккаунтом работает.');
        send(res, 200, { ok: true });
      } catch (e) {
        send(res, 409, { error: 'not_delivered', detail: e.message });
      }
      return true;
    }
    send(res, 405, { error: 'method_not_allowed' });
    return true;
  }

  return { handle: handle };
}

module.exports = { createAdminAuthRoute: createAdminAuthRoute };
