/*
  POST /api/external-booking - приёмник внешних броней (Treatwell, письма, календарь) в единый табель занятости.
  GET  /api/external-booking?from=YYYY-MM-DD&to=YYYY-MM-DD - что сейчас занято (для проверки).

  Доступ: заголовок  Authorization: Bearer <EXTERNAL_BOOKING_TOKEN>  (или X-Api-Key).
  Без токена в окружении: локально разрешено, в продакшене эндпоинт выключен (503).

  Тело (JSON):
    {
      "source":      "treatwell" | "email" | "calendar",
      "date":        "2026-11-12",            // или "start": "2026-11-12T14:30:00+02:00" (переводится во время Афин)
      "time":        "14:30",
      "name":        "Anna K.",               // имя клиента (client_name / client.name тоже подойдут)
      "minutes":     90,                      // по умолчанию 60 (duration_minutes / duration тоже)
      "service":     "manicure",              // необязательно
      "external_id": "TW-100500",             // необязательно: повторная доставка не создаст дубль
      "status":      "cancelled"              // необязательно: снять бронь (нужен external_id)
    }
*/
'use strict';

const crypto = require('node:crypto');
const { parseTreatwellEmail } = require('../parsers/treatwell.js');

function createExternalBookingRoute(cfg) {
  const state = cfg.state;
  const S = cfg.schedule;
  const token = cfg.token || '';
  const prod = Boolean(cfg.prod);
  const send = cfg.send;
  const readJson = cfg.readJson;
  const limited = cfg.limited || function () { return false; };
  const notifyAdmin = cfg.notifyAdmin || function () {};
  const notifyNew = cfg.notifyNew || function () {};
  const log = cfg.log || console.log;
  let warned = false;

  /*
    Тело входящего письма от почтового сервиса. Понимаем три формата:
      JSON (Cloudflare Email Worker / своя пересылка)  { from, subject, text, html }
      urlencoded и multipart/form-data (Mailgun Routes, SendGrid Inbound Parse): sender|from, subject, body-plain|text, body-html|html
    Вложения (файловые части multipart) пропускаются.
  */
  function readRaw(req, maxBytes) {
    return new Promise(function (resolve, reject) {
      let size = 0; const chunks = [];
      req.on('data', function (c) { size += c.length; if (size > maxBytes) { reject(new Error('too_large')); req.destroy(); } else { chunks.push(c); } });
      req.on('end', function () { resolve(Buffer.concat(chunks)); });
      req.on('error', reject);
    });
  }
  function parseMultipart(buf, boundary) {
    const out = {};
    const sep = Buffer.from('--' + boundary);
    let pos = buf.indexOf(sep);
    while (pos >= 0) {
      const next = buf.indexOf(sep, pos + sep.length);
      if (next < 0) { break; }
      const part = buf.subarray(pos + sep.length + 2, next - 2);          // без CRLF вокруг
      const cut = part.indexOf('\r\n\r\n');
      if (cut > 0) {
        const head = part.subarray(0, cut).toString('utf8');
        const name = (head.match(/name="([^"]+)"/i) || [])[1];
        if (name && !/filename=/i.test(head)) { out[name] = part.subarray(cut + 4).toString('utf8'); }
      }
      pos = next;
    }
    return out;
  }
  async function readMail(req) {
    const buf = await readRaw(req, 2 * 1024 * 1024);
    const type = String(req.headers['content-type'] || '');
    let f = {};
    if (/multipart\/form-data/i.test(type)) {
      const b = (type.match(/boundary=("?)([^";]+)\1/i) || [])[2];
      f = b ? parseMultipart(buf, b) : {};
    } else if (/x-www-form-urlencoded/i.test(type)) {
      f = Object.fromEntries(new URLSearchParams(buf.toString('utf8')));
    } else {
      try { f = JSON.parse(buf.toString('utf8') || '{}'); } catch (e) { throw new Error('bad_json'); }
    }
    return {
      from: f.from || f.sender || f.From || '',
      subject: f.subject || f.Subject || '',
      text: f.text || f['body-plain'] || f['stripped-text'] || '',
      html: f.html || f['body-html'] || f['stripped-html'] || ''
    };
  }

  function authorized(req, url) {
    if (!token) { return !prod; }
    const h = String(req.headers.authorization || '');
    /* почтовые сервисы не умеют слать заголовок авторизации, поэтому ключ можно передать в адресе вебхука: ?key=… */
    const given = h.indexOf('Bearer ') === 0 ? h.slice(7).trim() : String(req.headers['x-api-key'] || (url && url.searchParams.get('key')) || '');
    const a = crypto.createHash('sha256').update(given).digest();
    const b = crypto.createHash('sha256').update(token).digest();
    return crypto.timingSafeEqual(a, b);
  }

  /* принимаем разные имена полей, которые встречаются в письмах и вебхуках */
  function pick(body) {
    const client = body.client && typeof body.client === 'object' ? body.client : {};
    let date = body.date, time = body.time;
    if ((!date || !time) && body.start) {
      const d = new Date(body.start);
      if (!isNaN(d)) { const p = S.athensParts(d); date = p.date; time = p.time; }
    }
    return {
      source: body.source,
      date: String(date || ''), time: String(time || '').slice(0, 5),
      name: body.name || body.client_name || body.clientName || client.name || '',
      minutes: body.minutes || body.duration_minutes || body.duration,
      service: body.service,
      externalId: body.external_id || body.externalId || body.id || '',
      cancelled: /^(cancel|canceled|cancelled)/i.test(String(body.status || body.action || ''))
    };
  }

  /* Общая обработка письма Treatwell (вебхук и IMAP-опрос): разбор -> bookingState -> уведомление. Возвращает { status, body, p } */
  async function processMail(mail) {
    const p = parseTreatwellEmail(mail, { extraSenders: cfg.extraSenders });
    if (!p.ok) { log('[ПОЧТА] Treatwell: письмо не разобрано (' + p.error + ') · тема: ' + String(mail.subject || '').slice(0, 80)); return { status: 400, body: { error: p.error }, p: p }; }
    if (p.kind === 'cancel') {
      const r = await state.cancelExternal('treatwell', p.code);
      log('[ПОЧТА] Treatwell ' + p.code + ': отмена' + (r.found ? ' -> слот освобождён.' : ' (такой брони не было).'));
      return { status: r.ok ? 200 : 400, body: r.ok ? { ok: true, kind: 'cancel', code: p.code, cancelled: r.found } : { error: r.error }, p: p };
    }
    const r = await state.bookSlot(p.date, p.time, 'treatwell', {
      name: p.name, minutes: p.minutes, externalId: p.code, serviceName: p.service, phone: p.phone, email: p.email, price: p.price
    });
    if (!r.ok) { return { status: 400, body: { error: r.error }, p: p }; }
    if (r.duplicate) { return { status: 200, body: { ok: true, duplicate: true, id: r.booking.id, code: p.code }, p: p }; }
    const conflict = r.conflicts.length > 0;
    log('[ПОЧТА] Treatwell ' + p.code + ': ' + (conflict ? 'КОНФЛИКТ — слот ' + p.time + ' уже занят, администратору отправлено уведомление.' : 'слот ' + p.time + ' свободен, бронь принята.'));
    if (conflict) { notifyAdmin(r.booking, r.conflicts); } else { notifyNew(r.booking, p); }
    return {
      status: conflict ? 409 : 201, p: p,
      body: {
        ok: !conflict, conflict: conflict, blocked: true, id: r.booking.id, code: p.code, date: r.booking.date, time: r.booking.time,
        minutes: r.booking.minutes, conflicts: r.conflicts, parsed: { service: p.service, price: p.price, name: p.name, phone: p.phone, email: p.email }
      }
    };
  }

  /* POST /api/external-booking/email  { from, subject, text | html } - письмо Treatwell целиком (почтовый хук / симуляция) */
  async function handleMail(req, res) {
    let mail;
    try { mail = await readMail(req); } catch (e) { send(res, 400, { error: e.message }); return; }
    const r = await processMail(mail);
    send(res, r.status, r.body);
  }

  /* возвращает true, если запрос обработан этим маршрутом */
  async function handle(req, res, url, ip) {
    const isMail = url.pathname === '/api/external-booking/email';
    if (url.pathname !== '/api/external-booking' && !isMail) { return false; }
    if (!token && prod) { send(res, 503, { error: 'disabled' }); return true; }
    if (!token && !warned) { warned = true; log('  [СИНХРОНИЗАЦИЯ] EXTERNAL_BOOKING_TOKEN не задан — эндпоинт открыт только потому, что сервер запущен локально.'); }
    if (limited(ip, 'external', 60)) { send(res, 429, { error: 'rate_limited' }); return true; }
    if (!authorized(req, url)) { send(res, 401, { error: 'unauthorized' }); return true; }

    if (isMail && req.method === 'POST') { await handleMail(req, res); return true; }
    if (isMail) { send(res, 405, { error: 'method_not_allowed' }); return true; }

    if (req.method === 'GET') {
      const from = url.searchParams.get('from') || S.athensParts().date;
      const to = url.searchParams.get('to') || S.addDays(from, 14);
      send(res, 200, { ok: true, from: from, to: to, busy: await state.listBusy(from, to) });
      return true;
    }
    if (req.method !== 'POST') { send(res, 405, { error: 'method_not_allowed' }); return true; }

    const body = await readJson(req);
    const d = pick(body || {});
    const source = state.normalizeSource(d.source);
    if (!source || !state.isExternal(source)) { send(res, 400, { error: 'bad_source' }); return true; }

    if (d.cancelled) {
      const r = await state.cancelExternal(source, d.externalId);
      send(res, r.ok ? 200 : 400, r.ok ? { ok: true, cancelled: r.found } : { error: r.error });
      return true;
    }

    const r = await state.bookSlot(d.date, d.time, source, { name: d.name, minutes: d.minutes, service: d.service, externalId: d.externalId });
    if (!r.ok) { send(res, 400, { error: r.error }); return true; }
    if (r.duplicate) { send(res, 200, { ok: true, duplicate: true, id: r.booking.id }); return true; }
    if (r.conflicts.length) { notifyAdmin(r.booking, r.conflicts); }   // Мария узнаёт о наложении сразу
    send(res, 201, {
      ok: true, blocked: true, id: r.booking.id, source: source, date: r.booking.date, time: r.booking.time, minutes: r.booking.minutes,
      conflicts: r.conflicts
    });
    return true;
  }

  return { handle: handle, processMail: processMail };
}

module.exports = { createExternalBookingRoute: createExternalBookingRoute };
