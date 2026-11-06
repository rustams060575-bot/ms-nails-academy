/*
  WhatsApp Business Cloud API (Meta) — отправка шаблонных сообщений.

  Бизнес-сообщения «первыми» (напоминания клиенту, уведомление Марии) WhatsApp разрешает только по заранее
  одобренным шаблонам. Поэтому здесь отправляются именно шаблоны (type: template).
  Подготовка (аккаунт Meta, номер, шаблоны): booking/agent/DEPLOY.md, раздел «WhatsApp».

  Без зависимостей: Node 20+ и Cloudflare Workers.
*/

const GRAPH = 'https://graph.facebook.com';

/* Параметры шаблона не могут содержать переводов строки и табуляции и не должны быть пустыми */
function cleanParam(v) {
  const s = String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').replace(/ {2,}/g, ' ').trim();
  return s || '-';
}

export async function sendWhatsAppTemplate({ token, phoneId, to, template, lang, params = [], apiVersion = 'v21.0' }) {
  if (!token || !phoneId || !to || !template) { throw new Error('WhatsApp: token, phoneId, to and template are required'); }
  const body = {
    messaging_product: 'whatsapp',
    to: String(to).replace(/[^\d]/g, ''),   // международный формат без «+»
    type: 'template',
    template: {
      name: template,
      language: { code: lang || 'el' },
      components: params.length ? [{ type: 'body', parameters: params.map(function (p) { return { type: 'text', text: cleanParam(p) }; }) }] : []
    }
  };
  const r = await fetch(GRAPH + '/' + apiVersion + '/' + phoneId + '/messages', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json().catch(function () { return {}; });
  if (!r.ok) { throw new Error('WhatsApp ' + r.status + ': ' + ((j.error && (j.error.message || j.error.error_user_msg)) || 'error')); }
  return j.messages && j.messages[0] && j.messages[0].id;
}
