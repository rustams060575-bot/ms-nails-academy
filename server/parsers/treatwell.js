/*
  Разбор писем-уведомлений Treatwell (noreply@treatwell.gr) о новой / отменённой брони.

  Тема:  «Έχεις μια νέα κράτηση Treatwell (Κωδ. T2197420607)»
  Тело:  код заказа, услуга, дата и время («5 ноября 2026 в 12:40» / «5 Νοεμβρίου 2026 at 12:40»), стоимость («€20,00»),
         данные клиента: имя, телефон, email.

  parseTreatwellEmail({ from, subject, text, html }) -> { ok:true, kind:'new'|'cancel', code, service, date, time, minutes,
                                                          price, name, phone, email }  |  { ok:false, error }
  Разбор терпимый к языку (русский / греческий / английский) и к вёрстке: метки полей ищутся по нескольким названиям,
  а если метки нет, берутся запасные признаки (телефон, email, € в тексте). Зависимостей нет.
*/
'use strict';

const MONTHS = [   // порядок важен: «март» раньше «май»; греческие названия сравниваются без ударений
  [1, /^(янв|ιανουαρ|jan)/], [2, /^(фев|φεβρουαρ|feb)/], [3, /^(мар|μαρτ|mar)/], [4, /^(апр|απριλ|apr)/],
  [5, /^(ма[яй]|μαι|may)/], [6, /^(июн|ιουν|jun)/], [7, /^(июл|ιουλ|jul)/], [8, /^(авг|αυγουστ|aug)/],
  [9, /^(сен|σεπτεμβρ|sep)/], [10, /^(окт|οκτωβρ|oct)/], [11, /^(ноя|νοεμβρ|nov)/], [12, /^(дек|δεκεμβρ|dec)/]
];

function plain(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }

function monthOf(word) {
  const w = plain(word).replace(/\.$/, '');
  for (let i = 0; i < MONTHS.length; i++) { if (MONTHS[i][1].test(w)) { return MONTHS[i][0]; } }
  return 0;
}

function toText(input) {
  let s = String(input || '');
  s = s.replace(/<(br|\/p|\/div|\/tr|\/li|\/h\d|\/table)\b[^>]*>/gi, '\n').replace(/<\/t[dh]>/gi, ' ');
  s = s.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ');
  s = s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&euro;/g, '€');
  s = s.replace(/&#(\d+);/g, function (_, n) { return String.fromCharCode(Number(n)); });
  return s.split(/\r?\n/).map(function (l) { return l.replace(/[ \t ]+/g, ' ').trim(); }).filter(Boolean).join('\n');
}

const LABELS = {
  service: '(?:услуга|услуги|υπηρεσία|υπηρεσίες|υπηρεσια|service|treatment)',
  name: '(?:клиент|имя|имя клиента|πελάτης|πελάτισσα|όνομα|ονοματεπώνυμο|customer|client|name)',
  duration: '(?:длительность|продолжительность|διάρκεια|duration)'
};

function labeled(text, label) {
  const m = text.match(new RegExp('(?:^|\\n)\\s*' + label + '\\s*[:\\-–]?\\s*(?:\\n\\s*)?([^\\n]{2,80})', 'i'));
  return m ? m[1].trim() : '';
}

function parseTreatwellEmail(mail, opts) {
  const m = mail || {};
  const from = String(m.from || '');
  /* отправитель: сам Treatwell или доверенный адрес, с которого Мария пересылает письма (opts.extraSenders) */
  const trusted = ((opts && opts.extraSenders) || []).some(function (a) { return a && from.toLowerCase().indexOf(String(a).toLowerCase()) >= 0; });
  if (from && !trusted && !/@([a-z0-9-]+\.)*treatwell\.[a-z.]+/i.test(from)) { return { ok: false, error: 'bad_sender' }; }
  const subject = String(m.subject || '');
  const text = toText([m.text, m.html, m.body].filter(Boolean).join('\n'))   // в письмах бывает и text, и html: читаем обе части;
  const all = subject + '\n' + text;

  const code = (all.match(/\bT\d{8,12}\b/) || [])[0] || '';
  if (!code) { return { ok: false, error: 'no_order_code' }; }
  if (/ακυρ|cancel|отмен/.test(plain(subject))) { return { ok: true, kind: 'cancel', code: code }; }

  /* дата: «5 ноября 2026», «5 Νοεμβρίου 2026», «5 November 2026»; время - первое HH:MM после неё */
  const dm = text.match(/(\d{1,2})(?:-?(?:го|st|nd|rd|th))?\s+([A-Za-zА-Яа-яЁёΑ-Ωα-ωά-ώ]{3,})\.?,?\s+(\d{4})/u);
  const month = dm ? monthOf(dm[2]) : 0;
  if (!dm || !month) { return { ok: false, error: 'no_date', code: code }; }
  const after = text.slice(dm.index + dm[0].length);
  const tm = after.match(/(\d{1,2}):(\d{2})/);
  if (!tm || Number(tm[1]) > 23 || Number(tm[2]) > 59) { return { ok: false, error: 'no_time', code: code }; }
  const pad = function (n) { return String(n).padStart(2, '0'); };
  const date = dm[3] + '-' + pad(month) + '-' + pad(dm[1]);
  const time = pad(tm[1]) + ':' + tm[2];

  const price = (text.match(/€\s*(\d+(?:[.,]\d{1,2})?)/) || text.match(/(\d+(?:[.,]\d{1,2})?)\s*€/) || [])[1] || '';
  const email = (text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []).filter(function (e) { return !/treatwell\./i.test(e); })[0] || '';
  const phoneMatch = text.match(/\+\d[\d\s().-]{7,17}\d/);
  const phone = phoneMatch ? phoneMatch[0].replace(/[^\d+]/g, '') : '';

  let name = labeled(text, LABELS.name);
  if (!name || /@|\d{5,}/.test(name)) {   // запасной признак: строка перед телефоном или email
    name = '';
    const lines = text.split('\n');
    const idx = lines.findIndex(function (l) { return (phoneMatch && l.indexOf(phoneMatch[0].trim()) >= 0) || (email && l.indexOf(email) >= 0); });
    for (let i = idx - 1; idx > 0 && i >= Math.max(0, idx - 3); i--) {
      if (/^[^\d@€:]{3,60}$/u.test(lines[i])) { name = lines[i]; break; }
    }
  }
  let service = labeled(text, LABELS.service);
  if (!service) {   // запасной признак: строка прямо перед датой
    const lines = text.split('\n');
    const di = lines.findIndex(function (l) { return l.indexOf(dm[0]) >= 0; });
    if (di > 0) { service = lines[di - 1]; }
  }
  const durText = labeled(text, LABELS.duration) || (text.match(/\b\d{2,3}\s*(?:мин|min|λεπτ)/i) || [''])[0];
  const dur = (durText.match(/(\d{1,3})\s*(?:мин|min|λεπτ|')?/i) || [])[1];
  const minutes = dur && Number(dur) >= 10 && Number(dur) <= 360 ? Number(dur) : 60;

  return {
    ok: true, kind: 'new', code: code, service: service.slice(0, 80), date: date, time: time, minutes: minutes,
    price: price ? price.replace(',', '.') : '', name: name.slice(0, 60), phone: phone, email: email
  };
}

module.exports = { parseTreatwellEmail: parseTreatwellEmail, toText: toText };
