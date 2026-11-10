// Service Worker der Web-Version: App offline startbar machen + Klicks auf Benachrichtigungen.
const CACHE = 'whatsup-__VERSION__';

self.addEventListener('install', (e) => { self.skipWaiting(); });
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('whatsup-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Erst Netz (damit Updates sofort da sind), sonst Cache
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }))
  );
});

// Push vom Briefkasten-Server: Es liegt eine Nachricht bereit (Inhalt bleibt verschlüsselt auf dem Server).
// iPhone/iPad verlangen zu jedem Push eine sichtbare Benachrichtigung.
function fromKeys(key, code) {
  return new Promise((resolve) => {
    try {
      const r = indexedDB.open('chatbox');
      r.onerror = () => resolve(null);
      r.onsuccess = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains('keys')) { d.close(); resolve(null); return; }
        const q = d.transaction('keys', 'readonly').objectStore('keys').get(key);
        q.onsuccess = () => { d.close(); resolve((q.result && q.result[code]) || null); };
        q.onerror = () => { d.close(); resolve(null); };
      };
    } catch { resolve(null); }
  });
}
self.addEventListener('push', (e) => {
  let data = {};
  try { data = (e.data && e.data.json()) || {}; } catch {}
  const from = typeof data.from === 'string' ? data.from : null;
  e.waitUntil((async () => {
    if (data.test) {
      await self.registration.showNotification('WhatsUp', {
        body: 'So sehen deine Benachrichtigungen aus 👋', icon: 'icon-192.png', badge: 'icon-192.png', tag: 'test', data: {},
      });
      return;
    }
    const name = from ? await fromKeys('pushNames', from) : null;
    const avatar = from ? await fromKeys('pushIcons', from) : null; // Profilbild (Android/PC; iPhone zeigt immer das App-Symbol)
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    list.forEach((c) => c.postMessage({ type: 'relay-poll' })); // offene App holt sofort ab
    await self.registration.showNotification(name || 'WhatsUp', {
      body: name ? 'Neue Nachricht' : 'Du hast eine neue Nachricht',
      icon: avatar || 'icon-192.png',
      badge: 'icon-192.png',
      tag: from ? 'relay-' + from : 'relay',
      data: { chatId: from ? 'u:' + from : null },
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const chatId = e.notification.data && e.notification.data.chatId;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (list.length) {
      const c = list[0];
      await c.focus();
      if (chatId) c.postMessage({ type: 'open-chat', chatId });
      return;
    }
    await self.clients.openWindow(chatId ? './?chat=' + encodeURIComponent(chatId) : './');
  })());
});
