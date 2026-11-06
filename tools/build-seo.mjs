// Генерирует SEO-артефакты из index.html (источник правды — русская версия в корне):
//   en/index.html, el/index.html, sitemap.xml, robots.txt, CNAME, JSON-LD, hreflang, OG
// Запуск: node tools/build-seo.mjs   (после любых правок index.html; скрипт идемпотентен)
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import vm from 'node:vm';

const DOMAIN = 'msnails.eu';
const BASE = `https://${DOMAIN}`;
const src = readFileSync('index.html', 'utf8');

const SERVICES = vm.runInNewContext(src.match(/var SERVICES = \[[\s\S]*?\n\];/)[0].replace('var SERVICES =', 'x =') + ';x');

const L = {
  ru: { path: '/', og: 'ru_RU', title: 'Маникюр и педикюр в Перистери, Афины · MS Nails Academy', desc: 'MS Nails Academy — студия маникюра, педикюра и наращивания ногтей Марии Семеновой в Перистери (Афины). Russian manicure, гель, акригель, брови, онлайн-запись.' },
  en: { path: '/en/', og: 'en_US', title: 'Manicure & Pedicure in Peristeri, Athens · MS Nails Academy', desc: 'MS Nails Academy — Maria Semenova’s nail studio in Peristeri, Athens: Russian manicure, spa pedicure, gel & acrygel extensions, eyebrow care. Book online.' },
  el: { path: '/el/', og: 'el_GR', title: 'Μανικιούρ & Πεντικιούρ στο Περιστέρι, Αθήνα · MS Nails Academy', desc: 'MS Nails Academy — στούντιο νυχιών της Maria Semenova στο Περιστέρι, Αθήνα: ρωσικό μανικιούρ, spa πεντικιούρ, επεκτάσεις τζελ & ακρυτζελ, φρύδια. Κλείστε ραντεβού online.' }
};

