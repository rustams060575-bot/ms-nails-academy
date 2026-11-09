/*
  Постоянная память ассистента Афины (хранится на сервере, а не в браузере).

  Что хранится:
    • клиентки (clients.json)  — профиль гостьи: имя, телефоны, заметки о предпочтениях, когда была последний раз;
    • диалоги (chats/<id>.json) — последние сообщения каждой гостьи, чтобы разговор продолжался в другой день и на другом экране;
    • речевые паттерны Марии (patterns.json) — живые фразы и правила стиля, которые попадают в системный промпт.

  Идентификатор гостьи — случайный clientId из браузера (localStorage). Это «ключ» к её памяти: зная его, можно прочитать историю,
  поэтому он никогда не показывается другим и не выводится в логи. По одному лишь введённому номеру телефона история НЕ раскрывается
  (иначе можно было бы узнать чужие имена и визиты, просто набрав чужой номер).

  Хранилище (backend):
    • файлы в booking/agent/data/memory/ — локальная разработка;
    • приватный репозиторий GitHub (папка memory/) — продакшен: на Render файловая система временная.
  Записи отложенные (раз в ~15 секунд и при остановке сервера), чтобы не делать коммит на каждое сообщение.
*/
'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_MESSAGES = 40;       // сколько последних сообщений помним по каждой гостье
const MAX_NOTES = 30;          // заметок о предпочтениях на гостью
const MAX_PATTERNS = 400;
const FLUSH_MS = 15000;
const RETAIN_DAYS = 540;       // профиль гостьи, не писавшей дольше, удаляется

/* ---------- хранилища ---------- */
function fileBackend(dir) {
  return {
    name: 'file',
    async read(rel) {
      try { return JSON.parse((await fsp.readFile(path.join(dir, rel), 'utf8')) || '[]'); } catch (e) { return []; }
    },
    async write(rel, data) {
      const f = path.join(dir, rel);
      await fsp.mkdir(path.dirname(f), { recursive: true });
      await fsp.writeFile(f + '.tmp', JSON.stringify(data, null, 2) + '\n', 'utf8');
      await fsp.rename(f + '.tmp', f);
    }
  };
}

/* makeStore(relPath) → createStore из shared/store.mjs для файла в приватном репозитории */
function githubBackend(makeStore, prefix) {
  const stores = new Map();
  const st = function (rel) {
    const p = (prefix ? prefix + '/' : '') + rel;
    if (!stores.has(p)) { stores.set(p, makeStore(p)); }
    return stores.get(p);
  };
  return {
    name: 'github',
    async read(rel) { return (await st(rel).read()).bookings; },
    write(rel, data) {
      return st(rel).update(function (list) { list.length = 0; Array.prototype.push.apply(list, data); return {}; }, 'memory: ' + rel);
    }
  };
}

/* ---------- чистка текста ---------- */
function oneLine(s, max) {
  return String(s == null ? '' : s).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim().slice(0, max);
}

/* Убираем телефоны, e-mail и ссылки: переписки Марии с клиентками не должны уходить дальше с личными данными */
function stripPersonal(text) {
  return String(text)
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[e-mail]')
    .replace(/https?:\/\/\S+/gi, '[ссылка]')
    .replace(/\+?\d[\d\s().-]{7,}\d/g, '[номер]');
}

/* ---------- разбор экспорта чата (WhatsApp / Telegram / «Имя: текст») ---------- */
const HEAD_RE = /^\s*\[?\d{1,2}[./]\d{1,2}[./]\d{2,4},?\s+\d{1,2}:\d{2}(?::\d{2})?(?:\s?[APap][Mm])?\]?\s*(?:-\s*)?([^:\n]{1,40}):\s?(.*)$/;
const PLAIN_RE = /^([^:\n]{1,30}):\s+(.+)$/;

function parseChatExport(text, who) {
  const target = String(who || '').trim().toLowerCase();
  const msgs = [];
  let cur = null;
  String(text).split(/\r?\n/).forEach(function (line) {
    const m = line.match(HEAD_RE) || line.match(PLAIN_RE);
    if (m) {
      cur = { sender: m[1].trim(), text: m[2].trim() };
      msgs.push(cur);
    } else if (cur && line.trim()) {
      cur.text += ' ' + line.trim();
    }
  });
  const mine = msgs.filter(function (m) { return target && m.sender.toLowerCase().indexOf(target) > -1; });
  return { total: msgs.length, mine: mine.map(function (m) { return m.text; }) };
}

