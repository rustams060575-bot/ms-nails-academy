/*
  Хранилище записей — файл bookings.json в ПРИВАТНОМ GitHub-репозитории (GitHub Contents API).
  Каждое изменение — отдельный коммит, так что у Марии есть полная история.
  Одновременные записи не теряются: запись идёт с sha текущей версии, при конфликте — перечитываем и повторяем.
  Работает и в Cloudflare Worker, и в Node 20 (GitHub Actions) — без зависимостей.
*/

const API = 'https://api.github.com';

function b64decode(s) {
  const bin = atob(s.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(bin, function (c) { return c.charCodeAt(0); }));
}

function b64encode(str) {
  let bin = '';
  new TextEncoder().encode(str).forEach(function (b) { bin += String.fromCharCode(b); });
  return btoa(bin);
}

export function createStore({ token, repo, path = 'bookings.json', branch = 'main' }) {
  if (!token || !repo) { throw new Error('Store: token and repo are required'); }
  const url = API + '/repos/' + repo + '/contents/' + path;
  const headers = {
    Authorization: 'Bearer ' + token,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'ms-nails-booking'
  };

  async function read() {
    const r = await fetch(url + '?ref=' + encodeURIComponent(branch), { headers: headers });
    if (r.status === 404) { return { bookings: [], sha: null }; }
    if (!r.ok) { throw new Error('GitHub read failed: ' + r.status); }
    const j = await r.json();
    return { bookings: JSON.parse(b64decode(j.content) || '[]'), sha: j.sha };
  }

  /* true — записано, false — конфликт версий (кто-то успел раньше) */
  async function write(bookings, sha, message) {
    const body = { message: message, branch: branch, content: b64encode(JSON.stringify(bookings, null, 2) + '\n') };
    if (sha) { body.sha = sha; }
    const r = await fetch(url, { method: 'PUT', headers: Object.assign({ 'Content-Type': 'application/json' }, headers), body: JSON.stringify(body) });
    if (r.status === 409 || (r.status === 422 && !sha)) { return false; }
    if (!r.ok) { throw new Error('GitHub write failed: ' + r.status); }
    return true;
  }

  /*
    mutate(bookings) меняет массив на месте и возвращает результат.
    Если результат содержит { skipWrite: true } — ничего не коммитим.
  */
  async function update(mutate, message, attempts = 5) {
    for (let i = 0; i < attempts; i++) {
      const cur = await read();
      const result = (await mutate(cur.bookings)) || {};
      if (result.skipWrite) { return result; }
      if (await write(cur.bookings, cur.sha, message)) { return result; }
      await new Promise(function (res) { setTimeout(res, 250 * (i + 1)); });
    }
    throw new Error('GitHub write conflict: too many retries');
  }

  return { read: read, update: update };
}
