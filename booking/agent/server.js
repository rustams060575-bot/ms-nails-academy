/*
  MS Nails Academy — сервер ИИ-ассистента записи (локальная разработка и продакшен на Render).

    node booking/agent/server.js        →  http://localhost:8787

  Маршруты:
    GET  /availability      свободные слоты (для iOS-виджета)
    POST /book              запись из виджета
    POST /agent/chat        диалог с Claude (инструменты get_availability, create_booking)
    GET  /healthz           проверка живости (Render health check)
    остальное (только локально, SERVE_SITE=true): сайт из корня проекта + тест-страница

  После каждой новой записи Мария получает сообщение в Telegram (TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID).
  Хранилище: GITHUB_TOKEN + BOOKINGS_REPO → приватный репозиторий (продакшен), иначе локальный файл data/bookings.json.
  Все переменные — в booking/agent/DEPLOY.md и .env.example. Зависимостей нет, нужен Node 20+.
*/
'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'bookings.json');

/* ---------- .env (без dotenv) ---------- */
(function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) { return; }
  fs.readFileSync(f, 'utf8').split(/\r?\n/).forEach(function (line) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith('#') && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  });
})();

const ENV = process.env;
const PROD = ENV.NODE_ENV === 'production' || Boolean(ENV.RENDER);   // Render выставляет RENDER=true сам
const PORT = Number(ENV.PORT) || 8787;
const HOST = ENV.HOST || (PROD ? '0.0.0.0' : '127.0.0.1');
const API_KEY = ENV.ANTHROPIC_API_KEY || '';
const MODEL = ENV.ANTHROPIC_MODEL || 'claude-sonnet-5-5';
/* Сайт раздаётся только локально; в продакшене сайт живёт на GitHub Pages, а здесь — один API */
const SERVE_SITE = ENV.SERVE_SITE ? ENV.SERVE_SITE === 'true' : !PROD;
/* Сайты, которым разрешено обращаться к API из браузера (через запятую). Пусто = без ограничений (только для локалки) */
const ALLOWED_ORIGINS = (ENV.ALLOWED_ORIGINS || '').split(',').map(function (s) { return s.trim().replace(/\/$/, ''); }).filter(Boolean);

let S;           // shared/schedule.mjs (ESM) — подгружается в main()
let TG;          // shared/telegram.mjs
let ghStore = null; // shared/store.mjs → приватный репозиторий (если заданы GITHUB_TOKEN и BOOKINGS_REPO)

