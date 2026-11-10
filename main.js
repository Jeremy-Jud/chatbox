const { app, BrowserWindow, ipcMain, shell, net, nativeTheme } = require('electron');
const path = require('path');

const REPO = 'Jeremy-Jud/whatsup';
const RELEASES_URL = `https://github.com/${REPO}/releases/latest`;

let win;
const TEST_MODE = process.env.CHATBOX_HIDDEN === '1' && !app.isPackaged;
const IS_PORTABLE = !!process.env.PORTABLE_EXECUTABLE_FILE;

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

function createWindow() {
  win = new BrowserWindow({
    width: 380,
    height: 600,
    minWidth: 320,
    minHeight: 460,
    frame: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0e0e10' : '#ffffff',
    // Testmodus: Fenster wird gezeichnet, ist aber unsichtbar und nicht klickbar
    ...(TEST_MODE ? { opacity: 0, focusable: false, skipTaskbar: true } : {}),
    title: 'WhatsUp',
    icon: path.join(__dirname, 'src', 'assets', 'logo.png'),
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
  win.loadFile(path.join(__dirname, 'src', 'index.html'));

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

app.on('second-instance', () => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
});

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
  if (canSelfUpdate) setImmediate(() => autoUpdater.quitAndInstall(true, true));
});

ipcMain.on('open:repo', () => shell.openExternal(`https://github.com/${REPO}`));

app.whenReady().then(() => {
  app.setAppUserModelId('com.whatsup.app');
  createWindow();
});

app.on('window-all-closed', () => app.quit());
