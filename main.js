const { app, BrowserWindow, ipcMain, shell, net, nativeTheme, Notification, Tray, Menu, nativeImage } = require('electron');
const path = require('path');

const REPO = 'Jeremy-Jud/whatsup';
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;
const ICON_PATH = path.join(__dirname, 'src', 'assets', 'logo.png');

let win = null;
let tray = null;
let quitting = false;
const TEST_MODE = process.env.CHATBOX_HIDDEN === '1' && !app.isPackaged;
const IS_PORTABLE = !!process.env.PORTABLE_EXECUTABLE_FILE;
const START_HIDDEN = process.argv.includes('--hidden');
// Wird vom Fenster aus den Einstellungen gesetzt
const prefs = { runInBackground: true, openAtLogin: false };

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

  // Sicherheit: App darf nie auf fremde Seiten navigieren
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  // Links im normalen Browser öffnen, nicht in der App (nur https)
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://')) shell.openExternal(url);
    return { action: 'deny' };
  });

  // Keine Rechte (Kamera, Mikrofon, Standort …) außer Benachrichtigungen
  win.webContents.session.setPermissionRequestHandler((_wc, permission, cb) => {
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
ipcMain.on('win:flash', () => {
  if (win && !win.isFocused()) win.flashFrame(true);
});

// ---------- Benachrichtigungen ----------
const liveNotifications = new Set(); // Referenzen halten, sonst gehen Klicks verloren
ipcMain.on('notify', (_e, n) => {
  if (!Notification.isSupported() || !n || typeof n !== 'object') return;
  let icon = nativeImage.createFromPath(ICON_PATH);
  if (typeof n.icon === 'string' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(n.icon)) {
    const av = nativeImage.createFromDataURL(n.icon);
    if (!av.isEmpty()) icon = av;
  }
  const note = new Notification({
    title: String(n.title || 'WhatsUp').slice(0, 80),
    body: String(n.body || '').slice(0, 200),
    icon,
    silent: !!n.silent,
  });
  liveNotifications.add(note);
  const drop = () => liveNotifications.delete(note);
  note.on('click', () => {
    drop();
    showWindow();
    if (win && n.chatId) win.webContents.send('notification:click', String(n.chatId));
  });
  note.on('close', drop);
  note.show();
  if (win && !win.isFocused()) win.flashFrame(true);
  setTimeout(drop, 10 * 60 * 1000);
});

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

app.whenReady().then(() => {
  app.setAppUserModelId('com.whatsup.app');
  createWindow();
  createTray();
});

app.on('window-all-closed', () => app.quit());