/* Запасной вариант без ИИ: берём содержательные реплики Марии как «живые фразы» (на проверку) */
function heuristicPhrases(lines) {
  return lines
    .map(function (t) { return stripPersonal(t); })
    .filter(function (t) { return t.length >= 25 && t.length <= 400 && !/^<.*>$/.test(t) && !/^\[.*\]$/.test(t); })
    .slice(0, 25)
    .map(function (t) { return { situation: 'из переписки', text: t }; });
}

function detectLang(s) {
  if (/[Ͱ-Ͽ]/.test(s)) { return 'el'; }
  if (/[Ѐ-ӿ]/.test(s)) { return 'ru'; }
  return 'en';
}

/* ---------- память ---------- */
function createMemory({ backend, log }) {
  const say = log || function () {};
  const clients = new Map();
  let patterns = [];
  const chats = new Map();          // id → { msgs, dirty }
  const dirty = { clients: false, patterns: false, admin: false };
  let timer = null;
  let chain = Promise.resolve();

  function schedule() {
    if (timer) { return; }
    timer = setTimeout(function () { timer = null; flush(); }, FLUSH_MS);
    if (timer.unref) { timer.unref(); }
  }

  async function doFlush() {
    if (timer) { clearTimeout(timer); timer = null; }
    if (dirty.clients) {
      dirty.clients = false;
      try { await backend.write('clients.json', Array.from(clients.values())); } catch (e) { dirty.clients = true; throw e; }
    }
    if (dirty.patterns) {
      dirty.patterns = false;
      try { await backend.write('patterns.json', patterns); } catch (e) { dirty.patterns = true; throw e; }
    }
    if (dirty.admin) {
      dirty.admin = false;
      try { await backend.write('admin.json', [admin]); } catch (e) { dirty.admin = true; throw e; }
    }
    for (const [id, c] of Array.from(chats.entries())) {
      if (!c.dirty) { continue; }
      c.dirty = false;
      try { await backend.write('chats/' + id + '.json', c.msgs); } catch (e) { c.dirty = true; throw e; }
    }
    if (chats.size > 200) {   // не раздуваем память процесса
      for (const [id, c] of Array.from(chats.entries())) { if (!c.dirty && chats.size > 100) { chats.delete(id); } }
    }
  }

  function flush() {
    chain = chain.then(doFlush).catch(function (e) { say('память: не удалось сохранить — ' + e.message); schedule(); });
    return chain;
  }

  async function init() {
    const list = await backend.read('clients.json');
    const limit = Date.now() - RETAIN_DAYS * 86400000;
    (Array.isArray(list) ? list : []).forEach(function (p) {
      if (p && UUID_RE.test(p.id) && (!p.lastSeen || Date.parse(p.lastSeen) > limit)) { clients.set(p.id, p); }
    });
    const pl = await backend.read('patterns.json');
    patterns = (Array.isArray(pl) ? pl : []).filter(function (p) { return p && p.id && p.text; });
    const al = await backend.read('admin.json');
    const a = Array.isArray(al) && al[0] && typeof al[0] === 'object' ? al[0] : {};
    admin = {
      notes: (Array.isArray(a.notes) ? a.notes : []).filter(function (n) { return n && n.text; }),
      msgs: (Array.isArray(a.msgs) ? a.msgs : []).filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'; }),
      summary: typeof a.summary === 'string' ? a.summary : ''
    };
  }

  /* ----- гостьи ----- */
  function isId(id) { return typeof id === 'string' && UUID_RE.test(id); }
  function profile(id) { return clients.get(id) || null; }

  function touch(id, lang) {
    let p = clients.get(id);
    const now = new Date().toISOString();
    if (!p) {
      p = { id: id, createdAt: now, lastSeen: now, lang: lang || 'ru', name: '', phones: [], notes: [] };
      clients.set(id, p);
    }
    p.lastSeen = now;
    if (lang) { p.lang = lang; }
    dirty.clients = true;
    schedule();
    return p;
  }

  function setName(id, name) {
    const n = oneLine(name, 60);
    if (n.length < 2) { return; }
    touch(id).name = n;
  }

  function addPhone(id, phone) {
    const p = touch(id);
    if (phone && p.phones.indexOf(phone) < 0) { p.phones.push(phone); p.phones = p.phones.slice(-3); }
  }

  /* Заметка о предпочтениях: короткая, без переводов строк; дубликаты и почти-дубликаты не копим */
  function addNote(id, text) {
    const t = oneLine(text, 220);
    if (t.length < 3) { return false; }
    const p = touch(id);
    const key = t.toLowerCase();
    if (p.notes.some(function (n) { return n.text.toLowerCase() === key; })) { return false; }
    p.notes.push({ at: new Date().toISOString(), text: t });
    if (p.notes.length > MAX_NOTES) { p.notes = p.notes.slice(-MAX_NOTES); }
    return true;
  }

  async function history(id) {
    if (!chats.has(id)) {
      const raw = await backend.read('chats/' + id + '.json');
      const msgs = (Array.isArray(raw) ? raw : []).filter(function (m) { return m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'; });
      chats.set(id, { msgs: msgs, dirty: false });
    }
    return chats.get(id).msgs;
  }

  async function append(id, items) {
    const h = await history(id);
    const at = new Date().toISOString();
    items.forEach(function (m) { h.push({ role: m.role, content: String(m.content).slice(0, 1500), at: at }); });
    const dropped = [];   // вытесненные реплики не пропадают бесследно: из них строится краткая сводка (setSummary)
    while (h.length > MAX_MESSAGES) { dropped.push(h.shift()); }
    while (h.length && h[0].role !== 'user') { dropped.push(h.shift()); }
    chats.get(id).dirty = true;
    touch(id);
    return dropped;
  }

  /* Долгая память: сводка прошлых бесед (то, что уже не помещается в последние MAX_MESSAGES реплик) */
  function setSummary(id, text) {
    const p = clients.get(id);
    const t = String(text || '').replace(/\r/g, '').trim().slice(0, 1200);
    if (!p || !t) { return false; }
    p.summary = t;
    p.summaryAt = new Date().toISOString();
    dirty.clients = true;
    schedule();
    return true;
  }

  /* ----- память о Марии и студии (admin.json): заметки «запомни…», последние реплики, сводка прошлых разговоров ----- */
  let admin = { notes: [], msgs: [], summary: '' };
  const MAX_ADMIN_NOTES = 80, MAX_ADMIN_MSGS = 30;
  function adminState() { return admin; }
  function adminAddNote(text) {
    const t = oneLine(text, 400);
    if (t.length < 3) { return null; }
    const dup = admin.notes.find(function (n) { return n.text.toLowerCase() === t.toLowerCase(); });
    if (dup) { return { note: dup, duplicate: true }; }
    const note = { id: crypto.randomBytes(3).toString('hex'), at: new Date().toISOString(), text: t };
    admin.notes.push(note);
    if (admin.notes.length > MAX_ADMIN_NOTES) { admin.notes = admin.notes.slice(-MAX_ADMIN_NOTES); }
    dirty.admin = true; schedule();
    return { note: note, duplicate: false };
  }
  function adminRemoveNote(ref) {   // по номеру в списке (с 1) или по id
    const i = /^\d{1,3}$/.test(String(ref)) ? Number(ref) - 1 : admin.notes.findIndex(function (n) { return n.id === String(ref); });
    if (i < 0 || i >= admin.notes.length) { return null; }
    const gone = admin.notes.splice(i, 1)[0];
    dirty.admin = true; schedule();
    return gone;
  }
  function adminAppend(items) {   // возвращает вытесненные реплики для сводки
    const at = new Date().toISOString();
    items.forEach(function (m) { admin.msgs.push({ role: m.role, content: String(m.content).slice(0, 3000), at: at }); });
    const dropped = [];
    while (admin.msgs.length > MAX_ADMIN_MSGS) { dropped.push(admin.msgs.shift()); }
    while (admin.msgs.length && admin.msgs[0].role !== 'user') { dropped.push(admin.msgs.shift()); }
    dirty.admin = true; schedule();
    return dropped;
  }
  function adminSetSummary(text) {
    const t = String(text || '').replace(/\r/g, '').trim().slice(0, 1500);
    if (!t) { return false; }
    admin.summary = t; dirty.admin = true; schedule();
    return true;
  }
  function adminReset() { admin = { notes: admin.notes, msgs: [], summary: '' }; dirty.admin = true; schedule(); }

  /* «Забыть меня»: профиль и диалог стираются (в git-истории приватного репозитория старые коммиты остаются — см. DEPLOY.md) */
  async function forget(id) {
    clients.delete(id);
    chats.set(id, { msgs: [], dirty: true });
    dirty.clients = true;
    await flush();
  }

  function listGuests() {
    return Array.from(clients.values()).map(function (p) {
      return { id: p.id, name: p.name, phones: (p.phones || []).map(function (x) { return x.slice(0, 4) + '•••' + x.slice(-3); }), notes: p.notes.length, lastSeen: p.lastSeen, lang: p.lang };
    }).sort(function (a, b) { return String(b.lastSeen).localeCompare(String(a.lastSeen)); });
  }

  /* ----- речевые паттерны Марии ----- */
  function listPatterns() { return patterns.slice().sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); }); }

  function addPattern(p) {
    const text = oneLine(p.text, 500);
    if (text.length < 8) { return null; }
    if (patterns.some(function (x) { return x.text.toLowerCase() === text.toLowerCase(); })) { return null; }   // не плодим дубли
    const rec = {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      kind: p.kind === 'rule' ? 'rule' : 'phrase',
      source: oneLine(p.source || 'manual', 40),
      situation: oneLine(p.situation || '', 80),
      text: text,
      lang: ['ru', 'en', 'el'].indexOf(p.lang) > -1 ? p.lang : detectLang(text),
      approved: p.approved === true
    };
    patterns.push(rec);
    if (patterns.length > MAX_PATTERNS) { patterns = patterns.slice(-MAX_PATTERNS); }
    dirty.patterns = true; schedule();
    return rec;
  }

  function updatePattern(id, patch) {
    const p = patterns.find(function (x) { return x.id === id; });
    if (!p) { return null; }
    if (typeof patch.approved === 'boolean') { p.approved = patch.approved; }
    if (typeof patch.text === 'string' && patch.text.trim().length >= 8) { p.text = oneLine(patch.text, 500); }
    if (typeof patch.situation === 'string') { p.situation = oneLine(patch.situation, 80); }
    if (typeof patch.kind === 'string') { p.kind = patch.kind === 'rule' ? 'rule' : 'phrase'; }
    dirty.patterns = true; schedule();
    return p;
  }

  function removePattern(id) {
    const n = patterns.length;
    patterns = patterns.filter(function (x) { return x.id !== id; });
    if (patterns.length !== n) { dirty.patterns = true; schedule(); return true; }
    return false;
  }

  /* Текст для системного промпта: только утверждённые Марией/админом паттерны */
  function promptPatterns(lang) {
    const ok = patterns.filter(function (p) { return p.approved; });
    const rules = ok.filter(function (p) { return p.kind === 'rule'; }).sort(function (a, b) { return String(b.createdAt).localeCompare(String(a.createdAt)); }).slice(0, 12);
    const phrases = ok.filter(function (p) { return p.kind !== 'rule'; }).sort(function (a, b) {
      const la = a.lang === lang ? 0 : 1, lb = b.lang === lang ? 0 : 1;
      return la - lb || String(b.createdAt).localeCompare(String(a.createdAt));
    }).slice(0, 14);
    if (!rules.length && !phrases.length) { return '(пока нет утверждённых примеров от Марии: держись общего характера, описанного выше)'; }
    const out = [];
    if (rules.length) {
      out.push('Правила стиля Марии:');
      rules.forEach(function (r) { out.push('- ' + r.text); });
    }
    if (phrases.length) {
      if (out.length) { out.push(''); }
      out.push('Живые фразы Марии (ориентир по тону и теплоте; не копируй дословно в каждом ответе и не придумывай новых «цитат Марии»):');
      phrases.forEach(function (r) { out.push('- ' + (r.situation ? '[' + r.situation + '] ' : '') + '«' + r.text + '»'); });
    }
    return out.join('\n');
  }

  return {
    backendName: backend.name,
    init, flush, isId, profile, touch, setName, addPhone, addNote, setSummary, history, append, forget, listGuests,
    adminState, adminAddNote, adminRemoveNote, adminAppend, adminSetSummary, adminReset,
    listPatterns, addPattern, updatePattern, removePattern, promptPatterns
  };
}

module.exports = { createMemory, fileBackend, githubBackend, parseChatExport, heuristicPhrases, stripPersonal, oneLine, detectLang, UUID_RE };
