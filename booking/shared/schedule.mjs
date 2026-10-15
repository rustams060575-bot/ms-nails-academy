/*
  Расписание студии — единый источник правды для Worker (запись) и GitHub Actions (SMS).
  Всё время — по Афинам (Europe/Athens), летнее/зимнее время учитывается автоматически.

  Чтобы поменять график, длительность услуги или шаг сетки — правьте только этот файл.
*/

export const TZ = 'Europe/Athens';

export const SERVICES = {
  manicure: { minutes: 90, ru: 'Маникюр', en: 'Manicure', el: 'Μανικιούρ' },
  pedicure: { minutes: 90, ru: 'Педикюр', en: 'Pedicure', el: 'Πεντικιούρ' },
  face:     { minutes: 60, ru: 'Уход за лицом', en: 'Face care', el: 'Περιποίηση προσώπου' }
};

/* 0 = воскресенье … 6 = суббота; null — выходной */
export const HOURS = {
  0: null,
  1: ['09:00', '21:00'],
  2: ['09:00', '21:00'],
  3: ['09:00', '21:00'],
  4: ['09:00', '21:00'],
  5: ['09:00', '21:00'],
  6: ['09:00', '21:00']
};

export const STEP_MIN = 30;      // шаг сетки времени
export const BUFFER_MIN = 0;     // пауза между клиентами (уборка, стерилизация)
export const LEAD_MIN = 120;     // минимум за сколько минут можно записаться
export const HORIZON_DAYS = 21;  // на сколько дней вперёд открыта запись

const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
});

/* Дата и время по Афинам для момента d: { date: 'YYYY-MM-DD', time: 'HH:MM' } */
export function athensParts(d = new Date()) {
  const p = {};
  fmt.formatToParts(d).forEach(function (x) { p[x.type] = x.value; });
  return { date: p.year + '-' + p.month + '-' + p.day, time: p.hour + ':' + p.minute };
}

function utcOf(date, time) {
  const [y, m, d] = date.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  return Date.UTC(y, m - 1, d, h, mi);
}

/* Афинское 'YYYY-MM-DD' + 'HH:MM' → настоящий момент времени (Date) */
export function toUtc(date, time) {
  const wanted = utcOf(date, time);
  let ts = wanted;
  for (let i = 0; i < 2; i++) {
    const p = athensParts(new Date(ts));
    ts += wanted - utcOf(p.date, p.time);
  }
  return new Date(ts);
}

export function addDays(date, n) {
  const d = new Date(utcOf(date, '12:00') + n * 86400000);
  return d.toISOString().slice(0, 10);
}

export function weekday(date) {
  return new Date(utcOf(date, '12:00')).getUTCDay();
}

export const toMin = function (t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
export const fromMin = function (n) { return String(Math.floor(n / 60)).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0'); };

/* Записи, которые занимают время: всё, кроме отменённых (включая блокировки type:"block") */
function busyIntervals(date, bookings) {
  return bookings
    .filter(function (b) { return b.date === date && b.status !== 'cancelled'; })
    .map(function (b) {
      const start = toMin(b.time);
      const len = b.minutes || (SERVICES[b.service] && SERVICES[b.service].minutes) || 60;
      return [start, start + len + BUFFER_MIN];
    });
}

/* Свободные слоты услуги на конкретный день */
export function slotsForDate(serviceId, date, bookings, now = new Date()) {
  const svc = SERVICES[serviceId];
  const hours = HOURS[weekday(date)];
  if (!svc || !hours) { return []; }
  const today = athensParts(now).date;
  if (date < today || date > addDays(today, HORIZON_DAYS - 1)) { return []; }

  const busy = busyIntervals(date, bookings);
  const earliest = now.getTime() + LEAD_MIN * 60000;
  const open = toMin(hours[0]);
  const close = toMin(hours[1]);
  const out = [];
  for (let t = open; t + svc.minutes <= close; t += STEP_MIN) {
    const end = t + svc.minutes + BUFFER_MIN;
    if (busy.some(function (iv) { return t < iv[1] && end > iv[0]; })) { continue; }
    if (toUtc(date, fromMin(t)).getTime() < earliest) { continue; }
    out.push(fromMin(t));
  }
  return out;
}

/* Свободные слоты всех услуг на весь горизонт записи */
export function availability(bookings, now = new Date()) {
  const today = athensParts(now).date;
  const result = {};
  Object.keys(SERVICES).forEach(function (id) {
    result[id] = [];
    for (let i = 0; i < HORIZON_DAYS; i++) {
      const date = addDays(today, i);
      result[id].push({ date: date, slots: slotsForDate(id, date, bookings, now) });
    }
  });
  return result;
}