/* ---------- прайс из index.html (единый источник правды) ---------- */
function loadPricesText() {
  const src = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const block = src.match(/var PRICES = \[[\s\S]*?\n\];/);
  if (!block) { return '(прайс не найден)'; }
  const PRICES = vm.runInNewContext(block[0].replace('var PRICES =', 'x =') + ';x');
  const dec = function (s) { return String(s).replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&'); };
  const out = [];
  PRICES.forEach(function (cat) {
    out.push('### ' + cat.ru + ' / ' + cat.en + ' / ' + cat.el + '  (id: ' + cat.id + ')');
    cat.rows.forEach(function (r) {
      const n = r[0], dur = r[1];
      const name = function (l) { return dec(n[l].join(', ')); };
      const mins = dur[0] * 60 + dur[1];
      out.push('- ' + name('ru') + ' | ' + name('en') + ' | ' + name('el') + ' — ' + mins + ' мин — ' + r[2] + ' €');
    });
    out.push('');
  });
  return out.join('\n');
}

function systemPrompt() {
  const raw = fs.readFileSync(path.join(__dirname, 'AGENT_INSTRUCTIONS.md'), 'utf8');
  const now = new Date();
  const p = S.athensParts(now);
  const wd = new Intl.DateTimeFormat('ru-RU', { timeZone: S.TZ, weekday: 'long' }).format(now);
  return raw
    .replace('{{PRICES}}', loadPricesText())
    .replace('{{TODAY}}', p.date).replace('{{WEEKDAY}}', wd).replace('{{NOW}}', p.time);
}

/* ---------- локальное хранилище (тот же смысл, что и у GitHub-хранилища) ---------- */
/*
  Два режима хранения:
    • GitHub (продакшен): GITHUB_TOKEN + BOOKINGS_REPO → bookings.json в приватном репозитории — тот же файл, что читают
      SMS-напоминания (GitHub Actions). Файловая система Render временная, поэтому локальный файл там не годится.
    • Файл booking/agent/data/bookings.json (локальная разработка).
*/
let lock = Promise.resolve();
let cache = { at: 0, list: null };
async function readBookings() {
  if (ghStore) {
    if (cache.list && Date.now() - cache.at < 4000) { return cache.list; }   // не дёргаем GitHub на каждый показ слотов
    const r = await ghStore.read();
    cache = { at: Date.now(), list: r.bookings };
    return r.bookings;
  }
  try { return JSON.parse(await fsp.readFile(DATA_FILE, 'utf8') || '[]'); } catch (e) { return []; }
}
function updateBookings(mutate, message) {
  if (ghStore) {
    cache = { at: 0, list: null };
    return ghStore.update(mutate, message || 'booking').then(function (r) { cache = { at: 0, list: null }; return r; });
  }
  const run = lock.then(async function () {
    const list = await readBookings();
    const result = (await mutate(list)) || {};
    if (!result.skipWrite) {
      await fsp.mkdir(DATA_DIR, { recursive: true });
      await fsp.writeFile(DATA_FILE, JSON.stringify(list, null, 2) + '\n', 'utf8');
    }
    return result;
  });
  lock = run.catch(function () {});
  return run;
}

/* ---------- бизнес-логика записи (как в Worker + длительность под услугу) ---------- */
const MAX_ACTIVE_PER_PHONE = 3;
const LANGS = ['ru', 'en', 'el'];

/* «Синтетическая» услуга нужной длительности, чтобы переиспользовать slotsForDate без правок shared/ */
function serviceKey(service, minutes) {
  const base = S.SERVICES[service];
  if (!base) { return null; }
  const m = Number(minutes) || base.minutes;
  if (m === base.minutes) { return service; }
  if (!Number.isInteger(m) || m < 10 || m > 360) { return null; }
  const key = service + '_' + m;
  if (!S.SERVICES[key]) { S.SERVICES[key] = Object.assign({}, base, { minutes: m }); }
  return key;
}

function normalizePhone(raw) {
  let p = String(raw || '').replace(/[^\d+]/g, '');
  if (p.startsWith('00')) { p = '+' + p.slice(2); }
  if (!p.startsWith('+') && /^[26]\d{9}$/.test(p)) { p = '+30' + p; }
  return p.startsWith('+') ? p : '';
}

function validate(b) {
  b = b || {};
  const name = String(b.name || '').trim().replace(/\s+/g, ' ');
  const phone = normalizePhone(b.phone);
  if (!S.SERVICES[b.service] || b.service.indexOf('_') > -1) { return { error: 'bad_service' }; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || '') || !/^\d{2}:\d{2}$/.test(b.time || '')) { return { error: 'bad_slot' }; }
  if (name.length < 2 || name.length > 60) { return { error: 'bad_name' }; }
  if (!/^\+\d{8,15}$/.test(phone) || (phone.startsWith('+30') && !/^\+30[26]\d{9}$/.test(phone))) { return { error: 'bad_phone' }; }
  const key = serviceKey(b.service, b.duration_minutes);
  if (!key) { return { error: 'bad_duration' }; }
  return { service: b.service, key: key, date: b.date, time: b.time, name: name, phone: phone, lang: LANGS.includes(b.lang) ? b.lang : 'ru', source: b.source || 'site' };
}

/* ---------- Telegram: уведомление Марии о новой записи ---------- */
function telegramText(b) {
  const svc = S.SERVICES[b.service];
  const day = new Intl.DateTimeFormat('ru-RU', { timeZone: S.TZ, weekday: 'short', day: 'numeric', month: 'long' }).format(S.toUtc(b.date, b.time));
  const via = b.source === 'ai-agent' ? '🤖 ИИ-ассистент' : 'Сайт (виджет)';
  return [
    '💅 <b>Новая запись</b>',
    '',
    '<b>' + TG.escapeHtml(svc ? svc.ru : b.service) + '</b> · ' + b.minutes + ' мин',
    '🗓 ' + TG.escapeHtml(day) + ', <b>' + b.time + '</b>',
    '👤 ' + TG.escapeHtml(b.name),
    '📞 <a href="tel:' + b.phone + '">' + b.phone + '</a>',
    '',
    '<i>' + via + ' · ' + String(b.lang).toUpperCase() + ' · SMS-напоминание уйдёт за 24 часа</i>'
  ].join('\n');
}

