/*
  Напоминания клиентам: за 24 часа и за 12 часов до визита (запускается GitHub Actions каждые 15 минут).

  За 24 часа — визит ЗАВТРА по афинскому календарю и до него осталось ≤ 24 часов → одно сообщение.
  За 12 часов — до визита осталось от 1,5 до 12 часов, запись существовала уже на отметке «12 часов до визита»
  (если клиент записался позже, второе напоминание сразу после записи было бы навязчивым) и сейчас не ночь
  (отправка только с 08:00 до 21:30 по Афинам).
  Отправленные помечаются в bookings.json (reminderSentAt / reminder12SentAt) — повторно ничего не уйдёт.
  При ошибке — до 3 попыток, после последней Мария получает предупреждение в Telegram.

  Канал (REMINDER_CHANNEL):
    sms               — только SMS (по умолчанию)
    whatsapp          — только WhatsApp (шаблон, Meta Cloud API)
    whatsapp_then_sms — сначала WhatsApp, при ошибке SMS

  Логи публичного репозитория видны всем, поэтому имена и номера в лог не пишем.

  ENV: BOOKINGS_TOKEN, BOOKINGS_REPO, [BOOKINGS_PATH], [BOOKINGS_BRANCH]
       [REMINDER_CHANNEL] = sms | whatsapp | whatsapp_then_sms
       SMS_PROVIDER = smsto | twilio
       smsto:  SMSTO_API_KEY, [SMS_SENDER_ID]
       twilio: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM | TWILIO_MESSAGING_SERVICE_SID
       whatsapp: WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_TEMPLATE_REMINDER, [WHATSAPP_REMINDER_LANG=el]
       [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID] — предупреждения о сбоях
       [DRY_RUN=true] — только показать, кому ушло бы сообщение
*/

import { SERVICES, athensParts, addDays, toUtc } from '../shared/schedule.mjs';
import { createStore } from '../shared/store.mjs';
import { sendTelegram, escapeHtml } from '../shared/telegram.mjs';
import { sendWhatsAppTemplate } from '../shared/whatsapp.mjs';

const env = process.env;
const DRY_RUN = env.DRY_RUN === 'true';
const MAX_ATTEMPTS = 3;
const PRUNE_DAYS = 120; // записи старше — удаляются из файла (история остаётся в git)
const HOUR = 3600 * 1000;

/* Два вида напоминаний: в каких полях записи хранится результат */
export const KINDS = {
  h24: { sent: 'reminderSentAt', attempts: 'reminderAttempts', error: 'reminderError', label: '24 ч' },
  h12: { sent: 'reminder12SentAt', attempts: 'reminder12Attempts', error: 'reminder12Error', label: '12 ч' }
};

const serviceEl = function (b) { return (SERVICES[b.service] && SERVICES[b.service].el) || b.service; };
const ddmm = function (b) { const p = b.date.split('-'); return p[2] + '/' + p[1]; };

/* «σήμερα» / «αύριο» + дата: слово всегда соответствует реальному дню визита */
export function dayLabel(b, now) {
  const today = athensParts(now).date;
  return (b.date === today ? 'σήμερα ' : b.date === addDays(today, 1) ? 'αύριο ' : '') + ddmm(b);
}

export function smsText(b, kind = 'h24', now = new Date()) {
  const when = dayLabel(b, now);
  if (kind === 'h12') {
    return 'MS Nails Academy: Μικρή υπενθύμιση, σας περιμένουμε ' + when + ' στις ' + b.time + ' (' + serviceEl(b) + '), Λυκούργου 15, Περιστέρι.';
  }
  return 'MS Nails Academy: Υπενθύμιση για το ραντεβού σας ' + when + ' στις ' + b.time + ' (' + serviceEl(b) + '). Σας περιμένουμε!';
}

/* Параметры WhatsApp-шаблона: {{1}} услуга, {{2}} день, {{3}} время */
export function waParams(b, now = new Date()) {
  return [serviceEl(b), dayLabel(b, now), b.time];
}

export function isDue(b, now, kind = 'h24') {
  const k = KINDS[kind];
  if (b.type === 'block' || b.status === 'cancelled' || !b.phone || b[k.sent]) { return false; }
  if ((b[k.attempts] || 0) >= MAX_ATTEMPTS) { return false; }
  const start = toUtc(b.date, b.time).getTime();
  const left = start - now.getTime();
  if (kind === 'h24') {
    if (b.date !== addDays(athensParts(now).date, 1)) { return false; }
    return left > 0 && left <= 24 * HOUR;
  }
  if (!(left > 1.5 * HOUR && left <= 12 * HOUR)) { return false; }
  if (b.createdAt && new Date(b.createdAt).getTime() > start - 12 * HOUR) { return false; }   // записались уже внутри 12 часов
  const t = athensParts(now).time;
  return t >= '08:00' && t <= '21:30';
}

const mask = function (p) { return p.slice(0, 3) + '•••••' + p.slice(-3); };

async function sendSmsTo(to, text) {
  const provider = (env.SMS_PROVIDER || 'smsto').toLowerCase();

  if (provider === 'twilio') {
    const form = new URLSearchParams({ To: to, Body: text });
    if (env.TWILIO_MESSAGING_SERVICE_SID) { form.set('MessagingServiceSid', env.TWILIO_MESSAGING_SERVICE_SID); }
    else { form.set('From', env.TWILIO_FROM); }
    const auth = Buffer.from(env.TWILIO_ACCOUNT_SID + ':' + env.TWILIO_AUTH_TOKEN).toString('base64');
    const r = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + env.TWILIO_ACCOUNT_SID + '/Messages.json', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form
    });
    const j = await r.json().catch(function () { return {}; });
    if (!r.ok) { throw new Error('Twilio ' + r.status + ': ' + (j.message || '')); }
    return j.sid;
  }

  const r = await fetch('https://api.sms.to/sms/send', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + env.SMSTO_API_KEY, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ message: text, to: to, sender_id: env.SMS_SENDER_ID || 'MSNails' })
  });
  const j = await r.json().catch(function () { return {}; });
  if (!r.ok || j.success === false) { throw new Error('SMS.to ' + r.status + ': ' + (j.message || '')); }
  return j.message_id;
}

