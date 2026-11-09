/*
  Единый табель занятости студии: записи с сайта / от ИИ-агента Афины и внешние брони (Treatwell, email, календарь).

  Хранилище — тот же список записей, что читают виджет на сайте, Афина и SMS-напоминания
  (booking/agent/data/bookings.json локально, bookings.json в приватном репозитории на Render).
  Внешняя бронь хранится как запись { type: 'block', source: 'treatwell', ... }: расписание (shared/schedule.mjs)
  уже считает любую неотменённую запись занятой, поэтому слот исчезает и из виджета, и из ответов Афины, а клиенту
  не уходят напоминания (у блока нет телефона и type = 'block').

  Модуль не знает, где лежат данные: чтение и запись ему передают (read / update), так что он работает
  и с файлом, и с GitHub. Без этих аргументов (для тестов) использует локальный файл booking/agent/data/bookings.json.

  Публичные функции:
    checkAvailability(date, time, opts)          свободен ли слот -> { available, reason?, conflicts? }
    bookSlot(date, time, source, clientData)     занять слот -> { ok, booking, conflicts } | { ok:false, error }
    cancelExternal(source, externalId)           снять внешнюю бронь (отмена на Treatwell)
    freeSlots(serviceKey, date, now, list?)      свободные слоты услуги на день (для виджета и Афины)
    listBusy(fromDate, toDate)                   занятые слоты с источником
    getConfig() / updateConfig(patch) / withConfig(fn)   настройки студии: admin_chat_id (Telegram Марии), activation_token и др.
    adminChatId()                                Telegram chat id администратора (из конфигурации)
*/
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const SOURCES = {
  site: 'Сайт',
  'ai-agent': 'Сайт',
  treatwell: 'Treatwell',
  email: 'Email',
  calendar: 'Календарь'
};
const EXTERNAL = ['treatwell', 'email', 'calendar'];
const ALIASES = { 'сайт': 'site', 'календарь': 'calendar', 'google calendar': 'calendar', 'ical': 'calendar', 'ics': 'calendar', 'почта': 'email', 'e-mail': 'email' };

function normalizeSource(raw) {
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  const key = ALIASES[s] || s;
  return Object.prototype.hasOwnProperty.call(SOURCES, key) ? key : null;
}
const labelOf = function (source) { return SOURCES[source] || source; };
const isExternal = function (source) { return EXTERNAL.indexOf(source) > -1; };

const DEFAULT_FILE = path.join(__dirname, '..', 'booking', 'agent', 'data', 'bookings.json');
const DEFAULT_CONFIG_FILE = path.join(__dirname, '..', 'booking', 'agent', 'data', 'config.json');

/* запасной вариант без внешних read/update: локальный файл + очередь, чтобы записи не затирали друг друга */
function fileAdapter(file) {
  let lock = Promise.resolve();
  async function read() {
    try { return JSON.parse((await fsp.readFile(file, 'utf8')) || '[]'); } catch (e) { return []; }
  }
  function update(mutate) {
    const run = lock.then(async function () {
      const list = await read();
      const result = (await mutate(list)) || {};
      if (!result.skipWrite) {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        await fsp.writeFile(file, JSON.stringify(list, null, 2) + '\n', 'utf8');
      }
      return result;
    });
    lock = run.catch(function () {});
    return run;
  }
  return { read: read, update: update };
}