function notifyTelegram(booking) {
  if (!ENV.TELEGRAM_BOT_TOKEN || !ENV.TELEGRAM_CHAT_ID) {
    console.log('  Telegram: пропущено (нет TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)');
    return;
  }
  TG.sendTelegram({ token: ENV.TELEGRAM_BOT_TOKEN, chatId: ENV.TELEGRAM_CHAT_ID, html: telegramText(booking) })
    .then(function () { console.log('  Telegram: уведомление отправлено'); })
    .catch(function (e) { console.error('  Telegram: ' + e.message); });
}

async function createBooking(input) {
  const data = validate(input);
  if (data.error) { return { ok: false, error: data.error }; }
  let booking = null;
  const result = await updateBookings(function (list) {
    const now = new Date();
    if (!S.slotsForDate(data.key, data.date, list, now).includes(data.time)) { return { error: 'slot_taken', skipWrite: true }; }
    const active = list.filter(function (b) { return b.phone === data.phone && b.status !== 'cancelled' && S.toUtc(b.date, b.time) > now; });
    if (active.length >= MAX_ACTIVE_PER_PHONE) { return { error: 'too_many', skipWrite: true }; }
    booking = {
      id: crypto.randomUUID(), service: data.service, minutes: S.SERVICES[data.key].minutes, date: data.date, time: data.time,
      name: data.name, phone: data.phone, lang: data.lang, status: 'confirmed', source: data.source, createdAt: now.toISOString(), reminderSentAt: null
    };
    list.push(booking);
    list.sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });
    return {};
  }, 'booking: ' + data.service + ' ' + data.date + ' ' + data.time + ' (' + data.source + ')');
  if (result.error) { return { ok: false, error: result.error }; }
  console.log('  новая запись [' + data.source + ']: ' + booking.service + ' ' + booking.date + ' ' + booking.time + ' · ' + booking.minutes + ' мин · ' + booking.name + ' ' + booking.phone.replace(/\d(?=\d{3})/g, '•'));
  notifyTelegram(booking);   // не ждём: сбой Telegram не должен отменять уже сохранённую запись
  return { ok: true, booking: { id: booking.id, service: booking.service, date: booking.date, time: booking.time, minutes: booking.minutes } };
}

