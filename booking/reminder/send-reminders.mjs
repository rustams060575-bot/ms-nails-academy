/*
  SMS-напоминания за 24 часа до визита (запускается GitHub Actions каждые 15 минут).

  Правило: визит ЗАВТРА по афинскому календарю и до него осталось ≤ 24 часов → одно SMS.
  Так текст «αύριο» всегда правдив, а запуск с опозданием (cron GitHub бывает неточен) ничего не ломает.
  Отправленные помечаются reminderSentAt в bookings.json — повторно SMS не уйдёт.
  При ошибке — до 3 попыток, после последней Мария получает предупреждение в Telegram.

  Логи публичного репозитория видны всем, поэтому имена и номера в лог не пишем.

  ENV: BOOKINGS_TOKEN, BOOKINGS_REPO, [BOOKINGS_PATH], [BOOKINGS_BRANCH]
       SMS_PROVIDER = smsto | twilio
       smsto:  SMSTO_API_KEY, [SMS_SENDER_ID]
       twilio: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM | TWILIO_MESSAGING_SERVICE_SID
       [TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID] — предупреждения о сбоях
       [DRY_RUN=true] — только показать, кому ушло бы SMS
*/

import { SERVICES, athensParts, addDays, toUtc } from '../shared/schedule.mjs';
import { createStore } from '../shared/store.mjs';
import { sendTelegram, escapeHtml } from '../shared/telegram.mjs';

const env = process.env;
const DRY_RUN = env.DRY_RUN === 'true';
const MAX_ATTEMPTS = 3;
const PRUNE_DAYS = 120; // записи старше — удаляются из файла (история остаётся в git)

const TEMPLATE = 'MS Nails Academy: Υπενθύμιση για το ραντεβού σας αύριο {DATE} στις {TIME} ({SERVICE}). Σας περιμένουμε!';

export function smsText(b) {
  const [, m, d] = b.date.split('-');
  const service = (SERVICES[b.service] && SERVICES[b.service].el) || b.service;
  return TEMPLATE.replace('{DATE}', d + '/' + m).replace('{TIME}', b.time).replace('{SERVICE}', service);
}

export function isDue(b, now) {
  if (b.type === 'block' || b.status === 'cancelled' || !b.phone || b.reminderSentAt) { return false; }
  if ((b.reminderAttempts || 0) >= MAX_ATTEMPTS) { return false; }
  if (b.date !== addDays(athensParts(now).date, 1)) { return false; }
  const left = toUtc(b.date, b.time).getTime() - now.getTime();
  return left > 0 && left <= 24 * 3600 * 1000;
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

async function alertMaria(b, err) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) { return; }
  const html = [
    '⚠️ <b>SMS-напоминание не отправлено</b>',
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
  const due = bookings.filter(function (b) { return isDue(b, now); });
  console.log('Athens now: ' + athensParts(now).date + ' ' + athensParts(now).time + ' · bookings: ' + bookings.length + ' · due: ' + due.length + (DRY_RUN ? ' · DRY RUN' : ''));

  const outcome = {};
  for (const b of due) {
    const text = smsText(b);
    if (DRY_RUN) { console.log('[dry] ' + b.id + ' → ' + mask(b.phone) + ' · ' + text); continue; }
    try {
      const msgId = await sendSmsTo(b.phone, text);
      outcome[b.id] = { sentAt: new Date().toISOString() };
      console.log('sent ' + b.id + ' → ' + mask(b.phone) + ' (' + msgId + ')');
    } catch (e) {
      outcome[b.id] = { error: e.message };
      console.error('failed ' + b.id + ' → ' + mask(b.phone) + ': ' + e.message);
      if ((b.reminderAttempts || 0) + 1 >= MAX_ATTEMPTS) { await alertMaria(b, e.message); }
    }
  }

  const pruneBefore = addDays(athensParts(now).date, -PRUNE_DAYS);
  const needsPrune = bookings.some(function (b) { return b.date < pruneBefore; });
  if (DRY_RUN || (Object.keys(outcome).length === 0 && !needsPrune)) { return; }

  // Помечаем результат поверх свежей версии файла — Worker мог добавить записи, пока шли SMS
  await store.update(function (list) {
    for (let i = list.length - 1; i >= 0; i--) {
      const b = list[i];
      if (b.date < pruneBefore) { list.splice(i, 1); continue; }
      const o = outcome[b.id];
      if (!o) { continue; }
      if (o.sentAt) { b.reminderSentAt = o.sentAt; }
      else { b.reminderAttempts = (b.reminderAttempts || 0) + 1; b.reminderError = o.error.slice(0, 200); }
    }
    return {};
  }, 'reminders: ' + Object.keys(outcome).length + ' processed');
}

if (process.argv[1] && process.argv[1].endsWith('send-reminders.mjs')) {
  main().catch(function (e) { console.error(e); process.exit(1); });
}
