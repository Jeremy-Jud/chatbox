const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatboxWindow', {
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),
  reload: () => ipcRenderer.send('win:reload'),
  togglePin: () => ipcRenderer.invoke('win:togglePin'),
  isPinned: () => ipcRenderer.invoke('win:isPinned'),
  flash: () => ipcRenderer.send('win:flash'),
  attention: () => ipcRenderer.send('win:attention'),
  notify: (n) => ipcRenderer.send('notify', n),
  setBadge: (count, dataUrl) => ipcRenderer.send('badge', count, dataUrl),
  setPrefs: (p) => ipcRenderer.send('prefs', p),
  onNotificationClick: (fn) => ipcRenderer.on('notification:click', (_e, chatId) => fn(chatId)),
  onNotificationReply: (fn) => ipcRenderer.on('notification:reply', (_e, chatId, text) => fn(chatId, text)),
  testReply: (chatId, text) => ipcRenderer.send('test:reply', chatId, text),
  ready: () => ipcRenderer.send('app:ready'),
  onHidden: (fn) => ipcRenderer.on('win:hidden', () => fn()),
});

contextBridge.exposeInMainWorld('whatsupApp', {
  info: () => ipcRenderer.invoke('app:info'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.send('update:install'),
  openRepo: () => ipcRenderer.send('open:repo'),
  fetchImage: (url) => ipcRenderer.invoke('fetch:image', url),
  onUpdateProgress: (fn) => ipcRenderer.on('update:progress', (_e, p) => fn(p)),
  onUpdateReady: (fn) => ipcRenderer.on('update:ready', () => fn()),
  onUpdateError: (fn) => ipcRenderer.on('update:error', (_e, m) => fn(m)),
});
