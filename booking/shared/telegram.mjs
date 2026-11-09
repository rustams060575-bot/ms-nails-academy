/* Сообщение в Telegram-бот Марии — прямой вызов Bot API, без посредников */

export function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function sendTelegram({ token, chatId, html, markup }) {
  if (!token || !chatId) { throw new Error('Telegram: token and chatId are required'); }
  const payload = { chat_id: chatId, text: html, parse_mode: 'HTML', disable_web_page_preview: true };
  if (markup) { payload.reply_markup = markup; }   // например { inline_keyboard: [[{ text, callback_data }]] }
  const r = await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const j = await r.json().catch(function () { return {}; });
  if (!r.ok || !j.ok) { throw new Error('Telegram failed: ' + r.status + ' ' + (j.description || '')); }
}
