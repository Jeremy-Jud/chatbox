const { app, BrowserWindow, ipcMain, shell, net, nativeTheme, Notification, Tray, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const REPO = 'Jeremy-Jud/whatsup';
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const ICON_PATH = path.join(__dirname, 'src', 'assets', 'logo.png');
const APP_ID = 'com.whatsup.app';
// Feste Kennung, über die Windows Antworten aus Benachrichtigungen an WhatsUp zurückgibt
const TOAST_CLSID = '{7B3E6C1A-5D2F-4E8B-9A41-2C6F0D8E3B57}';
if (process.platform === 'win32') {
  try { app.setToastActivatorCLSID(TOAST_CLSID); } catch (e) { console.warn('Toast-CLSID:', e); }
}

let win = null;
let tray = null;
let quitting = false;
const TEST_MODE = process.env.CHATBOX_HIDDEN === '1' && !app.isPackaged;
// Tests: künstliche Kamera und Mikrofon statt echter Geräte
if (TEST_MODE) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
}
const IS_PORTABLE = !!process.env.PORTABLE_EXECUTABLE_FILE;
const START_HIDDEN = process.argv.includes('--hidden');
// Wird vom Fenster aus den Einstellungen gesetzt
const prefs = { runInBackground: true, openAtLogin: false, popupNotify: true, theme: 'system' };

// Optional: --profile=name startet ein getrenntes Profil (z. B. zum Testen mit zwei Fenstern)
const profileArg = process.argv.find((a) => a.startsWith('--profile='));
if (profileArg) {
  const name = profileArg.split('=')[1].replace(/[^a-z0-9_-]/gi, '');
  if (name) app.setPath('userData', path.join(app.getPath('appData'), 'Chatbox-' + name));
} else {
  // Daten bleiben im bisherigen Ordner, damit Chats nach der Umbenennung in WhatsUp erhalten bleiben
  app.setPath('userData', path.join(app.getPath('appData'), 'Chatbox'));
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function showWindow() {
  if (!win) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
}

function createWindow() {
  win = new BrowserWindow({
    width: 380,
    height: 600,
    minWidth: 320,
    minHeight: 460,
    frame: false,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e0e10' : '#ffffff',
    // Testmodus: Fenster wird gezeichnet, ist aber unsichtbar und nicht klickbar
    ...(TEST_MODE ? { opacity: 0, focusable: false, skipTaskbar: true } : {}),
    title: 'WhatsUp',
    icon: ICON_PATH,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false, // Chat soll auch im Hintergrund verbunden bleiben
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });

  if (TEST_MODE) win.setIgnoreMouseEvents(true);
  win.once('ready-to-show', () => { if (!START_HIDDEN || TEST_MODE) win.show(); });
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // Schließen = im Hintergrund weiterlaufen (wie Discord/Teams)
  win.on('close', (e) => {
    if (quitting || !prefs.runInBackground || TEST_MODE) return;
    e.preventDefault();
    win.hide();
    win.webContents.send('win:hidden');
  });
  win.on('focus', () => win.flashFrame(false));
  win.on('closed', () => { if (popup && !popup.isDestroyed()) popup.destroy(); });

  // Sicherheit: App darf nie auf fremde Seiten navigieren
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // Links im normalen Browser öffnen, nicht in der App (nur https)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Keine Rechte (Standort …) außer Benachrichtigungen und Kamera/Mikrofon für Anrufe
  win.webContents.session.setPermissionRequestHandler((wc, permission, cb, details) => {
    if (permission === 'media') {
      cb(wc === win.webContents && (details.mediaTypes || []).every((t) => t === 'audio' || t === 'video'));
      return;
    }
    cb(permission === 'notifications' || permission === 'clipboard-sanitized-write');
  });
}

function createTray() {
  if (TEST_MODE) return;
  const img = nativeImage.createFromPath(ICON_PATH).resize({ width: 32, height: 32, quality: 'best' });
  tray = new Tray(img);
  tray.setToolTip('WhatsUp');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'WhatsUp öffnen', click: showWindow },
    { type: 'separator' },
    { label: 'Beenden', click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on('click', showWindow);
}

// Verknüpfungen sicherstellen (installierte Version).
// Stille Updates des Installers können sie entfernen. Ohne Startmenü-Eintrag mit
// App-ID ordnet Windows Benachrichtigungen und Neustarts nicht mehr richtig zu.
function ensureShortcuts() {
  if (process.platform !== 'win32' || !app.isPackaged || IS_PORTABLE) return;
  const exe = process.execPath;
  const opts = { target: exe, cwd: path.dirname(exe), appUserModelId: APP_ID, toastActivatorClsid: TOAST_CLSID, description: 'WhatsUp', icon: exe, iconIndex: 0 };
  const startMenu = path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'WhatsUp.lnk');
  try {
    let ok = false;
    try {
      const l = shell.readShortcutLink(startMenu);
      ok = l.target.toLowerCase() === exe.toLowerCase() && l.appUserModelId === APP_ID &&
        String(l.toastActivatorClsid || '').toUpperCase().replace(/[{}]/g, '') === TOAST_CLSID.replace(/[{}]/g, '');
    } catch {}
    if (!ok) shell.writeShortcutLink(startMenu, 'create', opts);
  } catch (e) { console.warn('Startmenü-Verknüpfung:', e); }
  // Desktop-Verknüpfung nur einmal anlegen – löscht man sie, bleibt sie weg
  const flag = path.join(app.getPath('userData'), 'desktop-shortcut-created');
  if (!fs.existsSync(flag)) {
    try {
      const desktop = path.join(app.getPath('desktop'), 'WhatsUp.lnk');
      if (!fs.existsSync(desktop)) shell.writeShortcutLink(desktop, 'create', opts);
      fs.writeFileSync(flag, '1');
    } catch (e) { console.warn('Desktop-Verknüpfung:', e); }
  }
}