async function availabilityFor(args) {
  const key = serviceKey(args.service, args.duration_minutes);
  if (!key) { return { error: 'bad_service_or_duration' }; }
  const list = await readBookings();
  const now = new Date();
  const today = S.athensParts(now).date;
  const from = /^\d{4}-\d{2}-\d{2}$/.test(args.from_date || '') && args.from_date > today ? args.from_date : today;
  const days = Math.min(Math.max(Number(args.days) || 7, 1), 14);
  const out = [];
  for (let i = 0; i < S.HORIZON_DAYS && out.length < days; i++) {
    const date = S.addDays(from, i);
    const slots = S.slotsForDate(key, date, list, now);
    if (slots.length) {
      out.push({ date: date, weekday: new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', weekday: 'long' }).format(new Date(date + 'T12:00:00Z')), slots: slots });
    }
  }
  return { minutes: S.SERVICES[key].minutes, days: out, note: out.length ? undefined : 'no free slots in the booking window from this date' };
}

/* ---------- ИИ-агент ---------- */
const TOOLS = [
  {
    name: 'get_availability',
    description: 'Свободные слоты записи по Афинскому времени. Возвращает только дни, где есть свободное время. Вызывай перед тем, как предлагать клиенту время.',
    input_schema: {
      type: 'object',
      properties: {
        service: { type: 'string', enum: ['manicure', 'pedicure', 'face'], description: 'Тип услуги для календаря' },
        from_date: { type: 'string', description: 'YYYY-MM-DD — с какой даты искать (по умолчанию сегодня)' },
        days: { type: 'integer', description: 'Сколько дней со свободным временем вернуть (1–14, по умолчанию 7)' },
        duration_minutes: { type: 'integer', description: 'Длительность визита в минутах, если отличается от стандартной (наращивание, несколько процедур)' }
      },
      required: ['service']
    }
  },
  {
    name: 'create_booking',
    description: 'Создать новую запись. Вызывать ТОЛЬКО после того, как клиент явно подтвердил итог (услуга, дата, время, имя, телефон).',
    input_schema: {
      type: 'object',
      properties: {
        service: { type: 'string', enum: ['manicure', 'pedicure', 'face'] },
        date: { type: 'string', description: 'YYYY-MM-DD' },
        time: { type: 'string', description: 'HH:MM — ровно из слотов get_availability' },
        duration_minutes: { type: 'integer', description: 'Та же длительность, что использовалась в get_availability' },
        name: { type: 'string', description: 'Имя клиента' },
        phone: { type: 'string', description: 'Телефон с кодом страны, например +306912345678' },
        lang: { type: 'string', enum: LANGS, description: 'Язык клиента' }
      },
      required: ['service', 'date', 'time', 'name', 'phone', 'lang']
    }
  }
];

async function runTool(name, input, ctx) {
  if (name === 'get_availability') { return availabilityFor(input || {}); }
  if (name === 'create_booking') {
    const r = await createBooking(Object.assign({}, input, { source: 'ai-agent' }));
    if (r.ok) { ctx.booking = r.booking; }
    return r;
  }
  return { error: 'unknown_tool' };
}

async function callClaude(system, messages) {
  const r = await fetch((process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com') + '/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: system, tools: TOOLS, messages: messages })
  });
  const j = await r.json().catch(function () { return {}; });
  if (!r.ok) { throw new Error('Anthropic ' + r.status + ': ' + ((j.error && j.error.message) || 'error')); }
  return j;
}

async function chat(history) {
  const ctx = { booking: null };
  const system = systemPrompt();
  const messages = history.map(function (m) { return { role: m.role, content: m.content }; });
  for (let step = 0; step < 6; step++) {
    const res = await callClaude(system, messages);
    const text = res.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n').trim();
    if (res.stop_reason !== 'tool_use') { return { reply: text || '…', booking: ctx.booking }; }
    messages.push({ role: 'assistant', content: res.content });
    const results = [];
    for (const b of res.content.filter(function (x) { return x.type === 'tool_use'; })) {
      let out;
      try { out = await runTool(b.name, b.input, ctx); } catch (e) { out = { error: 'tool_failed' }; console.error(e); }
      results.push({ type: 'tool_result', tool_use_id: b.id, content: JSON.stringify(out) });
    }
    messages.push({ role: 'user', content: results });
  }
  return { reply: '…', booking: ctx.booking };
}

/* Демо-режим без ключа: реальные слоты, заготовленный текст */
const DEMO = {
  ru: ['Демо-режим: ключ Anthropic не подключён, поэтому я отвечаю по шаблону. Ближайшее свободное время на маникюр: ', 'Чтобы включить настоящего ассистента, впишите ANTHROPIC_API_KEY в booking/agent/.env и перезапустите сервер.'],
  en: ['Demo mode: no Anthropic key is connected, so I reply from a template. Nearest free manicure time: ', 'To enable the real assistant, put ANTHROPIC_API_KEY into booking/agent/.env and restart the server.'],
  el: ['Demo λειτουργία: δεν υπάρχει κλειδί Anthropic, οπότε απαντώ από πρότυπο. Πλησιέστερη ώρα για μανικιούρ: ', 'Για να ενεργοποιήσετε τον πραγματικό βοηθό, βάλτε ANTHROPIC_API_KEY στο booking/agent/.env και κάντε επανεκκίνηση.']
};
async function demoChat(history, lang) {
  const a = await availabilityFor({ service: 'manicure', days: 2 });
  const L = DEMO[lang] || DEMO.en;
  const slots = (a.days || []).map(function (d) { return d.date + ': ' + d.slots.slice(0, 4).join(', '); }).join(' · ') || '—';
  return { reply: L[0] + slots + '\n\n' + L[1], booking: null };
}