function sendWhatsApp(b, now) {
  if (!env.WHATSAPP_TOKEN || !env.WHATSAPP_PHONE_ID || !env.WHATSAPP_TEMPLATE_REMINDER) {
    throw new Error('WhatsApp не настроен (WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, WHATSAPP_TEMPLATE_REMINDER)');
  }
  return sendWhatsAppTemplate({
    token: env.WHATSAPP_TOKEN, phoneId: env.WHATSAPP_PHONE_ID, to: b.phone,
    template: env.WHATSAPP_TEMPLATE_REMINDER, lang: env.WHATSAPP_REMINDER_LANG || 'el', params: waParams(b, now)
  });
}

/* Отправка по выбранному каналу; возвращает строку вида «whatsapp:wamid…» или «sms:id» */
export async function deliver(b, kind, now) {
  const channel = (env.REMINDER_CHANNEL || 'sms').toLowerCase();
  const viaSms = async function () { return 'sms:' + await sendSmsTo(b.phone, smsText(b, kind, now)); };
  const viaWa = async function () { return 'whatsapp:' + await sendWhatsApp(b, now); };
  if (channel === 'whatsapp') { return viaWa(); }
  if (channel === 'whatsapp_then_sms') {
    try { return await viaWa(); } catch (e) { console.error('whatsapp failed, fallback to sms: ' + e.message); return viaSms(); }
  }
  return viaSms();
}

async function alertMaria(b, kind, err) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) { return; }
  const html = [
    '⚠️ <b>Напоминание (' + KINDS[kind].label + ') не отправлено</b>',
    escapeHtml(SERVICES[b.service] ? SERVICES[b.service].ru : b.service) + ' · ' + b.date.split('-').reverse().join('.') + ', ' + b.time,
    '👤 ' + escapeHtml(b.name) + ' · <a href="tel:' + b.phone + '">' + b.phone + '</a>',
    '<i>' + escapeHtml(err) + '</i>',
    'Пожалуйста, напомните клиенту вручную.'
  ].join('\n');
  await sendTelegram({ token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, html: html })
    .catch(function (e) { console.error('telegram alert failed:', e.message); });
}

async function main() {
  if (!env.BOOKINGS_TOKEN) {
    console.log('BOOKINGS_TOKEN не задан — напоминания ещё не настроены (booking/README.md, шаг 6). Пропускаю.');
    return;
  }
  const store = createStore({
    token: env.BOOKINGS_TOKEN,
    repo: env.BOOKINGS_REPO,
    path: env.BOOKINGS_PATH || 'bookings.json',
    branch: env.BOOKINGS_BRANCH || 'main'
  });
  const now = new Date();
  const { bookings } = await store.read();
  const jobs = [];
  Object.keys(KINDS).forEach(function (kind) {
    bookings.forEach(function (b) { if (isDue(b, now, kind)) { jobs.push({ b: b, kind: kind }); } });
  });
  console.log('Athens now: ' + athensParts(now).date + ' ' + athensParts(now).time + ' · bookings: ' + bookings.length + ' · due: ' + jobs.length +
    ' · channel: ' + (env.REMINDER_CHANNEL || 'sms') + (DRY_RUN ? ' · DRY RUN' : ''));

  const outcome = {};   // id → { h24: {...}, h12: {...} }
  for (const { b, kind } of jobs) {
    const tag = KINDS[kind].label;
    if (DRY_RUN) { console.log('[dry ' + tag + '] ' + b.id + ' → ' + mask(b.phone) + ' · ' + smsText(b, kind, now)); continue; }
    outcome[b.id] = outcome[b.id] || {};
    try {
      const msgId = await deliver(b, kind, now);
      outcome[b.id][kind] = { sentAt: new Date().toISOString() };
      console.log('sent ' + tag + ' ' + b.id + ' → ' + mask(b.phone) + ' (' + msgId + ')');
    } catch (e) {
      outcome[b.id][kind] = { error: e.message };
      console.error('failed ' + tag + ' ' + b.id + ' → ' + mask(b.phone) + ': ' + e.message);
      if ((b[KINDS[kind].attempts] || 0) + 1 >= MAX_ATTEMPTS) { await alertMaria(b, kind, e.message); }
    }
  }

  const pruneBefore = addDays(athensParts(now).date, -PRUNE_DAYS);
  const needsPrune = bookings.some(function (b) { return b.date < pruneBefore; });
  if (DRY_RUN || (Object.keys(outcome).length === 0 && !needsPrune)) { return; }

  // Помечаем результат поверх свежей версии файла — сервер мог добавить записи, пока шла отправка
  await store.update(function (list) {
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      if (b.date < pruneBefore) { list.splice(i, 1); continue; }
      const o = outcome[b.id];
      if (!o) { continue; }
      Object.keys(o).forEach(function (kind) {
        const k = KINDS[kind];
        if (o[kind].sentAt) { b[k.sent] = o[kind].sentAt; }
        else { b[k.attempts] = (b[k.attempts] || 0) + 1; b[k.error] = o[kind].error.slice(0, 200); }
      });
    }
    return {};
  }, 'reminders: ' + Object.keys(outcome).length + ' processed');
}

if (process.argv[1] && process.argv[1].endsWith('send-reminders.mjs')) {
  main().catch(function (e) { console.error(e); process.exit(1); });
}