app.on('second-instance', showWindow);
app.on('before-quit', () => { quitting = true; });

// ---------- Fenster ----------
ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:close', () => win && win.close());
ipcMain.handle('win:togglePin', () => {
  if (!win) return false;
  const pinned = !win.isAlwaysOnTop();
  win.setAlwaysOnTop(pinned);
  return pinned;
});
ipcMain.handle('win:isPinned', () => !!(win && win.isAlwaysOnTop()));
// Eingehender Anruf: Fenster nach vorne holen (wie bei Teams)
ipcMain.on('win:attention', () => {
  if (!win || TEST_MODE) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.flashFrame(true);
});
ipcMain.on('win:flash', () => {
  if (win && !win.isFocused()) win.flashFrame(true);
});

// ---------- Benachrichtigungen ----------
const liveNotifications = new Set(); // Referenzen halten, sonst gehen Klicks verloren
const handledReplies = new Set();    // Antwort kann über zwei Wege gemeldet werden -> nur einmal senden
const CHAT_ID_RE = /^(u:[A-Z0-9]{6}|g:[a-z0-9-]{8,40})$/;
let pendingReplies = [];             // Antworten, bevor das Fenster bereit ist (Kaltstart)

const xmlEsc = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c]));

// Windows liest Bilder für Benachrichtigungen nur aus normalen Dateien (nicht aus app.asar)
function toastDir() {
  const d = path.join(app.getPath('userData'), 'toast');
  fs.mkdirSync(d, { recursive: true });
  return d;
}
function assetFile(name) {
  const p = path.join(toastDir(), name);
  if (!fs.existsSync(p)) fs.writeFileSync(p, fs.readFileSync(path.join(__dirname, 'src', 'assets', name)));
  return p;
}
function avatarFile(dataUrl) {
  if (typeof dataUrl === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(dataUrl)) {
    const img = nativeImage.createFromDataURL(dataUrl);
    if (!img.isEmpty()) {
      const hash = require('crypto').createHash('sha1').update(dataUrl).digest('hex').slice(0, 16);
      const p = path.join(toastDir(), `av-${hash}.png`);
      if (!fs.existsSync(p)) fs.writeFileSync(p, img.toPNG());
      return p;
    }
  }
  return assetFile('logo.png');
}

