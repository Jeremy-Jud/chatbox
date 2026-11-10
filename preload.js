const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('chatboxWindow', {
  minimize: () => ipcRenderer.send('win:minimize'),
  close: () => ipcRenderer.send('win:close'),
  togglePin: () => ipcRenderer.invoke('win:togglePin'),
  flash: () => ipcRenderer.send('win:flash'),
});
