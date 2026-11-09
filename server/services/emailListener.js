/*
  Фоновый опрос почтового ящика Афины по IMAP: раз в N секунд (по умолчанию 60) берёт НОВЫЕ (UNSEEN) письма от
  noreply@treatwell.gr, отдаёт их в обработчик (разбор -> bookingState -> Telegram) и помечает прочитанными.
  Зависимостей нет: небольшой IMAP-клиент на node:tls и разбор MIME (multipart, quoted-printable, base64, кодировки).

  Gmail: нужен включённый IMAP и «пароль приложения» (обычный пароль аккаунта IMAP не принимает, если включена
  двухэтапная аутентификация; а для новых ящиков она обязательна для паролей приложений).
*/
'use strict';

const tls = require('node:tls');

/* ---------- MIME ---------- */
function decodeBytes(buf, charset) {
  try { return new TextDecoder(String(charset || 'utf-8').toLowerCase()).decode(buf); } catch (e) { return Buffer.from(buf).toString('utf8'); }
}
function qpBytes(str) {
  const s = str.replace(/=\r?\n/g, '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(s.substr(i + 1, 2))) { out.push(parseInt(s.substr(i + 1, 2), 16)); i += 2; }
    else { out.push(s.charCodeAt(i) & 255); }
  }
  return Buffer.from(out);
}
function decodeWords(v) {   // RFC 2047: =?utf-8?B?...?= / =?windows-1253?Q?...?=
  return String(v || '').replace(/\?=\s+=\?/g, '?==?').replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, function (_, cs, enc, data) {
    const bytes = /b/i.test(enc) ? Buffer.from(data, 'base64') : qpBytes(data.replace(/_/g, ' '));
    return decodeBytes(bytes, cs);
  });
}
function splitPart(raw) {
  const m = raw.match(/\r?\n\r?\n/);
  const cut = m ? m.index : raw.length;
  const head = raw.slice(0, cut).replace(/\r?\n[ \t]+/g, ' ');
  const headers = {};
  head.split(/\r?\n/).forEach(function (l) { const i = l.indexOf(':'); if (i > 0) { headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); } });
  return { headers: headers, body: m ? raw.slice(cut + m[0].length) : '' };
}
function params(h) {
  const out = {};
  String(h || '').replace(/;\s*([\w-]+)\s*=\s*("([^"]*)"|[^;\s]+)/g, function (_, k, v, q) { out[k.toLowerCase()] = q !== undefined ? q : v; return ''; });
  return out;
}
function walk(raw, acc) {
  const part = splitPart(raw);
  const ct = String(part.headers['content-type'] || 'text/plain').toLowerCase();
  const type = ct.split(';')[0].trim();
  if (type.indexOf('multipart/') === 0) {
    const b = params(part.headers['content-type']).boundary;
    if (!b) { return; }
    part.body.split('--' + b).slice(1).forEach(function (chunk) {
      if (chunk.indexOf('--') === 0) { return; }          // закрывающий разделитель
      walk(chunk.replace(/^\r?\n/, ''), acc);
    });
    return;
  }
  if ((type !== 'text/plain' && type !== 'text/html') || /attachment/i.test(part.headers['content-disposition'] || '')) { return; }
  const enc = String(part.headers['content-transfer-encoding'] || '7bit').toLowerCase();
  const bytes = enc === 'base64' ? Buffer.from(part.body.replace(/\s+/g, ''), 'base64')
    : enc === 'quoted-printable' ? qpBytes(part.body) : Buffer.from(part.body, 'latin1');
  const text = decodeBytes(bytes, params(ct).charset);
  if (type === 'text/html') { acc.html += text + '\n'; } else { acc.text += text + '\n'; }
}
/* parseMail(Buffer) -> { from, subject, text, html } */
function parseMail(buf) {
  const raw = buf.toString('latin1');
  const top = splitPart(raw);
  const acc = { text: '', html: '' };
  walk(raw, acc);
  return { from: decodeWords(top.headers.from), subject: decodeWords(top.headers.subject), text: acc.text, html: acc.html };
}