function deliverReply(tag, chatId, text) {
  text = String(text || '').trim().slice(0, 4000);
  if (!tag || !CHAT_ID_RE.test(chatId || '') || !text || handledReplies.has(tag)) return;
  handledReplies.add(tag);
  if (win && rendererReady) win.webContents.send('notification:reply', chatId, text);
  else pendingReplies.push([chatId, text]);
}
// Die Oberfläche meldet sich, sobald Chats geladen sind; dann wartende Antworten senden
let rendererReady = false;
ipcMain.on('app:ready', () => {
  rendererReady = true;
  const list = pendingReplies;
  pendingReplies = [];
  list.forEach(([chatId, text]) => win && win.webContents.send('notification:reply', chatId, text));
});
function openFromNotification(chatId) {
  showWindow();
  if (win && CHAT_ID_RE.test(chatId || '')) win.webContents.send('notification:click', chatId);
}

// Eigenes Layout: Senden-Symbol im Antwortfeld, damit Enter die Antwort abschickt
function replyToastXml({ id, chatId, title, body, iconPath, placeholder, silent }) {
  const args = (type) => xmlEsc(`type=${type}&tag=${id}&chat=${chatId}`);
  return `<toast launch="${args('click')}" activationType="foreground">
  <visual><binding template="ToastGeneric">
    <text>${xmlEsc(title)}</text>
    <text>${xmlEsc(body)}</text>
    <image placement="appLogoOverride" hint-crop="circle" src="${xmlEsc(require('url').pathToFileURL(iconPath).href)}"/>
  </binding></visual>
  <actions>
    <input id="reply" type="text" placeHolderContent="${xmlEsc(placeholder)}"/>
    <action content="Senden" arguments="${args('reply')}" activationType="foreground" hint-inputId="reply"
      imageUri="${xmlEsc(require('url').pathToFileURL(assetFile('send.png')).href)}"/>
  </actions>
  ${silent ? '<audio silent="true"/>' : ''}
</toast>`;
}

// ---------- Eigenes Benachrichtigungsfenster (unten rechts) ----------
// Windows-Benachrichtigungen erlauben nicht, Enter/Shift+Enter selbst festzulegen.
// Deshalb zeigt WhatsUp standardmäßig ein eigenes kleines Fenster wie das alte Teams.
const POPUP_W = 380;
let popup = null;
let popupReady = false;
let popupQueue = [];

function placePopup(h) {
  if (!popup || popup.isDestroyed()) return;
  const { screen } = require('electron');
  const wa = screen.getPrimaryDisplay().workArea;
  const height = Math.max(60, Math.min(Math.round(h), wa.height - 20));
  popup.setBounds({ x: wa.x + wa.width - POPUP_W - 6, y: wa.y + wa.height - height - 6, width: POPUP_W, height });
}

