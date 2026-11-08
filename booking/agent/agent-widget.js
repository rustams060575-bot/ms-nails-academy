/*
  ИИ-ассистент записи · клиентский модуль (диалог в стиле iOS).
  Работает только если страница объявила window.MS_AGENT_API (адрес бэкенда: Render в продакшене, локальный сервер при разработке).
  Без переменной модуль ничего не делает, кнопка остаётся скрытой.
  iOS-виджет записи не меняется: ассистент читает его текущий выбор (услуга, дата, время, имя, телефон),
  ведёт клиента до записи в тот же API, а после записи сообщает виджету обновить слоты (событие msagent:booked).
*/
(function () {
  'use strict';
  var API = window.MS_AGENT_API;
  if (!API) { return; }
  API = String(API).replace(/\/$/, '');

  var lang = ['ru', 'en', 'el'].indexOf(document.documentElement.lang) > -1 ? document.documentElement.lang : 'ru';
  var ID_KEY = 'msa-client-id';

  var T = {
    ru: {
      title: 'Ассистент от Nails Academy', sub: 'администратор студии Afina', iname: 'Афина', irole: 'ИИ-ассистент студии Nails Academy', ion: 'на связи', iph: 'Напишите Афине…', close: 'Закрыть', placeholder: 'Напишите сообщение…', send: 'Отправить',
      hello: 'Здравствуйте! Меня зовут Афина, я цифровой администратор студии Nails Academy. Подскажу по услугам и ценам, помогу выбрать удобное время и оформлю запись. Как вас зовут?',
      chips: ['Какие услуги и цены?', 'Хочу записаться на маникюр', 'Ближайшее время на педикюр'],
      err: 'Не удалось получить ответ. Попробуйте ещё раз через минуту.',
      back: 'С возвращением, {name}! Рада вас видеть. Чем могу помочь сегодня?',
      cont: 'Продолжить с моим выбором: {sel}', want: 'Хочу записаться: {sel}.',
      booked: 'Вы записаны', service: 'Услуга', when: 'Когда', duration: 'Длительность', cal: 'Запись сохранена. SMS-напоминание придёт за 24 часа.',
      svc: { manicure: 'Маникюр', pedicure: 'Педикюр', face: 'Уход за лицом' }, min: 'мин', locale: 'ru-RU'
    },
    en: {
      title: 'Assistant by Nails Academy', sub: 'Afina studio administrator', iname: 'Athena', irole: 'AI assistant of Nails Academy studio', ion: 'online', iph: 'Write to Athena…', close: 'Close', placeholder: 'Type a message…', send: 'Send',
      hello: 'Hello! My name is Athena, I’m the digital concierge of Nails Academy studio. I can tell you about services and prices, find a convenient time and book your appointment. May I have your name?',
      chips: ['Services and prices?', 'I’d like to book a manicure', 'Earliest pedicure slot'],
      err: 'Could not get a reply. Please try again in a minute.',
      back: 'Welcome back, {name}! Lovely to see you again. How can I help today?',
      cont: 'Continue with my choice: {sel}', want: 'I’d like to book: {sel}.',
      booked: 'You’re booked', service: 'Service', when: 'When', duration: 'Duration', cal: 'Saved. You will get an SMS reminder 24 hours before.',
      svc: { manicure: 'Manicure', pedicure: 'Pedicure', face: 'Face care' }, min: 'min', locale: 'en-GB'
    },
    el: {
      title: 'Βοηθός από Nails Academy', sub: 'διαχειριστής στούντιο Afina', iname: 'Αθηνά', irole: 'Βοηθός AI του στούντιο Nails Academy', ion: 'συνδεδεμένη', iph: 'Γράψτε στην Αθηνά…', close: 'Κλείσιμο', placeholder: 'Γράψτε ένα μήνυμα…', send: 'Αποστολή',
      hello: 'Γεια σας! Με λένε Αθηνά και είμαι η ψηφιακή υπεύθυνος του στούντιο Nails Academy. Μπορώ να σας πω για υπηρεσίες και τιμές, να βρω ώρα και να κλείσω το ραντεβού σας. Πώς σας λένε;',
      chips: ['Υπηρεσίες και τιμές;', 'Θέλω ραντεβού για μανικιούρ', 'Πρώτη διαθέσιμη ώρα για πεντικιούρ'],
      err: 'Δεν ήταν δυνατή η απάντηση. Δοκιμάστε ξανά σε ένα λεπτό.',
      back: 'Καλώς ήρθατε ξανά, {name}! Χαίρομαι που σας βλέπω. Πώς μπορώ να βοηθήσω σήμερα;',
      cont: 'Συνέχεια με την επιλογή μου: {sel}', want: 'Θα ήθελα να κλείσω ραντεβού: {sel}.',
      booked: 'Το ραντεβού κλείστηκε', service: 'Υπηρεσία', when: 'Πότε', duration: 'Διάρκεια', cal: 'Αποθηκεύτηκε. Θα λάβετε SMS υπενθύμιση 24 ώρες πριν.',
      svc: { manicure: 'Μανικιούρ', pedicure: 'Πεντικιούρ', face: 'Πρόσωπο' }, min: 'λεπ.', locale: 'el-GR'
    }
  }[lang];

  var shown = 0;      // сколько сообщений уже на экране (история теперь хранится на сервере, у гостьи в браузере только её clientId)
  var busy = false;
  var els = null;     // DOM диалога, создаётся при первом открытии
  var lastFocus = null;
  var host = document.querySelector('[data-msa-inline]');   // встроенный чат в блоке записи (вместо всплывающего окна)

  var SVC_IDS = ['manicure', 'pedicure', 'face'];
  /* Текущий выбор клиента в iOS-виджете записи (читаем из DOM, виджет не меняем) */
  function readSelection() {
    var q = function (sel) { return document.querySelector('[data-iw] ' + sel); };
    var sv = q('[data-iw-seg] button[aria-checked="true"]'), d = q('.iw__day[aria-pressed="true"]'), t = q('.iw__time[aria-pressed="true"]');
    var name = q('input[name="name"]'), phone = q('input[name="phone"]'), cc = q('select[name="cc"]');
    var sel = {};
    if (sv && SVC_IDS[+sv.dataset.i]) { sel.service = SVC_IDS[+sv.dataset.i]; }
    if (d && t) { sel.date = d.dataset.date; sel.time = t.dataset.time; }
    if (name && name.value.trim()) { sel.name = name.value.trim(); }
    if (phone && phone.value.replace(/\D/g, '')) { sel.phone = (cc ? cc.value : '') + phone.value.replace(/\D/g, ''); }
    return sel;
  }
  function describe(sel) {
    var day = new Intl.DateTimeFormat(T.locale, { weekday: 'short', day: 'numeric', month: 'long' }).format(new Date(sel.date + 'T12:00:00'));
    return (T.svc[sel.service] || '') + ', ' + day + ', ' + sel.time;
  }

  /* Анонимный идентификатор гостьи: по нему сервер находит её память (имя, предпочтения, прошлые визиты и разговор).
     Тот же ключ использует виджет записи, чтобы визиты попадали в её профиль. */
  var clientId = (function () {
    var id = '';
    try { id = localStorage.getItem(ID_KEY) || ''; } catch (e) {}
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      id = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, function () { return Math.floor(Math.random() * 16).toString(16); });
      try { localStorage.setItem(ID_KEY, id); } catch (e) {}
    }
    return id;
  })();

  /* Открытие чата: подтягиваем с сервера историю и имя; если гостья уже знакома — встречаем по имени */
  function startSession() {
    return fetch(API + '/agent/session?clientId=' + encodeURIComponent(clientId))
      .then(function (r) { if (!r.ok) { throw new Error(r.status); } return r.json(); })
      .catch(function () { return { history: [], returning: false, name: '' }; })
      .then(function (s) {
        var hist = s.history || [];
        hist.forEach(function (m) { bubble(m.role === 'user' ? 'me' : 'bot', m.content, true); shown++; });
        var stale = !s.lastAt || (Date.now() - Date.parse(s.lastAt)) > 6 * 3600 * 1000;
        if (!hist.length) {
          bubble('bot', s.returning && s.name ? T.back.replace('{name}', s.name) : T.hello); shown++;
          chips();
        } else if (s.returning && s.name && stale) {
          bubble('bot', T.back.replace('{name}', s.name));
        }
        selectionChip();
      });
  }

  function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  /* минимальный markdown: **жирный**, списки «- », абзацы. Всё остальное экранируется. */
  function md(text) {
    var out = [], list = [];
    function flush() { if (list.length) { out.push('<ul>' + list.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ul>'); list = []; } }
    String(text).split(/\n/).forEach(function (line) {
      var l = esc(line).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
      var m = l.match(/^\s*(?:[-•*]|\d+[.)])\s+(.*)$/);
      if (m) { list.push(m[1]); } else { flush(); if (l.trim()) { out.push('<p>' + l + '</p>'); } }
    });
    flush();
    return out.join('');
  }

  var ICON_X = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
  var ICON_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M12 19V5M5.5 11.5L12 5l6.5 6.5"/></svg>';
  var ICON_OK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>';

  function build() {
    var root = document.createElement('div');
    root.className = host ? 'msa msa--inline' : 'msa';
    root.setAttribute('data-lenis-prevent', '');
    if (!host) { root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); }
    root.setAttribute('aria-label', host ? T.iname : T.title);
    var head = host
      ? '<div class="msa__head"><div class="msa__ava" aria-hidden="true"></div>' +
          '<div class="msa__who"><b>' + esc(T.iname) + ' <em>AI</em></b><span>' + esc(T.irole) + '</span></div>' +
          '<span class="msa__on"><i></i>' + esc(T.ion) + '</span></div>'
      : '<div class="msa__head"><div class="msa__ava" aria-hidden="true"></div>' +
          '<div class="msa__who"><b>' + esc(T.title) + '</b><span>' + esc(T.sub) + '</span></div>' +
          '<button type="button" class="msa__x" data-msa-close aria-label="' + esc(T.close) + '">' + ICON_X + '</button></div>';
    root.innerHTML =
      (host ? '' : '<div class="msa__back" data-msa-close></div>') +
      '<div class="msa__sheet">' + head +
        '<div class="msa__list" role="log" aria-live="polite"></div>' +
        '<form class="msa__form"><textarea class="msa__in" rows="1" maxlength="1500" placeholder="' + esc(host ? T.iph : T.placeholder) + '" aria-label="' + esc(host ? T.iph : T.placeholder) + '"></textarea>' +
          '<button type="submit" class="msa__send" aria-label="' + esc(T.send) + '" disabled>' + ICON_UP + '</button></form>' +
      '</div>';
    (host || document.body).appendChild(root);
    if (host) { root.dataset.open = 'true'; }
    els = { root: root, list: root.querySelector('.msa__list'), form: root.querySelector('.msa__form'), input: root.querySelector('.msa__in'), send: root.querySelector('.msa__send') };

    root.addEventListener('click', function (e) { if (e.target.closest('[data-msa-close]')) { close(); } });
    document.addEventListener('keydown', function (e) { if (!host && e.key === 'Escape' && els.root.dataset.open === 'true') { close(); } });
    els.input.addEventListener('input', function () {
      els.input.style.height = 'auto';
      els.input.style.height = Math.min(els.input.scrollHeight, 120) + 'px';
      els.send.disabled = busy || !els.input.value.trim();
    });
    els.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); els.form.requestSubmit(); }
    });
    els.form.addEventListener('submit', function (e) {
      e.preventDefault();
      var v = els.input.value.trim();
      if (!v || busy) { return; }
      els.input.value = ''; els.input.style.height = 'auto'; els.send.disabled = true;
      ask(v);
    });

    startSession();
  }

  function scroll() { els.list.scrollTop = els.list.scrollHeight; }
  function bubble(who, text, quiet) {
    var d = document.createElement('div');
    d.className = 'msa__m msa__m--' + who;
    if (who === 'bot') { d.innerHTML = md(text); } else { d.textContent = text; }
    if (quiet) { d.style.animation = 'none'; }
    els.list.appendChild(d); scroll();
    return d;
  }
  /* если клиент уже выбрал в виджете услугу, дату и время — предлагаем продолжить именно с этим выбором */
  function selectionChip() {
    var sel = readSelection();
    if (!(sel.service && sel.date && sel.time) || shown) { return; }
    var old = els.list.querySelector('.msa__chips--sel');
    if (old) { old.remove(); }
    var w = document.createElement('div');
    w.className = 'msa__chips msa__chips--sel';
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'msa__chip msa__chip--sel'; b.textContent = T.cont.replace('{sel}', describe(sel));
    b.addEventListener('click', function () { els.list.querySelectorAll('.msa__chips').forEach(function (x) { x.remove(); }); ask(T.want.replace('{sel}', describe(sel))); });
    w.appendChild(b);
    els.list.insertBefore(w, els.list.querySelector('.msa__chips'));
    scroll();
  }

  function chips() {
    var w = document.createElement('div');
    w.className = 'msa__chips';
    T.chips.forEach(function (c, i) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'msa__chip'; b.textContent = c; b.style.animationDelay = (160 + i * 70) + 'ms';
      b.addEventListener('click', function () { w.remove(); ask(c); });
      w.appendChild(b);
    });
    els.list.appendChild(w); scroll();
  }
  function typing(on) {
    var t = els.list.querySelector('.msa__typing');
    if (on && !t) { t = document.createElement('div'); t.className = 'msa__typing'; t.innerHTML = '<i></i><i></i><i></i>'; els.list.appendChild(t); scroll(); }
    if (!on && t) { t.remove(); }
  }

  function ticket(b) {
    var d = new Date(b.date + 'T12:00:00');
    var when = new Intl.DateTimeFormat(T.locale, { weekday: 'short', day: 'numeric', month: 'long' }).format(d) + ', ' + b.time;
    var w = document.createElement('div');
    w.className = 'msa__ticket';
    w.innerHTML = '<h4>' + ICON_OK + esc(T.booked) + '</h4><dl>' +
      '<div><dt>' + esc(T.service) + '</dt><dd>' + esc(T.svc[b.service] || b.service) + '</dd></div>' +
      '<div><dt>' + esc(T.when) + '</dt><dd>' + esc(when) + '</dd></div>' +
      '<div><dt>' + esc(T.duration) + '</dt><dd>' + b.minutes + ' ' + esc(T.min) + '</dd></div></dl>';
    els.list.appendChild(w); scroll();
  }

  function ask(text) {
    busy = true;
    bubble('me', text); shown++;
    typing(true);
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) { ctl.abort(); } }, 45000);
    fetch(API + '/agent/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: ctl ? ctl.signal : undefined,
      body: JSON.stringify({ clientId: clientId, message: text, lang: lang, context: readSelection() })
    })
      .then(function (r) { return r.json().then(function (j) { if (!r.ok) { throw new Error(j.error || r.status); } return j; }); })
      .then(function (j) {
        typing(false);
        bubble('bot', j.reply); shown++;
        if (j.booking) { ticket(j.booking); window.dispatchEvent(new CustomEvent('msagent:booked', { detail: j.booking })); }
      })
      .catch(function () {
        typing(false);
        var e = document.createElement('div');
        e.className = 'msa__m msa__m--err'; e.textContent = T.err;
        els.list.appendChild(e); scroll();
      })
      .then(function () { clearTimeout(timer); busy = false; els.send.disabled = !els.input.value.trim(); els.input.focus({ preventScroll: true }); });
  }

  function open() {
    if (host) {   // чат уже в блоке записи: просто переводим фокус в поле ввода
      if (!els) { build(); }
      setTimeout(function () { els.input.focus({ preventScroll: true }); }, 400);
      return;
    }
    if (!els) { build(); }
    lastFocus = document.activeElement;
    document.documentElement.classList.add('msa-lock');
    els.root.dataset.open = 'true';
    selectionChip();
    setTimeout(function () { els.input.focus({ preventScroll: true }); scroll(); }, 380);
  }
  function close() {
    if (host) { return; }
    els.root.dataset.open = 'false';
    document.documentElement.classList.remove('msa-lock');
    if (lastFocus && lastFocus.focus) { lastFocus.focus({ preventScroll: true }); }
  }

  /* кнопки вызова: показываем и вешаем обработчик (делегирование — кнопка может перерисовываться) */
  function reveal() { document.querySelectorAll('[data-msa-open]').forEach(function (b) { b.hidden = false; }); }
  document.addEventListener('click', function (e) { if (e.target.closest('[data-msa-open]')) { e.preventDefault(); open(); } });
  reveal();
  if (host) {   // чат строим, когда блок записи подъезжает к экрану
    if ('IntersectionObserver' in window) {
      var io = new IntersectionObserver(function (en) { if (en.some(function (x) { return x.isIntersecting; })) { io.disconnect(); if (!els) { build(); } } }, { rootMargin: '300px' });
      io.observe(host);
    } else { build(); }
  }
  window.MSAgent = { open: open, close: close };
  if (location.hash === '#agent') { open(); }   // удобно для проверки: страница.html#agent
})();
