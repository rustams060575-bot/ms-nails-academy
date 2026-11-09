/*
  Cloudflare Email Worker: пересылает входящее письмо на адрес Афины в бэкенд.
  Вставьте в Workers → Create → Email Worker, задайте переменные (Settings → Variables):
    WEBHOOK_URL = https://ms-nails-academy.onrender.com/api/external-booking/email
    API_KEY     = значение EXTERNAL_BOOKING_TOKEN (секрет)
  Затем в Email Routing создайте адрес (например booking@msnails.eu) с действием «Send to a Worker».
  Читает письмо без внешних библиотек: берёт текстовую часть и HTML как есть (письма Treatwell простые).
*/
export default {
  async email(message, env) {
    const raw = await new Response(message.raw).text();
    const cut = raw.search(/\r?\n\r?\n/);
    const body = cut > 0 ? raw.slice(cut).trim() : raw;
    const decoded = /quoted-printable/i.test(raw.slice(0, Math.max(cut, 0)))
      ? body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      : body;
    const res = await fetch(env.WEBHOOK_URL + '?key=' + encodeURIComponent(env.API_KEY), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ from: message.from, subject: message.headers.get('subject') || '', html: decoded })
    });
    if (!res.ok && res.status >= 500) { throw new Error('webhook ' + res.status); }   // 5xx: Cloudflare повторит доставку
  }
};