function ensurePopup() {
  if (popup && !popup.isDestroyed()) return popup;
  popupReady = false;
  popup = new BrowserWindow({
    width: POPUP_W, height: 120,
    frame: false, transparent: true, backgroundColor: '#00000000', hasShadow: false,
    resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, show: false,
    ...(TEST_MODE ? { opacity: 0 } : {}),
    title: 'WhatsUp',
    webPreferences: {
      preload: path.join(__dirname, 'popup-preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      devTools: !app.isPackaged,
    },
  });
  popup.setAlwaysOnTop(true, 'pop-up-menu');
  if (TEST_MODE) popup.setIgnoreMouseEvents(true);
  popup.webContents.on('will-navigate', (e) => e.preventDefault());
  popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  popup.webContents.session.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
  popup.webContents.once('did-finish-load', () => {
    popupReady = true;
    const q = popupQueue; popupQueue = [];
    q.forEach((n) => popup.webContents.send('popup:show', n));
  });
  popup.on('closed', () => { popup = null; popupReady = false; });
  popup.loadFile(path.join(__dirname, 'src', 'popup.html'));
  return popup;
}

function showPopup(n) {
  ensurePopup();
  if (popupReady) popup.webContents.send('popup:show', n);
  else popupQueue.push(n);
}

const fromPopup = (e) => popup && !popup.isDestroyed() && e.sender === popup.webContents;
ipcMain.on('popup:size', (e, h) => {
  if (!fromPopup(e)) return;
  if (!h) { popup.hide(); return; }
  placePopup(h);
  // nicht den Fokus klauen (z. B. beim Tippen oder Spielen)
  if (!popup.isVisible()) popup.showInactive();
});
ipcMain.on('popup:reply', (e, id, chatId, text) => {
  if (!fromPopup(e)) return;
  deliverReply('p-' + String(id).slice(0, 64), chatId, text);
});
ipcMain.on('popup:open', (e, chatId) => {
  if (!fromPopup(e)) return;
  openFromNotification(CHAT_ID_RE.test(chatId) ? chatId : null);
});
ipcMain.on('popup:focus', (e) => { if (fromPopup(e) && !TEST_MODE) popup.focus(); });

ipcMain.on('notify', (_e, n) => {
  if (!n || typeof n !== 'object') return;
  const chatId = CHAT_ID_RE.test(n.chatId || '') ? n.chatId : null;
  const title = String(n.title || 'WhatsUp').slice(0, 80);
  const body = String(n.body || '').slice(0, 200);
  const placeholder = String(n.replyPlaceholder || 'Antworten…').slice(0, 60);
  if (prefs.popupNotify) {
    const icon = typeof n.icon === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(n.icon) && n.icon.length < 2e6 ? n.icon : null;
    showPopup({ id: require('crypto').randomUUID(), chatId, title, body, icon, placeholder, silent: !!n.silent, theme: prefs.theme });
    if (win && !win.isFocused()) win.flashFrame(true);
    return;
  }
  if (!Notification.isSupported()) return;
  let icon = nativeImage.createFromPath(ICON_PATH);
  if (typeof n.icon === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(n.icon)) {
    const av = nativeImage.createFromDataURL(n.icon);
    if (!av.isEmpty()) icon = av;
  }

  const build = (custom) => {
    const id = require('crypto').randomUUID();
    let opts = { id, title, body, icon, silent: !!n.silent };
    if (chatId && custom && process.platform === 'win32') {
      try {
        opts.toastXml = replyToastXml({ id, chatId, title, body, iconPath: avatarFile(n.icon), placeholder, silent: !!n.silent });
      } catch (e) { console.warn('Toast-Layout:', e); }
    }
    if (chatId && !opts.toastXml) opts = { ...opts, hasReply: true, replyPlaceholder: placeholder };
    const note = new Notification(opts);
    liveNotifications.add(note);
    const drop = () => liveNotifications.delete(note);
    note.on('click', () => openFromNotification(chatId));
    note.on('reply', (details, legacy) => { deliverReply(note.id || id, chatId, (details && details.reply) ?? legacy); drop(); });
    // Falls Windows das eigene Layout ablehnt: Standard-Benachrichtigung zeigen
    note.on('failed', (_ev, err) => { drop(); console.warn('Benachrichtigung fehlgeschlagen:', err); if (custom && opts.toastXml) build(false); });
    // Bleibt im Benachrichtigungscenter, daher Referenz länger halten
    setTimeout(drop, 6 * 60 * 60 * 1000);
    note.show();
  };
  build(true);
  if (win && !win.isFocused()) win.flashFrame(true);
});

// Testmodus: Antwort aus einer Benachrichtigung simulieren
if (TEST_MODE) {
  ipcMain.on('test:reply', (_e, chatId, text) => win && win.webContents.send('notification:reply', chatId, text));
}

// Roter Zähler am Taskleisten-Icon
ipcMain.on('badge', (_e, count, dataUrl) => {
  if (!win) return;
  const n = Math.max(0, Number(count) || 0);
  if (n && typeof dataUrl === 'string' && dataUrl.startsWith('data:image/png;base64,')) {
    win.setOverlayIcon(nativeImage.createFromDataURL(dataUrl), `${n} ungelesene Nachrichten`);
  } else {
    win.setOverlayIcon(null, '');
  }
  if (tray) tray.setToolTip(n ? `WhatsUp – ${n} ungelesen` : 'WhatsUp');
});

ipcMain.on('prefs', (_e, p) => {
  if (!p || typeof p !== 'object') return;
  prefs.runInBackground = p.runInBackground !== false;
  prefs.openAtLogin = !!p.openAtLogin;
  prefs.popupNotify = p.popupNotify !== false;
  prefs.theme = ['light', 'dark'].includes(p.theme) ? p.theme : 'system';
  if (app.isPackaged && !IS_PORTABLE) {
    app.setLoginItemSettings({ openAtLogin: prefs.openAtLogin, args: ['--hidden'] });
  }
});

// ---------- Updates ----------
// Installierte Version (Setup): electron-updater lädt das Update von GitHub,
// prüft die SHA-512-Prüfsumme und installiert es.
// Portable Version / Entwicklung: nur prüfen und die Download-Seite öffnen.
const canSelfUpdate = app.isPackaged && !IS_PORTABLE;
let autoUpdater = null;
if (canSelfUpdate) {
  ({ autoUpdater } = require('electron-updater'));
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('download-progress', (p) => win && win.webContents.send('update:progress', Math.round(p.percent)));
  autoUpdater.on('update-downloaded', () => win && win.webContents.send('update:ready'));
  autoUpdater.on('error', (e) => win && win.webContents.send('update:error', String(e && e.message || e)));
}

const newer = (a, b) => {
  const pa = String(a).replace(/^v/, '').split('.').map(Number);
  const pb = String(b).replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0); }
  return false;
};

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  mode: !app.isPackaged ? 'dev' : IS_PORTABLE ? 'portable' : 'installed',
}));

