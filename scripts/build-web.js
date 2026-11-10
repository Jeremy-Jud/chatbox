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

// Versionsnummer an alle eigenen Dateien hängen, damit Safari nach einem Update
// nicht neue index.html mit alter style.css/app.js aus dem Zwischenspeicher mischt
html = html.replace(/(href|src)="(?!https?:|data:|#)([^"?]+\.(?:css|js))"/g, `$1="$2?v=${version}"`);

fs.writeFileSync(path.join(out, 'index.html'), html);
fs.writeFileSync(path.join(out, '.nojekyll'), '');
console.log(`Web-Version ${version} gebaut: ${path.relative(root, out)}/`);