/* конфигурация студии: один JSON-объект (локально — файл, на Render — файл config.json в приватном репозитории) */
function configFileAdapter(file) {
  let lock = Promise.resolve();
  async function read() {
    try { const j = JSON.parse((await fsp.readFile(file, 'utf8')) || '{}'); return j && typeof j === 'object' && !Array.isArray(j) ? j : {}; } catch (e) { return {}; }
  }
  function update(mutate) {
    const run = lock.then(async function () {
      const cfg = await read();
      await mutate(cfg);
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(file, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      return cfg;
    });
    lock = run.catch(function () {});
    return run;
  }
  return { read: read, update: update };
}

/*
  createBookingState({ schedule, read, update, configRead, configUpdate, log })
    schedule — модуль shared/schedule.mjs (уже импортированный сервером)
    read()   — Promise<массив записей>
    update(mutate, message) — применяет mutate(list) к списку и сохраняет (mutate меняет массив на месте)
*/
function createBookingState(opts) {
  const S = opts.schedule;
  if (!S) { throw new Error('bookingState: schedule is required'); }
  const fallback = opts.read && opts.update ? null : fileAdapter(opts.file || DEFAULT_FILE);
  const read = opts.read || fallback.read;
  const update = opts.update || fallback.update;
  const log = opts.log || console.log;
  const cfgFallback = opts.configRead && opts.configUpdate ? null : configFileAdapter(opts.configFile || DEFAULT_CONFIG_FILE);
  const configRead = opts.configRead || cfgFallback.read;
  const configUpdate = opts.configUpdate || cfgFallback.update;

  const isTime = function (t) { return /^([01]\d|2[0-3]):[0-5]\d$/.test(t || ''); };
  const isDate = function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d || '') && !isNaN(Date.parse(d + 'T12:00:00Z')); };

  function lengthOf(b) {
    return b.minutes || (S.SERVICES[b.service] && S.SERVICES[b.service].minutes) || 60;
  }

  /* неотменённые записи дня, пересекающиеся с интервалом [start, end) в минутах */
  function overlapping(list, date, start, end) {
    return list.filter(function (b) {
      if (b.date !== date || b.status === 'cancelled') { return false; }
      const bs = S.toMin(b.time);
      const be = bs + lengthOf(b) + S.BUFFER_MIN;
      return start < be && end > bs;
    });
  }

  const brief = function (b) {
    return { id: b.id, time: b.time, minutes: lengthOf(b), source: b.source || 'site', sourceLabel: labelOf(b.source || 'site'), name: b.name || '' };
  };

  /* чистая проверка по готовому списку (без чтения хранилища) */
  function check(list, date, time, o) {
    o = o || {};
    if (!isDate(date) || !isTime(time)) { return { available: false, reason: 'bad_slot' }; }
    const minutes = Number(o.minutes) || S.STEP_MIN;
    const start = S.toMin(time);
    if (!o.ignoreHours) {
      const hours = S.HOURS[S.weekday(date)];
      if (!hours) { return { available: false, reason: 'closed' }; }
      if (start < S.toMin(hours[0]) || start + minutes > S.toMin(hours[1])) { return { available: false, reason: 'outside_hours' }; }
    }
    if (o.enforceLead) {
      const now = o.now || new Date();
      const today = S.athensParts(now).date;
      if (S.toUtc(date, time).getTime() < now.getTime() + S.LEAD_MIN * 60000) { return { available: false, reason: date < today ? 'past' : 'too_soon' }; }
      if (date > S.addDays(today, S.HORIZON_DAYS - 1)) { return { available: false, reason: 'beyond_horizon' }; }
    }
    const conflicts = overlapping(list, date, start, start + minutes + S.BUFFER_MIN);
    if (conflicts.length) { return { available: false, reason: 'busy', conflicts: conflicts.map(brief) }; }
    return { available: true };
  }

  /* checkAvailability(date, time, { minutes, enforceLead }) - свободен ли слот с учётом всех источников, включая Treatwell */
  async function checkAvailability(date, time, o) {
    return check(await read(), date, time, o);
  }

  /*
    bookSlot(date, time, source, clientData)
      source: 'site' | 'treatwell' | 'email' | 'calendar'
      clientData: { name, phone, service, minutes, externalId, note, lang, clientId }
    Внешняя бронь уже случилась на другой площадке, поэтому её всегда записываем (даже если слот пересёкся с чьей-то
    записью) и возвращаем conflicts - администратору нужно разобраться. Запись с сайта при занятом слоте отклоняется.
  */
  async function bookSlot(date, time, source, clientData) {
    const src = normalizeSource(source);
    if (!src) { return { ok: false, error: 'bad_source' }; }
    const c = clientData || {};
    if (!isDate(date) || !isTime(time)) { return { ok: false, error: 'bad_slot' }; }
    const external = isExternal(src);
    const minutes = Math.round(Number(c.minutes) || (S.SERVICES[c.service] && S.SERVICES[c.service].minutes) || 60);
    if (minutes < 10 || minutes > 360) { return { ok: false, error: 'bad_duration' }; }
    const name = String(c.name == null ? '' : c.name).replace(/\s+/g, ' ').trim().slice(0, 60);
    const externalId = c.externalId ? String(c.externalId).slice(0, 80) : '';
    const out = await update(function (list) {
      if (external && externalId) {
        const dup = list.find(function (b) { return b.source === src && b.externalId === externalId && b.status !== 'cancelled'; });
        if (dup) { return { duplicate: true, booking: dup, conflicts: [], skipWrite: true }; }
      }
      const verdict = check(list, date, time, { minutes: minutes, enforceLead: !external, ignoreHours: external });
      if (!external && !verdict.available) { return { error: verdict.reason === 'busy' ? 'slot_taken' : verdict.reason, skipWrite: true }; }
      const now = new Date();
      const entry = {
        id: crypto.randomUUID(),
        minutes: minutes, date: date, time: time,
        name: name || (external ? labelOf(src) : ''),
        status: 'confirmed', source: src, sourceLabel: labelOf(src),
        createdAt: now.toISOString()
      };
      if (c.service && S.SERVICES[c.service]) { entry.service = c.service; }
      if (external) {
        entry.type = 'block';
        if (externalId) { entry.externalId = externalId; }
        if (c.note) { entry.note = String(c.note).slice(0, 200); }
        if (c.serviceName) { entry.serviceName = String(c.serviceName).slice(0, 80); }
        if (c.phone) { entry.phone = String(c.phone).slice(0, 30); }
        if (c.email) { entry.email = String(c.email).slice(0, 80); }
        if (c.price) { entry.price = String(c.price).slice(0, 12); }
      } else {
        entry.phone = c.phone || '';
        entry.lang = c.lang || 'ru';
        entry.reminderSentAt = null;
        entry.reminder12SentAt = null;
        if (c.clientId) { entry.clientId = c.clientId; }
      }
      list.push(entry);
      list.sort(function (a, b) { return (a.date + a.time).localeCompare(b.date + b.time); });
      return { booking: entry, conflicts: external && !verdict.available ? (verdict.conflicts || []) : [] };
    }, 'sync: ' + src + ' ' + date + ' ' + time);
    if (out.error) { return { ok: false, error: out.error }; }
    if (out.duplicate) { return { ok: true, duplicate: true, booking: out.booking, conflicts: [] }; }

    if (external) {
      const end = S.fromMin(S.toMin(time) + minutes);
      log('[СИНХРОНИЗАЦИЯ] Новая запись из ' + labelOf(src) + ' -> Слот ' + time + ' заблокирован.');
      log('  ' + date + ' · ' + time + '–' + end + ' · ' + (out.booking.name || '—') + (externalId ? ' · id ' + externalId : ''));
      out.conflicts.forEach(function (x) {
        log('[СИНХРОНИЗАЦИЯ] ВНИМАНИЕ: слот ' + time + ' из ' + labelOf(src) + ' пересекается с записью ' + x.time + ' (' + x.sourceLabel + ', ' + (x.name || '—') + ') — нужна ручная проверка.');
      });
    }
    return { ok: true, booking: out.booking, conflicts: out.conflicts };
  }

  /* отмена внешней брони (клиент отменил визит на Treatwell): слот снова свободен */
  async function cancelExternal(source, externalId) {
    const src = normalizeSource(source);
    if (!src || !isExternal(src) || !externalId) { return { ok: false, error: 'bad_request' }; }
    const out = await update(function (list) {
      const b = list.find(function (x) { return x.source === src && x.externalId === String(externalId) && x.status !== 'cancelled'; });
      if (!b) { return { found: false, skipWrite: true }; }
      b.status = 'cancelled';
      b.cancelledAt = new Date().toISOString();
      return { found: true, booking: b };
    }, 'sync: cancel ' + src + ' ' + externalId);
    if (out.found) { log('[СИНХРОНИЗАЦИЯ] Отмена в ' + labelOf(src) + ' -> Слот ' + out.booking.time + ' (' + out.booking.date + ') освобождён.'); }
    return { ok: true, found: out.found, booking: out.booking };
  }

  /*
    Свободные слоты услуги на день: расписание (часы, длительность, LEAD) + проверка каждого слота через check().
    Именно этим пользуются Афина и демо-режим, поэтому занятое на Treatwell они не предлагают.
  */
  async function freeSlots(serviceKey, date, now, list) {
    const l = list || (await read());
    const svc = S.SERVICES[serviceKey];
    if (!svc) { return []; }
    return S.slotsForDate(serviceKey, date, l, now || new Date()).filter(function (t) {
      return check(l, date, t, { minutes: svc.minutes }).available;
    });
  }

  async function listBusy(fromDate, toDate) {
    const list = await read();
    return list
      .filter(function (b) { return b.status !== 'cancelled' && (!fromDate || b.date >= fromDate) && (!toDate || b.date <= toDate); })
      .map(function (b) { return Object.assign({ date: b.date, type: b.type || 'booking' }, brief(b)); });
  }

  /* конфигурация: admin_chat_id, admin_name, admin_bound_at ... */
  async function getConfig() { return Object.assign({}, await configRead()); }
  async function updateConfig(patch) {
    return configUpdate(function (cfg) { Object.assign(cfg, patch); });
  }
  /* атомарное чтение-изменение конфигурации: fn(cfg) меняет объект на месте и возвращает результат */
  async function withConfig(fn) {
    let result;
    await configUpdate(function (cfg) { result = fn(cfg); });
    return result;
  }
  async function adminChatId() { return String((await configRead()).admin_chat_id || ''); }

  return { getConfig: getConfig, updateConfig: updateConfig, withConfig: withConfig, adminChatId: adminChatId, checkAvailability: checkAvailability, bookSlot: bookSlot, cancelExternal: cancelExternal, freeSlots: freeSlots, listBusy: listBusy, normalizeSource: normalizeSource, isExternal: isExternal, labelOf: labelOf };
}

module.exports = { createBookingState: createBookingState, normalizeSource: normalizeSource, SOURCES: SOURCES, EXTERNAL: EXTERNAL };