const ldjson = (lang) => JSON.stringify({
  '@context': 'https://schema.org',
  '@type': ['NailSalon', 'BeautySalon'],
  '@id': `${BASE}/#business`,
  name: 'MS Nails Academy',
  alternateName: 'Maria Semenova · MS Nails Academy',
  description: L[lang].desc,
  url: BASE + L[lang].path,
  image: `${BASE}/photos/og-cover.jpg`,
  logo: `${BASE}/photos/logo.png`,
  telephone: '+306939350160',
  email: 'marianails777365@gmail.com',
  priceRange: '€€',
  currenciesAccepted: 'EUR',
  knowsLanguage: ['el', 'en', 'ru'],
  address: { '@type': 'PostalAddress', streetAddress: 'Likourgou 15', addressLocality: 'Peristeri', addressRegion: 'Attica', postalCode: '121 32', addressCountry: 'GR' },
  hasMap: 'https://www.google.com/maps/place/Likourgou+15,+Peristeri+121+32',
  openingHoursSpecification: [{ '@type': 'OpeningHoursSpecification', dayOfWeek: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'], opens: '09:00', closes: '21:00' }],
  areaServed: ['Peristeri', 'Athens', 'Egaleo', 'Chaidari', 'Ilion', 'Agioi Anargyroi'].map((n) => ({ '@type': 'City', name: n })),
  sameAs: ['https://www.instagram.com/maria_sem_nails_academy', 'https://www.facebook.com/share/1c5vxPRgHh/'],
  founder: { '@type': 'Person', name: 'Maria Semenova' },
  potentialAction: { '@type': 'ReserveAction', target: { '@type': 'EntryPoint', urlTemplate: `${BASE}${L[lang].path}#book` }, result: { '@type': 'Reservation', name: 'Book an appointment' } },
  hasOfferCatalog: { '@type': 'OfferCatalog', name: 'Services', itemListElement: SERVICES.map((s) => ({ '@type': 'Offer', itemOffered: { '@type': 'Service', name: s[lang] } })) }
});

const seoBlock = (lang) => {
  const d = L[lang];
  return `<!--SEO:BEGIN-->
<link rel="canonical" href="${BASE}${d.path}">
<link rel="alternate" hreflang="ru" href="${BASE}/">
<link rel="alternate" hreflang="en" href="${BASE}/en/">
<link rel="alternate" hreflang="el" href="${BASE}/el/">
<link rel="alternate" hreflang="x-default" href="${BASE}/el/">
<meta property="og:type" content="website">
<meta property="og:site_name" content="MS Nails Academy">
<meta property="og:locale" content="${d.og}">
<meta property="og:url" content="${BASE}${d.path}">
<meta property="og:title" content="${d.title}">
<meta property="og:description" content="${d.desc}">
<meta property="og:image" content="${BASE}/photos/og-cover.jpg">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="MS Nails Academy — ${d.title}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${d.title}">
<meta name="twitter:description" content="${d.desc}">
<meta name="twitter:image:alt" content="MS Nails Academy — ${d.title}">
<meta name="twitter:image" content="${BASE}/photos/og-cover.jpg">
<link rel="icon" href="/photos/logo.png" type="image/png">
<link rel="apple-touch-icon" href="/photos/logo.png">
<script type="application/ld+json">${ldjson(lang)}</script>
<!--SEO:END-->`;
};

function page(lang) {
  let s = src;
  const d = L[lang];
  s = s.replace(/<html lang="\w+"( data-lang-fixed="\w+")?/, lang === 'ru' ? '<html lang="ru"' : `<html lang="${lang}" data-lang-fixed="${lang}"`);
  s = s.replace(/<title>[\s\S]*?<\/title>/, `<title>${d.title}</title>`);
  s = s.replace(/<meta name="description" content="[^"]*">/, `<meta name="description" content="${d.desc}">`);
  s = s.replace(/<!--SEO:BEGIN-->[\s\S]*?<!--SEO:END-->/, () => seoBlock(lang));
  // заголовки/описания во всех языковых словарях скрипта (иначе JS перезапишет <title>)
  for (const l of ['ru', 'en', 'el']) {
    s = s.replace(
      new RegExp(`(\\n  ${l}: \\{\\s*\\n\\s*'meta\\.title': )'[^']*',(\\s*\\n\\s*'meta\\.desc': )'[^']*',`),
      (_, a, b) => `${a}'${L[l].title}',${b}'${L[l].desc}',`
    );
  }
  return s;
}

writeFileSync('index.html', page('ru'), 'utf8');
for (const lang of ['en', 'el']) {
  // страница в подпапке — пути к ресурсам делаем абсолютными
  const h = page(lang).replace(/(["'(])(photos|fonts)\//g, '$1/$2/');
  mkdirSync(lang, { recursive: true });
  writeFileSync(`${lang}/index.html`, h, 'utf8');
}

const today = new Date().toISOString().slice(0, 10);
const alt = ['ru', 'en', 'el'].map((x) => `    <xhtml:link rel="alternate" hreflang="${x}" href="${BASE}${L[x].path}"/>`).join('\n') + `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${BASE}/el/"/>`;
writeFileSync('sitemap.xml', `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${['ru', 'en', 'el'].map((l) => `  <url>\n    <loc>${BASE}${L[l].path}</loc>\n    <lastmod>${today}</lastmod>\n${alt}\n  </url>`).join('\n')}
</urlset>
`);
const robots = [
  'User-agent: *', 'Allow: /', 'Disallow: /booking/', 'Disallow: /msq-fix-ru.html', 'Disallow: /tools/', '',
  'User-agent: Googlebot', 'Allow: /', 'Disallow: /booking/', '',
  'User-agent: Yandex', 'Allow: /', 'Disallow: /booking/', 'Disallow: /msq-fix-ru.html', 'Disallow: /tools/', '',
  `Sitemap: ${BASE}/sitemap.xml`, '',
];
writeFileSync('robots.txt', robots.join('\n'));
writeFileSync('CNAME', `${DOMAIN}\n`);
