const { app, BrowserWindow, ipcMain, shell } = require('electron');
const path = require('path');

let win;

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

function createWindow() {
  win = new BrowserWindow({
    width: 360,
    height: 540,
    minWidth: 300,
    minHeight: 400,
    frame: false,
    backgroundColor: '#14161c',
    title: 'Chatbox',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      devTools: !app.isPackaged,
    },
  });

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

ipcMain.on('win:minimize', () => win && win.minimize());
ipcMain.on('win:close', () => win && win.close());
ipcMain.handle('win:togglePin', () => {
  if (!win) return false;
  const pinned = !win.isAlwaysOnTop();
  win.setAlwaysOnTop(pinned);
  return pinned;
});
ipcMain.on('win:flash', () => {
  if (win && !win.isFocused()) win.flashFrame(true);
});

app.whenReady().then(() => {
  app.setAppUserModelId('com.chatbox.app');
  createWindow();
});

app.on('window-all-closed', () => app.quit());
