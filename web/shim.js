// Web-Version (iPhone/iPad/Browser): ersetzt, was in der Windows-App preload.js + main.js liefern.
// Läuft vor app.js. In Electron wird diese Datei nicht geladen.
(() => {
  const VERSION = '__VERSION__';
  const REPO = 'https://github.com/Jeremy-Jud/whatsup';
  const noop = () => {};
  const hasSW = 'serviceWorker' in navigator && location.protocol.startsWith('http');
  const canNotify = () => 'Notification' in window;

  document.documentElement.classList.add('is-web');
  // Als App auf dem Home-Bildschirm? (Safari-Tab vs. installiert)
  const standalone = window.navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
  if (standalone) document.documentElement.classList.add('is-standalone');

  // Daten nicht von Safari aufräumen lassen
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(noop);

  let swReg = null;
  if (hasSW) {
    navigator.serviceWorker.register('./sw.js').then((r) => { swReg = r; }).catch((e) => console.warn('Service Worker:', e));
  }

  // Klick auf eine Benachrichtigung -> Chat öffnen
  let clickHandler = null;
  let appReady = false;
  let pendingChat = new URLSearchParams(location.search).get('chat');
  const openChat = (chatId) => {
    if (!chatId) return;
    if (appReady && clickHandler) clickHandler(chatId);
    else pendingChat = chatId;
  };
  if (hasSW) {
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'open-chat') openChat(e.data.chatId);
    });
  }

  function show(n) {
    const opts = {
      body: n.body || '',
      icon: n.icon || 'icon-192.png',
      badge: 'icon-192.png',
      tag: n.chatId || undefined,
      silent: !!n.silent,
      data: { chatId: n.chatId || null },
    };
    const reg = swReg ? Promise.resolve(swReg) : hasSW ? navigator.serviceWorker.ready : Promise.reject();
    reg.then((r) => r.showNotification(n.title || 'WhatsUp', opts))
      .catch(() => { try { new Notification(n.title || 'WhatsUp', opts); } catch {} });
  }

  // Erlaubnis muss direkt aus einem Tipp/Klick kommen (sonst lehnt Safari ab)
  function askPermission() {
    if (!canNotify() || Notification.permission !== 'default') return Promise.resolve(canNotify() ? Notification.permission : 'denied');
    try { return Promise.resolve(Notification.requestPermission()); } catch { return Promise.resolve('denied'); }
  }

  window.chatboxWindow = {
    minimize: noop,
    close: noop,
    togglePin: () => Promise.resolve(false),
    isPinned: () => Promise.resolve(false),
    flash: noop,
    notify: (n) => {
      if (!canNotify()) return;
      if (Notification.permission === 'granted') show(n);
      else if (Notification.permission === 'default') askPermission().then((p) => p === 'granted' && show(n));
    },
    // Zahl am App-Symbol auf dem Home-Bildschirm
    setBadge: (count) => {
      try {
        if (count > 0 && navigator.setAppBadge) navigator.setAppBadge(count).catch(noop);
        else if (navigator.clearAppBadge) navigator.clearAppBadge().catch(noop);
      } catch {}
    },
    setPrefs: noop,
    onNotificationClick: (fn) => { clickHandler = fn; },
    onNotificationReply: noop,
    testReply: noop,
    ready: () => {
      appReady = true;
      if (pendingChat) { const c = pendingChat; pendingChat = null; if (clickHandler) clickHandler(c); }
    },
    onHidden: noop,
  };

  // Updates kommen in der Web-Version automatisch beim nächsten Öffnen
  window.whatsupApp = {
    info: () => Promise.resolve({ version: VERSION, mode: 'web' }),
    checkUpdate: () => Promise.resolve({ available: false, latest: VERSION }),
    downloadUpdate: () => Promise.resolve(),
    installUpdate: () => location.reload(),
    openRepo: () => window.open(REPO, '_blank', 'noopener'),
    onUpdateProgress: noop,
    onUpdateReady: noop,
    onUpdateError: noop,
  };

  document.addEventListener('DOMContentLoaded', () => {
    // Beim Einschalten der Benachrichtigungen gleich um Erlaubnis fragen
    const sw = document.getElementById('setNotify');
    if (sw) sw.addEventListener('change', (e) => { if (e.target.checked) askPermission(); });

    // Hinweis in den Einstellungen: was im Browser anders ist
    const info = document.getElementById('webInfo');
    if (info) {
      if (!standalone) {
        info.textContent = 'Tipp: In Safari auf „Teilen“ → „Zum Home-Bildschirm“ tippen. Dann läuft WhatsUp wie eine eigene App im Vollbild.';
      } else {
        info.textContent = 'Auf iPhone und iPad kommen Nachrichten nur an, solange WhatsUp geöffnet ist.';
      }
    }
  });
})();