/* ---------- HTTP ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.mp3': 'audio/mpeg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml' };
const PUBLIC_AGENT_FILES = ['/booking/agent/agent-widget.js', '/booking/agent/agent.css', '/booking/agent/agent-test.html'];

function allowedStatic(urlPath) {
  if (PUBLIC_AGENT_FILES.includes(urlPath)) { return true; }
  if (/(^|\/)(\.|node_modules)/.test(urlPath)) { return false; }
  if (/^\/(booking|tools)(\/|$)/.test(urlPath)) { return false; }
  if (/\.(zip|md|mjs)$/i.test(urlPath) || /\/desktop\.ini$/i.test(urlPath)) { return false; }
  return true;
}

const HEAD_INJECT = '<link rel="stylesheet" href="/booking/agent/agent.css"><script>window.MS_AGENT_API=location.origin;</script>';
const BODY_INJECT = '<script src="/booking/agent/agent-widget.js" defer></script>';
function injectHtml(html) {
  return html
    .replace("var BOOKING_API = '';", 'var BOOKING_API = location.origin;')
    .replace('</head>', HEAD_INJECT + '</head>')
    .replace('</body>', BODY_INJECT + '</body>');
}

const hits = new Map();
function limited(ip, bucket, max) {
  const k = ip + bucket, now = Date.now();
  const arr = (hits.get(k) || []).filter(function (t) { return now - t < 60000; });
  arr.push(now); hits.set(k, arr);
  return arr.length > max;
}

function send(res, status, data, extra) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, Object.assign({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }, extra || {}));
  res.end(body);
}

function readJson(req) {
  return new Promise(function (resolve, reject) {
    let size = 0; const chunks = [];
    req.on('data', function (c) { size += c.length; if (size > 64 * 1024) { reject(new Error('too_large')); req.destroy(); } else { chunks.push(c); } });
    req.on('end', function () { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(new Error('bad_json')); } });
    req.on('error', reject);
  });
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const fwd = PROD ? String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() : '';
  const ip = fwd || req.socket.remoteAddress || '';
  const origin = req.headers.origin || '';
  const originOk = !ALLOWED_ORIGINS.length || !origin || ALLOWED_ORIGINS.includes(origin) || (SERVE_SITE && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin));
  if (origin && originOk && ALLOWED_ORIGINS.length) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.setHeader('Vary', 'Origin');
  }
  try {
    if (req.method === 'OPTIONS') { res.writeHead(originOk ? 204 : 403); return res.end(); }
    if (req.method === 'GET' && (url.pathname === '/healthz' || (!SERVE_SITE && url.pathname === '/'))) {
      return send(res, 200, { ok: true, service: 'ms-nails-agent', mode: API_KEY ? 'claude' : 'demo', storage: ghStore ? 'github' : 'file', telegram: Boolean(ENV.TELEGRAM_BOT_TOKEN && ENV.TELEGRAM_CHAT_ID) });
    }
    if (!originOk && /^\/(availability|book|agent\/)/.test(url.pathname)) { return send(res, 403, { error: 'forbidden' }); }
    if (req.method === 'GET' && url.pathname === '/availability') {
      return send(res, 200, { tz: S.TZ, services: S.availability(await readBookings()) });
    }
    if (req.method === 'POST' && url.pathname === '/book') {
      if (limited(ip, 'book', 20)) { return send(res, 429, { error: 'rate_limited' }); }
      const body = await readJson(req);
      if (body.website) { return send(res, 200, { ok: true }); } // honeypot
      const r = await createBooking(Object.assign({}, body, { source: 'site' }));
      return send(res, r.ok ? 200 : (r.error === 'slot_taken' || r.error === 'too_many' ? 409 : 400), r.ok ? r : { error: r.error });
    }
    if (req.method === 'POST' && url.pathname === '/agent/chat') {
      if (limited(ip, 'chat', 20)) { return send(res, 429, { error: 'rate_limited' }); }
      const body = await readJson(req);
      const lang = LANGS.includes(body.lang) ? body.lang : 'ru';
      const history = (Array.isArray(body.messages) ? body.messages : []).slice(-30)
        .filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim(); })
        .map(function (m) { return { role: m.role, content: m.content.slice(0, 1500) }; });
      while (history.length && history[0].role !== 'user') { history.shift(); }
      if (!history.length || history[history.length - 1].role !== 'user') { return send(res, 400, { error: 'bad_messages' }); }
      const out = API_KEY ? await chat(history) : await demoChat(history, lang);
      return send(res, 200, Object.assign({ demo: !API_KEY }, out));
    }
    if (req.method === 'GET' && url.pathname === '/agent/status') {
      return send(res, 200, { ok: true, demo: !API_KEY, model: API_KEY ? MODEL : null });
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') { return send(res, 405, { error: 'method_not_allowed' }); }

    // статика (только локально: в продакшене сайт отдаёт GitHub Pages)
    if (!SERVE_SITE) { return send(res, 404, { error: 'not_found' }); }
    let p = decodeURIComponent(url.pathname);
    if (p.endsWith('/')) { p += 'index.html'; }
    if (!allowedStatic(p)) { return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' }); }
    let file = path.join(ROOT, p);
    if (!file.startsWith(ROOT + path.sep)) { return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' }); }
    let st = await fsp.stat(file).catch(function () { return null; });
    if (st && st.isDirectory()) { file = path.join(file, 'index.html'); st = await fsp.stat(file).catch(function () { return null; }); }
    if (!st) { return send(res, 404, 'Not found', { 'Content-Type': 'text/plain' }); }
    const ext = path.extname(file).toLowerCase();
    const type = MIME[ext] || 'application/octet-stream';
    if (ext === '.html') {
      return send(res, 200, injectHtml(await fsp.readFile(file, 'utf8')), { 'Content-Type': type });
    }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
    if (req.method === 'HEAD') { return res.end(); }
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error('[error]', e.message);
    const client = e.message === 'bad_json' || e.message === 'too_large';
    if (!res.headersSent) { send(res, client ? 400 : 500, { error: client ? e.message : 'server_error' }); }
  }
}

(async function main() {
  const toUrl = function (f) { return require('node:url').pathToFileURL(path.join(ROOT, 'booking', 'shared', f)).href; };
  S = await import(toUrl('schedule.mjs'));
  TG = await import(toUrl('telegram.mjs'));
  if (ENV.GITHUB_TOKEN && ENV.BOOKINGS_REPO) {
    const { createStore } = await import(toUrl('store.mjs'));
    ghStore = createStore({ token: ENV.GITHUB_TOKEN, repo: ENV.BOOKINGS_REPO, path: ENV.BOOKINGS_PATH || 'bookings.json', branch: ENV.BOOKINGS_BRANCH || 'main' });
  } else if (PROD) {
    console.warn('  ВНИМАНИЕ: GITHUB_TOKEN/BOOKINGS_REPO не заданы — записи лежат во временном файле и пропадут при перезапуске!');
  }
  http.createServer(handler).listen(PORT, HOST, function () {
    console.log('\n  MS Nails Academy · ИИ-ассистент записи (' + (PROD ? 'продакшен' : 'локально') + ')');
    console.log('  Адрес:         http://' + (HOST === '0.0.0.0' ? 'localhost' : HOST) + ':' + PORT + '/');
    if (SERVE_SITE) { console.log('  Тест-страница: http://localhost:' + PORT + '/booking/agent/agent-test.html'); }
    console.log('  ИИ:            ' + (API_KEY ? 'Claude (' + MODEL + ')' : 'ДЕМО — нет ANTHROPIC_API_KEY'));
    console.log('  Хранилище:     ' + (ghStore ? 'GitHub · ' + ENV.BOOKINGS_REPO : path.relative(ROOT, DATA_FILE) + ' (локальный файл)'));
    console.log('  Telegram:      ' + (ENV.TELEGRAM_BOT_TOKEN && ENV.TELEGRAM_CHAT_ID ? 'включён' : 'выключен (нет TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)'));
    console.log('  CORS:          ' + (ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : 'не ограничен') + '\n');
  });
})();
