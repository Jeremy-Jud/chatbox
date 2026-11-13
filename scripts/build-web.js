// Baut die Web-Version (iPhone/iPad/Browser) nach dist-web/.
// Nutzt dieselben Dateien aus src/ wie die Windows-App und ergänzt nur, was im Browser fehlt.
//   npm run build:web
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'dist-web');
const { version } = require(path.join(root, 'package.json'));

const peerjs = path.join(root, 'node_modules', 'peerjs', 'dist', 'peerjs.min.js');
if (!fs.existsSync(peerjs)) {
  console.error('peerjs fehlt. Bitte zuerst "npm install" ausführen.');
  process.exit(1);
}

fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(path.join(root, 'src'), out, { recursive: true });
fs.copyFileSync(peerjs, path.join(out, 'peerjs.min.js'));
fs.copyFileSync(path.join(root, 'web', 'web.css'), path.join(out, 'web.css'));
fs.copyFileSync(path.join(root, 'web', 'manifest.webmanifest'), path.join(out, 'manifest.webmanifest'));
// Musik für UpReels (CC BY 4.0, siehe web/music/CREDITS.md) – auch die Windows-App lädt sie von hier
fs.cpSync(path.join(root, 'web', 'music'), path.join(out, 'music'), { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'web', 'icons'))) {
  fs.copyFileSync(path.join(root, 'web', 'icons', f), path.join(out, f));
}
const withVersion = (f) => fs.readFileSync(path.join(root, 'web', f), 'utf8').replaceAll('__VERSION__', version);
fs.writeFileSync(path.join(out, 'shim.js'), withVersion('shim.js'));
fs.writeFileSync(path.join(out, 'sw.js'), withVersion('sw.js'));

let html = fs.readFileSync(path.join(out, 'index.html'), 'utf8');
const replace = (from, to) => {
  if (!html.includes(from)) throw new Error('Nicht gefunden in index.html: ' + from);
  html = html.replace(from, to);
};

replace('<meta charset="utf-8">', `<meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-title" content="WhatsUp">
  <meta name="apple-mobile-web-app-status-bar-style" content="default">
  <meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#0e0e10" media="(prefers-color-scheme: dark)">
  <link rel="manifest" href="manifest.webmanifest">
  <link rel="apple-touch-icon" href="apple-touch-icon.png">
  <link rel="icon" type="image/png" href="icon-192.png">`);
replace('<link rel="stylesheet" href="style.css">', '<link rel="stylesheet" href="style.css">\n  <link rel="stylesheet" href="web.css">');
replace('<script src="../node_modules/peerjs/dist/peerjs.min.js"></script>',
  '<script src="shim.js"></script>\n  <script src="peerjs.min.js"></script>');
replace('<h2>Info</h2>', '<h2>Info</h2>\n      <div class="setting"><span class="muted" id="webInfo"></span></div>');

// ---- Für Suchmaschinen und Link-Vorschauen (Google, WhatsApp, Discord, LinkedIn …) ----
const SITE = 'https://jeremy-jud.github.io/whatsup/';
const DESC = 'WhatsUp: kostenlose Chat-App ohne Konto. Freunde per Code hinzufügen, Gruppenchats, Umfragen, Anrufe, UpReels mit Musik, Erfolge und Ranglisten – im Browser, auf dem iPhone und für Windows.';
replace('<title>WhatsUp</title>', `<title>WhatsUp – Chat-App ohne Konto (Web-Version)</title>
  <meta name="description" content="${DESC}">
  <meta name="author" content="Jeremy Jud">
  <link rel="canonical" href="${SITE}">
  <meta property="og:type" content="website">
  <meta property="og:site_name" content="WhatsUp">
  <meta property="og:title" content="WhatsUp – Chat-App ohne Konto">
  <meta property="og:description" content="Freunde per Code hinzufügen und direkt chatten. Kostenlos im Browser, auf dem iPhone und für Windows.">
  <meta property="og:url" content="${SITE}">
  <meta property="og:image" content="${SITE}about/og.jpg">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${SITE}about/og.jpg">`);
// Text und Link für Suchmaschinen, auch ohne JavaScript lesbar (für Menschen unsichtbar, die App deckt ihn ab)
replace('<body>', `<body>
  <div class="seo-intro">
    <h1>WhatsUp – Chat-App ohne Konto</h1>
    <p>${DESC}</p>
    <p><a href="about/">Mehr über WhatsUp, Screenshots und Download für Windows</a> · Entwickelt von Jeremy Jud</p>
  </div>
  <noscript><p>WhatsUp braucht JavaScript. <a href="about/">Hier gibt es Infos und den Download für Windows.</a></p></noscript>`);

// Versionsnummer an alle eigenen Dateien hängen, damit Safari nach einem Update
// nicht neue index.html mit alter style.css/app.js aus dem Zwischenspeicher mischt
html = html.replace(/(href|src)="(?!https?:|data:|#)([^"?]+\.(?:css|js))"/g, `$1="$2?v=${version}"`);

fs.writeFileSync(path.join(out, 'index.html'), html);
fs.writeFileSync(path.join(out, '.nojekyll'), '');

// Infoseite (Beschreibung, Screenshots, Download) und Sitemap für die Google Search Console
fs.cpSync(path.join(root, 'web', 'about'), path.join(out, 'about'), { recursive: true });
const today = new Date().toISOString().slice(0, 10);
fs.writeFileSync(path.join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${SITE}about/</loc><lastmod>${today}</lastmod><priority>1.0</priority></url>
  <url><loc>${SITE}</loc><lastmod>${today}</lastmod><priority>0.8</priority></url>
</urlset>
`);
// Bestätigungsdatei der Google Search Console (falls vorhanden: web/google*.html)
for (const f of fs.readdirSync(path.join(root, 'web')).filter((n) => /^google[0-9a-f]+\.html$/.test(n))) {
  fs.copyFileSync(path.join(root, 'web', f), path.join(out, f));
}
console.log(`Web-Version ${version} gebaut: ${path.relative(root, out)}/`);