/* ---------- IMAP ---------- */
function quote(s) { return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'; }

function connect(host, port) {
  return new Promise(function (resolve, reject) {
    const sock = tls.connect({ host: host, port: port, servername: host });
    let buf = Buffer.alloc(0), pending = null, n = 0, closed = false;
    const fail = function (e) { closed = true; if (pending) { const p = pending; pending = null; clearTimeout(p.timer); p.reject(e); } };
    /* разбор накопленного ответа: строки + литералы {N}; готово, когда пришла строка с нужным тегом (или первая строка-приветствие) */
    function scan(tag) {
      let pos = 0;
      const entries = [];
      while (pos < buf.length) {
        let text = '';
        const lits = [];
        for (;;) {
          const eol = buf.indexOf('\r\n', pos);
          if (eol < 0) { return null; }
          const line = buf.toString('latin1', pos, eol);
          pos = eol + 2;
          text += line;
          const m = line.match(/\{(\d+)\}$/);
          if (!m) { break; }
          const len = Number(m[1]);
          if (buf.length < pos + len) { return null; }
          lits.push(buf.subarray(pos, pos + len));
          pos += len;
        }
        entries.push({ text: text, lits: lits });
        if (tag === null || text.indexOf(tag + ' ') === 0) { return { entries: entries, used: pos, tagged: text }; }
      }
      return null;
    }
    function pump() {
      if (!pending) { return; }
      const r = scan(pending.tag);
      if (!r) { return; }
      buf = buf.subarray(r.used);
      const p = pending; pending = null; clearTimeout(p.timer);
      p.resolve({ ok: p.tag === null || r.tagged.indexOf(p.tag + ' OK') === 0, status: r.tagged, entries: r.entries });
    }
    function wait(tag, send) {
      return new Promise(function (res, rej) {
        if (closed) { rej(new Error('соединение закрыто')); return; }
        pending = { tag: tag, resolve: res, reject: rej, timer: setTimeout(function () { fail(new Error('IMAP: нет ответа за 30 с')); sock.destroy(); }, 30000) };
        if (send) { sock.write(send); }
        pump();
      });
    }
    sock.on('data', function (d) { buf = Buffer.concat([buf, d]); pump(); });
    sock.on('error', function (e) { fail(e); reject(e); });
    sock.on('close', function () { fail(new Error('соединение закрыто сервером')); });
    sock.setTimeout(45000, function () { sock.destroy(new Error('IMAP: таймаут соединения')); });
    sock.once('secureConnect', function () {
      wait(null).then(function (g) {
        if (!g.ok && g.status.indexOf('* OK') !== 0) { throw new Error('IMAP: приветствие сервера: ' + g.status); }
        resolve({
          cmd: function (c) { const t = 'A' + (++n); return wait(t, t + ' ' + c + '\r\n'); },
          close: function () { closed = true; sock.destroy(); }
        });
      }).catch(reject);
    });
  });
}

/* ---------- слушатель ---------- */
function createEmailListener(cfg) {
  const user = cfg.user, password = cfg.password;
  const host = cfg.host || 'imap.gmail.com';
  const port = Number(cfg.port) || 993;
  const everyMs = Math.max(15, Number(cfg.intervalSec) || 60) * 1000;
  const senders = [].concat(cfg.from || 'noreply@treatwell.gr').filter(Boolean);   // Treatwell и, при пересылке, адреса Марии
  const fromFilter = senders.join(', ');
  /* IMAP: префиксная запись OR FROM a OR FROM b FROM c */
  const fromCriteria = senders.length === 1 ? 'FROM ' + quote(senders[0])
    : senders.slice(0, -1).map(function (a) { return 'OR FROM ' + quote(a); }).join(' ') + ' FROM ' + quote(senders[senders.length - 1]);
  const onMail = cfg.onMail;                               // async (mail) -> void; исключение = временная ошибка (письмо останется непрочитанным)
  const log = cfg.log || console.log;
  let timer = null, running = false, lastError = '', ok = false, polls = 0, processed = 0;

  async function pollOnce() {
    const c = await connect(host, port);
    let uids = [];
    const done = [];
    try {
      let r = await c.cmd('LOGIN ' + quote(user) + ' ' + quote(password));
      if (!r.ok) { const e = new Error(r.status.replace(/^A\d+\s+/, '')); e.auth = true; throw e; }
      r = await c.cmd('SELECT INBOX');
      if (!r.ok) { throw new Error('IMAP: не открылась папка INBOX: ' + r.status); }
      r = await c.cmd('UID SEARCH UNSEEN ' + fromCriteria);
      const line = r.entries.find(function (e) { return e.text.indexOf('* SEARCH') === 0; });
      uids = line ? line.text.slice(8).trim().split(/\s+/).filter(Boolean).slice(0, 20) : [];
      for (const uid of uids) {
        r = await c.cmd('UID FETCH ' + uid + ' (BODY.PEEK[])');
        const e = r.entries.find(function (x) { return x.lits.length; });
        if (!e) { continue; }
        try { await onMail(parseMail(e.lits[0])); } catch (err) { log('[IMAP] письмо ' + uid + ' не обработано, повторю: ' + err.message); continue; }
        await c.cmd('UID STORE ' + uid + ' +FLAGS (\\Seen)');   // обработано (или не бронь) - больше не трогаем
        done.push(uid);
      }
      await c.cmd('LOGOUT').catch(function () {});
    } finally { c.close(); }
    return { found: uids.length, processed: done.length };
  }

  async function tick() {
    if (running) { return; }
    running = true;
    try {
      const r = await pollOnce();
      polls++; processed += r.processed;
      if (!ok || lastError) {
        log('[IMAP] ✓ Подключение к ' + host + ':' + port + ' успешно · ящик ' + user + ' · опрос каждые ' + everyMs / 1000 + ' с · новых писем от ' + fromFilter + ': ' + r.found);
      } else if (r.found) {
        log('[IMAP] Обработано писем от ' + fromFilter + ': ' + r.processed + ' из ' + r.found);
      }
      ok = true; lastError = '';
    } catch (e) {
      let msg = e.message;
      if (e.auth) { msg += ' · вход отклонён: для Gmail включите IMAP и используйте «пароль приложения» (Аккаунт Google → Безопасность → Пароли приложений), обычный пароль не подходит'; }
      if (msg !== lastError) { log('[IMAP] ✗ Ошибка подключения к ' + host + ': ' + msg); }
      lastError = msg; ok = false;
    } finally { running = false; }
  }

  return {
    start: function () {
      if (timer) { return; }
      tick();
      timer = setInterval(tick, everyMs);
    },
    stop: function () { if (timer) { clearInterval(timer); timer = null; } },
    tick: tick,
    status: function () { return { enabled: true, connected: ok, host: host, user: user, polls: polls, processed: processed, error: lastError }; }
  };
}

module.exports = { createEmailListener: createEmailListener, parseMail: parseMail };
