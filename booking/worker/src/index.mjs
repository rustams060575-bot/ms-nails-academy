/*
  MS Nails Academy — API онлайн-записи (Cloudflare Worker).

  GET  /availability  → свободные слоты всех услуг (без персональных данных)
  POST /book          → { service, date, time, name, phone, lang } → запись + сообщение Марии в Telegram

  Секреты (wrangler secret put …): GITHUB_TOKEN, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
  Переменные (wrangler.toml): ALLOWED_ORIGINS, BOOKINGS_REPO, BOOKINGS_PATH, BOOKINGS_BRANCH
*/

import { SERVICES, availability, slotsForDate, toUtc } from '../../shared/schedule.mjs';
import { createStore } from '../../shared/store.mjs';
import { sendTelegram, escapeHtml } from '../../shared/telegram.mjs';

const LANGS = ['ru', 'en', 'el'];
const MAX_ACTIVE_PER_PHONE = 3;

function storeFor(env) {
  return createStore({
    token: env.GITHUB_TOKEN,
    repo: env.BOOKINGS_REPO,
    path: env.BOOKINGS_PATH || 'bookings.json',
    branch: env.BOOKINGS_BRANCH || 'main'
  });
}

function corsHeaders(req, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  const origin = req.headers.get('Origin') || '';
  return {
    'Access-Control-Allow-Origin': allowed.length === 0 ? '*' : (allowed.includes(origin) ? origin : allowed[0]),
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin'
  };
}

function originAllowed(req, env) {
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map(function (s) { return s.trim(); }).filter(Boolean);
  return allowed.length === 0 || allowed.includes(req.headers.get('Origin') || '');
}

function json(data, status, cors) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, cors)
  });
}

function validate(body) {
  const b = body || {};
  const name = String(b.name || '').trim().replace(/\s+/g, ' ');
  const phone = String(b.phone || '').replace(/[^\d+]/g, '');
  if (!SERVICES[b.service]) { return { error: 'bad_service' }; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '') || !/^\d{2}:\d{2}$/.test(b.time || '')) { return { error: 'bad_slot' }; }
  if (name.length < 2 || name.length > 60) { return { error: 'bad_name' }; }
  if (!/^\+\d{8,15}$/.test(phone) || (phone.startsWith('+30') && !/^\+30[26]\d{9}$/.test(phone))) { return { error: 'bad_phone' }; }
  return { service: b.service, date: b.date, time: b.time, name: name, phone: phone, lang: LANGS.includes(b.lang) ? b.lang : 'ru' };
}

function telegramText(b) {
  const svc = SERVICES[b.service];
  const day = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Athens', weekday: 'short', day: 'numeric', month: 'long' }).format(toUtc(b.date, b.time));
  return [
    '💅 <b>Новая запись</b>',
    '',
    '<b>' + escapeHtml(svc.ru) + '</b> · ' + svc.minutes + ' мин',
    '🗓 ' + escapeHtml(day) + ', <b>' + b.time + '</b>',
    '👤 ' + escapeHtml(b.name),
    '📞 <a href="tel:' + b.phone + '">' + b.phone + '</a>',
    '',
    '<i>Сайт · ' + b.lang.toUpperCase() + ' · SMS-напоминание уйдёт за 24 часа</i>'
  ].join('\n');
}

async function handleBook(req, env, ctx, cors) {
  if (!originAllowed(req, env)) { return json({ error: 'forbidden' }, 403, cors); }
  let body;
  try { body = await req.json(); } catch (e) { return json({ error: 'bad_json' }, 400, cors); }
  if (body && body.website) { return json({ ok: true }, 200, cors); } // honeypot: боты заполняют скрытое поле

  const data = validate(body);
  if (data.error) { return json({ error: data.error }, 400, cors); }

  let booking = null;
  const result = await storeFor(env).update(function (bookings) {
    const now = new Date();
    if (!slotsForDate(data.service, data.date, bookings, now).includes(data.time)) {
      return { error: 'slot_taken', skipWrite: true };
    }
    const active = bookings.filter(function (b) {
      return b.phone === data.phone && b.status !== 'cancelled' && toUtc(b.date, b.time) > now;
    });
    if (active.length >= MAX_ACTIVE_PER_PHONE) { return { error: 'too_many', skipWrite: true }; }

    booking = {
      id: crypto.randomUUID(),
      service: data.service,
      minutes: SERVICES[data.service].minutes,
      date: data.date,
      time: data.time,
      name: data.name,
      phone: data.phone,
      lang: data.lang,
      status: 'confirmed',
      createdAt: now.toISOString(),
      reminderSentAt: null
    };
    bookings.push(booking);
    bookings.sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });
    return {};
  }, 'booking: ' + data.service + ' ' + data.date + ' ' + data.time);

  if (result.error) { return json({ error: result.error }, 409, cors); }

  // Telegram не должен задерживать ответ клиенту и не может «отменить» уже сохранённую запись
  ctx.waitUntil(
    sendTelegram({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, html: telegramText(booking) })
      .catch(function (e) { console.error('telegram', e.message); })
  );

  return json({ ok: true, booking: { id: booking.id, service: booking.service, date: booking.date, time: booking.time, minutes: booking.minutes } }, 200, cors);
}

export default {
  async fetch(req, env, ctx) {
    const cors = corsHeaders(req, env);
    const path = new URL(req.url).pathname.replace(/\/+$/, '');

    if (req.method === 'OPTIONS') { return new Response(null, { status: 204, headers: cors }); }

    try {
      if (req.method === 'GET' && path === '/availability') {
        const { bookings } = await storeFor(env).read();
        return json({ tz: 'Europe/Athens', services: availability(bookings) }, 200, cors);
      }
      if (req.method === 'POST' && path === '/book') {
        return await handleBook(req, env, ctx, cors);
      }
      if (req.method === 'GET' && path === '') {
        return json({ ok: true, service: 'ms-nails-booking' }, 200, cors);
      }
      return json({ error: 'not_found' }, 404, cors);
    } catch (e) {
      console.error(e);
      return json({ error: 'server_error' }, 500, cors);
    }
  }
};