ipcMain.handle('update:check', async () => {
  if (canSelfUpdate) {
    const r = await autoUpdater.checkForUpdates();
    const latest = r && r.updateInfo && r.updateInfo.version;
    return { latest, available: !!latest && newer(latest, app.getVersion()) };
  }
  const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { 'User-Agent': 'WhatsUp-App', Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error('GitHub antwortet nicht (' + res.status + ')');
  const latest = String((await res.json()).tag_name || '').replace(/^v/, '');
  return { latest, available: !!latest && newer(latest, app.getVersion()) };
});

ipcMain.handle('update:download', async () => {
  if (!canSelfUpdate) { shell.openExternal(RELEASES_URL); return false; }
  await autoUpdater.downloadUpdate();
  return true;
});

ipcMain.on('update:install', () => {
  if (canSelfUpdate) { quitting = true; setImmediate(() => autoUpdater.quitAndInstall(true, true)); }
});

ipcMain.on('open:repo', () => shell.openExternal(`https://github.com/${REPO}`));

// Bild/GIF von einer Adresse laden – z. B. GIFs aus dem Windows-Emoji-Feld (Win + .),
// das statt einer Datei nur einen Bild-Link einfügt. Nur https, nur Bilder, max. 25 MB.
const MAX_FETCH = 25 * 1024 * 1024;
ipcMain.handle('fetch:image', async (_e, url) => {
  let u;
  try { u = new URL(String(url)); } catch { throw new Error('Ungültige Adresse'); }
  if (u.protocol !== 'https:') throw new Error('Nur https-Adressen');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await net.fetch(u.href, { signal: ctrl.signal, headers: { Accept: 'image/gif,image/webp,image/png,image/jpeg' } });
    if (!res.ok) throw new Error('GIF konnte nicht geladen werden (' + res.status + ')');
    const type = (res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!/^image\/(gif|png|jpeg|webp)$/.test(type)) throw new Error('Keine Bilddatei');
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_FETCH) throw new Error('Das GIF ist zu groß (max. 25 MB)');
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FETCH) throw new Error('Das GIF ist zu groß (max. 25 MB)');
    return { type, base64: buf.toString('base64') };
  } catch (e) {
    if (e && e.name === 'AbortError') throw new Error('Das GIF lädt zu lange – Internetverbindung prüfen');
    throw e;
  } finally { clearTimeout(timer); }
});

app.whenReady().then(() => {
  app.setAppUserModelId(APP_ID);
  ensureShortcuts();
  // Klick auf eine ältere Benachrichtigung (z. B. nach Neustart aus dem Benachrichtigungscenter)
  // Zentrale Behandlung aller Klicks/Antworten – auch nach Neustart aus dem Benachrichtigungscenter
  if (process.platform === 'win32' && typeof Notification.handleActivation === 'function') {
    Notification.handleActivation((d) => {
      if (!d) return;
      const a = new URLSearchParams(String(d.arguments || ''));
      const chatId = a.get('chat');
      const type = a.get('type') || d.type;
      if (type === 'reply' || d.type === 'reply') {
        deliverReply(a.get('tag') || 'x-' + Date.now(), chatId, d.reply ?? (d.userInputs && d.userInputs.reply));
        if (!win || !win.isVisible()) return; // im Hintergrund bleiben, wie bei Teams
      } else openFromNotification(chatId);
    });
  }
  createWindow();
  createTray();
});

app.on('window-all-closed', () => app.quit());
