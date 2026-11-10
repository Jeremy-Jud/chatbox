// Brücke für das eigene Benachrichtigungsfenster (unten rechts)
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('popup', {
  onShow: (fn) => ipcRenderer.on('popup:show', (_e, n) => fn(n)),
  onSent: (fn) => ipcRenderer.on('popup:sent', (_e, id) => fn(id)),
  setHeight: (h) => ipcRenderer.send('popup:size', Number(h) || 0),
  reply: (id, chatId, text) => ipcRenderer.send('popup:reply', String(id), String(chatId), String(text)),
  open: (chatId) => ipcRenderer.send('popup:open', String(chatId || '')),
  focus: () => ipcRenderer.send('popup:focus'),
});
