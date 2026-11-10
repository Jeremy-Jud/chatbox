const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatboxWindow', {
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),
  togglePin: () => ipcRenderer.invoke('win:togglePin'),
  isPinned: () => ipcRenderer.invoke('win:isPinned'),
  flash: () => ipcRenderer.send('win:flash'),
});

contextBridge.exposeInMainWorld('whatsupApp', {
  info: () => ipcRenderer.invoke('app:info'),
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.send('update:install'),
  openRepo: () => ipcRenderer.send('open:repo'),
  onUpdateProgress: (fn) => ipcRenderer.on('update:progress', (_e, p) => fn(p)),
  onUpdateReady: (fn) => ipcRenderer.on('update:ready', () => fn()),
  onUpdateError: (fn) => ipcRenderer.on('update:error', (_e, m) => fn(m)),
});
